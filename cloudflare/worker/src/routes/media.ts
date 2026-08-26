import { Buffer } from 'node:buffer';

import { DEFAULT_BACKGROUNDS } from '../defaults.generated';
import {
    empty,
    HttpError,
    json,
    maxUploadBytes,
    readFormData,
    readJson,
    safeName,
    text,
} from '../http';
import type { Router } from '../router';
import { deleteObject, findObject, listObjects, putObject, renameObject, serveObject } from '../storage/objects';
import { deleteState, getState, listState, putState } from '../storage/state';

const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'apng', 'mp4', 'webm', 'mp3', 'wav', 'ogg']);
const DEFAULT_BACKGROUND_SET = new Set<string>(DEFAULT_BACKGROUNDS);

function cleanFileName(value: unknown, field = 'name'): string {
    const source = safeName(value, field);
    const cleaned = source.replace(/[<>:"|?*\u0000-\u001F]/gu, '').trim();
    if (!cleaned || cleaned.startsWith('.')) throw new HttpError(400, `Invalid ${field}`);
    return cleaned.slice(0, 180);
}

function relativeName(value: unknown, prefix: string): string {
    if (typeof value !== 'string') throw new HttpError(400, 'Missing path');
    let normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
    const normalizedPrefix = prefix.replace(/^\/+|\/+$/gu, '');
    if (normalized === normalizedPrefix) throw new HttpError(400, 'Missing file name');
    if (normalized.startsWith(`${normalizedPrefix}/`)) normalized = normalized.slice(normalizedPrefix.length + 1);
    const segments = normalized.split('/').filter(Boolean).map(segment => cleanFileName(decodeURIComponent(segment), 'path'));
    if (segments.length === 0 || segments.length > 8) throw new HttpError(400, 'Invalid path');
    return segments.join('/');
}

function contentTypeFor(name: string, fallback = 'application/octet-stream'): string {
    const extension = name.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
        bmp: 'image/bmp', svg: 'image/svg+xml', apng: 'image/apng', mp4: 'video/mp4', webm: 'video/webm',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', json: 'application/json', txt: 'text/plain',
        pdf: 'application/pdf', zip: 'application/zip', css: 'text/css', js: 'text/javascript', html: 'text/html',
    };
    return extension ? types[extension] ?? fallback : fallback;
}

async function uploadedFile(request: Request, env: Env): Promise<{ file: File; fields: Record<string, string> }> {
    const form = await readFormData(request, maxUploadBytes(env));
    let file: File | undefined;
    const fields: Record<string, string> = {};
    form.forEach((value, key) => {
        if (value instanceof File) {
            if (!file && (key === 'avatar' || key === 'file')) file = value;
        } else {
            fields[key] = value;
        }
    });
    if (!file) throw new HttpError(400, 'Missing uploaded file');
    return { file, fields };
}

async function writeFileObject(env: Env, kind: string, name: string, file: File): Promise<void> {
    await putObject(env, kind, name, file.stream(), {
        mimeType: file.type || contentTypeFor(name),
        byteLength: file.size,
    });
}

async function hiddenBackgrounds(env: Env): Promise<Set<string>> {
    return new Set((await listState<boolean>(env, 'hidden-background')).filter(item => item.value).map(item => item.key));
}

async function serveOrNotFound(env: Env, kind: string, name: string, request: Request): Promise<Response> {
    if (!await findObject(env, kind, name)) throw new HttpError(404, 'File not found');
    return serveObject(env, kind, name, request);
}

function isAnimatedName(name: string): boolean {
    return /\.(?:gif|apng|webp|mp4|webm)$/iu.test(name);
}

interface ImageFolder {
    id: string;
    name: string;
    thumbnailFile?: string;
}

function isImageFolder(value: unknown): value is ImageFolder {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string' && typeof record.name === 'string';
}

async function imageFolders(env: Env): Promise<ImageFolder[]> {
    const value = (await getState<unknown[]>(env, 'image-metadata', 'background-folders'))?.value;
    return Array.isArray(value) ? value.filter(isImageFolder) : [];
}

async function imageFolderMap(env: Env): Promise<Record<string, string[]>> {
    return (await getState<Record<string, string[]>>(env, 'image-metadata', 'background-map'))?.value ?? {};
}

function backgroundFileFromPath(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replaceAll('\\', '/');
    const leaf = normalized.slice(normalized.lastIndexOf('/') + 1);
    try {
        return cleanFileName(leaf, 'path');
    } catch {
        return null;
    }
}

export function registerMediaRoutes(router: Router): void {
    router.on('POST', '/api/backgrounds/all', async ({ env }) => {
        const [custom, hidden] = await Promise.all([listObjects(env, 'background'), hiddenBackgrounds(env)]);
        const map = new Map<string, boolean>();
        for (const name of DEFAULT_BACKGROUNDS) if (!hidden.has(name)) map.set(name, isAnimatedName(name));
        for (const item of custom) map.set(item.name, isAnimatedName(item.name));
        return json({
            images: [...map.entries()].map(([filename, isAnimated]) => ({ filename, isAnimated })),
            config: { width: 160, height: 90 },
        });
    });
    router.on('POST', '/api/backgrounds/folders', async ({ env }) => {
        const folders = (await getState<unknown[]>(env, 'image-metadata', 'background-folders'))?.value ?? [];
        const imageFolderMap = (await getState<Record<string, string[]>>(env, 'image-metadata', 'background-map'))?.value ?? {};
        return json({ folders, imageFolderMap });
    });
    router.on('POST', '/api/backgrounds/upload', async ({ request, env }) => {
        const { file } = await uploadedFile(request, env);
        const name = cleanFileName(file.name, 'filename');
        await writeFileObject(env, 'background', name, file);
        await deleteState(env, 'hidden-background', name);
        return text(name);
    });
    router.on('POST', '/api/backgrounds/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const name = cleanFileName(body.bg, 'bg');
        const deleted = await deleteObject(env, 'background', name);
        if (!deleted && !DEFAULT_BACKGROUND_SET.has(name)) throw new HttpError(404, 'Background not found');
        if (!deleted) await putState(env, 'hidden-background', name, true);
        return text('ok');
    });
    router.on('POST', '/api/backgrounds/rename', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const oldName = cleanFileName(body.old_bg, 'old_bg');
        const newName = cleanFileName(body.new_bg, 'new_bg');
        const renamed = await renameObject(env, 'background', oldName, newName);
        if (!renamed) throw new HttpError(409, 'Bundled backgrounds cannot be renamed; upload a copy instead');
        return text('ok');
    });
    router.on('GET', '/backgrounds/:name', ({ request, env, params }) => serveOrNotFound(env, 'background', cleanFileName(params.name), request));
    router.on('HEAD', '/backgrounds/:name', ({ request, env, params }) => serveOrNotFound(env, 'background', cleanFileName(params.name), request));

    router.on('POST', '/api/avatars/get', async ({ env }) => json((await listObjects(env, 'user-avatar')).map(item => item.name)));
    router.on('POST', '/api/avatars/upload', async ({ request, env }) => {
        const { file, fields } = await uploadedFile(request, env);
        const name = cleanFileName(fields.overwrite_name || `${Date.now()}.png`, 'overwrite_name');
        await writeFileObject(env, 'user-avatar', name, file);
        return json({ path: name });
    });
    router.on('POST', '/api/avatars/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const deleted = await deleteObject(env, 'user-avatar', cleanFileName(body.avatar, 'avatar'));
        if (!deleted) throw new HttpError(404, 'Avatar not found');
        return json({ result: 'ok' });
    });
    const serveAvatar = ({ request, env, params }: { request: Request; env: Env; params: Readonly<Record<string, string>> }) => serveOrNotFound(env, 'user-avatar', cleanFileName(params.name), request);
    router.on('GET', '/User%20Avatars/:name', serveAvatar);
    router.on('HEAD', '/User%20Avatars/:name', serveAvatar);
    router.on('GET', '/User Avatars/:name', serveAvatar);
    router.on('HEAD', '/User Avatars/:name', serveAvatar);

    router.on('POST', '/api/images/upload', async ({ request, env }) => {
        const isMultipart = (request.headers.get('content-type') ?? '').includes('multipart/form-data');
        if (isMultipart) {
            const form = await readFormData(request, maxUploadBytes(env) + 65_536);
            const file = form.get('image');
            if (!(file instanceof File) || file.size === 0) throw new HttpError(400, 'No image file provided');
            if (file.size > maxUploadBytes(env)) throw new HttpError(413, 'Image exceeds upload limit');
            const format = String(form.get('format') ?? file.name.split('.').pop() ?? '').toLowerCase();
            if (!IMAGE_FORMATS.has(format)) throw new HttpError(400, 'Invalid image format');
            const base = String(form.get('filename') ?? file.name).replace(/\.[^.]+$/u, '') || String(Date.now());
            const fileName = `${cleanFileName(base, 'filename')}.${format}`;
            const folderValue = String(form.get('ch_name') ?? '');
            const folder = folderValue ? cleanFileName(folderValue, 'ch_name') : '';
            const name = folder ? `${folder}/${fileName}` : fileName;
            await putObject(env, 'user-image', name, file.stream(), {
                mimeType: file.type || contentTypeFor(name), byteLength: file.size,
            });
            return json({ path: `user/images/${name.split('/').map(encodeURIComponent).join('/')}` });
        }

        const body = await readJson(request, maxUploadBytes(env) * 2);
        const format = typeof body.format === 'string' ? body.format.toLowerCase() : '';
        if (!IMAGE_FORMATS.has(format)) throw new HttpError(400, 'Invalid image format');
        const base = typeof body.filename === 'string' && body.filename ? body.filename.replace(/\.[^.]+$/u, '') : String(Date.now());
        const fileName = `${cleanFileName(base, 'filename')}.${format}`;
        const folder = typeof body.ch_name === 'string' && body.ch_name ? cleanFileName(body.ch_name, 'ch_name') : '';
        const name = folder ? `${folder}/${fileName}` : fileName;

        if (typeof body.image !== 'string' || !body.image) throw new HttpError(400, 'No image data provided');
        let bytes: Buffer;
        try {
            bytes = Buffer.from(body.image, 'base64');
        } catch {
            throw new HttpError(400, 'Invalid base64 image');
        }
        if (bytes.byteLength > maxUploadBytes(env)) throw new HttpError(413, 'Image exceeds upload limit');
        await putObject(env, 'user-image', name, bytes, {
            mimeType: contentTypeFor(name),
            byteLength: bytes.byteLength,
        });
        return json({ path: `user/images/${name.split('/').map(encodeURIComponent).join('/')}` });
    });
    const listImages = async (request: Request, env: Env, routeFolder?: string): Promise<Response> => {
        const body = await readJson(request, 32_768);
        const folderValue = routeFolder ?? body.folder;
        const folder = cleanFileName(folderValue, 'folder');
        const prefix = `${folder}/`;
        const files = (await listObjects(env, 'user-image')).filter(item => item.name.startsWith(prefix) && !item.name.slice(prefix.length).includes('/'));
        if (body.sortOrder === 'desc') files.reverse();
        return json(files.map(item => item.name.slice(prefix.length)));
    };
    router.on('POST', '/api/images/list', ({ request, env }) => listImages(request, env));
    router.on('POST', '/api/images/list/:folder', ({ request, env, params }) => listImages(request, env, params.folder));
    router.on('POST', '/api/images/folders', async ({ env }) => {
        const folders = new Set<string>();
        for (const item of await listObjects(env, 'user-image')) if (item.name.includes('/')) folders.add(item.name.split('/')[0] ?? '');
        return json([...folders].filter(Boolean).toSorted());
    });
    router.on('POST', '/api/images/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const deleted = await deleteObject(env, 'user-image', relativeName(body.path, 'user/images'));
        if (!deleted) throw new HttpError(404, 'Image not found');
        return empty(200);
    });
    router.on('GET', '/user/images/*', ({ request, env, params }) => serveOrNotFound(env, 'user-image', relativeName(params.wildcard, ''), request));
    router.on('HEAD', '/user/images/*', ({ request, env, params }) => serveOrNotFound(env, 'user-image', relativeName(params.wildcard, ''), request));

    router.on('POST', '/api/files/sanitize-filename', async ({ request }) => {
        const body = await readJson(request, 16_384);
        return json({ fileName: cleanFileName(body.fileName, 'fileName') });
    });
    router.on('POST', '/api/files/upload', async ({ request, env }) => {
        const body = await readJson(request, maxUploadBytes(env));
        const name = cleanFileName(body.name, 'name');
        if (typeof body.data !== 'string' || !body.data) throw new HttpError(400, 'No upload data specified');
        const bytes = Buffer.from(body.data, 'base64');
        if (bytes.byteLength > maxUploadBytes(env)) throw new HttpError(413, 'File exceeds upload limit');
        await putObject(env, 'user-file', name, bytes, {
            mimeType: contentTypeFor(name),
            byteLength: bytes.byteLength,
        });
        return json({ path: `user/files/${encodeURIComponent(name)}` });
    });
    router.on('POST', '/api/files/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const deleted = await deleteObject(env, 'user-file', relativeName(body.path, 'user/files'));
        if (!deleted) throw new HttpError(404, 'File not found');
        return empty(200);
    });
    router.on('POST', '/api/files/verify', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        if (!Array.isArray(body.urls)) throw new HttpError(400, 'No URLs specified');
        const available = new Set((await listObjects(env, 'user-file')).map(item => item.name));
        const verified: Record<string, boolean> = {};
        for (const value of body.urls.slice(0, 500)) {
            if (typeof value !== 'string') continue;
            try {
                verified[value] = available.has(relativeName(value, 'user/files'));
            } catch {
                verified[value] = false;
            }
        }
        return json(verified);
    });
    router.on('GET', '/user/files/*', ({ request, env, params }) => serveOrNotFound(env, 'user-file', relativeName(params.wildcard, ''), request));
    router.on('HEAD', '/user/files/*', ({ request, env, params }) => serveOrNotFound(env, 'user-file', relativeName(params.wildcard, ''), request));

    router.on('GET', '/thumbnail', async ({ request, env, url }) => {
        const file = cleanFileName(url.searchParams.get('file'), 'file');
        const type = url.searchParams.get('type');
        if (type === 'avatar') {
            if (await findObject(env, 'character-avatar', file)) return serveObject(env, 'character-avatar', file, request);
            return Response.redirect(new URL(`/characters/${encodeURIComponent(file)}`, request.url), 302);
        }
        if (type === 'persona') {
            if (await findObject(env, 'user-avatar', file)) return serveObject(env, 'user-avatar', file, request);
            return Response.redirect(new URL(`/User%20Avatars/${encodeURIComponent(file)}`, request.url), 302);
        }
        if (type === 'bg') {
            if (await findObject(env, 'background', file)) return serveObject(env, 'background', file, request);
            return Response.redirect(new URL(`/backgrounds/${encodeURIComponent(file)}`, request.url), 302);
        }
        throw new HttpError(400, 'Invalid thumbnail type');
    });

    router.on('POST', '/api/image-metadata/folders/get', async ({ env }) => json(await imageFolders(env)));
    router.on('POST', '/api/image-metadata/folders/create', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const folder: ImageFolder = { id: crypto.randomUUID(), name: cleanFileName(body.name, 'name'), thumbnailFile: '' };
        const folders = await imageFolders(env);
        folders.push(folder);
        await putState(env, 'image-metadata', 'background-folders', folders);
        return json(folder);
    });
    router.on('POST', '/api/image-metadata/folders/update', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const id = typeof body.id === 'string' ? body.id : '';
        const folders = await imageFolders(env);
        const folder = folders.find(item => item.id === id);
        if (!folder) throw new HttpError(404, 'Folder not found');
        if (typeof body.name === 'string') folder.name = cleanFileName(body.name, 'name');
        if (typeof body.thumbnailFile === 'string') folder.thumbnailFile = body.thumbnailFile.slice(0, 180);
        await putState(env, 'image-metadata', 'background-folders', folders);
        return json(folder);
    });
    router.on('POST', '/api/image-metadata/folders/set-thumbnails', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        if (!Array.isArray(body.updates)) throw new HttpError(400, 'updates must be an array');
        const folders = await imageFolders(env);
        for (const value of body.updates.slice(0, 100)) {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
            const update = value as Record<string, unknown>;
            const folder = folders.find(item => item.id === update.id);
            if (folder && typeof update.thumbnailFile === 'string') folder.thumbnailFile = update.thumbnailFile.slice(0, 180);
        }
        await putState(env, 'image-metadata', 'background-folders', folders);
        return json({ ok: true });
    });
    router.on('POST', '/api/image-metadata/folders/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const id = typeof body.id === 'string' ? body.id : '';
        const folders = await imageFolders(env);
        if (!folders.some(folder => folder.id === id)) throw new HttpError(404, 'Folder not found');
        const map = await imageFolderMap(env);
        for (const [name, ids] of Object.entries(map)) {
            map[name] = ids.filter(value => value !== id);
            if (map[name]?.length === 0) delete map[name];
        }
        await Promise.all([
            putState(env, 'image-metadata', 'background-folders', folders.filter(folder => folder.id !== id)),
            putState(env, 'image-metadata', 'background-map', map),
        ]);
        return json({ ok: true });
    });
    const assignFolder = async (request: Request, env: Env, remove: boolean): Promise<Response> => {
        const body = await readJson(request, 65_536);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!(await imageFolders(env)).some(folder => folder.id === id)) throw new HttpError(404, 'Folder not found');
        if (!Array.isArray(body.paths)) throw new HttpError(400, 'paths must be an array');
        const map = await imageFolderMap(env);
        for (const path of body.paths.slice(0, 200)) {
            const name = backgroundFileFromPath(path);
            if (!name) continue;
            const current = map[name] ?? [];
            if (remove) {
                map[name] = current.filter(value => value !== id);
                if (map[name]?.length === 0) delete map[name];
            } else if (!current.includes(id)) map[name] = [...current, id];
        }
        await putState(env, 'image-metadata', 'background-map', map);
        return json({ ok: true });
    };
    router.on('POST', '/api/image-metadata/folders/assign', ({ request, env }) => assignFolder(request, env, false));
    router.on('POST', '/api/image-metadata/folders/unassign', ({ request, env }) => assignFolder(request, env, true));
    router.on('POST', '/api/image-metadata', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        const map = await imageFolderMap(env);
        const metadata = (path: unknown) => {
            const name = backgroundFileFromPath(path);
            return name ? { isAnimated: isAnimatedName(name), folderIds: map[name] ?? [] } : { error: 'Invalid path' };
        };
        if (typeof body.path === 'string' && !body.paths) return json(metadata(body.path));
        if (Array.isArray(body.paths)) return json(Object.fromEntries(body.paths.filter((value): value is string => typeof value === 'string').map(path => [path, metadata(path)])));
        throw new HttpError(400, 'Either path or paths is required');
    });
    router.on('POST', '/api/image-metadata/all', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const prefix = typeof body.prefix === 'string' ? body.prefix : '';
        const map = await imageFolderMap(env);
        const images = Object.fromEntries(Object.entries(map)
            .map(([name, folderIds]) => [`backgrounds/${name}`, { folderIds, isAnimated: isAnimatedName(name) }] as const)
            .filter(([path]) => path.startsWith(prefix)));
        return json({ version: 1, images });
    });
    router.on('POST', '/api/image-metadata/cleanup', () => json({ ok: true }));
}
