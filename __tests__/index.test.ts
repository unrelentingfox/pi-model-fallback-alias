import assert from "node:assert/strict";
import test from "node:test";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { installPiModelAlias } from "../index.ts";
import { parseAliasConfig } from "../src/fallback/index.ts";
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
