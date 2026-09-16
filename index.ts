import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAP_PATH, createPolicyLoader, loadAliasConfig } from "./src/alias-config.ts";
import { aliasModel, initializeAliasMetadata } from "./src/alias/alias-model.ts";
import { createAliasStreams } from "./src/stream/alias-stream.ts";
import { registerAliasApiProvider } from "./src/alias/api-registration.ts";
import { createAliasAuth } from "./src/alias/auth-gate.ts";
import { createSharedCooldownRegistry } from "./src/cooldown-store.ts";
import { createDebugLog, type DebugLog } from "./src/debug-log.ts";
import { describeFailure, type AliasConfig, type CooldownRegistry } from "./src/fallback/index.ts";
import { EXTENSION_LATENCY_LOG_PATH, expandLogPaths, readLatencyLog } from "./src/latency/log.ts";
import { createLatencyReport, createLatencyReportEntry } from "./src/latency/report.ts";
import { renderStatusTick, startSession, type AliasSession as StatusSession } from "./src/status/session-status.ts";
import {
	appendAliasTargetsEntry,
	appendConfigWarningEntry,
	appendFailoverEntry,
	appendLatencyReportEntry,
	appendPolicyWarningEntry,
	appendResetEntry,
	appendSettingWarningEntry,
	createAliasTargetsEntry,
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

export interface PiModelAliasDependencies {
	aliasConfig?: AliasConfig;
	debugLog?: DebugLog;
	cooldowns?: CooldownRegistry;
	timers?: import("./src/fallback/types.ts").TimerApi;
}

export default function piModelAlias(pi: ExtensionAPI): void {
	installPiModelAlias(pi);
}

export function installPiModelAlias(pi: ExtensionAPI, dependencies: PiModelAliasDependencies = {}): void {
	const debugLog = dependencies.debugLog ?? DEBUG_LOG;
	const targetCooldowns = dependencies.cooldowns ?? TARGET_COOLDOWNS;
	const aliasConfig = dependencies.aliasConfig ?? loadAliasConfig(debugLog);
	const { aliases } = aliasConfig;
	let pendingConfigWarnings = [...aliasConfig.warnings];
	let pendingSettingWarnings = [...aliasConfig.settingWarnings];
	debugLog.log("extension-load", { mapPath: MAP_PATH, aliases: [...aliases.keys()] });
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
				cooldowns: targetCooldowns,
				debugLog,
			});
		} catch (error) {
			debugLog.log("ui-error", { operation: "status-tick", message: describeFailure(error) });
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
		debugLog,
		initial: aliasConfig,
		onWarning(warning) {
			appendPolicyWarningEntry(pi, warning, debugLog);
			if (!session.hasUI) console.warn(`[pi-model-alias] ${formatPolicyWarning(warning)}`);
		},
	});
	const streams = createAliasStreams({
		aliases,
		policyFor,
		aliasModels,
		session,
		cooldowns: targetCooldowns,
		debugLog,
		timers: dependencies.timers,
		onTargetSelected() {
			publishStatus();
		},
		onFailover(data) {
			if (data.nextTarget) session.activeTargets.set(data.role, data.nextTarget);
			reportFailover(data, session, debugLog);
			appendFailoverEntry(pi, data, debugLog);
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
		if (startSession(session, ctx, debugLog)) {
			lastPushedText = undefined;
			startStatusRefresh();
			publishStatus();
		}
		initializeAliasMetadata(aliases, aliasModels, ctx.modelRegistry);
		if (pendingSettingWarnings.length > 0) {
			const warnings = pendingSettingWarnings;
			pendingSettingWarnings = [];
			for (const warning of warnings) {
				debugLog.log("setting-warning", { ...warning });
				if (!session.hasUI) console.warn(`[pi-model-alias] ${formatSettingWarning(warning)}`);
				appendSettingWarningEntry(pi, warning, debugLog);
			}
		}
		// Config warnings render once, for the user only: custom transcript
		// entries never enter the model context.
		if (pendingConfigWarnings.length > 0) {
			const warnings = pendingConfigWarnings;
			pendingConfigWarnings = [];
			for (const warning of warnings) {
				debugLog.log("expand-warning", { ...warning });
				if (!session.hasUI) console.warn(`[pi-model-alias] ${formatConfigWarning(warning)}`);
				appendConfigWarningEntry(pi, warning, debugLog);
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

	pi.registerCommand("model-alias-reset-cooldown", {
		description: "Clear all model-alias target cooldowns",
		handler: async () => {
			const clearedCount = targetCooldowns.clearAll();
			publishStatus();
			appendResetEntry(pi, clearedCount);
		},
	});

	pi.registerCommand("model-alias-targets", {
		description: "Show fully flattened model-alias chains",
		getArgumentCompletions: (prefix) => [...aliases.keys()]
			.filter((role) => role.startsWith(prefix))
			.map((role) => ({ value: role, label: role })),
		handler: async (args) => {
			const role = args.trim() || undefined;
			appendAliasTargetsEntry(pi, createAliasTargetsEntry(aliases, role));
		},
	});

	pi.registerCommand("model-alias-latency-report", {
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
