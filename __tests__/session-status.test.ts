import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	renderStatusTick,
	startSession,
	type AliasSession,
	type AliasSessionContext,
} from "../session-status.ts";

const NOOP_DEBUG_LOG = { log() {} };

function createUi(showColors = false) {
	const statuses: Array<string | undefined> = [];
	const ui = {
		setStatus(_key: string, value: string | undefined) {
			statuses.push(value);
		},
		theme: {
			fg(color: string, text: string) {
				return showColors ? `[${color}]${text}` : text;
			},
		},
	};
	return { ui, statuses };
}

function createSession(): AliasSession {
	return {
		registry: undefined,
		ui: undefined,
		hasUI: false,
		model: undefined,
		activeTargets: new Map(),
	};
}

function createContext(hasUI: boolean, ui: AliasSessionContext["ui"], registry: object): AliasSessionContext {
	return { hasUI, ui, modelRegistry: registry };
}

describe("alias session ownership", () => {
	it("adopts the registry but not the UI when a headless session starts", () => {
		const session = createSession();
		const captured = createUi();
		const headless = createUi();
		const headlessRegistry = {};

		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		const adopted = startSession(session, createContext(false, headless.ui, headlessRegistry), NOOP_DEBUG_LOG);

		assert.equal(adopted, false);
		assert.equal(session.ui, captured.ui);
		assert.equal(session.registry, headlessRegistry);
		assert.equal(session.hasUI, true);
	});

	it("clears any stale footer when a UI session starts", () => {
		const session = createSession();
		const captured = createUi();

		const adopted = startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);

		assert.equal(adopted, true);
		assert.deepEqual(captured.statuses, [undefined]);
	});
});

