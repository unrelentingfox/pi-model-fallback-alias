import assert from "node:assert/strict";
import test from "node:test";
import { createCooldownRegistry, parseAliasConfig, runFallbackChain, type TimerApi } from "../fallback.ts";

type Event = { type: "start" | "thinking_delta" | "text_start" | "done" | "error"; reason?: "error" | "aborted"; error?: { errorMessage?: string } };
type Entry = { ms: number; callback: () => void; cleared: boolean; unrefed: boolean };

function timers(): { api: TimerApi; entries: Entry[]; fire(ms: number): void; advance(ms: number): void } {
	const entries: Entry[] = [];
	const handles = new Map<object, Entry>();
	return {
		api: {
			setTimeout(callback, ms) {
				const entry = { ms, callback, cleared: false, unrefed: false };
				const handle = { unref: () => (entry.unrefed = true) };
				entries.push(entry);
				handles.set(handle, entry);
				return handle;
			},
			clearTimeout(handle) {
				const entry = handles.get(handle as object);
				if (entry) entry.cleared = true;
			},
		},
		entries,
		fire(ms) {
			const entry = entries.find((item) => item.ms === ms && !item.cleared);
			assert.ok(entry, `expected an active ${ms}ms timer`);
			entry.callback();
		},
		advance(ms) {
			for (const entry of entries.filter((item) => item.ms === ms && !item.cleared)) entry.callback();
		},
	};
}

async function* never(): AsyncGenerator<Event> {
	await new Promise<void>(() => undefined);
}

async function* values(...items: Event[]): AsyncGenerator<Event> {
	for (const item of items) yield item;
}

function turn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function chain(clock: ReturnType<typeof timers>, open: (target: string, signal?: AbortSignal) => Promise<AsyncIterable<Event>>, timeouts: object, extras = {}) {
	return runFallbackChain({
		role: "coder", targets: ["a/model", "b/model"], timers: clock.api, timeoutsFor: () => timeouts,
		open, forward: async () => undefined, warn: () => undefined, ...extras,
	});
}

test("fails over on a first-event latency timeout", async () => {
	const clock = timers(); const opened: string[] = []; const forwarded: string[] = []; const warnings: string[] = [];
	const run = runFallbackChain({ role: "coder", targets: ["a/model", "b/model"], timers: clock.api, timeoutsFor: () => ({ firstEventMs: 10 }), open: async (target) => { opened.push(target); return target === "a/model" ? never() : values({ type: "text_start" }, { type: "done" }); }, forward: async (event) => { forwarded.push(event.type); }, warn: (_a, reason) => warnings.push(reason) });
	await turn(); clock.fire(10); await run;
	assert.deepEqual(opened, ["a/model", "b/model"]); assert.deepEqual(forwarded, ["text_start", "done"]); assert.match(warnings[0]!, /latency timeout/);
});

test("resets the stall timer for thinking events and discards their buffer", async () => {
	const clock = timers(); let release!: () => void; const wait = new Promise<void>((resolve) => (release = resolve)); const sent: string[] = [];
	async function* thinking(): AsyncGenerator<Event> { yield { type: "thinking_delta" }; yield { type: "thinking_delta" }; await wait; }
	const run = runFallbackChain({ role: "coder", targets: ["a/model", "b/model"], timers: clock.api, timeoutsFor: () => ({ stallMs: 20 }), open: async (target) => target === "a/model" ? thinking() : values({ type: "text_start" }, { type: "done" }), forward: async (event) => { sent.push(event.type); }, warn: () => undefined });
	await turn(); clock.fire(20); release(); await run;
	assert.deepEqual(sent, ["text_start", "done"]); assert.ok(clock.entries.filter((entry) => entry.ms === 20).length >= 3);
});

test("uses commit timeout while thinking continues", async () => {
	const clock = timers(); let release!: () => void; const wait = new Promise<void>((resolve) => (release = resolve)); const opened: string[] = [];
	async function* thinking(): AsyncGenerator<Event> { yield { type: "thinking_delta" }; await wait; }
	const run = chain(clock, async (target) => { opened.push(target); return target === "a/model" ? thinking() : values({ type: "text_start" }, { type: "done" }); }, { commitMs: 30 });
	await turn(); clock.fire(30); release(); await run; assert.deepEqual(opened, ["a/model", "b/model"]);
});

test("does not arm timers for the final target", async () => {
	const clock = timers(); let reject!: (error: Error) => void; const pending = new Promise<AsyncIterable<Event>>((_resolve, fail) => (reject = fail));
	const run = chain(clock, async (target) => target === "a/model" ? values({ type: "error", reason: "error" }) : pending, { firstEventMs: 10 });
	await turn(); assert.equal(clock.entries.length, 1); reject(new Error("stop")); await assert.rejects(run, /stop/);
});

test("does not arm timers for a single target", async () => {
	const clock = timers(); let reject!: (error: Error) => void; const pending = new Promise<AsyncIterable<Event>>((_resolve, fail) => (reject = fail));
	const run = runFallbackChain({ role: "coder", targets: ["a/model"], timers: clock.api, timeoutsFor: () => ({ firstEventMs: 10 }), open: async () => pending, forward: async () => undefined, warn: () => undefined });
	await turn(); assert.equal(clock.entries.length, 0); reject(new Error("stop")); await assert.rejects(run, /stop/);
});

