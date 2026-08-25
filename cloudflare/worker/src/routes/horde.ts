import { HttpError, json, maxJsonBytes, readJson, requireString, text } from '../http';
import type { RouteContext, Router } from '../router';
import { readSecret } from '../storage/secrets';
import { proxyResponse } from './providers';

type JsonObject = Record<string, unknown>;

const BASE = 'https://aihorde.net/api/v2';
const ANONYMOUS_KEY = '0000000000';
const CLIENT_AGENT = 'SillyTavern-Serverless-Edition:1.18.0:ZUENS2020';
const SD_SAMPLERS = ['k_euler', 'k_euler_a', 'k_heun', 'k_dpm_2', 'k_dpm_2_a', 'k_lms', 'k_dpm_fast', 'k_dpm_adaptive', 'k_dpmpp_2s_a', 'k_dpmpp_2m', 'dpmsolver', 'DDIM', 'plms'];

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

async function key(env: Env): Promise<string> {
    return await readSecret(env, 'api_key_horde') || ANONYMOUS_KEY;
}

function headers(apiKey?: string): Headers {
    const result = new Headers({ accept: 'application/json', 'client-agent': CLIENT_AGENT });
    if (apiKey) result.set('apikey', apiKey);
    return result;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
        }, { once: true });
    });
}

async function taskRoute(context: RouteContext, operation: 'cancel' | 'status'): Promise<Response> {
    const body = await readJson(context.request, 32_768);
    const taskId = requireString(body.taskId, 'taskId', 128);
    return proxyResponse(await fetch(`${BASE}/generate/text/status/${encodeURIComponent(taskId)}`, {
        method: operation === 'cancel' ? 'DELETE' : 'GET', headers: headers(), signal: context.request.signal,
    }));
}

function sanitizedPrompt(source: string): string {
    return source
        .replace(/\b(?:girl|boy|girls|boys)\b/giu, match => ({ girl: 'woman', boy: 'man', girls: 'women', boys: 'men' })[match.toLowerCase()] ?? 'person')
        .replace(/\b(?:under.?age|loli|pedo(?:phile)?|minor|prepubescent|shota|infant|baby|toddler|child|teen|kid)\w*\b/giu, 'person')
        .slice(0, 4_500);
}

async function hordeImage(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env));
    const prompt = requireString(body.prompt, 'prompt', 5_000);
    const negative = typeof body.negative_prompt === 'string' ? body.negative_prompt.slice(0, 500) : '';
    const submitHeaders = headers(await key(context.env));
    submitHeaders.set('content-type', 'application/json');
    const submit = await fetch(`${BASE}/generate/async`, {
        method: 'POST',
        headers: submitHeaders,
        body: JSON.stringify({
            prompt: `${body.sanitize ? sanitizedPrompt(prompt) : prompt} ### ${negative}`,
            params: {
                sampler_name: body.sampler, hires_fix: Boolean(body.enable_hr), use_gfpgan: Boolean(body.restore_faces),
                cfg_scale: body.scale, steps: body.steps, width: body.width, height: body.height,
                clip_skip: body.clip_skip, seed: typeof body.seed === 'number' && body.seed >= 0 ? String(body.seed) : undefined, n: 1,
            },
            r2: false, nsfw: Boolean(body.nsfw), models: [body.model],
        }),
        signal: context.request.signal,
    });
    const accepted = objectValue(await submit.json().catch(() => ({})));
    if (!submit.ok || typeof accepted.id !== 'string') return json(accepted, { status: submit.status || 502 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await delay(3_000, context.request.signal);
        const check = objectValue(await fetch(`${BASE}/generate/check/${encodeURIComponent(accepted.id)}`, { headers: headers(), signal: context.request.signal }).then(response => response.json()));
        if (check.faulted) throw new HttpError(502, 'AI Horde image task failed');
        if (!check.done) continue;
        const result = objectValue(await fetch(`${BASE}/generate/status/${encodeURIComponent(accepted.id)}`, { headers: headers(), signal: context.request.signal }).then(response => response.json()));
        const generation = objectValue(Array.isArray(result.generations) ? result.generations[0] : undefined);
        if (typeof generation.img !== 'string') throw new HttpError(502, 'AI Horde returned no image');
        return text(generation.img);
    }
    throw new HttpError(504, 'AI Horde image task timed out');
}

