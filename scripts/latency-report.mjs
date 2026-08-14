#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import {
	suggestedConfig,
	summarizeByRole,
	summarizeByRoleAndTarget,
	suggestRoleThresholds,
	timeoutWarnings,
} from "../latency-stats.ts";

const defaultPath = "logs/pi-model-alias-debug.jsonl";
const inputPaths = process.argv.slice(2);
const report = readReport(expandPaths(inputPaths.length === 0 ? [defaultPath] : inputPaths));
const { samples, legacyTimeouts } = report;

if (samples.length === 0) {
	console.log("No attempt-latency samples found. Keep using Pi, then run this report again.");
	process.exit(0);
}

const rows = summarizeByRoleAndTarget(samples).flatMap((summary) => {
	const confidence = summary.n < 200 ? "low confidence — keep collecting" : "ready";
	return [
		...metricRows(summary.role, summary.targetRef, summary.n, confidence, formatTimeouts(summary), "ttfbMs", summary.ttfbMs),
		...metricRows("", "", "", "", "", "maxGapMs", summary.maxGapMs),
		...metricRows("", "", "", "", "", "totalMs", summary.totalMs),
	];
});
printTable(rows);
printTimeoutSummary(summarizeByRole(samples));
printLegacyTimeoutKinds(legacyTimeouts);
console.log("\nPercentiles and suggestions use complete samples only. Attempt and timeout counts include all samples.");
console.log("\nSuggestions use ceil(p995(ttfbMs) * 1.5), minimum 10000 ms, and ceil(p995(maxGapMs) * 2), minimum 20000 ms. Both round up to 1000 ms. Commit time is never suggested.");
console.log("\nSuggested model-alias.json roles (retain any existing targets not seen in these logs):");
console.log(JSON.stringify(suggestedConfig(suggestRoleThresholds(samples)), null, 2));

function expandPaths(paths) {
	return [...new Set(paths.flatMap((path) => (path.endsWith(".old") ? [path] : [path, `${path}.old`])))];
}

function readReport(paths) {
	return paths.reduce((report, path) => appendPath(report, path), { samples: [], legacyTimeouts: [] });
}

function appendPath(report, path) {
	if (!existsSync(path)) return report;
	for (const line of readFileSync(path, "utf8").split("\n")) appendRecord(report, line);
	return report;
}

function appendRecord(report, line) {
	try {
		const record = JSON.parse(line);
		if (isLatencySample(record)) report.samples.push(record);
		const legacyTimeout = legacyTimeoutKind(record);
		if (legacyTimeout !== undefined) report.legacyTimeouts.push(legacyTimeout);
	} catch {}
}

function legacyTimeoutKind(record) {
	if (record?.event !== "attempt-timeout" || typeof record.role !== "string" || typeof record.targetRef !== "string") return undefined;
	const timeoutKind = timeoutKindFromReason(record.reason);
	return timeoutKind === undefined ? undefined : { role: record.role, targetRef: record.targetRef, timeoutKind };
}

function timeoutKindFromReason(reason) {
	if (typeof reason !== "string") return undefined;
	const match = /^latency timeout: no (first event|stall|commit) within \d+ms$/.exec(reason);
	return match?.[1];
}

function isTimeoutKind(value) {
	return value === "first event" || value === "stall" || value === "commit";
}

function isLatencySample(record) {
	return record?.event === "attempt-latency"
		&& typeof record.role === "string"
		&& typeof record.targetRef === "string"
		&& typeof record.maxGapMs === "number"
		&& typeof record.totalMs === "number"
		&& typeof record.eventCount === "number"
		&& typeof record.committed === "boolean"
		&& typeof record.outcome === "string"
		&& (record.timeoutKind === undefined || isTimeoutKind(record.timeoutKind));
}

function metricRows(role, targetRef, n, confidence, timeouts, metric, values) {
	return [[role, targetRef, n, confidence, timeouts, metric, values.p50, values.p90, values.p99, values.p995, values.max]];
}

function formatTimeouts(summary) {
	const breakdown = Object.entries(summary.timeoutsByKind)
		.filter(([, count]) => count > 0)
		.map(([kind, count]) => `${kind}: ${count}`)
		.join(", ");
	return `${summary.timeouts}/${summary.attempts} (${(summary.timeoutRate * 100).toFixed(1)}%)${breakdown ? `; ${breakdown}` : ""}`;
}

function printTimeoutSummary(summaries) {
	console.log("\nTimeouts by role:");
	for (const summary of summaries) console.log(`${summary.role}: attempts ${summary.attempts}, timeouts ${summary.timeouts}, rate ${(summary.timeoutRate * 100).toFixed(1)}%; ${formatKindBreakdown(summary.timeoutsByKind)}`);
	for (const warning of timeoutWarnings(summaries)) console.log(`Warning: ${warning}`);
}

function printLegacyTimeoutKinds(legacyTimeouts) {
	if (legacyTimeouts.length === 0) return;
	const counts = new Map();
	for (const timeout of legacyTimeouts) {
		const key = `${timeout.role}\u0000${timeout.targetRef}`;
		const group = counts.get(key) ?? { "first event": 0, stall: 0, commit: 0 };
		group[timeout.timeoutKind] += 1;
		counts.set(key, group);
	}
	console.log("\nLegacy timeout kinds (from attempt-timeout reason text; not matched to latency samples):");
	for (const [key, group] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const [role, targetRef] = key.split("\u0000");
		console.log(`${role}/${targetRef}: ${formatKindBreakdown(group)}`);
	}
}

function formatKindBreakdown(counts) {
	return `first event: ${counts["first event"]}, stall: ${counts.stall}, commit: ${counts.commit}`;
}

function printTable(rows) {
	const headers = ["role", "target", "n", "confidence", "timeouts", "metric", "p50", "p90", "p99", "p995", "max"];
	const values = [headers, ...rows].map((row) => row.map(formatValue));
	const widths = headers.map((_, column) => Math.max(...values.map((row) => row[column].length)));
	console.log(values.map((row) => row.map((value, column) => value.padEnd(widths[column])).join("  ")).join("\n"));
}

function formatValue(value) {
	return value === undefined ? "-" : String(value);
}
