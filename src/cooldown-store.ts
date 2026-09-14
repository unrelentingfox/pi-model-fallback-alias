import {
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DebugLog } from "./debug-log.ts";
import {
	nextCooldown,
	type CooldownPolicy,
	type CooldownRegistry,
	type CooldownState,
} from "./fallback/index.ts";
import { STATE_DIR } from "./state-paths.ts";

const STATE_NAME = "cooldown-state.json";
const DEFAULT_STATE_DIR = STATE_DIR;
const STALE_ENTRY_AGE_MS = 60 * 60_000;

type CooldownEntries = Record<string, CooldownState>;

interface CooldownStoreFs {
	mkdirSync(path: string, options: { recursive: true }): unknown;
	readFileSync(path: string, encoding: "utf8"): string;
	renameSync(oldPath: string, newPath: string): void;
	statSync(path: string): { mtimeMs: number };
	writeFileSync(path: string, data: string, encoding: "utf8"): void;
}

interface SharedCooldownOptions {
	dir?: string;
	now?: () => number;
	fs?: CooldownStoreFs;
	debugLog?: DebugLog;
}

const defaultFs: CooldownStoreFs = {
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
};

export function createSharedCooldownRegistry(options: SharedCooldownOptions = {}): CooldownRegistry {
	const store = createStore(options);
	return {
		isActive(target) {
			const entry = store.entries()[target];
			return entry !== undefined && entry.nextRetryAt > store.now();
		},
		recordFailure(target, cooldown?: CooldownPolicy) {
			const now = store.now();
			store.prepareWrite();
			const entries = store.reload();
			const update = nextCooldown(entries[target], now, cooldown);
			entries[target] = { failCount: update.failCount, nextRetryAt: update.nextRetryAt };
			store.write(entries, now);
			store.log("cooldown-record", { targetRef: target, ...update });
			return update;
		},
		recordSuccess(target, resetAfter) {
			const now = store.now();
			const entries = store.reload();
			const entry = entries[target];
			if (!entry) return;
			const successCount = (entry.successCount ?? 0) + 1;
			store.prepareWrite();
			if (successCount >= resetAfter) {
				delete entries[target];
				store.write(entries, now);
				store.log("cooldown-reset", { targetRef: target });
				return;
			}
			entries[target] = { ...entry, successCount };
			store.write(entries, now);
			store.log("cooldown-success", { targetRef: target, successCount, resetAfter });
		},
		resetSuccesses(target) {
			const entries = store.reload();
			const entry = entries[target];
			if (!entry || entry.successCount === undefined) return;
			store.prepareWrite();
			entries[target] = { failCount: entry.failCount, nextRetryAt: entry.nextRetryAt };
			store.write(entries, store.now());
		},
		clearAll() {
			const entries = store.reload();
			if (Object.keys(entries).length === 0) return 0;
			const now = store.now();
			const clearedCount = Object.values(entries).filter((entry) => entry.nextRetryAt > now).length;
			store.prepareWrite();
			store.write({}, now);
			store.log("cooldown-clear-all", { clearedCount });
			return clearedCount;
		},
		state(target) {
			const entry = store.entries()[target];
			return entry ? { ...entry } : undefined;
		},
	};
}

function createStore(options: SharedCooldownOptions) {
	const fs = options.fs ?? defaultFs;
	const now = options.now ?? Date.now;
	const path = join(options.dir ?? DEFAULT_STATE_DIR, STATE_NAME);
	let cache: CooldownEntries = {};
	let cachedMtime: number | undefined;
	let loaded = false;

	return {
		now,
		entries(): CooldownEntries {
			const mtime = fileMtime(path, fs);
			if (!loaded || mtime !== cachedMtime) load(mtime);
			return cache;
		},
		reload(): CooldownEntries {
			load(fileMtime(path, fs));
			return { ...cache };
		},
		prepareWrite(): void {
			try {
				fs.mkdirSync(dirname(path), { recursive: true });
			} catch {}
		},
		write(entries: CooldownEntries, currentTime: number): void {
			const prunedCount = pruneStaleEntries(entries, currentTime);
			try {
				const tempPath = `${path}.${process.pid}.tmp`;
				fs.writeFileSync(tempPath, JSON.stringify(entries), "utf8");
				fs.renameSync(tempPath, path);
				cache = entries;
				cachedMtime = fileMtime(path, fs);
				loaded = true;
				if (prunedCount > 0) log("cooldown-store-prune", { path, prunedCount });
				log("cooldown-store-write", { path, entryCount: Object.keys(entries).length });
			} catch (error) {
				cache = entries;
				loaded = true;
				log("cooldown-store-write", { path, error: errorMessage(error) });
			}
		},
		log,
	};

	function load(mtime: number | undefined): void {
		let error: string | undefined;
		try {
			cache = parseEntries(fs.readFileSync(path, "utf8"));
		} catch (caught) {
			cache = {};
			error = errorMessage(caught);
		}
		cachedMtime = mtime;
		loaded = true;
		log("cooldown-store-load", {
			path,
			entryCount: Object.keys(cache).length,
			...(error ? { error } : {}),
		});
	}

	function log(event: string, data: Record<string, unknown>): void {
		try {
			options.debugLog?.log(event, data);
		} catch {}
	}
}

function parseEntries(source: string): CooldownEntries {
	const value = JSON.parse(source) as unknown;
	if (!isRecord(value)) throw new Error("expected a cooldown state object");

	const entries: CooldownEntries = {};
	for (const [targetRef, state] of Object.entries(value)) {
		if (isCooldownState(state)) entries[targetRef] = state;
	}
	return entries;
}

function pruneStaleEntries(entries: CooldownEntries, now: number): number {
	let prunedCount = 0;
	for (const [targetRef, state] of Object.entries(entries)) {
		if (state.nextRetryAt >= now - STALE_ENTRY_AGE_MS) continue;
		delete entries[targetRef];
		prunedCount++;
	}
	return prunedCount;
}

function fileMtime(path: string, fs: CooldownStoreFs): number | undefined {
	try {
		return fs.statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

function isCooldownState(value: unknown): value is CooldownState {
	if (!isRecord(value)) return false;
	if (value.successCount !== undefined && (typeof value.successCount !== "number" || !Number.isFinite(value.successCount))) {
		return false;
	}
	return (
		typeof value.failCount === "number" &&
		Number.isFinite(value.failCount) &&
		typeof value.nextRetryAt === "number" &&
		Number.isFinite(value.nextRetryAt)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
