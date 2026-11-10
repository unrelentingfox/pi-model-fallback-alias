import assert from "node:assert/strict";
import test from "node:test";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	ProviderResponse,
	StreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { agentLoop, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAliasStreams } from "../src/stream/alias-stream.ts";
import { BUILT_IN_COOLDOWN_POLICY, createCooldownRegistry, type AliasPolicy } from "../src/fallback/index.ts";

test("rewrites partial and done identities without mutating target messages", async () => {
	const partial = targetMessage({ responseModel: "reported-model" });
	const done = targetMessage({ responseId: "response-2" });
	const expectedDone = structuredClone(done);
	const sourceEvents = [partialEvent(partial), doneEvent(done)];
	const events = await collect(streamFor(sourceEvents));

	const forwardedPartial = partialOf(events[0]!);
	const forwardedDone = doneOf(events[1]!);
	assertAliasIdentity(forwardedPartial, "reported-model");
	assertAliasIdentity(forwardedDone, "target-model");
	assertPreserved(forwardedDone, expectedDone);
	assert.notStrictEqual(events[0], sourceEvents[0]);
	assert.notStrictEqual(forwardedPartial, partial);
	assert.equal(partial.provider, "target-provider");
	assert.equal(done.model, "target-model");
});

test("rewrites error identities and preserves concrete responseModel", async () => {
	const error = targetMessage({ responseModel: "reported-error", stopReason: "error", errorMessage: "target failed" });
	const expectedError = structuredClone(error);
	const events = await collect(streamFor([{ type: "error", reason: "error", error }]));

	assert.equal(events.length, 1);
	const forwardedError = errorOf(events[0]!);
	assertAliasIdentity(forwardedError, "reported-error");
	assertPreserved(forwardedError, expectedError);
	assert.equal(error.provider, "target-provider");
});

test("keeps alias identity in generated errors after a partial response", async () => {
	const partial = targetMessage();
	const events = await collect(streamFor(throwAfter(partialEvent(partial))));

	assert.equal(events.length, 2);
	const generatedError = errorOf(events[1]!);
	assertAliasIdentity(generatedError, "target-model");
	assert.equal(generatedError.errorMessage, "target stream failed");
	assert.equal(generatedError.stopReason, "error");
});

test("rewrites buffered safe-prefix events when the first target commits", async () => {
	const { stream } = aliasStream({
		"target-model": asyncEvents(
			{ type: "start", partial: targetMessage() },
			{ type: "thinking_start", contentIndex: 0, partial: targetMessage() },
			{ type: "thinking_delta", contentIndex: 0, delta: "thinking", partial: targetMessage() },
			{ type: "thinking_end", contentIndex: 0, content: "thinking", partial: targetMessage() },
			partialEvent(targetMessage()),
			doneEvent(targetMessage()),
		),
		"unused-model": asyncEvents(doneEvent(targetMessage({ model: "unused-model" }))),
	});
	const events = await collect(stream);

	assert.deepEqual(events.map((event) => event.type), [
		"start",
		"thinking_start",
		"thinking_delta",
		"thinking_end",
		"text_start",
		"done",
	]);
	for (const event of events) assertAliasIdentity(messageOf(event), "target-model");
	const thinkingDelta = events[2];
	assert.equal(thinkingDelta?.type, "thinking_delta");
	if (thinkingDelta?.type === "thinking_delta") assert.equal(thinkingDelta.delta, "thinking");
});

test("rewrites fallback success while retaining the fallback target", async () => {
	const fallbackDone = targetMessage({ model: "fallback-model" });
	const { stream, activeTargets } = aliasStream({
		"primary-model": asyncEvents({ type: "error", reason: "error", error: targetMessage({ stopReason: "error" }) }),
		"fallback-model": asyncEvents(doneEvent(fallbackDone)),
	});
	const events = await collect(stream);

	assert.equal(events.length, 1);
	assertAliasIdentity(doneOf(events[0]!), "fallback-model");
	assert.equal(activeTargets.get("coder"), "target/fallback-model");
});

