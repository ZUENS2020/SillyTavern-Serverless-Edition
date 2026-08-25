import { HttpError, json, maxJsonBytes, readJson, readJsonValue } from '../http';
import type { Router } from '../router';
import { safeRemoteUrl } from './providers';

type JsonObject = Record<string, unknown>;

const BYTES_PER_TOKEN = 3.35;

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function estimate(value: unknown): number {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return Math.ceil(new TextEncoder().encode(text).byteLength / BYTES_PER_TOKEN);
}

function tokenId(chunk: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < chunk.length; index += 1) {
        hash ^= chunk.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
}

function approximateEncoding(text: string): { ids: number[]; count: number; chunks: string[]; approximate: true } {
    const count = estimate(text);
    if (text.length > 65_536) return { ids: [], count, chunks: [], approximate: true };
    const pieces = text.match(/\s+|[^\s]{1,4}/gu) ?? [];
    const chunks = pieces.slice(0, 16_384);
    return { ids: chunks.map(tokenId), count, chunks, approximate: true };
}

function appendPath(base: URL, path: string): URL {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/(?:v1)?\/?$/u, '')}/${path.replace(/^\/+/, '')}`;
    url.search = '';
    return url;
}

async function remoteCount(request: Request, env: Env, textgen: boolean): Promise<Response> {
    const body = await readJson(request, maxJsonBytes(env));
    const base = safeRemoteUrl(body.url, 'url');
    const text = typeof body.text === 'string' ? body.text : '';
    const apiType = typeof body.api_type === 'string' ? body.api_type : '';
    let path: string;
    let outbound: JsonObject;
    if (!textgen || apiType === 'koboldcpp') {
        path = textgen ? '/api/extra/tokencount' : '/extra/tokencount';
        outbound = { prompt: text, special: false };
    } else if (apiType === 'tabby') {
        path = '/v1/token/encode';
        outbound = { text, add_bos_token: false, encode_special_tokens: false };
    } else if (apiType === 'llamacpp') {
        path = '/tokenize';
        outbound = { model: body.model, content: text };
    } else if (apiType === 'vllm') {
        path = '/tokenize';
        outbound = { model: body.model, prompt: text };
    } else if (apiType === 'aphrodite') {
        path = '/v1/tokenize';
        outbound = { model: body.model, prompt: text };
    } else {
        path = '/v1/internal/encode';
        outbound = { text };
    }
    const response = await fetch(appendPath(base, path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(outbound),
        signal: request.signal,
    });
    if (!response.ok) return json({ error: true }, { status: response.status });
    const data = objectValue(await response.json());
    const ids = Array.isArray(data.tokens) ? data.tokens : Array.isArray(data.ids) ? data.ids : [];
    const countValue = typeof data.length === 'number' ? data.length : typeof data.count === 'number' ? data.count : typeof data.value === 'number' ? data.value : ids.length;
    return json({ count: countValue, ids });
}

export function registerTokenizerRoutes(router: Router): void {
    router.on('POST', '/api/tokenizers/openai/count', async ({ request, env }) => {
        const body = await readJsonValue(request, maxJsonBytes(env));
        return json({ token_count: estimate(body), approximate: true });
    });
    router.on('POST', '/api/tokenizers/remote/kobold/count', ({ request, env }) => remoteCount(request, env, false));
    router.on('POST', '/api/tokenizers/remote/textgenerationwebui/encode', ({ request, env }) => remoteCount(request, env, true));
    router.on('POST', '/api/tokenizers/:tokenizer/:operation', async ({ request, env, params }) => {
        const body = await readJson(request, maxJsonBytes(env));
        if (params.operation === 'encode') {
            const source = typeof body.text === 'string' ? body.text : '';
            return json(approximateEncoding(source));
        }
        if (params.operation === 'decode') {
            return json({ text: '', chunks: [], approximate: true });
        }
        throw new HttpError(404, 'Tokenizer operation not found');
    });
}
