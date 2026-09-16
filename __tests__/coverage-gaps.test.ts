import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseAliasConfig,
	BUILT_IN_POLICY,
	DEFAULT_TIMERS,
	runFallbackChain,
} from "../src/fallback/index.ts";
import { failureStopReason, formatExhaustionError, resolveFirstTarget } from "../src/fallback/refs.ts";
import { createSharedCooldownRegistry } from "../src/cooldown-store.ts";
import { loadAliasConfig } from "../src/alias-config.ts";
import { archiveTimestamp } from "../src/debug-log.ts";
import { createDebugLog } from "../src/debug-log.ts";
import { expandLogPaths, parseLatencyLog, readLatencyLog } from "../src/latency/log.ts";
import {
	createLatencyReport,
	createLatencyReportEntry,
	formatCliLatencyReport,
	formatCompactLatencyReport,
	formatLatencyReportEntry,
} from "../src/latency/report.ts";
import {
	percentile,
	summarize,
	summarizeByRole,
	suggestRoleThresholds,
	suggestThresholds,
	timeoutWarnings,
} from "../src/latency/stats.ts";
import { aliasModel, initializeAliasMetadata, mirrorTargetMetadata, targetsFor } from "../src/alias/alias-model.ts";
import { registerAliasApiProvider } from "../src/alias/api-registration.ts";
import {
	appendConfigWarningEntry,
	appendFailoverEntry,
	appendSettingWarningEntry,
	registerTranscriptRenderers,
	reportFailover,
} from "../src/status/transcript.ts";
import { renderStatusTick, startSession, type AliasSession } from "../src/status/session-status.ts";

test("covers configuration validation and policy fallbacks", () => {
	const values: unknown[] = [null, [], { "": "provider/model" }, { "$defaults": null, coder: "provider/model" },
		{ "$defaults": { unknown: true }, coder: "provider/model" },
		{ "$defaults": { cooldownResetSuccesses: 2, cooldown: { resetSuccesses: 3 } }, coder: "provider/model" },
		{ "$settings": null, coder: "provider/model" }, { "$settings": {}, coder: "provider/model" }, { "$settings": { statusRefreshMs: 2 }, coder: "provider/model" },
		{ "$settings": { statusRefreshMs: 2 }, coder: { nope: [] } },
		{ coder: { targets: "provider/model", timeouts: null } }, { coder: { targets: "provider/model", cooldown: { baseMs: 4, capMs: 2 } } },
		{ coder: { targets: "provider/model", nope: true } },
		{ coder: { targets: "provider/model", cooldown: null } },
		{ coder: { targets: "provider/model", cooldown: { nope: 1 } } },
		{ coder: { targets: "provider/model", cooldown: { baseMs: 0 } } },
		{ coder: { targets: "provider/model", cooldown: { resetSuccesses: 0 } } },
		{ coder: { targets: "provider/model", timeouts: { nope: 1 } } },
		{ coder: { targets: "provider/model", timeouts: { firstEventMs: 0 } } },
		{ coder: [] }, { coder: ["bad"] },
	];
	for (const value of values) {
		if (value && typeof value === "object" && "$settings" in value) {
			const settings = (value as Record<string, unknown>).$settings;
			const coder = (value as Record<string, unknown>).coder;
			if (settings === null || (settings && Object.keys(settings as object).length === 0) || (settings && Object.keys(settings as object).length === 1 && (settings as Record<string, unknown>).statusRefreshMs === 2 && typeof coder === "string")) {
				assert.doesNotThrow(() => parseAliasConfig(value));
				continue;
			}
		}
		assert.throws(() => parseAliasConfig(value));
	}
	const config = parseAliasConfig({ "$defaults": { cooldownResetSuccesses: 2 }, coder: "provider/model" });
	assert.equal(config.policyFor("coder").cooldown.resetSuccesses, 2);
	assert.equal(parseAliasConfig({ "$settings": { statusRefreshMs: 2 }, coder: "provider/model" }).statusRefreshMs, 2);
	assert.equal(config.policyFor("other"), config.policyFor("other"));
	assert.equal(config.policyFor("coder").cooldown.resetSuccesses, 2);
	assert.equal(BUILT_IN_POLICY.cooldown.baseMs > 0, true);
});

