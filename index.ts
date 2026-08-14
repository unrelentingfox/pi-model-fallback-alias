import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAP_PATH, loadAliasConfig } from "./alias-config.ts";
import { aliasModel, initializeAliasMetadata } from "./alias-model.ts";
import { createAliasStreams } from "./alias-stream.ts";
import { registerAliasApiProvider } from "./api-registration.ts";
import { createSharedCooldownRegistry } from "./cooldown-store.ts";
import { createDebugLog } from "./debug-log.ts";
import { describeFailure } from "./fallback.ts";
import { EXTENSION_LATENCY_LOG_PATH, expandLogPaths, readLatencyLog } from "./latency-log.ts";
import { createLatencyReport, createLatencyReportEntry } from "./latency-report.ts";
import { renderStatusTick, startSession, type AliasSession as StatusSession } from "./session-status.ts";
import {
	appendFailoverEntry,
	appendLatencyReportEntry,
	appendResetEntry,
	registerTranscriptRenderers,
	reportFailover,
} from "./transcript.ts";

export { renderStatusTick, startSession } from "./session-status.ts";
export type { AliasSessionContext, RenderStatusTickOptions } from "./session-status.ts";

const PROVIDER_ID = "alias";
const STATUS_REFRESH_INTERVAL_MS = 30_000;
const DEBUG_LOG = createDebugLog();
const TARGET_COOLDOWNS = createSharedCooldownRegistry({ debugLog: DEBUG_LOG });

type Registry = ExtensionContext["modelRegistry"];
export type AliasSession = StatusSession<Registry, ExtensionContext["ui"]>;

export default function piModelAlias(pi: ExtensionAPI): void {
	const aliasConfig = loadAliasConfig(DEBUG_LOG);
	const { aliases, timeoutsFor } = aliasConfig;
	DEBUG_LOG.log("extension-load", { mapPath: MAP_PATH, aliases: [...aliases.keys()] });
	if (aliases.size === 0) return;

	const session: AliasSession = {
		registry: undefined,
		ui: undefined,
		hasUI: false,
		model: undefined,
		activeTargets: new Map(),
	};
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
		timeoutsFor,
		aliasModels,
		session,
		cooldowns: TARGET_COOLDOWNS,
		debugLog: DEBUG_LOG,
		onFailover(data) {
			if (data.nextTarget) session.activeTargets.set(data.role, data.nextTarget);
			reportFailover(data, session, DEBUG_LOG);
			appendFailoverEntry(pi, data, DEBUG_LOG);
			publishStatus();
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
		session.model = ctx.model;
		if (startSession(session, ctx, DEBUG_LOG)) {
			lastPushedText = undefined;
			publishStatus();
		}
		initializeAliasMetadata(aliases, aliasModels, ctx.modelRegistry);
	});

	pi.on("model_select", (event, ctx) => {
		session.model = event.model;
		if (!ctx.hasUI) return;
		lastPushedText = undefined;
		publishStatus();
	});

	pi.registerCommand("reset-model-cooldown", {
		description: "Clear all model-alias target cooldowns",
		handler: async () => {
			const clearedCount = TARGET_COOLDOWNS.clearAll();
			publishStatus();
			appendResetEntry(pi, clearedCount);
		},
	});

	pi.registerCommand("alias-latency-report", {
		description: "Show model-alias attempt latency statistics",
		getArgumentCompletions: (prefix) => [...aliases.keys()]
			.filter((role) => role.startsWith(prefix))
			.map((role) => ({ value: role, label: role })),
		handler: async (args) => {
			const role = args.trim() || undefined;
			const report = createLatencyReport(readLatencyLog(expandLogPaths([EXTENSION_LATENCY_LOG_PATH])));
			appendLatencyReportEntry(pi, createLatencyReportEntry(report, [...aliases.keys()], role));
		},
	});
}
