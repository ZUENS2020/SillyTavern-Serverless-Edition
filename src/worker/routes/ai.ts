import { HttpError, json, maxJsonBytes, readJson, requireString } from '../http';
import type { RouteContext, Router } from '../router';

type JsonObject = Record<string, unknown>;

export const AI_CAPABILITIES = [
    'chat',
    'text',
    'embedding',
    'web-search',
    'caption',
    'classification',
    'image',
    'tts',
    'stt',
    'translation',
    'reasoning',
    'tools',
    'structured-output',
] as const;

export type AICapability = typeof AI_CAPABILITIES[number];

interface CapabilityRow {
    capability: AICapability;
    model_id: string;
    enabled: number;
    declarations_json: string;
    updated_at: number;
}

export interface CapabilityProfile {
    capability: AICapability;
    modelId: string;
    enabled: boolean;
    declarations: JsonObject;
    updatedAt: number;
    fixed?: boolean;
}

interface DynamicAiBinding {
    run(
        model: string,
        payload: JsonObject,
        options: {
            gateway: {
                id: string;
                collectLog: boolean;
                skipCache: boolean;
                requestTimeoutMs: number;
                retries: { maxAttempts: 1 | 2 };
                metadata: Record<string, string>;
            };
            returnRawResponse: true;
            signal: AbortSignal;
        },
    ): Promise<Response>;
}

function objectValue(value: unknown): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Expected an object');
    return value as JsonObject;
}

function capability(value: unknown): AICapability {
    const candidate = requireString(value, 'capability', 64);
    if (!AI_CAPABILITIES.includes(candidate as AICapability)) throw new HttpError(404, 'Unknown AI capability');
    return candidate as AICapability;
}

function modelId(value: unknown): string {
    const model = requireString(value, 'modelId', 256).trim();
    if (!/^[a-zA-Z0-9@._:/+-]+$/u.test(model)) throw new HttpError(400, 'Invalid Gateway model ID');
    return model;
}

function decodeProfile(row: CapabilityRow): CapabilityProfile {
    let declarations: JsonObject = {};
    try {
        declarations = objectValue(JSON.parse(row.declarations_json) as unknown);
    } catch {
        // A damaged optional declaration must not expose or change the model selection.
    }
    return {
        capability: row.capability,
        modelId: row.model_id,
        enabled: row.enabled === 1,
        declarations,
        updatedAt: row.updated_at,
    };
}

function embeddingProfile(env: Env): CapabilityProfile {
    return {
        capability: 'embedding',
        modelId: env.EMBEDDING_MODEL,
        enabled: true,
        declarations: { dimensions: 1024, metric: 'cosine', schemaVersion: Number(env.EMBEDDING_SCHEMA_VERSION) },
        updatedAt: 0,
        fixed: true,
    };
}

export async function getCapabilityProfile(env: Env, name: AICapability): Promise<CapabilityProfile> {
    if (name === 'embedding') return embeddingProfile(env);
    const row = await env.DB.prepare(`
        SELECT capability, model_id, enabled, declarations_json, updated_at
        FROM ai_capability_profiles WHERE capability = ?
    `).bind(name).first<CapabilityRow>();
    return row ? decodeProfile(row) : {
        capability: name,
        modelId: '',
        enabled: false,
        declarations: {},
        updatedAt: 0,
    };
}

async function listCapabilityProfiles(env: Env): Promise<CapabilityProfile[]> {
    const result = await env.DB.prepare(`
        SELECT capability, model_id, enabled, declarations_json, updated_at FROM ai_capability_profiles
    `).all<CapabilityRow>();
    const saved = new Map(result.results.map(row => [row.capability, decodeProfile(row)]));
    return AI_CAPABILITIES.map(name => name === 'embedding'
        ? embeddingProfile(env)
        : saved.get(name) ?? { capability: name, modelId: '', enabled: false, declarations: {}, updatedAt: 0 });
}

async function saveProfile(env: Env, name: AICapability, body: JsonObject): Promise<CapabilityProfile> {
    if (name === 'embedding') {
        if (body.modelId !== undefined && body.modelId !== env.EMBEDDING_MODEL) {
            throw new HttpError(409, 'The embedding model is fixed by the active Vectorize schema');
        }
        return embeddingProfile(env);
    }
    const model = modelId(body.modelId);
    const enabled = body.enabled !== false;
    const declarations = body.declarations === undefined ? {} : objectValue(body.declarations);
    const encoded = JSON.stringify(declarations);
    if (encoded.length > 16_384) throw new HttpError(413, 'Capability declarations are too large');
    const now = Date.now();
    await env.DB.prepare(`
        INSERT INTO ai_capability_profiles(capability, model_id, enabled, declarations_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(capability) DO UPDATE SET model_id = excluded.model_id, enabled = excluded.enabled,
            declarations_json = excluded.declarations_json, updated_at = excluded.updated_at
    `).bind(name, model, enabled ? 1 : 0, encoded, now).run();
    await env.CACHE.delete('ai:capabilities');
    return { capability: name, modelId: model, enabled, declarations, updatedAt: now };
}

function notConfigured(name: AICapability): Response {
    return json({
        error: {
            code: 'CAPABILITY_NOT_CONFIGURED',
            message: `AI capability ${name} has no enabled Gateway model`,
        },
    }, { status: 422 });
}

const BLOCKED_CONNECTION_FIELDS = new Set([
    'model', 'provider', 'endpoint', 'url', 'api_url', 'api_key', 'token', 'secret',
    'headers', 'authorization', 'reverse_proxy', 'proxy_password', 'server_url',
]);

function boundedNumber(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        throw new HttpError(400, `${field} is outside the allowed range`);
    }
    return parsed;
}