test("reports each selected target immediately", async () => {
	const selected: Array<[string, string]> = [];
	const { stream } = aliasStream(
		{
			"primary-model": asyncEvents({ type: "error", reason: "error", error: targetMessage({ stopReason: "error" }) }),
			"fallback-model": asyncEvents(doneEvent(targetMessage({ model: "fallback-model" }))),
		},
		{ onTargetSelected: (role, targetRef) => selected.push([role, targetRef]) },
	);

	await collect(stream);

	assert.deepEqual(selected, [
		["coder", "target/primary-model"],
		["coder", "target/fallback-model"],
	]);
});

test("records response status without headers or failover", async () => {
	const records: Array<{ event: string; data?: Record<string, unknown> }> = [];
	const response = { status: 500, headers: undefined } as unknown as ProviderResponse;
	const { stream } = aliasStream(
		{ "target-model": asyncEvents(doneEvent(targetMessage())) },
		{ providerResponse: response, log: (event, data) => records.push({ event, data }) },
	);

	const events = await collect(stream);
	await new Promise(setImmediate);

	assert.equal(events.length, 1);
	assert.equal(events[0]?.type, "done");
	assert.equal(records.filter(({ event }) => event === "failover-warn").length, 0);
	assert.equal(records.find(({ event }) => event === "attempt-latency")?.data?.httpStatus, 500, JSON.stringify(records));
});

test("logs allowlisted provider response metadata and preserves the caller callback", async () => {
	const records: Array<{ event: string; data?: Record<string, unknown> }> = [];
	const responses = {
		"target-model": asyncEvents({ type: "error", reason: "error", error: targetMessage({ stopReason: "error" }) }),
		"fallback-model": asyncEvents(doneEvent(targetMessage({ model: "fallback-model" }))),
	};
	const providerResponse: ProviderResponse = {
		status: 500,
		headers: {
			"X-Amzn-RequestId": "request-1",
			"X-Amzn-Trace-Id": "trace-1",
			Authorization: "Bearer secret",
			Cookie: "session=secret",
			"Set-Cookie": "token=secret",
		},
	};
	let callerResponse: ProviderResponse | undefined;
	const { stream } = aliasStream(responses, {
		providerResponse,
		streamOptions: { onResponse: (response) => { callerResponse = response; } },
		log: (event, data) => records.push({ event, data }),
	});

	await collect(stream);

	assert.equal(callerResponse, providerResponse);
	const latency = records.find(({ event, data }) =>
		event === "attempt-latency" && data?.targetRef === "target/target-model")?.data;
	assert.equal(latency?.httpStatus, 500);
	assert.equal(latency?.requestId, "request-1");
	assert.equal(latency?.traceId, "trace-1");
	assert.deepEqual(latency?.diagnosticHeaders, {
		"x-amzn-requestid": "request-1",
		"x-amzn-trace-id": "trace-1",
	});
	assert.doesNotMatch(JSON.stringify(records), /secret|authorization|cookie/iu);
});

test("reports the config load cost on every attempt record without an extra event", async () => {
	const records: Array<{ event: string; data?: Record<string, unknown> }> = [];
	const { stream } = aliasStream(
		{
			"target-model": asyncEvents({ type: "error", reason: "error", error: targetMessage({ stopReason: "error" }) }),
			"fallback-model": asyncEvents(doneEvent(targetMessage({ model: "fallback-model" }))),
		},
		{ configLoadMs: 0.42, log: (event, data) => records.push({ event, data }) },
	);

	await collect(stream);

	const latency = records.filter(({ event }) => event === "attempt-latency");
	assert.equal(latency.length, 2);
	// Each record is self-contained, so a reader never has to join events.
	assert.deepEqual(latency.map(({ data }) => data?.configLoadMs), [0.42, 0.42]);
	// A reader can tell whether an attempt ran on current or cached policy.
	assert.deepEqual(latency.map(({ data }) => data?.configDegraded), [false, false]);
	assert.deepEqual(records.filter(({ event }) => event.startsWith("alias-policy")), []);
	// Only the duration and a degraded flag are reported; alias names and policy
	// values stay out of the log.
	assert.doesNotMatch(JSON.stringify(records), /resetSuccesses|baseMs|capMs|\$defaults/u);
});

