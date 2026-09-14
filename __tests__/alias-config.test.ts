import assert from "node:assert/strict";
import test from "node:test";
import { createPolicyLoader, readAliasConfig } from "../src/alias-config.ts";
import {
	BUILT_IN_COOLDOWN_POLICY,
	DEFAULT_STATUS_REFRESH_MS,
	MAX_STATUS_REFRESH_MS,
	parseAliasConfig,
	type AliasConfig,
} from "../src/fallback/index.ts";

const PATH = "/fake/model-alias.json";

function configText(resetSuccesses: number, targets: readonly string[] = ["provider/first"]): string {
	return JSON.stringify({
		$defaults: { cooldown: { resetSuccesses } },
		coder: { targets: [...targets] },
	});
}

/** Injected reader standing in for the shared config file. */
class FakeConfigFile {
	contents: string | Error;
	reads = 0;

	constructor(contents: string | Error) {
		this.contents = contents;
	}

	read = (path: string): string => {
		assert.equal(path, PATH);
		this.reads++;
		if (this.contents instanceof Error) throw this.contents;
		return this.contents;
	};
}

function loaderFor(
	file: FakeConfigFile,
	initial: AliasConfig,
	warnings: Array<{ role: string; reason: string }>,
	events: string[] = [],
) {
	return createPolicyLoader({
		debugLog: { log: (event) => events.push(event) },
		initial,
		path: PATH,
		readConfig: file.read,
		onWarning: (warning) => warnings.push(warning),
	});
}

test("parses the extension-wide status refresh setting with a two-second default", () => {
	assert.equal(parseAliasConfig({ coder: "provider/model" }).statusRefreshMs, DEFAULT_STATUS_REFRESH_MS);
	assert.equal(
		parseAliasConfig({ $settings: { statusRefreshMs: MAX_STATUS_REFRESH_MS }, coder: "provider/model" }).statusRefreshMs,
		MAX_STATUS_REFRESH_MS,
	);
});

test("warns and uses the default for invalid extension settings", () => {
	const invalidValues = [0, -1, 1.5, Number.NaN, "2000", MAX_STATUS_REFRESH_MS + 1];
	for (const statusRefreshMs of invalidValues) {
		const config = parseAliasConfig({ $settings: { statusRefreshMs }, coder: "provider/model" });
		assert.equal(config.statusRefreshMs, DEFAULT_STATUS_REFRESH_MS);
		assert.equal(config.aliases.get("coder")?.[0], "provider/model");
		assert.deepEqual(config.settingWarnings, [{
			setting: "$settings.statusRefreshMs",
			reason: `expected an integer from 1 to ${MAX_STATUS_REFRESH_MS}; using ${DEFAULT_STATUS_REFRESH_MS}ms`,
		}]);
	}

	const unknown = parseAliasConfig({ $settings: { unknown: true }, coder: "provider/model" });
	assert.equal(unknown.statusRefreshMs, DEFAULT_STATUS_REFRESH_MS);
	assert.deepEqual(unknown.settingWarnings, [{
		setting: "$settings",
		reason: `unknown setting(s): unknown; using ${DEFAULT_STATUS_REFRESH_MS}ms`,
	}]);
});

test("ignores top-level metadata keys prefixed with a dollar sign", () => {
	const config = parseAliasConfig({
		$comment: "local notes",
		$metadata: { owner: "team" },
		coder: "provider/model",
	});

	assert.deepEqual([...config.aliases], [["coder", ["provider/model"]]]);
});

test("resolves the current policy on every stream without reloading the extension", () => {
	const file = new FakeConfigFile(configText(3));
	const initial = readAliasConfig(PATH, file.read);
	const warnings: Array<{ role: string; reason: string }> = [];
	const policyFor = loaderFor(file, initial, warnings);

	assert.equal(policyFor("coder").policy.cooldown.resetSuccesses, 3);

	file.contents = configText(7);
	const reloaded = policyFor("coder");

	assert.equal(reloaded.policy.cooldown.resetSuccesses, 7);
	assert.equal(reloaded.degraded, false);
	assert.deepEqual(warnings, []);
	assert.ok(file.reads > 1, "each stream re-reads the shared file");
});

test("ignores target edits until the extension reloads", () => {
	const file = new FakeConfigFile(configText(1, ["provider/first"]));
	const initial = readAliasConfig(PATH, file.read);
	const policyFor = loaderFor(file, initial, []);

	file.contents = configText(1, ["provider/second"]);
	policyFor("coder");

	// Registered chains come from startup; only policy follows the file.
	assert.deepEqual(initial.aliases.get("coder"), ["provider/first"]);
});

test("reports a load cost for every resolution", () => {
	const file = new FakeConfigFile(configText(2));
	const initial = readAliasConfig(PATH, file.read);
	let clock = 0;
	const policyFor = createPolicyLoader({
		debugLog: { log: () => undefined },
		initial,
		path: PATH,
		readConfig: file.read,
		now: () => (clock += 0.5),
		onWarning: () => undefined,
	});

	assert.equal(policyFor("coder").configLoadMs, 0.5);
});

