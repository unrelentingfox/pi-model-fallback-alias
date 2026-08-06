import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	createProvider,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Provider,
	type ProviderHeaders,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { ALIAS_API_ID, registerAliasApiProvider } from "./api-registration.ts";
import { createSharedCooldownRegistry } from "./cooldown-store.ts";
import { createDebugLog } from "./debug-log.ts";
import {
	describeFailure,
	failureStopReason,
	parseAliasMap,
	resolveFirstTarget,
	resolveTargetReference,
	runFallbackChain,
	type AliasMap,
} from "./fallback.ts";
import {
	renderStatusTick,
	startSession,
	type AliasSession as StatusSession,
} from "./session-status.ts";
import { formatDuration, formatFailoverWarning } from "./status.ts";

export { renderStatusTick, startSession } from "./session-status.ts";
export type { AliasSessionContext, RenderStatusTickOptions } from "./session-status.ts";

const PROVIDER_ID = "alias";
const FAILOVER_ENTRY = "model-alias-failover";
const RESET_ENTRY = "model-alias-reset";
const DEFAULT_MAP_PATH = join(getAgentDir(), "model-alias.json");
const MAP_PATH = process.env.PI_MODEL_ALIAS_MAP || DEFAULT_MAP_PATH;
const PLACEHOLDER_CONTEXT_WINDOW = 1_000_000;
const PLACEHOLDER_MAX_TOKENS = 262_144;
const STATUS_REFRESH_INTERVAL_MS = 5_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEBUG_LOG = createDebugLog();
const TARGET_COOLDOWNS = createSharedCooldownRegistry({ debugLog: DEBUG_LOG });

type Registry = ExtensionContext["modelRegistry"];
type SessionUi = ExtensionContext["ui"];
type ResolvedAuth = { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
type StreamKind = keyof Pick<ProviderStreams, "stream" | "streamSimple">;

export type AliasSession = StatusSession<Registry, SessionUi>;

interface FailoverEntryData {
	role: string;
	failedTarget: string;
	nextTarget?: string;
	reason: string;
	cooldownMs: number;
	failCount: number;
	timestamp: number;
}

export default function piModelAlias(pi: ExtensionAPI): void {
	const aliases = loadAliases();
	DEBUG_LOG.log("extension-load", { mapPath: MAP_PATH, aliases: [...aliases.keys()] });
	if (aliases.size === 0) return;

	const session: AliasSession = {
		registry: undefined,
		ui: undefined,
		hasUI: false,
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
	const aliasModels = [...aliases.keys()].map(aliasModel);
	const streams = createAliasStreams(aliases, aliasModels, pi, session);
	void registerAliasApiProvider(streams);
	registerFailoverRenderer(pi);

	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Model Aliases",
			auth: {
				apiKey: {
					name: "Local model alias map",
					async check() {
						return { source: MAP_PATH, type: "api_key" };
					},
					async resolve() {
						return { auth: {}, source: MAP_PATH };
					},
				},
			},
			models: aliasModels,
			api: streams,
		}),
	);

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
			pi.appendEntry(RESET_ENTRY, { clearedCount });
		},
	});
}

function createAliasStreams(
	aliases: AliasMap,
	aliasModels: Model<Api>[],
	pi: ExtensionAPI,
	session: AliasSession,
): ProviderStreams {
	return {
		stream(model, context, options) {
			return createFallbackStream("stream", model, context, options, aliases, aliasModels, pi, session);
		},
		streamSimple(model, context, options) {
			return createFallbackStream("streamSimple", model, context, options, aliases, aliasModels, pi, session);
		},
	};
}

