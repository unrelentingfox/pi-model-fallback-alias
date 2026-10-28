import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Provider,
	type ProviderResponse,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PolicyLoad } from "../alias-config.ts";
import { mirrorTargetMetadata, targetsFor, ZERO_COST } from "../alias/alias-model.ts";
import type { DebugLog } from "../debug-log.ts";
import {
	describeFailure,
	failureStopReason,
	runFallbackChain,
	type AliasMap,
	type CooldownRegistry,
	type FailoverEntryData,
} from "../fallback/index.ts";
import { requestOptions, type ResolvedTargetAuth } from "./request-options.ts";
import type { ProviderResponseMetadata } from "../latency/stats.ts";
import type { AliasSession } from "../status/session-status.ts";
import { resolveAuthenticatedTarget } from "./target-auth.ts";

type Registry = ExtensionContext["modelRegistry"];
type StreamKind = keyof Pick<ProviderStreams, "stream" | "streamSimple">;

interface AliasStreamDependencies {
	aliases: AliasMap;
	timers?: import("../fallback/types.ts").TimerApi;
	/** Re-read per stream so every process follows the current shared rules. */
	policyFor(role: string): PolicyLoad;
	aliasModels: Model<Api>[];
	session: AliasSession<Registry, ExtensionContext["ui"]>;
	cooldowns: CooldownRegistry;
	debugLog: DebugLog;
	onTargetSelected(role: string, targetRef: string): void;
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
	const {
		aliases,
		policyFor,
		aliasModels,
		session,
		cooldowns,
		debugLog,
		onTargetSelected,
		onFailover,
	} = dependencies;
	const registry = session.registry;
	if (!registry) {
		const error = new Error(`Model alias "${aliasModel.id}" cannot stream before a session starts in this process`);
		debugLog.log("open-attempt", { role: aliasModel.id, ok: false, reason: error.message });
		endWithError(output, aliasModel, error, undefined, options?.signal);
		return output;
	}
	// Targets stay as registered at load; only policy follows the file.
	const targets = targetsFor(aliasModel, aliases);
	const { policy, configLoadMs, degraded } = policyFor(aliasModel.id);
	const metadataByTarget = new Map<string, ProviderResponseMetadata>();
	let lastPartial: AssistantMessage | undefined;
	const relay = policy.streamThinkingBeforeCommit ? createThinkingRelay(output) : undefined;

	void runFallbackChain({
		role: aliasModel.id,
		targets,
		cooldowns,
		policy,
		timers: dependencies.timers,
		signal: options?.signal,
		open: async (targetRef, attemptSignal) => {
			try {
				metadataByTarget.delete(targetRef);
				const target = await resolveAuthenticatedTarget(aliasModel.id, targetRef, registry);
				mirrorTargetMetadata(aliasModel, aliasModels, target.model);
				const stream = openTargetStream(
					kind,
					target,
					context,
					withResponseCapture(options, (response) => metadataByTarget.set(targetRef, response)),
					linkedSignal(options?.signal, attemptSignal),
				);
				session.activeTargets.set(aliasModel.id, targetRef);
				onTargetSelected(aliasModel.id, targetRef);
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
			const forwarded = withAliasIdentity(relay ? structuredClone(event) : event, aliasModel);
			lastPartial = partialFrom(forwarded) ?? lastPartial;
			if (relay) relay.forward(forwarded);
			else output.push(forwarded);
		},
		onAttemptAbandoned: () => {
			relay?.abandon();
			lastPartial = undefined;
		},
		// configLoadMs and configDegraded ride the existing record; a separate event
		// would add one more synchronous append per stream.
		onLatency: (sample) =>
			debugLog.log("attempt-latency", {
				...sample,
				configLoadMs,
				configDegraded: degraded,
				...metadataByTarget.get(sample.targetRef),
			}),
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
				...metadataByTarget.get(failedTarget),
			}),
		// Buffered events must not share the provider's mutable partial.
		snapshot: (event) => structuredClone(event),
	})
		.then(() => output.end())
		.catch((error) => {
			relay?.close();
			endWithError(output, aliasModel, error, lastPartial, options?.signal);
		});
	return output;
}

