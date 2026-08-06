import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAP_PATH, loadAliases } from "./alias-config.ts";
import { aliasModel, initializeAliasMetadata } from "./alias-model.ts";
import { createAliasStreams } from "./alias-stream.ts";
import { registerAliasApiProvider } from "./api-registration.ts";
import { createSharedCooldownRegistry } from "./cooldown-store.ts";
import { createDebugLog } from "./debug-log.ts";
import { describeFailure } from "./fallback.ts";
import { renderStatusTick, startSession, type AliasSession as StatusSession } from "./session-status.ts";
import {
	appendFailoverEntry,
	appendResetEntry,
	registerTranscriptRenderers,
	reportFailover,
} from "./transcript.ts";

export { renderStatusTick, startSession } from "./session-status.ts";
export type { AliasSessionContext, RenderStatusTickOptions } from "./session-status.ts";

const PROVIDER_ID = "alias";
const STATUS_REFRESH_INTERVAL_MS = 5_000;
const DEBUG_LOG = createDebugLog();
const TARGET_COOLDOWNS = createSharedCooldownRegistry({ debugLog: DEBUG_LOG });

type Registry = ExtensionContext["modelRegistry"];
export type AliasSession = StatusSession<Registry, ExtensionContext["ui"]>;

export default function piModelAlias(pi: ExtensionAPI): void {
	const aliases = loadAliases(DEBUG_LOG);
	DEBUG_LOG.log("extension-load", { mapPath: MAP_PATH, aliases: [...aliases.keys()] });
	if (aliases.size === 0) return;

	const session: AliasSession = { registry: undefined, ui: undefined, hasUI: false };
	let lastPushedText: string | undefined;
	const publishStatus = () => {
		try {
			lastPushedText = renderStatusTick({
				aliases,
				session,
				lastPushedText,
				cooldowns: TARGET_COOLDOWNS,
				debugLog: DEBUG_LOG,
			});
		} catch (error) {
			DEBUG_LOG.log("ui-error", { operation: "status-tick", message: describeFailure(error) });
		}
	};
	const statusRefreshInterval = setInterval(publishStatus, STATUS_REFRESH_INTERVAL_MS);
	statusRefreshInterval.unref?.();

	const aliasModels = [...aliases.keys()].map((id) => aliasModel(id, PROVIDER_ID));
	const streams = createAliasStreams({
		aliases,
		aliasModels,
		session,
		cooldowns: TARGET_COOLDOWNS,
		debugLog: DEBUG_LOG,
		onFailover(data) {
			reportFailover(data, session, DEBUG_LOG);
			appendFailoverEntry(pi, data, DEBUG_LOG);
		},
	});
	void registerAliasApiProvider(streams);
	registerTranscriptRenderers(pi);

	pi.registerProvider(createProvider({
		id: PROVIDER_ID,
		name: "Model Aliases",
		auth: { apiKey: {
			name: "Local model alias map",
			async check() { return { source: MAP_PATH, type: "api_key" }; },
			async resolve() { return { auth: {}, source: MAP_PATH }; },
		} },
		models: aliasModels,
		api: streams,
	}));

	pi.on("session_start", (_event, ctx) => {
		if (startSession(session, ctx, DEBUG_LOG)) {
			lastPushedText = undefined;
			publishStatus();
		}
		initializeAliasMetadata(aliases, aliasModels, ctx.modelRegistry);
	});

	pi.registerCommand("reset-model-cooldown", {
		description: "Clear all model-alias target cooldowns",
		handler: async () => {
			const clearedCount = TARGET_COOLDOWNS.clearAll();
			publishStatus();
			appendResetEntry(pi, clearedCount);
		},
	});
}
