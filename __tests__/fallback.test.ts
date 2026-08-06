import assert from "node:assert/strict";
import test from "node:test";
import {
	ALIAS_API_ID,
	API_REGISTRY_SOURCE_ID,
	API_REGISTRY_UNAVAILABLE_WARNING,
	registerAliasApiProvider,
} from "../api-registration.ts";
import {
	createCooldownRegistry,
	failureStopReason,
	formatExhaustionError,
	parseAliasMap,
	resolveFirstTarget,
	resolveTargetReference,
	runFallbackChain,
} from "../fallback.ts";

type FakeEvent =
	| { type: "start"; partial?: string }
	| { type: "text_start"; partial?: string }
	| { type: "thinking_delta"; partial?: string }
	| { type: "done"; message?: string }
	| { type: "error"; reason: "error" | "aborted"; error: { errorMessage?: string } };

const fakeRegistry = {
	find(providerId: string, modelId: string) {
		return providerId === "good" && modelId === "model" ? { id: modelId } : undefined;
	},
	getProvider(providerId: string) {
		return providerId === "good" ? { id: providerId } : undefined;
	},
};

test("replaces the global alias API registration with the shared streams", async () => {
	const calls: string[] = [];
	const streams = { stream: () => "stream", streamSimple: () => "streamSimple" };
	let registered: (typeof streams & { api: typeof ALIAS_API_ID }) | undefined;
	await registerAliasApiProvider(streams, {
		async importRegistrar() {
			return {
				unregisterApiProviders(sourceId) {
					calls.push(`unregister:${sourceId}`);
				},
				registerApiProvider(provider, sourceId) {
					calls.push(`register:${sourceId}`);
					registered = provider;
				},
			};
		},
	});

	assert.deepEqual(calls, [
		`unregister:${API_REGISTRY_SOURCE_ID}`,
		`register:${API_REGISTRY_SOURCE_ID}`,
	]);
	assert.equal(registered?.api, ALIAS_API_ID);
	assert.equal(registered?.stream, streams.stream);
	assert.equal(registered?.streamSimple, streams.streamSimple);
});

test("continues with one warning when the compat API registry is unavailable", async () => {
	const warnings: string[] = [];

	await registerAliasApiProvider(
		{ stream: () => "stream", streamSimple: () => "streamSimple" },
		{
			async importRegistrar() {
				throw new Error("compat export removed");
			},
			warn: (message) => warnings.push(message),
		},
	);

	assert.deepEqual(warnings, [API_REGISTRY_UNAVAILABLE_WARNING]);
});

test("parses string and ordered array mappings", () => {
	const aliases = parseAliasMap({ single: "good/model", chain: ["bad/model", "good/model"] });

	assert.deepEqual([...aliases], [
		["single", ["good/model"]],
		["chain", ["bad/model", "good/model"]],
	]);
});

test("rejects empty and invalid target arrays", () => {
	assert.throws(() => parseAliasMap({ empty: [] }), /invalid mapping for "empty"/u);
	assert.throws(() => parseAliasMap({ invalid: ["good/model", 4] }), /invalid mapping for "invalid"/u);
});

test("resolves the first available target in preference order", () => {
	const target = resolveFirstTarget("role", ["bad/model", "good/model"], fakeRegistry);

	assert.equal(target.ref, "good/model");
});

test("fails over when a target throws before its first visible event", async () => {
	const forwarded: FakeEvent[] = [];
	const warnings: string[] = [];
	const opened: string[] = [];

	await runFallbackChain({
		role: "role",
		targets: ["bad/model", "good/model"],
		open: async (target) => {
			opened.push(target);
			if (target === "bad/model") return throwBeforeEvent("connection refused");
			return events({ type: "start", partial: "good" }, { type: "done", message: "ok" });
		},
		forward: (event) => forwarded.push(event),
		warn: (failed, reason, next) => warnings.push(`${failed}: ${reason} -> ${next}`),
	});

	assert.deepEqual(opened, ["bad/model", "good/model"]);
	assert.deepEqual(forwarded.map((event) => event.type), ["start", "done"]);
	assert.deepEqual(warnings, ["bad/model: connection refused -> good/model"]);
});

