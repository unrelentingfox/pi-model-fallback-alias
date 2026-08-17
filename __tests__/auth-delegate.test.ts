import assert from "node:assert/strict";
import test from "node:test";
import { resolveDelegatedAuth, type DelegateAuthRegistry } from "../auth-delegate.ts";
import { parseAliasConfig } from "../fallback.ts";

const MAP_PATH = "/tmp/model-alias.json";

type FakeModel = { ref: string };
type FakeProvider = { id: string };
type AuthResult = { ok: boolean; error?: string; apiKey?: string; headers?: Record<string, string> };

function makeRegistry(auths: Record<string, AuthResult>): DelegateAuthRegistry<FakeModel, FakeProvider> {
	const providers = new Set(Object.keys(auths).map((ref) => ref.slice(0, ref.indexOf("/"))));
	return {
		find(providerId, modelId) {
			const ref = `${providerId}/${modelId}`;
			return ref in auths ? { ref } : undefined;
		},
		getProvider(providerId) {
			return providers.has(providerId) ? { id: providerId } : undefined;
		},
		async getApiKeyAndHeaders(model) {
			return auths[model.ref] ?? { ok: false, error: "no auth" };
		},
	};
}

function makeSession(
	registry: DelegateAuthRegistry<FakeModel, FakeProvider> | undefined,
	model?: { id: string; provider: string },
	activeTargets: ReadonlyMap<string, string> = new Map(),
) {
	return { registry, model, activeTargets };
}

function aliasesOf(value: unknown) {
	return parseAliasConfig(value).aliases;
}

test("returns empty auth before a session registry exists", async () => {
	const aliases = aliasesOf({ gpt: "a/one" });
	const result = await resolveDelegatedAuth({ aliases, session: makeSession(undefined), mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: {}, source: MAP_PATH });
});

test("returns empty auth when no aliases are configured", async () => {
	const registry = makeRegistry({ "a/one": { ok: true, apiKey: "KEY-A" } });
	const result = await resolveDelegatedAuth({
		aliases: new Map(),
		session: makeSession(registry, { id: "gpt", provider: "alias" }),
		mapPath: MAP_PATH,
	});
	assert.deepEqual(result, { auth: {}, source: MAP_PATH });
});

test("delegates to the first authenticated target of the session's alias role", async () => {
	const aliases = aliasesOf({ coder: "c/other", gpt: ["a/one", "b/two"] });
	const registry = makeRegistry({
		"c/other": { ok: true, apiKey: "KEY-C" },
		"a/one": { ok: true, apiKey: "KEY-A" },
		"b/two": { ok: true, apiKey: "KEY-B" },
	});
	const session = makeSession(registry, { id: "gpt", provider: "alias" });
	const result = await resolveDelegatedAuth({ aliases, session, mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: { apiKey: "KEY-A" }, source: `${MAP_PATH} → a/one` });
});

test("tries the role's active target before the chain head", async () => {
	const aliases = aliasesOf({ gpt: ["a/one", "b/two"] });
	const registry = makeRegistry({
		"a/one": { ok: true, apiKey: "KEY-A" },
		"b/two": { ok: true, apiKey: "KEY-B" },
	});
	const session = makeSession(registry, { id: "gpt", provider: "alias" }, new Map([["gpt", "b/two"]]));
	const result = await resolveDelegatedAuth({ aliases, session, mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: { apiKey: "KEY-B" }, source: `${MAP_PATH} → b/two` });
});

test("skips env-only targets and returns the first key-based one", async () => {
	const aliases = aliasesOf({ gpt: ["bedrock/env-only", "a/one"] });
	const registry = makeRegistry({
		"bedrock/env-only": { ok: true },
		"a/one": { ok: true, apiKey: "KEY-A" },
	});
	const session = makeSession(registry, { id: "gpt", provider: "alias" });
	const result = await resolveDelegatedAuth({ aliases, session, mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: { apiKey: "KEY-A" }, source: `${MAP_PATH} → a/one` });
});

test("returns headers-only auth when a target has headers but no key", async () => {
	const aliases = aliasesOf({ gpt: "a/one" });
	const registry = makeRegistry({ "a/one": { ok: true, headers: { "x-auth": "token" } } });
	const session = makeSession(registry, { id: "gpt", provider: "alias" });
	const result = await resolveDelegatedAuth({ aliases, session, mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: { headers: { "x-auth": "token" } }, source: `${MAP_PATH} → a/one` });
});

test("returns empty auth when every target is env-only or failing", async () => {
	const aliases = aliasesOf({ gpt: ["bedrock/env-only", "broken/model", "ghost/model"] });
	const registry = makeRegistry({
		"bedrock/env-only": { ok: true },
		"broken/model": { ok: false, error: "no credentials" },
	});
	const session = makeSession(registry, { id: "gpt", provider: "alias" });
	const result = await resolveDelegatedAuth({ aliases, session, mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: {}, source: MAP_PATH });
});

test("falls back to the first alias when the session model is not an alias", async () => {
	const aliases = aliasesOf({ gpt: "a/one", coder: "b/two" });
	const registry = makeRegistry({
		"a/one": { ok: true, apiKey: "KEY-A" },
		"b/two": { ok: true, apiKey: "KEY-B" },
	});
	const session = makeSession(registry, { id: "gpt-4", provider: "openai" });
	const result = await resolveDelegatedAuth({ aliases, session, mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: { apiKey: "KEY-A" }, source: `${MAP_PATH} → a/one` });
});

test("resolves through a nested alias chain expanded at parse time", async () => {
	const aliases = aliasesOf({ reviewer: ["alias/opus", "m/sol"], opus: ["a/op1", "a/op2"] });
	const registry = makeRegistry({
		"a/op1": { ok: true, apiKey: "KEY-OP1" },
		"a/op2": { ok: true, apiKey: "KEY-OP2" },
		"m/sol": { ok: true, apiKey: "KEY-SOL" },
	});
	const session = makeSession(registry, { id: "reviewer", provider: "alias" });
	const result = await resolveDelegatedAuth({ aliases, session, mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: { apiKey: "KEY-OP1" }, source: `${MAP_PATH} → a/op1` });
});

test("skips targets the registry cannot resolve without throwing", async () => {
	const aliases = aliasesOf({ gpt: ["ghost/model", "a/one"] });
	const registry = makeRegistry({ "a/one": { ok: true, apiKey: "KEY-A" } });
	const session = makeSession(registry, { id: "gpt", provider: "alias" });
	const result = await resolveDelegatedAuth({ aliases, session, mapPath: MAP_PATH });
	assert.deepEqual(result, { auth: { apiKey: "KEY-A" }, source: `${MAP_PATH} → a/one` });
});
