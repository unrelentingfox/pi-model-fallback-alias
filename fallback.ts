import type { LatencyOutcome, LatencySample, TimeoutKind } from "./latency-stats.ts";

export type AliasMap = ReadonlyMap<string, readonly string[]>;

export interface AttemptTimeouts {
	firstEventMs?: number;
	stallMs?: number;
	commitMs?: number;
}

export interface TimerHandle {
	unref?(): void;
}

export interface TimerApi {
	setTimeout(callback: () => void, delayMs: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

export interface AliasConfig {
	aliases: AliasMap;
	timeoutsFor(role: string): AttemptTimeouts | undefined;
	warnings: readonly AliasExpansionWarning[];
}

/** A nested-alias ref skipped during expansion (cycle, unknown alias, or depth cap). */
export interface AliasExpansionWarning {
	role: string;
	target: string;
	reason: string;
}

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

export type AttemptLatencySample = LatencySample;
export type AttemptLatencyOutcome = LatencyOutcome;

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
	message?: unknown;
	error?: { errorMessage?: string };
}

export interface FallbackOptions<Event extends StreamEventLike> {
	role: string;
	targets: readonly string[];
	cooldowns?: CooldownRegistry;
	signal?: Pick<AbortSignal, "aborted">;
	open(target: string, attemptSignal?: AbortSignal): Promise<AsyncIterable<Event>>;
	forward(event: Event): void | Promise<void>;
	warn(failedTarget: string, reason: string, nextTarget: string | undefined, cooldown: CooldownUpdate): void;
	snapshot?(event: Event): Event;
	timeoutsFor?(target: string): AttemptTimeouts | undefined;
	timers?: TimerApi;
	now?: () => number;
	onLatency?(sample: AttemptLatencySample): void;
	onTimeout?(target: string, reason: string): void;
}

interface AttemptWatchdog {
	readonly expired: Promise<void>;
	readonly fired: TimeoutKind | undefined;
	onEvent(): void;
	disarm(): void;
}

type AttemptOutcome =
	| { kind: "complete" }
	| { kind: "retryable-failure"; reason: string }
	| { kind: "committed-failure" }
	| { kind: "unsafe-throw"; error: unknown };

const DEFAULT_TIMERS: TimerApi = {
	setTimeout(callback, delayMs) {
		return setTimeout(callback, delayMs);
	},
	clearTimeout(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_CAP_MS = 30 * 60_000;
const MAX_UNCAPPED_EXPONENT = 6;

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

export function parseAliasConfig(value: unknown): AliasConfig {
	if (!isRecord(value)) throw new Error("expected a JSON object");

	const defaults = parseDefaults(value.$defaults);
	const aliases = new Map<string, readonly string[]>();
	const roleTimeouts = new Map<string, AttemptTimeouts>();
	for (const [role, configuredTargets] of Object.entries(value)) {
		if (role === "$defaults") continue;
		const config = parseRoleConfig(role, configuredTargets);
		aliases.set(role, config.targets);
		const timeouts = mergeTimeouts(defaults, config.timeouts);
		if (timeouts) roleTimeouts.set(role, timeouts);
	}
	const expanded = expandNestedAliases(aliases);
	return {
		aliases: expanded.aliases,
		timeoutsFor(role) {
			return roleTimeouts.get(role);
		},
		warnings: expanded.warnings,
	};
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
	if (options.targets.length === 0) {
		throw new Error(
			`Model alias "${options.role}" has no usable targets (all skipped during config expansion — see model-alias config warnings)`,
		);
	}
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
		const outcome = await attemptTarget(options, attempt.target, cooldowns, nextTarget !== undefined);
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
	let outcome: AttemptLatencyOutcome = "complete";
	const latency = createLatencySampler(options, target);
	try {
		const stream = await options.open(target);
		for await (const event of stream) {
			latency.recordEvent();
			if (isSuccessfulTerminal(event) || isAbortedTerminal(event) || isFailureEvent(event)) latency.recordUsage(event);
			if (!committed && !failureRecorded && isFailureEvent(event)) {
				failureRecorded = true;
				outcome = "retryable-failure";
				warnCooldown(options, target, failureEventReason(event), undefined, cooldowns);
			}
			if (!committed && isCommitEvent(event)) {
				committed = true;
				latency.commit();
				if (!failureRecorded) cooldowns.reset(target);
			}
			if (committed && isFailureEvent(event)) outcome = "committed-failure";
			await options.forward(event);
		}
	} catch (error) {
		outcome = "unsafe-throw";
		if (!committed && !failureRecorded && failureStopReason(error, options.signal) !== "aborted") {
			warnCooldown(options, target, describeFailure(error), undefined, cooldowns);
		}
		throw error;
	} finally {
		latency.emit(outcome);
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

async function attemptTarget<Event extends StreamEventLike>(
	options: FallbackOptions<Event>,
	target: string,
	cooldowns: CooldownRegistry,
	hasNextTarget: boolean,
): Promise<AttemptOutcome> {
	let committed = false;
	let outcome: AttemptLatencyOutcome = "unsafe-throw";
	const latency = createLatencySampler(options, target);
	const buffered: Event[] = [];
	const timeouts = hasNextTarget ? options.timeoutsFor?.(target) : undefined;
	const controller = timeouts ? new AbortController() : undefined;
	const watchdog = timeouts ? createWatchdog(timeouts, options.timers ?? DEFAULT_TIMERS, () => controller!.abort()) : undefined;
	try {
		const stream = await options.open(target, controller?.signal);
		const iterator = stream[Symbol.asyncIterator]();
		for (;;) {
			const next = iterator.next();
			// Once committed, a stale fire must never win the race: failover is no longer possible.
			const racing = watchdog !== undefined && !committed;
			const result = racing ? await Promise.race([next, watchdog!.expired.then(() => undefined)]) : await next;
			if (racing && watchdog!.fired) {
				void next.catch(() => undefined);
				void iterator.return?.().catch(() => undefined);
				const reason = timeoutReason(watchdog.fired, timeouts!);
				options.onTimeout?.(target, reason);
				outcome = "timeout";
				return { kind: "retryable-failure", reason };
			}
			if (!result || result.done) break;
			const event = result.value;
			latency.recordEvent();
			if (!committed) watchdog?.onEvent();
			if (isSuccessfulTerminal(event) || isAbortedTerminal(event)) {
				latency.recordUsage(event);
				watchdog?.disarm();
				await flush(buffered, options.forward);
				await options.forward(event);
				outcome = "complete";
				return { kind: "complete" };
			}
			if (isFailureEvent(event)) {
				latency.recordUsage(event);
				watchdog?.disarm();
				if (committed) {
					await options.forward(event);
					outcome = "committed-failure";
					return { kind: "committed-failure" };
				}
				outcome = "retryable-failure";
				return { kind: "retryable-failure", reason: failureEventReason(event) };
			}
			if (!committed && isSafePrefixEvent(event)) {
				buffered.push(options.snapshot?.(event) ?? event);
				continue;
			}
			if (!committed) {
				watchdog?.disarm();
				await flush(buffered, options.forward);
				committed = true;
				latency.commit();
				cooldowns.reset(target);
			}
			await options.forward(event);
		}
		watchdog?.disarm();
		const reason = "stream ended without a terminal event";
		outcome = committed ? "unsafe-throw" : "retryable-failure";
		return committed ? { kind: "unsafe-throw", error: new Error(reason) } : { kind: "retryable-failure", reason };
	} catch (error) {
		watchdog?.disarm();
		if (watchdog?.fired && !committed) {
			const reason = timeoutReason(watchdog.fired, timeouts!);
			options.onTimeout?.(target, reason);
			outcome = "timeout";
			return { kind: "retryable-failure", reason };
		}
		if (committed || failureStopReason(error, options.signal) === "aborted") {
			outcome = "unsafe-throw";
			return { kind: "unsafe-throw", error };
		}
		outcome = "retryable-failure";
		return { kind: "retryable-failure", reason: describeFailure(error) };
	} finally {
		latency.emit(outcome, outcome === "timeout" ? watchdog?.fired : undefined);
	}
}

function createLatencySampler<Event extends StreamEventLike>(
	options: FallbackOptions<Event>,
	targetRef: string,
): { recordEvent(): void; commit(): void; recordUsage(event: Event): void; emit(outcome: AttemptLatencyOutcome, timeoutKind?: TimeoutKind): void } {
	const now = options.now ?? Date.now;
	const openedAt = now();
	let firstEventAt: number | undefined;
	let previousEventAt: number | undefined;
	let commitAt: number | undefined;
	let maxGapMs = 0;
	let eventCount = 0;
	let tokens: Pick<AttemptLatencySample, "inputTokens" | "cacheReadTokens" | "outputTokens"> = {};
	return {
		recordEvent() {
			const eventAt = now();
			firstEventAt ??= eventAt;
			if (previousEventAt !== undefined) maxGapMs = Math.max(maxGapMs, eventAt - previousEventAt);
			previousEventAt = eventAt;
			eventCount++;
		},
		commit() {
			commitAt ??= now();
		},
		recordUsage(event) {
			tokens = extractUsage(event) ?? tokens;
		},
		emit(outcome, timeoutKind) {
			try {
				const sample: AttemptLatencySample = {
					role: options.role,
					targetRef,
					...(firstEventAt === undefined ? {} : { ttfbMs: firstEventAt - openedAt }),
					maxGapMs,
					...(commitAt === undefined ? {} : { commitMs: commitAt - openedAt }),
					totalMs: now() - openedAt,
					eventCount,
					committed: commitAt !== undefined,
					outcome,
					...(timeoutKind === undefined ? {} : { timeoutKind }),
					...tokens,
				};
				options.onLatency?.(sample);
			} catch {}
		},
	};
}

function extractUsage(event: StreamEventLike): Pick<AttemptLatencySample, "inputTokens" | "cacheReadTokens" | "outputTokens"> | undefined {
	if (!isRecord(event)) return undefined;
	const terminalMessage = event.type === "done" ? event.message : event.error;
	if (!isRecord(terminalMessage) || !isRecord(terminalMessage.usage)) return undefined;
	const { input, cacheRead, output } = terminalMessage.usage;
	if (typeof input !== "number" || typeof cacheRead !== "number" || typeof output !== "number") return undefined;
	return { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output };
}

function createWatchdog(timeouts: AttemptTimeouts, timers: TimerApi, expire: () => void): AttemptWatchdog {
	let firstEventHandle: TimerHandle | undefined;
	let stallHandle: TimerHandle | undefined;
	let commitHandle: TimerHandle | undefined;
	let disarmed = false;
	let fired: TimeoutKind | undefined;
	let resolveExpired!: () => void;
	const expired = new Promise<void>((resolve) => {
		resolveExpired = resolve;
	});

	const fire = (kind: TimeoutKind) => {
		if (fired) return;
		fired = kind;
		resolveExpired();
		expire();
	};
	const arm = (delayMs: number | undefined, kind: TimeoutKind): TimerHandle | undefined => {
		if (disarmed || !delayMs) return undefined;
		const handle = timers.setTimeout(() => fire(kind), delayMs);
		handle.unref?.();
		return handle;
	};
	const clear = (handle: TimerHandle | undefined) => {
		if (handle) timers.clearTimeout(handle);
	};

	firstEventHandle = arm(timeouts.firstEventMs, "first event");
	stallHandle = arm(timeouts.stallMs, "stall");
	commitHandle = arm(timeouts.commitMs, "commit");
	return {
		expired,
		get fired() {
			return fired;
		},
		onEvent() {
			clear(firstEventHandle);
			firstEventHandle = undefined;
			clear(stallHandle);
			stallHandle = arm(timeouts.stallMs, "stall");
		},
		disarm() {
			disarmed = true;
			clear(firstEventHandle);
			clear(stallHandle);
			clear(commitHandle);
		},
	};
}

function timeoutReason(kind: TimeoutKind, timeouts: AttemptTimeouts): string {
	const delayMs = kind === "first event" ? timeouts.firstEventMs : kind === "stall" ? timeouts.stallMs : timeouts.commitMs;
	return `latency timeout: no ${kind} within ${delayMs}ms`;
}

async function flush<Event>(events: Event[], forward: (event: Event) => void | Promise<void>): Promise<void> {
	for (const event of events) await forward(event);
	events.length = 0;
}

function parseDefaults(value: unknown): AttemptTimeouts | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "timeouts")) {
		throw new Error('invalid mapping for "$defaults"');
	}
	return parseTimeouts("$defaults", value.timeouts);
}

function parseRoleConfig(role: string, value: unknown): { targets: readonly string[]; timeouts?: AttemptTimeouts } {
	if (!role) throw new Error('invalid mapping for ""');
	if (!isRecord(value)) return { targets: normalizeTargets(role, value) };
	if (Object.keys(value).some((key) => key !== "targets" && key !== "timeouts") || !("targets" in value)) {
		throw new Error(`invalid mapping for "${role}"`);
	}
	return { targets: normalizeTargets(role, value.targets), timeouts: parseTimeouts(role, value.timeouts) };
}

function parseTimeouts(role: string, value: unknown): AttemptTimeouts | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`invalid mapping for "${role}"`);
	const validKeys = new Set(["firstEventMs", "stallMs", "commitMs"]);
	if (Object.keys(value).some((key) => !validKeys.has(key))) throw new Error(`invalid mapping for "${role}"`);
	const timeouts: AttemptTimeouts = {};
	for (const key of validKeys) {
		const delayMs = value[key];
		if (delayMs === undefined) continue;
		if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0) {
			throw new Error(`invalid mapping for "${role}"`);
		}
		Object.assign(timeouts, { [key]: delayMs });
	}
	return timeouts;
}

