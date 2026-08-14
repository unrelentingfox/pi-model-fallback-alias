export const TIMEOUT_KINDS = ["first event", "stall", "commit"] as const;
export type TimeoutKind = (typeof TIMEOUT_KINDS)[number];

export type LatencyOutcome =
	| "complete"
	| "retryable-failure"
	| "committed-failure"
	| "unsafe-throw"
	| "timeout";

export type LatencySample = {
	role: string;
	targetRef: string;
	timeoutKind?: TimeoutKind;
	ttfbMs?: number;
	maxGapMs: number;
	commitMs?: number;
	totalMs: number;
	eventCount: number;
	committed: boolean;
	outcome: LatencyOutcome;
	inputTokens?: number;
	cacheReadTokens?: number;
	outputTokens?: number;
};

export interface MetricSummary {
	p50?: number;
	p90?: number;
	p99?: number;
	p995?: number;
	max?: number;
}

export interface TimeoutSummary {
	attempts: number;
	timeouts: number;
	timeoutRate: number;
	timeoutsByKind: Record<TimeoutKind, number>;
}

export interface TargetSummary extends TimeoutSummary {
	n: number;
	ttfbMs: MetricSummary;
	maxGapMs: MetricSummary;
	totalMs: MetricSummary;
}

export interface RoleTargetSummary extends TargetSummary {
	role: string;
	targetRef: string;
}

export interface RoleSummary extends TargetSummary {
	role: string;
}

export interface TargetThresholdSuggestion {
	firstEventMs?: number;
	stallMs?: number;
	lowConfidence: boolean;
}

export interface RoleThresholdSuggestion {
	targets: string[];
	firstEventMs?: number;
	stallMs?: number;
	lowConfidence: boolean;
	lowConfidenceTargets: string[];
}

export interface SuggestedRoleConfig {
	targets: string[];
	timeouts: { firstEventMs?: number; stallMs?: number };
}

