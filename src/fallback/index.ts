export type {
	AliasConfig,
	AliasExpansionWarning,
	AliasMap,
	AliasPolicy,
	AliasPolicyInput,
	AliasSettingWarning,
	AttemptLatencyOutcome,
	AttemptLatencySample,
	AttemptTimeouts,
	CooldownPolicy,
	CooldownRegistry,
	CooldownState,
	CooldownUpdate,
	FailoverEntryData,
	FallbackOptions,
	ResolvedTarget,
	TargetFailure,
	TargetRegistry,
	TimerApi,
	TimerHandle,
} from "./types.ts";

export {
	BUILT_IN_COOLDOWN_POLICY,
	COOLDOWN_BASE_MS,
	COOLDOWN_CAP_MS,
	createCooldownRegistry,
	DEFAULT_STATUS_REFRESH_MS,
	MAX_STATUS_REFRESH_MS,
	nextCooldown,
} from "./cooldown.ts";

export { BUILT_IN_POLICY, MAX_ALIAS_DEPTH, parseAliasConfig } from "./config.ts";

export {
	describeFailure,
	failureStopReason,
	formatExhaustionError,
	resolveFirstTarget,
	resolveTargetReference,
} from "./refs.ts";

export { runFallbackChain } from "./chain.ts";
