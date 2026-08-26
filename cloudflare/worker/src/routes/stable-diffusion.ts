import defaultComfyWorkflow from '../../../../default/content/Default_Comfy_Workflow.json';
import characterComfyWorkflow from '../../../../default/content/Char_Avatar_Comfy_Workflow.json';
import { empty, HttpError, json, maxJsonBytes, maxUploadBytes, readJson, requireString, safeName } from '../http';
import type { RouteContext, Router } from '../router';
import { readSecret } from '../storage/secrets';
import { proxyResponse, safeRemoteUrl } from './providers';

type JsonObject = Record<string, unknown>;

const DEFAULT_WORKFLOW = 'Default_Comfy_Workflow.json';
const CHARACTER_WORKFLOW = 'Char_Avatar_Comfy_Workflow.json';

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function remote(body: JsonObject, pathname: string): URL {
    const url = safeRemoteUrl(body.url, 'url');
    url.pathname = pathname;
    url.search = '';
    return url;
}

function authorization(body: JsonObject): Headers {
    const headers = new Headers({ accept: 'application/json' });
    if (typeof body.auth === 'string' && body.auth) headers.set('authorization', `Basic ${btoa(body.auth)}`);
    return headers;
}

async function jsonData(response: Response): Promise<unknown> {
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new HttpError(response.status, `Stable Diffusion service returned ${response.status}`);
    return data;
}

async function sdList(context: RouteContext, operation: 'upscalers' | 'vaes' | 'samplers' | 'schedulers' | 'models'): Promise<Response> {
    const body = await readJson(context.request, 65_536);
    const headers = authorization(body);
    if (operation === 'upscalers') {
        const [upscalers, latent] = await Promise.all([
            fetch(remote(body, '/sdapi/v1/upscalers'), { headers, redirect: 'error', signal: context.request.signal }).then(jsonData),
            fetch(remote(body, '/sdapi/v1/latent-upscale-modes'), { headers, redirect: 'error', signal: context.request.signal }).then(jsonData).catch(() => []),
        ]);
        const first = Array.isArray(upscalers) ? upscalers.map(item => objectValue(item).name).filter((name): name is string => typeof name === 'string') : [];
        const second = Array.isArray(latent) ? latent.map(item => objectValue(item).name).filter((name): name is string => typeof name === 'string') : [];
        first.splice(Math.min(1, first.length), 0, ...second);
        return json(first);
    }
    const paths = { vaes: '/sdapi/v1/sd-vae', samplers: '/sdapi/v1/samplers', schedulers: '/sdapi/v1/schedulers', models: '/sdapi/v1/sd-models' } as const;
    const data = await fetch(remote(body, paths[operation]), { headers, redirect: 'error', signal: context.request.signal }).then(jsonData);
    if (!Array.isArray(data)) throw new HttpError(502, 'Stable Diffusion service returned an invalid list');
    if (operation === 'models') return json(data.map(item => {
        const value = objectValue(item);
        const title = typeof value.title === 'string' ? value.title : String(value.model_name ?? '');
        return { value: title, text: title };
    }));
    const field = operation === 'vaes' ? 'model_name' : 'name';
    return json(data.map(item => objectValue(item)[field]).filter((name): name is string => typeof name === 'string'));
}

async function sdOperation(context: RouteContext, operation: 'ping' | 'get-model' | 'set-model' | 'generate'): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const headers = authorization(body);
    if (operation === 'ping' || operation === 'get-model') {
        const data = objectValue(await fetch(remote(body, '/sdapi/v1/options'), { headers, redirect: 'error', signal: context.request.signal }).then(jsonData));
        return operation === 'ping' ? empty(200) : json(data.sd_model_checkpoint ?? '');
    }
    headers.set('content-type', 'application/json');
    if (operation === 'set-model') {
        const response = await fetch(remote(body, '/sdapi/v1/options'), {
            method: 'POST', headers, body: JSON.stringify({ sd_model_checkpoint: requireString(body.model, 'model', 256) }), redirect: 'error', signal: context.request.signal,
        });
        if (!response.ok) return proxyResponse(response);
        return empty(200);
    }
    const outbound: JsonObject = {};
    for (const [key, value] of Object.entries(body)) if (key !== 'url' && key !== 'auth') outbound[key] = value;
    return proxyResponse(await fetch(remote(body, '/sdapi/v1/txt2img'), {
        method: 'POST', headers, body: JSON.stringify(outbound), redirect: 'error', signal: context.request.signal,
    }));
}

