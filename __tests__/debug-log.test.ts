import assert from "node:assert/strict";
import test from "node:test";
import { archiveTimestamp, createDebugLog, MAX_BYTES_ENV, RETENTION_DAYS_ENV } from "../src/debug-log.ts";

const FIXED_DATE = new Date("2026-03-20T12:34:56.000Z");
const ARCHIVE_SUFFIX = `2026-03-20T12-34-56-000Z.${process.pid}.1.jsonl`;
const LOG_PATH = "/fake/logs/pi-model-alias-debug.jsonl";

class FakeDebugFs {
	size = 0;
	entries: string[] = [];
	appends: { path: string; data: string; encoding: string }[] = [];
	calls: string[] = [];
	throwOnAppend = false;
	throwOnMkdir = false;
	throwOnReaddir = false;
	throwOnRename = false;
	throwOnRm = false;
	throwOnStat = false;
	missingOnStat = false;

	appendFileSync(path: string, data: string, encoding: "utf8"): void {
		this.calls.push(`append:${path}`);
		if (this.throwOnAppend) throw new Error("disk full");
		this.appends.push({ path, data, encoding });
	}

	mkdirSync(path: string): void {
		this.calls.push(`mkdir:${path}`);
		if (this.throwOnMkdir) throw new Error("mkdir denied");
	}

	readdirSync(path: string): string[] {
		this.calls.push(`readdir:${path}`);
		if (this.throwOnReaddir) throw new Error("readdir denied");
		return this.entries;
	}

	renameSync(oldPath: string, newPath: string): void {
		this.calls.push(`rename:${oldPath}:${newPath}`);
		if (this.throwOnRename) throw new Error("rename denied");
	}

	rmSync(path: string): void {
		this.calls.push(`rm:${path}`);
		if (this.throwOnRm) throw new Error("rm denied");
	}

	statSync(): { size: number } {
		this.calls.push("stat");
		if (this.missingOnStat) {
			const error = new Error("missing") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		if (this.throwOnStat) throw new Error("stat denied");
		return { size: this.size };
	}
}

function renames(fs: FakeDebugFs): string[] {
	return fs.calls.filter((call) => call.startsWith("rename:"));
}

test("writes one JSON line with timestamp, pid, event, and data", () => {
	const fs = new FakeDebugFs();
	const log = createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {} });

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

test("archives the active log once it passes the default megabyte", () => {
	const fs = new FakeDebugFs();
	fs.size = 1024 * 1024 + 1;

	createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {} });

	assert.deepEqual(renames(fs), [`rename:${LOG_PATH}:${LOG_PATH}.${ARCHIVE_SUFFIX}`]);
});

test("keeps the active log below the default megabyte", () => {
	const fs = new FakeDebugFs();
	fs.size = 1024 * 1024;

	createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {} });

	assert.deepEqual(renames(fs), []);
});

test("honors a custom byte threshold", () => {
	const fs = new FakeDebugFs();
	fs.size = 2_048;

	createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: { [MAX_BYTES_ENV]: "1024" } });

	assert.deepEqual(renames(fs), [`rename:${LOG_PATH}:${LOG_PATH}.${ARCHIVE_SUFFIX}`]);
});

test("gives each archive in one process a distinct name", () => {
	const fs = new FakeDebugFs();
	fs.size = 4_096;
	const log = createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: { [MAX_BYTES_ENV]: "1024" } });

	for (let call = 0; call < 200; call++) log.log("event");

	assert.deepEqual(renames(fs), [
		`rename:${LOG_PATH}:${LOG_PATH}.2026-03-20T12-34-56-000Z.${process.pid}.1.jsonl`,
		`rename:${LOG_PATH}:${LOG_PATH}.2026-03-20T12-34-56-000Z.${process.pid}.2.jsonl`,
	]);
});

test("deletes archives past the default seven-day window", () => {
	const fs = new FakeDebugFs();
	fs.entries = [
		`pi-model-alias-debug.jsonl.2026-03-12T00-00-00-000Z.${process.pid}.1.jsonl`,
		`pi-model-alias-debug.jsonl.2026-03-19T00-00-00-000Z.${process.pid}.1.jsonl`,
		"pi-model-alias-debug.jsonl",
		"pi-model-alias-debug.jsonl.old",
		"cooldown-state.json",
	];

	createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {} });

	assert.deepEqual(
		fs.calls.filter((call) => call.startsWith("rm:")),
		[`rm:/fake/logs/pi-model-alias-debug.jsonl.2026-03-12T00-00-00-000Z.${process.pid}.1.jsonl`],
	);
});

test("honors a custom retention window", () => {
	const fs = new FakeDebugFs();
	fs.entries = [`pi-model-alias-debug.jsonl.2026-03-19T00-00-00-000Z.${process.pid}.1.jsonl`];

	createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: { [RETENTION_DAYS_ENV]: "1" } });

	assert.deepEqual(
		fs.calls.filter((call) => call.startsWith("rm:")),
		[`rm:/fake/logs/pi-model-alias-debug.jsonl.2026-03-19T00-00-00-000Z.${process.pid}.1.jsonl`],
	);
});

