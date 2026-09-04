import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DebugLog } from "./debug-log.ts";
import { BUILT_IN_POLICY, describeFailure, parseAliasConfig, type AliasConfig, type AliasPolicy } from "./fallback.ts";

const DEFAULT_MAP_PATH = join(getAgentDir(), "model-alias.json");
export const MAP_PATH = process.env.PI_MODEL_ALIAS_MAP || DEFAULT_MAP_PATH;

const EMPTY_CONFIG: AliasConfig = {
	aliases: new Map(),
	policyFor: () => BUILT_IN_POLICY,
	warnings: [],
};

/** One requested-alias policy plus the cost of obtaining it. */
export interface PolicyLoad {
	policy: AliasPolicy;
	configLoadMs: number;
	/** True when the current file could not supply this alias and a cached policy was used. */
	degraded: boolean;
}

export interface PolicyWarning {
	role: string;
	reason: string;
}

export interface PolicyLoaderOptions {
	debugLog: DebugLog;
	initial: AliasConfig;
	path?: string;
	readConfig?(path: string): string;
	now?(): number;
	onWarning?(warning: PolicyWarning): void;
}

/** Reads the map, parses it, and returns the requested alias policy. Throws on any problem. */
export function readAliasConfig(path: string, readConfig: (path: string) => string = defaultRead): AliasConfig {
	return parseAliasConfig(JSON.parse(readConfig(path)) as unknown);
}

export function loadAliasConfig(debugLog: DebugLog): AliasConfig {
	try {
		return readAliasConfig(MAP_PATH);
	} catch (error) {
		debugLog.log("alias-map-error", { mapPath: MAP_PATH, message: describeFailure(error) });
		console.warn(`[pi-model-alias] No aliases registered; could not load ${MAP_PATH}: ${describeFailure(error)}`);
		return EMPTY_CONFIG;
	}
}

/**
 * Per-stream policy source. Cooldown state is shared across processes, so each
 * stream re-reads the map instead of trusting a startup snapshot. A bad file
 * fails open on the last valid policy: availability matters more than making
 * every process agree during a broken edit.
 */
export function createPolicyLoader(options: PolicyLoaderOptions): (role: string) => PolicyLoad {
	const { debugLog, initial } = options;
	const path = options.path ?? MAP_PATH;
	const readConfig = options.readConfig ?? defaultRead;
	const now = options.now ?? (() => performance.now());
	const onWarning = options.onWarning ?? ((warning: PolicyWarning) => console.warn(defaultWarningMessage(warning)));
	const cache = new Map<string, AliasPolicy>();
	for (const role of initial.aliases.keys()) cache.set(role, initial.policyFor(role));
	// Each alias recovers independently from a bad shared file.
	const warnedReasons = new Map<string, string>();

	return function policyFor(role: string): PolicyLoad {
		const startedAt = now();
		try {
			const config = readAliasConfig(path, readConfig);
			// A parseable file that dropped the alias is still unusable for it.
			if (!config.aliases.has(role)) throw new Error(`alias "${role}" is no longer configured`);
			const policy = config.policyFor(role);
			cache.set(role, policy);
			if (warnedReasons.delete(role)) debugLog.log("alias-policy-recovered", { mapPath: path, role });
			return { policy, configLoadMs: elapsed(startedAt), degraded: false };
		} catch (error) {
			const reason = describeFailure(error);
			reportDegraded(role, reason);
			return { policy: cache.get(role) ?? BUILT_IN_POLICY, configLoadMs: elapsed(startedAt), degraded: true };
		}
	};

	function reportDegraded(role: string, reason: string): void {
		debugLog.log("alias-policy-stale", { mapPath: path, role, reason });
		if (warnedReasons.get(role) === reason) return;
		warnedReasons.set(role, reason);
		onWarning({ role, reason });
	}

	function elapsed(startedAt: number): number {
		return Math.max(0, now() - startedAt);
	}
}

function defaultWarningMessage(warning: PolicyWarning): string {
	return `[pi-model-alias] Using last valid policy for "${warning.role}"; could not load current config: ${warning.reason}`;
}

function defaultRead(path: string): string {
	return readFileSync(path, "utf8");
}
