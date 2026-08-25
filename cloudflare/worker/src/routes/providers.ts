import YAML from 'yaml';

import { HttpError, json, maxJsonBytes, readJson, requireString } from '../http';
import type { Router } from '../router';
import { readSecret } from '../storage/secrets';

type JsonObject = Record<string, unknown>;

interface ProviderConfig {
    baseUrl: URL;
    apiKey: string;
    headers: Headers;
    kind: 'openai' | 'anthropic' | 'gemini' | 'azure' | 'workers-ai';
}

const OPENAI_FIELDS = new Set([
    'model', 'messages', 'prompt', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k',
    'min_p', 'stop', 'stream', 'stream_options', 'n', 'frequency_penalty', 'presence_penalty', 'repetition_penalty',
    'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'response_format', 'tools', 'tool_choice',
    'parallel_tool_calls', 'reasoning_effort', 'reasoning', 'verbosity', 'user', 'service_tier', 'transforms',
    'plugins', 'provider', 'route', 'include_reasoning', 'min_tokens', 'best_of', 'ignore_eos',
]);

const PROVIDERS: Record<string, { base: string; secret: string }> = {
    openai: { base: 'https://api.openai.com/v1', secret: 'api_key_openai' },
    openrouter: { base: 'https://openrouter.ai/api/v1', secret: 'api_key_openrouter' },
    mistralai: { base: 'https://api.mistral.ai/v1', secret: 'api_key_mistralai' },
    cohere: { base: 'https://api.cohere.ai/v2', secret: 'api_key_cohere' },
    perplexity: { base: 'https://api.perplexity.ai', secret: 'api_key_perplexity' },
    groq: { base: 'https://api.groq.com/openai/v1', secret: 'api_key_groq' },
    chutes: { base: 'https://llm.chutes.ai/v1', secret: 'api_key_chutes' },
    electronhub: { base: 'https://api.electronhub.ai/v1', secret: 'api_key_electronhub' },
    nanogpt: { base: 'https://nano-gpt.com/api/v1', secret: 'api_key_nanogpt' },
    deepseek: { base: 'https://api.deepseek.com', secret: 'api_key_deepseek' },
    aimlapi: { base: 'https://api.aimlapi.com/v1', secret: 'api_key_aimlapi' },
    xai: { base: 'https://api.x.ai/v1', secret: 'api_key_xai' },
    pollinations: { base: 'https://gen.pollinations.ai/v1', secret: 'api_key_pollinations' },
    moonshot: { base: 'https://api.moonshot.ai/v1', secret: 'api_key_moonshot' },
    fireworks: { base: 'https://api.fireworks.ai/inference/v1', secret: 'api_key_fireworks' },
    cometapi: { base: 'https://api.cometapi.com/v1', secret: 'api_key_cometapi' },
    zai: { base: 'https://api.z.ai/api/paas/v4', secret: 'api_key_zai' },
    siliconflow: { base: 'https://api.siliconflow.com/v1', secret: 'api_key_siliconflow' },
    minimax: { base: 'https://api.minimax.io/v1', secret: 'api_key_minimax' },
    ai21: { base: 'https://api.ai21.com/studio/v1', secret: 'api_key_ai21' },
};

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function isPrivateIpv4(hostname: string): boolean {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
    if (!match) return false;
    const octets = match.slice(1).map(Number);
    const [first = 0, second = 0] = octets;
    return first === 0 || first === 10 || first === 127 || first >= 224
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168);
}

export function safeRemoteUrl(value: unknown, field: string): URL {
    const source = requireString(value, field, 2048);
    let url: URL;
    try {
        url = new URL(source);
    } catch {
        throw new HttpError(400, `Invalid ${field}`);
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname
        || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
        || hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')
        || isPrivateIpv4(hostname)) {
        throw new HttpError(400, `${field} must be a public HTTPS URL`);
    }
    return url;
}

function endpoint(base: URL, pathname: string): URL {
    const result = new URL(base);
    result.pathname = `${result.pathname.replace(/\/+$/u, '')}/${pathname.replace(/^\/+/, '')}`;
    result.search = '';
    result.hash = '';
    return result;
}

