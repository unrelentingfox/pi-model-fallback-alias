import assert from "node:assert/strict";
import test from "node:test";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { installPiModelAlias } from "../index.ts";
import { aliasSessionSlot } from "../src/session-slot.ts";
import { parseAliasConfig } from "../src/fallback/index.ts";
import { aliasModel } from "../src/alias/alias-model.ts";
import { ALIAS_TARGETS_ENTRY, LATENCY_REPORT_ENTRY, RESET_ENTRY } from "../src/status/transcript.ts";

test("registers aliases and handles commands through the extension API", async () => {
	const commands = new Map<string, { handler: (args?: string) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }>();
	const listeners = new Map<string, (...args: never[]) => unknown>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const target = targetModel();
	const provider = targetProvider();
	const registry = {
		find(providerId: string, modelId: string) {
			return providerId === "provider" && modelId === "target" ? target : undefined;
		},
		getProvider(providerId: string) {
			return providerId === "provider" ? provider : undefined;
		},
	};
	const pi = {
		appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
		registerEntryRenderer() {},
		registerProvider() {},
		on(event: string, handler: (...args: never[]) => unknown) { listeners.set(event, handler); },
		registerCommand(name: string, command: { handler: (args?: string) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }) { commands.set(name, command); },
	};

	installPiModelAlias(pi as never, {
		aliasConfig: parseAliasConfig({ coder: "provider/target" }),
		debugLog: { log() {} },
		cooldowns: cooldowns(),
	});

	assert.deepEqual(commands.get("model-alias-targets")?.getArgumentCompletions?.("co"), [{ value: "coder", label: "coder" }]);
	await listeners.get("session_start")?.({} as never, { model: { id: "coder", provider: "alias" }, modelRegistry: registry, hasUI: false } as never);
	await commands.get("model-alias-targets")?.handler("coder");
	await commands.get("model-alias-latency-report")?.handler("");
	await commands.get("model-alias-reset-cooldown")?.handler();

	assert.deepEqual(entries.map((entry) => entry.type), [ALIAS_TARGETS_ENTRY, LATENCY_REPORT_ENTRY, RESET_ENTRY]);
});

function doneEvent() {
	return {
		type: "done",
		reason: "stop",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "target response" }],
			api: "test",
			provider: "provider",
			model: "target",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

function harness() {
	const commands = new Map<string, { handler: (args?: string) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }>();
	const listeners = new Map<string, (...args: never[]) => unknown>();
	const providers: unknown[] = [];
	const pi = {
		appendEntry() {},
		registerEntryRenderer() {},
		registerProvider(provider: unknown) { providers.push(provider); },
		on(event: string, handler: (...args: never[]) => unknown) { listeners.set(event, handler); },
		registerCommand(name: string, command: { handler: (args?: string) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }) { commands.set(name, command); },
	};
	return { pi, providers, listeners, commands };
}

function streamingRegistry() {
	const target = targetModel();
	return {
		find(providerId: string, modelId: string) {
			return providerId === "provider" && modelId === "target" ? target : undefined;
		},
		getProvider() {
			return {
				async *streamSimple() { yield doneEvent(); },
				async *stream() { yield doneEvent(); },
			};
		},
		async getApiKeyAndHeaders() { return { ok: true }; },
	};
}

function targetModel(): Model<"test"> {
	return {
		id: "target", name: "Target", api: "test", provider: "provider", baseUrl: "https://target.invalid",
		reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		contextWindow: 100, maxTokens: 20,
	};
}

function targetProvider(): Provider {
	return {
		id: "provider",
		name: "Provider",
		stream() { return { async *[Symbol.asyncIterator]() { yield { type: "done" }; } }; },
		streamSimple() { return { async *[Symbol.asyncIterator]() { yield { type: "done" }; } }; },
	} as unknown as Provider;
}

function cooldowns() {
	return {
		clearAll: () => 0,
		state: () => undefined,
		isActive: () => false,
		recordFailure: () => ({ failCount: 1, nextRetryAt: 0, durationMs: 0 }),
		recordSuccess() {},
		resetSuccesses() {},
	};
}

function uiStub() {
	return { theme: { fg: (_color: string, text: string) => text }, setStatus() {} };
}

function errorEvent() {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [{ type: "text", text: "target failed" }],
			api: "test",
			provider: "provider",
			model: "primary",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: "usage limit reached",
			timestamp: 0,
		},
	};
}

function failoverRegistry() {
	const primary = { ...targetModel(), id: "primary" };
	const fallback = { ...targetModel(), id: "fallback" };
	const provider = {
		async *streamSimple(model: Model<"test">) {
			yield model.id === "primary" ? errorEvent() : doneEvent();
		},
		async *stream(model: Model<"test">) {
			yield model.id === "primary" ? errorEvent() : doneEvent();
		},
	};
	return {
		find(providerId: string, modelId: string) {
			if (providerId !== "provider") return undefined;
			if (modelId === "primary") return primary;
			if (modelId === "fallback") return fallback;
			return undefined;
		},
		getProvider() {
			return provider;
		},
		async getApiKeyAndHeaders() {
			return { ok: true };
		},
	};
}

async function collectProvider(copy: ReturnType<typeof harness>, role: string): Promise<Array<{ type: string }>> {
	const provider = copy.providers.at(-1) as unknown as {
		streamSimple: (model: never, context: never, options: never) => AsyncIterable<{ type: string }>;
	};
	const events: Array<{ type: string }> = [];
	for await (const event of provider.streamSimple(aliasModel(role, "alias") as never, { messages: [] } as never, {} as never)) {
		events.push(event);
	}
	return events;
}