test("grows cooldowns exponentially and caps them at thirty minutes", async () => {
	let currentTime = 1_000;
	const cooldowns = createCooldownRegistry(() => currentTime);
	const durations: number[] = [];

	for (let failure = 0; failure < 7; failure++) {
		await runFallbackChain({
			role: "role",
			targets: ["bad/model", "good/model"],
			cooldowns,
			open: async (target) =>
				target === "bad/model"
					? throwBeforeEvent("unavailable")
					: events({ type: "text_start" }, { type: "done", message: "ok" }),
			forward: () => undefined,
			warn: (_target, _reason, _next, cooldown) => durations.push(cooldown.durationMs),
		});
		currentTime = cooldowns.state("bad/model")!.nextRetryAt;
	}

	assert.deepEqual(durations, [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000]);
	assert.equal(cooldowns.state("bad/model")!.failCount, 7);
});

test("resets a target cooldown when its stream commits", async () => {
	let currentTime = 0;
	let targetFails = true;
	const cooldowns = createCooldownRegistry(() => currentTime);
	const failCounts: number[] = [];
	const request = () =>
		runFallbackChain({
			role: "role",
			targets: ["target/model", "fallback/model"],
			cooldowns,
			open: async (target) => {
				if (target === "target/model" && targetFails) return throwBeforeEvent("unavailable");
				return events({ type: "text_start" }, { type: "done", message: "ok" });
			},
			forward: () => undefined,
			warn: (_target, _reason, _next, cooldown) => failCounts.push(cooldown.failCount),
		});

	await request();
	currentTime = cooldowns.state("target/model")!.nextRetryAt;
	targetFails = false;
	await request();
	assert.equal(cooldowns.state("target/model"), undefined);

	targetFails = true;
	await request();
	assert.deepEqual(failCounts, [1, 1]);
});

test("skips a target while its cooldown is active", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const opened: string[] = [];
	cooldowns.recordFailure("cooling/model");

	await runFallbackChain({
		role: "role",
		targets: ["cooling/model", "ready/model"],
		cooldowns,
		open: async (target) => {
			opened.push(target);
			return events({ type: "text_start" }, { type: "done", message: "ok" });
		},
		forward: () => undefined,
		warn: () => assert.fail("skipping a cooled target must be silent"),
	});

	assert.deepEqual(opened, ["ready/model"]);
});

test("retries a cooled target after available targets fail", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const opened: string[] = [];
	cooldowns.recordFailure("cooling/model");

	await runFallbackChain({
		role: "role",
		targets: ["cooling/model", "ready/model"],
		cooldowns,
		open: async (target) => {
			opened.push(target);
			return target === "ready/model"
				? throwBeforeEvent("ready failed")
				: events({ type: "text_start" }, { type: "done", message: "ok" });
		},
		forward: () => undefined,
		warn: () => undefined,
	});

	assert.deepEqual(opened, ["ready/model", "cooling/model"]);
	assert.equal(cooldowns.state("cooling/model"), undefined);
});

test("reports every failure when cooled retries are also exhausted", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const opened: string[] = [];
	cooldowns.recordFailure("cooling/model");
	const expected = formatExhaustionError("role", [
		{ target: "cooling/model", reason: "cooling failed", retriedFromCooldown: true },
		{ target: "ready/model", reason: "ready failed" },
	]);

	await assert.rejects(
		runFallbackChain({
			role: "role",
			targets: ["cooling/model", "ready/model"],
			cooldowns,
			open: async (target) => {
				opened.push(target);
				return throwBeforeEvent(target === "cooling/model" ? "cooling failed" : "ready failed");
			},
			forward: () => undefined,
			warn: () => undefined,
		}),
		(error) => error instanceof Error && error.message === expected,
	);

	assert.deepEqual(opened, ["ready/model", "cooling/model"]);
});

test("attempts the full chain when every target is cooling", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const opened: string[] = [];
	cooldowns.recordFailure("first/model");
	cooldowns.recordFailure("second/model");

	await runFallbackChain({
		role: "role",
		targets: ["first/model", "second/model"],
		cooldowns,
		open: async (target) => {
			opened.push(target);
			return target === "first/model"
				? throwBeforeEvent("still unavailable")
				: events({ type: "text_start" }, { type: "done", message: "ok" });
		},
		forward: () => undefined,
		warn: () => undefined,
	});

	assert.deepEqual(opened, ["first/model", "second/model"]);
	assert.equal(cooldowns.state("first/model")!.failCount, 2);
	assert.equal(cooldowns.state("second/model"), undefined);
});