test("marks attempts that ran on a cached policy", async () => {
	const records: Array<{ event: string; data?: Record<string, unknown> }> = [];
	const { stream } = aliasStream(
		{ "target-model": asyncEvents(doneEvent(targetMessage())) },
		{
			log: (event, data) => records.push({ event, data }),
			policyLoad: () => ({ policy: { cooldown: BUILT_IN_COOLDOWN_POLICY }, configLoadMs: 0.2, degraded: true }),
		},
	);

	await collect(stream);
	await new Promise(setImmediate);

	assert.equal(
		records.find(({ event }) => event === "attempt-latency")?.data?.configDegraded,
		true,
		JSON.stringify(records),
	);
});

test("keeps the policy captured when the stream started", async () => {
	const records: Array<{ event: string; data?: Record<string, unknown> }> = [];
	let loads = 0;
	const { stream } = aliasStream(
		{ "target-model": asyncEvents(doneEvent(targetMessage())) },
		{
			log: (event, data) => records.push({ event, data }),
			policyLoad: () => ({
				policy: { cooldown: BUILT_IN_COOLDOWN_POLICY },
				configLoadMs: ++loads,
				degraded: false,
			}),
		},
	);

	await collect(stream);
	await new Promise(setImmediate);

	assert.equal(loads, 1, "one stream resolves policy once");
	assert.equal(records.find(({ event }) => event === "attempt-latency")?.data?.configLoadMs, 1);
});

test("live thinking arrives before a deferred text commit", { timeout: 2000 }, async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const thinking = targetMessage({ content: [{ type: "thinking", thinking: "live", thinkingSignature: "signed" }] });
	async function* primary() {
		yield { type: "start", partial: thinking } as AssistantMessageEvent;
		yield { type: "thinking_start", contentIndex: 0, partial: thinking } as AssistantMessageEvent;
		yield { type: "thinking_delta", contentIndex: 0, delta: "live", partial: thinking } as AssistantMessageEvent;
		await gate;
		yield partialEvent(targetMessage());
		yield doneEvent(targetMessage());
	}
	const { stream } = aliasStream({ primary: primary(), unused: [] }, { policy: livePolicy() });
	const iterator = stream[Symbol.asyncIterator]();
	try {
		for (const type of ["start", "thinking_start", "thinking_delta"]) {
			const event = await iterator.next();
			assert.equal(event.value?.type, type);
		}
	} finally { release(); }
	const remaining: AssistantMessageEvent[] = [];
	for (;;) {
		const event = await iterator.next();
		if (event.done) break;
		remaining.push(event.value);
	}
	assert.equal(remaining.at(-1)?.type, "done");
	assert.deepEqual(thinking.content, [{ type: "thinking", thinking: "live", thinkingSignature: "signed" }]);
});

