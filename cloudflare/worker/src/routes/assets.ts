import { empty, HttpError, json, maxUploadBytes, readJson, requireString } from '../http';
import type { Router } from '../router';
import { deleteObject, findObject, listObjects, putObject, serveObject } from '../storage/objects';
import { safeRemoteUrl } from './providers';

const CATEGORIES = ['bgm', 'ambient', 'blip', 'live2d', 'vrm', 'character'] as const;
const CATEGORY_SET = new Set<string>(CATEGORIES);
const UNSAFE_EXTENSIONS = new Set(['.exe', '.com', '.bat', '.cmd', '.sh', '.js', '.mjs', '.cjs', '.html', '.htm', '.php', '.svg']);

function category(value: unknown): string {
    const selected = requireString(value, 'category', 32);
    if (!CATEGORY_SET.has(selected)) throw new HttpError(400, 'Unsupported asset category');
    return selected;
}

function fileName(value: unknown): string {
    const name = requireString(value, 'filename', 180);
    if (!/^[a-zA-Z0-9_.-]+$/u.test(name) || name.startsWith('.')) throw new HttpError(400, 'Invalid asset filename');
    const dot = name.lastIndexOf('.');
    if (dot >= 0 && UNSAFE_EXTENSIONS.has(name.slice(dot).toLowerCase())) throw new HttpError(400, 'Forbidden asset extension');
    return name;
}

function mimeType(name: string, fallback: string | null): string {
    if (fallback) return fallback;
    const extension = name.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
        json: 'application/json', vrm: 'model/gltf-binary', glb: 'model/gltf-binary',
    };
    return extension ? types[extension] ?? 'application/octet-stream' : 'application/octet-stream';
}

function assetPath(value: unknown): string {
    if (typeof value !== 'string') throw new HttpError(400, 'Missing asset path');
    const parts = value.replaceAll('\\', '/').replace(/^\/?assets\//u, '').split('/').filter(Boolean);
    if (parts.length < 2 || parts.length > 4) throw new HttpError(400, 'Invalid asset path');
    return parts.map((part, index) => index === parts.length - 1 ? fileName(decodeURIComponent(part)) : requireString(decodeURIComponent(part), 'folder', 128)).join('/');
}

export function registerAssetRoutes(router: Router): void {
    router.on('POST', '/api/assets/get', async ({ env }) => {
        const result: Record<string, unknown> = Object.fromEntries(CATEGORIES.filter(value => value !== 'character').map(value => [value, []]));
        result.vrm = { model: [], animation: [] };
        for (const item of await listObjects(env, 'asset')) {
            const [folder] = item.name.split('/');
            if (!folder || folder === 'character') continue;
            if (folder === 'vrm') {
                const vrm = result.vrm as { model: string[]; animation: string[] };
                if (item.name.startsWith('vrm/model/')) vrm.model.push(`assets/${item.name}`);
                else if (item.name.startsWith('vrm/animation/')) vrm.animation.push(`assets/${item.name}`);
            } else if (Array.isArray(result[folder])) {
                (result[folder] as string[]).push(`assets/${item.name}`);
            }
        }
        return json(result);
    });
    router.on('POST', '/api/assets/download', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        const selectedCategory = category(body.category);
        const name = fileName(body.filename);
        const remote = safeRemoteUrl(body.url, 'url');
        const response = await fetch(remote, { signal: request.signal, redirect: 'follow' });
        if (!response.ok || !response.body) return json({ error: 'Asset download failed' }, { status: response.status || 502 });
        const length = Number(response.headers.get('content-length') ?? 0);
        if (!Number.isFinite(length) || length <= 0) throw new HttpError(422, 'Remote asset must provide Content-Length');
        if (length > maxUploadBytes(env)) throw new HttpError(413, 'Remote asset exceeds upload limit');
        if (selectedCategory === 'character') {
            const headers = new Headers({ 'content-type': mimeType(name, response.headers.get('content-type')), 'cache-control': 'no-store' });
            return new Response(response.body, { headers });
        }
        await putObject(env, 'asset', `${selectedCategory}/${name}`, response.body, {
            mimeType: mimeType(name, response.headers.get('content-type')),
            byteLength: length,
        });
        return empty(200);
    });
    router.on('POST', '/api/assets/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const deleted = await deleteObject(env, 'asset', `${category(body.category)}/${fileName(body.filename)}`);
        if (!deleted) throw new HttpError(404, 'Asset not found');
        return empty(200);
    });
    router.on('POST', '/api/assets/character', async ({ env, url }) => {
        const name = requireString(url.searchParams.get('name'), 'name', 128);
        const selectedCategory = category(url.searchParams.get('category'));
        const prefix = `character/${name}/${selectedCategory}/`;
        return json((await listObjects(env, 'asset')).filter(item => item.name.startsWith(prefix)).map(item => `assets/${item.name}`));
    });
    router.on('GET', '/assets/*', async ({ request, env, params }) => {
        const name = assetPath(params.wildcard);
        if (!await findObject(env, 'asset', name)) throw new HttpError(404, 'Asset not found');
        return serveObject(env, 'asset', name, request);
    });
    router.on('HEAD', '/assets/*', async ({ request, env, params }) => {
        const name = assetPath(params.wildcard);
        if (!await findObject(env, 'asset', name)) throw new HttpError(404, 'Asset not found');
        return serveObject(env, 'asset', name, request);
    });
}
