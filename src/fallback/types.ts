import type { LatencyOutcome, LatencySample, ProviderResponseMetadata } from "../latency/stats.ts";

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

/** Cooldown growth and recovery rules for one requested alias. */
export interface CooldownPolicy {
	baseMs: number;
	capMs: number;
	resetSuccesses: number;
}

/** Fully resolved policy: built-in defaults, then `$defaults`, then alias overrides. */
export interface AliasPolicy {
	timeouts?: AttemptTimeouts;
	cooldown: CooldownPolicy;
}

/** Partial policy as written in `$defaults` or an object-form alias entry. */
export interface AliasPolicyInput {
	timeouts?: AttemptTimeouts;
	cooldown?: Partial<CooldownPolicy>;
}

export interface AliasConfig {
	aliases: AliasMap;
	statusRefreshMs: number;
	policyFor(role: string): AliasPolicy;
	warnings: readonly AliasExpansionWarning[];
	settingWarnings: readonly AliasSettingWarning[];
}

/** A nested-alias ref skipped during expansion (cycle, unknown alias, or depth cap). */
export interface AliasExpansionWarning {
	role: string;
	target: string;
	reason: string;
}

export interface AliasSettingWarning {
	setting: string;
	reason: string;
}

export interface FailoverEntryData extends Partial<ProviderResponseMetadata> {
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
	successCount?: number;
}

export interface CooldownUpdate extends CooldownState {
	durationMs: number;
}

export interface CooldownRegistry {
	isActive(target: string): boolean;
	recordFailure(target: string, cooldown?: CooldownPolicy): CooldownUpdate;
	recordSuccess(target: string, resetAfter: number): void;
	resetSuccesses(target: string): void;
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

export interface StreamEventLike {
	type: string;
	reason?: string;
	message?: unknown;
	error?: { errorMessage?: string };
}

export interface FallbackOptions<Event extends StreamEventLike> {
	role: string;
	targets: readonly string[];
	cooldowns?: CooldownRegistry;
	/** Resolved policy of the requested alias; omitted means built-in defaults. */
	policy?: AliasPolicy;
	signal?: Pick<AbortSignal, "aborted">;
	open(target: string, attemptSignal?: AbortSignal): Promise<AsyncIterable<Event>>;
	forward(event: Event): void | Promise<void>;
	warn(failedTarget: string, reason: string, nextTarget: string | undefined, cooldown: CooldownUpdate): void;
	snapshot?(event: Event): Event;
	timers?: TimerApi;
	now?: () => number;
	onLatency?(sample: AttemptLatencySample): void;
	onTimeout?(target: string, reason: string): void;
}
