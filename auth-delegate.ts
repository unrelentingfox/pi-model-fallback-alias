import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { resolveTargetReference, type AliasMap, type TargetRegistry } from "./fallback.ts";

/** Shape returned to pi's provider auth resolver (`ModelAuth` subset — no `env` field exists there). */
export interface DelegatedAuth {
	auth: { apiKey?: string; headers?: ProviderHeaders };
	source: string;
}

export interface DelegateAuthRegistry<Model, Provider> extends TargetRegistry<Model, Provider> {
	getApiKeyAndHeaders(model: Model): Promise<{
		ok: boolean;
		error?: string;
		apiKey?: string;
		headers?: ProviderHeaders;
	}>;
}

export interface DelegateAuthSession<Model, Provider> {
	registry: DelegateAuthRegistry<Model, Provider> | undefined;
	model: { id: string; provider: string } | undefined;
	activeTargets: ReadonlyMap<string, string>;
}

export interface ResolveDelegatedAuthOptions<Model, Provider> {
	aliases: AliasMap;
	session: DelegateAuthSession<Model, Provider>;
	mapPath: string;
}

/**
 * Delegate the alias provider's auth to the first authenticated target in the
 * active role's chain. Auth resolution in pi is provider-scoped (the resolver
 * never sees the model), so the role comes from session state. The returned
 * credential is a gate-pass for registry consumers (e.g. background review
 * extensions that hard-require an apiKey); actual streaming re-resolves
 * per-target auth in alias-stream.ts and never reuses this value.
 *
 * Never throws: unresolvable targets are skipped (same policy as
 * resolveFirstTarget), and when no target yields a key or headers — e.g.
 * env-only AWS_PROFILE providers — the result is today's empty auth.
 */
export async function resolveDelegatedAuth<Model, Provider>(
	options: ResolveDelegatedAuthOptions<Model, Provider>,
): Promise<DelegatedAuth> {
	const { aliases, session, mapPath } = options;
	const empty: DelegatedAuth = { auth: {}, source: mapPath };
	const registry = session.registry;
	if (!registry || aliases.size === 0) return empty;

	const role = session.model?.provider === "alias" && aliases.has(session.model.id)
		? session.model.id
		: aliases.keys().next().value!;
	const chain = aliases.get(role) ?? [];
	const activeTarget = session.activeTargets.get(role);
	const candidates = [...new Set(activeTarget ? [activeTarget, ...chain] : chain)];

	for (const targetRef of candidates) {
		try {
			const target = resolveTargetReference(role, targetRef, registry);
			const auth = await registry.getApiKeyAndHeaders(target.model);
			if (auth.ok === false || (!auth.apiKey && !auth.headers)) continue;
			return {
				auth: {
					...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
					...(auth.headers ? { headers: auth.headers } : {}),
				},
				source: `${mapPath} → ${targetRef}`,
			};
		} catch {
			// Unresolvable target: skip and try the next one.
		}
	}
	return empty;
}