test("covers refs and model metadata defensive paths", () => {
	assert.equal(failureStopReason(new Error("aborted")), "aborted");
	assert.equal(failureStopReason({ nope: true }), "error");
	assert.equal(failureStopReason(new Error("x"), { aborted: true }), "aborted");
	assert.equal(formatExhaustionError("r", [{ target: "a/b", reason: "x", retriedFromCooldown: true }]), 'Model alias "r" failed all targets:\n- a/b (retried from cooldown): x');
	const registry = { find: () => undefined, getProvider: () => undefined };
	assert.throws(() => resolveFirstTarget("r", ["a/b"], registry), /failed all targets/);
	const model = aliasModel("coder", "alias");
	const target = { ...model, contextWindow: 12, maxTokens: 4, reasoning: false, input: ["text"] as ["text"] };
	const models = [model];
	mirrorTargetMetadata(model, models, target);
	assert.equal(model.contextWindow, 12);
	assert.doesNotThrow(() => initializeAliasMetadata(new Map([["coder", ["missing/model"]]]), models, registry as never));
	assert.throws(() => targetsFor(aliasModel("missing", "alias"), new Map()), /Unknown model alias/);
});

test("covers latency log readers and report formatting fallbacks", () => {
	const sample = { event: "attempt-latency", role: "r", targetRef: "p/m", maxGapMs: 2, totalMs: 3, eventCount: 1, committed: true, outcome: "complete" };
	assert.equal(parseLatencyLog(["", "bad", JSON.stringify(sample)]).samples.length, 1);
	assert.equal(parseLatencyLog([JSON.stringify({ event: "attempt-timeout", role: "r", targetRef: "p/m", reason: "wrong" })]).legacyTimeouts.length, 0);
	assert.equal(parseLatencyLog([JSON.stringify({ event: "attempt-timeout", role: "r", targetRef: "p/m", reason: 3 })]).legacyTimeouts.length, 0);
	assert.equal(parseLatencyLog([JSON.stringify({ event: "attempt-timeout", role: "r", targetRef: "p/m", reason: "latency timeout: no nope within 1ms" })]).legacyTimeouts.length, 0);
	assert.equal(parseLatencyLog([JSON.stringify({ event: "attempt-timeout", role: "r", targetRef: "p/m", reason: "latency timeout: no first event within 1ms" })]).legacyTimeouts.length, 1);
	assert.deepEqual(readLatencyLog(["missing"], () => undefined), { samples: [], legacyTimeouts: [] });
	const path = join(mkdtempSync(join(tmpdir(), "lat-")), "debug.jsonl"); writeFileSync(path, JSON.stringify(sample));
	assert.equal(readLatencyLog([path]).samples.length, 1);
	assert.deepEqual(expandLogPaths([path + ".old"]), [path + ".old"]);
	assert.deepEqual(expandLogPaths(["/definitely/missing/log.jsonl"]), ["/definitely/missing/log.jsonl.old", "/definitely/missing/log.jsonl"]);
	const report = createLatencyReport({ samples: [sample as never], legacyTimeouts: [] });
	assert.match(formatCliLatencyReport(report), /Suggested model-alias/);
	assert.match(formatLatencyReportEntry(undefined, false), /Missing/);
	assert.match(formatLatencyReportEntry({ message: "hello" }, false), /hello/);
	assert.match(formatLatencyReportEntry({ report }, false), /attempts/);
	assert.match(formatLatencyReportEntry({ report, armedRoles: ["r"] }, false), /attempts/);
	assert.match(formatLatencyReportEntry({ report }, true), /Percentiles/);
	assert.match(formatLatencyReportEntry({ report: createLatencyReport({ samples: [{ ...sample, n: undefined } as never], legacyTimeouts: [] }) }, true), /Percentiles/);
	assert.match(formatLatencyReportEntry({ report: { ...report, targetSummaries: [] } }, true), /Percentiles/);
	assert.equal(formatCompactLatencyReport({ report, armedRoles: ["none"] }), "none: 0 attempts, 0.0% timeouts");
});