async function hordeTextSubmit(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const outboundHeaders = headers(await key(context.env));
    outboundHeaders.set('content-type', 'application/json');
    return proxyResponse(await fetch(`${BASE}/generate/text/async`, {
        method: 'POST', headers: outboundHeaders, body: JSON.stringify(body), signal: context.request.signal,
    }));
}

async function hordeCaption(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const image = requireString(body.image, 'image', maxJsonBytes(context.env) * 4);
    const outboundHeaders = headers(await key(context.env));
    outboundHeaders.set('content-type', 'application/json');
    const submit = await fetch(`${BASE}/interrogate/async`, {
        method: 'POST', headers: outboundHeaders, body: JSON.stringify({ source_image: image, forms: [{ name: 'caption' }] }),
        signal: context.request.signal,
    });
    const accepted = objectValue(await submit.json().catch(() => ({})));
    if (!submit.ok || typeof accepted.id !== 'string') return json(accepted, { status: submit.status || 502 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await delay(3_000, context.request.signal);
        const response = await fetch(`${BASE}/interrogate/status/${encodeURIComponent(accepted.id)}`, {
            headers: headers(), signal: context.request.signal,
        });
        const status = objectValue(await response.json().catch(() => ({})));
        if (!response.ok) return json(status, { status: response.status });
        if (status.state === 'faulted' || status.state === 'cancelled') throw new HttpError(503, 'AI Horde caption task failed');
        if (status.state !== 'done') continue;
        const form = objectValue(Array.isArray(status.forms) ? status.forms[0] : undefined);
        const caption = objectValue(form.result).caption;
        if (typeof caption !== 'string' || !caption) throw new HttpError(502, 'AI Horde returned no caption');
        return json({ caption });
    }
    throw new HttpError(504, 'AI Horde caption task timed out');
}

export function registerHordeRoutes(router: Router): void {
    router.on('POST', '/api/horde/text-workers', async ({ request }) => proxyResponse(await fetch(`${BASE}/workers?type=text`, { headers: headers(), signal: request.signal })));
    router.on('POST', '/api/horde/text-models', async ({ request }) => proxyResponse(await fetch(`${BASE}/status/models?type=text`, { headers: headers(), signal: request.signal })));
    router.on('POST', '/api/horde/status', async ({ request }) => {
        const response = await fetch(`${BASE}/status/heartbeat`, { headers: headers(), signal: request.signal });
        return json({ ok: response.ok });
    });
    router.on('POST', '/api/horde/cancel-task', context => taskRoute(context, 'cancel'));
    router.on('POST', '/api/horde/task-status', context => taskRoute(context, 'status'));
    router.on('POST', '/api/horde/generate-text', hordeTextSubmit);
    router.on('POST', '/api/backends/koboldhorde/generate', hordeTextSubmit);
    router.on('POST', '/api/horde/sd-samplers', () => json(SD_SAMPLERS));
    router.on('POST', '/api/horde/sd-models', async ({ request }) => proxyResponse(await fetch(`${BASE}/status/models?type=image`, { headers: headers(), signal: request.signal })));
    router.on('POST', '/api/horde/user-info', async ({ request, env }) => {
        const apiKey = await readSecret(env, 'api_key_horde');
        if (!apiKey) return json({ anonymous: true });
        const response = await fetch(`${BASE}/find_user`, { headers: headers(apiKey), signal: request.signal });
        if (!response.ok) return proxyResponse(response);
        return json({ user: await response.json(), sharedKey: null, anonymous: false });
    });
    router.on('POST', '/api/horde/caption-image', hordeCaption);
    router.on('POST', '/api/horde/generate-image', hordeImage);
}
