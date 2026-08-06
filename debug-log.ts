import {
	appendFileSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_NAME = "pi-model-alias-debug.jsonl";
const MAX_LOG_BYTES = 1024 * 1024;
const ROTATION_CHECK_INTERVAL = 200;
const DEFAULT_LOG_DIR = fileURLToPath(new URL("./logs", import.meta.url));

export interface DebugLog {
	log(event: string, data?: Record<string, unknown>): void;
}

interface DebugLogFs {
	appendFileSync(path: string, data: string, encoding: "utf8"): void;
	mkdirSync(path: string, options: { recursive: true }): unknown;
	renameSync(oldPath: string, newPath: string): void;
	rmSync(path: string, options: { force: true }): void;
	statSync(path: string): { size: number };
}

interface DebugLogOptions {
	dir?: string;
	now?: () => Date;
	fs?: DebugLogFs;
}

const defaultFs: DebugLogFs = {
	appendFileSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
};

export function createDebugLog(options: DebugLogOptions = {}): DebugLog {
	const fs = options.fs ?? defaultFs;
	const now = options.now ?? (() => new Date());
	const path = join(options.dir ?? DEFAULT_LOG_DIR, LOG_NAME);
	let callsSinceRotationCheck = 0;
	rotateLog(path, fs);

	return {
		log(event, data = {}) {
			try {
				callsSinceRotationCheck++;
				if (callsSinceRotationCheck >= ROTATION_CHECK_INTERVAL) {
					rotateLog(path, fs);
					callsSinceRotationCheck = 0;
				}
				fs.mkdirSync(dirname(path), { recursive: true });
				const line = JSON.stringify({ ts: now().toISOString(), pid: process.pid, event, ...data });
				fs.appendFileSync(path, `${line}\n`, "utf8");
			} catch {}
		},
	};
}

function rotateLog(path: string, fs: DebugLogFs): void {
	try {
		fs.mkdirSync(dirname(path), { recursive: true });
		if (fs.statSync(path).size <= MAX_LOG_BYTES) return;
		const oldPath = `${path}.old`;
		fs.rmSync(oldPath, { force: true });
		fs.renameSync(path, oldPath);
	} catch {}
}
