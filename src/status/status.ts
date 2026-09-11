export interface CooldownStatusItem {
	targetRef: string;
	remainingMs: number;
}

export function formatFooterStatus(
	targetRef: string | undefined,
	cooldownItems: CooldownStatusItem[],
): string | undefined {
	return composeFooterStatus(formatModelStatus(targetRef), formatCooldownStatus(cooldownItems));
}

export function formatModelStatus(targetRef: string | undefined): string | undefined {
	return targetRef;
}

export function formatCooldownStatus(items: CooldownStatusItem[]): string | undefined {
	if (items.length === 0) return undefined;
	const entries = items.map(
		({ targetRef, remainingMs }) => `${targetRef} ${formatDuration(remainingMs)}`,
	);
	return `cooldown: ${entries.join(", ")}`;
}

export function composeFooterStatus(
	modelStatus: string | undefined,
	cooldownStatus: string | undefined,
): string | undefined {
	const segments = [modelStatus, cooldownStatus].filter((segment): segment is string => segment !== undefined);
	return segments.length > 0 ? segments.join(" · ") : undefined;
}

export function formatFailoverWarning(input: {
	role?: string;
	failedTarget?: string;
	reason?: string;
	nextTarget?: string;
	cooldownMs?: number;
	failCount?: number;
}): string {
	const failedTarget = input.failedTarget ?? "unknown";
	const nextTarget = input.nextTarget ?? "unknown";
	const outcome = input.nextTarget ? `falling back to ${nextTarget}` : "chain exhausted";
	return [
		`alias "${input.role ?? "unknown"}": ${failedTarget} failed (${oneLine(input.reason)});`,
		`${outcome} — cooldown ${formatDuration(input.cooldownMs)} (failure ${finiteNumber(input.failCount)})`,
	].join(" ");
}

export function formatDuration(ms: number | undefined): string {
	const durationMs = finiteNumber(ms);
	const seconds = Math.ceil(durationMs / 1_000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.ceil(durationMs / 60_000)}m`;
}

export function finiteNumber(value: number | undefined): number {
	return Number.isFinite(value) ? (value as number) : 0;
}

function oneLine(value: string | undefined): string {
	return (value ?? "").replace(/\s+/gu, " ").trim();
}
