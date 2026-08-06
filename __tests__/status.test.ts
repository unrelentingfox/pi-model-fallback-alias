import assert from "node:assert/strict";
import test from "node:test";
import { formatCooldownStatus, formatDuration, formatFailoverWarning, shortModelLabel } from "../status.ts";

const modelLabelExamples = [
	["amazon-bedrock/model-primary", "opus-4-8"],
	["amazon-bedrock/us.anthropic.model-premium", "fable-5"],
	["amazon-bedrock/model-legacy", "opus-4-6-v1"],
	["provider-example/model-primary", "gpt-5.6-sol"],
	["baseten/moonshotai/Kimi-K3", "Kimi-K3"],
] as const;

for (const [targetRef, expected] of modelLabelExamples) {
	test(`shortens ${targetRef}`, () => {
		assert.equal(shortModelLabel(targetRef), expected);
	});
}

test("leaves an unprefixed model segment unchanged", () => {
	assert.equal(shortModelLabel("provider/custom-model"), "custom-model");
});

test("defaults a missing model label to unknown", () => {
	assert.equal(shortModelLabel(undefined), "unknown");
});

test("omits cooldown status when no targets are cooling", () => {
	assert.equal(formatCooldownStatus([]), undefined);
});

test("formats one cooling target", () => {
	assert.equal(
		formatCooldownStatus([
			{
				targetRef: "amazon-bedrock/global.anthropic.model-premium",
				remainingMs: 28_000,
			},
		]),
		"cooldown: fable-5 28s",
	);
});

test("formats cooling targets in declared order", () => {
	assert.equal(
		formatCooldownStatus([
			{
				targetRef: "amazon-bedrock/global.anthropic.model-premium",
				remainingMs: 28_000,
			},
			{
				targetRef: "amazon-bedrock/global.anthropic.claude-opus-5",
				remainingMs: 240_000,
			},
		]),
		"cooldown: fable-5 28s, opus-5 4m",
	);
});

test("formats a failover warning with the next target", () => {
	assert.equal(
		formatFailoverWarning({
			role: "fable-opus-fallback",
			failedTarget: "amazon-bedrock/global.anthropic.model-premium",
			reason: "throttled",
			nextTarget: "amazon-bedrock/global.anthropic.claude-opus-5",
			cooldownMs: 30_000,
			failCount: 1,
		}),
		'alias "fable-opus-fallback": fable-5 failed (throttled); falling back to opus-5 — cooldown 30s (failure 1)',
	);
});

test("formats a failover warning with missing persisted fields", () => {
	assert.equal(
		formatFailoverWarning({}),
		'alias "unknown": unknown failed (); chain exhausted — cooldown 0s (failure 0)',
	);
});

test("formats a failover warning when the chain is exhausted", () => {
	assert.equal(
		formatFailoverWarning({
			role: "fable-opus-fallback",
			failedTarget: "amazon-bedrock/global.anthropic.claude-opus-5",
			reason: "unavailable",
			cooldownMs: 120_000,
			failCount: 2,
		}),
		'alias "fable-opus-fallback": opus-5 failed (unavailable); chain exhausted — cooldown 2m (failure 2)',
	);
});

test("formats durations in seconds below one minute", () => {
	assert.equal(formatDuration(30_000), "30s");
});

test("formats values that round to sixty seconds in minutes", () => {
	assert.equal(formatDuration(59_999), "1m");
});

test("defaults invalid or missing durations to zero seconds", () => {
	assert.equal(formatDuration(Number.NaN), "0s");
	assert.equal(formatDuration(undefined), "0s");
});

test("formats durations in minutes from one minute", () => {
	assert.equal(formatDuration(120_000), "2m");
});