for (const failure of ["error", "throw", "timeout"] as const) {
	test(`live thinking ${failure} retries with fresh masking indexes and compact terminal content`, async () => {
		const source = targetMessage({ content: [{ type: "thinking", thinking: "abandoned", thinkingSignature: "old-signature" }] });
		async function* primary() {
			yield { type: "start", partial: source } as AssistantMessageEvent;
			yield { type: "thinking_start", contentIndex: 0, partial: source } as AssistantMessageEvent;
			yield { type: "thinking_delta", contentIndex: 0, delta: "abandoned", partial: source } as AssistantMessageEvent;
			if (failure === "throw") throw new Error("failed");
			if (failure === "timeout") await new Promise((resolve) => setTimeout(resolve, 30));
			yield { type: "error", reason: "error", error: source } as AssistantMessageEvent;
		}
		const final = targetMessage({ model: "secondary", content: [{ type: "thinking", thinking: "fresh", thinkingSignature: "new-signature" }, { type: "text", text: "answer" }] });
		const { stream } = aliasStream({ primary: primary(), secondary: asyncEvents(
			{ type: "start", partial: final },
			{ type: "thinking_start", contentIndex: 0, partial: final },
			{ type: "thinking_delta", contentIndex: 0, delta: "fresh", partial: final },
			{ type: "thinking_end", contentIndex: 0, content: "fresh", partial: final },
			{ type: "text_start", contentIndex: 1, partial: final },
			{ type: "text_delta", contentIndex: 1, delta: "answer", partial: final },
			doneEvent(final),
		) }, { policy: livePolicy(failure === "timeout" ? { stallMs: 5 } : undefined) });
		const events = await collect(stream);
		assert.equal(events.filter((event) => event.type === "start").length, 1);
		assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1);
		const deltas = events.filter((event) => event.type === "thinking_delta");
		assert.ok(deltas[1]!.contentIndex > deltas[0]!.contentIndex);
		// Exact representative of the masking transform's persistent contentIndex-keyed raw buffer.
		const raw = new Map<number, string>();
		for (const event of events) {
			if (event.type === "thinking_delta" || event.type === "text_delta") {
				raw.set(event.contentIndex, (raw.get(event.contentIndex) ?? "") + event.delta);
				const block = event.partial.content[event.contentIndex]!;
				assert.equal(block.type === "thinking" ? block.thinking : block.type === "text" ? block.text : "", raw.get(event.contentIndex));
			}
			if ("contentIndex" in event) assert.ok(event.partial.content[event.contentIndex]);
		}
		const fresh = deltas[1]!;
		assert.deepEqual(fresh.partial.content.slice(0, fresh.contentIndex), Array.from({ length: fresh.contentIndex }, () => ({ type: "thinking", thinking: "" })));
		assert.deepEqual(doneOf(events.at(-1)!).content, final.content);
		assert.deepEqual(source.content, [{ type: "thinking", thinking: "abandoned", thinkingSignature: "old-signature" }]);
	});
}

test("live thinking all-target exhaustion clears signatures, including a single target", async () => {
	for (const count of [1, 2]) {
		const responses = Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index), throwAfter({
			type: "thinking_start", contentIndex: 0,
			partial: targetMessage({ content: [{ type: "thinking", thinking: "abandoned", thinkingSignature: "old-signature" }] }),
		})]));
		const events = await collect(aliasStream(responses, { policy: livePolicy() }).stream);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
		assert.deepEqual(errorOf(events.at(-1)!).content, []);
	}
});

for (const termination of ["throw", "error", "end"] as const) {
	test(`live thinking cancellation with ${termination} does not retry`, async () => {
	const controller = new AbortController();
	async function* primary() {
		yield { type: "start", partial: targetMessage({ content: [] }) } as AssistantMessageEvent;
		controller.abort();
		if (termination === "throw") throw new Error("cancelled");
		if (termination === "error") yield { type: "error", reason: "error", error: targetMessage({ stopReason: "error" }) } as AssistantMessageEvent;
	}
	const selected: string[] = [];
	const events = await collect(aliasStream({ primary: primary(), unused: [] }, {
		policy: livePolicy(), streamOptions: { signal: controller.signal },
		onTargetSelected: (_role, target) => selected.push(target),
	}).stream);
	assert.deepEqual(selected, ["target/primary"]);
	assert.equal(errorOf(events.at(-1)!).stopReason, "aborted");
	});
}

