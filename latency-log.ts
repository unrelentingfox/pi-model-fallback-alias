import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveTimestampFor } from "./debug-log.ts";
import { type LatencySample, TIMEOUT_KINDS, type TimeoutKind } from "./latency-stats.ts";

export interface LegacyTimeout {
	role: string;
	targetRef: string;
	timeoutKind: TimeoutKind;
}

export interface LatencyLogReport {
	samples: LatencySample[];
	legacyTimeouts: LegacyTimeout[];
}

export type ReadLogFile = (path: string) => string | undefined;
export type ListLogDir = (path: string) => string[];

export const DEFAULT_LATENCY_LOG_PATH = "logs/pi-model-alias-debug.jsonl";
export const EXTENSION_LATENCY_LOG_PATH = fileURLToPath(
	new URL("./logs/pi-model-alias-debug.jsonl", import.meta.url),
);

/** Retained generations oldest first, so the active file's records land last. */
export function expandLogPaths(paths: readonly string[], listDir: ListLogDir = listLogDir): string[] {
	const expanded = paths.flatMap((path) => (path.endsWith(".old") ? [path] : retainedPaths(path, listDir)));
	return [...new Set(expanded)];
}

function retainedPaths(activePath: string, listDir: ListLogDir): string[] {
	const directory = dirname(activePath);
	const activeName = basename(activePath);
	const archives = listDir(directory)
		.flatMap((name) => {
			const archivedAt = archiveTimestampFor(name, activeName);
			return archivedAt === undefined ? [] : [{ path: join(directory, name), archivedAt }];
		})
		.sort((left, right) => left.archivedAt - right.archivedAt)
		.map(({ path }) => path);
	return [`${activePath}.old`, ...archives, join(directory, activeName)];
}

function listLogDir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

export function readLatencyLog(paths: readonly string[], readFile: ReadLogFile = readLogFile): LatencyLogReport {
	return paths.reduce<LatencyLogReport>((report, path) => appendLogFile(report, readFile(path)), {
		samples: [],
		legacyTimeouts: [],
	});
}

export function parseLatencyLog(lines: readonly string[]): LatencyLogReport {
	return lines.reduce<LatencyLogReport>((report, line) => appendLogLine(report, line), {
		samples: [],
		legacyTimeouts: [],
	});
}

export function readLogFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function appendLogFile(report: LatencyLogReport, contents: string | undefined): LatencyLogReport {
	if (contents === undefined) return report;
	for (const line of contents.split("\n")) appendLogLine(report, line);
	return report;
}

function appendLogLine(report: LatencyLogReport, line: string): LatencyLogReport {
	try {
		const record: unknown = JSON.parse(line);
		if (isLatencySample(record)) report.samples.push(record);
		const legacyTimeout = legacyTimeoutKind(record);
		if (legacyTimeout !== undefined) report.legacyTimeouts.push(legacyTimeout);
	} catch {}
	return report;
}

function legacyTimeoutKind(record: unknown): LegacyTimeout | undefined {
	if (!isRecord(record) || record.event !== "attempt-timeout" || typeof record.role !== "string" || typeof record.targetRef !== "string") return undefined;
	const timeoutKind = timeoutKindFromReason(record.reason);
	return timeoutKind === undefined ? undefined : { role: record.role, targetRef: record.targetRef, timeoutKind };
}

function timeoutKindFromReason(reason: unknown): TimeoutKind | undefined {
	if (typeof reason !== "string") return undefined;
	const match = /^latency timeout: no (first event|stall|commit) within \d+ms$/.exec(reason);
	return isTimeoutKind(match?.[1]) ? match[1] : undefined;
}

function isLatencySample(record: unknown): record is LatencySample {
	return isRecord(record)
		&& record.event === "attempt-latency"
		&& typeof record.role === "string"
		&& typeof record.targetRef === "string"
		&& typeof record.maxGapMs === "number"
		&& typeof record.totalMs === "number"
		&& typeof record.eventCount === "number"
		&& typeof record.committed === "boolean"
		&& typeof record.outcome === "string"
		&& (record.timeoutKind === undefined || isTimeoutKind(record.timeoutKind));
}

function isTimeoutKind(value: unknown): value is TimeoutKind {
	return typeof value === "string" && TIMEOUT_KINDS.includes(value as TimeoutKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
