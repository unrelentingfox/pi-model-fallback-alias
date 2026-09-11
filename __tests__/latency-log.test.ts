import assert from "node:assert/strict";
import test from "node:test";
import { createLatencyReport, createLatencyReportEntry, formatLatencyReportEntry } from "../src/latency/report.ts";
import { expandLogPaths, readLatencyLog } from "../src/latency/log.ts";

const completeSample = {
	role: "coder",
	targetRef: "provider/model",
	maxGapMs: 1_000,
	totalMs: 2_000,
	eventCount: 1,
	committed: true,
	outcome: "complete" as const,
};

test("reads valid latency records, malformed lines, and .old rotations", () => {
	const logs = new Map<string, string>([
		["debug.jsonl", `${JSON.stringify({ event: "attempt-latency", ...completeSample })}\nnot json\n{}`],
		["debug.jsonl.old", `${JSON.stringify({ event: "attempt-latency", ...completeSample, targetRef: "provider/old" })}\n`],
	]);

	const report = readLatencyLog(expandLogPaths(["debug.jsonl"], () => []), (path) => logs.get(path));

	assert.equal(report.samples.length, 2);
	assert.deepEqual(report.samples.map((sample) => sample.targetRef), ["provider/old", "provider/model"]);
});

test("reads retained generations oldest first and the active file last", () => {
	const entries = [
		"pi-model-alias-debug.jsonl",
		"pi-model-alias-debug.jsonl.2026-03-20T00-00-00-000Z.99.1.jsonl",
		"pi-model-alias-debug.jsonl.2026-03-18T00-00-00-000Z.98.1.jsonl",
		"cooldown-state.json",
	];

	const paths = expandLogPaths(["/logs/pi-model-alias-debug.jsonl"], () => entries);

	assert.deepEqual(paths, [
		"/logs/pi-model-alias-debug.jsonl.old",
		"/logs/pi-model-alias-debug.jsonl.2026-03-18T00-00-00-000Z.98.1.jsonl",
		"/logs/pi-model-alias-debug.jsonl.2026-03-20T00-00-00-000Z.99.1.jsonl",
		"/logs/pi-model-alias-debug.jsonl",
	]);
});

test("excludes archives that belong to another requested log name", () => {
	const entries = [
		"pi-model-alias-debug.jsonl.2026-03-18T00-00-00-000Z.98.1.jsonl",
		"other.jsonl.2026-03-19T00-00-00-000Z.98.1.jsonl",
	];

	const paths = expandLogPaths(["/logs/other.jsonl"], () => entries);

	assert.deepEqual(paths, [
		"/logs/other.jsonl.old",
		"/logs/other.jsonl.2026-03-19T00-00-00-000Z.98.1.jsonl",
		"/logs/other.jsonl",
	]);
});

test("reads each retained generation once", () => {
	const entries = ["pi-model-alias-debug.jsonl.2026-03-18T00-00-00-000Z.98.1.jsonl"];
	const reads: string[] = [];
	const paths = expandLogPaths(
		["/logs/pi-model-alias-debug.jsonl", "/logs/pi-model-alias-debug.jsonl"],
		() => entries,
	);

	readLatencyLog(paths, (path) => {
		reads.push(path);
		return undefined;
	});

	assert.equal(new Set(reads).size, reads.length);
	assert.equal(reads.length, 3);
});

test("keeps legacy attempt-timeout records separate from latency samples", () => {
	const log = `${JSON.stringify({
		event: "attempt-timeout",
		role: "coder",
		targetRef: "provider/model",
		reason: "latency timeout: no stall within 1000ms",
	})}\n`;

	const report = readLatencyLog(["debug.jsonl"], () => log);

	assert.equal(report.samples.length, 0);
	assert.deepEqual(report.legacyTimeouts, [{ role: "coder", targetRef: "provider/model", timeoutKind: "stall" }]);
});

test("filters reports by a known role and reports unknown and empty roles", () => {
	const report = createLatencyReport({
		samples: [completeSample],
		legacyTimeouts: [],
	});

	const filtered = createLatencyReportEntry(report, ["coder", "fallback"], "coder");
	const unknown = createLatencyReportEntry(report, ["coder", "fallback"], "writer");
	const empty = createLatencyReportEntry(report, ["coder", "fallback"], "fallback");

	assert.equal(filtered.report?.samples.length, 1);
	assert.equal(unknown.message, "Unknown alias role \"writer\". Available roles: coder, fallback.");
	assert.equal(empty.message, "No attempt-latency samples found. Restart Pi to begin sampling after this extension change.");
});

test("shapes latency renderer output and handles missing payloads", () => {
	const report = createLatencyReport({
		samples: [completeSample],
		legacyTimeouts: [],
	});

	assert.match(formatLatencyReportEntry(createLatencyReportEntry(report, ["coder"], undefined), false), /coder: 1 attempts/);
	assert.doesNotThrow(() => formatLatencyReportEntry(undefined, false));
	assert.equal(formatLatencyReportEntry(undefined, false), "[model-alias] Missing latency report details");
	assert.equal(formatLatencyReportEntry({ report: {} }, true), "[model-alias] Missing latency report details");
});