test("serves alias streams from a copy that never receives session_start", async () => {
	// A subagent whose agent definition restricts `extensions:` gets a copy of
	// this extension that is loaded but never bound, so it never sees
	// `session_start`; it still replaces the process-wide provider.
	const bound = harness();
	installPiModelAlias(bound.pi as never, {
		aliasConfig: parseAliasConfig({ coder: "provider/target" }),
		debugLog: { log() {} },
		cooldowns: cooldowns(),
	});
	await bound.listeners.get("session_start")?.({} as never, {
		model: { id: "coder", provider: "alias" },
		modelRegistry: streamingRegistry(),
		hasUI: false,
	} as never);

	const unbound = harness();
	installPiModelAlias(unbound.pi as never, {
		aliasConfig: parseAliasConfig({ coder: "provider/target" }),
		debugLog: { log() {} },
		cooldowns: cooldowns(),
	});

	const events = await collectProvider(unbound, "coder");

	assert.deepEqual(events.map((event) => event.type), ["done"]);
});

test("shares one session slot across copies", () => {
	assert.strictEqual(aliasSessionSlot(), aliasSessionSlot());
});

test("keeps copies isolated when they are given their own slot", async () => {
	const first = { registry: undefined, hasUI: false };
	const second = { registry: undefined, hasUI: false };
	const registry = streamingRegistry();
	for (const slot of [first, second]) {
		const copy = harness();
		installPiModelAlias(copy.pi as never, {
			aliasConfig: parseAliasConfig({ coder: "provider/target" }),
			debugLog: { log() {} },
			cooldowns: cooldowns(),
			sessionSlot: slot,
		});
		if (slot === first) {
			await copy.listeners.get("session_start")?.({} as never, {
				model: { id: "coder", provider: "alias" },
				modelRegistry: registry,
				hasUI: false,
			} as never);
		}
	}

	assert.strictEqual(first.registry, registry);
	assert.strictEqual(second.registry, undefined);
});

test("an unbound copy keeps failover warnings off stderr when a UI is bound", async (t) => {
	const warnings: unknown[][] = [];
	t.mock.method(console, "warn", (...args: unknown[]) => {
		warnings.push(args);
	});
	const slot = { registry: undefined, hasUI: false };
	const bound = harness();
	installPiModelAlias(bound.pi as never, {
		aliasConfig: parseAliasConfig({ coder: ["provider/primary", "provider/fallback"] }),
		debugLog: { log() {} },
		cooldowns: cooldowns(),
		sessionSlot: slot,
	});
	await bound.listeners.get("session_start")?.({} as never, {
		model: { id: "coder", provider: "alias" },
		modelRegistry: failoverRegistry(),
		hasUI: true,
		ui: uiStub(),
	} as never);

	// The copy that never receives session_start still replaces the process-wide
	// provider; sharing hasUI keeps its failover warning from drawing over the TUI.
	const unbound = harness();
	installPiModelAlias(unbound.pi as never, {
		aliasConfig: parseAliasConfig({ coder: ["provider/primary", "provider/fallback"] }),
		debugLog: { log() {} },
		cooldowns: cooldowns(),
		sessionSlot: slot,
	});
	const events = await collectProvider(unbound, "coder");

	assert.deepEqual(events.map((event) => event.type), ["done"]);
	assert.equal(slot.hasUI, true);
	assert.deepEqual(warnings, []);
});

test("a copy warns about failover when no copy has a UI", async (t) => {
	const warnings: unknown[][] = [];
	t.mock.method(console, "warn", (...args: unknown[]) => {
		warnings.push(args);
	});
	const copy = harness();
	installPiModelAlias(copy.pi as never, {
		aliasConfig: parseAliasConfig({ coder: ["provider/primary", "provider/fallback"] }),
		debugLog: { log() {} },
		cooldowns: cooldowns(),
		sessionSlot: { registry: undefined, hasUI: false },
	});
	await copy.listeners.get("session_start")?.({} as never, {
		model: { id: "coder", provider: "alias" },
		modelRegistry: failoverRegistry(),
		hasUI: false,
	} as never);
	await collectProvider(copy, "coder");

	assert.ok(
		warnings.some((args) => /^\[pi-model-alias\] alias "coder": provider\/primary failed/.test(String(args[0]))),
		JSON.stringify(warnings),
	);
});

function trackedRegistry(name: string, calls: string[]) {
	const registry = streamingRegistry();
	return {
		...registry,
		getProvider() {
			calls.push(name);
			return registry.getProvider();
		},
	};
}

test("a later headless bound copy does not replace an interactive copy's registry", async () => {
	const calls: string[] = [];
	const slot = { registry: undefined, hasUI: false };
	const interactiveRegistry = trackedRegistry("interactive", calls);
	const headlessRegistry = trackedRegistry("headless", calls);
	const install = () => {
		const copy = harness();
		installPiModelAlias(copy.pi as never, {
			aliasConfig: parseAliasConfig({ coder: "provider/target" }),
			debugLog: { log() {} },
			cooldowns: cooldowns(),
			sessionSlot: slot,
		});
		return copy;
	};

	const interactive = install();
	await interactive.listeners.get("session_start")?.({} as never, {
		model: { id: "coder", provider: "alias" },
		modelRegistry: interactiveRegistry,
		hasUI: true,
		ui: uiStub(),
	} as never);

	// An in-process headless child binds its own copy after the interactive one.
	const headless = install();
	await headless.listeners.get("session_start")?.({} as never, {
		model: { id: "coder", provider: "alias" },
		modelRegistry: headlessRegistry,
		hasUI: false,
	} as never);

	const unbound = install();
	calls.length = 0;

	await collectProvider(interactive, "coder");
	await collectProvider(headless, "coder");
	await collectProvider(unbound, "coder");

	assert.deepEqual(calls, ["interactive", "headless", "interactive"]);
	assert.strictEqual(slot.registry, interactiveRegistry);
});