export function proxyResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    headers.delete('transfer-encoding');
    headers.delete('connection');
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function customHeaders(value: unknown): Headers {
    const headers = new Headers();
    if (typeof value !== 'string' || !value.trim()) return headers;
    let parsed: unknown;
    try {
        parsed = YAML.parse(value);
    } catch {
        throw new HttpError(400, 'Invalid custom headers');
    }
    for (const [key, headerValue] of Object.entries(objectValue(parsed))) {
        const normalized = key.toLowerCase();
        if (normalized === 'host' || normalized.startsWith('cf-') || normalized === 'content-length'
            || normalized === 'connection' || normalized === 'transfer-encoding' || typeof headerValue !== 'string') continue;
        headers.set(key, headerValue);
    }
    return headers;
}

async function providerConfig(env: Env, body: JsonObject): Promise<ProviderConfig> {
    const source = requireString(body.chat_completion_source, 'chat_completion_source', 64);
    if (source === 'claude') {
        const reverse = typeof body.reverse_proxy === 'string' && body.reverse_proxy ? safeRemoteUrl(body.reverse_proxy, 'reverse_proxy') : new URL('https://api.anthropic.com/v1');
        const apiKey = typeof body.reverse_proxy === 'string' && body.reverse_proxy
            ? String(body.proxy_password ?? '')
            : await readSecret(env, 'api_key_claude', typeof body.secret_id === 'string' ? body.secret_id : undefined);
        return { baseUrl: reverse, apiKey, headers: new Headers(), kind: 'anthropic' };
    }
    if (source === 'makersuite') {
        const reverse = typeof body.reverse_proxy === 'string' && body.reverse_proxy ? safeRemoteUrl(body.reverse_proxy, 'reverse_proxy') : new URL('https://generativelanguage.googleapis.com');
        const apiKey = typeof body.reverse_proxy === 'string' && body.reverse_proxy
            ? String(body.proxy_password ?? '')
            : await readSecret(env, 'api_key_makersuite', typeof body.secret_id === 'string' ? body.secret_id : undefined);
        return { baseUrl: reverse, apiKey, headers: new Headers(), kind: 'gemini' };
    }
    if (source === 'azure_openai') {
        const baseUrl = safeRemoteUrl(body.azure_base_url, 'azure_base_url');
        const apiKey = await readSecret(env, 'api_key_azure_openai', typeof body.secret_id === 'string' ? body.secret_id : undefined);
        return { baseUrl, apiKey, headers: new Headers(), kind: 'azure' };
    }
    if (source === 'workers_ai') {
        const accountId = requireString(body.workers_ai_account_id, 'workers_ai_account_id', 128);
        if (!/^[a-f0-9]{32}$/iu.test(accountId)) throw new HttpError(400, 'Invalid Workers AI account ID');
        const apiKey = await readSecret(env, 'api_key_workers_ai', typeof body.secret_id === 'string' ? body.secret_id : undefined);
        return { baseUrl: new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/`), apiKey, headers: new Headers(), kind: 'workers-ai' };
    }
    if (source === 'custom') {
        const baseUrl = safeRemoteUrl(body.custom_url, 'custom_url');
        const apiKey = await readSecret(env, 'api_key_custom', typeof body.secret_id === 'string' ? body.secret_id : undefined);
        return { baseUrl, apiKey, headers: customHeaders(body.custom_include_headers), kind: 'openai' };
    }
    const known = PROVIDERS[source];
    if (!known) throw new HttpError(400, `Unsupported chat completion source: ${source}`);
    const reverse = typeof body.reverse_proxy === 'string' && body.reverse_proxy ? safeRemoteUrl(body.reverse_proxy, 'reverse_proxy') : new URL(known.base);
    const apiKey = typeof body.reverse_proxy === 'string' && body.reverse_proxy
        ? String(body.proxy_password ?? '')
        : await readSecret(env, known.secret, typeof body.secret_id === 'string' ? body.secret_id : undefined);
    const headers = new Headers();
    if (source === 'openrouter') {
        headers.set('http-referer', 'https://github.com/ZUENS2020/SillyTavern-Serverless-Edition');
        headers.set('x-title', 'SillyTavern Serverless Edition');
    }
    return { baseUrl: reverse, apiKey, headers, kind: 'openai' };
}

function openAiBody(body: JsonObject): JsonObject {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(body)) if (OPENAI_FIELDS.has(key) && value !== undefined) result[key] = value;
    return result;
}

export function openRouterBody(body: JsonObject): JsonObject {
    const result = openAiBody(body);
    if (body.top_a !== undefined) result.top_a = body.top_a;
    if (body.repetition_penalty !== undefined) result.repetition_penalty = body.repetition_penalty;

    if (body.middleout === 'on') result.transforms = ['middle-out'];
    else if (body.middleout === 'off') result.transforms = [];
    else if (body.middleout === 'auto') delete result.transforms;

    const plugins = Array.isArray(body.plugins) ? [...body.plugins] : [];
    if (body.enable_web_search && !plugins.some(value => objectValue(value).id === 'web')) plugins.push({ id: 'web' });
    if (plugins.length > 0) result.plugins = plugins;

    const reasoning = objectValue(body.reasoning);
    const reasoningConfig: JsonObject = { ...reasoning };
    if (body.include_reasoning !== undefined) reasoningConfig.exclude = !Boolean(body.include_reasoning);
    if (body.reasoning_effort) reasoningConfig.effort = body.reasoning_effort;
    if (Object.keys(reasoningConfig).length > 0) result.reasoning = reasoningConfig;
    delete result.include_reasoning;

    const provider: JsonObject = Array.isArray(body.provider)
        ? (body.provider.length > 0 ? { allow_fallbacks: body.allow_fallbacks ?? true, order: body.provider } : {})
        : { ...objectValue(body.provider) };
    if (Array.isArray(body.quantizations) && body.quantizations.length > 0) provider.quantizations = body.quantizations;
    if (Object.keys(provider).length > 0) result.provider = provider;
    else delete result.provider;
    if (body.use_fallback) result.route = 'fallback';

    const jsonSchema = objectValue(body.json_schema);
    if (Object.keys(jsonSchema).length > 0) {
        result.response_format = {
            type: 'json_schema',
            json_schema: {
                name: jsonSchema.name,
                strict: jsonSchema.strict ?? true,
                schema: jsonSchema.value,
            },
        };
    }
    return result;
}

function anthropicBody(body: JsonObject): JsonObject {
    const sourceMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages: JsonObject[] = [];
    const system: unknown[] = [];
    for (const value of sourceMessages) {
        const message = objectValue(value);
        const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
        if (role === 'system') {
            if (typeof message.content === 'string') system.push({ type: 'text', text: message.content });
            else if (Array.isArray(message.content)) system.push(...message.content);
            continue;
        }
        messages.push({ role, content: message.content ?? '' });
    }
    const tools = Array.isArray(body.tools) ? body.tools.map(item => {
        const tool = objectValue(item);
        const fn = objectValue(tool.function);
        return { name: fn.name, description: fn.description, input_schema: fn.parameters ?? { type: 'object', properties: {} } };
    }) : undefined;
    const result: JsonObject = {
        model: body.model,
        messages,
        max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 1024,
        stream: Boolean(body.stream),
    };
    if (system.length > 0) result.system = system;
    if (body.temperature !== undefined) result.temperature = body.temperature;
    if (body.top_p !== undefined) result.top_p = body.top_p;
    if (body.top_k !== undefined) result.top_k = body.top_k;
    if (Array.isArray(body.stop)) result.stop_sequences = body.stop;
    if (tools && tools.length > 0) result.tools = tools;
    return result;
}

function geminiBody(body: JsonObject): JsonObject {
    const sourceMessages = Array.isArray(body.messages) ? body.messages : [];
    const contents: JsonObject[] = [];
    const systemParts: JsonObject[] = [];
    for (const value of sourceMessages) {
        const message = objectValue(value);
        const destination = message.role === 'system' ? systemParts : undefined;
        const content = message.content;
        const parts = typeof content === 'string' ? [{ text: content }] : Array.isArray(content)
            ? content.map(item => {
                const part = objectValue(item);
                return typeof part.text === 'string' ? { text: part.text } : part;
            })
            : [{ text: String(content ?? '') }];
        if (destination) destination.push(...parts);
        else contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
    const generationConfig: JsonObject = {};
    if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens;
    if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
    if (body.top_p !== undefined) generationConfig.topP = body.top_p;
    if (body.top_k !== undefined) generationConfig.topK = body.top_k;
    if (Array.isArray(body.stop)) generationConfig.stopSequences = body.stop;
    const result: JsonObject = { contents, generationConfig };
    if (systemParts.length > 0) result.systemInstruction = { parts: systemParts };
    return result;
}

async function modelStatus(env: Env, body: JsonObject, request: Request): Promise<Response> {
    const config = await providerConfig(env, body);
    if (config.kind === 'anthropic' || config.kind === 'azure' || config.kind === 'workers-ai') return json({ bypass: true, data: [] });
    let url: URL;
    if (config.kind === 'gemini') {
        url = endpoint(config.baseUrl, '/v1beta/models');
        if (config.apiKey) url.searchParams.set('key', config.apiKey);
    } else {
        url = endpoint(config.baseUrl, '/models');
    }
    const headers = new Headers(config.headers);
    headers.set('accept', 'application/json');
    if (config.apiKey && config.kind !== 'gemini') headers.set('authorization', `Bearer ${config.apiKey}`);
    const response = await fetch(url, { headers, signal: request.signal });
    if (config.kind !== 'gemini') return proxyResponse(response);
    const data = await response.json<JsonObject>();
    if (!response.ok) return json(data, { status: response.status });
    const models = Array.isArray(data.models) ? data.models.map(value => {
        const model = objectValue(value);
        const name = typeof model.name === 'string' ? model.name.replace(/^models\//u, '') : '';
        return { ...model, id: name };
    }) : [];
    return json({ data: models });
}

async function generate(env: Env, body: JsonObject, request: Request): Promise<Response> {
    const config = await providerConfig(env, body);
    if (!config.apiKey && !(typeof body.reverse_proxy === 'string' && body.reverse_proxy)) throw new HttpError(400, 'API key is missing');
    const headers = new Headers(config.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', body.stream ? 'text/event-stream, application/json' : 'application/json');
    let url: URL;
    let outbound: JsonObject;
    if (config.kind === 'anthropic') {
        url = endpoint(config.baseUrl, '/messages');
        headers.set('x-api-key', config.apiKey);
        headers.set('anthropic-version', '2023-06-01');
        outbound = anthropicBody(body);
    } else if (config.kind === 'gemini') {
        const model = requireString(body.model, 'model', 256).replace(/^models\//u, '');
        url = endpoint(config.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:${body.stream ? 'streamGenerateContent' : 'generateContent'}`);
        if (config.apiKey) url.searchParams.set('key', config.apiKey);
        if (body.stream) url.searchParams.set('alt', 'sse');
        outbound = geminiBody(body);
    } else if (config.kind === 'azure') {
        const deployment = requireString(body.azure_deployment_name, 'azure_deployment_name', 256);
        const version = typeof body.azure_api_version === 'string' && body.azure_api_version ? body.azure_api_version : '2024-10-21';
        url = endpoint(config.baseUrl, `/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`);
        url.searchParams.set('api-version', version);
        headers.set('api-key', config.apiKey);
        outbound = openAiBody(body);
        delete outbound.model;
    } else if (config.kind === 'workers-ai') {
        const model = requireString(body.model, 'model', 256);
        url = endpoint(config.baseUrl, model);
        headers.set('authorization', `Bearer ${config.apiKey}`);
        outbound = openAiBody(body);
    } else {
        const isText = typeof body.messages === 'string' || typeof body.prompt === 'string' && !Array.isArray(body.messages);
        url = endpoint(config.baseUrl, isText ? '/completions' : '/chat/completions');
        if (body.chat_completion_source === 'openrouter') url = endpoint(config.baseUrl, '/chat/completions');
        if (config.apiKey) headers.set('authorization', `Bearer ${config.apiKey}`);
        outbound = body.chat_completion_source === 'openrouter' ? openRouterBody(body) : openAiBody(body);
    }
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(outbound),
        signal: request.signal,
    });
    return proxyResponse(response);
}

