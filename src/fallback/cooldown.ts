import type { CooldownPolicy, CooldownRegistry, CooldownState, CooldownUpdate } from "./types.ts";

export const COOLDOWN_BASE_MS = 5 * 60_000;
export const COOLDOWN_CAP_MS = 60 * 60_000;
export const DEFAULT_STATUS_REFRESH_MS = 2_000;
export const MAX_STATUS_REFRESH_MS = 60_000;

/** Policy used when a config supplies no cooldown fields. */
export const BUILT_IN_COOLDOWN_POLICY: CooldownPolicy = {
	baseMs: COOLDOWN_BASE_MS,
	capMs: COOLDOWN_CAP_MS,
	resetSuccesses: 1,
};

export function createCooldownRegistry(now: () => number = Date.now): CooldownRegistry {
	const entries = new Map<string, CooldownState>();
	return {
		isActive(target) {
			const entry = entries.get(target);
			return entry !== undefined && entry.nextRetryAt > now();
		},
		recordFailure(target, cooldown) {
			const update = nextCooldown(entries.get(target), now(), cooldown);
			entries.set(target, { failCount: update.failCount, nextRetryAt: update.nextRetryAt });
			return update;
		},
		recordSuccess(target, resetAfter) {
			const entry = entries.get(target);
			if (!entry) return;
			const successCount = (entry.successCount ?? 0) + 1;
			if (successCount >= resetAfter) {
				entries.delete(target);
				return;
			}
			entries.set(target, { ...entry, successCount });
		},
		resetSuccesses(target) {
			const entry = entries.get(target);
			if (!entry || entry.successCount === undefined) return;
			entries.set(target, { failCount: entry.failCount, nextRetryAt: entry.nextRetryAt });
		},
		clearAll() {
			const nowMs = now();
			const clearedCount = [...entries.values()].filter((entry) => entry.nextRetryAt > nowMs).length;
			entries.clear();
			return clearedCount;
		},
		state(target) {
			const entry = entries.get(target);
			return entry ? { ...entry } : undefined;
		},
	};
}

export function nextCooldown(
	previous: CooldownState | undefined,
	now: number,
	cooldown: CooldownPolicy = BUILT_IN_COOLDOWN_POLICY,
): CooldownUpdate {
	const failCount = (previous?.failCount ?? 0) + 1;
	// Cooldown state is shared, so a shorter alias policy must never pull an
	// active retry time closer than another alias already set.
	const nextRetryAt = Math.max(previous?.nextRetryAt ?? 0, now + growthMs(failCount, cooldown));
	return { failCount, nextRetryAt, durationMs: nextRetryAt - now };
}

function growthMs(failCount: number, cooldown: CooldownPolicy): number {
	const { baseMs, capMs } = cooldown;
	// Stop doubling once the cap binds, so the exponent stays small for any valid pair.
	const exponent = Math.min(failCount - 1, Math.max(0, Math.ceil(Math.log2(capMs / baseMs))));
	return Math.min(baseMs * 2 ** exponent, capMs);
}
