import assert from "node:assert/strict";
import test from "node:test";
import {
	appendPolicyWarningEntry,
	appendSettingWarningEntry,
	formatPolicyWarning,
	formatSettingWarning,
	POLICY_WARNING_ENTRY,
	SETTING_WARNING_ENTRY,
} from "../src/status/transcript.ts";

const warning = { role: "gpt", reason: "Unexpected end of JSON input" };

test("formats a durable policy warning without config values", () => {
	assert.equal(
		formatPolicyWarning(warning),
		'Alias "gpt" is using its last valid policy because the current config could not load: Unexpected end of JSON input',
	);
});

test("appends the policy warning as a durable custom entry", () => {
	const entries: Array<{ type: string; data: unknown }> = [];
	const events: string[] = [];
	appendPolicyWarningEntry(
		{ appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as never,
		warning,
		{ log: (event) => events.push(event) },
	);

	assert.deepEqual(entries, [{ type: POLICY_WARNING_ENTRY, data: warning }]);
	assert.deepEqual(events, []);
});

test("formats and appends a durable setting warning", () => {
	const settingWarning = {
		setting: "$settings.statusRefreshMs",
		reason: "expected an integer from 1 to 60000; using 2000ms",
	};
	const entries: Array<{ type: string; data: unknown }> = [];
	assert.equal(
		formatSettingWarning(settingWarning),
		"Invalid $settings.statusRefreshMs: expected an integer from 1 to 60000; using 2000ms",
	);
	appendSettingWarningEntry(
		{ appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as never,
		settingWarning,
		{ log: () => undefined },
	);
	assert.deepEqual(entries, [{ type: SETTING_WARNING_ENTRY, data: settingWarning }]);
});

test("logs append failures without interrupting policy fallback", () => {
	const events: string[] = [];
	appendPolicyWarningEntry(
		{ appendEntry: () => { throw new Error("entry store unavailable"); } } as never,
		warning,
		{ log: (event) => events.push(event) },
	);

	assert.deepEqual(events, ["append-entry-error"]);
});
