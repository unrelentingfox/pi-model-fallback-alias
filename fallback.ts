export type AliasMap = ReadonlyMap<string, readonly string[]>;

export interface FailoverEntryData {
	role: string;
	failedTarget: string;
	nextTarget?: string;
	reason: string;
	cooldownMs: number;
	failCount: number;
	timestamp: number;
}

export interface CooldownState {
	failCount: number;
	nextRetryAt: number;
}

export interface CooldownUpdate extends CooldownState {
	durationMs: number;
}

export interface CooldownRegistry {
	isActive(target: string): boolean;
	recordFailure(target: string): CooldownUpdate;
	reset(target: string): void;
	clearAll(): number;
	state(target: string): CooldownState | undefined;
}

export interface TargetRegistry<Model, Provider> {
	find(providerId: string, modelId: string): Model | undefined;
	getProvider(providerId: string): Provider | undefined;
}

export interface ResolvedTarget<Model, Provider> {
	ref: string;
	model: Model;
	provider: Provider;
}

export interface TargetFailure {
	target: string;
	reason: string;
	retriedFromCooldown?: boolean;
}

interface TargetAttempt {
	target: string;
	targetIndex: number;
	retriedFromCooldown: boolean;
}

interface IndexedTargetFailure extends TargetFailure {
	targetIndex: number;
}

interface StreamEventLike {
	type: string;
	reason?: string;
	error?: { errorMessage?: string };
}

interface FallbackOptions<Event extends StreamEventLike> {
	role: string;
	targets: readonly string[];
	cooldowns?: CooldownRegistry;
	signal?: Pick<AbortSignal, "aborted">;
	open(target: string): Promise<AsyncIterable<Event>>;
	forward(event: Event): void | Promise<void>;
	warn(failedTarget: string, reason: string, nextTarget: string | undefined, cooldown: CooldownUpdate): void;
	snapshot?(event: Event): Event;
}

export const COOLDOWN_BASE_MS = 30_000;
export const COOLDOWN_CAP_MS = 30 * 60_000;
export const MAX_UNCAPPED_EXPONENT = 6;

export function createCooldownRegistry(now: () => number = Date.now): CooldownRegistry {
	const entries = new Map<string, CooldownState>();
	return {
		isActive(target) {
			const entry = entries.get(target);
			return entry !== undefined && entry.nextRetryAt > now();
		},
		recordFailure(target) {
			const update = nextCooldown(entries.get(target), now());
			entries.set(target, { failCount: update.failCount, nextRetryAt: update.nextRetryAt });
			return update;
		},
		reset(target) {
			entries.delete(target);
		},
		clearAll() {
			const nowMs = now();
			const clearedCount = [...entries.values()].filter((entry) => entry.nextRetryAt > nowMs).length;
			entries.clear();
			return clearedCount;
		},
		state(target) {
			const entry = entries.get(target);
			return entry ? { ...entry } : undefined;
		},
	};
}

export function nextCooldown(previous: CooldownState | undefined, now: number): CooldownUpdate {
	const failCount = (previous?.failCount ?? 0) + 1;
	const exponent = Math.min(failCount - 1, MAX_UNCAPPED_EXPONENT);
	const durationMs = Math.min(COOLDOWN_BASE_MS * 2 ** exponent, COOLDOWN_CAP_MS);
	return { failCount, nextRetryAt: now + durationMs, durationMs };
}

export function parseAliasMap(value: unknown): Map<string, readonly string[]> {
	if (!isRecord(value)) throw new Error("expected a JSON object");

	const aliases = new Map<string, readonly string[]>();
	for (const [role, configuredTargets] of Object.entries(value)) {
		aliases.set(role, normalizeTargets(role, configuredTargets));
	}
	return expandNestedAliases(aliases);
}

export function resolveTargetReference<Model, Provider>(
	aliasId: string,
	targetRef: string,
	registry: TargetRegistry<Model, Provider>,
): ResolvedTarget<Model, Provider> {
	const [providerId, modelId] = splitModelRef(targetRef);
	if (providerId === "alias") {
		throw new Error(`Model alias "${aliasId}" cannot target another alias: "${targetRef}"`);
	}

	const model = registry.find(providerId, modelId);
	const provider = registry.getProvider(providerId);
	if (!model || !provider) {
		throw new Error(`Model alias "${aliasId}" targets unknown model "${targetRef}"`);
	}
	return { ref: targetRef, model, provider };
}

