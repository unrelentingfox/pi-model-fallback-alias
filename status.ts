const MODEL_PREFIX = /^(?:(?:global|us|eu|au|jp)\.)?(?:[^.]+\.)?(?:claude-)?/u;

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
	return targetRef ? shortModelLabel(targetRef) : undefined;
}

export function formatCooldownStatus(items: CooldownStatusItem[]): string | undefined {
	if (items.length === 0) return undefined;
	const entries = items.map(
		({ targetRef, remainingMs }) => `${shortModelLabel(targetRef)} ${formatDuration(remainingMs)}`,
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

export function shortModelLabel(targetRef: string | undefined): string {
	if (!targetRef) return "unknown";
	const firstSlash = targetRef.indexOf("/");
	const modelRef = firstSlash < 0 ? targetRef : targetRef.slice(firstSlash + 1);
	const strippedRef = modelRef.replace(MODEL_PREFIX, "");
	return strippedRef.split("/").at(-1) ?? strippedRef;
}

export function formatFailoverWarning(input: {
	role?: string;
	failedTarget?: string;
	reason?: string;
	nextTarget?: string;
	cooldownMs?: number;
	failCount?: number;
}): string {
	const failedLabel = shortModelLabel(input.failedTarget);
	const nextLabel = shortModelLabel(input.nextTarget);
	const outcome = input.nextTarget ? `falling back to ${nextLabel}` : "chain exhausted";
	return [
		`alias "${input.role ?? "unknown"}": ${failedLabel} failed (${oneLine(input.reason)});`,
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
