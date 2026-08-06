import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	renderStatusTick,
	startSession,
	type AliasSession,
	type AliasSessionContext,
} from "../session-status.ts";

const NOOP_DEBUG_LOG = { log() {} };

function createUi() {
	const statuses: Array<string | undefined> = [];
	const ui = {
		setStatus(_key: string, value: string | undefined) {
			statuses.push(value);
		},
		theme: {
			fg(_color: string, text: string) {
				return text;
			},
		},
	};
	return { ui, statuses };
}

function createSession(): AliasSession {
	return { registry: undefined, ui: undefined, hasUI: false };
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
