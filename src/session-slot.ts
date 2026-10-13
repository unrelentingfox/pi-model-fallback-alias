import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AliasRegistry = ExtensionContext["modelRegistry"];

/**
 * The fallback session state every copy of this extension shares in one process.
 *
 * Pi runs more than one copy of this extension in a single process: a subagent
 * session binds extensions again, and a copy whose agent restricts
 * `extensions:` is loaded but never bound, so it never receives `session_start`.
 * Every copy re-registers the process-wide `alias` provider, so the streams
 * serving the process may belong to a copy that has neither a registry nor a
 * UI of its own.
 *
 * A bound copy always streams through its own registry. The slot only serves
 * copies that were never bound, so they stay usable instead of failing every
 * alias call. It holds the registry of the interactive session when there is
 * one: a headless session never replaces it.
 */
export interface AliasSessionSlot {
	registry: AliasRegistry | undefined;
	/**
	 * True once any copy in this process received a UI session. Every copy then
	 * keeps warnings off stderr, where a live TUI would draw over them.
	 */
	hasUI: boolean;
}

const SLOT_KEY = Symbol.for("pi-model-fallback-alias.session-slot");

/** The slot shared by every copy of the extension in this process. */
export function aliasSessionSlot(): AliasSessionSlot {
	const store = globalThis as { [SLOT_KEY]?: AliasSessionSlot };
	return (store[SLOT_KEY] ??= { registry: undefined, hasUI: false });
}