const TEXTGEN_SECRETS: Record<string, string> = {
    ooba: 'api_key_ooba', mancer: 'api_key_mancer', vllm: 'api_key_vllm', aphrodite: 'api_key_aphrodite',
    tabby: 'api_key_tabby', koboldcpp: 'api_key_koboldcpp', togetherai: 'api_key_togetherai',
    llamacpp: 'api_key_llamacpp', infermaticai: 'api_key_infermaticai', dreamgen: 'api_key_dreamgen',
    openrouter: 'api_key_openrouter', featherless: 'api_key_featherless', huggingface: 'api_key_huggingface',
    generic: 'api_key_generic',
};

async function textGenerationProxy(env: Env, request: Request, status: boolean): Promise<Response> {
    const body = await readJson(request, maxJsonBytes(env) * 4);
    const apiType = typeof body.api_type === 'string' ? body.api_type : 'generic';
    const base = safeRemoteUrl(body.api_server, 'api_server');
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    if (apiType === 'openrouter') {
        headers.set('http-referer', 'https://github.com/ZUENS2020/SillyTavern-Serverless-Edition');
        headers.set('x-title', 'SillyTavern Serverless Edition');
    }
    const secret = TEXTGEN_SECRETS[apiType];
    if (secret) {
        const key = await readSecret(env, secret, typeof body.secret_id === 'string' ? body.secret_id : undefined);
        if (key) headers.set('authorization', `Bearer ${key}`);
    }
    let path: string;
    if (status) {
        path = apiType === 'ollama' ? '/api/tags' : apiType === 'tabby' ? '/v1/model/list' : '/v1/models';
    } else {
        path = apiType === 'ollama' ? '/api/generate'
            : apiType === 'llamacpp' ? '/completion'
                : apiType === 'openrouter' ? '/v1/chat/completions'
                    : '/v1/completions';
    }
    const url = endpoint(base, path);
    const outbound = apiType === 'openrouter' ? openRouterBody(body) : openAiBody(body);
    const response = await fetch(url, status
        ? { method: 'GET', headers, signal: request.signal }
        : { method: 'POST', headers, body: JSON.stringify(outbound), signal: request.signal });
    if (!status) return proxyResponse(response);
    if (!response.ok) return proxyResponse(response);
    const data = await response.json<JsonObject>();
    const models = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const normalized = models.map(value => {
        const model = objectValue(value);
        return { ...model, id: model.id ?? model.name };
    });
    return json({ result: objectValue(normalized[0]).id ?? 'Valid', data: normalized });
}