function compact(body: JsonObject, omitted: readonly string[] = []): JsonObject {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(body)) {
        if (!omitted.includes(key) && value !== undefined && value !== null && value !== '') result[key] = value;
    }
    return result;
}

async function secret(env: Env, key: string): Promise<string> {
    const value = await readSecret(env, key);
    if (!value) throw new HttpError(400, `Missing ${key}`);
    return value;
}

async function checkedJson(response: Response, service: string): Promise<unknown> {
    if (!response.ok) throw new HttpError(502, `${service} returned ${response.status}`);
    const value: unknown = await response.json().catch(() => null);
    if (value === null) throw new HttpError(502, `${service} returned invalid JSON`);
    return value;
}

function extensionFor(contentType: string | null, fallback = 'png'): string {
    const type = String(contentType ?? '').split(';')[0]?.trim().toLowerCase();
    const extensions: Record<string, string> = {
        'image/avif': 'avif', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/png': 'png',
        'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm',
    };
    const normalizedFallback = fallback.replace(/[^a-z0-9]/giu, '').toLowerCase();
    return (type ? extensions[type] : undefined) ?? (normalizedFallback || 'bin');
}

function streamGeneratedMedia(context: RouteContext, response: Response, fallback = 'png'): Response {
    if (!response.ok || !response.body) throw new HttpError(502, `Image provider returned ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > maxUploadBytes(context.env)) throw new HttpError(413, 'Generated media exceeds the configured size limit');
    const headers = new Headers(response.headers);
    if (!headers.has('content-type')) headers.set('content-type', `image/${fallback}`);
    headers.set('x-st-media-format', extensionFor(headers.get('content-type'), fallback));
    return proxyResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}

function workflowName(value: unknown, field = 'file_name'): string {
    const name = safeName(value, field, 180);
    if (!name.toLowerCase().endsWith('.json')) throw new HttpError(400, 'Only JSON workflow files are allowed');
    return name;
}

function builtInWorkflow(name: string): string | null {
    if (name === DEFAULT_WORKFLOW) return JSON.stringify(defaultComfyWorkflow);
    if (name === CHARACTER_WORKFLOW) return JSON.stringify(characterComfyWorkflow);
    return null;
}

async function comfyInfo(context: RouteContext, operation: 'ping' | 'samplers' | 'models' | 'schedulers' | 'vaes'): Promise<Response> {
    const body = await readJson(context.request, 65_536);
    if (operation === 'ping') {
        const response = await fetch(remote(body, '/system_stats'), { redirect: 'error', signal: context.request.signal });
        if (!response.ok) throw new HttpError(502, `ComfyUI returned ${response.status}`);
        return empty(200);
    }
    const info = objectValue(await fetch(remote(body, '/object_info'), { redirect: 'error', signal: context.request.signal }).then(response => checkedJson(response, 'ComfyUI')));
    const sampler = objectValue(objectValue(objectValue(info.KSampler).input).required);
    if (operation === 'samplers' || operation === 'schedulers') {
        const value = sampler[operation === 'samplers' ? 'sampler_name' : 'scheduler'];
        return json(Array.isArray(value) && Array.isArray(value[0]) ? value[0] : []);
    }
    if (operation === 'vaes') {
        const required = objectValue(objectValue(objectValue(info.VAELoader).input).required);
        const value = required.vae_name;
        return json(Array.isArray(value) && Array.isArray(value[0]) ? value[0] : []);
    }
    const modelValues: Array<{ value: string; text: string }> = [];
    for (const [node, field, prefix] of [
        ['CheckpointLoaderSimple', 'ckpt_name', ''], ['UNETLoader', 'unet_name', 'UNet: '], ['UnetLoaderGGUF', 'unet_name', 'GGUF: '],
    ] as const) {
        const required = objectValue(objectValue(objectValue(info[node]).input).required);
        const value = required[field];
        if (!Array.isArray(value) || !Array.isArray(value[0])) continue;
        for (const item of value[0]) if (typeof item === 'string') {
            modelValues.push({ value: item, text: `${prefix}${item}`.replace(/\.[^.]*$/u, '').replaceAll('_', ' ') });
        }
    }
    return json(modelValues);
}

async function comfyWorkflow(context: RouteContext, operation: 'list' | 'get' | 'save' | 'delete' | 'rename'): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    if (operation === 'list') {
        return json([DEFAULT_WORKFLOW, CHARACTER_WORKFLOW]);
    }
    if (operation !== 'get') throw new HttpError(422, 'Custom ComfyUI workflows are stored in browser IndexedDB; the Worker only serves bundled workflows');
    const name = workflowName(body.file_name);
    const workflow = builtInWorkflow(name);
    if (workflow === null) throw new HttpError(404, 'Workflow is browser-local');
    return json(workflow);
}

async function comfyGenerate(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const base = safeRemoteUrl(body.url, 'url');
    const headers = authorization(body);
    const action = typeof body.action === 'string' ? body.action : 'submit';
    if (action === 'submit') {
        headers.set('content-type', 'application/json');
        const promptResponse = await fetch(new URL('/prompt', base), {
            method: 'POST', headers, body: requireString(body.prompt, 'prompt', maxJsonBytes(context.env) * 4), redirect: 'error', signal: context.request.signal,
        });
        const promptData = objectValue(await checkedJson(promptResponse, 'ComfyUI'));
        return json({ status: 'submitted', jobId: requireString(promptData.prompt_id, 'prompt_id', 256) });
    }
    if (action === 'result') {
        const media = objectValue(body.media);
        const view = new URL('/view', base);
        for (const key of ['filename', 'subfolder', 'type'] as const) {
            if (typeof media[key] === 'string' && media[key]) view.searchParams.set(key, requireString(media[key], key, 512));
        }
        const imageResponse = await fetch(view, { headers, redirect: 'error', signal: context.request.signal });
        const fallback = typeof media.filename === 'string' ? media.filename.split('.').pop() ?? 'png' : 'png';
        return streamGeneratedMedia(context, imageResponse, fallback);
    }
    if (action !== 'status') throw new HttpError(400, 'Invalid ComfyUI action');
    const promptId = requireString(body.jobId, 'jobId', 256);
    const history = objectValue(await fetch(new URL(`/history/${encodeURIComponent(promptId)}`, base), {
        headers, redirect: 'error', signal: context.request.signal,
    }).then(response => checkedJson(response, 'ComfyUI')));
    const item = objectValue(history[promptId]);
    if (Object.keys(item).length === 0) return json({ status: 'pending' }, { status: 202 });
    if (objectValue(item.status).status_str === 'error') throw new HttpError(502, 'ComfyUI generation failed');
    const outputs = objectValue(item.outputs);
    let imageInfo: JsonObject | null = null;
    for (const output of Object.values(outputs)) {
        const value = objectValue(output);
        const media = Array.isArray(value.images) ? value.images : Array.isArray(value.gifs) ? value.gifs : [];
        if (media.length > 0) { imageInfo = objectValue(media[0]); break; }
    }
    if (!imageInfo) throw new HttpError(502, 'ComfyUI returned no media');
    return json({ status: 'complete', media: imageInfo });
}

async function runPod(context: RouteContext, operation: 'ping' | 'generate'): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const key = await secret(context.env, 'api_key_comfy_runpod');
    const base = safeRemoteUrl(body.url, 'url');
    const headers = new Headers({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
    if (operation === 'ping') {
        const response = await fetch(new URL('/health', base), { headers, redirect: 'error', signal: context.request.signal });
        if (!response.ok) throw new HttpError(502, `RunPod returned ${response.status}`);
        return empty(200);
    }
    const action = typeof body.action === 'string' ? body.action : 'submit';
    if (action === 'status') {
        const id = requireString(body.jobId, 'jobId', 256);
        const response = await fetch(new URL(`/status/${encodeURIComponent(id)}`, base), { headers, redirect: 'error', signal: context.request.signal });
        if (!response.ok) throw new HttpError(502, `RunPod returned ${response.status}`);
        return proxyResponse(response);
    }
    if (action !== 'submit') throw new HttpError(400, 'Invalid RunPod action');
    let prompt: unknown;
    try { prompt = JSON.parse(requireString(body.prompt, 'prompt', maxJsonBytes(context.env) * 4)); } catch { throw new HttpError(400, 'Invalid RunPod workflow'); }
    const workflow = objectValue(prompt).prompt;
    const workflowObject = objectValue(workflow);
    const wrappedWorkflow = objectValue(objectValue(workflowObject.input).workflow);
    const outbound = Object.keys(wrappedWorkflow).length > 0 ? workflowObject : { input: { workflow } };
    const submitted = objectValue(await fetch(new URL('/run', base), {
        method: 'POST', headers, body: JSON.stringify(outbound), redirect: 'error', signal: context.request.signal,
    }).then(response => checkedJson(response, 'RunPod')));
    return json({ status: 'submitted', jobId: requireString(submitted.id, 'job id', 256) });
}

async function publicSdService(context: RouteContext, service: 'sdcpp' | 'drawthings', operation: string): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const paths = service === 'sdcpp'
        ? { ping: '/v1/images/generations', models: '/v1/models', generate: '/sdapi/v1/txt2img' }
        : { ping: '/', 'get-model': '/', 'get-upscaler': '/', generate: '/sdapi/v1/txt2img' };
    const path = paths[operation as keyof typeof paths];
    if (!path) throw new HttpError(404, 'Unknown operation');
    const headers = service === 'drawthings' ? authorization(body) : new Headers({ accept: 'application/json' });
    const method = operation === 'ping' ? (service === 'sdcpp' ? 'OPTIONS' : 'HEAD') : operation === 'generate' ? 'POST' : 'GET';
    if (method === 'POST') headers.set('content-type', 'application/json');
    const response = await fetch(remote(body, path), {
        method, headers, ...(method === 'POST' ? { body: JSON.stringify(compact(body, ['url', 'auth'])) } : {}), redirect: 'error', signal: context.request.signal,
    });
    if (!response.ok) throw new HttpError(502, `${service} returned ${response.status}`);
    if (operation === 'ping') return empty(200);
    const data = await checkedJson(response, service);
    if (service === 'drawthings' && operation !== 'generate') return json(objectValue(data)[operation === 'get-model' ? 'model' : 'upscaler'] ?? '');
    return json(data);
}

async function modelList(context: RouteContext, provider: string): Promise<Response> {
    const body = await readJson(context.request, 65_536);
    let response: Response;
    let transform: (value: unknown) => unknown;
    if (provider === 'pollinations') {
        response = await fetch('https://gen.pollinations.ai/image/models', { signal: context.request.signal });
        transform = value => Array.isArray(value) ? value.map(item => objectValue(item).name).filter((name): name is string => typeof name === 'string').map(name => ({ value: name, text: name })) : [];
    } else if (provider === 'together') {
        response = await fetch('https://api.together.xyz/api/models', { headers: { authorization: `Bearer ${await secret(context.env, 'api_key_togetherai')}` }, signal: context.request.signal });
        transform = value => Array.isArray(value) ? value.filter(item => objectValue(item).type === 'image').map(item => ({ value: objectValue(item).id, text: objectValue(item).display_name })) : [];
    } else if (provider === 'electronhub') {
        response = await fetch('https://api.electronhub.ai/v1/models', { headers: { authorization: `Bearer ${await secret(context.env, 'api_key_electronhub')}` }, signal: context.request.signal });
        transform = value => Array.isArray(objectValue(value).data) ? (objectValue(value).data as unknown[]).filter(item => Array.isArray(objectValue(item).endpoints) && (objectValue(item).endpoints as unknown[]).includes('/v1/images/generations')).map(item => ({ ...objectValue(item), value: objectValue(item).id, text: objectValue(item).name })) : [];
    } else if (provider === 'chutes') {
        response = await fetch('https://api.chutes.ai/chutes/?template=diffusion&include_public=true&limit=999', { headers: { authorization: `Bearer ${await secret(context.env, 'api_key_chutes')}` }, signal: context.request.signal });
        transform = value => Array.isArray(objectValue(value).items) ? (objectValue(value).items as unknown[]).map(item => objectValue(item).name).filter((name): name is string => typeof name === 'string').sort().map(name => ({ value: name, text: name })) : [];
    } else if (provider === 'nanogpt') {
        response = await fetch('https://nano-gpt.com/api/models', { headers: { 'x-api-key': await secret(context.env, 'api_key_nanogpt') }, signal: context.request.signal });
        transform = value => Object.values(objectValue(objectValue(value).models).image ?? {}).map(item => ({ value: objectValue(item).model, text: objectValue(item).name }));
    } else if (provider === 'falai') {
        response = await fetch('https://fal.ai/api/models?categories=text-to-image&page=1', { signal: context.request.signal });
        transform = value => Array.isArray(objectValue(value).items) ? (objectValue(value).items as unknown[]).filter(item => !/(inpainting|control|upscale|lora)/iu.test(String(objectValue(item).title ?? ''))).map(item => ({ value: String(objectValue(item).modelUrl ?? '').split('fal-ai/')[1], text: `${String(objectValue(item).title ?? '')} (${String(objectValue(item).modelUrl ?? '').split('fal-ai/')[1]})` })) : [];
    } else if (provider === 'aimlapi') {
        response = await fetch('https://api.aimlapi.com/v1/models', { headers: { authorization: `Bearer ${await secret(context.env, 'api_key_aimlapi')}` }, signal: context.request.signal });
        transform = value => ({ data: Array.isArray(objectValue(value).data) ? (objectValue(value).data as unknown[]).filter(item => objectValue(item).type === 'image' && !['triposr', 'flux/dev/image-to-image'].includes(String(objectValue(item).id))).map(item => ({ value: objectValue(item).id, text: objectValue(objectValue(item).info).name ?? objectValue(item).id })) : [] });
    } else if (provider === 'workersai') {
        const account = requireString(body.account_id, 'account_id', 128);
        const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/models/search`);
        url.search = '?task=Text-to-Image&per_page=1000';
        response = await fetch(url, { headers: { authorization: `Bearer ${await secret(context.env, 'api_key_workers_ai')}` }, signal: context.request.signal });
        transform = value => Array.isArray(objectValue(value).result) ? (objectValue(value).result as unknown[]).map(item => ({ value: objectValue(item).name, text: objectValue(item).name })) : [];
    } else {
        throw new HttpError(404, 'Unknown image provider');
    }
    return json(transform(await checkedJson(response, provider)));
}