test("covers latency statistics empty and warning paths", () => {
	assert.equal(percentile([], 0.5), undefined);
	assert.equal(percentile([1, Number.NaN], 2), undefined);
	const sample = (role: string, outcome: "complete" | "timeout", timeoutKind?: "first event" | "stall" | "commit") => ({ role, targetRef: "p/m", maxGapMs: 2, totalMs: 3, eventCount: 1, committed: true, outcome, ...(timeoutKind ? { timeoutKind } : {}) });
	const samples = [sample("r", "complete"), sample("r", "timeout", "stall"), sample("r", "timeout", "commit")];
	const summary = summarize(samples as never[]);
	assert.equal(summary["p/m"]?.attempts, 3);
	assert.equal(summarizeByRole(samples as never[])[0]?.timeouts, 2);
	assert.equal(summarizeByRole([] as never[]).length, 0);
	assert.equal(formatCliLatencyReport(createLatencyReport({ samples: [], legacyTimeouts: [] })).includes("Timeouts by role"), true);
	assert.equal(timeoutWarnings([{ role: "r", attempts: 200, timeouts: 0, timeoutRate: 0, timeoutsByKind: { "first event": 0, stall: 0, commit: 0 }, n: 200, ttfbMs: {}, maxGapMs: {}, totalMs: {} }]).length, 1);
	assert.equal(timeoutWarnings([]).length, 0);
	assert.equal(summarize([{ role: "empty", targetRef: "p/m", maxGapMs: 1, totalMs: 1, eventCount: 1, committed: false, outcome: "timeout" }] as never[])["p/m"]?.attempts, 1);
	assert.equal(Object.keys(suggestThresholds(summary)).length, 1);
	assert.equal(summarize([]).constructor, Object);
	assert.equal(formatLatencyReportEntry({ report: undefined }, false), "[model-alias] Missing latency report details");
	assert.equal(formatCompactLatencyReport({ report: undefined }), "");
	assert.equal(formatLatencyReportEntry({ report: createLatencyReport({ samples: [], legacyTimeouts: [] }), armedRoles: [] }, false), "");
	assert.equal(formatLatencyReportEntry({ report: createLatencyReport({ samples: [], legacyTimeouts: [] }), armedRoles: ["missing"] }, false), "missing: 0 attempts, 0.0% timeouts");
	assert.equal(formatLatencyReportEntry({ report: createLatencyReport({ samples, legacyTimeouts: [] }), armedRoles: ["other"] }, false), "other: 0 attempts, 0.0% timeouts");
	assert.equal(Object.keys(suggestRoleThresholds(samples as never[])).length, 1);
	assert.deepEqual(summarize([]), {});
});

test("covers transcript renderers and session errors", () => {
	const events: string[] = []; const pi = { appendEntry() { throw new Error("no store"); }, registerEntryRenderer(_type: string, renderer: any) { renderers.push(renderer); } }; const renderers: any[] = [];
	const log = { log: (event: string) => events.push(event) };
	appendConfigWarningEntry(pi as never, { role: "r", target: "p/m", reason: "x" }, log);
	appendSettingWarningEntry(pi as never, { setting: "s", reason: "x" }, log);
	appendFailoverEntry(pi as never, { role: "r", failedTarget: "p/m", reason: "x", cooldownMs: 1, failCount: 1, timestamp: 1 }, log);
	reportFailover({ role: "r", failedTarget: "p/m", reason: "x", cooldownMs: 1, failCount: 1, timestamp: 1 }, { hasUI: false } as never, log);
	registerTranscriptRenderers({ registerEntryRenderer(_type: string, renderer: any) { renderers.push(renderer); } } as never);
	const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text };
	for (const renderer of renderers) { renderer({ data: { role: "r", target: "p/m", reason: "x", chains: [], report: undefined } }, { expanded: false }, theme); renderer({ data: { role: "r", target: "p/m", reason: "x", chains: [], report: undefined } }, { expanded: true }, theme); }
	assert.ok(events.includes("append-entry-error"));
	const session: AliasSession = { registry: undefined, ui: undefined, hasUI: false, model: undefined, activeTargets: new Map() };
	const ui = { theme: { fg: (_c: "muted" | "warning", text: string) => text }, setStatus() { throw new Error("ui"); } };
	assert.equal(startSession(session, { modelRegistry: {}, ui, hasUI: true }, log), true);
	assert.equal(renderStatusTick({ aliases: new Map(), session, lastPushedText: undefined, cooldowns: { state: () => undefined }, debugLog: log }), undefined);
});

test("covers API registration fallback", async () => {
	const calls: string[] = [];
	await registerAliasApiProvider({ stream() {} }, { importRegistrar: async () => ({ unregisterApiProviders: () => calls.push("unregister"), registerApiProvider: () => calls.push("register") }) });
	await registerAliasApiProvider({}, { importRegistrar: async () => { throw new Error("unavailable"); }, warn: (message) => calls.push(message) });
	await registerAliasApiProvider({}, { importRegistrar: async () => { throw new Error("unavailable"); } });
	assert.deepEqual(calls.slice(0, 2), ["unregister", "register"]);
});