export function resolveFirstTarget<Model, Provider>(
	aliasId: string,
	targets: readonly string[],
	registry: TargetRegistry<Model, Provider>,
): ResolvedTarget<Model, Provider> {
	const failures: TargetFailure[] = [];
	for (const target of targets) {
		try {
			return resolveTargetReference(aliasId, target, registry);
		} catch (error) {
			failures.push({ target, reason: describeFailure(error) });
		}
	}
	throw new Error(formatExhaustionError(aliasId, failures));
}

export async function runFallbackChain<Event extends StreamEventLike>(options: FallbackOptions<Event>): Promise<void> {
	const cooldowns = options.cooldowns ?? createCooldownRegistry();
	if (options.targets.length === 1) {
		await forwardSingleTarget(options, options.targets[0]!, cooldowns);
		return;
	}

	const attempts = attemptsForRequest(options.targets, cooldowns);
	const failures: IndexedTargetFailure[] = [];
	for (let index = 0; index < attempts.length; index++) {
		const attempt = attempts[index]!;
		const nextTarget = attempts[index + 1]?.target;
		const outcome = await attemptTarget(options, attempt.target, cooldowns);
		if (outcome.kind === "complete" || outcome.kind === "committed-failure") return;
		if (outcome.kind === "unsafe-throw") throw outcome.error;

		failures.push({
			target: attempt.target,
			reason: outcome.reason,
			targetIndex: attempt.targetIndex,
			retriedFromCooldown: attempt.retriedFromCooldown,
		});
		warnCooldown(options, attempt.target, outcome.reason, nextTarget, cooldowns);
	}
	throw new Error(formatExhaustionError(options.role, orderFailures(failures)));
}

export function formatExhaustionError(role: string, failures: readonly TargetFailure[]): string {
	const details = failures
		.map(({ target, reason, retriedFromCooldown }) => {
			const retryNote = retriedFromCooldown ? " (retried from cooldown)" : "";
			return `- ${target}${retryNote}: ${reason}`;
		})
		.join("\n");
	return `Model alias "${role}" failed all targets:\n${details}`;
}

export function describeFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function failureStopReason(
	error: unknown,
	signal?: Pick<AbortSignal, "aborted">,
): "error" | "aborted" {
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
	return /\babort(?:ed)?\b/iu.test(describeFailure(error)) ? "aborted" : "error";
}

async function forwardSingleTarget<Event extends StreamEventLike>(
	options: FallbackOptions<Event>,
	target: string,
	cooldowns: CooldownRegistry,
): Promise<void> {
	let committed = false;
	let failureRecorded = false;
	try {
		const stream = await options.open(target);
		for await (const event of stream) {
			if (!committed && !failureRecorded && isFailureEvent(event)) {
				failureRecorded = true;
				warnCooldown(options, target, failureEventReason(event), undefined, cooldowns);
			}
			if (!committed && isCommitEvent(event)) {
				committed = true;
				if (!failureRecorded) cooldowns.reset(target);
			}
			await options.forward(event);
		}
	} catch (error) {
		if (!committed && !failureRecorded && failureStopReason(error, options.signal) !== "aborted") {
			warnCooldown(options, target, describeFailure(error), undefined, cooldowns);
		}
		throw error;
	}
}

function attemptsForRequest(targets: readonly string[], cooldowns: CooldownRegistry): readonly TargetAttempt[] {
	const attempts = targets.map((target, targetIndex) => ({
		target,
		targetIndex,
		retriedFromCooldown: cooldowns.isActive(target),
	}));
	const available = attempts.filter((attempt) => !attempt.retriedFromCooldown);
	if (available.length === 0) return attempts;
	return [...available, ...attempts.filter((attempt) => attempt.retriedFromCooldown)];
}

function orderFailures(failures: readonly IndexedTargetFailure[]): TargetFailure[] {
	return [...failures].sort((left, right) => left.targetIndex - right.targetIndex).map(toTargetFailure);
}

function toTargetFailure(failure: IndexedTargetFailure): TargetFailure {
	return {
		target: failure.target,
		reason: failure.reason,
		retriedFromCooldown: failure.retriedFromCooldown,
	};
}

function warnCooldown<Event extends StreamEventLike>(
	options: FallbackOptions<Event>,
	target: string,
	reason: string,
	nextTarget: string | undefined,
	cooldowns: CooldownRegistry,
): void {
	options.warn(target, reason, nextTarget, cooldowns.recordFailure(target));
}

type AttemptOutcome =
	| { kind: "complete" }
	| { kind: "retryable-failure"; reason: string }
	| { kind: "committed-failure" }
	| { kind: "unsafe-throw"; error: unknown };

