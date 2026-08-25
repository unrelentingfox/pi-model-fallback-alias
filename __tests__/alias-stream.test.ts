import assert from "node:assert/strict";
import test from "node:test";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
} from "@earendil-works/pi-ai";
import { createAliasStreams } from "../alias-stream.ts";
import { createCooldownRegistry } from "../fallback.ts";

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

function streamFor(events: readonly AssistantMessageEvent[] | AsyncIterable<AssistantMessageEvent>): AssistantMessageEventStream {
	const { stream } = aliasStream({ "target-model": events });
	return stream;
}

function aliasStream(responses: Record<string, readonly AssistantMessageEvent[] | AsyncIterable<AssistantMessageEvent>>): {
	stream: AssistantMessageEventStream;
	activeTargets: Map<string, string>;
} {
	const activeTargets = new Map<string, string>();
	const streams = createAliasStreams({
		aliases: new Map([["coder", Object.keys(responses).map((model) => `target/${model}`)]]),
		timeoutsFor: () => undefined,
		aliasModels: [aliasModel()],
		session: {
			registry: {
				find(_provider: string, model: string) {
					return targetModel(model);
				},
				getProvider() {
					return {
						stream(model: Model<Api>) {
							return responses[model.id]! as AssistantMessageEventStream;
						},
						streamSimple(model: Model<Api>) {
							return responses[model.id]! as AssistantMessageEventStream;
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
		debugLog: { log: () => undefined },
		onFailover: () => undefined,
	} as unknown as Parameters<typeof createAliasStreams>[0]);
	return { stream: streams.stream(aliasModel(), { messages: [] }, undefined), activeTargets };
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