async function koboldGenerate(env: Env, request: Request): Promise<Response> {
    const body = await readJson(request, maxJsonBytes(env) * 4);
    const base = safeRemoteUrl(body.api_server, 'api_server');
    const outbound: JsonObject = {
        prompt: body.prompt,
        use_story: false,
        use_memory: false,
        use_authors_note: false,
        use_world_info: false,
        max_context_length: body.max_context_length,
        max_length: body.max_length,
    };
    for (const key of ['rep_pen', 'rep_pen_range', 'rep_pen_slope', 'temperature', 'tfs', 'top_a', 'top_k', 'top_p', 'min_p', 'typical', 'sampler_order', 'singleline', 'mirostat', 'mirostat_eta', 'mirostat_tau', 'grammar', 'sampler_seed', 'stop_sequence']) {
        if (body[key] !== undefined) outbound[key] = body[key];
    }
    const headers = new Headers({ 'content-type': 'application/json' });
    const key = await readSecret(env, 'api_key_koboldcpp');
    if (key) headers.set('authorization', `Bearer ${key}`);
    const url = endpoint(base, body.streaming ? '/extra/generate/stream' : '/v1/generate');
    return proxyResponse(await fetch(url, { method: 'POST', headers, body: JSON.stringify(outbound), signal: request.signal }));
}

