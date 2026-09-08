import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { resolveStateDir, STATE_DIR_ENV } from "../state-paths.ts";

describe("resolveStateDir", () => {
	it("stores state below the Pi agent directory by default", () => {
		assert.equal(resolveStateDir({}, "/agent"), resolve("/agent/state/pi-model-fallback-alias"));
	});

	it("uses the configured state directory", () => {
		assert.equal(resolveStateDir({ [STATE_DIR_ENV]: "/tmp/alias-state" }, "/agent"), resolve("/tmp/alias-state"));
	});

	it("ignores an empty state directory override", () => {
		assert.equal(resolveStateDir({ [STATE_DIR_ENV]: "  " }, "/agent"), resolve("/agent/state/pi-model-fallback-alias"));
	});
});
