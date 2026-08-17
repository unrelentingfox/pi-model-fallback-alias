import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { DebugLog } from "./debug-log.ts";
import { describeFailure, type AliasExpansionWarning, type FailoverEntryData } from "./fallback.ts";
import { formatLatencyReportEntry, type LatencyReportEntryData } from "./latency-report.ts";
import type { AliasSession } from "./session-status.ts";
import { finiteNumber, formatDuration, formatFailoverWarning } from "./status.ts";

export const FAILOVER_ENTRY = "model-alias-failover";
export const RESET_ENTRY = "model-alias-reset";
export const LATENCY_REPORT_ENTRY = "model-alias-latency-report";
export const CONFIG_WARNING_ENTRY = "model-alias-config-warning";

export function formatConfigWarning(data: AliasExpansionWarning): string {
	return `Alias "${data.role}" skipped target "${data.target}": ${data.reason}`;
}

export function appendConfigWarningEntry(pi: ExtensionAPI, data: AliasExpansionWarning, debugLog: DebugLog): void {
	try {
		pi.appendEntry<AliasExpansionWarning>(CONFIG_WARNING_ENTRY, data);
	} catch (error) {
		debugLog.log("append-entry-error", { message: describeFailure(error) });
	}
}

export function reportFailover(data: FailoverEntryData, session: AliasSession, debugLog: DebugLog): void {
	debugLog.log("failover-warn", { ...data });
	// In TUI mode the transcript entry is the log; raw stderr would draw over the UI.
	if (!session.hasUI) console.warn(`[pi-model-alias] ${formatFailoverWarning(data)}`);
}

export function appendFailoverEntry(pi: ExtensionAPI, data: FailoverEntryData, debugLog: DebugLog): void {
	try {
		pi.appendEntry<FailoverEntryData>(FAILOVER_ENTRY, data);
	} catch (error) {
		debugLog.log("append-entry-error", { message: describeFailure(error) });
	}
}

export function appendResetEntry(pi: ExtensionAPI, clearedCount: number): void {
	pi.appendEntry(RESET_ENTRY, { clearedCount });
}

export function appendLatencyReportEntry(pi: ExtensionAPI, data: LatencyReportEntryData): void {
	pi.appendEntry(LATENCY_REPORT_ENTRY, data);
}

export function registerTranscriptRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<Partial<AliasExpansionWarning>>(CONFIG_WARNING_ENTRY, (entry, _opts, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const data = entry.data;
		const summary = data?.role && data?.target
			? formatConfigWarning({ role: data.role, target: data.target, reason: data.reason ?? "unknown reason" })
			: "Missing alias config warning details";
		box.addChild(new Text(`${theme.fg("warning", "[model-alias]")} ${summary}`, 0, 0));
		return box;
	});
	pi.registerEntryRenderer<{ clearedCount?: number }>(RESET_ENTRY, (entry, _opts, theme) => {
		const clearedCount = finiteNumber(entry.data?.clearedCount);
		return new Text(theme.fg("dim", `[model-alias] Cleared ${clearedCount} model cooldown(s)`), 0, 0);
	});
	pi.registerEntryRenderer<Partial<LatencyReportEntryData>>(LATENCY_REPORT_ENTRY, (entry, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const data = entry.data;
		if (!data?.report) {
			box.addChild(new Text(theme.fg("warning", formatLatencyReportEntry(data, expanded)), 0, 0));
			return box;
		}
		box.addChild(new Text(theme.fg("dim", "[model-alias] Latency report"), 0, 0));
		box.addChild(new Text(formatLatencyReportEntry(data, expanded), 0, 0));
		return box;
	});
	pi.registerEntryRenderer<Partial<FailoverEntryData>>(FAILOVER_ENTRY, (entry, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const data = entry.data;
		if (!data) {
			box.addChild(new Text(theme.fg("warning", "[model-alias] Missing failover details"), 0, 0));
			return box;
		}

		const warning = formatFailoverWarning(data);
		box.addChild(new Text(`${theme.fg("warning", "[model-alias]")} ${warning}`, 0, 0));
		if (expanded) {
			box.addChild(new Text(`${theme.fg("dim", "Reason:")} ${data.reason ?? ""}`, 0, 0));
			box.addChild(
				new Text(
					theme.fg(
						"dim",
						`Cooldown: ${formatDuration(data.cooldownMs)}; failure ${finiteNumber(data.failCount)}`,
					),
					0,
					0,
				),
			);
			box.addChild(new Text(theme.fg("dim", new Date(finiteNumber(data.timestamp)).toLocaleString()), 0, 0));
		}
		return box;
	});
}
