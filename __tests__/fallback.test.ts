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
	MAX_ALIAS_DEPTH,
	parseAliasConfig,
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

function aliasesOf(value: unknown): ReadonlyMap<string, readonly string[]> {
	return parseAliasConfig(value).aliases;
}

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
	const aliases = aliasesOf({ single: "good/model", chain: ["bad/model", "good/model"] });

	assert.deepEqual([...aliases], [
		["single", ["good/model"]],
		["chain", ["bad/model", "good/model"]],
	]);
});

test("expands a nested alias in place", () => {
	const aliases = aliasesOf({
		coder: ["provider/first", "alias/fallback", "provider/last"],
		fallback: ["provider/second", "provider/third"],
	});

	assert.deepEqual(aliases.get("coder"), [
		"provider/first",
		"provider/second",
		"provider/third",
		"provider/last",
	]);
});

test("expands multi-level nested aliases", () => {
	const aliases = aliasesOf({
		a: "alias/b",
		b: ["provider/b", "alias/c"],
		c: "provider/c",
	});

	assert.deepEqual(aliases.get("a"), ["provider/b", "provider/c"]);
});

test("expands a diamond through its shared alias once", () => {
	const aliases = aliasesOf({
		a: ["alias/b", "alias/c"],
		b: ["p/1", "alias/d"],
		c: ["p/2", "alias/d"],
		d: ["p/3"],
	});

	assert.deepEqual(aliases.get("a"), ["p/1", "p/3", "p/2"]);
});

test("deduplicates expanded targets at their first position", () => {
	const aliases = aliasesOf({
		coder: ["provider/one", "alias/shared", "provider/two"],
		shared: ["provider/two", "provider/one", "provider/three"],
	});

	assert.deepEqual(aliases.get("coder"), ["provider/one", "provider/two", "provider/three"]);
});

test("deduplicates concrete targets in a flat chain", () => {
	const aliases = aliasesOf({ top: ["p/1", "p/2", "p/1"] });

	assert.deepEqual(aliases.get("top"), ["p/1", "p/2"]);
});

test("skips a self-referencing alias cycle and warns", () => {
	const config = parseAliasConfig({ "coder-model": ["provider/model", "alias/coder-model"] });
	assert.deepEqual(config.aliases.get("coder-model"), ["provider/model"]);
	assert.deepEqual(config.warnings, [
		{ role: "coder-model", target: "alias/coder-model", reason: "alias cycle coder-model -> coder-model" },
	]);
});

test("skips a mutual alias cycle in both directions and keeps concrete targets", () => {
	const config = parseAliasConfig({ a: ["p/1", "alias/b"], b: ["p/2", "alias/a"] });
	assert.deepEqual(config.aliases.get("a"), ["p/1", "p/2"]);
	assert.deepEqual(config.aliases.get("b"), ["p/2", "p/1"]);
	assert.deepEqual(config.warnings, [
		{ role: "b", target: "alias/a", reason: "alias cycle a -> b -> a" },
		{ role: "a", target: "alias/b", reason: "alias cycle b -> a -> b" },
	]);
});

test("attributes a nested cycle to the role that owns the cyclic ref", () => {
	const config = parseAliasConfig({
		r: "alias/x",
		x: ["p/9", "alias/y"],
		y: "alias/z",
		z: "alias/x",
	});
	assert.deepEqual(config.aliases.get("r"), ["p/9"]);
	assert.deepEqual(config.aliases.get("x"), ["p/9"]);
	assert.ok(config.warnings.some(
		(warning) => warning.role === "z" && warning.target === "alias/x" && warning.reason === "alias cycle x -> y -> z -> x",
	));
});

test("skips an unknown nested alias and warns, keeping the role with an empty chain", () => {
	const config = parseAliasConfig({ "coder-model": "alias/nope" });
	assert.deepEqual(config.aliases.get("coder-model"), []);
	assert.deepEqual(config.warnings, [
		{ role: "coder-model", target: "alias/nope", reason: 'unknown alias target "alias/nope"' },
	]);
});

