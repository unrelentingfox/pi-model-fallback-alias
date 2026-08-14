import {
	createAssistantMessageEventStream,
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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mirrorTargetMetadata, targetsFor, ZERO_COST } from "./alias-model.ts";
import type { DebugLog } from "./debug-log.ts";
import {
	describeFailure,
	failureStopReason,
	resolveTargetReference,
	runFallbackChain,
	type AliasMap,
	type AttemptTimeouts,
	type CooldownRegistry,
	type FailoverEntryData,
} from "./fallback.ts";
import type { AliasSession } from "./session-status.ts";

type Registry = ExtensionContext["modelRegistry"];
type ResolvedAuth = { apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> };
type StreamKind = keyof Pick<ProviderStreams, "stream" | "streamSimple">;

interface AliasStreamDependencies {
	aliases: AliasMap;
	timeoutsFor(role: string): AttemptTimeouts | undefined;
	aliasModels: Model<Api>[];
	session: AliasSession<Registry, ExtensionContext["ui"]>;
	cooldowns: CooldownRegistry;
	debugLog: DebugLog;
	onFailover(data: FailoverEntryData): void;
}

export function createAliasStreams(dependencies: AliasStreamDependencies): ProviderStreams {
	return {
		stream(model, context, options) {
			return createFallbackStream("stream", model, context, options, dependencies);
		},
		streamSimple(model, context, options) {
			return createFallbackStream("streamSimple", model, context, options, dependencies);
		},
	};
}

function createFallbackStream(
	kind: StreamKind,
	aliasModel: Model<Api>,
	context: Context,
	options: StreamOptions | SimpleStreamOptions | undefined,
	dependencies: AliasStreamDependencies,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const { aliases, timeoutsFor, aliasModels, session, cooldowns, debugLog, onFailover } = dependencies;
	const registry = session.registry;
	if (!registry) {
		const error = new Error(`Model alias "${aliasModel.id}" cannot stream before a session starts in this process`);
		debugLog.log("open-attempt", { role: aliasModel.id, ok: false, reason: error.message });
		endWithError(output, aliasModel, error, undefined, options?.signal);
		return output;
	}
	const targets = targetsFor(aliasModel, aliases);
	let lastPartial: AssistantMessage | undefined;

	void runFallbackChain({
		role: aliasModel.id,
		targets,
		cooldowns,
		signal: options?.signal,
		open: async (targetRef, attemptSignal) => {
			try {
				const target = await resolveAuthenticatedTarget(aliasModel.id, targetRef, registry);
				mirrorTargetMetadata(aliasModel, aliasModels, target.model);
				const stream = openTargetStream(kind, target, context, options, linkedSignal(options?.signal, attemptSignal));
				session.activeTargets.set(aliasModel.id, targetRef);
				debugLog.log("open-attempt", { role: aliasModel.id, targetRef, ok: true });
				return stream;
			} catch (error) {
				debugLog.log("open-attempt", {
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
		timeoutsFor: () => timeoutsFor(aliasModel.id),
		onLatency: (sample) => debugLog.log("attempt-latency", sample),
		onTimeout: (targetRef, reason) => debugLog.log("attempt-timeout", { role: aliasModel.id, targetRef, reason }),
		warn: (failedTarget, reason, nextTarget, cooldown) =>
			onFailover({
				role: aliasModel.id,
				failedTarget,
				...(nextTarget ? { nextTarget } : {}),
				reason,
				cooldownMs: cooldown.durationMs,
				failCount: cooldown.failCount,
				timestamp: Date.now(),
			}),
		// Pi treats a restart as a second assistant message, so safe prefixes stay hidden until commit.
		snapshot: (event) => structuredClone(event),
	})
		.then(() => output.end())
		.catch((error) => endWithError(output, aliasModel, error, lastPartial, options?.signal));
	return output;
}

function openTargetStream(
	kind: StreamKind,
	target: { model: Model<Api>; provider: Provider; auth: ResolvedAuth },
	context: Context,
	options: StreamOptions | SimpleStreamOptions | undefined,
	signal: AbortSignal | undefined,
): AssistantMessageEventStream {
	const request = requestOptions(options, target.auth, signal);
	return kind === "streamSimple"
		? target.provider.streamSimple(target.model, context, request as SimpleStreamOptions)
		: target.provider.stream(target.model, context, request);
}

async function resolveAuthenticatedTarget(aliasId: string, targetRef: string, registry: Registry) {
	const target = resolveTargetReference(aliasId, targetRef, registry);
	const auth = await registry.getApiKeyAndHeaders(target.model);
	if (!auth.ok) {
		throw new Error(`Model alias "${aliasId}" target "${targetRef}" is unavailable: ${auth.error}`);
	}
	return { ...target, auth };
}

function requestOptions<T extends StreamOptions | SimpleStreamOptions>(
	options: T | undefined,
	auth: ResolvedAuth,
	signal: AbortSignal | undefined,
): T {
	return {
		...options,
		signal: signal ?? options?.signal,
		apiKey: auth.apiKey ?? options?.apiKey,
		headers: mergeHeaders(auth.headers, options?.headers),
		env: { ...auth.env, ...options?.env },
	} as T;
}

function linkedSignal(userSignal: AbortSignal | undefined, attemptSignal: AbortSignal | undefined): AbortSignal | undefined {
	if (!userSignal) return attemptSignal;
	if (!attemptSignal) return userSignal;
	return AbortSignal.any([userSignal, attemptSignal]);
}

function mergeHeaders(
	authHeaders: ProviderHeaders | undefined,
	requestHeaders: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!authHeaders && !requestHeaders) return undefined;
	return { ...authHeaders, ...requestHeaders };
}

function partialFrom(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
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
			cost: { ...ZERO_COST, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}