test("shares target cooldowns across roles", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const opened: string[] = [];

	await runFallbackChain({
		role: "first-role",
		targets: ["shared/model", "first-fallback/model"],
		cooldowns,
		open: async (target) => {
			opened.push(target);
			return target === "shared/model"
				? throwBeforeEvent("unavailable")
				: events({ type: "text_start" }, { type: "done", message: "ok" });
		},
		forward: () => undefined,
		warn: () => undefined,
	});
	await runFallbackChain({
		role: "second-role",
		targets: ["shared/model", "second-fallback/model"],
		cooldowns,
		open: async (target) => {
			opened.push(target);
			return events({ type: "text_start" }, { type: "done", message: "ok" });
		},
		forward: () => undefined,
		warn: () => assert.fail("the shared cooled target must be skipped silently"),
	});

	assert.deepEqual(opened, ["shared/model", "first-fallback/model", "second-fallback/model"]);
});

test("records at most one pre-commit failure per single-target attempt", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const warnings: string[] = [];
	const warn = (target: string) => warnings.push(target);

	await runFallbackChain({
		role: "double-error-role",
		targets: ["double-error/model"],
		cooldowns,
		open: async () =>
			events(
				{ type: "error", reason: "error", error: { errorMessage: "first" } },
				{ type: "error", reason: "error", error: { errorMessage: "second" } },
			),
		forward: () => undefined,
		warn,
	});
	await runFallbackChain({
		role: "error-commit-role",
		targets: ["error-commit/model"],
		cooldowns,
		open: async () =>
			events(
				{ type: "error", reason: "error", error: { errorMessage: "failed" } },
				{ type: "text_start" },
				{ type: "done", message: "ok" },
			),
		forward: () => undefined,
		warn,
	});

	assert.deepEqual(warnings, ["double-error/model", "error-commit/model"]);
	assert.equal(cooldowns.state("double-error/model")!.failCount, 1);
	assert.equal(cooldowns.state("error-commit/model")!.failCount, 1);
});

test("does not update cooldowns for aborts or post-commit failures", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	const abortError = new Error("cancelled");
	abortError.name = "AbortError";
	cooldowns.recordFailure("aborted/model");
	const abortedState = cooldowns.state("aborted/model");

	await assert.rejects(
		runFallbackChain({
			role: "aborted-role",
			targets: ["aborted/model"],
			cooldowns,
			open: async () => throwError(abortError),
			forward: () => undefined,
			warn: () => assert.fail("an abort must not update cooldown state"),
		}),
		(error) => error === abortError,
	);
	assert.deepEqual(cooldowns.state("aborted/model"), abortedState);

	await assert.rejects(
		runFallbackChain({
			role: "partial-role",
			targets: ["partial/model", "unused/model"],
			cooldowns,
			open: async () => emitTwoThenThrow(),
			forward: () => undefined,
			warn: () => assert.fail("a post-commit failure must not update cooldown state"),
		}),
		/stream broke/u,
	);
	assert.equal(cooldowns.state("partial/model"), undefined);
});

test("flushes buffered thinking events once in order when the fallback commits", async () => {
	const forwarded: FakeEvent[] = [];
	const warnings: string[] = [];
	const opened: string[] = [];
	const committed = [
		{ type: "start", partial: "fallback-start" },
		{ type: "thinking_delta", partial: "thought-one" },
		{ type: "thinking_delta", partial: "thought-two" },
		{ type: "text_start", partial: "answer" },
		{ type: "done", message: "ok" },
	] satisfies FakeEvent[];

	await runFallbackChain({
		role: "role",
		targets: ["failed/model", "fallback/model"],
		open: async (target) => {
			opened.push(target);
			if (target === "failed/model") {
				return events(
					{ type: "start", partial: "discarded-start" },
					{ type: "thinking_delta", partial: "discarded-thought" },
					{ type: "error", reason: "error", error: { errorMessage: "failed" } },
				);
			}
			return events(...committed);
		},
		forward: (event) => forwarded.push(event),
		warn: (failed, reason, next) => warnings.push(`${failed}: ${reason} -> ${next}`),
	});

	assert.deepEqual(opened, ["failed/model", "fallback/model"]);
	assert.deepEqual(forwarded, committed);
	assert.deepEqual(warnings, ["failed/model: failed -> fallback/model"]);
});

test("flushes buffered thinking before an aborted terminal without failing over", async () => {
	const forwarded: FakeEvent[] = [];
	const opened: string[] = [];
	const source = [
		{ type: "start", partial: "start" },
		{ type: "thinking_delta", partial: "thought" },
		{ type: "error", reason: "aborted", error: { errorMessage: "cancelled" } },
	] satisfies FakeEvent[];

	await runFallbackChain({
		role: "role",
		targets: ["active/model", "unused/model"],
		open: async (target) => {
			opened.push(target);
			return events(...source);
		},
		forward: (event) => forwarded.push(event),
		warn: () => assert.fail("an aborted stream must not fail over"),
	});

	assert.deepEqual(opened, ["active/model"]);
	assert.deepEqual(forwarded, source);
});

