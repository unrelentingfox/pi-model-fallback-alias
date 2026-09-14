import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ALIAS_API_ID } from "./api-registration.ts";
import {
	describeFailure,
	resolveFirstTarget,
	type AliasMap,
} from "../fallback/index.ts";

const PLACEHOLDER_CONTEXT_WINDOW = 1_000_000;
const PLACEHOLDER_MAX_TOKENS = 262_144;

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

type Registry = ExtensionContext["modelRegistry"];

export function aliasModel(id: string, providerId: string): Model<Api> {
	return {
		id,
		name: id,
		api: ALIAS_API_ID,
		provider: providerId,
		baseUrl: "https://pi-model-alias.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: PLACEHOLDER_CONTEXT_WINDOW,
		maxTokens: PLACEHOLDER_MAX_TOKENS,
	};
}

export function initializeAliasMetadata(aliases: AliasMap, aliasModels: Model<Api>[], registry: Registry): void {
	for (const aliasModel of aliasModels) {
		try {
			const target = resolveFirstTarget(aliasModel.id, targetsFor(aliasModel, aliases), registry);
			mirrorTargetMetadata(aliasModel, aliasModels, target.model);
		} catch (error) {
			console.warn(
				`[pi-model-alias] Metadata initialization failed; will retry at stream time: ${describeFailure(error)}`,
			);
		}
	}
}

export function targetsFor(aliasModel: Model<Api>, aliases: AliasMap): readonly string[] {
	const targets = aliases.get(aliasModel.id);
	if (!targets) throw new Error(`Unknown model alias "${aliasModel.id}"`);
	return targets;
}

export function mirrorTargetMetadata(aliasModel: Model<Api>, aliasModels: Model<Api>[], targetModel: Model<Api>): void {
	// Concurrent requests use last-writer-wins display metadata; streamed usage remains target-specific.
	const registeredModel = aliasModels.find((model) => model.id === aliasModel.id);
	for (const model of new Set([aliasModel, registeredModel].filter((item): item is Model<Api> => item !== undefined))) {
		model.contextWindow = targetModel.contextWindow;
		model.cost = targetModel.cost;
		model.maxTokens = targetModel.maxTokens;
		model.reasoning = targetModel.reasoning;
		model.input = targetModel.input;
		model.thinkingLevelMap = targetModel.thinkingLevelMap;
	}
}
