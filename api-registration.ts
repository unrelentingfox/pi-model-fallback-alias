export const ALIAS_API_ID = "alias-delegate";
export const API_REGISTRY_SOURCE_ID = "pi-model-alias";
export const API_REGISTRY_UNAVAILABLE_WARNING =
	"pi-model-alias: pi-ai compat api registry unavailable; direct-dispatch consumers (e.g. context-prune) will not resolve alias models";

interface ApiRegistrar<TStreams extends object> {
	registerApiProvider(provider: TStreams & { api: typeof ALIAS_API_ID }, sourceId?: string): void;
	unregisterApiProviders(sourceId: string): void;
}

interface RegistrationOptions<TStreams extends object> {
	importRegistrar?: () => Promise<ApiRegistrar<TStreams>>;
	warn?: (message: string) => void;
}

export async function registerAliasApiProvider<TStreams extends object>(
	streams: TStreams,
	options: RegistrationOptions<TStreams> = {},
): Promise<void> {
	try {
		const registrar = options.importRegistrar
			? await options.importRegistrar()
			: ((await import("@earendil-works/pi-ai/compat")) as unknown as ApiRegistrar<TStreams>);
		registrar.unregisterApiProviders(API_REGISTRY_SOURCE_ID);
		registrar.registerApiProvider({ api: ALIAS_API_ID, ...streams }, API_REGISTRY_SOURCE_ID);
	} catch {
		(options.warn ?? console.warn)(API_REGISTRY_UNAVAILABLE_WARNING);
	}
}
