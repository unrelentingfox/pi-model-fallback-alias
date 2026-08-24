export const ALIAS_GATE_API_KEY = "pi-model-alias-gate";

export interface AliasGateAuth {
	auth: { apiKey: string };
	source: string;
}

/**
 * Mark the alias provider as available to registry consumers that require an
 * API key. This fixed value is not a target credential. Alias streaming drops
 * it and resolves the selected target's authentication independently.
 */
export function resolveAliasGate(mapPath: string): AliasGateAuth {
	return {
		auth: { apiKey: ALIAS_GATE_API_KEY },
		source: mapPath,
	};
}

/** Provider auth registration for consumers that require an API key. */
export function createAliasAuth(mapPath: string) {
	return {
		apiKey: {
			name: "Local model alias map",
			async check() { return { source: mapPath, type: "api_key" as const }; },
			async resolve() { return resolveAliasGate(mapPath); },
		},
	};
}
