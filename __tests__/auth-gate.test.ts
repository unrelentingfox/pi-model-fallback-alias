import assert from "node:assert/strict";
import test from "node:test";
import { ALIAS_GATE_API_KEY, createAliasAuth } from "../src/alias/auth-gate.ts";

const MAP_PATH = "/tmp/model-alias.json";

test("provider auth registration identifies the local alias map and returns the fixed gate", async () => {
	const auth = createAliasAuth(MAP_PATH);

	assert.deepEqual(await auth.apiKey.check(), {
		source: MAP_PATH,
		type: "api_key",
	});
	assert.deepEqual(await auth.apiKey.resolve(), {
		auth: { apiKey: ALIAS_GATE_API_KEY },
		source: MAP_PATH,
	});
});
