import type { TimeoutKind } from "../latency/stats.ts";
import { BUILT_IN_COOLDOWN_POLICY, createCooldownRegistry } from "./cooldown.ts";
import { describeFailure, failureStopReason, formatExhaustionError, isRecord } from "./refs.ts";
import type {
	AttemptLatencyOutcome,
	AttemptLatencySample,
	AttemptTimeouts,
	CooldownPolicy,
	CooldownRegistry,
	FallbackOptions,
	StreamEventLike,
	TargetFailure,
	TimerApi,
	TimerHandle,
} from "./types.ts";

interface TargetAttempt {
	target: string;
	targetIndex: number;
	retriedFromCooldown: boolean;
}

interface IndexedTargetFailure extends TargetFailure {
	targetIndex: number;
}

type AttemptOutcome =
	| { kind: "complete" }
	| { kind: "retryable-failure"; reason: string }
	| { kind: "committed-failure" }
	| { kind: "unsafe-throw"; error: unknown };

interface AttemptWatchdog {
	readonly expired: Promise<void>;
	readonly fired: TimeoutKind | undefined;
	onEvent(): void;
	disarm(): void;
}

const DEFAULT_TIMERS: TimerApi = {
	setTimeout(callback, delayMs) {
		return setTimeout(callback, delayMs);
	},
	clearTimeout(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

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
			}
			if (!failureRecorded && isSuccessfulTerminal(event)) {
				cooldowns.recordSuccess(target, resetSuccessesOf(options));
			}
			if (committed && isFailureEvent(event)) {
				cooldowns.resetSuccesses(target);
				outcome = "committed-failure";
			}
			await options.forward(event);
		}
	} catch (error) {
		outcome = "unsafe-throw";
		if (!committed && !failureRecorded && failureStopReason(error, options.signal) !== "aborted") {
			warnCooldown(options, target, describeFailure(error), undefined, cooldowns);
		}
		if (committed && failureStopReason(error, options.signal) !== "aborted") cooldowns.resetSuccesses(target);
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
	options.warn(target, reason, nextTarget, cooldowns.recordFailure(target, cooldownOf(options)));
}

function cooldownOf<Event extends StreamEventLike>(options: FallbackOptions<Event>): CooldownPolicy {
	return options.policy?.cooldown ?? BUILT_IN_COOLDOWN_POLICY;
}

function resetSuccessesOf<Event extends StreamEventLike>(options: FallbackOptions<Event>): number {
	return cooldownOf(options).resetSuccesses;
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
	const timeouts = hasNextTarget ? options.policy?.timeouts : undefined;
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
				if (isSuccessfulTerminal(event)) cooldowns.recordSuccess(target, resetSuccessesOf(options));
				outcome = "complete";
				return { kind: "complete" };
			}
			if (isFailureEvent(event)) {
				latency.recordUsage(event);
				watchdog?.disarm();
				if (committed) {
					cooldowns.resetSuccesses(target);
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
			if (committed && failureStopReason(error, options.signal) !== "aborted") cooldowns.resetSuccesses(target);
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