test("maps a thrown AbortError to aborted without failing over", async () => {
	const opened: string[] = [];
	const abortError = new Error("cancelled");
	abortError.name = "AbortError";
	let surfaced: unknown;

	await assert.rejects(
		runFallbackChain({
			role: "role",
			targets: ["active/model", "unused/model"],
			open: async (target) => {
				opened.push(target);
				return throwError(abortError);
			},
			forward: () => assert.fail("a thrown abort has no events to forward"),
			warn: () => assert.fail("a thrown abort must not fail over"),
		}),
		(error) => {
			surfaced = error;
			return error === abortError;
		},
	);

	assert.equal(failureStopReason(surfaced), "aborted");
	assert.equal(failureStopReason(new Error("cancelled"), { aborted: true }), "aborted");
	assert.deepEqual(opened, ["active/model"]);
});

test("does not restart after non-thinking output was forwarded", async () => {
	const forwarded: FakeEvent[] = [];
	const opened: string[] = [];

	await assert.rejects(
		runFallbackChain({
			role: "role",
			targets: ["partial/model", "unused/model"],
			open: async (target) => {
				opened.push(target);
				return emitTwoThenThrow();
			},
			forward: (event) => forwarded.push(event),
			warn: () => assert.fail("mid-stream failure must not warn about failover"),
		}),
		/stream broke/u,
	);

	assert.deepEqual(opened, ["partial/model"]);
	assert.deepEqual(forwarded.map((event) => event.type), ["start", "text_start"]);
});

test("formats every failure when all targets are exhausted", async () => {
	const expected = formatExhaustionError("role", [
		{ target: "missing/model", reason: 'Model alias "role" targets unknown model "missing/model"' },
		{ target: "bad/model", reason: "HTTP 429" },
	]);

	await assert.rejects(
		runFallbackChain({
			role: "role",
			targets: ["missing/model", "bad/model"],
			open: async (target) => {
				if (target === "missing/model") {
					resolveTargetReference("role", target, fakeRegistry);
				}
				return events({ type: "error", reason: "error", error: { errorMessage: "HTTP 429" } });
			},
			forward: () => assert.fail("failed attempts must stay hidden"),
			warn: () => undefined,
		}),
		(error) => error instanceof Error && error.message === expected,
	);
});

test("passes a single string target stream through unchanged", async () => {
	const aliases = parseAliasMap({ role: "good/model" });
	const warnings: string[] = [];
	const source = [
		{ type: "start", partial: "one" },
		{ type: "error", reason: "error", error: { errorMessage: "original" } },
	] satisfies FakeEvent[];
	const forwarded: FakeEvent[] = [];

	await runFallbackChain({
		role: "role",
		targets: aliases.get("role")!,
		open: async () => events(...source),
		forward: (event) => forwarded.push(event),
		warn: (target, reason, next) => warnings.push(`${target}: ${reason} -> ${String(next)}`),
	});

	assert.deepEqual(forwarded, source);
	assert.deepEqual(warnings, ["good/model: original -> undefined"]);
});

test("rejects alias targets to guard against cycles", () => {
	assert.throws(
		() => resolveTargetReference("role", "alias/other-role", fakeRegistry),
		/Model alias "role" cannot target another alias/u,
	);
});

test("in-memory clearAll wipes everything but counts only active cooldowns", () => {
	let currentTime = 0;
	const cooldowns = createCooldownRegistry(() => currentTime);
	cooldowns.recordFailure("provider/expired");
	currentTime = 60_000;
	cooldowns.recordFailure("provider/active");

	assert.equal(cooldowns.clearAll(), 1);

	assert.equal(cooldowns.state("provider/expired"), undefined);
	assert.equal(cooldowns.state("provider/active"), undefined);
});

async function* events(...source: FakeEvent[]): AsyncGenerator<FakeEvent> {
	yield* source;
}

async function* throwBeforeEvent(reason: string): AsyncGenerator<FakeEvent> {
	throw new Error(reason);
}

async function* throwError(error: Error): AsyncGenerator<FakeEvent> {
	throw error;
}

async function* emitTwoThenThrow(): AsyncGenerator<FakeEvent> {
	yield { type: "start", partial: "partial" };
	yield { type: "text_start", partial: "partial" };
	throw new Error("stream broke");
}