export function percentile(values: readonly number[], p: number): number | undefined {
	if (p < 0 || p > 1 || !Number.isFinite(p)) return undefined;
	const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
	if (sorted.length === 0) return undefined;
	return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export function summarize(samples: readonly LatencySample[]): Record<string, TargetSummary> {
	return summarizeGroups(samples, (sample) => sample.targetRef);
}

export function summarizeByRoleAndTarget(samples: readonly LatencySample[]): RoleTargetSummary[] {
	const groups = new Map<string, LatencySample[]>();
	for (const sample of samples) {
		const key = `${sample.role}\u0000${sample.targetRef}`;
		const group = groups.get(key) ?? [];
		group.push(sample);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.map(([key, group]) => {
			const [role, targetRef] = key.split("\u0000");
			return { role, targetRef, ...summarizeSampleGroup(group) };
		})
		.sort((left, right) => left.role.localeCompare(right.role) || left.targetRef.localeCompare(right.targetRef));
}

export function summarizeByRole(samples: readonly LatencySample[]): RoleSummary[] {
	return Object.entries(summarizeGroups(samples, (sample) => sample.role))
		.map(([role, summary]) => ({ role, ...summary }))
		.sort((left, right) => left.role.localeCompare(right.role));
}

export function timeoutWarnings(summaries: readonly RoleSummary[]): string[] {
	return summaries.flatMap((summary) => {
		if (summary.timeoutRate > 0.02) {
			return [`${summary.role}: timeout rate ${(summary.timeoutRate * 100).toFixed(1)}% exceeds 2%; thresholds are probably too tight.`];
		}
		if (summary.timeouts === 0 && summary.attempts >= 200) {
			return [`${summary.role}: no timeouts in ${summary.attempts} attempts; timers may never fire and could be tightened.`];
		}
		return [];
	});
}

export function suggestThresholds(summary: Record<string, TargetSummary>): Record<string, TargetThresholdSuggestion> {
	return Object.fromEntries(
		Object.entries(summary).map(([targetRef, target]) => [
			targetRef,
			{
				firstEventMs: threshold(target.ttfbMs.p995, 1.5, 10_000),
				stallMs: threshold(target.maxGapMs.p995, 2, 20_000),
				lowConfidence: target.n < 200,
			},
		]),
	);
}

export function suggestRoleThresholds(samples: readonly LatencySample[]): Record<string, RoleThresholdSuggestion> {
	const roleGroups = new Map<string, LatencySample[]>();
	for (const sample of samples) {
		const group = roleGroups.get(sample.role) ?? [];
		group.push(sample);
		roleGroups.set(sample.role, group);
	}
	return Object.fromEntries(
		[...roleGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([role, roleSamples]) => {
			const targets = summarize(roleSamples);
			const suggestions = suggestThresholds(targets);
			const targetRefs = Object.keys(targets).sort();
			const lowConfidenceTargets = targetRefs.filter((targetRef) => targets[targetRef].n < 50);
			return [
				role,
				{
					targets: targetRefs,
					firstEventMs: maximum(targetRefs.map((targetRef) => suggestions[targetRef].firstEventMs)),
					stallMs: maximum(targetRefs.map((targetRef) => suggestions[targetRef].stallMs)),
					lowConfidence: roleSamples.length < 200 || lowConfidenceTargets.length > 0,
					lowConfidenceTargets,
				},
			];
		}),
	);
}

export function suggestedConfig(suggestions: Record<string, RoleThresholdSuggestion>): Record<string, SuggestedRoleConfig> {
	return Object.fromEntries(Object.entries(suggestions).map(([role, suggestion]) => [
		role,
		{
			targets: suggestion.targets,
			timeouts: {
				...(suggestion.firstEventMs === undefined ? {} : { firstEventMs: suggestion.firstEventMs }),
				...(suggestion.stallMs === undefined ? {} : { stallMs: suggestion.stallMs }),
			},
		},
	]));
}

function summarizeGroups(samples: readonly LatencySample[], groupKey: (sample: LatencySample) => string): Record<string, TargetSummary> {
	const groups = new Map<string, LatencySample[]>();
	for (const sample of samples) {
		const key = groupKey(sample);
		const group = groups.get(key) ?? [];
		group.push(sample);
		groups.set(key, group);
	}
	return Object.fromEntries([...groups.entries()].map(([key, group]) => [key, summarizeSampleGroup(group)]));
}

function summarizeSampleGroup(samples: readonly LatencySample[]): TargetSummary {
	const completeSamples = samples.filter((sample) => sample.outcome === "complete");
	return {
		n: samples.length,
		...summarizeTimeouts(samples),
		ttfbMs: summarizeMetric(completeSamples.map((sample) => sample.ttfbMs).filter(isNumber)),
		maxGapMs: summarizeMetric(completeSamples.map((sample) => sample.maxGapMs)),
		totalMs: summarizeMetric(completeSamples.map((sample) => sample.totalMs)),
	};
}

function summarizeTimeouts(samples: readonly LatencySample[]): TimeoutSummary {
	const timeouts = samples.filter((sample) => sample.outcome === "timeout");
	const timeoutsByKind: Record<TimeoutKind, number> = {
		"first event": 0,
		stall: 0,
		commit: 0,
	};
	for (const sample of timeouts) {
		if (sample.timeoutKind) timeoutsByKind[sample.timeoutKind] += 1;
	}
	return {
		attempts: samples.length,
		timeouts: timeouts.length,
		timeoutRate: samples.length === 0 ? 0 : timeouts.length / samples.length,
		timeoutsByKind,
	};
}

function summarizeMetric(values: readonly number[]): MetricSummary {
	return {
		p50: percentile(values, 0.5),
		p90: percentile(values, 0.9),
		p99: percentile(values, 0.99),
		p995: percentile(values, 0.995),
		max: percentile(values, 1),
	};
}

function threshold(value: number | undefined, multiplier: number, floor: number): number | undefined {
	return value === undefined ? undefined : roundUpToThousand(Math.max(Math.ceil(value * multiplier), floor));
}

function roundUpToThousand(value: number): number {
	return Math.ceil(value / 1_000) * 1_000;
}

function maximum(values: readonly (number | undefined)[]): number | undefined {
	const present = values.filter(isNumber);
	return present.length === 0 ? undefined : Math.max(...present);
}

function isNumber(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
