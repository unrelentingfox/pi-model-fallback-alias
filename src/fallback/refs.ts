import type { ResolvedTarget, TargetFailure, TargetRegistry } from "./types.ts";

export function describeFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isModelRef(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

export function splitModelRef(value: string): [string, string] {
	const slash = value.indexOf("/");
	return [value.slice(0, slash), value.slice(slash + 1)];
}

export function resolveTargetReference<Model, Provider>(
	aliasId: string,
	targetRef: string,
	registry: TargetRegistry<Model, Provider>,
): ResolvedTarget<Model, Provider> {
	const [providerId, modelId] = splitModelRef(targetRef);
	if (providerId === "alias") {
		throw new Error(`Model alias "${aliasId}" cannot target another alias: "${targetRef}"`);
	}

	const model = registry.find(providerId, modelId);
	const provider = registry.getProvider(providerId);
	if (!model || !provider) {
		throw new Error(`Model alias "${aliasId}" targets unknown model "${targetRef}"`);
	}
	return { ref: targetRef, model, provider };
}

export function resolveFirstTarget<Model, Provider>(
	aliasId: string,
	targets: readonly string[],
	registry: TargetRegistry<Model, Provider>,
): ResolvedTarget<Model, Provider> {
	const failures: TargetFailure[] = [];
	for (const target of targets) {
		try {
			return resolveTargetReference(aliasId, target, registry);
		} catch (error) {
			failures.push({ target, reason: describeFailure(error) });
		}
	}
	throw new Error(formatExhaustionError(aliasId, failures));
}

export function formatExhaustionError(role: string, failures: readonly TargetFailure[]): string {
	const details = failures
		.map(({ target, reason, retriedFromCooldown }) => {
			const retryNote = retriedFromCooldown ? " (retried from cooldown)" : "";
			return `- ${target}${retryNote}: ${reason}`;
		})
		.join("\n");
	return `Model alias "${role}" failed all targets:\n${details}`;
}

export function failureStopReason(
	error: unknown,
	signal?: Pick<AbortSignal, "aborted">,
): "error" | "aborted" {
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
	return /\babort(?:ed)?\b/iu.test(describeFailure(error)) ? "aborted" : "error";
}
