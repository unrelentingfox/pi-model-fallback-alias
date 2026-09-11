import {
	suggestedConfig,
	summarizeByRole,
	summarizeByRoleAndTarget,
	suggestRoleThresholds,
	timeoutWarnings,
	type MetricSummary,
	type RoleSummary,
	type RoleTargetSummary,
} from "./stats.ts";
import type { LatencyLogReport } from "./log.ts";

export interface LatencyReport {
	samples: LatencyLogReport["samples"];
	legacyTimeouts: LatencyLogReport["legacyTimeouts"];
	targetSummaries: RoleTargetSummary[];
	roleSummaries: RoleSummary[];
	suggestedRoles: Record<string, { targets: string[]; timeouts: { firstEventMs?: number; stallMs?: number } }>;
}

export interface LatencyReportEntryData {
	armedRoles?: string[];
	message?: string;
	report?: LatencyReport;
}

type TableValue = number | string | undefined;
type TableRow = TableValue[];

export function createLatencyReport(log: LatencyLogReport): LatencyReport {
	return {
		samples: log.samples,
		legacyTimeouts: log.legacyTimeouts,
		targetSummaries: summarizeByRoleAndTarget(log.samples),
		roleSummaries: summarizeByRole(log.samples),
		suggestedRoles: suggestedConfig(suggestRoleThresholds(log.samples)),
	};
}

export function filterLatencyReport(report: LatencyReport, role: string): LatencyReport {
	return createLatencyReport({
		samples: report.samples.filter((sample) => sample.role === role),
		legacyTimeouts: report.legacyTimeouts.filter((timeout) => timeout.role === role),
	});
}

export function createLatencyReportEntry(
	report: LatencyReport,
	armedRoles: readonly string[],
	role: string | undefined,
): LatencyReportEntryData {
	if (role !== undefined && !armedRoles.includes(role)) {
		const availableRoles = armedRoles.length === 0 ? "none" : armedRoles.join(", ");
		return { message: `Unknown alias role "${role}". Available roles: ${availableRoles}.` };
	}
	const filteredReport = role === undefined ? report : filterLatencyReport(report, role);
	if (filteredReport.samples.length === 0) {
		return { message: "No attempt-latency samples found. Restart Pi to begin sampling after this extension change." };
	}
	return { armedRoles: role === undefined ? [...armedRoles] : [role], report: filteredReport };
}

export function formatCliLatencyReport(report: LatencyReport): string {
	return [
		formatTable(report.targetSummaries.flatMap(metricRows)),
		formatTimeoutSummary(report.roleSummaries),
		formatLegacyTimeoutKinds(report),
		"Percentiles and suggestions use complete samples only. Attempt and timeout counts include all samples.",
		"Suggestions use ceil(p995(ttfbMs) * 1.5), minimum 10000 ms, and ceil(p995(maxGapMs) * 2), minimum 20000 ms. Both round up to 1000 ms. Commit time is never suggested.",
		"Suggested model-alias.json roles (retain any existing targets not seen in these logs):\n"
			+ JSON.stringify(report.suggestedRoles, null, 2),
	].filter((section) => section !== "").join("\n\n");
}

export function formatLatencyReportEntry(value: unknown, expanded: boolean): string {
	if (!isEntryData(value)) return missingLatencyReportMessage();
	if (typeof value.message === "string") return `[model-alias] ${value.message}`;
	if (!value.report) return missingLatencyReportMessage();
	try {
		return expanded
			? formatCliLatencyReport(value.report)
			: formatCompactLatencyReport({ armedRoles: validRoles(value.armedRoles), report: value.report });
	} catch {
		return missingLatencyReportMessage();
	}
}

export function formatCompactLatencyReport(data: LatencyReportEntryData): string {
	if (!data.report) return "";
	const summaries = new Map(data.report.roleSummaries.map((summary) => [summary.role, summary]));
	return (data.armedRoles ?? data.report.roleSummaries.map((summary) => summary.role))
		.map((role) => formatCompactRole(role, summaries.get(role)))
		.join(" · ");
}