function mergeTimeouts(defaults: AttemptTimeouts | undefined, overrides: AttemptTimeouts | undefined): AttemptTimeouts | undefined {
	if (!defaults && !overrides) return undefined;
	return { ...defaults, ...overrides };
}

function normalizeTargets(role: string, value: unknown): readonly string[] {
	const targets = typeof value === "string" ? [value] : value;
	if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => !isModelRef(target))) {
		throw new Error(`invalid mapping for "${role}"`);
	}
	return targets;
}

/** Nested-alias refs deeper than this are skipped with a warning; deeper nesting is almost certainly a config mistake. */
export const MAX_ALIAS_DEPTH = 4;

interface ExpandedAliases {
	aliases: Map<string, readonly string[]>;
	warnings: readonly AliasExpansionWarning[];
}

function expandNestedAliases(aliases: Map<string, readonly string[]>): ExpandedAliases {
	const expandedAliases = new Map<string, readonly string[]>();
	// Keyed dedupe: expansions recompute per entry point and would repeat warnings.
	const warnings = new Map<string, AliasExpansionWarning>();
	for (const role of aliases.keys()) {
		expandedAliases.set(role, expandAlias(role, aliases, [], warnings));
	}
	return { aliases: expandedAliases, warnings: [...warnings.values()] };
}

