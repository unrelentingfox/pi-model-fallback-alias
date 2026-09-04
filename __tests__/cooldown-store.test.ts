import assert from "node:assert/strict";
import test from "node:test";
import { createSharedCooldownRegistry } from "../cooldown-store.ts";
import { COOLDOWN_BASE_MS } from "../fallback.ts";

const STATE_PATH = "/fake/logs/cooldown-state.json";

class FakeCooldownFs {
	files = new Map<string, string>();
	mtimes = new Map<string, number>();
	calls: string[] = [];
	private clock = 0;

	mkdirSync(path: string): void {
		this.calls.push(`mkdir:${path}`);
	}

	readFileSync(path: string): string {
		this.calls.push(`read:${path}`);
		const value = this.files.get(path);
		if (value === undefined) throw new Error("ENOENT");
		return value;
	}

	renameSync(oldPath: string, newPath: string): void {
		this.calls.push(`rename:${oldPath}:${newPath}`);
		const value = this.files.get(oldPath);
		if (value === undefined) throw new Error("ENOENT");
		this.files.delete(oldPath);
		this.files.set(newPath, value);
		this.mtimes.set(newPath, ++this.clock);
	}

	statSync(path: string): { mtimeMs: number } {
		this.calls.push(`stat:${path}`);
		const mtimeMs = this.mtimes.get(path);
		if (mtimeMs === undefined) throw new Error("ENOENT");
		return { mtimeMs };
	}

	writeFileSync(path: string, data: string): void {
		this.calls.push(`write:${path}`);
		this.files.set(path, data);
		this.mtimes.set(path, ++this.clock);
	}

	seed(value: string): void {
		this.files.set(STATE_PATH, value);
		this.mtimes.set(STATE_PATH, ++this.clock);
	}

	state(): Record<string, { failCount: number; nextRetryAt: number }> {
		return JSON.parse(this.files.get(STATE_PATH)!) as Record<
			string,
			{ failCount: number; nextRetryAt: number }
		>;
	}
}

test("escalates failures persisted by another registry instance", () => {
	const fs = new FakeCooldownFs();
	const first = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });
	const second = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });

	const firstUpdate = first.recordFailure("provider/model");
	const secondUpdate = second.recordFailure("provider/model");

	assert.deepEqual(firstUpdate, {
		failCount: 1,
		nextRetryAt: 1_000 + COOLDOWN_BASE_MS,
		durationMs: COOLDOWN_BASE_MS,
	});
	assert.deepEqual(secondUpdate, {
		failCount: 2,
		nextRetryAt: 1_000 + COOLDOWN_BASE_MS * 2,
		durationMs: COOLDOWN_BASE_MS * 2,
	});
	assert.deepEqual(fs.state(), {
		"provider/model": { failCount: 2, nextRetryAt: 1_000 + COOLDOWN_BASE_MS * 2 },
	});
});

test("reloads cached state when the file mtime changes", () => {
	const fs = new FakeCooldownFs();
	fs.seed(JSON.stringify({ "provider/model": { failCount: 1, nextRetryAt: 40_000 } }));
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 0, fs });
	assert.equal(registry.state("provider/model")?.failCount, 1);

	fs.seed(JSON.stringify({ "provider/model": { failCount: 4, nextRetryAt: 80_000 } }));

	assert.equal(registry.state("provider/model")?.failCount, 4);
});

test("treats a corrupt state file as empty", () => {
	const fs = new FakeCooldownFs();
	fs.seed("{not json");
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", fs });

	assert.doesNotThrow(() => registry.state("provider/model"));
	assert.equal(registry.state("provider/model"), undefined);
});

test("resetting an absent target via recordSuccess does not write or log a reset", () => {
	const fs = new FakeCooldownFs();
	const events: string[] = [];
	const registry = createSharedCooldownRegistry({
		dir: "/fake/logs",
		fs,
		debugLog: { log: (event) => events.push(event) },
	});

	registry.recordSuccess("absent/model", 1);

	assert.deepEqual(
		fs.calls.filter((call) => call.startsWith("write:") || call.startsWith("rename:")),
		[],
	);
	assert.equal(events.includes("cooldown-reset"), false);
});

