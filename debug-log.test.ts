import assert from "node:assert/strict";
import test from "node:test";
import { createDebugLog } from "./debug-log.ts";

const FIXED_DATE = new Date("2026-03-20T12:34:56.000Z");

class FakeDebugFs {
	size = 0;
	appends: { path: string; data: string; encoding: string }[] = [];
	calls: string[] = [];
	throwOnAppend = false;

	appendFileSync(path: string, data: string, encoding: "utf8"): void {
		this.calls.push(`append:${path}`);
		if (this.throwOnAppend) throw new Error("disk full");
		this.appends.push({ path, data, encoding });
	}

	mkdirSync(path: string): void {
		this.calls.push(`mkdir:${path}`);
	}

	renameSync(oldPath: string, newPath: string): void {
		this.calls.push(`rename:${oldPath}:${newPath}`);
	}

	rmSync(path: string): void {
		this.calls.push(`rm:${path}`);
	}

	statSync(): { size: number } {
		this.calls.push("stat");
		return { size: this.size };
	}
}

test("writes one JSON line with timestamp, pid, event, and data", () => {
	const fs = new FakeDebugFs();
	const log = createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs });

	log.log("open-attempt", { role: "coder", ok: true });

	assert.equal(fs.appends.length, 1);
	assert.equal(fs.appends[0]!.encoding, "utf8");
	assert.ok(fs.appends[0]!.data.endsWith("\n"));
	assert.deepEqual(JSON.parse(fs.appends[0]!.data), {
		ts: FIXED_DATE.toISOString(),
		pid: process.pid,
		event: "open-attempt",
		role: "coder",
		ok: true,
	});
});

test("rotates an oversized log and replaces the previous old log", () => {
	const fs = new FakeDebugFs();
	fs.size = 1024 * 1024 + 1;

	createDebugLog({ dir: "/fake/logs", fs });

	assert.deepEqual(fs.calls, [
		"mkdir:/fake/logs",
		"stat",
		"rm:/fake/logs/pi-model-alias-debug.jsonl.old",
		"rename:/fake/logs/pi-model-alias-debug.jsonl:/fake/logs/pi-model-alias-debug.jsonl.old",
	]);
});

test("rechecks and rotates an oversized log every two hundred calls", () => {
	const fs = new FakeDebugFs();
	const log = createDebugLog({ dir: "/fake/logs", fs });
	fs.size = 1024 * 1024 + 1;

	for (let call = 0; call < 199; call++) log.log("event");
	assert.equal(fs.calls.filter((call) => call === "stat").length, 1);

	log.log("event");

	assert.equal(fs.calls.filter((call) => call === "stat").length, 2);
	assert.equal(
		fs.calls.includes(
			"rename:/fake/logs/pi-model-alias-debug.jsonl:/fake/logs/pi-model-alias-debug.jsonl.old",
		),
		true,
	);
});

test("swallows rotation and append errors", () => {
	const fs = new FakeDebugFs();
	fs.statSync = () => {
		throw new Error("stat denied");
	};
	fs.throwOnAppend = true;

	assert.doesNotThrow(() => {
		const log = createDebugLog({ dir: "/fake/logs", fs });
		log.log("event");
	});
});