test("attributes a deeply nested unknown alias to its immediate role", () => {
	const config = parseAliasConfig({ r: "alias/x", x: "alias/y", y: ["p/1", "alias/ghost"] });
	assert.deepEqual(config.aliases.get("r"), ["p/1"]);
	assert.deepEqual(config.warnings, [
		{ role: "y", target: "alias/ghost", reason: 'unknown alias target "alias/ghost"' },
	]);
});

test("skips alias refs nested deeper than MAX_ALIAS_DEPTH and warns", () => {
	const config = parseAliasConfig({
		r0: "alias/r1",
		r1: "alias/r2",
		r2: "alias/r3",
		r3: "alias/r4",
		r4: ["p/deep", "alias/r5"],
		r5: "p/deepest",
	});
	assert.deepEqual(config.aliases.get("r0"), ["p/deep"]);
	// One level shallower, the same chain resolves in full.
	assert.deepEqual(config.aliases.get("r1"), ["p/deep", "p/deepest"]);
	assert.deepEqual(config.warnings, [
		{ role: "r4", target: "alias/r5", reason: `alias nesting deeper than ${MAX_ALIAS_DEPTH} levels` },
	]);
});

test("depth-cap expansion is declaration-order independent", () => {
	const deep = {
		r0: "alias/r1",
		r1: "alias/r2",
		r2: "alias/r3",
		r3: "alias/r4",
		r4: ["p/deep", "alias/r5"],
		r5: "p/deepest",
	};
	const first = parseAliasConfig(deep);
	const second = parseAliasConfig(Object.fromEntries(Object.entries(deep).reverse()));

	for (const role of Object.keys(deep)) {
		assert.deepEqual(second.aliases.get(role), first.aliases.get(role), `chain for "${role}" depends on declaration order`);
	}
	const byRole = (left: { role: string }, right: { role: string }) => left.role.localeCompare(right.role);
	assert.deepEqual([...second.warnings].sort(byRole), [...first.warnings].sort(byRole));
});

test("expands a pure mutual cycle to empty chains without throwing", () => {
	const config = parseAliasConfig({ a: ["alias/b"], b: ["alias/a"] });
	assert.deepEqual(config.aliases.get("a"), []);
	assert.deepEqual(config.aliases.get("b"), []);
	assert.equal(config.warnings.length, 2);
});

test("parses a clean config with no warnings", () => {
	assert.deepEqual(parseAliasConfig({ a: ["p/1", "alias/b"], b: "p/2" }).warnings, []);
});

test("expands a string-form nested alias", () => {
	const aliases = aliasesOf({ x: "alias/y", y: "provider/model" });

	assert.deepEqual(aliases.get("x"), ["provider/model"]);
});

test("leaves a map without nested aliases unchanged", () => {
	const aliases = aliasesOf({
		single: "provider/model",
		chain: ["provider/first", "provider/second"],
	});

	assert.deepEqual([...aliases], [
		["single", ["provider/model"]],
		["chain", ["provider/first", "provider/second"]],
	]);
});

