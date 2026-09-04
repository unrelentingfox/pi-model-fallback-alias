import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const STATE_DIR_ENV = "PI_MODEL_ALIAS_STATE_DIR";

export function resolveStateDir(
	env: Record<string, string | undefined> = process.env,
	agentDir: string = getAgentDir(),
): string {
	const configured = env[STATE_DIR_ENV]?.trim();
	return configured ? resolve(configured) : resolve(agentDir, "state", "pi-model-fallback-aliases");
}

export const STATE_DIR = resolveStateDir();