async function providerGenerate(context: RouteContext, provider: string): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    let response: Response;
    if (provider === 'pollinations') {
        const url = new URL(`https://gen.pollinations.ai/image/${encodeURIComponent(requireString(body.prompt, 'prompt', 10_000))}`);
        for (const key of ['model', 'negative_prompt', 'seed', 'width', 'height'] as const) if (body[key] !== undefined) url.searchParams.set(key, String(body[key]));
        if (body.enhance) url.searchParams.set('enhance', 'true');
        response = await fetch(url, { headers: { authorization: `Bearer ${await secret(context.env, 'api_key_pollinations')}` }, signal: context.request.signal });
        return streamGeneratedMedia(context, response, 'jpg');
    }
    const configurations: Record<string, { url: string; secret: string; header: string; prefix: string; body?: JsonObject }> = {
        together: { url: 'https://api.together.xyz/v1/images/generations', secret: 'api_key_togetherai', header: 'authorization', prefix: 'Bearer ', body: { ...body, n: 1 } },
        electronhub: { url: 'https://api.electronhub.ai/v1/images/generations', secret: 'api_key_electronhub', header: 'authorization', prefix: 'Bearer ' },
        chutes: { url: 'https://image.chutes.ai/generate', secret: 'api_key_chutes', header: 'authorization', prefix: 'Bearer ', body: { ...body, num_inference_steps: body.steps } },
        nanogpt: { url: 'https://nano-gpt.com/api/generate-image', secret: 'api_key_nanogpt', header: 'x-api-key', prefix: '' },
        xai: { url: 'https://api.x.ai/v1/images/generations', secret: 'api_key_xai', header: 'authorization', prefix: 'Bearer ' },
        aimlapi: { url: 'https://api.aimlapi.com/v1/images/generations', secret: 'api_key_aimlapi', header: 'authorization', prefix: 'Bearer ' },
    };
    const config = configurations[provider];
    if (config) {
        const headers = new Headers({ 'content-type': 'application/json' });
        headers.set(config.header, `${config.prefix}${await secret(context.env, config.secret)}`);
        response = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify(compact(config.body ?? body)), signal: context.request.signal });
        if ((response.headers.get('content-type') ?? '').includes('application/json')) {
            // Provider JSON (including base64 or signed URLs) is passed through untouched.
            // Decoding or downloading it is browser work and never consumes Worker memory.
            return proxyResponse(response);
        }
        return streamGeneratedMedia(context, response, 'jpg');
    }
    if (provider === 'stability') {
        const model = requireString(body.model, 'model', 80);
        const endpoints: Record<string, string> = { 'stable-image-ultra': 'ultra', 'stable-image-core': 'core', 'stable-diffusion-3': 'sd3' };
        const endpoint = endpoints[model];
        if (!endpoint) throw new HttpError(400, 'Invalid Stability AI model');
        const form = new FormData();
        for (const [key, value] of Object.entries(objectValue(body.payload))) if (value !== undefined) form.append(key, String(value));
        response = await fetch(`https://api.stability.ai/v2beta/stable-image/generate/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${await secret(context.env, 'api_key_stability')}`, accept: 'image/*' }, body: form, signal: context.request.signal });
        return streamGeneratedMedia(context, response, 'png');
    }
    if (provider === 'huggingface') {
        response = await fetch(`https://api-inference.huggingface.co/models/${encodeURIComponent(requireString(body.model, 'model', 256))}`, { method: 'POST', headers: { authorization: `Bearer ${await secret(context.env, 'api_key_huggingface')}`, 'content-type': 'application/json' }, body: JSON.stringify({ inputs: body.prompt }), signal: context.request.signal });
        return streamGeneratedMedia(context, response, 'jpg');
    }
    if (provider === 'workersai') {
        const account = requireString(body.account_id, 'account_id', 128);
        const model = requireString(body.model, 'model', 256);
        const outbound = compact({ prompt: body.prompt, negative_prompt: body.negative_prompt, width: body.width, height: body.height, num_steps: body.steps, guidance: body.scale, seed: body.seed });
        const headers = new Headers({ authorization: `Bearer ${await secret(context.env, 'api_key_workers_ai')}` });
        let requestBody: BodyInit;
        if (/flux-2/u.test(model)) {
            const form = new FormData();
            for (const [key, value] of Object.entries(outbound)) form.append(key, String(value));
            requestBody = form;
        } else {
            headers.set('content-type', 'application/json');
            requestBody = JSON.stringify(outbound);
        }
        response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`, { method: 'POST', headers, body: requestBody, signal: context.request.signal });
        if ((response.headers.get('content-type') ?? '').includes('application/json')) return proxyResponse(response);
        return streamGeneratedMedia(context, response, 'png');
    }
    throw new HttpError(404, 'Unknown image provider');
}

async function electronHubSizes(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, 65_536);
    const model = requireString(body.model, 'model', 256);
    const response = await fetch(`https://api.electronhub.ai/v1/models/${encodeURIComponent(model)}`, { signal: context.request.signal });
    const value = objectValue(await checkedJson(response, 'Electron Hub'));
    if (!Array.isArray(value.sizes)) throw new HttpError(502, 'Electron Hub returned no sizes');
    return json({ sizes: value.sizes });
}

