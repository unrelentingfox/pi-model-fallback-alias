import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAP_PATH, createPolicyLoader, loadAliasConfig } from "./src/alias-config.ts";
import { aliasModel, initializeAliasMetadata } from "./src/alias/alias-model.ts";
import { createAliasStreams } from "./src/stream/alias-stream.ts";
import { registerAliasApiProvider } from "./src/alias/api-registration.ts";
import { createAliasAuth } from "./src/alias/auth-gate.ts";
import { createSharedCooldownRegistry } from "./src/cooldown-store.ts";
import { createDebugLog } from "./src/debug-log.ts";
import { describeFailure } from "./src/fallback/index.ts";
import { EXTENSION_LATENCY_LOG_PATH, expandLogPaths, readLatencyLog } from "./src/latency/log.ts";
import { createLatencyReport, createLatencyReportEntry } from "./src/latency/report.ts";
import { renderStatusTick, startSession, type AliasSession as StatusSession } from "./src/status/session-status.ts";
import {
	appendConfigWarningEntry,
	appendFailoverEntry,
	appendLatencyReportEntry,
	appendPolicyWarningEntry,
	appendResetEntry,
	appendSettingWarningEntry,
	formatConfigWarning,
	formatPolicyWarning,
	formatSettingWarning,
	registerTranscriptRenderers,
	reportFailover,
} from "./src/status/transcript.ts";

export { renderStatusTick, startSession } from "./src/status/session-status.ts";
export type { AliasSessionContext, RenderStatusTickOptions } from "./src/status/session-status.ts";

const PROVIDER_ID = "alias";
const DEBUG_LOG = createDebugLog();
const TARGET_COOLDOWNS = createSharedCooldownRegistry({ debugLog: DEBUG_LOG });

type Registry = ExtensionContext["modelRegistry"];
export type AliasSession = StatusSession<Registry, ExtensionContext["ui"]>;

export default function piModelAlias(pi: ExtensionAPI): void {
	const aliasConfig = loadAliasConfig(DEBUG_LOG);
	const { aliases } = aliasConfig;
	let pendingConfigWarnings = [...aliasConfig.warnings];
	let pendingSettingWarnings = [...aliasConfig.settingWarnings];
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
	let statusRefreshInterval: ReturnType<typeof setInterval> | undefined;
	const startStatusRefresh = () => {
		if (statusRefreshInterval) return;
		statusRefreshInterval = setInterval(publishStatus, aliasConfig.statusRefreshMs);
		statusRefreshInterval.unref?.();
	};
	const stopStatusRefresh = () => {
		if (!statusRefreshInterval) return;
		clearInterval(statusRefreshInterval);
		statusRefreshInterval = undefined;
	};

	const aliasModels = [...aliases.keys()].map((id) => aliasModel(id, PROVIDER_ID));
	const policyFor = createPolicyLoader({
		debugLog: DEBUG_LOG,
		initial: aliasConfig,
		onWarning(warning) {
			appendPolicyWarningEntry(pi, warning, DEBUG_LOG);
			if (!session.hasUI) console.warn(`[pi-model-alias] ${formatPolicyWarning(warning)}`);
		},
	});
	const streams = createAliasStreams({
		aliases,
		policyFor,
		aliasModels,
		session,
		cooldowns: TARGET_COOLDOWNS,
		debugLog: DEBUG_LOG,
		onTargetSelected() {
			publishStatus();
		},
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
		// Registry consumers receive a non-secret availability gate. Streaming
		// drops it and resolves the selected target's real auth.
		auth: createAliasAuth(MAP_PATH),
		models: aliasModels,
		api: streams,
	}));

	pi.on("session_start", (_event, ctx) => {
		session.model = ctx.model;
		if (startSession(session, ctx, DEBUG_LOG)) {
			lastPushedText = undefined;
			startStatusRefresh();
			publishStatus();
		}
		initializeAliasMetadata(aliases, aliasModels, ctx.modelRegistry);
		if (pendingSettingWarnings.length > 0) {
			const warnings = pendingSettingWarnings;
			pendingSettingWarnings = [];
			for (const warning of warnings) {
				DEBUG_LOG.log("setting-warning", { ...warning });
				if (!session.hasUI) console.warn(`[pi-model-alias] ${formatSettingWarning(warning)}`);
				appendSettingWarningEntry(pi, warning, DEBUG_LOG);
			}
		}
		// Config warnings render once, for the user only: custom transcript
		// entries never enter the model context.
		if (pendingConfigWarnings.length > 0) {
			const warnings = pendingConfigWarnings;
			pendingConfigWarnings = [];
			for (const warning of warnings) {
				DEBUG_LOG.log("expand-warning", { ...warning });
				if (!session.hasUI) console.warn(`[pi-model-alias] ${formatConfigWarning(warning)}`);
				appendConfigWarningEntry(pi, warning, DEBUG_LOG);
			}
		}
	});

	pi.on("session_shutdown", () => {
		stopStatusRefresh();
	});

	pi.on("model_select", (event, ctx) => {
		session.model = event.model;
		if (!ctx.hasUI) return;
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
