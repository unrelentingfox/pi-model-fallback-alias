import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./state-paths.ts";

const LOG_NAME = "pi-model-alias-debug.jsonl";
const ROTATION_CHECK_INTERVAL = 200;
const DEFAULT_LOG_DIR = STATE_DIR;
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const MAX_BYTES_ENV = "PI_MODEL_ALIAS_LOG_MAX_BYTES";
export const RETENTION_DAYS_ENV = "PI_MODEL_ALIAS_LOG_RETENTION_DAYS";

export interface DebugLog {
	log(event: string, data?: Record<string, unknown>): void;
}

interface DebugLogFs {
	appendFileSync(path: string, data: string, encoding: "utf8"): void;
	mkdirSync(path: string, options: { recursive: true }): unknown;
	readdirSync(path: string): string[];
	renameSync(oldPath: string, newPath: string): void;
	rmSync(path: string, options: { force: true }): void;
	statSync(path: string): { size: number };
}

interface DebugLogOptions {
	dir?: string;
	now?: () => Date;
	fs?: DebugLogFs;
	env?: Record<string, string | undefined>;
	warn?: (message: string) => void;
}

const defaultFs: DebugLogFs = {
	appendFileSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
};

export function createDebugLog(options: DebugLogOptions = {}): DebugLog {
	const fs = options.fs ?? defaultFs;
	const now = options.now ?? (() => new Date());
	const path = join(options.dir ?? DEFAULT_LOG_DIR, LOG_NAME);
	const warn = options.warn ?? ((message) => console.warn(message));
	const limits = readLimits(options.env ?? process.env, warn);
	const maintenanceFailures = new Map<string, string>();
	let callsSinceRotationCheck = 0;
	let archivesInThisProcess = 0;
	maintainLogs();

	return {
		log(event, data = {}) {
			try {
				callsSinceRotationCheck++;
				if (callsSinceRotationCheck >= ROTATION_CHECK_INTERVAL) {
					maintainLogs();
					callsSinceRotationCheck = 0;
				}
				fs.mkdirSync(dirname(path), { recursive: true });
				const line = JSON.stringify({ ts: now().toISOString(), pid: process.pid, event, ...data });
				fs.appendFileSync(path, `${line}\n`, "utf8");
			} catch {}
		},
	};

	function maintainLogs(): void {
		runMaintenance("directory creation", () => fs.mkdirSync(dirname(path), { recursive: true }));
		runMaintenance("archive rotation", rotateWhenOversized);
		runMaintenance("retention cleanup", pruneExpiredArchives);
	}

	function runMaintenance(operation: string, action: () => void): void {
		try {
			action();
			maintenanceFailures.delete(operation);
		} catch (error) {
			const message = errorMessage(error);
			if (maintenanceFailures.get(operation) === message) return;
			maintenanceFailures.set(operation, message);
			warn(`[pi-model-alias] Log ${operation} failed: ${message}`);
		}
	}

	function rotateWhenOversized(): void {
		let size: number;
		try {
			size = fs.statSync(path).size;
		} catch (error) {
			if (isMissingFile(error)) return;
			throw error;
		}
		if (size <= limits.maxBytes) return;
		// The pid and sequence keep concurrent sessions from claiming one name.
		const stamp = now().toISOString().replaceAll(":", "-").replaceAll(".", "-");
		archivesInThisProcess++;
		fs.renameSync(path, `${path}.${stamp}.${process.pid}.${archivesInThisProcess}.jsonl`);
	}

	function pruneExpiredArchives(): void {
		const directory = dirname(path);
		const expiresBefore = now().getTime() - limits.retentionDays * MS_PER_DAY;
		for (const name of fs.readdirSync(directory)) {
			const archivedAt = archiveTimestampFor(name, LOG_NAME);
			if (archivedAt === undefined || archivedAt >= expiresBefore) continue;
			fs.rmSync(join(directory, name), { force: true });
		}
	}
}

/** Epoch ms encoded in a rotated archive name, or undefined for other files. */
export function archiveTimestamp(fileName: string): number | undefined {
	return archiveTimestampFor(fileName, LOG_NAME);
}

export function archiveTimestampFor(fileName: string, activeName: string): number | undefined {
	const match = new RegExp(`^${escapeRegex(activeName)}\\.(.+)\\.\\d+\\.\\d+\\.jsonl$`, "u").exec(fileName);
	if (!match?.[1]) return undefined;
	const parsed = Date.parse(restoreIsoStamp(match[1]));
	return Number.isNaN(parsed) ? undefined : parsed;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function restoreIsoStamp(stamp: string): string {
	const [date, time] = stamp.split("T");
	if (!date || !time) return stamp;
	const parts = time.split("-");
	if (parts.length !== 4) return stamp;
	return `${date}T${parts[0]}:${parts[1]}:${parts[2]}.${parts[3]}`;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface LogLimits {
	maxBytes: number;
	retentionDays: number;
}

function readLimits(env: Record<string, string | undefined>, warn: (message: string) => void): LogLimits {
	return {
		maxBytes: positiveInteger(env[MAX_BYTES_ENV], DEFAULT_MAX_LOG_BYTES, MAX_BYTES_ENV, warn),
		retentionDays: positiveInteger(env[RETENTION_DAYS_ENV], DEFAULT_RETENTION_DAYS, RETENTION_DAYS_ENV, warn),
	};
}

function positiveInteger(
	value: string | undefined,
	fallback: number,
	name: string,
	warn: (message: string) => void,
): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
	warn(`[pi-model-alias] Ignoring invalid ${name}="${value}"; using ${fallback}`);
	return fallback;
}