function createThinkingRelay(
	output: AssistantMessageEventStream,
): { forward(event: AssistantMessageEvent): void; abandon(): void; close(): void } {
	let offset = 0;
	let nextIndex = 0;
	let partial: AssistantMessage | undefined;
	const openThinking = new Set<number>();
	return { forward, abandon, close };

	function forward(event: AssistantMessageEvent): void {
		if (event.type === "done" || event.type === "error") {
			close();
			output.push(event);
			return;
		}
		partial = { ...event.partial, content: [...emptyThinkingBlocks(offset), ...event.partial.content] };
		nextIndex = Math.max(nextIndex, partial.content.length);
		if ("contentIndex" in event) {
			const contentIndex = offset + event.contentIndex;
			nextIndex = Math.max(nextIndex, contentIndex + 1);
			if (event.type === "thinking_start") openThinking.add(contentIndex);
			if (event.type === "thinking_end") openThinking.delete(contentIndex);
			output.push({ ...event, contentIndex, partial });
		} else output.push({ ...event, partial });
	}

	function abandon(): void {
		close();
		if (partial && nextIndex > offset) {
			// Fresh indexes isolate contentIndex-keyed downstream restoration buffers.
			const contentIndex = nextIndex++;
			const cleared = { ...partial, content: emptyThinkingBlocks(nextIndex) };
			output.push({ type: "thinking_start", contentIndex, partial: cleared });
			output.push({ type: "thinking_end", contentIndex, content: "", partial: cleared });
		}
		offset = nextIndex;
		partial = undefined;
	}

	function close(): void {
		if (!partial) return;
		for (const contentIndex of openThinking) {
			const block = partial.content[contentIndex];
			output.push({
				type: "thinking_end", contentIndex,
				content: block.type === "thinking" ? block.thinking : "", partial,
			});
		}
		openThinking.clear();
	}
}

function emptyThinkingBlocks(length: number): AssistantMessage["content"] {
	return Array.from({ length }, () => ({ type: "thinking", thinking: "" }));
}

function openTargetStream(
	kind: StreamKind,
	target: { model: Model<Api>; provider: Provider; auth: ResolvedTargetAuth },
	context: Context,
	options: StreamOptions | SimpleStreamOptions | undefined,
	signal: AbortSignal | undefined,
): AssistantMessageEventStream {
	const request = requestOptions(options, target.auth, signal);
	return kind === "streamSimple"
		? target.provider.streamSimple(target.model, context, request as SimpleStreamOptions)
		: target.provider.stream(target.model, context, request);
}

function withResponseCapture<T extends StreamOptions | SimpleStreamOptions>(
	options: T | undefined,
	capture: (metadata: ProviderResponseMetadata) => void,
): T {
	return {
		...options,
		onResponse: async (response: ProviderResponse, model: Model<Api>) => {
			capture(responseMetadata(response));
			await options?.onResponse?.(response, model);
		},
	} as T;
}

function responseMetadata(response: ProviderResponse): ProviderResponseMetadata {
	const diagnosticHeaders = allowlistedHeaders(response.headers ?? {});
	return {
		httpStatus: response.status,
		...(diagnosticHeaders["x-amzn-requestid"] ? { requestId: diagnosticHeaders["x-amzn-requestid"] } : {}),
		...(diagnosticHeaders["x-amzn-trace-id"] ? { traceId: diagnosticHeaders["x-amzn-trace-id"] } : {}),
		...(Object.keys(diagnosticHeaders).length > 0 ? { diagnosticHeaders } : {}),
	};
}

const DIAGNOSTIC_HEADER_NAMES = new Set([
	"x-amzn-requestid",
	"x-amzn-trace-id",
	"x-amz-request-id",
	"x-request-id",
]);

function allowlistedHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers)
			.map(([name, value]) => [name.toLowerCase(), value] as const)
			.filter(([name]) => DIAGNOSTIC_HEADER_NAMES.has(name)),
	);
}

function linkedSignal(userSignal: AbortSignal | undefined, attemptSignal: AbortSignal | undefined): AbortSignal | undefined {
	if (!userSignal) return attemptSignal;
	if (!attemptSignal) return userSignal;
	return AbortSignal.any([userSignal, attemptSignal]);
}

function withAliasIdentity(event: AssistantMessageEvent, aliasModel: Model<Api>): AssistantMessageEvent {
	if (event.type === "done") {
		return { ...event, message: withAliasMessageIdentity(event.message, aliasModel) };
	}
	if (event.type === "error") {
		return { ...event, error: withAliasMessageIdentity(event.error, aliasModel) };
	}
	return { ...event, partial: withAliasMessageIdentity(event.partial, aliasModel) };
}

function withAliasMessageIdentity(message: AssistantMessage, aliasModel: Model<Api>): AssistantMessage {
	return {
		...message,
		api: aliasModel.api,
		provider: aliasModel.provider,
		model: aliasModel.id,
		responseModel: message.responseModel ?? message.model,
	};
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