test("covers cooldown reload, pruning, and debug failures", () => {
	let source = JSON.stringify({
		"old/model": { failCount: 1, nextRetryAt: 0 },
		"valid/model": { failCount: 2, nextRetryAt: 10_000, successCount: 1 },
		"bad/model": { failCount: "bad", nextRetryAt: 10_000 },
	});
	let mtime = 1;
	const writes: string[] = [];
	const fs = {
		mkdirSync() {}, readFileSync() { return source; }, statSync() { return { mtimeMs: mtime }; },
		writeFileSync(_path: string, data: string) { writes.push(data); source = data; }, renameSync() {},
	};
	const registry = createSharedCooldownRegistry({ now: () => 3_600_001, fs });
	assert.equal(registry.state("old/model")?.failCount, 1);
	assert.equal(registry.state("valid/model")?.successCount, 1);
	mtime++;
	source = JSON.stringify({ "valid/model": { failCount: 2, nextRetryAt: 10_000 } });
	assert.equal(registry.state("valid/model")?.successCount, undefined);
	registry.recordFailure("valid/model");
	registry.recordSuccess("valid/model", 2);
	registry.resetSuccesses("valid/model");
	assert.ok(writes.length > 0);

	const debugWarnings: string[] = [];
	const debugLog = { log() { throw new Error("debug"); } };
	const brokenFs = {
		appendFileSync() { throw new Error("append"); }, mkdirSync() { throw new Error("mkdir"); },
		readdirSync() { throw new Error("read"); }, renameSync() {}, rmSync() {}, statSync() { throw new Error("stat"); },
	};
	const log = createDebugLog({ dir: "/tmp/broken", fs: brokenFs, warn: (message) => debugWarnings.push(message) });
	createSharedCooldownRegistry({ dir: "/tmp/broken", debugLog });
	log.log("event");
	assert.equal(debugWarnings.length, 3);
});

test("fails over with default watchdog timers", async () => {
	assert.ok(DEFAULT_TIMERS.setTimeout(() => undefined, 1));
	DEFAULT_TIMERS.clearTimeout({});
	await runFallbackChain({
		role: "default-timer", targets: ["p/a", "p/b"], policy: { timeouts: { firstEventMs: 1 }, cooldown: BUILT_IN_POLICY.cooldown },
		open: async (target) => target === "p/a" ? hangingEvents() : doneEvents(), forward: () => undefined, warn: () => undefined,
	});
});

test("fails over after an internal timeout", async () => {
	let timeoutCallbacks = 0;
	await runFallbackChain({
		role: "timeout", targets: ["p/a", "p/b"], policy: { timeouts: { firstEventMs: 1 }, cooldown: BUILT_IN_POLICY.cooldown },
		timers: { setTimeout(callback) { callback(); return {}; }, clearTimeout() {} },
		open: async (target) => target === "p/a" ? timeoutRejectingEvents() : doneEvents(), forward: () => undefined, warn: () => undefined,
		onTimeout: () => { timeoutCallbacks++; },
	});
	assert.equal(timeoutCallbacks, 1);
});

test("preserves an error after output commits", async () => {
	await assert.rejects(runFallbackChain({
		role: "role", targets: ["p/a", "p/b"],
		open: async () => committedThenRejectingEvents(), forward: () => undefined, warn: () => undefined,
	}), /committed iterator failed/);
});

test("covers cooldown defensive branches", () => {
	const broken = { mkdirSync() { throw new Error("mkdir"); }, readFileSync() { return "[]"; }, statSync() { throw "stat"; }, writeFileSync() {}, renameSync() {} };
	const registry = createSharedCooldownRegistry({ dir: "/tmp/branches", fs: broken });
	assert.equal(registry.isActive("missing"), false);
	registry.recordFailure("target");
	const silent = createSharedCooldownRegistry({ dir: "/tmp/branches", fs: broken });
	silent.recordFailure("target");
});

async function* hangingEvents() { await new Promise<void>(() => undefined); }
async function* doneEvents() { yield { type: "done" }; }
async function* committedThenRejectingEvents() { yield { type: "text_delta" }; throw new Error("committed iterator failed"); }
async function* timeoutRejectingEvents() { throw new Error("timeout iterator failed"); }

