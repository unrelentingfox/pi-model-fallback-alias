import type { DebugLog } from "./debug-log.ts";
import { describeFailure, type AliasMap, type CooldownRegistry } from "./fallback.ts";
import {
	composeFooterStatus,
	formatCooldownStatus,
	formatFooterStatus,
	formatModelStatus,
	type CooldownStatusItem,
} from "./status.ts";

const STATUS_KEY = "model-alias";

export interface AliasSessionUi {
	theme: {
		fg(color: "muted" | "warning", text: string): string;
	};
	setStatus(key: string, value: string | undefined): void;
}

export interface AliasSessionModel {
	id: string;
	provider: string;
}

export interface AliasSession<Registry = unknown, Ui extends AliasSessionUi = AliasSessionUi> {
	registry: Registry | undefined;
	ui: Ui | undefined;
	hasUI: boolean;
	model: AliasSessionModel | undefined;
	activeTargets: Map<string, string>;
}

export interface AliasSessionContext<Registry = unknown, Ui extends AliasSessionUi = AliasSessionUi> {
	modelRegistry: Registry;
	ui: Ui;
	hasUI: boolean;
}

export interface RenderStatusTickOptions {
	aliases: AliasMap;
	session: AliasSession;
	lastPushedText: string | undefined;
	debugLog: DebugLog;
	now?: number;
	cooldowns: Pick<CooldownRegistry, "state">;
}

export function renderStatusTick(options: RenderStatusTickOptions): string | undefined {
	const { aliases, session, lastPushedText, debugLog, now = Date.now(), cooldowns } = options;
	const targetRef = activeTargetForSession(aliases, session, now, cooldowns);
	const items = activeCooldownItems(aliases, now, cooldowns);
	const text = formatFooterStatus(targetRef, items);
	if (text === lastPushedText || !session.hasUI || !session.ui) return lastPushedText;

	try {
		session.ui.setStatus(STATUS_KEY, themedStatus(targetRef, items, session.ui));
		debugLog.log(text ? "status-publish" : "status-clear", {
			itemRefs: items.map(({ targetRef }) => targetRef),
			text: text ?? "cleared",
		});
		return text;
	} catch (error) {
		debugLog.log("ui-error", { operation: "status-publish", message: describeFailure(error) });
		return lastPushedText;
	}
}

export function startSession<Registry, Ui extends AliasSessionUi>(
	session: AliasSession<Registry, Ui>,
	ctx: AliasSessionContext<Registry, Ui>,
	debugLog: DebugLog,
): boolean {
	debugLog.log("session-start", { hasUI: ctx.hasUI });
	session.registry = ctx.modelRegistry;
	if (!ctx.hasUI) return false;

	session.ui = ctx.ui;
	session.hasUI = true;
	try {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	} catch (error) {
		debugLog.log("ui-error", { operation: "status-reset", message: describeFailure(error) });
	}
	return true;
}

function activeTargetForSession(
	aliases: AliasMap,
	session: AliasSession,
	now: number,
	cooldowns: Pick<CooldownRegistry, "state">,
): string | undefined {
	if (session.model?.provider !== "alias") return undefined;
	const role = session.model.id;
	const recordedTarget = session.activeTargets.get(role);
	if (recordedTarget) return recordedTarget;

	const targets = aliases.get(role);
	if (!targets || targets.length === 0) return undefined;
	return targets.find((targetRef) => !isCooling(targetRef, now, cooldowns)) ?? targets[0];
}

function activeCooldownItems(
	aliases: AliasMap,
	now: number,
	cooldowns: Pick<CooldownRegistry, "state">,
): CooldownStatusItem[] {
	const items: CooldownStatusItem[] = [];
	const seen = new Set<string>();
	for (const targets of aliases.values()) {
		for (const targetRef of targets) {
			if (seen.has(targetRef)) continue;
			seen.add(targetRef);
			const state = cooldowns.state(targetRef);
			if (state && state.nextRetryAt > now) {
				items.push({ targetRef, remainingMs: state.nextRetryAt - now });
			}
		}
	}
	return items;
}

function themedStatus(
	targetRef: string | undefined,
	items: CooldownStatusItem[],
	ui: AliasSessionUi,
): string | undefined {
	const modelStatus = formatModelStatus(targetRef);
	const cooldownStatus = formatCooldownStatus(items);
	return composeFooterStatus(
		modelStatus ? ui.theme.fg("muted", modelStatus) : undefined,
		cooldownStatus ? ui.theme.fg("warning", cooldownStatus) : undefined,
	);
}

function isCooling(
	targetRef: string,
	now: number,
	cooldowns: Pick<CooldownRegistry, "state">,
): boolean {
	return (cooldowns.state(targetRef)?.nextRetryAt ?? 0) > now;
}