test("an absent recordSuccess does not erase a failure committed after its cached snapshot", () => {
	const fs = new FakeCooldownFs();
	const first = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });
	const second = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });
	assert.equal(second.state("other/model"), undefined);
	first.recordFailure("failed/model");
	const writesBeforeReset = fs.calls.filter((call) => call.startsWith("write:")).length;

	second.recordSuccess("other/model", 1);

	assert.equal(fs.calls.filter((call) => call.startsWith("write:")).length, writesBeforeReset);
	assert.deepEqual(fs.state(), {
		"failed/model": { failCount: 1, nextRetryAt: 1_000 + COOLDOWN_BASE_MS },
	});
});

test("a present recordSuccess at threshold one reloads and preserves a concurrently committed failure", () => {
	const fs = new FakeCooldownFs();
	fs.seed(JSON.stringify({ "reset/model": { failCount: 1, nextRetryAt: 20_000 } }));
	const first = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });
	const second = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });
	assert.equal(second.state("reset/model")?.failCount, 1);
	first.recordFailure("failed/model");

	second.recordSuccess("reset/model", 1);

	assert.deepEqual(fs.state(), {
		"failed/model": { failCount: 1, nextRetryAt: 1_000 + COOLDOWN_BASE_MS },
	});
});

test("recordSuccess below threshold keeps the cooldown active and stores the success count", () => {
	const fs = new FakeCooldownFs();
	fs.seed(JSON.stringify({ "slow-reset/model": { failCount: 2, nextRetryAt: 20_000 } }));
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });

	registry.recordSuccess("slow-reset/model", 3);

	assert.deepEqual(registry.state("slow-reset/model"), {
		failCount: 2,
		nextRetryAt: 20_000,
		successCount: 1,
	});

	registry.recordSuccess("slow-reset/model", 3);
	assert.equal(registry.state("slow-reset/model")?.successCount, 2);

	registry.recordSuccess("slow-reset/model", 3);
	assert.equal(registry.state("slow-reset/model"), undefined);
});

test("resetSuccesses clears an in-progress success streak without clearing the cooldown", () => {
	const fs = new FakeCooldownFs();
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });
	registry.recordFailure("flaky/model");
	registry.recordSuccess("flaky/model", 5);
	assert.equal(registry.state("flaky/model")?.successCount, 1);

	registry.resetSuccesses("flaky/model");

	assert.deepEqual(registry.state("flaky/model"), {
		failCount: 1,
		nextRetryAt: 1_000 + COOLDOWN_BASE_MS,
	});
});

test("prunes entries whose retry time is over one hour old", () => {
	const now = 10_000_000;
	const fs = new FakeCooldownFs();
	fs.seed(
		JSON.stringify({
			"stale/model": { failCount: 2, nextRetryAt: now - 3_600_001 },
			"recent/model": { failCount: 1, nextRetryAt: now - 1_000 },
		}),
	);
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => now, fs });

	registry.recordFailure("new/model");

	assert.deepEqual(fs.state(), {
		"recent/model": { failCount: 1, nextRetryAt: now - 1_000 },
		"new/model": { failCount: 1, nextRetryAt: now + COOLDOWN_BASE_MS },
	});
});

test("writes through a temporary file before atomic rename", () => {
	const fs = new FakeCooldownFs();
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 0, fs });

	registry.recordFailure("provider/model");

	const atomicCalls = fs.calls.filter((call) => call.startsWith("write:") || call.startsWith("rename:"));
	const tempPath = `/fake/logs/cooldown-state.json.${process.pid}.tmp`;
	assert.deepEqual(atomicCalls, [
		`write:${tempPath}`,
		`rename:${tempPath}:/fake/logs/cooldown-state.json`,
	]);
});

test("clearAll empties the store and reports the cleared count", () => {
	const fs = new FakeCooldownFs();
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", now: () => 1_000, fs });
	registry.recordFailure("provider/model-a");
	registry.recordFailure("provider/model-b");

	assert.equal(registry.clearAll(), 2);

	assert.equal(fs.files.get(STATE_PATH), "{}");
	assert.equal(registry.state("provider/model-a"), undefined);
});

test("clearAll on an empty store returns zero without writing", () => {
	const fs = new FakeCooldownFs();
	const registry = createSharedCooldownRegistry({ dir: "/fake/logs", fs });

	assert.equal(registry.clearAll(), 0);

	assert.equal(fs.files.has(STATE_PATH), false);
});
