import { HttpError, json, maxJsonBytes, readJson, requireString, text } from '../http';
import type { Router } from '../router';
import { readSecret } from '../storage/secrets';
import { proxyResponse, safeRemoteUrl } from './providers';

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function language(value: unknown): string {
    const lang = requireString(value, 'lang', 32);
    if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?$/u.test(lang)) throw new HttpError(400, 'Invalid language');
    return lang;
}

async function lingvaTranslate(env: Env, body: JsonObject): Promise<Response> {
    const sourceText = requireString(body.text, 'text', 200_000);
    const lang = language(body.lang).replace(/^zh-(?:CN|TW)$/iu, 'zh').replace(/^pt-(?:BR|PT)$/iu, 'pt');
    const configured = await readSecret(env, 'lingva_url');
    const base = configured ? safeRemoteUrl(configured, 'lingva_url') : new URL('https://lingva.ml/api/v1/');
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/auto/${encodeURIComponent(lang)}/${encodeURIComponent(sourceText)}`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return proxyResponse(response);
    const data = objectValue(await response.json());
    return text(typeof data.translation === 'string' ? data.translation : '');
}

async function translationRoute(kind: string, env: Env, request: Request): Promise<Response> {
    const body = await readJson(request, maxJsonBytes(env));
    if (kind === 'google' || kind === 'bing' || kind === 'lingva') return lingvaTranslate(env, body);
    const sourceText = kind === 'yandex' && Array.isArray(body.chunks)
        ? body.chunks.filter((value): value is string => typeof value === 'string').join('')
        : requireString(body.text, 'text', 200_000);
    if (!sourceText) throw new HttpError(400, 'Missing text');
    if (kind === 'libre') {
        const configured = await readSecret(env, 'libre_url');
        if (!configured) throw new HttpError(400, 'LibreTranslate URL is not configured');
        const key = await readSecret(env, 'libre');
        const response = await fetch(safeRemoteUrl(configured, 'libre_url'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ q: sourceText, source: 'auto', target: language(body.lang), format: 'text', api_key: key }),
        });
        if (!response.ok) return proxyResponse(response);
        const data = objectValue(await response.json());
        return text(typeof data.translatedText === 'string' ? data.translatedText : '');
    }
    if (kind === 'deepl') {
        const key = await readSecret(env, 'deepl');
        if (!key) throw new HttpError(400, 'DeepL key is not configured');
        const params = new URLSearchParams({ text: sourceText, target_lang: language(body.lang) });
        const url = body.endpoint === 'pro' ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate';
        const response = await fetch(url, {
            method: 'POST',
            headers: { authorization: `DeepL-Auth-Key ${key}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: params,
        });
        if (!response.ok) return proxyResponse(response);
        const data = objectValue(await response.json());
        const translations = Array.isArray(data.translations) ? data.translations : [];
        const first = objectValue(translations[0]);
        return text(typeof first.text === 'string' ? first.text : '');
    }
    if (kind === 'deeplx') {
        const configured = await readSecret(env, 'deeplx_url');
        if (!configured) throw new HttpError(400, 'DeepLX URL is not configured');
        const response = await fetch(safeRemoteUrl(configured, 'deeplx_url'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ text: sourceText, source_lang: 'auto', target_lang: language(body.lang) }),
        });
        if (!response.ok) return proxyResponse(response);
        const data = objectValue(await response.json());
        return text(typeof data.data === 'string' ? data.data : '');
    }
    if (kind === 'onering') {
        const configured = await readSecret(env, 'oneringtranslator_url');
        if (!configured) throw new HttpError(400, 'OneRing URL is not configured');
        const url = safeRemoteUrl(configured, 'oneringtranslator_url');
        url.searchParams.set('text', sourceText);
        url.searchParams.set('from_lang', requireString(body.from_lang, 'from_lang', 32));
        url.searchParams.set('to_lang', requireString(body.to_lang, 'to_lang', 32));
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) return proxyResponse(response);
        const data = objectValue(await response.json());
        return text(typeof data.result === 'string' ? data.result : '');
    }
    if (kind === 'yandex') {
        const chunks = Array.isArray(body.chunks) ? body.chunks.filter((value): value is string => typeof value === 'string') : [sourceText];
        const params = new URLSearchParams({ lang: language(body.lang), format: 'text', srv: 'android' });
        for (const chunk of chunks) params.append('text', chunk);
        const response = await fetch('https://translate.yandex.net/api/v1/tr.json/translate', {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params,
        });
        if (!response.ok) return proxyResponse(response);
        const data = objectValue(await response.json());
        return text(Array.isArray(data.text) ? data.text.filter((value): value is string => typeof value === 'string').join('') : '');
    }
    throw new HttpError(404, 'Translation provider not found');
}