async function koboldEmbed(env: Env, request: Request): Promise<Response> {
    const body = await readJson(request, maxJsonBytes(env) * 4);
    const base = safeRemoteUrl(body.server, 'server');
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
        throw new HttpError(400, 'items must be an array with at most 100 entries');
    }
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    const key = await readSecret(env, 'api_key_koboldcpp');
    if (key) headers.set('authorization', `Bearer ${key}`);
    const response = await fetch(endpoint(base, '/api/extra/embeddings'), {
        method: 'POST', headers, body: JSON.stringify({ input: body.items }), signal: request.signal,
    });
    if (!response.ok) return proxyResponse(response);
    const data = await response.json<JsonObject>();
    if (!Array.isArray(data.data)) throw new HttpError(502, 'KoboldCpp returned no embeddings');
    const rows = data.data.map(value => Array.isArray(value) ? objectValue(value[0]) : objectValue(value));
    rows.sort((left, right) => numberValue(left.index) - numberValue(right.index));
    const embeddings = rows.map(row => row.embedding).filter(Array.isArray);
    if (embeddings.length !== rows.length) throw new HttpError(502, 'KoboldCpp returned invalid embeddings');
    return json({ model: typeof data.model === 'string' ? data.model : 'unknown', embeddings });
}

function numberValue(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function ollamaCaption(request: Request, env: Env): Promise<Response> {
    const body = await readJson(request, maxJsonBytes(env) * 4);
    const base = safeRemoteUrl(body.server_url, 'server_url');
    const model = requireString(body.model, 'model', 256);
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    const key = await readSecret(env, 'api_key_ollama');
    if (key) headers.set('authorization', `Bearer ${key}`);
    const response = await fetch(endpoint(base, '/api/generate'), {
        method: 'POST', headers, signal: request.signal,
        body: JSON.stringify({ model, prompt: body.prompt, images: [body.image], stream: false }),
    });
    if (!response.ok) return proxyResponse(response);
    const data = await response.json<JsonObject>();
    if (typeof data.response !== 'string' || !data.response) throw new HttpError(502, 'Ollama returned no caption');
    return json({ caption: data.response });
}

async function modelDownload(request: Request, env: Env, provider: 'ollama' | 'tabby'): Promise<Response> {
    const body = await readJson(request, maxJsonBytes(env));
    const base = safeRemoteUrl(body.api_server, 'api_server');
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    const secretName = provider === 'ollama' ? 'api_key_ollama' : 'api_key_tabby';
    const key = await readSecret(env, secretName);
    if (key) headers.set('authorization', `Bearer ${key}`);
    if (provider === 'tabby') {
        const permission = await fetch(endpoint(base, '/v1/auth/permission'), { headers, signal: request.signal });
        if (!permission.ok) return proxyResponse(permission);
        const permissionData = await permission.json<JsonObject>();
        if (permissionData.permission !== 'admin') throw new HttpError(403, 'Tabby admin permission is required');
    }
    const url = endpoint(base, provider === 'ollama' ? '/api/pull' : '/v1/download');
    const outbound = provider === 'ollama'
        ? { name: requireString(body.name, 'name', 256), stream: false }
        : body;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(outbound), signal: request.signal });
    if (!response.ok) return proxyResponse(response);
    // Do not buffer a potentially large progress response; model bytes remain provider-to-provider.
    return json({ ok: true });
}