describe("renderStatusTick", () => {
	it("prefers the recorded target over the configured chain", () => {
		const session = createSession();
		const captured = createUi();
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		session.model = { provider: "alias", id: "fast" };
		session.activeTargets.set("fast", "provider/recorded");

		const text = renderStatusTick({
			aliases: new Map([["fast", ["provider/primary"]]]),
			session,
			lastPushedText: undefined,
			now: 1_000,
			cooldowns: { state: () => undefined },
			debugLog: NOOP_DEBUG_LOG,
		});

		assert.equal(text, "provider/recorded");
		assert.equal(captured.statuses.at(-1), "provider/recorded");
	});

	it("updates the recorded target after failover", () => {
		const session = createSession();
		const captured = createUi(true);
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		session.model = { provider: "alias", id: "fast" };
		session.activeTargets.set("fast", "provider/primary");
		const aliases = new Map([["fast", ["provider/primary", "provider/fallback"]]]);
		const cooldowns = {
			state: (targetRef: string) =>
				targetRef === "provider/primary" ? { failCount: 1, nextRetryAt: 61_000 } : undefined,
		};

		const firstText = renderStatusTick({
			aliases,
			session,
			lastPushedText: undefined,
			now: 1_000,
			cooldowns: { state: () => undefined },
			debugLog: NOOP_DEBUG_LOG,
		});
		session.activeTargets.set("fast", "provider/fallback");
		const failoverText = renderStatusTick({
			aliases,
			session,
			lastPushedText: firstText,
			now: 1_000,
			cooldowns,
			debugLog: NOOP_DEBUG_LOG,
		});

		assert.equal(firstText, "provider/primary");
		assert.equal(failoverText, "provider/fallback · cooldown: provider/primary 1m");
		assert.equal(captured.statuses.at(-1), "[muted]provider/fallback · [warning]cooldown: provider/primary 1m");
	});

	it("renders the next target while the failed target cools", () => {
		const session = createSession();
		const captured = createUi();
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		session.model = { provider: "alias", id: "fast" };
		session.activeTargets.set("fast", "provider/fable-5");
		const aliases = new Map([["fast", ["provider/fable-5", "provider/opus-5"]]]);

		session.activeTargets.set("fast", "provider/opus-5");
		const text = renderStatusTick({
			aliases,
			session,
			lastPushedText: undefined,
			now: 1_000,
			cooldowns: {
				state: (targetRef: string) =>
					targetRef === "provider/fable-5" ? { failCount: 1, nextRetryAt: 31_000 } : undefined,
			},
			debugLog: NOOP_DEBUG_LOG,
		});

		assert.equal(text, "provider/opus-5 · cooldown: provider/fable-5 30s");
		assert.notEqual(text, "provider/fable-5 · cooldown: provider/fable-5 30s");
	});

	it("skips a cooled primary when no target has been recorded", () => {
		const session = createSession();
		const captured = createUi();
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		session.model = { provider: "alias", id: "fast" };

		const text = renderStatusTick({
			aliases: new Map([["fast", ["provider/primary", "provider/healthy"]]]),
			session,
			lastPushedText: undefined,
			now: 1_000,
			cooldowns: {
				state: (targetRef) =>
					targetRef === "provider/primary" ? { failCount: 1, nextRetryAt: 61_000 } : undefined,
			},
			debugLog: NOOP_DEBUG_LOG,
		});

		assert.equal(text, "provider/healthy · cooldown: provider/primary 1m");
	});

	it("shows the primary when the entire chain is cooling", () => {
		const session = createSession();
		const captured = createUi();
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		session.model = { provider: "alias", id: "fast" };

		const text = renderStatusTick({
			aliases: new Map([["fast", ["provider/primary", "provider/secondary"]]]),
			session,
			lastPushedText: undefined,
			now: 1_000,
			cooldowns: { state: () => ({ failCount: 1, nextRetryAt: 61_000 }) },
			debugLog: NOOP_DEBUG_LOG,
		});

		assert.equal(text, "provider/primary · cooldown: provider/primary 1m, provider/secondary 1m");
	});

	it("removes only the current model status when a non-alias model is selected", () => {
		const session = createSession();
		const captured = createUi();
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		session.model = { provider: "alias", id: "fast" };
		const aliases = new Map([["fast", ["provider/primary"]]]);
		const cooldowns = { state: () => ({ failCount: 1, nextRetryAt: 61_000 }) };

		const aliasText = renderStatusTick({
			aliases,
			session,
			lastPushedText: undefined,
			now: 1_000,
			cooldowns,
			debugLog: NOOP_DEBUG_LOG,
		});
		session.model = { provider: "provider", id: "fast" };
		const nonAliasText = renderStatusTick({
			aliases,
			session,
			lastPushedText: aliasText,
			now: 1_000,
			cooldowns,
			debugLog: NOOP_DEBUG_LOG,
		});

		assert.equal(aliasText, "provider/primary · cooldown: provider/primary 1m");
		assert.equal(nonAliasText, "cooldown: provider/primary 1m");
		assert.deepEqual(captured.statuses, [
			undefined,
			"provider/primary · cooldown: provider/primary 1m",
			"cooldown: provider/primary 1m",
		]);
	});

	it("omits the model segment for a non-alias session model", () => {
		const session = createSession();
		const captured = createUi();
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		session.model = { provider: "provider", id: "fast" };
		session.activeTargets.set("fast", "provider/recorded");

		const text = renderStatusTick({
			aliases: new Map([["fast", ["provider/primary"]]]),
			session,
			lastPushedText: undefined,
			now: 1_000,
			cooldowns: { state: () => ({ failCount: 1, nextRetryAt: 61_000 }) },
			debugLog: NOOP_DEBUG_LOG,
		});

		assert.equal(text, "cooldown: provider/primary 1m");
	});

	it("keeps the footer hidden without an alias session model or cooldowns", () => {
		const session = createSession();
		const captured = createUi();
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);

		const text = renderStatusTick({
			aliases: new Map([["fast", ["provider/primary"]]]),
			session,
			lastPushedText: undefined,
			now: 1_000,
			cooldowns: { state: () => undefined },
			debugLog: NOOP_DEBUG_LOG,
		});

		assert.equal(text, undefined);
		assert.deepEqual(captured.statuses, [undefined]);
	});

	it("publishes changed cooldown text and skips unchanged text", () => {
		const session = createSession();
		const captured = createUi();
		startSession(session, createContext(true, captured.ui, {}), NOOP_DEBUG_LOG);
		const aliases = new Map([["fast", ["provider/model"]]]);
		let nextRetryAt = 61_000;
		const cooldowns = {
			state: () => ({ failCount: 1, nextRetryAt }),
		};
		const events: string[] = [];
		const debugLog = {
			log(event: string) {
				events.push(event);
			},
		};
		let lastPushedText: string | undefined;

		lastPushedText = renderStatusTick({
			aliases,
			session,
			lastPushedText,
			now: 1_000,
			cooldowns,
			debugLog,
		});
		lastPushedText = renderStatusTick({
			aliases,
			session,
			lastPushedText,
			now: 1_000,
			cooldowns,
			debugLog,
		});
		nextRetryAt = 1_000;
		lastPushedText = renderStatusTick({
			aliases,
			session,
			lastPushedText,
			now: 1_000,
			cooldowns,
			debugLog,
		});

		assert.equal(lastPushedText, undefined);
		assert.deepEqual(events, ["status-publish", "status-clear"]);
		assert.equal(captured.statuses.length, 3);
		assert.equal(captured.statuses[0], undefined);
		assert.match(captured.statuses[1] ?? "", /model/);
		assert.equal(captured.statuses[2], undefined);
	});
});