test("live thinking keeps tool-call public indexes valid after fallback", async () => {
	const toolCall = { type: "toolCall" as const, id: "tool-1", name: "run", arguments: { value: 1 } };
	const final = targetMessage({ content: [toolCall], stopReason: "toolUse" });
	const events = await collect(aliasStream({ primary: throwAfter({ type: "thinking_start", contentIndex: 0, partial: targetMessage({ content: [{ type: "thinking", thinking: "old" }] }) }), secondary: asyncEvents(
		{ type: "start", partial: final },
		{ type: "toolcall_start", contentIndex: 0, partial: final },
		{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":1}', partial: final },
		{ type: "toolcall_end", contentIndex: 0, toolCall, partial: final },
		{ type: "done", reason: "toolUse", message: final },
	) }, { policy: livePolicy() }).stream);
	const tools = events.filter((event) => event.type.startsWith("toolcall_"));
	for (const event of tools) {
		assert.ok("contentIndex" in event);
		assert.ok(event.contentIndex > 0);
		assert.deepEqual(event.partial.content[event.contentIndex], toolCall);
	}
	assert.deepEqual(doneOf(events.at(-1)!).content, [toolCall]);
});

test("current Pi agent-loop saves only compact final target content", async () => {
	const final = targetMessage({ model: "secondary", content: [{ type: "text", text: "answer" }] });
	const abandoned = targetMessage({ content: [{ type: "thinking", thinking: "old", thinkingSignature: "old-signature" }] });
	async function* primary() {
		yield { type: "start", partial: abandoned } as AssistantMessageEvent;
		yield { type: "thinking_start", contentIndex: 0, partial: abandoned } as AssistantMessageEvent;
		yield { type: "thinking_delta", contentIndex: 0, delta: "old", partial: abandoned } as AssistantMessageEvent;
		throw new Error("failed");
	}
	const { stream } = aliasStream({ primary: primary(), secondary: asyncEvents(
		{ type: "start", partial: final }, partialEvent(final), doneEvent(final),
	) }, { policy: livePolicy() });
	const config = { model: aliasModel(), convertToLlm: (messages: AgentMessage[]) => messages as never };
	const loop = agentLoop([{ role: "user", content: "hello", timestamp: 1 }], { systemPrompt: "", messages: [], tools: [] }, config, undefined, () => stream);
	let starts = 0;
	let ends = 0;
	for await (const event of loop) {
		if (event.type === "message_start" && event.message.role === "assistant") starts++;
		if (event.type === "message_end" && event.message.role === "assistant") ends++;
		if (event.type === "message_update" && "contentIndex" in event.assistantMessageEvent) {
			assert.ok(event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex]);
		}
	}
	assert.equal(starts, 1);
	assert.equal(ends, 1);
	const messages = await loop.result();
	const assistant = messages.filter((message) => message.role === "assistant");
	assert.equal(assistant.length, 1);
	assert.deepEqual(assistant[0]!.content, final.content);
	let requested = false;
	const second = agentLoop([{ role: "user", content: "continue", timestamp: 2 }], { systemPrompt: "", messages, tools: [] }, config, undefined, (_model, context) => {
		requested = true;
		const saved = context.messages.filter((message) => message.role === "assistant");
		assert.equal(saved.length, 1);
		assert.deepEqual(saved[0]!.content, final.content);
		assert.doesNotMatch(JSON.stringify(context), /old-signature|"thinking"/);
		const next = createAssistantMessageEventStream();
		next.push(doneEvent(final));
		next.end();
		return next;
	});
	for await (const _event of second) { /* Consume the second turn. */ }
	assert.equal(requested, true);
});

for (const enabled of [undefined, false]) {
	test(`live thinking disabled (${enabled}) keeps safe prefixes buffered`, async () => {
		const abandoned = targetMessage({ content: [{ type: "thinking", thinking: "old" }] });
		async function* primary() {
			yield { type: "start", partial: abandoned } as AssistantMessageEvent;
			yield { type: "thinking_start", contentIndex: 0, partial: abandoned } as AssistantMessageEvent;
			yield { type: "thinking_delta", contentIndex: 0, delta: "old", partial: abandoned } as AssistantMessageEvent;
			throw new Error("failed");
		}
		const final = targetMessage();
		const events = await collect(aliasStream({ primary: primary(), secondary: asyncEvents(
			{ type: "start", partial: final }, partialEvent(final), doneEvent(final),
		) }, { policy: { cooldown: BUILT_IN_COOLDOWN_POLICY, ...(enabled === undefined ? {} : { streamThinkingBeforeCommit: enabled }) } }).stream);
		assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "done"]);
	});
}