function isEntryData(value: unknown): value is Partial<LatencyReportEntryData> {
	return typeof value === "object" && value !== null;
}

function validRoles(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((role) => typeof role === "string") ? value : undefined;
}

function missingLatencyReportMessage(): string {
	return "[model-alias] Missing latency report details";
}

function metricRows(summary: RoleTargetSummary): TableRow[] {
	const confidence = summary.n < 200 ? "low confidence — keep collecting" : "ready";
	return [
		metricRow(summary.role, summary.targetRef, summary.n, confidence, formatTimeouts(summary), "ttfbMs", summary.ttfbMs),
		metricRow("", "", "", "", "", "maxGapMs", summary.maxGapMs),
		metricRow("", "", "", "", "", "totalMs", summary.totalMs),
	];
}

function metricRow(
	role: string,
	targetRef: string,
	n: number | string,
	confidence: string,
	timeouts: string,
	metric: string,
	values: MetricSummary,
): TableRow {
	return [role, targetRef, n, confidence, timeouts, metric, values.p50, values.p90, values.p99, values.p995, values.max];
}

function formatTable(rows: readonly TableRow[]): string {
	const headers = ["role", "target", "n", "confidence", "timeouts", "metric", "p50", "p90", "p99", "p995", "max"];
	const values = [headers, ...rows].map((row) => row.map(formatValue));
	const widths = headers.map((_, column) => Math.max(...values.map((row) => row[column].length)));
	return values.map((row) => row.map((value, column) => value.padEnd(widths[column])).join("  ")).join("\n");
}

function formatTimeoutSummary(summaries: readonly RoleSummary[]): string {
	const lines = ["Timeouts by role:"];
	for (const summary of summaries) {
		lines.push(`${summary.role}: attempts ${summary.attempts}, timeouts ${summary.timeouts}, rate ${(summary.timeoutRate * 100).toFixed(1)}%; ${formatKindBreakdown(summary.timeoutsByKind)}`);
	}
	for (const warning of timeoutWarnings(summaries)) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

function formatLegacyTimeoutKinds(report: LatencyReport): string {
	if (report.legacyTimeouts.length === 0) return "";
	const counts = new Map<string, { "first event": number; stall: number; commit: number }>();
	for (const timeout of report.legacyTimeouts) {
		const key = `${timeout.role}\u0000${timeout.targetRef}`;
		const group = counts.get(key) ?? { "first event": 0, stall: 0, commit: 0 };
		group[timeout.timeoutKind] += 1;
		counts.set(key, group);
	}
	const lines = ["Legacy timeout kinds (from attempt-timeout reason text; not matched to latency samples):"];
	for (const [key, group] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const [role, targetRef] = key.split("\u0000");
		lines.push(`${role}/${targetRef}: ${formatKindBreakdown(group)}`);
	}
	return lines.join("\n");
}

function formatCompactRole(role: string, summary: RoleSummary | undefined): string {
	const attempts = summary?.attempts ?? 0;
	const rate = ((summary?.timeoutRate ?? 0) * 100).toFixed(1);
	return `${role}: ${attempts} attempts, ${rate}% timeouts`;
}

function formatTimeouts(summary: RoleTargetSummary): string {
	const breakdown = Object.entries(summary.timeoutsByKind)
		.filter(([, count]) => count > 0)
		.map(([kind, count]) => `${kind}: ${count}`)
		.join(", ");
	return `${summary.timeouts}/${summary.attempts} (${(summary.timeoutRate * 100).toFixed(1)}%)${breakdown ? `; ${breakdown}` : ""}`;
}

function formatKindBreakdown(counts: RoleSummary["timeoutsByKind"]): string {
	return `first event: ${counts["first event"]}, stall: ${counts.stall}, commit: ${counts.commit}`;
}

function formatValue(value: TableValue): string {
	return value === undefined ? "-" : String(value);
}
