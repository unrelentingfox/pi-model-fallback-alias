import type { ProviderHeaders, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";

export type ResolvedTargetAuth = {
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
};

/**
 * Header names that carry credentials. Pi's model runtime resolves provider
 * auth into request headers (e.g. an OAuth `Authorization: Bearer ...`), and
 * callers echo resolved auth back through options — so caller headers matching
 * this list are stripped before merging, or a credential resolved for one
 * target would ride along to a different provider after failover.
 */
const CREDENTIAL_HEADER_NAMES = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

/**
 * Assemble the per-target request options from the caller's options and the
 * target's own resolved auth. Target auth always wins: the alias provider's
 * delegated credential (see auth-delegate.ts) echoes back through caller
 * options, so the caller's apiKey is dropped entirely, credential headers are
 * stripped from the caller's headers, and caller env/headers only fill gaps
 * the target's auth does not define.
 */
export function requestOptions<T extends StreamOptions | SimpleStreamOptions>(
	options: T | undefined,
	auth: ResolvedTargetAuth,
	signal: AbortSignal | undefined,
): T {
	return {
		...options,
		signal: signal ?? options?.signal,
		apiKey: auth.apiKey,
		headers: mergeHeaders(withoutCredentialHeaders(options?.headers), auth.headers),
		env: { ...options?.env, ...auth.env },
	} as T;
}

function isCredentialHeader(name: string): boolean {
	const lowered = name.toLowerCase();
	return CREDENTIAL_HEADER_NAMES.has(lowered) || lowered.startsWith("anthropic-");
}

function withoutCredentialHeaders(headers: ProviderHeaders | undefined): ProviderHeaders | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers).filter(([name]) => !isCredentialHeader(name));
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function mergeHeaders(
	requestHeaders: ProviderHeaders | undefined,
	authHeaders: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!authHeaders && !requestHeaders) return undefined;
	return { ...requestHeaders, ...authHeaders };
}
