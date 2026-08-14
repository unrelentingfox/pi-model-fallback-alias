import assert from "node:assert/strict";
import test from "node:test";
import { runFallbackChain, type AttemptLatencySample, type TimerApi } from "../fallback.ts";
import { percentile, summarizeByRole, suggestThresholds, summarize, timeoutWarnings } from "../latency-stats.ts";

type Event = { type: "start" | "thinking_delta" | "text_start" | "done" | "error"; reason?: "error" | "aborted" };
type TimerEntry = { ms: number; callback: () => void; cleared: boolean };

function fakeTimers(): { api: TimerApi; fire(ms: number): void } {
	const entries: TimerEntry[] = [];
	return {
		api: {
			setTimeout(callback, ms) {
				const handle = { unref: () => undefined };
				entries.push({ ms, callback, cleared: false });
				return handle;
			},
			clearTimeout() {},
		},
		fire(ms) {
			const entry = entries.find((candidate) => candidate.ms === ms && !candidate.cleared);
			assert.ok(entry);
			entry.callback();
		},
	};
}

async function* events(...values: Event[]): AsyncGenerator<Event> {
	for (const value of values) yield value;
}

async function* never(): AsyncGenerator<Event> {
	await new Promise<void>(() => undefined);
}

function turn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("records attempt latency with an injected clock", async () => {
	let time = 0;
	const samples: AttemptLatencySample[] = [];
	async function* timedEvents(): AsyncGenerator<Event> {
		time = 10; yield { type: "start" };
		time = 35; yield { type: "thinking_delta" };
		time = 50; yield { type: "text_start" };
		time = 80; yield { type: "done" };
	}
	await runFallbackChain({ role: "coder", targets: ["a/model"], open: async () => timedEvents(), forward: () => undefined, warn: () => undefined, now: () => time, onLatency: (sample) => samples.push(sample) });
	assert.deepEqual(samples, [{ role: "coder", targetRef: "a/model", ttfbMs: 10, maxGapMs: 30, commitMs: 50, totalMs: 80, eventCount: 4, committed: true, outcome: "complete" }]);
});

test("records failed attempts and attempts with no configured timeouts", async () => {
	const samples: AttemptLatencySample[] = [];
	await runFallbackChain({ role: "coder", targets: ["a/model", "b/model"], open: async (target) => events(target === "a/model" ? { type: "error", reason: "error" } : { type: "done" }), forward: () => undefined, warn: () => undefined, onLatency: (sample) => samples.push(sample) });
	assert.deepEqual(samples.map((sample) => [sample.targetRef, sample.outcome]), [["a/model", "retryable-failure"], ["b/model", "complete"]]);
});

test("records timed out attempts", async () => {
	let time = 0;
	const clock = fakeTimers();
	const samples: AttemptLatencySample[] = [];
	const run = runFallbackChain({ role: "coder", targets: ["a/model", "b/model"], timers: clock.api, timeoutsFor: () => ({ firstEventMs: 10 }), now: () => time, open: async (target) => target === "a/model" ? never() : events({ type: "done" }), forward: () => undefined, warn: () => undefined, onLatency: (sample) => samples.push(sample) });
	await turn(); time = 10; clock.fire(10); await run;
	assert.equal(samples[0]?.outcome, "timeout");
	assert.equal(samples[0]?.timeoutKind, "first event");
});

test("ignores latency callback failures", async () => {
	const forwarded: string[] = [];
	await runFallbackChain({ role: "coder", targets: ["a/model"], open: async () => events({ type: "done" }), forward: (event) => { forwarded.push(event.type); }, warn: () => undefined, onLatency: () => { throw new Error("log failed"); } });
	assert.deepEqual(forwarded, ["done"]);
});

test("labels a single-target fatal open failure as unsafe", async () => {
	const samples: AttemptLatencySample[] = [];
	await assert.rejects(runFallbackChain({
		role: "coder",
		targets: ["a/model"],
		open: async () => { throw new Error("fatal"); },
		forward: () => undefined,
		warn: () => undefined,
		onLatency: (sample) => samples.push(sample),
	}), /fatal/);
	assert.equal(samples[0]?.outcome, "unsafe-throw");
});

test("summarizes percentiles and marks low-confidence suggestions", () => {
	assert.equal(percentile([], 0.5), undefined);
	assert.equal(percentile([7], 0.995), 7);
	const summary = summarize([{ role: "coder", targetRef: "a/model", ttfbMs: 7_001, maxGapMs: 10_001, totalMs: 20, eventCount: 1, committed: false, outcome: "complete" }]);
	assert.deepEqual(suggestThresholds(summary), { "a/model": { firstEventMs: 11_000, stallMs: 21_000, lowConfidence: true } });
});

test("excludes truncated attempts from percentile inputs", () => {
	const summary = summarize([
		{ role: "coder", targetRef: "a/model", maxGapMs: 100, totalMs: 200, eventCount: 1, committed: true, outcome: "complete" },
		{ role: "coder", targetRef: "a/model", maxGapMs: 10_000, totalMs: 20_000, eventCount: 0, committed: false, outcome: "timeout", timeoutKind: "stall" },
	]);
	const target = summary["a/model"];
	assert.deepEqual(
		target && { attempts: target.attempts, timeouts: target.timeouts, maxGapMs: target.maxGapMs.p995, totalMs: target.totalMs.p995 },
		{ attempts: 2, timeouts: 1, maxGapMs: 100, totalMs: 200 },
	);
});

test("summarizes timeout rates and kinds by role", () => {
	const summary = summarizeByRole([
		{ role: "coder", targetRef: "a/model", maxGapMs: 1, totalMs: 2, eventCount: 0, committed: false, outcome: "timeout", timeoutKind: "first event" },
		{ role: "coder", targetRef: "b/model", maxGapMs: 1, totalMs: 2, eventCount: 0, committed: false, outcome: "timeout", timeoutKind: "stall" },
		{ role: "coder", targetRef: "b/model", maxGapMs: 1, totalMs: 2, eventCount: 1, committed: true, outcome: "complete" },
	]);
	assert.deepEqual(summary[0] && { attempts: summary[0].attempts, timeouts: summary[0].timeouts, timeoutRate: summary[0].timeoutRate, timeoutsByKind: summary[0].timeoutsByKind }, { attempts: 3, timeouts: 2, timeoutRate: 2 / 3, timeoutsByKind: { "first event": 1, stall: 1, commit: 0 } });
});

test("warns for high timeout rates and inactive timers", () => {
	const summaries = summarizeByRole([
		...Array.from({ length: 50 }, () => ({ role: "tight", targetRef: "a/model", maxGapMs: 1, totalMs: 2, eventCount: 0, committed: false, outcome: "timeout" as const })),
		...Array.from({ length: 200 }, () => ({ role: "loose", targetRef: "b/model", maxGapMs: 1, totalMs: 2, eventCount: 1, committed: true, outcome: "complete" as const })),
	]);
	assert.deepEqual(timeoutWarnings(summaries), [
		"loose: no timeouts in 200 attempts; timers may never fire and could be tightened.",
		"tight: timeout rate 100.0% exceeds 2%; thresholds are probably too tight.",
	]);
});