// Deliberately unmemoized: the depth cap makes an expansion path-dependent, so a
// reused result would let declaration order decide whether a deep ref is skipped.
// Alias maps are tiny (a handful of roles, depth ≤ MAX_ALIAS_DEPTH), so each
// top-level role re-expands with its own true path depth.
function expandAlias(
	role: string,
	aliases: Map<string, readonly string[]>,
	path: readonly string[],
	warnings: Map<string, AliasExpansionWarning>,
): readonly string[] {
	const expandedTargets: string[] = [];
	const seenTargets = new Set<string>();
	for (const target of aliases.get(role)!) {
		const [providerId, nestedRole] = splitModelRef(target);
		if (providerId !== "alias") {
			appendUnique(expandedTargets, seenTargets, target);
			continue;
		}
		const skipReason = nestedSkipReason(role, nestedRole, aliases, path);
		if (skipReason) {
			recordWarning(warnings, { role, target, reason: skipReason });
			continue;
		}
		for (const nestedTarget of expandAlias(nestedRole, aliases, [...path, role], warnings)) {
			appendUnique(expandedTargets, seenTargets, nestedTarget);
		}
	}
	return expandedTargets;
}

function nestedSkipReason(
	role: string,
	nestedRole: string,
	aliases: Map<string, readonly string[]>,
	path: readonly string[],
): string | undefined {
	if (!aliases.has(nestedRole)) return `unknown alias target "alias/${nestedRole}"`;
	if (nestedRole === role || path.includes(nestedRole)) {
		const chain = [...path, role, nestedRole];
		return `alias cycle ${chain.slice(chain.indexOf(nestedRole)).join(" -> ")}`;
	}
	if (path.length + 1 > MAX_ALIAS_DEPTH) return `alias nesting deeper than ${MAX_ALIAS_DEPTH} levels`;
	return undefined;
}

function recordWarning(warnings: Map<string, AliasExpansionWarning>, warning: AliasExpansionWarning): void {
	warnings.set(`${warning.role}\u0000${warning.target}\u0000${warning.reason}`, warning);
}

function appendUnique(targets: string[], seenTargets: Set<string>, target: string): void {
	if (seenTargets.has(target)) return;
	seenTargets.add(target);
	targets.push(target);
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