async function keyedSearch(env: Env, request: Request, provider: string): Promise<Response> {
    const body = await readJson(request, maxJsonBytes(env));
    const query = requireString(body.query, 'query', 8_192);
    let url: string;
    let headers: HeadersInit = { 'content-type': 'application/json', accept: 'application/json' };
    let outbound: JsonObject;
    if (provider === 'serpapi') {
        const key = await readSecret(env, 'api_key_serpapi');
        if (!key) throw new HttpError(400, 'SerpApi key is missing');
        const endpoint = new URL('https://serpapi.com/search.json');
        endpoint.searchParams.set('q', query);
        endpoint.searchParams.set('api_key', key);
        return proxyResponse(await fetch(endpoint, { signal: request.signal }));
    }
    if (provider === 'tavily') {
        const key = await readSecret(env, 'api_key_tavily');
        if (!key) throw new HttpError(400, 'Tavily key is missing');
        url = 'https://api.tavily.com/search';
        outbound = { query, api_key: key, search_depth: 'basic', topic: 'general', include_answer: true, include_raw_content: false, include_images: Boolean(body.include_images), max_results: 10 };
    } else if (provider === 'serper') {
        const key = await readSecret(env, 'api_key_serper');
        if (!key) throw new HttpError(400, 'Serper key is missing');
        url = body.images ? 'https://google.serper.dev/images' : 'https://google.serper.dev/search';
        headers = { ...headers, 'x-api-key': key };
        outbound = { q: query };
    } else if (provider === 'zai') {
        const key = await readSecret(env, 'api_key_zai');
        if (!key) throw new HttpError(400, 'Z.AI key is missing');
        url = 'https://api.z.ai/api/paas/v4/web_search';
        headers = { ...headers, authorization: `Bearer ${key}` };
        outbound = { search_engine: 'search-prime', search_query: query };
    } else throw new HttpError(404, 'Search provider not found');
    return proxyResponse(await fetch(url, { method: 'POST', headers, body: JSON.stringify(outbound), signal: request.signal }));
}

export function registerExternalRoutes(router: Router): void {
    for (const provider of ['libre', 'google', 'yandex', 'lingva', 'deepl', 'onering', 'deeplx', 'bing']) {
        router.on('POST', `/api/translate/${provider}`, ({ request, env }) => translationRoute(provider, env, request));
    }
    for (const provider of ['serpapi', 'tavily', 'serper', 'zai']) {
        router.on('POST', `/api/search/${provider}`, ({ request, env }) => keyedSearch(env, request, provider));
    }
    router.on('POST', '/api/search/searxng', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const base = safeRemoteUrl(body.baseUrl, 'baseUrl');
        const url = new URL('/search', base);
        url.searchParams.set('q', requireString(body.query, 'query', 8_192));
        if (typeof body.preferences === 'string') url.searchParams.set('preferences', body.preferences);
        if (typeof body.categories === 'string') url.searchParams.set('categories', body.categories);
        return proxyResponse(await fetch(url, { headers: { accept: 'text/html, application/json' }, signal: request.signal }));
    });
    router.on('POST', '/api/search/koboldcpp', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const base = safeRemoteUrl(body.url, 'url');
        const url = new URL(base);
        url.pathname = `${url.pathname.replace(/\/(?:v1)?\/?$/u, '')}/api/extra/websearch`;
        return proxyResponse(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: body.query }), signal: request.signal }));
    });
    router.on('POST', '/api/search/visit', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const url = safeRemoteUrl(body.url, 'url');
        const response = await fetch(url, {
            headers: { accept: body.html === false ? '*/*' : 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; SillyTavern-Serverless/1.0)' },
            signal: request.signal,
        });
        if (!response.ok) return proxyResponse(response);
        if (body.html !== false && !(response.headers.get('content-type') ?? '').includes('text/html')) throw new HttpError(415, 'Visited URL is not HTML');
        return proxyResponse(response);
    });
    router.on('POST', '/api/search/transcript', () => json({ error: 'YouTube transcript extraction is unavailable in the free-CPU profile' }, { status: 501 }));
}
