import { Buffer } from 'node:buffer';

import { HttpError, json, maxJsonBytes, maxUploadBytes, readFormData, readJson, requireString, text } from '../http';
import type { RouteContext, Router } from '../router';
import { readSecret } from '../storage/secrets';
import { proxyResponse, safeRemoteUrl } from './providers';

type JsonObject = Record<string, unknown>;

const GOOGLE_NATIVE_VOICES = [
    'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirhoe', 'Autonoe',
    'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
    'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
    'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
] as const;

const GOOGLE_TRANSLATE_VOICES = [
    ['en', 'English'], ['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'],
    ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)'], ['ja', 'Japanese'],
    ['ko', 'Korean'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'],
    ['pt-BR', 'Portuguese (Brazil)'], ['ru', 'Russian'], ['ar', 'Arabic'], ['hi', 'Hindi'],
] as const;

const OPENAI_CAPTION_PROVIDERS: Record<string, { base: string; secret: string }> = {
    openai: { base: 'https://api.openai.com/v1', secret: 'api_key_openai' },
    openrouter: { base: 'https://openrouter.ai/api/v1', secret: 'api_key_openrouter' },
    xai: { base: 'https://api.x.ai/v1', secret: 'api_key_xai' },
    mistral: { base: 'https://api.mistral.ai/v1', secret: 'api_key_mistralai' },
    groq: { base: 'https://api.groq.com/openai/v1', secret: 'api_key_groq' },
    aimlapi: { base: 'https://api.aimlapi.com/v1', secret: 'api_key_aimlapi' },
    moonshot: { base: 'https://api.moonshot.ai/v1', secret: 'api_key_moonshot' },
    nanogpt: { base: 'https://nano-gpt.com/api/v1', secret: 'api_key_nanogpt' },
    chutes: { base: 'https://llm.chutes.ai/v1', secret: 'api_key_chutes' },
    electronhub: { base: 'https://api.electronhub.ai/v1', secret: 'api_key_electronhub' },
    zai: { base: 'https://api.z.ai/api/paas/v4', secret: 'api_key_zai' },
    pollinations: { base: 'https://gen.pollinations.ai/v1', secret: 'api_key_pollinations' },
};

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function endpoint(base: string | URL, path: string): URL {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
    url.search = '';
    return url;
}

async function requiredSecret(env: Env, key: string, id?: unknown): Promise<string> {
    const value = await readSecret(env, key, typeof id === 'string' ? id : undefined);
    if (!value) throw new HttpError(400, `${key} is not configured`);
    return value;
}

function jsonHeaders(key?: string): Headers {
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    if (key) headers.set('authorization', `Bearer ${key}`);
    return headers;
}

async function postJson(url: string | URL, body: unknown, request: Request, headers = new Headers()): Promise<Response> {
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return proxyResponse(await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
    }));
}

function without(value: JsonObject, omitted: readonly string[]): JsonObject {
    const result: JsonObject = {};
    const blocked = new Set(omitted);
    for (const [key, item] of Object.entries(value)) if (!blocked.has(key) && item !== undefined) result[key] = item;
    return result;
}

function dataImage(value: unknown): { mimeType: string; data: string } {
    const source = requireString(value, 'image', 12_000_000);
    const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]+)$/u.exec(source);
    if (match?.[1] && match[2]) return { mimeType: match[1], data: match[2].replace(/\s/gu, '') };
    return { mimeType: 'image/jpeg', data: source };
}

function decodeBase64(value: unknown, field: string, maxBytes: number): Uint8Array<ArrayBuffer> {
    const source = requireString(value, field, Math.ceil(maxBytes * 4 / 3) + 16).replace(/\s/gu, '');
    if (!/^[a-zA-Z0-9+/]*={0,2}$/u.test(source)) throw new HttpError(502, `Invalid ${field}`);
    const decoded = Buffer.from(source, 'base64');
    if (decoded.byteLength === 0 || decoded.byteLength > maxBytes) throw new HttpError(502, `${field} exceeds the response limit`);
    const bytes = new Uint8Array(decoded.byteLength);
    bytes.set(decoded);
    return bytes;
}

function wavHeader(dataSize: number, sampleRate: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(new ArrayBuffer(44));
    const view = new DataView(bytes.buffer);
    for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
        for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
    }
    view.setUint32(4, 36 + dataSize, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(40, dataSize, true);
    return bytes;
}