test("live thinking arrives before a deferred tool commit and post-commit throws never retry", { timeout: 2000 }, async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const thinking = targetMessage({ content: [{ type: "thinking", thinking: "live" }] });
	const tool = targetMessage({ content: [{ type: "thinking", thinking: "live" }, { type: "toolCall", id: "call", name: "run", arguments: {} }] });
	async function* primary() {
		yield { type: "start", partial: thinking } as AssistantMessageEvent;
		yield { type: "thinking_start", contentIndex: 0, partial: thinking } as AssistantMessageEvent;
		yield { type: "thinking_delta", contentIndex: 0, delta: "live", partial: thinking } as AssistantMessageEvent;
		await gate;
		yield { type: "thinking_end", contentIndex: 0, content: "live", partial: thinking } as AssistantMessageEvent;
		yield { type: "toolcall_start", contentIndex: 1, partial: tool } as AssistantMessageEvent;
		throw new Error("after commit");
	}
	const selected: string[] = [];
	const { stream } = aliasStream({ primary: primary(), unused: [] }, { policy: livePolicy(), onTargetSelected: (_role, target) => selected.push(target) });
	const iterator = stream[Symbol.asyncIterator]();
	try {
		for (const type of ["start", "thinking_start", "thinking_delta"]) assert.equal((await iterator.next()).value?.type, type);
	} finally { release(); }
	const rest: AssistantMessageEvent[] = [];
	for (;;) {
		const next = await iterator.next();
		if (next.done) break;
		rest.push(next.value);
	}
	assert.deepEqual(selected, ["target/primary"]);
	assert.equal(errorOf(rest.at(-1)!).errorMessage, "after commit");
	assert.deepEqual(errorOf(rest.at(-1)!).content, tool.content);
});

test("live thinking closes open reasoning before clearing and single-target terminals stay compact", async () => {
	const thinking = targetMessage({ content: [{ type: "thinking", thinking: "live", thinkingSignature: "signature" }] });
	const final = targetMessage({ content: [] });
	const events = await collect(aliasStream({ primary: asyncEvents(
		{ type: "start", partial: thinking },
		{ type: "thinking_start", contentIndex: 0, partial: thinking },
		doneEvent(final),
	) }, { policy: livePolicy() }).stream);
	assert.deepEqual(events.map((event) => event.type), ["start", "thinking_start", "thinking_end", "done"]);
	assert.deepEqual(doneOf(events.at(-1)!).content, []);
	const abandoned = await collect(aliasStream({ primary: throwAfter({ type: "thinking_start", contentIndex: 0, partial: thinking }), secondary: asyncEvents(doneEvent(final)) }, { policy: livePolicy() }).stream);
	const end = abandoned.find((event) => event.type === "thinking_end");
	assert.equal(end?.type, "thinking_end");
	if (end?.type === "thinking_end") assert.equal(end.content, "live");
	assert.deepEqual(partialOf(abandoned[2]!).content, [{ type: "thinking", thinking: "" }, { type: "thinking", thinking: "" }]);
});

function livePolicy(timeouts?: AliasPolicy["timeouts"]): AliasPolicy {
	return { cooldown: BUILT_IN_COOLDOWN_POLICY, streamThinkingBeforeCommit: true, ...(timeouts ? { timeouts } : {}) };
}

function streamFor(events: readonly AssistantMessageEvent[] | AsyncIterable<AssistantMessageEvent>): AssistantMessageEventStream {
	const { stream } = aliasStream({ "target-model": events });
	return stream;
}

interface AliasStreamTestOptions {
	providerResponse?: ProviderResponse;
	streamOptions?: StreamOptions;
	log?(event: string, data?: Record<string, unknown>): void;
	onTargetSelected?(role: string, targetRef: string): void;
	policy?: AliasPolicy;
	configLoadMs?: number;
	policyLoad?(): { policy: AliasPolicy; configLoadMs: number; degraded: boolean };
}