async function attemptTarget<Event extends StreamEventLike>(
	options: FallbackOptions<Event>,
	target: string,
	cooldowns: CooldownRegistry,
): Promise<AttemptOutcome> {
	let committed = false;
	const buffered: Event[] = [];
	try {
		const stream = await options.open(target);
		for await (const event of stream) {
			if (isSuccessfulTerminal(event) || isAbortedTerminal(event)) {
				await flush(buffered, options.forward);
				await options.forward(event);
				return { kind: "complete" };
			}
			if (isFailureEvent(event)) {
				if (committed) {
					await options.forward(event);
					return { kind: "committed-failure" };
				}
				return { kind: "retryable-failure", reason: failureEventReason(event) };
			}
			if (!committed && isSafePrefixEvent(event)) {
				buffered.push(options.snapshot?.(event) ?? event);
				continue;
			}
			if (!committed) {
				await flush(buffered, options.forward);
				committed = true;
				cooldowns.reset(target);
			}
			await options.forward(event);
		}
		const reason = "stream ended without a terminal event";
		return committed ? { kind: "unsafe-throw", error: new Error(reason) } : { kind: "retryable-failure", reason };
	} catch (error) {
		if (committed || failureStopReason(error, options.signal) === "aborted") {
			return { kind: "unsafe-throw", error };
		}
		return { kind: "retryable-failure", reason: describeFailure(error) };
	}
}

async function flush<Event>(events: Event[], forward: (event: Event) => void | Promise<void>): Promise<void> {
	for (const event of events) await forward(event);
	events.length = 0;
}

function normalizeTargets(role: string, value: unknown): readonly string[] {
	if (!role) throw new Error('invalid mapping for ""');
	const targets = typeof value === "string" ? [value] : value;
	if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => !isModelRef(target))) {
		throw new Error(`invalid mapping for "${role}"`);
	}
	return targets;
}

function expandNestedAliases(aliases: Map<string, readonly string[]>): Map<string, readonly string[]> {
	const expandedAliases = new Map<string, readonly string[]>();
	const memo = new Map<string, readonly string[]>();
	for (const role of aliases.keys()) {
		expandedAliases.set(role, expandAlias(role, aliases, memo, []));
	}
	return expandedAliases;
}

function expandAlias(
	role: string,
	aliases: Map<string, readonly string[]>,
	memo: Map<string, readonly string[]>,
	path: readonly string[],
): readonly string[] {
	const memoized = memo.get(role);
	if (memoized) return memoized;

	const cycleStart = path.indexOf(role);
	if (cycleStart >= 0) {
		const cycle = [...path.slice(cycleStart), role].join(" -> ");
		throw invalidAliasMapping(role, `alias cycle ${cycle}`);
	}

	const expandedTargets: string[] = [];
	const seenTargets = new Set<string>();
	for (const target of aliases.get(role)!) {
		const [providerId, nestedRole] = splitModelRef(target);
		if (providerId !== "alias") {
			appendUnique(expandedTargets, seenTargets, target);
			continue;
		}
		if (!aliases.has(nestedRole)) {
			throw invalidAliasMapping(role, `unknown alias target "${target}"`);
		}
		for (const nestedTarget of expandAlias(nestedRole, aliases, memo, [...path, role])) {
			appendUnique(expandedTargets, seenTargets, nestedTarget);
		}
	}
	memo.set(role, expandedTargets);
	return expandedTargets;
}

function appendUnique(targets: string[], seenTargets: Set<string>, target: string): void {
	if (seenTargets.has(target)) return;
	seenTargets.add(target);
	targets.push(target);
}

function invalidAliasMapping(role: string, detail: string): Error {
	return new Error(`invalid mapping for "${role}": ${detail}`);
}

function isSafePrefixEvent(event: StreamEventLike): boolean {
	return event.type === "start" || event.type.startsWith("thinking_");
}

function isSuccessfulTerminal(event: StreamEventLike): boolean {
	return event.type === "done";
}

function isCommitEvent(event: StreamEventLike): boolean {
	return !isSafePrefixEvent(event) && !isSuccessfulTerminal(event) && !isFailureEvent(event) && !isAbortedTerminal(event);
}

function isFailureEvent(event: StreamEventLike): boolean {
	return event.type === "error" && event.reason !== "aborted";
}

function isAbortedTerminal(event: StreamEventLike): boolean {
	return event.type === "error" && event.reason === "aborted";
}

function failureEventReason(event: StreamEventLike): string {
	return event.error?.errorMessage || "provider returned an error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelRef(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

function splitModelRef(value: string): [string, string] {
	const slash = value.indexOf("/");
	return [value.slice(0, slash), value.slice(slash + 1)];
}
