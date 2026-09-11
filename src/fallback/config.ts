import { BUILT_IN_COOLDOWN_POLICY, DEFAULT_STATUS_REFRESH_MS, MAX_STATUS_REFRESH_MS } from "./cooldown.ts";
import { isModelRef, isRecord, splitModelRef } from "./refs.ts";
import type {
	AliasConfig,
	AliasExpansionWarning,
	AliasPolicy,
	AliasPolicyInput,
	AliasSettingWarning,
	AttemptTimeouts,
	CooldownPolicy,
} from "./types.ts";

export const BUILT_IN_POLICY: AliasPolicy = { cooldown: BUILT_IN_COOLDOWN_POLICY };

/** Nested-alias refs deeper than this are skipped with a warning; deeper nesting is almost certainly a config mistake. */
export const MAX_ALIAS_DEPTH = 4;

export function parseAliasConfig(value: unknown): AliasConfig {
	if (!isRecord(value)) throw new Error("expected a JSON object");

	const settings = parseSettings(value.$settings);
	const defaults = resolvePolicy("$defaults", BUILT_IN_POLICY, parseDefaultsPolicy(value.$defaults));
	const aliases = new Map<string, readonly string[]>();
	const rolePolicies = new Map<string, AliasPolicy>();
	for (const [role, configuredTargets] of Object.entries(value)) {
		if (role.startsWith("$")) continue;
		const config = parseRoleConfig(role, configuredTargets);
		aliases.set(role, config.targets);
		rolePolicies.set(role, resolvePolicy(role, defaults, config.policy));
	}
	const expanded = expandNestedAliases(aliases);
	return {
		aliases: expanded.aliases,
		statusRefreshMs: settings.statusRefreshMs,
		policyFor(role) {
			return rolePolicies.get(role) ?? defaults;
		},
		warnings: expanded.warnings,
		settingWarnings: settings.warnings,
	};
}

function resolvePolicy(role: string, base: AliasPolicy, overrides: AliasPolicyInput): AliasPolicy {
	const timeouts = mergeTimeouts(base.timeouts, overrides.timeouts);
	const cooldown = { ...base.cooldown, ...overrides.cooldown };
	if (cooldown.baseMs > cooldown.capMs) {
		// A lone lower cap deliberately shortens its inherited base.
		if (overrides.cooldown?.baseMs !== undefined) {
			throw new Error(`invalid mapping for "${role}": cooldown baseMs exceeds capMs`);
		}
		cooldown.baseMs = cooldown.capMs;
	}
	return { ...(timeouts ? { timeouts } : {}), cooldown };
}

function parseDefaultsPolicy(value: unknown): AliasPolicyInput {
	if (value === undefined) return {};
	const validKeys = new Set(["timeouts", "cooldown", "cooldownResetSuccesses"]);
	if (!isRecord(value) || Object.keys(value).some((key) => !validKeys.has(key))) {
		throw new Error('invalid mapping for "$defaults"');
	}
	const policy = parsePolicyFields("$defaults", value);
	if (value.cooldownResetSuccesses === undefined) return policy;
	if (policy.cooldown?.resetSuccesses !== undefined) {
		throw new Error('invalid mapping for "$defaults": set cooldown.resetSuccesses or cooldownResetSuccesses, not both');
	}
	return {
		...policy,
		cooldown: { ...policy.cooldown, resetSuccesses: parseResetSuccesses("$defaults", value.cooldownResetSuccesses) },
	};
}

function parseSettings(value: unknown): { statusRefreshMs: number; warnings: AliasSettingWarning[] } {
	if (value === undefined) return { statusRefreshMs: DEFAULT_STATUS_REFRESH_MS, warnings: [] };
	if (!isRecord(value)) {
		return invalidSettings("$settings", "expected an object");
	}

	const unknownKeys = Object.keys(value).filter((key) => key !== "statusRefreshMs");
	if (unknownKeys.length > 0) {
		return invalidSettings("$settings", `unknown setting(s): ${unknownKeys.join(", ")}`);
	}
	if (value.statusRefreshMs === undefined) {
		return { statusRefreshMs: DEFAULT_STATUS_REFRESH_MS, warnings: [] };
	}
	if (
		typeof value.statusRefreshMs !== "number" ||
		!Number.isSafeInteger(value.statusRefreshMs) ||
		value.statusRefreshMs <= 0 ||
		value.statusRefreshMs > MAX_STATUS_REFRESH_MS
	) {
		return invalidSettings(
			"$settings.statusRefreshMs",
			`expected an integer from 1 to ${MAX_STATUS_REFRESH_MS}`,
		);
	}
	return { statusRefreshMs: value.statusRefreshMs, warnings: [] };
}

function invalidSettings(setting: string, reason: string): {
	statusRefreshMs: number;
	warnings: AliasSettingWarning[];
} {
	return {
		statusRefreshMs: DEFAULT_STATUS_REFRESH_MS,
		warnings: [{ setting, reason: `${reason}; using ${DEFAULT_STATUS_REFRESH_MS}ms` }],
	};
}

function parseRoleConfig(role: string, value: unknown): { targets: readonly string[]; policy: AliasPolicyInput } {
	if (!role) throw new Error('invalid mapping for ""');
	if (!isRecord(value)) return { targets: normalizeTargets(role, value), policy: {} };
	const validKeys = new Set(["targets", "timeouts", "cooldown"]);
	if (Object.keys(value).some((key) => !validKeys.has(key)) || !("targets" in value)) {
		throw new Error(`invalid mapping for "${role}"`);
	}
	return { targets: normalizeTargets(role, value.targets), policy: parsePolicyFields(role, value) };
}

function parsePolicyFields(role: string, value: Record<string, unknown>): AliasPolicyInput {
	return {
		timeouts: parseTimeouts(role, value.timeouts),
		cooldown: parseCooldown(role, value.cooldown),
	};
}

function parseCooldown(role: string, value: unknown): Partial<CooldownPolicy> | undefined {
	if (value === undefined) return undefined;
	const validKeys = new Set(["baseMs", "capMs", "resetSuccesses"]);
	if (!isRecord(value) || Object.keys(value).some((key) => !validKeys.has(key))) {
		throw new Error(`invalid mapping for "${role}"`);
	}
	const cooldown: Partial<CooldownPolicy> = {};
	for (const key of ["baseMs", "capMs"] as const) {
		const delayMs = value[key];
		if (delayMs === undefined) continue;
		if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0) {
			throw new Error(`invalid mapping for "${role}"`);
		}
		cooldown[key] = delayMs;
	}
	if (value.resetSuccesses !== undefined) {
		cooldown.resetSuccesses = parseResetSuccesses(role, value.resetSuccesses);
	}
	return cooldown;
}

function parseResetSuccesses(role: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`invalid mapping for "${role}"`);
	}
	return value;
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