function numberValue(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedUsage(value: unknown): JsonObject | null {
    const usage = objectValue(value);
    if (Object.keys(usage).length === 0) return null;
    return {
        used: numberValue(usage.used),
        remaining: numberValue(usage.remaining),
        percentUsed: numberValue(usage.percentUsed),
        resetAt: numberValue(usage.resetAt),
    };
}

async function nanoGptCredits(context: RouteContext): Promise<Response> {
    const key = await requiredSecret(context.env, 'api_key_nanogpt');
    const headers = { accept: 'application/json', 'x-api-key': key };
    const [balanceResult, subscriptionResult] = await Promise.allSettled([
        fetch('https://nano-gpt.com/api/check-balance', { method: 'POST', headers, signal: context.request.signal }),
        fetch('https://nano-gpt.com/api/subscription/v1/usage', { headers, signal: context.request.signal }),
    ]);
    if (balanceResult.status !== 'fulfilled' || !balanceResult.value.ok) {
        throw new HttpError(502, 'NanoGPT balance request failed');
    }
    const balance = objectValue(await balanceResult.value.json().catch(() => ({})));
    const result: JsonObject = {
        usd_balance: numberValue(balance.usd_balance),
        nano_balance: numberValue(balance.nano_balance),
        subscription: null,
    };
    if (subscriptionResult.status === 'fulfilled' && subscriptionResult.value.ok) {
        const subscription = objectValue(await subscriptionResult.value.json().catch(() => ({})));
        if (subscription.active) {
            const period = objectValue(subscription.period);
            const limits = objectValue(subscription.limits);
            result.subscription = {
                active: true,
                state: String(subscription.state ?? ''),
                allowOverage: Boolean(subscription.allowOverage),
                period: { currentPeriodEnd: String(period.currentPeriodEnd ?? '') },
                limits: {
                    weeklyInputTokens: numberValue(limits.weeklyInputTokens),
                    dailyInputTokens: numberValue(limits.dailyInputTokens),
                    dailyImages: numberValue(limits.dailyImages),
                },
                weekly_tokens: normalizedUsage(subscription.weeklyInputTokens),
                daily_tokens: normalizedUsage(subscription.dailyInputTokens),
                daily_images: normalizedUsage(subscription.dailyImages),
            };
        }
    }
    return json(result);
}

async function nanoGptProviders(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, 16_384);
    if (typeof body.model !== 'string' || !body.model) return json({ supportsProviderSelection: false, providers: [] });
    const response = await fetch(`https://nano-gpt.com/api/models/${encodeURIComponent(body.model)}/providers`, {
        headers: { accept: 'application/json' }, signal: context.request.signal,
    });
    if (!response.ok) return json({ supportsProviderSelection: false, providers: [] });
    const data = objectValue(await response.json().catch(() => ({})));
    const providers = Array.isArray(data.providers)
        ? data.providers.map(objectValue).filter(provider => provider.available !== false && typeof provider.provider === 'string').map(provider => provider.provider)
        : [];
    return json({ supportsProviderSelection: Boolean(data.supportsProviderSelection), providers });
}

const MULTIMODAL_CONFIG: Record<string, { url: string; secret?: string }> = {
    pollinations: { url: 'https://gen.pollinations.ai/models' },
    aimlapi: { url: 'https://api.aimlapi.com/v1/models' },
    nanogpt: { url: 'https://nano-gpt.com/api/v1/models?detailed=true' },
    electronhub: { url: 'https://api.electronhub.ai/v1/models' },
    chutes: { url: 'https://llm.chutes.ai/v1/models', secret: 'api_key_chutes' },
    mistral: { url: 'https://api.mistral.ai/v1/models', secret: 'api_key_mistralai' },
    xai: { url: 'https://api.x.ai/v1/language-models', secret: 'api_key_xai' },
    moonshot: { url: 'https://api.moonshot.ai/v1/models', secret: 'api_key_moonshot' },
};

function multimodalIds(provider: string, value: unknown): string[] {
    const data = objectValue(value);
    const source = provider === 'pollinations' && Array.isArray(value) ? value
        : provider === 'xai' && Array.isArray(data.models) ? data.models
            : Array.isArray(data.data) ? data.data : [];
    const models = source.map(objectValue).filter(model => {
        if (provider === 'aimlapi') return Array.isArray(model.features) && model.features.includes('openai/chat-completion.vision');
        if (provider === 'nanogpt' || provider === 'mistral') return Boolean(objectValue(model.capabilities).vision);
        if (provider === 'electronhub') return Boolean(objectValue(model.metadata).vision);
        if (provider === 'moonshot') return Boolean(model.supports_image_in);
        return Array.isArray(model.input_modalities) && model.input_modalities.includes('image');
    }).map(model => model.id ?? model.name).filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (provider === 'xai' && !models.includes('grok-4-0709')) models.push('grok-4-0709');
    return models;
}