export function registerProviderRoutes(router: Router): void {
    router.on('POST', '/api/backends/chat-completions/status', ({ request, env }) => readJson(request, 262_144).then(body => modelStatus(env, body, request)));
    router.on('POST', '/api/backends/chat-completions/generate', ({ request, env }) => readJson(request, maxJsonBytes(env) * 4).then(body => generate(env, body, request)));
    router.on('POST', '/api/backends/chat-completions/bias', () => json({}));
    router.on('POST', '/api/backends/chat-completions/process', async ({ request, env }) => json(await readJson(request, maxJsonBytes(env))));
    router.on('POST', '/api/backends/text-completions/status', ({ request, env }) => textGenerationProxy(env, request, true));
    router.on('POST', '/api/backends/text-completions/generate', ({ request, env }) => textGenerationProxy(env, request, false));
    router.on('POST', '/api/backends/text-completions/props', async ({ request }) => {
        const body = await readJson(request, 65_536);
        const base = safeRemoteUrl(body.api_server, 'api_server');
        return proxyResponse(await fetch(endpoint(base, '/props'), { signal: request.signal }));
    });
    router.on('POST', '/api/backends/kobold/generate', ({ request, env }) => koboldGenerate(env, request));
    router.on('POST', '/api/backends/kobold/embed', ({ request, env }) => koboldEmbed(env, request));
    router.on('POST', '/api/backends/kobold/status', async ({ request }) => {
        const body = await readJson(request, 65_536);
        const base = safeRemoteUrl(body.api_server, 'api_server');
        const response = await fetch(endpoint(base, '/v1/model'), { signal: request.signal });
        if (!response.ok) return json({ model: 'no_connection', koboldUnitedVersion: '0.0.0', koboldCppVersion: '0.0' });
        const data = await response.json<JsonObject>();
        return json({ model: data.result ?? 'Valid', koboldUnitedVersion: '0.0.0', koboldCppVersion: '0.0' });
    });
    router.on('POST', '/api/backends/text-completions/ollama/caption-image', ({ request, env }) => ollamaCaption(request, env));
    router.on('POST', '/api/backends/text-completions/ollama/download', ({ request, env }) => modelDownload(request, env, 'ollama'));
    router.on('POST', '/api/backends/text-completions/tabby/download', ({ request, env }) => modelDownload(request, env, 'tabby'));
}
