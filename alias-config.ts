import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DebugLog } from "./debug-log.ts";
import { describeFailure, parseAliasMap, type AliasMap } from "./fallback.ts";

const DEFAULT_MAP_PATH = join(getAgentDir(), "model-alias.json");
export const MAP_PATH = process.env.PI_MODEL_ALIAS_MAP || DEFAULT_MAP_PATH;

export function loadAliases(debugLog: DebugLog): AliasMap {
	try {
		return parseAliasMap(JSON.parse(readFileSync(MAP_PATH, "utf8")) as unknown);
	} catch (error) {
		debugLog.log("alias-map-error", { mapPath: MAP_PATH, message: describeFailure(error) });
		console.warn(`[pi-model-alias] No aliases registered; could not load ${MAP_PATH}: ${describeFailure(error)}`);
		return new Map();
	}
}