async function multimodalModels(context: RouteContext, provider: string): Promise<Response> {
    const body = await readJson(context.request, 16_384);
    if (provider === 'workers_ai') {
        const accountId = typeof body.workers_ai_account_id === 'string' ? body.workers_ai_account_id.trim() : '';
        const key = await readSecret(context.env, 'api_key_workers_ai');
        if (!key || !/^[a-f0-9]{32}$/iu.test(accountId)) return json([]);
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?task=Text+Generation&per_page=1000`, {
            headers: { authorization: `Bearer ${key}` }, signal: context.request.signal,
        });
        if (!response.ok) return json([]);
        const data = objectValue(await response.json().catch(() => ({})));
        const models = Array.isArray(data.result) ? data.result.map(objectValue).filter(model => Array.isArray(model.properties)
            && model.properties.map(objectValue).some(property => property.property_id === 'vision' && property.value === 'true'))
            .map(model => model.name).filter((name): name is string => typeof name === 'string') : [];
        return json(models);
    }
    const config = MULTIMODAL_CONFIG[provider];
    if (!config) throw new HttpError(404, 'Unknown multimodal provider');
    const headers = new Headers({ accept: 'application/json' });
    if (config.secret) {
        const key = await readSecret(context.env, config.secret);
        if (!key) return json([]);
        headers.set('authorization', `Bearer ${key}`);
    }
    const response = await fetch(config.url, { headers, signal: context.request.signal });
    if (!response.ok) return json([]);
    return json(multimodalIds(provider, await response.json().catch(() => ({}))));
}

async function openAiCaption(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const api = typeof body.api === 'string' ? body.api : 'openai';
    let base: URL;
    let key: string;
    if (typeof body.reverse_proxy === 'string' && body.reverse_proxy) {
        base = safeRemoteUrl(body.reverse_proxy, 'reverse_proxy');
        key = typeof body.proxy_password === 'string' ? body.proxy_password : '';
    } else if (api === 'custom') {
        base = safeRemoteUrl(body.server_url, 'server_url');
        key = await requiredSecret(context.env, 'api_key_custom', body.secret_id);
    } else {
        const provider = OPENAI_CAPTION_PROVIDERS[api];
        if (!provider) throw new HttpError(400, `Unsupported caption API: ${api}`);
        base = new URL(provider.base);
        key = await requiredSecret(context.env, provider.secret, body.secret_id);
    }
    const headers = jsonHeaders(key);
    if (api === 'openrouter') {
        headers.set('http-referer', 'https://github.com/ZUENS2020/SillyTavern-Serverless-Edition');
        headers.set('x-title', 'SillyTavern Serverless Edition');
    }
    const remote = await fetch(endpoint(base, '/chat/completions'), {
        method: 'POST', headers, signal: context.request.signal,
        body: JSON.stringify({
            model: body.model,
            max_tokens: body.max_tokens ?? 1024,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: typeof body.prompt === 'string' ? body.prompt : 'Describe this image.' },
                    { type: 'image_url', image_url: { url: body.image } },
                ],
            }],
        }),
    });
    const data = objectValue(await remote.json().catch(() => ({})));
    if (!remote.ok) return json(data, { status: remote.status });
    const choice = objectValue(Array.isArray(data.choices) ? data.choices[0] : undefined);
    const message = objectValue(choice.message);
    const content = message.content;
    const caption = typeof content === 'string' ? content
        : Array.isArray(content) ? objectValue(content.find(item => objectValue(item).type === 'text')).text : undefined;
    if (typeof caption !== 'string' || !caption) throw new HttpError(502, 'Caption provider returned no text');
    return json({ caption });
}

async function anthropicCaption(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const key = await requiredSecret(context.env, 'api_key_claude', body.secret_id);
    const image = dataImage(body.image);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
            model: body.model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } },
                { type: 'text', text: typeof body.prompt === 'string' ? body.prompt : 'Describe this image.' },
            ] }],
        }),
        signal: context.request.signal,
    });
    const data = objectValue(await response.json().catch(() => ({})));
    if (!response.ok) return json(data, { status: response.status });
    const caption = objectValue(Array.isArray(data.content) ? data.content.find(item => objectValue(item).type === 'text') : undefined).text;
    if (typeof caption !== 'string') throw new HttpError(502, 'Anthropic returned no caption');
    return json({ caption });
}

async function googleRequest(env: Env, request: Request, body: JsonObject, outbound: JsonObject): Promise<JsonObject> {
    if (body.api && body.api !== 'makersuite') throw new HttpError(422, 'Vertex AI service-account signing is unavailable; use Google AI Studio');
    const key = await requiredSecret(env, 'api_key_makersuite', body.secret_id);
    const model = requireString(body.model, 'model', 256).replace(/^models\//u, '');
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`);
    url.searchParams.set('key', key);
    const response = await fetch(url, {
        method: 'POST', headers: jsonHeaders(), body: JSON.stringify(outbound), signal: request.signal,
    });
    const data = objectValue(await response.json().catch(() => ({})));
    if (!response.ok) throw new HttpError(response.status, JSON.stringify(data).slice(0, 1024));
    return data;
}