async function queuedGenerate(context: RouteContext, provider: 'bfl' | 'falai'): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const key = await secret(context.env, provider === 'bfl' ? 'api_key_bfl' : 'api_key_falai');
    const headers = provider === 'bfl'
        ? new Headers({ 'content-type': 'application/json', 'x-key': key })
        : new Headers({ 'content-type': 'application/json', authorization: `Key ${key}` });
    const action = typeof body.action === 'string' ? body.action : 'submit';
    if (action === 'status') {
        const reference = requireString(body.jobReference, 'jobReference', 2048);
        const statusUrl = provider === 'bfl'
            ? `https://api.bfl.ml/v1/get_result?id=${encodeURIComponent(reference)}`
            : safeRemoteUrl(reference, 'status URL').toString();
        const status = objectValue(await fetch(statusUrl, { headers, redirect: 'error', signal: context.request.signal }).then(response => checkedJson(response, provider)));
        const state = String(status.status ?? '');
        if (['Pending', 'IN_QUEUE', 'IN_PROGRESS'].includes(state)) return json({ status: 'pending' }, { status: 202 });
        if (provider === 'bfl' && state === 'Ready') {
            return json({ status: 'complete', image: safeRemoteUrl(objectValue(status.result).sample, 'image URL').toString(), format: 'jpg' });
        }
        if (provider === 'falai' && state === 'COMPLETED') {
            return json({ status: 'ready', resultReference: safeRemoteUrl(status.response_url, 'response URL').toString() });
        }
        throw new HttpError(502, `${provider} image generation failed`);
    }
    if (action === 'result' && provider === 'falai') {
        const resultUrl = safeRemoteUrl(body.resultReference, 'response URL');
        const result = objectValue(await fetch(resultUrl, { headers, redirect: 'error', signal: context.request.signal }).then(response => checkedJson(response, provider)));
        const imageUrl = Array.isArray(result.images) ? objectValue(result.images[0]).url : undefined;
        return json({ status: 'complete', image: safeRemoteUrl(imageUrl, 'image URL').toString(), format: 'jpg' });
    }
    if (action !== 'submit') throw new HttpError(400, `Invalid ${provider} action`);
    const model = requireString(body.model, 'model', 256);
    const url = provider === 'bfl' ? `https://api.bfl.ml/v1/${encodeURIComponent(model)}` : `https://queue.fal.run/fal-ai/${model.split('/').map(encodeURIComponent).join('/')}`;
    const outbound = provider === 'bfl'
        ? compact({ prompt: body.prompt, steps: body.steps, guidance: body.guidance, width: body.width, height: body.height, prompt_upsampling: body.prompt_upsampling, seed: body.seed, safety_tolerance: 6, output_format: 'jpeg' })
        : compact({ prompt: body.prompt, image_size: { width: body.width, height: body.height }, num_inference_steps: body.steps, seed: body.seed, guidance_scale: body.guidance, enable_safety_checker: false, safety_tolerance: 6 });
    const submitted = objectValue(await fetch(url, { method: 'POST', headers, body: JSON.stringify(outbound), signal: context.request.signal }).then(response => checkedJson(response, provider)));
    const statusReference = provider === 'bfl' ? submitted.id : submitted.status_url;
    if (!statusReference) throw new HttpError(502, `${provider} returned no job id`);
    return json({ status: 'submitted', jobReference: String(statusReference) });
}