test("covers shared cooldown write failure and active lookup", () => {
	const fs = { mkdirSync() {}, readFileSync() { throw new Error("missing"); }, renameSync() { throw new Error("disk"); }, statSync() { throw new Error("missing"); }, writeFileSync() { throw new Error("disk"); } };
	const throwingDebug = { log() { throw new Error("debug"); } };
	const registry = createSharedCooldownRegistry({ dir: "/tmp/no", fs, debugLog: throwingDebug });
	assert.equal(registry.isActive("x"), false);
	const active = createSharedCooldownRegistry({
		dir: "/tmp/no",
		now: () => 1,
		fs: {
			...fs,
			readFileSync() { return JSON.stringify({ x: { failCount: 1, nextRetryAt: 99 } }); },
			statSync() { return { mtimeMs: 1 }; },
		},
	});
	assert.equal(active.isActive("x"), true);
	assert.equal(registry.recordFailure("x").failCount, 1);
	assert.equal(registry.state("x")?.failCount, 1);
	assert.equal(registry.state("missing"), undefined);
	registry.resetSuccesses("missing");
});

test("keeps empty-config defaults and cooldown persistence failures observable", () => {
	const empty = loadAliasConfig({ log() {} }, "/definitely/missing/model-alias.json");
	assert.equal(empty.policyFor("missing"), BUILT_IN_POLICY);

	const errors: string[] = [];
	const registry = createSharedCooldownRegistry({
		dir: "/tmp/write-error",
		fs: {
			mkdirSync() {},
			readFileSync() { throw new Error("missing"); },
			statSync() { throw new Error("missing"); },
			writeFileSync() { throw "disk unavailable"; },
			renameSync() {},
		},
		debugLog: { log(_event, data) { if (typeof data?.error === "string") errors.push(data.error); } },
	});
	registry.recordFailure("provider/model");
	assert.deepEqual(errors, ["missing", "disk unavailable"]);
});

test("fails over from a non-terminal stream and ignores malformed terminal usage", async () => {
	const warnings: string[] = [];
	await runFallbackChain({
		role: "malformed", targets: ["p/a", "p/b"],
		open: async (target) => target === "p/a"
			? { [Symbol.asyncIterator]: () => ({ next: async () => undefined as never, return: async () => ({ done: true, value: undefined }) }) }
			: { async *[Symbol.asyncIterator]() { yield { type: "done" }; } },
		forward: () => undefined,
		warn: (_target, reason) => warnings.push(reason),
	});
	assert.equal(warnings[0], "stream ended without a terminal event");

	const samples: unknown[] = [];
	await runFallbackChain({
		role: "usage", targets: ["p/a"],
		open: async () => ({ async *[Symbol.asyncIterator]() {
			yield { type: "done", message: { usage: { input: "wrong", cacheRead: 1, output: 1 } } };
		} }),
		forward: () => undefined,
		onLatency: (sample) => samples.push(sample),
		warn: () => undefined,
		now: () => 0,
	});
	assert.deepEqual(samples, [
		{ role: "usage", targetRef: "p/a", ttfbMs: 0, maxGapMs: 0, totalMs: 0, eventCount: 1, committed: false, outcome: "complete" },
	]);
});

test("formats edge-case reports and defensive transcript renderers", () => {
	const emptyReport = createLatencyReport({ samples: [], legacyTimeouts: [] });
	assert.match(createLatencyReportEntry(emptyReport, [], "missing").message ?? "", /Available roles: none/);
	assert.equal(archiveTimestamp("pi-model-alias-debug.jsonl.bad.1.1.jsonl"), undefined);
	assert.equal(archiveTimestamp("pi-model-alias-debug.jsonl.2026-01-01T01-02.1.1.jsonl"), undefined);

	const renderers: Array<(entry: any, options: any, theme: any) => unknown> = [];
	registerTranscriptRenderers({ registerEntryRenderer(_type: string, renderer: any) { renderers.push(renderer); } } as never);
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
	for (const renderer of renderers.slice(0, 3)) renderer({ data: { role: "r", target: "p/m", setting: "s" } }, { expanded: false }, theme);

	const session: AliasSession = { registry: undefined, ui: undefined, hasUI: false, model: undefined, activeTargets: new Map() };
	renderStatusTick({
		aliases: new Map([["r", ["p/m", "p/m"]]]), session, lastPushedText: undefined,
		cooldowns: { state: () => undefined }, debugLog: { log() {} },
	});
});