function googleParts(data: JsonObject): JsonObject[] {
    const candidate = objectValue(Array.isArray(data.candidates) ? data.candidates[0] : undefined);
    const content = objectValue(candidate.content);
    return Array.isArray(content.parts) ? content.parts.map(objectValue) : [];
}

async function googleCaption(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const image = dataImage(body.image);
    const data = await googleRequest(context.env, context.request, body, {
        contents: [{ role: 'user', parts: [
            { text: typeof body.prompt === 'string' ? body.prompt : 'Describe this image.' },
            { inlineData: { mimeType: image.mimeType, data: image.data } },
        ] }],
    });
    const caption = googleParts(data).find(part => typeof part.text === 'string')?.text;
    if (typeof caption !== 'string') throw new HttpError(502, 'Google returned no caption');
    return json({ caption });
}

async function googleImage(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env));
    if (body.api && body.api !== 'makersuite') throw new HttpError(422, 'Vertex AI signing is unavailable in the free-CPU profile; use Google AI Studio');
    const key = await requiredSecret(context.env, 'api_key_makersuite', body.secret_id);
    const model = typeof body.model === 'string' && body.model ? body.model.replace(/^models\//u, '') : 'imagen-3.0-generate-002';
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predict`);
    const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
            instances: [{ prompt: requireString(body.prompt, 'prompt', 32_000) }],
            parameters: {
                sampleCount: 1,
                aspectRatio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '1:1',
                outputOptions: { mimeType: 'image/jpeg', compressionQuality: 100 },
            },
        }),
        signal: context.request.signal,
    });
    const data = objectValue(await response.json().catch(() => ({})));
    if (!response.ok) return json(data, { status: response.status });
    const prediction = objectValue(Array.isArray(data.predictions) ? data.predictions[0] : undefined);
    const image = prediction.bytesBase64Encoded;
    if (typeof image !== 'string' || !image) throw new HttpError(502, 'Google returned no image');
    return json({ image });
}

async function googleNativeTts(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env));
    const data = await googleRequest(context.env, context.request, body, {
        contents: [{ role: 'user', parts: [{ text: requireString(body.text, 'text', 20_000) }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: requireString(body.voice, 'voice', 128) } } },
        },
    });
    const inline = googleParts(data).map(part => objectValue(part.inlineData ?? part.inline_data)).find(part => typeof part.data === 'string');
    if (!inline || typeof inline.data !== 'string') throw new HttpError(502, 'Google returned no audio');
    const mimeType = typeof inline.mimeType === 'string' ? inline.mimeType : typeof inline.mime_type === 'string' ? inline.mime_type : 'application/octet-stream';
    const audio = decodeBase64(inline.data, 'Google audio response', maxUploadBytes(context.env));
    if (mimeType.toLowerCase().includes('audio/l16')) {
        const sampleRate = Number.parseInt(/rate=(\d+)/iu.exec(mimeType)?.[1] ?? '24000', 10);
        return new Response(new Blob([wavHeader(audio.byteLength, sampleRate), audio]), {
            headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' },
        });
    }
    return new Response(audio, { headers: { 'content-type': mimeType, 'cache-control': 'no-store' } });
}

async function openAiSpeech(context: RouteContext, provider: 'openai' | 'custom' | 'electronhub'): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env));
    let url: URL;
    let key: string;
    if (provider === 'custom') {
        url = endpoint(safeRemoteUrl(body.provider_endpoint, 'provider_endpoint'), '/audio/speech');
        key = await requiredSecret(context.env, 'api_key_custom_openai_tts', body.secret_id);
    } else if (provider === 'electronhub') {
        url = new URL('https://api.electronhub.ai/v1/audio/speech');
        key = await requiredSecret(context.env, 'api_key_electronhub', body.secret_id);
    } else {
        url = new URL('https://api.openai.com/v1/audio/speech');
        key = await requiredSecret(context.env, 'api_key_openai', body.secret_id);
    }
    const outbound = provider === 'openai'
        ? { input: body.text, voice: body.voice ?? 'alloy', model: body.model ?? 'tts-1', speed: body.speed ?? 1, response_format: 'mp3', instructions: body.instructions }
        : without(body, ['provider_endpoint', 'secret_id']);
    return postJson(url, outbound, context.request, jsonHeaders(key));
}

function azureRegion(value: unknown): string {
    const region = requireString(value, 'region', 64).toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(region)) throw new HttpError(400, 'Invalid Azure region');
    return region;
}

function xml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function azureTts(context: RouteContext, list: boolean): Promise<Response> {
    const body = await readJson(context.request, 65_536);
    const key = await requiredSecret(context.env, 'api_key_azure_tts', body.secret_id);
    const region = azureRegion(body.region);
    const base = `https://${region}.tts.speech.microsoft.com/cognitiveservices/`;
    if (list) return proxyResponse(await fetch(`${base}voices/list`, { headers: { 'ocp-apim-subscription-key': key }, signal: context.request.signal }));
    const voice = requireString(body.voice, 'voice', 128);
    const source = requireString(body.text, 'text', 20_000);
    const language = voice.split('-').slice(0, 2).join('-');
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(language)}"><voice xml:lang="${xml(language)}" name="${xml(voice)}">${xml(source)}</voice></speak>`;
    return proxyResponse(await fetch(`${base}v1`, {
        method: 'POST',
        headers: {
            'ocp-apim-subscription-key': key,
            'content-type': 'application/ssml+xml',
            'x-microsoft-outputformat': 'webm-24khz-16bit-mono-opus',
        },
        body: ssml,
        signal: context.request.signal,
    }));
}