async function zaiGenerate(context: RouteContext, video: boolean): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const key = await secret(context.env, 'api_key_zai');
    const headers = new Headers({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
    const action = typeof body.action === 'string' ? body.action : 'submit';
    if (action === 'status' && video) {
        const id = requireString(body.jobId, 'jobId', 256);
        const status = objectValue(await fetch(`https://api.z.ai/api/paas/v4/async-result/${encodeURIComponent(id)}`, { headers, signal: context.request.signal }).then(result => checkedJson(result, 'Z.AI')));
        if (status.task_status === 'FAIL') throw new HttpError(502, 'Z.AI video generation failed');
        if (status.task_status !== 'SUCCESS') return json({ status: 'pending' }, { status: 202 });
        const mediaUrl = Array.isArray(status.video_result) ? objectValue(status.video_result[0]).url : undefined;
        return json({ status: 'complete', video: safeRemoteUrl(mediaUrl, 'video URL').toString(), format: 'mp4' });
    }
    if (action !== 'submit') throw new HttpError(400, 'Invalid Z.AI action');
    const endpoint = video ? 'videos' : 'images';
    const response = await fetch(`https://api.z.ai/api/paas/v4/${endpoint}/generations`, { method: 'POST', headers, body: JSON.stringify(compact(body)), signal: context.request.signal });
    if (!video) return proxyResponse(response);
    const submitted = objectValue(await checkedJson(response, 'Z.AI'));
    return json({ status: 'submitted', jobId: requireString(submitted.id, 'job id', 256) });
}

export function registerStableDiffusionRoutes(router: Router): void {
    router.on('POST', '/api/sd/ping', context => sdOperation(context, 'ping'));
    router.on('POST', '/api/sd/get-model', context => sdOperation(context, 'get-model'));
    router.on('POST', '/api/sd/set-model', context => sdOperation(context, 'set-model'));
    router.on('POST', '/api/sd/generate', context => sdOperation(context, 'generate'));
    for (const operation of ['upscalers', 'vaes', 'samplers', 'schedulers', 'models'] as const) {
        router.on('POST', `/api/sd/${operation}`, context => sdList(context, operation));
    }
    router.on('POST', '/api/sd/sd-next/upscalers', context => sdList(context, 'upscalers'));

    for (const operation of ['ping', 'samplers', 'models', 'schedulers', 'vaes'] as const) {
        router.on('POST', `/api/sd/comfy/${operation}`, context => comfyInfo(context, operation));
    }
    router.on('POST', '/api/sd/comfy/workflows', context => comfyWorkflow(context, 'list'));
    router.on('POST', '/api/sd/comfy/workflow', context => comfyWorkflow(context, 'get'));
    router.on('POST', '/api/sd/comfy/save-workflow', context => comfyWorkflow(context, 'save'));
    router.on('POST', '/api/sd/comfy/delete-workflow', context => comfyWorkflow(context, 'delete'));
    router.on('POST', '/api/sd/comfy/rename-workflow', context => comfyWorkflow(context, 'rename'));
    router.on('POST', '/api/sd/comfy/generate', comfyGenerate);
    router.on('POST', '/api/sd/comfyrunpod/ping', context => runPod(context, 'ping'));
    router.on('POST', '/api/sd/comfyrunpod/generate', context => runPod(context, 'generate'));

    for (const operation of ['ping', 'models', 'generate'] as const) {
        router.on('POST', `/api/sd/sdcpp/${operation}`, context => publicSdService(context, 'sdcpp', operation));
    }
    for (const operation of ['ping', 'get-model', 'get-upscaler', 'generate'] as const) {
        router.on('POST', `/api/sd/drawthings/${operation}`, context => publicSdService(context, 'drawthings', operation));
    }

    for (const provider of ['together', 'pollinations', 'electronhub', 'chutes', 'nanogpt', 'falai', 'aimlapi', 'workersai'] as const) {
        router.on('POST', `/api/sd/${provider}/models`, context => modelList(context, provider));
    }
    router.on('POST', '/api/sd/electronhub/sizes', electronHubSizes);
    for (const provider of ['together', 'pollinations', 'stability', 'huggingface', 'electronhub', 'chutes', 'nanogpt', 'xai', 'workersai'] as const) {
        router.on('POST', `/api/sd/${provider}/generate`, context => providerGenerate(context, provider));
    }
    router.on('POST', '/api/sd/aimlapi/generate-image', context => providerGenerate(context, 'aimlapi'));
    router.on('POST', '/api/sd/bfl/generate', context => queuedGenerate(context, 'bfl'));
    router.on('POST', '/api/sd/falai/generate', context => queuedGenerate(context, 'falai'));
    router.on('POST', '/api/sd/zai/generate', context => zaiGenerate(context, false));
    router.on('POST', '/api/sd/zai/generate-video', context => zaiGenerate(context, true));
}