test("records normal cooldown state after a timeout", async () => {
	const clock = timers(); const cooldowns = createCooldownRegistry(() => 0); const run = chain(clock, async (target) => target === "a/model" ? never() : values({ type: "text_start" }, { type: "done" }), { firstEventMs: 10 }, { cooldowns });
	await turn(); clock.fire(10); await run; assert.equal(cooldowns.state("a/model")?.failCount, 1);
});

test("does not classify an internal timeout as a user abort", async () => {
	const clock = timers(); const user = new AbortController(); const opened: string[] = []; const run = chain(clock, async (target) => { opened.push(target); return target === "a/model" ? never() : values({ type: "text_start" }, { type: "done" }); }, { firstEventMs: 10 }, { signal: user.signal });
	await turn(); clock.fire(10); await run; assert.deepEqual(opened, ["a/model", "b/model"]); assert.equal(user.signal.aborted, false);
});

test("preserves a real user abort with configured timeouts", async () => {
	const clock = timers(); const user = new AbortController(); const cooldowns = createCooldownRegistry(() => 0); const run = chain(clock, async () => { user.abort(); throw new DOMException("aborted", "AbortError"); }, { firstEventMs: 10 }, { signal: user.signal, cooldowns });
	await assert.rejects(run, /aborted/); assert.equal(cooldowns.state("a/model"), undefined);
});

test("disarms all watchdog timers at commit", async () => {
	const clock = timers(); let release!: () => void; const wait = new Promise<void>((resolve) => (release = resolve)); const forwarded: string[] = [];
	async function* commits(): AsyncGenerator<Event> { yield { type: "text_start" }; await wait; yield { type: "done" }; }
	const run = runFallbackChain({ role: "coder", targets: ["a/model", "b/model"], timers: clock.api, timeoutsFor: () => ({ firstEventMs: 10, stallMs: 20, commitMs: 30 }), open: async (target) => target === "a/model" ? commits() : values({ type: "done" }), forward: async (event) => { forwarded.push(event.type); }, warn: () => undefined });
	await turn(); assert.ok(clock.entries.every((entry) => entry.unrefed)); release(); await run; assert.deepEqual(forwarded, ["text_start", "done"]);
});

test("does not rearm the watchdog after commit", async () => {
	const clock = timers();
	let emitPostCommit!: () => void;
	let complete!: () => void;
	let aborts = 0;
	const forwarded: Event[] = [];
	const postCommit = new Promise<void>((resolve) => (emitPostCommit = resolve));
	const completion = new Promise<void>((resolve) => (complete = resolve));
	async function* commitsThenPauses(): AsyncGenerator<Event> {
		yield { type: "text_start" };
		await postCommit;
		yield { type: "thinking_delta" };
		await completion;
		yield { type: "done" };
	}
	const run = runFallbackChain({
		role: "coder",
		targets: ["a/model", "b/model"],
		timers: clock.api,
		timeoutsFor: () => ({ stallMs: 20 }),
		open: async (target, signal) => {
			signal?.addEventListener("abort", () => { aborts++; });
			return target === "a/model" ? commitsThenPauses() : values({ type: "done" });
		},
		forward: async (event) => { forwarded.push(event); },
		warn: () => undefined,
	});
	await turn();
	emitPostCommit();
	await turn();
	clock.advance(20);
	complete();
	await run;
	assert.equal(aborts, 0);
	assert.deepEqual(forwarded.map((event) => event.type), ["text_start", "thinking_delta", "done"]);
});

test("ignores a timer that fires as the stream commits", async () => {
	const clock = timers(); let release!: () => void; const wait = new Promise<void>((resolve) => (release = resolve));
	const opened: string[] = []; const forwarded: string[] = []; const warned: string[] = [];
	async function* commits(): AsyncGenerator<Event> { yield { type: "text_start" }; await wait; yield { type: "done" }; }
	const run = runFallbackChain({ role: "coder", targets: ["a/model", "b/model"], timers: clock.api, timeoutsFor: () => ({ firstEventMs: 10, stallMs: 20 }), open: async (target) => { opened.push(target); return target === "a/model" ? commits() : values({ type: "done" }); }, forward: async (event) => { forwarded.push(event.type); }, warn: (target) => warned.push(target) });
	await turn(); clock.entries.forEach((entry) => { entry.cleared = false; }); clock.fire(20); release(); await run;
	assert.deepEqual(opened, ["a/model"]); assert.deepEqual(forwarded, ["text_start", "done"]); assert.deepEqual(warned, []);
});

test("parses defaults, role settings, and legacy maps", () => {
	const config = parseAliasConfig({ $defaults: { timeouts: { firstEventMs: 10, stallMs: 20 } }, old: "a/model", next: { targets: ["alias/old", "b/model"], timeouts: { commitMs: 30 } } });
	assert.deepEqual(config.aliases.get("next"), ["a/model", "b/model"]); assert.deepEqual(config.timeoutsFor("next"), { firstEventMs: 10, stallMs: 20, commitMs: 30 }); assert.equal(parseAliasConfig({ old: "a/model" }).timeoutsFor("old"), undefined); assert.throws(() => parseAliasConfig({ bad: { targets: "a/model", timeouts: { stallMs: 0 } } }));
});

test("passes an independently aborted attempt signal to the provider opener", async () => {
	const clock = timers(); let attempt: AbortSignal | undefined; const run = chain(clock, async (target, signal) => { if (target === "a/model") attempt = signal; return target === "a/model" ? never() : values({ type: "text_start" }, { type: "done" }); }, { firstEventMs: 10 });
	await turn(); assert.equal(attempt?.aborted, false); clock.fire(10); await run; assert.equal(attempt?.aborted, true);
});