async function novel(context: RouteContext, operation: 'status' | 'generate' | 'voice'): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const key = await requiredSecret(context.env, 'api_key_novel', body.secret_id);
    const headers = jsonHeaders(key);
    if (operation === 'status') return proxyResponse(await fetch('https://api.novelai.net/user/subscription', { headers, signal: context.request.signal }));
    if (operation === 'voice') {
        const url = new URL('https://api.novelai.net/ai/generate-voice');
        url.searchParams.set('text', requireString(body.text, 'text', 10_000));
        url.searchParams.set('voice', '-1');
        url.searchParams.set('seed', requireString(body.voice, 'voice', 256));
        url.searchParams.set('opus', 'false');
        url.searchParams.set('version', 'v2');
        return proxyResponse(await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: 'audio/mpeg' }, signal: context.request.signal }));
    }
    const parameters = without(body, ['input', 'model', 'streaming', 'secret_id']);
    const url = body.streaming ? 'https://text.novelai.net/ai/generate-stream' : 'https://text.novelai.net/ai/generate';
    return postJson(url, { input: body.input, model: body.model, parameters }, context.request, headers);
}

type OpenRouterModelKind = 'providers' | 'multimodal' | 'embedding' | 'image';

export function normalizeOpenRouterModels(value: unknown, kind: OpenRouterModelKind): unknown[] {
    const root = objectValue(value);
    if (kind === 'providers') {
        const endpoints = Array.isArray(objectValue(root.data).endpoints) ? objectValue(root.data).endpoints as unknown[] : [];
        return [...new Set(endpoints.map(item => objectValue(item).provider_name).filter((name): name is string => typeof name === 'string' && Boolean(name)))];
    }
    const models = Array.isArray(root.data) ? root.data : [];
    return models.filter(item => {
        const architecture = objectValue(objectValue(item).architecture);
        const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
        const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
        if (kind === 'multimodal') return inputs.includes('image') && outputs.includes('text');
        if (kind === 'embedding') return inputs.includes('text') && outputs.includes('embeddings');
        return inputs.includes('text') && outputs.includes('image');
    }).map(item => {
        const model = objectValue(item);
        const id = String(model.id ?? '');
        if (kind === 'multimodal') return id;
        if (kind === 'image') return { value: id, text: String(model.name ?? id) };
        return { id, name: String(model.name ?? id) };
    }).filter(item => typeof item !== 'string' || Boolean(item));
}

export function normalizeOpenRouterCredits(value: unknown): { remaining: number; total_credits: number; total_usage: number } {
    const data = objectValue(objectValue(value).data);
    const totalCredits = numberValue(data.total_credits ?? data.limit);
    const totalUsage = numberValue(data.total_usage ?? data.usage);
    const explicitRemaining = Number(data.limit_remaining);
    const remaining = Number.isFinite(explicitRemaining) ? explicitRemaining : totalCredits - totalUsage;
    return { remaining, total_credits: totalCredits, total_usage: totalUsage };
}