test("keeps the last valid policy when the current file cannot be used", () => {
	const cases: Array<{ name: string; broken: string | Error }> = [
		{ name: "unreadable", broken: new Error("ENOENT: no such file") },
		{ name: "malformed", broken: "{not json" },
		{ name: "partially written", broken: '{"$defaults": {"cooldown": {"resetSuc' },
		{ name: "invalid values", broken: JSON.stringify({ $defaults: { cooldown: { baseMs: 0 } }, coder: "provider/first" }) },
		{ name: "removed alias", broken: JSON.stringify({ other: "provider/first" }) },
	];

	for (const { name, broken } of cases) {
		const file = new FakeConfigFile(configText(4));
		const initial = readAliasConfig(PATH, file.read);
		const warnings: Array<{ role: string; reason: string }> = [];
		const events: string[] = [];
		const policyFor = loaderFor(file, initial, warnings, events);

		file.contents = broken;
		const load = policyFor("coder");

		assert.equal(load.policy.cooldown.resetSuccesses, 4, name);
		assert.equal(load.degraded, true, name);
		assert.equal(warnings.length, 1, name);
		assert.equal(warnings[0]?.role, "coder");
		assert.ok((warnings[0]?.reason.length ?? 0) > 0);
		assert.ok(events.includes("alias-policy-stale"), name);
	}
});

test("warns once for a persistent bad file and notes recovery", () => {
	const file = new FakeConfigFile(configText(2));
	const initial = readAliasConfig(PATH, file.read);
	const warnings: Array<{ role: string; reason: string }> = [];
	const events: string[] = [];
	const policyFor = loaderFor(file, initial, warnings, events);

	file.contents = "{not json";
	policyFor("coder");
	policyFor("coder");
	policyFor("coder");
	assert.equal(warnings.length, 1, "one persistent failure must not warn per stream");

	file.contents = configText(9);
	assert.equal(policyFor("coder").policy.cooldown.resetSuccesses, 9);
	assert.ok(events.includes("alias-policy-recovered"));

	file.contents = "{not json";
	policyFor("coder");
	assert.equal(warnings.length, 2, "a failure after recovery warns again");
});

test("warns once per alias when one bad file degrades several", () => {
	const file = new FakeConfigFile(JSON.stringify({ first: "provider/a", second: "provider/b" }));
	const initial = readAliasConfig(PATH, file.read);
	const warnings: Array<{ role: string; reason: string }> = [];
	const events: string[] = [];
	const policyFor = loaderFor(file, initial, warnings, events);

	file.contents = "{not json";
	for (let round = 0; round < 3; round++) {
		policyFor("first");
		policyFor("second");
	}

	assert.equal(warnings.length, 2);
	assert.equal(events.filter((event) => event === "alias-policy-stale").length, 6);
});

test("keeps one alias degraded while another resolves", () => {
	const file = new FakeConfigFile(JSON.stringify({ kept: "provider/a", dropped: "provider/b" }));
	const initial = readAliasConfig(PATH, file.read);
	const warnings: Array<{ role: string; reason: string }> = [];
	const events: string[] = [];
	const policyFor = loaderFor(file, initial, warnings, events);

	file.contents = JSON.stringify({ kept: "provider/a" });
	for (let round = 0; round < 4; round++) {
		assert.equal(policyFor("dropped").degraded, true);
		assert.equal(policyFor("kept").degraded, false);
	}

	assert.equal(warnings.length, 1);
	assert.deepEqual(events.filter((event) => event === "alias-policy-recovered"), []);
});

test("falls back to built-in policy when no valid config was ever loaded", () => {
	const file = new FakeConfigFile(new Error("ENOENT: no such file"));
	const warnings: Array<{ role: string; reason: string }> = [];
	const policyFor = loaderFor(file, parseAliasConfig({}), warnings);

	const load = policyFor("coder");

	assert.deepEqual(load.policy.cooldown, BUILT_IN_COOLDOWN_POLICY);
	assert.equal(load.degraded, true);
});

test("gives concurrent sessions one policy while valid and separate caches while broken", () => {
	const file = new FakeConfigFile(configText(2));
	const initial = readAliasConfig(PATH, file.read);
	const first = loaderFor(file, initial, []);
	const second = loaderFor(file, initial, []);

	file.contents = configText(6);
	assert.equal(first("coder").policy.cooldown.resetSuccesses, 6);
	assert.equal(second("coder").policy.cooldown.resetSuccesses, 6);

	// Each process caches its own last valid generation, so a broken file can
	// leave sessions on different policies until it parses again.
	file.contents = configText(8);
	assert.equal(first("coder").policy.cooldown.resetSuccesses, 8);
	file.contents = "{not json";
	const degradedFirst = first("coder");
	const degradedSecond = second("coder");

	assert.equal(degradedFirst.policy.cooldown.resetSuccesses, 8);
	assert.equal(degradedSecond.policy.cooldown.resetSuccesses, 6);
	assert.equal(degradedFirst.degraded, true);
	assert.equal(degradedSecond.degraded, true);
});
