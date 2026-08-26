import { empty, HttpError, json, readJson, requireString } from '../http';
import type { Router } from '../router';
import { listSecretRows, readSecret, saveSecretValues, secretValues } from '../storage/secrets';

export const SECRET_KEYS = [
    'api_key_horde', 'api_key_mancer', 'api_key_vllm', 'api_key_aphrodite', 'api_key_tabby',
    'api_key_openai', 'api_key_novel', 'api_key_claude', 'deepl', 'libre', 'libre_url', 'lingva_url',
    'api_key_openrouter', 'api_key_ai21', 'oneringtranslator_url', 'deeplx_url', 'api_key_makersuite',
    'api_key_vertexai', 'api_key_serpapi', 'api_key_togetherai', 'api_key_mistralai', 'api_key_custom',
    'api_key_ooba', 'api_key_infermaticai', 'api_key_dreamgen', 'api_key_nomicai', 'api_key_koboldcpp',
    'api_key_llamacpp', 'api_key_cohere', 'api_key_perplexity', 'api_key_groq', 'api_key_azure_tts',
    'api_key_featherless', 'api_key_huggingface', 'api_key_stability', 'api_key_custom_openai_tts',
    'api_key_tavily', 'api_key_chutes', 'api_key_electronhub', 'api_key_nanogpt', 'api_key_bfl',
    'api_key_comfy_runpod', 'api_key_falai', 'api_key_generic', 'api_key_deepseek', 'api_key_serper',
    'api_key_aimlapi', 'api_key_xai', 'api_key_fireworks', 'vertexai_service_account_json', 'api_key_minimax',
    'minimax_group_id', 'api_key_moonshot', 'api_key_cometapi', 'api_key_azure_openai', 'api_key_zai',
    'api_key_siliconflow', 'api_key_elevenlabs', 'api_key_pollinations', 'volcengine_app_id',
    'volcengine_access_key', 'api_key_workers_ai',
    'api_key_qdrant', 'api_key_pinecone',
] as const;

const EXPORTABLE_KEYS = new Set(['libre_url', 'lingva_url', 'oneringtranslator_url', 'deeplx_url']);

function secretKey(value: unknown): string {
    const key = requireString(value, 'key', 128);
    if (!/^[a-z0-9_]+$/u.test(key)) throw new HttpError(400, 'Invalid secret key');
    return key;
}

function masked(value: string): string {
    return value.length <= 10 ? '*'.repeat(10) : `${'*'.repeat(7)}${value.slice(-3)}`;
}

export function registerSecretRoutes(router: Router): void {
    router.on('POST', '/api/secrets/write', async ({ request, env }) => {
        const body = await readJson(request, 131_072);
        const key = secretKey(body.key);
        const value = typeof body.value === 'string' ? body.value : undefined;
        if (value === undefined) throw new HttpError(400, 'Invalid secret value');
        const values = await secretValues(env, key);
        for (const item of values) item.active = false;
        const id = crypto.randomUUID();
        values.push({ id, value, label: typeof body.label === 'string' && body.label ? body.label.slice(0, 128) : 'Unlabeled', active: true });
        await saveSecretValues(env, key, values);
        return json({ id });
    });
    router.on('POST', '/api/secrets/read', async ({ env }) => {
        const state: Record<string, unknown> = Object.fromEntries(SECRET_KEYS.map(key => [key, null]));
        for (const row of await listSecretRows(env)) {
            state[row.key] = row.values.map(item => ({ id: item.id, value: masked(item.value), label: item.label, active: item.active }));
        }
        return json(state);
    });
    router.on('POST', '/api/secrets/view', () => json({ error: 'Secret exposure is disabled' }, { status: 403 }));
    router.on('POST', '/api/secrets/find', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const key = secretKey(body.key);
        if (!EXPORTABLE_KEYS.has(key)) throw new HttpError(403, 'Secret exposure is disabled');
        const value = await readSecret(env, key, typeof body.id === 'string' ? body.id : undefined);
        if (!value) throw new HttpError(404, 'Secret not found');
        return json({ value });
    });
    router.on('POST', '/api/secrets/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const key = secretKey(body.key);
        const values = await secretValues(env, key);
        const id = typeof body.id === 'string' ? body.id : undefined;
        const target = values.findIndex(item => id ? item.id === id : item.active);
        if (target >= 0) values.splice(target, 1);
        if (values.length > 0 && !values.some(item => item.active) && values[0]) values[0].active = true;
        await saveSecretValues(env, key, values);
        return empty();
    });
    router.on('POST', '/api/secrets/rotate', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const key = secretKey(body.key);
        const id = requireString(body.id, 'id', 128);
        const values = await secretValues(env, key);
        if (!values.some(item => item.id === id)) throw new HttpError(404, 'Secret not found');
        for (const item of values) item.active = item.id === id;
        await saveSecretValues(env, key, values);
        return empty();
    });
    router.on('POST', '/api/secrets/rename', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const key = secretKey(body.key);
        const id = requireString(body.id, 'id', 128);
        const label = requireString(body.label, 'label', 128);
        const values = await secretValues(env, key);
        const found = values.find(item => item.id === id);
        if (!found) throw new HttpError(404, 'Secret not found');
        found.label = label;
        await saveSecretValues(env, key, values);
        return empty();
    });
    router.on('POST', '/api/secrets/settings', () => json({ allowKeysExposure: false }));
}