function validateMessages(value: unknown): void {
    if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
        throw new HttpError(400, 'messages must contain between 1 and 512 entries');
    }
    for (const raw of value) {
        const message = objectValue(raw);
        if (typeof message.role !== 'string' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
            throw new HttpError(400, 'messages[].role is invalid');
        }
        if (typeof message.content === 'string') {
            if (message.content.length > 131_072) throw new HttpError(413, 'A message is too large');
        } else if (!Array.isArray(message.content) && message.content !== null) {
            throw new HttpError(400, 'messages[].content is invalid');
        }
    }
}

function validatedPayload(name: AICapability, input: JsonObject): JsonObject {
    const payload = { ...input };
    for (const field of BLOCKED_CONNECTION_FIELDS) delete payload[field];
    if ('messages' in payload) validateMessages(payload.messages);
    if (['chat', 'reasoning', 'tools', 'structured-output', 'web-search'].includes(name) && !('messages' in payload)) {
        throw new HttpError(400, `${name} requires messages`);
    }
    if ('prompt' in payload && (typeof payload.prompt !== 'string' || payload.prompt.length > 262_144)) {
        throw new HttpError(413, 'prompt is invalid or too large');
    }
    if ('text' in payload && typeof payload.text !== 'string' && !Array.isArray(payload.text)) {
        throw new HttpError(400, 'text is invalid');
    }
    const maxTokens = boundedNumber(payload.max_tokens, 'max_tokens', 1, 32_768);
    if (maxTokens !== undefined) payload.max_tokens = Math.trunc(maxTokens);
    for (const [field, minimum, maximum] of [
        ['temperature', 0, 5], ['top_p', 0, 1], ['min_p', 0, 1], ['frequency_penalty', -2, 2],
        ['presence_penalty', -2, 2], ['repetition_penalty', 0, 5], ['top_k', 0, 1_000],
    ] as const) {
        const parsed = boundedNumber(payload[field], field, minimum, maximum);
        if (parsed !== undefined) payload[field] = parsed;
    }
    if ('stream' in payload && typeof payload.stream !== 'boolean') throw new HttpError(400, 'stream must be boolean');
    if (Array.isArray(payload.stop) && payload.stop.length > 16) throw new HttpError(413, 'Too many stop strings');
    if (Array.isArray(payload.tools) && payload.tools.length > 64) throw new HttpError(413, 'Too many tools');
    return payload;
}

function proxyAiResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    headers.delete('connection');
    headers.delete('transfer-encoding');
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function invokeCapability(
    context: Pick<RouteContext, 'env' | 'request'>,
    name: AICapability,
    payload: JsonObject,
): Promise<Response> {
    const profile = await getCapabilityProfile(context.env, name);
    if (!profile.enabled || !profile.modelId) return notConfigured(name);
    const outbound = validatedPayload(name, payload);
    try {
        const response = await (context.env.AI as unknown as DynamicAiBinding).run(profile.modelId, outbound, {
            gateway: {
                id: context.env.AI_GATEWAY_ID,
                collectLog: false,
                skipCache: true,
                requestTimeoutMs: 60_000,
                retries: { maxAttempts: 1 },
                metadata: { capability: name },
            },
            returnRawResponse: true,
            signal: context.request.signal,
        });
        return proxyAiResponse(response);
    } catch (error) {
        if (context.request.signal.aborted || error instanceof DOMException && error.name === 'AbortError') {
            throw new HttpError(499, 'AI request was cancelled');
        }
        const nameValue = error instanceof Error ? error.name : '';
        if (/limit|quota|rate/iu.test(nameValue)) throw new HttpError(429, 'AI Gateway limit reached');
        if (/timeout/iu.test(nameValue)) throw new HttpError(504, 'AI Gateway request timed out');
        throw new HttpError(502, 'AI Gateway request failed');
    }
}

function testPayload(name: AICapability, body: JsonObject): JsonObject {
    if (body.payload !== undefined) return objectValue(body.payload);
    switch (name) {
        case 'chat':
        case 'reasoning':
        case 'tools':
        case 'structured-output':
        case 'web-search':
            return { messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 4, stream: false };
        case 'text': return { prompt: 'Reply with OK.', max_tokens: 4 };
        case 'classification': return { text: 'neutral test' };
        case 'translation': return { text: 'hello', target_lang: 'zh' };
        case 'caption': return { prompt: 'Describe the image.', image: '' };
        case 'image': return { prompt: 'A one-pixel test image', num_steps: 1 };
        case 'tts': return { text: 'test' };
        case 'stt': return { audio: '' };
        case 'embedding': return { text: ['test'] };
    }
}

export function registerAiRoutes(router: Router): void {
    router.on('GET', '/api/ai/capabilities', async ({ env }) => json({
        gatewayId: env.AI_GATEWAY_ID,
        profiles: await listCapabilityProfiles(env),
    }));
    router.on('PUT', '/api/ai/capabilities/:capability', async ({ request, env, params }) => {
        const name = capability(params.capability);
        const body = await readJson(request, 32_768);
        return json(await saveProfile(env, name, body));
    });
    router.on('POST', '/api/ai/test', async context => {
        const body = await readJson(context.request, 65_536);
        const name = capability(body.capability);
        if (body.modelId !== undefined && name !== 'embedding') {
            await saveProfile(context.env, name, { ...body, enabled: true });
        }
        return invokeCapability(context, name, testPayload(name, body));
    });
    router.on('POST', '/api/ai/run/:capability', async context => {
        const name = capability(context.params.capability);
        const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
        const payload = body.payload === undefined ? body : objectValue(body.payload);
        return invokeCapability(context, name, payload);
    });
}