async function openRouter(context: RouteContext, path: string): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env));
    const key = await readSecret(context.env, 'api_key_openrouter', typeof body.secret_id === 'string' ? body.secret_id : undefined);
    const headers = jsonHeaders(key);
    headers.set('http-referer', 'https://github.com/ZUENS2020/SillyTavern-Serverless-Edition');
    headers.set('x-title', 'SillyTavern Serverless Edition');
    if (path === '/credits') {
        if (!key) throw new HttpError(400, 'api_key_openrouter is not configured');
        let response = await fetch('https://openrouter.ai/api/v1/credits', { headers, signal: context.request.signal });
        if (response.status === 403) response = await fetch('https://openrouter.ai/api/v1/key', { headers, signal: context.request.signal });
        if (!response.ok) return proxyResponse(response);
        return json(normalizeOpenRouterCredits(await response.json<unknown>()));
    }
    if (path.startsWith('/models')) {
        let kind: OpenRouterModelKind;
        let url: URL;
        if (path === '/models/providers') {
            kind = 'providers';
            const model = requireString(body.model, 'model', 256);
            const modelPath = model.split('/').map(encodeURIComponent).join('/');
            url = new URL(`https://openrouter.ai/api/v1/models/${modelPath}/endpoints`);
        } else if (path === '/models/image') {
            kind = 'image';
            url = new URL('https://openrouter.ai/api/v1/images/models');
        } else {
            kind = path === '/models/embedding' ? 'embedding' : 'multimodal';
            url = new URL('https://openrouter.ai/api/v1/models');
            url.searchParams.set('output_modalities', kind === 'embedding' ? 'embeddings' : 'text');
        }
        const response = await fetch(url, { headers, signal: context.request.signal });
        if (!response.ok) return proxyResponse(response);
        return json(normalizeOpenRouterModels(await response.json<unknown>(), kind));
    }
    if (!key) throw new HttpError(400, 'api_key_openrouter is not configured');
    const outbound: JsonObject = {
        model: requireString(body.model, 'model', 256),
        prompt: requireString(body.prompt, 'prompt', 20_000),
        n: 1,
        aspect_ratio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '1:1',
        output_format: typeof body.output_format === 'string' ? body.output_format : 'png',
    };
    for (const field of ['resolution', 'size', 'quality', 'background', 'output_compression', 'seed'] as const) {
        if (body[field] !== undefined) outbound[field] = body[field];
    }
    return postJson('https://openrouter.ai/api/v1/images', outbound, context.request, headers);
}

const TRANSCRIPTION_PROVIDERS: Record<string, { url: string; secret: string }> = {
    openai: { url: 'https://api.openai.com/v1/audio/transcriptions', secret: 'api_key_openai' },
    groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', secret: 'api_key_groq' },
    mistral: { url: 'https://api.mistral.ai/v1/audio/transcriptions', secret: 'api_key_mistralai' },
    zai: { url: 'https://api.z.ai/api/paas/v4/audio/transcriptions', secret: 'api_key_zai' },
    chutes: { url: 'https://chutes-whisper-large-v3.chutes.ai/transcribe', secret: 'api_key_chutes' },
};

async function transcribe(context: RouteContext, provider: string): Promise<Response> {
    const config = TRANSCRIPTION_PROVIDERS[provider];
    if (!config) throw new HttpError(404, 'Transcription provider not found');
    const incoming = await readFormData(context.request, maxUploadBytes(context.env));
    const secretId = incoming.get('secret_id');
    const key = await requiredSecret(context.env, config.secret, secretId);
    const outbound = new FormData();
    incoming.forEach((value, name) => {
        if (name === 'secret_id') return;
        if (value instanceof File) outbound.append(name === 'audio' ? 'file' : name, value, value.name || 'audio.wav');
        else outbound.append(name, value);
    });
    if (!outbound.has('file')) throw new HttpError(400, 'Missing audio file');
    if (!outbound.has('model')) outbound.set('model', provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1');
    return proxyResponse(await fetch(config.url, {
        method: 'POST', headers: { authorization: `Bearer ${key}` }, body: outbound, signal: context.request.signal,
    }));
}

async function elevenLabs(context: RouteContext, operation: 'voices' | 'voice-settings' | 'synthesize' | 'history' | 'history-audio' | 'voices-add'): Promise<Response> {
    const key = await requiredSecret(context.env, 'api_key_elevenlabs');
    const headers = new Headers({ 'xi-api-key': key });
    if (operation === 'voices' || operation === 'voice-settings' || operation === 'history') {
        const path = operation === 'voices' ? '/voices' : operation === 'voice-settings' ? '/voices/settings/default' : '/history';
        return proxyResponse(await fetch(`https://api.elevenlabs.io/v1${path}`, { headers, signal: context.request.signal }));
    }
    const body = await readJson(context.request, maxUploadBytes(context.env));
    if (operation === 'synthesize') {
        const voiceId = requireString(body.voiceId, 'voiceId', 256);
        const outbound = objectValue(body.request);
        headers.set('content-type', 'application/json');
        return proxyResponse(await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
            method: 'POST', headers, body: JSON.stringify(outbound), signal: context.request.signal,
        }));
    }
    if (operation === 'history-audio') {
        const historyItemId = requireString(body.historyItemId, 'historyItemId', 256);
        return proxyResponse(await fetch(`https://api.elevenlabs.io/v1/history/${encodeURIComponent(historyItemId)}/audio`, {
            headers, signal: context.request.signal,
        }));
    }
    const files = Array.isArray(body.files) ? body.files.slice(0, 10) : [];
    if (files.length === 0) throw new HttpError(400, 'At least one voice sample is required');
    const form = new FormData();
    form.set('name', typeof body.name === 'string' && body.name ? body.name.slice(0, 256) : 'Custom Voice');
    form.set('description', typeof body.description === 'string' ? body.description.slice(0, 2_000) : 'Uploaded via SillyTavern');
    form.set('labels', typeof body.labels === 'string' ? body.labels.slice(0, 2_000) : '');
    let totalBytes = 0;
    for (const [index, value] of files.entries()) {
        const match = typeof value === 'string' ? /^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]+)$/u.exec(value) : null;
        if (!match?.[1] || !match[2]) continue;
        const remaining = maxUploadBytes(context.env) - totalBytes;
        if (remaining <= 0) throw new HttpError(413, 'Voice samples exceed the upload limit');
        const bytes = decodeBase64(match[2], 'voice sample', remaining);
        totalBytes += bytes.byteLength;
        const extension = match[1].includes('mpeg') ? 'mp3' : match[1].includes('ogg') ? 'ogg' : match[1].includes('webm') ? 'webm' : 'wav';
        form.append('files', new Blob([bytes], { type: match[1] }), `audio-${index + 1}.${extension}`);
    }
    if (totalBytes === 0) throw new HttpError(400, 'No valid voice sample was provided');
    return proxyResponse(await fetch('https://api.elevenlabs.io/v1/voices/add', {
        method: 'POST', headers, body: form, signal: context.request.signal,
    }));
}

