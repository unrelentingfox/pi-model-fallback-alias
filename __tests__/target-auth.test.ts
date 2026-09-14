import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuthenticatedTarget, type TargetAuthRegistry } from "../src/stream/target-auth.ts";

type FakeModel = { ref: string };
type FakeProvider = { id: string };

const TARGET_PROFILE = "target-profile";

function registry(authOk = true): TargetAuthRegistry<FakeModel, FakeProvider> {
	return {
		find(providerId, modelId) {
			return providerId === "target" && modelId === "model" ? { ref: "target/model" } : undefined;
		},
		getProvider(providerId) {
			return providerId === "target" ? { id: providerId } : undefined;
		},
		async getApiKeyAndHeaders() {
			return authOk
				? { ok: true, env: { AWS_PROFILE: TARGET_PROFILE } }
				: { ok: false, error: "missing target credentials" };
		},
	};
}

test("resolves requested target auth without top-level model state", async () => {
	const target = await resolveAuthenticatedTarget("gpt-low", "target/model", registry());

	assert.equal(target.model.ref, "target/model");
	assert.equal(target.provider.id, "target");
	assert.deepEqual(target.auth, { ok: true, env: { AWS_PROFILE: TARGET_PROFILE } });
});

test("reports the requested alias and target when target auth fails", async () => {
	await assert.rejects(
		resolveAuthenticatedTarget("gpt-low", "target/model", registry(false)),
		/Model alias "gpt-low" target "target\/model" is unavailable: missing target credentials/,
	);
});