test("warns once and falls back when settings are invalid", () => {
	const fs = new FakeDebugFs();
	fs.size = 1024 * 1024 + 1;
	const warnings: string[] = [];

	createDebugLog({
		dir: "/fake/logs",
		now: () => FIXED_DATE,
		fs,
		env: { [MAX_BYTES_ENV]: "0", [RETENTION_DAYS_ENV]: "not-a-number" },
		warn: (message) => warnings.push(message),
	});

	assert.equal(warnings.length, 2);
	assert.match(warnings[0]!, /PI_MODEL_ALIAS_LOG_MAX_BYTES="0"; using 1048576/);
	assert.match(warnings[1]!, /PI_MODEL_ALIAS_LOG_RETENTION_DAYS="not-a-number"; using 7/);
	assert.deepEqual(renames(fs), [`rename:${LOG_PATH}:${LOG_PATH}.${ARCHIVE_SUFFIX}`]);
});

test("rechecks size and retention every two hundred calls", () => {
	const fs = new FakeDebugFs();
	const log = createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {} });
	fs.size = 1024 * 1024 + 1;

	for (let call = 0; call < 199; call++) log.log("event");
	assert.equal(fs.calls.filter((call) => call === "stat").length, 1);

	log.log("event");

	assert.equal(fs.calls.filter((call) => call === "stat").length, 2);
	assert.deepEqual(renames(fs), [`rename:${LOG_PATH}:${LOG_PATH}.${ARCHIVE_SUFFIX}`]);
});

test("reads a timestamp only from rotated archive names", () => {
	assert.equal(
		archiveTimestamp(`pi-model-alias-debug.jsonl.2026-03-20T12-34-56-000Z.${process.pid}.1.jsonl`),
		FIXED_DATE.getTime(),
	);
	assert.equal(archiveTimestamp("pi-model-alias-debug.jsonl"), undefined);
	assert.equal(archiveTimestamp("pi-model-alias-debug.jsonl.old"), undefined);
	assert.equal(archiveTimestamp("cooldown-state.json"), undefined);
	assert.equal(archiveTimestamp(`pi-model-alias-debug.jsonl.not-a-date.${process.pid}.1.jsonl`), undefined);
});

test("prunes expired archives when rotation cannot stat the active log", () => {
	const fs = new FakeDebugFs();
	fs.throwOnStat = true;
	fs.entries = [`pi-model-alias-debug.jsonl.2026-03-12T00-00-00-000Z.${process.pid}.1.jsonl`];

	assert.doesNotThrow(() => createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {} }));
	assert.deepEqual(
		fs.calls.filter((call) => call.startsWith("rm:")),
		[`rm:/fake/logs/pi-model-alias-debug.jsonl.2026-03-12T00-00-00-000Z.${process.pid}.1.jsonl`],
	);
});

test("warns once per actionable maintenance failure and continues cleanup independently", () => {
	const fs = new FakeDebugFs();
	fs.size = 2 * 1024 * 1024;
	fs.entries = [`pi-model-alias-debug.jsonl.2026-03-12T00-00-00-000Z.${process.pid}.1.jsonl`];
	fs.throwOnMkdir = true;
	fs.throwOnRename = true;
	fs.throwOnRm = true;
	const warnings: string[] = [];
	const log = createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {}, warn: (message) => warnings.push(message) });

	for (let call = 0; call < 200; call++) log.log("event");

	assert.deepEqual(warnings, [
		"[pi-model-alias] Log directory creation failed: mkdir denied",
		"[pi-model-alias] Log archive rotation failed: rename denied",
		"[pi-model-alias] Log retention cleanup failed: rm denied",
	]);
	assert.ok(fs.calls.some((call) => call.startsWith("rm:")), "cleanup still runs after rotation fails");
});

test("warns when reading the archive directory fails", () => {
	const fs = new FakeDebugFs();
	fs.throwOnReaddir = true;
	const warnings: string[] = [];

	createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {}, warn: (message) => warnings.push(message) });

	assert.deepEqual(warnings, ["[pi-model-alias] Log retention cleanup failed: readdir denied"]);
});

test("does not warn when the active log is absent during rotation", () => {
	const fs = new FakeDebugFs();
	fs.missingOnStat = true;
	const warnings: string[] = [];

	createDebugLog({ dir: "/fake/logs", now: () => FIXED_DATE, fs, env: {}, warn: (message) => warnings.push(message) });

	assert.deepEqual(warnings, []);
});

test("swallows append errors", () => {
	const fs = new FakeDebugFs();
	fs.throwOnAppend = true;

	assert.doesNotThrow(() => createDebugLog({ dir: "/fake/logs", fs, env: {} }).log("event"));
});
