import defaultComfyWorkflow from '../../../../default/content/Default_Comfy_Workflow.json';
import characterComfyWorkflow from '../../../../default/content/Char_Avatar_Comfy_Workflow.json';
import { empty, HttpError, json, maxJsonBytes, maxUploadBytes, readJson, requireString, safeName, text } from '../http';
import type { RouteContext, Router } from '../router';
import { deleteObject, listObjects, putObject, serveObject } from '../storage/objects';
import { readSecret } from '../storage/secrets';
import { deleteState, getState, listState, putState, renameState } from '../storage/state';
import { proxyResponse, safeRemoteUrl } from './providers';

type JsonObject = Record<string, unknown>;

const GENERATED_MEDIA_KIND = 'generated-media';
const GENERATED_MEDIA_LIMIT = 50;
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
            fetch(remote(body, '/sdapi/v1/upscalers'), { headers, signal: context.request.signal }).then(jsonData),
            fetch(remote(body, '/sdapi/v1/latent-upscale-modes'), { headers, signal: context.request.signal }).then(jsonData).catch(() => []),
        ]);
        const first = Array.isArray(upscalers) ? upscalers.map(item => objectValue(item).name).filter((name): name is string => typeof name === 'string') : [];
        const second = Array.isArray(latent) ? latent.map(item => objectValue(item).name).filter((name): name is string => typeof name === 'string') : [];
        first.splice(Math.min(1, first.length), 0, ...second);
        return json(first);
    }
    const paths = { vaes: '/sdapi/v1/sd-vae', samplers: '/sdapi/v1/samplers', schedulers: '/sdapi/v1/schedulers', models: '/sdapi/v1/sd-models' } as const;
    const data = await fetch(remote(body, paths[operation]), { headers, signal: context.request.signal }).then(jsonData);
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
        const data = objectValue(await fetch(remote(body, '/sdapi/v1/options'), { headers, signal: context.request.signal }).then(jsonData));
        return operation === 'ping' ? empty(200) : json(data.sd_model_checkpoint ?? '');
    }
    headers.set('content-type', 'application/json');
    if (operation === 'set-model') {
        const response = await fetch(remote(body, '/sdapi/v1/options'), {
            method: 'POST', headers, body: JSON.stringify({ sd_model_checkpoint: requireString(body.model, 'model', 256) }), signal: context.request.signal,
        });
        if (!response.ok) return proxyResponse(response);
        return empty(200);
    }
    const outbound: JsonObject = {};
    for (const [key, value] of Object.entries(body)) if (key !== 'url' && key !== 'auth') outbound[key] = value;
    return proxyResponse(await fetch(remote(body, '/sdapi/v1/txt2img'), {
        method: 'POST', headers, body: JSON.stringify(outbound), signal: context.request.signal,
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

async function cleanGeneratedMedia(env: Env): Promise<void> {
    const objects = await listObjects(env, GENERATED_MEDIA_KIND, GENERATED_MEDIA_LIMIT + 6);
    const excess = Math.min(Math.max(objects.length - GENERATED_MEDIA_LIMIT, 0), 5);
    for (const item of objects.slice(0, excess)) await deleteObject(env, GENERATED_MEDIA_KIND, item.name);
}

async function storeGeneratedMedia(context: RouteContext, response: Response, fallback = 'png'): Promise<{ url: string; format: string }> {
    if (!response.ok || !response.body) throw new HttpError(502, `Image provider returned ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > maxUploadBytes(context.env)) throw new HttpError(413, 'Generated media exceeds the configured size limit');
    const contentType = response.headers.get('content-type') ?? `image/${fallback}`;
    const format = extensionFor(contentType, fallback);
    const name = `${String(Date.now()).padStart(13, '0')}-${crypto.randomUUID()}.${format}`;
    const stored = await putObject(context.env, GENERATED_MEDIA_KIND, name, response.body, {
        mimeType: contentType,
        ...(declaredLength > 0 ? { byteLength: declaredLength } : {}),
    });
    if (stored.byteLength > maxUploadBytes(context.env)) {
        await deleteObject(context.env, GENERATED_MEDIA_KIND, name);
        throw new HttpError(413, 'Generated media exceeds the configured size limit');
    }
    context.execution.waitUntil(cleanGeneratedMedia(context.env).catch(error => console.error('Generated media cleanup failed', error)));
    return { url: `/generated-media/${encodeURIComponent(name)}`, format };
}

async function storeRemoteMedia(context: RouteContext, value: unknown, fallback = 'png', headers?: HeadersInit): Promise<{ url: string; format: string }> {
    const url = safeRemoteUrl(value, 'image URL');
    const response = await fetch(url, { ...(headers === undefined ? {} : { headers }), signal: context.request.signal });
    return storeGeneratedMedia(context, response, extensionFor(response.headers.get('content-type'), fallback));
}

function firstImage(value: unknown): JsonObject {
    const data = objectValue(value);
    const arrays = [data.data, data.images];
    for (const candidate of arrays) {
        if (Array.isArray(candidate) && candidate.length > 0) return objectValue(candidate[0]);
    }
    return {};
}

function dataUrlParts(value: unknown, fallback = 'jpg'): { image: string; format: string } | null {
    if (typeof value !== 'string' || !value) return null;
    const match = /^data:([^;]+);base64,(.+)$/u.exec(value);
    return match ? { image: match[2] ?? '', format: extensionFor(match[1] ?? '', fallback) } : { image: value, format: fallback };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });
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
        const response = await fetch(remote(body, '/system_stats'), { signal: context.request.signal });
        if (!response.ok) throw new HttpError(502, `ComfyUI returned ${response.status}`);
        return empty(200);
    }
    const info = objectValue(await fetch(remote(body, '/object_info'), { signal: context.request.signal }).then(response => checkedJson(response, 'ComfyUI')));
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
        const custom = (await listState(context.env, 'comfy-workflow')).map(item => item.key);
        return json([...new Set([DEFAULT_WORKFLOW, CHARACTER_WORKFLOW, ...custom])]);
    }
    if (operation === 'rename') {
        const oldName = workflowName(body.old_name, 'old_name');
        const newName = workflowName(body.new_name, 'new_name');
        if (builtInWorkflow(oldName)) throw new HttpError(409, 'Built-in workflows cannot be renamed');
        if (builtInWorkflow(newName) || await getState(context.env, 'comfy-workflow', newName)) throw new HttpError(409, 'Workflow already exists');
        if (!await renameState(context.env, 'comfy-workflow', oldName, newName)) throw new HttpError(404, 'Workflow not found');
        return empty(204);
    }
    const name = workflowName(body.file_name);
    if (operation === 'get') {
        const stored = await getState<string>(context.env, 'comfy-workflow', name);
        return json(stored?.value ?? builtInWorkflow(name) ?? JSON.stringify(defaultComfyWorkflow));
    }
    if (builtInWorkflow(name)) throw new HttpError(409, 'Built-in workflows are read-only; save under a new name');
    if (operation === 'delete') {
        await deleteState(context.env, 'comfy-workflow', name);
        return empty(200);
    }
    const workflow = requireString(body.workflow, 'workflow', maxJsonBytes(context.env) * 4);
    try { JSON.parse(workflow); } catch { throw new HttpError(400, 'Workflow must be valid JSON'); }
    await putState(context.env, 'comfy-workflow', name, workflow, 'text');
    const names = (await listState(context.env, 'comfy-workflow')).map(item => item.key);
    return json([...new Set([DEFAULT_WORKFLOW, CHARACTER_WORKFLOW, ...names])]);
}

async function comfyGenerate(context: RouteContext): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const base = safeRemoteUrl(body.url, 'url');
    const headers = authorization(body);
    headers.set('content-type', 'application/json');
    const promptResponse = await fetch(new URL('/prompt', base), {
        method: 'POST', headers, body: requireString(body.prompt, 'prompt', maxJsonBytes(context.env) * 4), signal: context.request.signal,
    });
    const promptData = objectValue(await checkedJson(promptResponse, 'ComfyUI'));
    const promptId = requireString(promptData.prompt_id, 'prompt_id', 256);
    let item: JsonObject | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const history = objectValue(await fetch(new URL(`/history/${encodeURIComponent(promptId)}`, base), {
            headers, signal: context.request.signal,
        }).then(response => checkedJson(response, 'ComfyUI')));
        item = objectValue(history[promptId]);
        if (Object.keys(item).length > 0) break;
        await delay(1_000, context.request.signal);
    }
    if (!item || Object.keys(item).length === 0) throw new HttpError(504, 'ComfyUI generation timed out');
    if (objectValue(item.status).status_str === 'error') throw new HttpError(502, 'ComfyUI generation failed');
    const outputs = objectValue(item.outputs);
    let imageInfo: JsonObject | null = null;
    for (const output of Object.values(outputs)) {
        const value = objectValue(output);
        const media = Array.isArray(value.images) ? value.images : Array.isArray(value.gifs) ? value.gifs : [];
        if (media.length > 0) { imageInfo = objectValue(media[0]); break; }
    }
    if (!imageInfo) throw new HttpError(502, 'ComfyUI returned no media');
    const view = new URL('/view', base);
    for (const key of ['filename', 'subfolder', 'type'] as const) if (typeof imageInfo[key] === 'string') view.searchParams.set(key, imageInfo[key]);
    const imageResponse = await fetch(view, { headers, signal: context.request.signal });
    const fallback = typeof imageInfo.filename === 'string' ? imageInfo.filename.split('.').pop() ?? 'png' : 'png';
    const stored = await storeGeneratedMedia(context, imageResponse, fallback);
    return json({ format: stored.format, data: stored.url });
}

async function runPod(context: RouteContext, operation: 'ping' | 'generate'): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const key = await secret(context.env, 'api_key_comfy_runpod');
    const base = safeRemoteUrl(body.url, 'url');
    const headers = new Headers({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
    if (operation === 'ping') {
        const response = await fetch(new URL('/health', base), { headers, signal: context.request.signal });
        if (!response.ok) throw new HttpError(502, `RunPod returned ${response.status}`);
        return empty(200);
    }
    let prompt: unknown;
    try { prompt = JSON.parse(requireString(body.prompt, 'prompt', maxJsonBytes(context.env) * 4)); } catch { throw new HttpError(400, 'Invalid RunPod workflow'); }
    const workflow = objectValue(prompt).prompt;
    const workflowObject = objectValue(workflow);
    const wrappedWorkflow = objectValue(objectValue(workflowObject.input).workflow);
    const outbound = Object.keys(wrappedWorkflow).length > 0
        ? workflowObject : { input: { workflow } };
    const submitted = objectValue(await fetch(new URL('/run', base), {
        method: 'POST', headers, body: JSON.stringify(outbound), signal: context.request.signal,
    }).then(response => checkedJson(response, 'RunPod')));
    const id = requireString(submitted.id, 'job id', 256);
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const status = objectValue(await fetch(new URL(`/status/${encodeURIComponent(id)}`, base), {
            headers, signal: context.request.signal,
        }).then(response => checkedJson(response, 'RunPod')));
        if (status.status === 'FAILED' || status.status === 'CANCELLED') throw new HttpError(502, 'RunPod generation failed');
        const images = objectValue(status.output).images;
        if (Array.isArray(images) && images.length > 0) {
            const image = objectValue(images[0]);
            const data = requireString(image.data, 'RunPod image', maxJsonBytes(context.env) * 16);
            const format = typeof image.filename === 'string' ? image.filename.split('.').pop() ?? 'png' : 'png';
            return json({ format, data });
        }
        await delay(1_000, context.request.signal);
    }
    throw new HttpError(504, 'RunPod generation timed out');
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
        method, headers, ...(method === 'POST' ? { body: JSON.stringify(compact(body, ['url', 'auth'])) } : {}), signal: context.request.signal,
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
        const stored = await storeGeneratedMedia(context, response, 'jpg');
        return json({ image: stored.url, format: stored.format });
    }
    const configurations: Record<string, { url: string; secret: string; header: string; prefix: string; body?: JsonObject }> = {
        together: { url: 'https://api.together.xyz/v1/images/generations', secret: 'api_key_togetherai', header: 'authorization', prefix: 'Bearer ', body: { ...body, n: 1 } },
        electronhub: { url: 'https://api.electronhub.ai/v1/images/generations', secret: 'api_key_electronhub', header: 'authorization', prefix: 'Bearer ', body: { ...body, response_format: 'b64_json' } },
        chutes: { url: 'https://image.chutes.ai/generate', secret: 'api_key_chutes', header: 'authorization', prefix: 'Bearer ', body: { ...body, num_inference_steps: body.steps } },
        nanogpt: { url: 'https://nano-gpt.com/api/generate-image', secret: 'api_key_nanogpt', header: 'x-api-key', prefix: '' },
        xai: { url: 'https://api.x.ai/v1/images/generations', secret: 'api_key_xai', header: 'authorization', prefix: 'Bearer ', body: { ...body, response_format: 'b64_json' } },
        aimlapi: { url: 'https://api.aimlapi.com/v1/images/generations', secret: 'api_key_aimlapi', header: 'authorization', prefix: 'Bearer ' },
    };
    const config = configurations[provider];
    if (config) {
        const headers = new Headers({ 'content-type': 'application/json' });
        headers.set(config.header, `${config.prefix}${await secret(context.env, config.secret)}`);
        response = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify(compact(config.body ?? body)), signal: context.request.signal });
        if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
            const stored = await storeGeneratedMedia(context, response, 'jpg');
            return json({ image: stored.url, format: stored.format });
        }
        const value = await checkedJson(response, provider);
        const image = firstImage(value);
        const root = objectValue(value);
        const encoded = image.b64_json ?? image.base64 ?? root.image;
        const parts = dataUrlParts(encoded, provider === 'xai' ? 'jpg' : 'jpg');
        if (parts?.image) {
            if (provider === 'together' || provider === 'aimlapi') return json({ format: parts.format, data: parts.image });
            return json({ image: parts.image, format: parts.format });
        }
        const imageUrl = image.url ?? root.url;
        if (imageUrl) {
            const stored = await storeRemoteMedia(context, imageUrl, 'jpg');
            if (provider === 'together' || provider === 'aimlapi') return json({ format: stored.format, data: stored.url });
            return json({ image: stored.url, format: stored.format });
        }
        throw new HttpError(502, `${provider} returned no image`);
    }
    if (provider === 'stability') {
        const model = requireString(body.model, 'model', 80);
        const endpoints: Record<string, string> = { 'stable-image-ultra': 'ultra', 'stable-image-core': 'core', 'stable-diffusion-3': 'sd3' };
        const endpoint = endpoints[model];
        if (!endpoint) throw new HttpError(400, 'Invalid Stability AI model');
        const form = new FormData();
        for (const [key, value] of Object.entries(objectValue(body.payload))) if (value !== undefined) form.append(key, String(value));
        response = await fetch(`https://api.stability.ai/v2beta/stable-image/generate/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${await secret(context.env, 'api_key_stability')}`, accept: 'image/*' }, body: form, signal: context.request.signal });
        const stored = await storeGeneratedMedia(context, response, 'png');
        return text(stored.url);
    }
    if (provider === 'huggingface') {
        response = await fetch(`https://api-inference.huggingface.co/models/${encodeURIComponent(requireString(body.model, 'model', 256))}`, { method: 'POST', headers: { authorization: `Bearer ${await secret(context.env, 'api_key_huggingface')}`, 'content-type': 'application/json' }, body: JSON.stringify({ inputs: body.prompt }), signal: context.request.signal });
        const stored = await storeGeneratedMedia(context, response, 'jpg');
        return json({ image: stored.url });
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
        if ((response.headers.get('content-type') ?? '').includes('application/json')) {
            const value = objectValue(await checkedJson(response, 'Workers AI'));
            const image = objectValue(value.result).image ?? value.image;
            const parts = dataUrlParts(image, 'png');
            if (!parts) throw new HttpError(502, 'Workers AI returned no image');
            return json({ image: parts.image, format: parts.format });
        }
        const stored = await storeGeneratedMedia(context, response, 'png');
        return json({ image: stored.url, format: stored.format });
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
    const model = requireString(body.model, 'model', 256);
    const headers = provider === 'bfl'
        ? new Headers({ 'content-type': 'application/json', 'x-key': key })
        : new Headers({ 'content-type': 'application/json', authorization: `Key ${key}` });
    const url = provider === 'bfl' ? `https://api.bfl.ml/v1/${encodeURIComponent(model)}` : `https://queue.fal.run/fal-ai/${model.split('/').map(encodeURIComponent).join('/')}`;
    const outbound = provider === 'bfl'
        ? compact({ prompt: body.prompt, steps: body.steps, guidance: body.guidance, width: body.width, height: body.height, prompt_upsampling: body.prompt_upsampling, seed: body.seed, safety_tolerance: 6, output_format: 'jpeg' })
        : compact({ prompt: body.prompt, image_size: { width: body.width, height: body.height }, num_inference_steps: body.steps, seed: body.seed, guidance_scale: body.guidance, enable_safety_checker: false, safety_tolerance: 6 });
    const submitted = objectValue(await fetch(url, { method: 'POST', headers, body: JSON.stringify(outbound), signal: context.request.signal }).then(response => checkedJson(response, provider)));
    const statusReference = provider === 'bfl' ? submitted.id : submitted.status_url;
    if (!statusReference) throw new HttpError(502, `${provider} returned no job id`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await delay(2_500, context.request.signal);
        const statusUrl = provider === 'bfl' ? `https://api.bfl.ml/v1/get_result?id=${encodeURIComponent(String(statusReference))}` : safeRemoteUrl(statusReference, 'status_url').toString();
        const status = objectValue(await fetch(statusUrl, { headers, signal: context.request.signal }).then(response => checkedJson(response, provider)));
        const state = String(status.status ?? '');
        if (['Pending', 'IN_QUEUE', 'IN_PROGRESS'].includes(state)) continue;
        let imageUrl: unknown;
        if (provider === 'bfl' && state === 'Ready') imageUrl = objectValue(status.result).sample;
        if (provider === 'falai' && state === 'COMPLETED') {
            const resultUrl = safeRemoteUrl(status.response_url, 'response_url');
            const result = objectValue(await fetch(resultUrl, { headers, signal: context.request.signal }).then(response => checkedJson(response, provider)));
            imageUrl = Array.isArray(result.images) ? objectValue(result.images[0]).url : undefined;
        }
        if (imageUrl) {
            const stored = await storeRemoteMedia(context, imageUrl, 'jpg', headers);
            return json({ image: stored.url });
        }
        throw new HttpError(502, `${provider} image generation failed`);
    }
    throw new HttpError(504, `${provider} image generation timed out`);
}

async function zaiGenerate(context: RouteContext, video: boolean): Promise<Response> {
    const body = await readJson(context.request, maxJsonBytes(context.env) * 4);
    const key = await secret(context.env, 'api_key_zai');
    const headers = new Headers({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
    const endpoint = video ? 'videos' : 'images';
    const response = await fetch(`https://api.z.ai/api/paas/v4/${endpoint}/generations`, { method: 'POST', headers, body: JSON.stringify(compact(body)), signal: context.request.signal });
    const submitted = objectValue(await checkedJson(response, 'Z.AI'));
    let mediaUrl: unknown = Array.isArray(submitted.data) ? objectValue(submitted.data[0]).url : undefined;
    if (video) {
        const id = requireString(submitted.id, 'job id', 256);
        for (let attempt = 0; attempt < 20; attempt += 1) {
            await delay(5_000, context.request.signal);
            const status = objectValue(await fetch(`https://api.z.ai/api/paas/v4/async-result/${encodeURIComponent(id)}`, { headers, signal: context.request.signal }).then(result => checkedJson(result, 'Z.AI')));
            if (status.task_status === 'FAIL') throw new HttpError(502, 'Z.AI video generation failed');
            if (status.task_status === 'SUCCESS') {
                mediaUrl = Array.isArray(status.video_result) ? objectValue(status.video_result[0]).url : undefined;
                break;
            }
        }
    }
    if (!mediaUrl) throw new HttpError(video ? 504 : 502, video ? 'Z.AI video generation timed out' : 'Z.AI returned no image');
    const stored = await storeRemoteMedia(context, mediaUrl, video ? 'mp4' : 'png');
    return json(video ? { video: stored.url, format: stored.format } : { image: stored.url, format: stored.format });
}

export function registerStableDiffusionRoutes(router: Router): void {
    router.on('GET', '/generated-media/:name', context => serveObject(context.env, GENERATED_MEDIA_KIND, safeName(context.params.name), context.request));
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
