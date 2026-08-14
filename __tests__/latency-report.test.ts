import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const reportScript = join(import.meta.dirname, "..", "scripts", "latency-report.mjs");

test("takes timeout kinds from typed latency samples", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-model-alias-latency-"));
	const logPath = join(directory, "debug.jsonl");
	writeFileSync(logPath, `${JSON.stringify({ event: "attempt-latency", role: "coder", targetRef: "provider/model", maxGapMs: 1_000, totalMs: 1_000, eventCount: 0, committed: false, outcome: "timeout", timeoutKind: "first event" })}\n`);

	const output = execFileSync(process.execPath, [reportScript, logPath], { encoding: "utf8" });

	assert.match(output, /1\/1 \(100\.0%\); first event: 1/);
	assert.match(output, /coder: attempts 1, timeouts 1, rate 100\.0%; first event: 1, stall: 0, commit: 0/);
});

test("reports legacy timeout kinds without pairing them to latency samples", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-model-alias-latency-"));
	const logPath = join(directory, "debug.jsonl");
	writeFileSync(logPath, `${JSON.stringify({ event: "attempt-timeout", role: "coder", targetRef: "provider/model", reason: "latency timeout: no first event within 1000ms" })}\n${JSON.stringify({ event: "attempt-latency", role: "coder", targetRef: "provider/model", maxGapMs: 1_000, totalMs: 1_000, eventCount: 0, committed: false, outcome: "timeout" })}\n`);

	const output = execFileSync(process.execPath, [reportScript, logPath], { encoding: "utf8" });

	assert.match(output, /Legacy timeout kinds \(from attempt-timeout reason text; not matched to latency samples\):/);
	assert.match(output, /coder\/provider\/model: first event: 1, stall: 0, commit: 0/);
});