function createFallbackStream(
	kind: StreamKind,
	aliasModel: Model<Api>,
	context: Context,
	options: StreamOptions | SimpleStreamOptions | undefined,
	aliases: AliasMap,
	aliasModels: Model<Api>[],
	pi: ExtensionAPI,
	session: AliasSession,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const registry = session.registry;
	if (!registry) {
		const error = new Error(`Model alias "${aliasModel.id}" cannot stream before a session starts in this process`);
		DEBUG_LOG.log("open-attempt", { role: aliasModel.id, ok: false, reason: error.message });
		endWithError(output, aliasModel, error, undefined, options?.signal);
		return output;
	}
	const targets = targetsFor(aliasModel, aliases);
	let lastPartial: AssistantMessage | undefined;

	void runFallbackChain({
		role: aliasModel.id,
		targets,
		cooldowns: TARGET_COOLDOWNS,
		signal: options?.signal,
		open: async (targetRef) => {
			try {
				const target = await resolveAuthenticatedTarget(aliasModel.id, targetRef, registry);
				mirrorTargetMetadata(aliasModel, aliasModels, target.model);
				const stream = openTargetStream(kind, target, context, options);
				DEBUG_LOG.log("open-attempt", { role: aliasModel.id, targetRef, ok: true });
				return stream;
			} catch (error) {
				DEBUG_LOG.log("open-attempt", {
					role: aliasModel.id,
					targetRef,
					ok: false,
					reason: describeFailure(error),
				});
				throw error;
			}
		},
		forward: (event) => {
			lastPartial = partialFrom(event) ?? lastPartial;
			output.push(event);
		},
		warn: (failedTarget, reason, nextTarget, cooldown) =>
			warnFailover(
				pi,
				session,
				aliasModel.id,
				failedTarget,
				reason,
				nextTarget,
				cooldown.durationMs,
				cooldown.failCount,
			),
		// Pi treats a restart as a second assistant message, so safe prefixes stay hidden until commit.
		snapshot: (event) => structuredClone(event),
	})
		.then(() => output.end())
		.catch((error) => endWithError(output, aliasModel, error, lastPartial, options?.signal));
	return output;
}

function initializeAliasMetadata(aliases: AliasMap, aliasModels: Model<Api>[], registry: Registry): void {
	for (const aliasModel of aliasModels) {
		try {
			const target = resolveFirstTarget(aliasModel.id, targetsFor(aliasModel, aliases), registry);
			mirrorTargetMetadata(aliasModel, aliasModels, target.model);
		} catch (error) {
			console.warn(
				`[pi-model-alias] Metadata initialization failed; will retry at stream time: ${describeFailure(error)}`,
			);
		}
	}
}

async function resolveAuthenticatedTarget(aliasId: string, targetRef: string, registry: Registry) {
	const target = resolveTargetReference(aliasId, targetRef, registry);
	const auth = await registry.getApiKeyAndHeaders(target.model);
	if (!auth.ok) {
		throw new Error(`Model alias "${aliasId}" target "${targetRef}" is unavailable: ${auth.error}`);
	}
	return { ...target, auth };
}

function openTargetStream(
	kind: StreamKind,
	target: { model: Model<Api>; provider: Provider; auth: ResolvedAuth },
	context: Context,
	options: StreamOptions | SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	const request = requestOptions(options, target.auth);
	return kind === "streamSimple"
		? target.provider.streamSimple(target.model, context, request as SimpleStreamOptions)
		: target.provider.stream(target.model, context, request);
}

function targetsFor(aliasModel: Model<Api>, aliases: AliasMap): readonly string[] {
	const targets = aliases.get(aliasModel.id);
	if (!targets) throw new Error(`Unknown model alias "${aliasModel.id}"`);
	return targets;
}

function warnFailover(
	pi: ExtensionAPI,
	session: AliasSession,
	role: string,
	failedTarget: string,
	reason: string,
	nextTarget: string | undefined,
	cooldownMs: number,
	failCount: number,
): void {
	const data: FailoverEntryData = {
		role,
		failedTarget,
		...(nextTarget ? { nextTarget } : {}),
		reason,
		cooldownMs,
		failCount,
		timestamp: Date.now(),
	};
	DEBUG_LOG.log("failover-warn", { ...data });
	// In TUI mode the transcript entry is the log; raw stderr would draw over the UI.
	if (!session.hasUI) console.warn(`[pi-model-alias] ${formatFailoverWarning(data)}`);
	try {
		pi.appendEntry<FailoverEntryData>(FAILOVER_ENTRY, data);
	} catch (error) {
		DEBUG_LOG.log("append-entry-error", { message: describeFailure(error) });
	}
}

function registerFailoverRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<{ clearedCount?: number }>(RESET_ENTRY, (entry, _opts, theme) => {
		const clearedCount = finiteNumber(entry.data?.clearedCount);
		return new Text(theme.fg("dim", `[model-alias] Cleared ${clearedCount} model cooldown(s)`), 0, 0);
	});
	pi.registerEntryRenderer<Partial<FailoverEntryData>>(FAILOVER_ENTRY, (entry, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const data = entry.data;
		if (!data) {
			box.addChild(new Text(theme.fg("warning", "[model-alias] Missing failover details"), 0, 0));
			return box;
		}

		const warning = formatFailoverWarning(data);
		box.addChild(new Text(`${theme.fg("warning", "[model-alias]")} ${warning}`, 0, 0));
		if (expanded) {
			box.addChild(new Text(`${theme.fg("dim", "Reason:")} ${data.reason ?? ""}`, 0, 0));
			box.addChild(
				new Text(
					theme.fg(
						"dim",
						`Cooldown: ${formatDuration(data.cooldownMs)}; failure ${finiteNumber(data.failCount)}`,
					),
					0,
					0,
				),
			);
			box.addChild(new Text(theme.fg("dim", new Date(finiteNumber(data.timestamp)).toLocaleString()), 0, 0));
		}
		return box;
	});
}

function finiteNumber(value: number | undefined): number {
	return Number.isFinite(value) ? (value as number) : 0;
}

function endWithError(
	stream: AssistantMessageEventStream,
	aliasModel: Model<Api>,
	error: unknown,
	partial: AssistantMessage | undefined,
	signal: AbortSignal | undefined,
): void {
	const reason = failureStopReason(error, signal);
	const message = errorMessage(aliasModel, error, partial, reason);
	stream.push({ type: "error", reason, error: message });
	stream.end(message);
}

function errorMessage(
	aliasModel: Model<Api>,
	error: unknown,
	partial: AssistantMessage | undefined,
	reason: "error" | "aborted",
): AssistantMessage {
	return {
		...(partial ?? emptyAssistantMessage(aliasModel, reason)),
		stopReason: reason,
		errorMessage: describeFailure(error),
	};
}

function emptyAssistantMessage(model: Model<Api>, stopReason: "error" | "aborted"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function partialFrom(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

function mirrorTargetMetadata(aliasModel: Model<Api>, aliasModels: Model<Api>[], targetModel: Model<Api>): void {
	// Concurrent requests use last-writer-wins display metadata; streamed usage remains target-specific.
	const registeredModel = aliasModels.find((model) => model.id === aliasModel.id);
	for (const model of new Set([aliasModel, registeredModel].filter((item): item is Model<Api> => item !== undefined))) {
		model.contextWindow = targetModel.contextWindow;
		model.cost = targetModel.cost;
		model.maxTokens = targetModel.maxTokens;
		model.reasoning = targetModel.reasoning;
		model.input = targetModel.input;
		model.thinkingLevelMap = targetModel.thinkingLevelMap;
	}
}

function requestOptions<T extends StreamOptions | SimpleStreamOptions>(options: T | undefined, auth: ResolvedAuth): T {
	return {
		...options,
		apiKey: auth.apiKey ?? options?.apiKey,
		headers: mergeHeaders(auth.headers, options?.headers),
		env: { ...auth.env, ...options?.env },
	} as T;
}

function mergeHeaders(
	authHeaders: Record<string, string> | undefined,
	requestHeaders: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!authHeaders && !requestHeaders) return undefined;
	return { ...authHeaders, ...requestHeaders };
}

function aliasModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: ALIAS_API_ID,
		provider: PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: PLACEHOLDER_CONTEXT_WINDOW,
		maxTokens: PLACEHOLDER_MAX_TOKENS,
	};
}

function loadAliases(): Map<string, readonly string[]> {
	try {
		return parseAliasMap(JSON.parse(readFileSync(MAP_PATH, "utf8")) as unknown);
	} catch (error) {
		DEBUG_LOG.log("alias-map-error", { mapPath: MAP_PATH, message: describeFailure(error) });
		console.warn(`[pi-model-alias] No aliases registered; could not read ${MAP_PATH}: ${describeFailure(error)}`);
		return new Map();
	}
}
