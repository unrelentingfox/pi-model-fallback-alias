import type { DebugLog } from "./debug-log.ts";
import { describeFailure, type AliasMap, type CooldownRegistry } from "./fallback.ts";
import { formatCooldownStatus } from "./status.ts";

const STATUS_KEY = "model-alias";

export interface AliasSessionUi {
	theme: {
		fg(color: "warning", text: string): string;
	};
	setStatus(key: string, value: string | undefined): void;
}

export interface AliasSession<Registry = unknown, Ui extends AliasSessionUi = AliasSessionUi> {
	registry: Registry | undefined;
	ui: Ui | undefined;
	hasUI: boolean;
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
	const items = activeCooldownItems(aliases, now, cooldowns);
	const text = formatCooldownStatus(items);
	if (text === lastPushedText || !session.hasUI || !session.ui) return lastPushedText;

	try {
		session.ui.setStatus(STATUS_KEY, text ? session.ui.theme.fg("warning", text) : undefined);
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

function activeCooldownItems(
	aliases: AliasMap,
	now: number,
	cooldowns: Pick<CooldownRegistry, "state">,
): { targetRef: string; remainingMs: number }[] {
	const items: { targetRef: string; remainingMs: number }[] = [];
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