test("rejects empty and invalid target arrays", () => {
	assert.throws(() => aliasesOf({ empty: [] }), /invalid mapping for "empty"/u);
	assert.throws(() => aliasesOf({ invalid: ["good/model", 4] }), /invalid mapping for "invalid"/u);
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
		forward: (event) => { forwarded.push(event); },
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

test("keeps a target cooling until it reaches the configured success threshold", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	cooldowns.recordFailure("flaky/model");
	const run = () =>
		runFallbackChain({
			role: "role",
			targets: ["flaky/model"],
			cooldowns,
			cooldownResetSuccesses: 3,
			open: async () => events({ type: "text_start" }, { type: "done", message: "ok" }),
			forward: () => undefined,
			warn: () => undefined,
		});

	await run();
	assert.equal(cooldowns.state("flaky/model")!.successCount, 1);
	await run();
	assert.equal(cooldowns.state("flaky/model")!.successCount, 2);
	await run();
	assert.equal(cooldowns.state("flaky/model"), undefined);
});

test("an intervening failure resets the success streak toward the configured threshold", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	cooldowns.recordFailure("flaky/model");
	const succeed = () =>
		runFallbackChain({
			role: "role",
			targets: ["flaky/model"],
			cooldowns,
			cooldownResetSuccesses: 3,
			open: async () => events({ type: "text_start" }, { type: "done", message: "ok" }),
			forward: () => undefined,
			warn: () => undefined,
		});

	await succeed();
	await succeed();
	assert.equal(cooldowns.state("flaky/model")!.successCount, 2);

	await assert.rejects(
		runFallbackChain({
			role: "role",
			targets: ["flaky/model"],
			cooldowns,
			cooldownResetSuccesses: 3,
			open: async () => throwBeforeEvent("flaky again"),
			forward: () => undefined,
			warn: () => undefined,
		}),
	);
	assert.equal(cooldowns.state("flaky/model")!.successCount, undefined);

	await succeed();
	await succeed();
	assert.equal(cooldowns.state("flaky/model")!.successCount, 2);
});

test("a post-commit failure resets an in-progress success streak", async () => {
	const cooldowns = createCooldownRegistry(() => 0);
	cooldowns.recordFailure("flaky/model");
	const succeed = () =>
		runFallbackChain({
			role: "role",
			targets: ["flaky/model"],
			cooldowns,
			cooldownResetSuccesses: 3,
			open: async () => events({ type: "text_start" }, { type: "done", message: "ok" }),
			forward: () => undefined,
			warn: () => undefined,
		});
	await succeed();
	await succeed();
	assert.equal(cooldowns.state("flaky/model")!.successCount, 2);

	await assert.rejects(
		runFallbackChain({
			role: "role",
			targets: ["flaky/model"],
			cooldowns,
			cooldownResetSuccesses: 3,
			open: async () => emitTwoThenThrow(),
			forward: () => undefined,
			warn: () => assert.fail("a post-commit failure must not warn about failover"),
		}),
		/stream broke/u,
	);
	assert.equal(cooldowns.state("flaky/model")!.successCount, undefined);
});

test("parses a configured $defaults.cooldownResetSuccesses and keeps the default of one", () => {
	const withDefault = parseAliasConfig({ role: "good/model" });
	assert.equal(withDefault.cooldownResetSuccesses, 1);

	const withThreshold = parseAliasConfig({ $defaults: { cooldownResetSuccesses: 5 }, role: "good/model" });
	assert.equal(withThreshold.cooldownResetSuccesses, 5);

	assert.throws(() => parseAliasConfig({ $defaults: { cooldownResetSuccesses: 0 } }), /invalid mapping for "\$defaults"/u);
	assert.throws(() => parseAliasConfig({ $defaults: { cooldownResetSuccesses: 1.5 } }), /invalid mapping for "\$defaults"/u);
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
		forward: (event) => { forwarded.push(event); },
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
		forward: (event) => { forwarded.push(event); },
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
			forward: (event) => { forwarded.push(event); },
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

test("points at config warnings when the expanded chain is empty", async () => {
	await assert.rejects(
		runFallbackChain({
			role: "empty",
			targets: [],
			open: async () => assert.fail("an empty chain must not open a stream"),
			forward: () => assert.fail("an empty chain must not forward events"),
			warn: () => assert.fail("an empty chain must not warn per target"),
		}),
		(error) =>
			error instanceof Error &&
			error.message ===
				'Model alias "empty" has no usable targets (all skipped during config expansion — see model-alias config warnings)',
	);
});

test("passes a single string target stream through unchanged", async () => {
	const aliases = aliasesOf({ role: "good/model" });
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
		forward: (event) => { forwarded.push(event); },
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
