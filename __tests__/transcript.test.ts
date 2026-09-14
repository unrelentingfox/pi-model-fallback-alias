import assert from "node:assert/strict";
import test from "node:test";
import {
	ALIAS_TARGETS_ENTRY,
	appendAliasTargetsEntry,
	appendPolicyWarningEntry,
	appendSettingWarningEntry,
	createAliasTargetsEntry,
	formatAliasTargetsEntry,
	formatPolicyWarning,
	formatSettingWarning,
	POLICY_WARNING_ENTRY,
	SETTING_WARNING_ENTRY,
} from "../src/status/transcript.ts";

const warning = { role: "gpt", reason: "Unexpected end of JSON input" };

test("formats all flattened alias chains", () => {
	const data = createAliasTargetsEntry(new Map([
		["coder", ["provider/one", "provider/two"]],
		["empty", []],
	]));

	assert.equal(
		formatAliasTargetsEntry(data),
		"coder:\n  - provider/one\n  - provider/two\n\nempty:\n  (empty)",
	);
});

test("formats a selected flattened alias chain", () => {
	const aliases = new Map([["coder", ["provider/one"]]]);
	assert.deepEqual(createAliasTargetsEntry(aliases, "coder"), {
		role: "coder",
		chains: [{ role: "coder", targets: ["provider/one"] }],
	});
	assert.equal(formatAliasTargetsEntry(createAliasTargetsEntry(aliases, "missing")), 'Unknown alias "missing"');
});

test("appends flattened chains as a durable custom entry", () => {
	const entries: Array<{ type: string; data: unknown }> = [];
	const data = createAliasTargetsEntry(new Map([["coder", ["provider/one"]]]));
	appendAliasTargetsEntry(
		{ appendEntry: (type: string, entryData: unknown) => entries.push({ type, data: entryData }) } as never,
		data,
	);

	assert.deepEqual(entries, [{ type: ALIAS_TARGETS_ENTRY, data }]);
});

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
