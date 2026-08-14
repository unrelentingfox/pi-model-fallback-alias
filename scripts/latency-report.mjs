#!/usr/bin/env node
import { DEFAULT_LATENCY_LOG_PATH, expandLogPaths, readLatencyLog } from "../latency-log.ts";
import { createLatencyReport, formatCliLatencyReport } from "../latency-report.ts";

const inputPaths = process.argv.slice(2);
const log = readLatencyLog(expandLogPaths(inputPaths.length === 0 ? [DEFAULT_LATENCY_LOG_PATH] : inputPaths));
const report = createLatencyReport(log);

if (report.samples.length === 0) {
	console.log("No attempt-latency samples found. Keep using Pi, then run this report again.");
	process.exit(0);
}

console.log(formatCliLatencyReport(report));