function aliasStream(
	responses: Record<string, readonly AssistantMessageEvent[] | AsyncIterable<AssistantMessageEvent>>,
	options: AliasStreamTestOptions = {},
): {
	stream: AssistantMessageEventStream;
	activeTargets: Map<string, string>;
} {
	const activeTargets = new Map<string, string>();
	const streams = createAliasStreams({
		aliases: new Map([["coder", Object.keys(responses).map((model) => `target/${model}`)]]),
		policyFor: options.policyLoad ?? (() => ({ policy: options.policy ?? { cooldown: BUILT_IN_COOLDOWN_POLICY }, configLoadMs: options.configLoadMs ?? 0, degraded: false })),
		aliasModels: [aliasModel()],
		session: {
			registry: {
				find(_provider: string, model: string) {
					return targetModel(model);
				},
				getProvider() {
					return {
						stream(model: Model<Api>, _context: unknown, streamOptions?: StreamOptions) {
							return providerEvents(responses[model.id]!, streamOptions, options.providerResponse);
						},
						streamSimple(model: Model<Api>, _context: unknown, streamOptions?: StreamOptions) {
							return providerEvents(responses[model.id]!, streamOptions, options.providerResponse);
						},
					};
				},
				async getApiKeyAndHeaders() {
					return { ok: true };
				},
			},
			ui: undefined,
			hasUI: false,
			model: undefined,
			activeTargets,
		},
		cooldowns: createCooldownRegistry(),
		debugLog: { log: options.log ?? (() => undefined) },
		onTargetSelected: options.onTargetSelected ?? (() => undefined),
		onFailover: () => undefined,
	} as unknown as Parameters<typeof createAliasStreams>[0]);
	return { stream: streams.stream(aliasModel(), { messages: [] }, options.streamOptions), activeTargets };
}

async function* providerEvents(
	events: readonly AssistantMessageEvent[] | AsyncIterable<AssistantMessageEvent>,
	options: StreamOptions | undefined,
	response: ProviderResponse | undefined,
): AsyncGenerator<AssistantMessageEvent> {
	if (response) await options?.onResponse?.(response, targetModel("target-model"));
	if (Symbol.asyncIterator in Object(events)) {
		for await (const event of events as AsyncIterable<AssistantMessageEvent>) yield event;
		return;
	}
	yield* events as readonly AssistantMessageEvent[];
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function* throwAfter(event: AssistantMessageEvent): AsyncGenerator<AssistantMessageEvent> {
	yield event;
	throw new Error("target stream failed");
}

async function* asyncEvents(...events: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
	yield* events;
}

function messageOf(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

function partialOf(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done" || event.type === "error") assert.fail("expected partial event");
	return event.partial;
}

function doneOf(event: AssistantMessageEvent): AssistantMessage {
	if (event.type !== "done") assert.fail("expected done event");
	return event.message;
}

function errorOf(event: AssistantMessageEvent): AssistantMessage {
	if (event.type !== "error") assert.fail("expected error event");
	return event.error;
}

function partialEvent(partial: AssistantMessage): AssistantMessageEvent {
	return { type: "text_start", contentIndex: 0, partial };
}

function doneEvent(message: AssistantMessage): AssistantMessageEvent {
	return { type: "done", reason: "stop", message };
}

function targetMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "target response" }],
		api: "target-api",
		provider: "target-provider",
		model: "target-model",
		responseId: "response-1",
		diagnostics: [{ type: "custom", timestamp: 122, details: { message: "target diagnostic" } }],
		usage: {
			input: 11,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 23,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		},
		stopReason: "stop",
		timestamp: 123,
		...overrides,
	};
}

function aliasModel(): Model<Api> {
	return {
		id: "coder",
		name: "coder",
		api: "alias-delegate",
		provider: "alias",
		baseUrl: "https://alias.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

function targetModel(id: string): Model<Api> {
	return { ...aliasModel(), id, provider: "target-provider", api: "target-api" };
}

function assertAliasIdentity(message: AssistantMessage, responseModel: string): void {
	assert.equal(message.api, "alias-delegate");
	assert.equal(message.provider, "alias");
	assert.equal(message.model, "coder");
	assert.equal(message.responseModel, responseModel);
}

function assertPreserved(actual: AssistantMessage, expected: AssistantMessage): void {
	assert.deepEqual(actual.content, expected.content);
	assert.deepEqual(actual.usage, expected.usage);
	assert.equal(actual.responseId, expected.responseId);
	assert.deepEqual(actual.diagnostics, expected.diagnostics);
	assert.equal(actual.stopReason, expected.stopReason);
	assert.equal(actual.timestamp, expected.timestamp);
}
