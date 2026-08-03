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
import { ALIAS_API_ID, registerAliasApiProvider } from "./api-registration.ts";
import {
	createCooldownRegistry,
	describeFailure,
	failureStopReason,
	parseAliasMap,
	resolveFirstTarget,
	resolveTargetReference,
	runFallbackChain,
	type AliasMap,
} from "./fallback.ts";

const PROVIDER_ID = "alias";
const DEFAULT_MAP_PATH = join(getAgentDir(), "model-alias.json");
const MAP_PATH = process.env.PI_MODEL_ALIAS_MAP || DEFAULT_MAP_PATH;
const PLACEHOLDER_CONTEXT_WINDOW = 1_000_000;
const PLACEHOLDER_MAX_TOKENS = 262_144;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TARGET_COOLDOWNS = createCooldownRegistry();

type Registry = ExtensionContext["modelRegistry"];
type ResolvedAuth = { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
type StreamKind = keyof Pick<ProviderStreams, "stream" | "streamSimple">;

export default function piModelAlias(pi: ExtensionAPI): void {
	const aliases = loadAliases();
	if (aliases.size === 0) return;

	let registry: Registry | undefined;
	const aliasModels = [...aliases.keys()].map(aliasModel);
	const streams = createAliasStreams(aliases, aliasModels, () => registry);
	void registerAliasApiProvider(streams);

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
		registry = ctx.modelRegistry;
		initializeAliasMetadata(aliases, aliasModels, registry);
	});
	pi.on("session_shutdown", () => {
		registry = undefined;
	});
}

function createAliasStreams(
	aliases: AliasMap,
	aliasModels: Model<Api>[],
	getRegistry: () => Registry | undefined,
): ProviderStreams {
	return {
		stream(model, context, options) {
			return createFallbackStream("stream", model, context, options, aliases, aliasModels, getRegistry);
		},
		streamSimple(model, context, options) {
			return createFallbackStream("streamSimple", model, context, options, aliases, aliasModels, getRegistry);
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
	getRegistry: () => Registry | undefined,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	let lastPartial: AssistantMessage | undefined;

	void runFallbackChain({
		role: aliasModel.id,
		targets: targetsFor(aliasModel, aliases),
		cooldowns: TARGET_COOLDOWNS,
		signal: options?.signal,
		open: async (targetRef) => {
			const target = await resolveAuthenticatedTarget(aliasModel.id, targetRef, getRegistry());
			mirrorTargetMetadata(aliasModel, aliasModels, target.model);
			return openTargetStream(kind, target, context, options);
		},
		forward: (event) => {
			lastPartial = partialFrom(event) ?? lastPartial;
			output.push(event);
		},
		warn: (failedTarget, reason, nextTarget, cooldown) =>
			warnFailover(aliasModel.id, failedTarget, reason, nextTarget, cooldown.durationMs, cooldown.failCount),
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

async function resolveAuthenticatedTarget(aliasId: string, targetRef: string, registry: Registry | undefined) {
	if (!registry) throw new Error(`Model alias "${aliasId}" cannot resolve "${targetRef}" before session start`);
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
	role: string,
	failedTarget: string,
	reason: string,
	nextTarget: string | undefined,
	durationMs: number,
	failCount: number,
): void {
	const retry = nextTarget ? `; trying "${nextTarget}"` : "";
	console.warn(
		`[pi-model-alias] Alias "${role}" target "${failedTarget}" failed: ${reason}; cooldown ${formatDuration(durationMs)} (failCount=${failCount})${retry}`,
	);
}

function formatDuration(durationMs: number): string {
	if (durationMs < 60_000) return `${durationMs / 1_000}s`;
	return `${durationMs / 60_000}m`;
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
		console.warn(`[pi-model-alias] No aliases registered; could not read ${MAP_PATH}: ${describeFailure(error)}`);
		return new Map();
	}
}