export function registerMultimediaRoutes(router: Router): void {
    router.on('POST', '/api/openai/caption-image', openAiCaption);
    router.on('POST', '/api/anthropic/caption-image', anthropicCaption);
    router.on('POST', '/api/google/caption-image', googleCaption);
    router.on('POST', '/api/google/generate-image', googleImage);
    router.on('POST', '/api/google/generate-native-tts', googleNativeTts);

    for (const provider of [...Object.keys(MULTIMODAL_CONFIG), 'workers_ai']) {
        router.on('POST', `/api/backends/chat-completions/multimodal-models/${provider}`, context => multimodalModels(context, provider));
    }
    router.on('POST', '/api/nanogpt/credits', nanoGptCredits);
    router.on('POST', '/api/nanogpt/models/providers', nanoGptProviders);

    router.on('POST', '/api/openai/generate-voice', context => openAiSpeech(context, 'openai'));
    router.on('POST', '/api/openai/custom/generate-voice', context => openAiSpeech(context, 'custom'));
    router.on('POST', '/api/openai/electronhub/generate-voice', context => openAiSpeech(context, 'electronhub'));
    router.on('POST', '/api/openai/electronhub/models', async ({ request, env }) => {
        const key = await requiredSecret(env, 'api_key_electronhub');
        return proxyResponse(await fetch('https://api.electronhub.ai/v1/models', { headers: jsonHeaders(key), signal: request.signal }));
    });
    router.on('POST', '/api/openai/chutes/generate-voice', async context => {
        const body = await readJson(context.request, maxJsonBytes(context.env));
        const key = await requiredSecret(context.env, 'api_key_chutes', body.secret_id);
        return postJson('https://chutes-kokoro.chutes.ai/speak', { text: body.input, voice: body.voice ?? 'af_heart', speed: body.speed ?? 1 }, context.request, jsonHeaders(key));
    });
    router.on('POST', '/api/openai/generate-image', async context => {
        const body = await readJson(context.request, maxJsonBytes(context.env));
        const key = await requiredSecret(context.env, 'api_key_openai', body.secret_id);
        return postJson('https://api.openai.com/v1/images/generations', without(body, ['secret_id']), context.request, jsonHeaders(key));
    });
    for (const provider of Object.keys(TRANSCRIPTION_PROVIDERS)) {
        const prefix = provider === 'openai' ? '' : `${provider}/`;
        router.on('POST', `/api/openai/${prefix}transcribe-audio`, context => transcribe(context, provider));
    }

    const embeddingModels = async (context: RouteContext, provider: 'nanogpt' | 'siliconflow' | 'chutes' | 'workers-ai'): Promise<Response> => {
        const body = await readJson(context.request, 65_536);
        let url: URL;
        let keyName: string;
        if (provider === 'nanogpt') {
            url = new URL('https://nano-gpt.com/api/v1/embedding-models');
            keyName = 'api_key_nanogpt';
        } else if (provider === 'siliconflow') {
            url = new URL(body.siliconflow_endpoint === 'cn'
                ? 'https://api.siliconflow.cn/v1/models?type=text&sub_type=embedding'
                : 'https://api.siliconflow.com/v1/models?type=text&sub_type=embedding');
            keyName = 'api_key_siliconflow';
        } else if (provider === 'chutes') {
            url = new URL('https://api.chutes.ai/chutes/?template=embedding&include_public=true&limit=999');
            keyName = 'api_key_chutes';
        } else {
            const accountId = requireString(body.workers_ai_account_id, 'workers_ai_account_id', 128);
            if (!/^[a-f0-9]{32}$/iu.test(accountId)) throw new HttpError(400, 'Invalid Workers AI account ID');
            url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?task=Text+Embeddings&per_page=100`);
            keyName = 'api_key_workers_ai';
        }
        const key = await requiredSecret(context.env, keyName, body.secret_id);
        return proxyResponse(await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: context.request.signal }));
    };
    for (const provider of ['nanogpt', 'siliconflow', 'chutes', 'workers-ai'] as const) {
        router.on('POST', `/api/openai/${provider}/models/embedding`, context => embeddingModels(context, provider));
    }

    router.on('POST', '/api/azure/list', context => azureTts(context, true));
    router.on('POST', '/api/azure/generate', context => azureTts(context, false));

    router.on('POST', '/api/google/list-voices', () => json(GOOGLE_TRANSLATE_VOICES.map(([voice_id, name]) => ({ voice_id, name, lang: voice_id }))));
    router.on('POST', '/api/google/list-native-voices', () => json({ voices: GOOGLE_NATIVE_VOICES.map(voice => ({ name: voice, voice_id: voice, lang: 'en-US' })) }));
    router.on('POST', '/api/google/generate-voice', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const chunks = Array.isArray(body.text) ? body.text.filter((value): value is string => typeof value === 'string') : [requireString(body.text, 'text', 1_000)];
        const source = chunks.slice(0, 6).join(' ').slice(0, 1_000);
        const voice = requireString(body.voice ?? 'en', 'voice', 32);
        const url = new URL('https://translate.google.com/translate_tts');
        url.searchParams.set('ie', 'UTF-8');
        url.searchParams.set('client', 'tw-ob');
        url.searchParams.set('q', source);
        url.searchParams.set('tl', voice);
        return proxyResponse(await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: request.signal }));
    });

    router.on('POST', '/api/novelai/status', context => novel(context, 'status'));
    router.on('POST', '/api/novelai/generate', context => novel(context, 'generate'));
    router.on('POST', '/api/novelai/generate-voice', context => novel(context, 'voice'));

    for (const path of ['/models/providers', '/models/multimodal', '/models/embedding', '/models/image', '/credits', '/image/generate']) {
        router.on('POST', `/api/openrouter${path}`, context => openRouter(context, path));
    }

    router.on('POST', '/api/speech/pollinations/voices', async ({ request }) => {
        const body = await readJson(request, 16_384);
        const response = await fetch('https://gen.pollinations.ai/text/models', { signal: request.signal });
        if (!response.ok) return proxyResponse(response);
        const data: unknown = await response.json().catch(() => []);
        const model = Array.isArray(data) ? data.map(objectValue).find(item => item.name === (body.model ?? 'openai-audio')) : undefined;
        return json(model && Array.isArray(model.voices) ? model.voices : []);
    });
    router.on('POST', '/api/speech/pollinations/generate', async context => {
        const body = await readJson(context.request, maxJsonBytes(context.env));
        const key = await requiredSecret(context.env, 'api_key_pollinations', body.secret_id);
        const response = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
            method: 'POST', headers: jsonHeaders(key), signal: context.request.signal, body: JSON.stringify({
                model: body.model ?? 'openai-audio',
                stream: false,
                modalities: ['text', 'audio'],
                audio: { voice: body.voice ?? 'alloy', format: 'mp3' },
                messages: [{ role: 'user', content: requireString(body.text, 'text', 20_000) }],
            }),
        });
        const data = objectValue(await response.json().catch(() => ({})));
        if (!response.ok) return json(data, { status: response.status });
        const choice = objectValue(Array.isArray(data.choices) ? data.choices[0] : undefined);
        const audio = objectValue(objectValue(choice.message).audio).data;
        return new Response(decodeBase64(audio, 'Pollinations audio response', maxUploadBytes(context.env)), {
            headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
        });
    });

    for (const operation of ['voices', 'voice-settings', 'synthesize', 'history', 'history-audio', 'voices-add'] as const) {
        const path = operation === 'voices-add' ? 'voices/add' : operation;
        router.on('POST', `/api/speech/elevenlabs/${path}`, context => elevenLabs(context, operation));
    }

    router.on('POST', '/api/speech/synthesize', () => {
        throw new HttpError(422, 'Local neural TTS is unavailable in the free-CPU profile; select a remote TTS provider');
    });
    router.on('POST', '/api/speech/recognize', () => {
        throw new HttpError(422, 'Local speech recognition is unavailable in the free-CPU profile; select a remote transcription provider');
    });
    router.on('POST', '/api/summarize', () => text('Use the configured generation provider for summarization', { status: 422 }));
}
