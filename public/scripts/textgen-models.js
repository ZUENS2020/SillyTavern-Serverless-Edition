/**
 * Compatibility surface for upstream modules that still import provider model-list helpers.
 * Model discovery belongs to Cloudflare AI Gateway capability profiles, so every legacy
 * loader is intentionally inert and no browser request can reach a Provider endpoint.
 */

export const openRouterModels = [];

const emptyAsync = async () => undefined;
const empty = () => undefined;

export const updateOpenRouterProvidersWarning = empty;
export const syncOpenRouterProvidersForModel = emptyAsync;
export const syncNanoGptProvidersForModel = emptyAsync;
export const updateNanoGptProvidersWarning = empty;
export const loadOllamaModels = emptyAsync;
export const loadTabbyModels = emptyAsync;
export const loadLlamaCppModels = emptyAsync;
export const loadTogetherAIModels = emptyAsync;
export const loadInfermaticAIModels = emptyAsync;
export const loadGenericModels = empty;
export const loadDreamGenModels = emptyAsync;
export const loadMancerModels = emptyAsync;
export const loadOpenRouterModels = emptyAsync;
export const loadVllmModels = emptyAsync;
export const loadAphroditeModels = emptyAsync;
export const loadFeatherlessModels = emptyAsync;

export function getCurrentOpenRouterModelTokenizer() {
    return 0;
}

export function getCurrentDreamGenModelTokenizer() {
    return 0;
}

export function initTextGenModels() {
    // No Provider model selector exists in the single-Worker UI.
}
