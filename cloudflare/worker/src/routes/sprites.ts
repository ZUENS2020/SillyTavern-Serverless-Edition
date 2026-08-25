import { unzipSync } from 'fflate';

import { DEFAULT_SPRITES } from '../defaults.generated';
import { empty, HttpError, json, maxJsonBytes, maxUploadBytes, readFormData, readJson, safeName } from '../http';
import type { Router } from '../router';
import { deleteObject, findObject, listObjects, putObject, putObjectsBulk, serveObject, type BulkObjectInput } from '../storage/objects';

function cleanComponent(value: unknown, field: string): string {
    const result = safeName(value, field).replace(/[<>:"|?*\u0000-\u001F]/gu, '').trim();
    if (!result || result.startsWith('.')) throw new HttpError(400, `Invalid ${field}`);
    return result;
}

function spriteFolder(value: unknown): string {
    if (typeof value !== 'string') throw new HttpError(400, 'Missing sprite name');
    const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
    if (parts.length < 1 || parts.length > 2) throw new HttpError(400, 'Invalid sprite folder');
    return parts.map((part, index) => cleanComponent(part, index === 0 ? 'name' : 'subfolder')).join('/');
}

function spritePath(value: unknown): string {
    if (typeof value !== 'string') throw new HttpError(400, 'Missing sprite path');
    const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
    if (parts.length < 2 || parts.length > 3) throw new HttpError(400, 'Invalid sprite path');
    return parts.map((part, index) => cleanComponent(decodeURIComponent(part), index === parts.length - 1 ? 'file' : 'folder')).join('/');
}

function extension(name: string): string {
    const match = /\.(png|jpe?g|gif|webp|bmp|apng)$/iu.exec(name);
    if (!match) throw new HttpError(400, 'Sprite must be an image');
    return `.${match[1]?.toLowerCase()}`;
}

function mimeType(name: string): string {
    const ext = extension(name);
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.svg') return 'image/svg+xml';
    return `image/${ext.slice(1)}`;
}

async function spriteForm(request: Request, env: Env): Promise<{ file: File; fields: Record<string, string> }> {
    const form = await readFormData(request, maxUploadBytes(env));
    let file: File | undefined;
    const fields: Record<string, string> = {};
    form.forEach((value, key) => {
        if (value instanceof File) {
            if (!file && (key === 'avatar' || key === 'file')) file = value;
        } else fields[key] = value;
    });
    if (!file) throw new HttpError(400, 'Missing sprite file');
    return { file, fields };
}

function baseName(name: string): string {
    const file = name.slice(name.lastIndexOf('/') + 1);
    const dot = file.lastIndexOf('.');
    return (dot > 0 ? file.slice(0, dot) : file).toLowerCase();
}

function expressionLabel(name: string): string {
    return baseName(name).match(/^(.+?)(?:[-.].*?)?$/u)?.[1] ?? baseName(name);
}

export function registerSpriteRoutes(router: Router): void {
    router.on('GET', '/api/sprites/get', async ({ env, url }) => {
        const folder = spriteFolder(url.searchParams.get('name'));
        const prefix = `${folder}/`;
        const custom = (await listObjects(env, 'sprite')).filter(item => item.name.startsWith(prefix) && !item.name.slice(prefix.length).includes('/'));
        const sprites = new Map<string, { label: string; path: string }>();
        if (folder === 'Seraphina') {
            for (const file of DEFAULT_SPRITES) sprites.set(baseName(file), { label: expressionLabel(file), path: `/characters/Seraphina/${encodeURIComponent(file)}` });
        }
        for (const item of custom) {
            const file = item.name.slice(prefix.length);
            sprites.set(baseName(file), { label: expressionLabel(file), path: `/characters/${folder.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(file)}?t=${item.updatedAt}` });
        }
        return json([...sprites.values()]);
    });
    router.on('POST', '/api/sprites/upload', async ({ request, env }) => {
        const { file, fields } = await spriteForm(request, env);
        const folder = spriteFolder(fields.name);
        const label = cleanComponent(fields.spriteName || fields.label, 'label');
        const name = `${folder}/${label}${extension(file.name)}`;
        await putObject(env, 'sprite', name, file.stream(), { mimeType: file.type || mimeType(name), byteLength: file.size });
        return json({ ok: true });
    });
    router.on('POST', '/api/sprites/upload-zip', async ({ request, env }) => {
        const { file, fields } = await spriteForm(request, env);
        if (file.size > 10_000_000) throw new HttpError(413, 'Sprite pack exceeds the serverless limit');
        const folder = spriteFolder(fields.name);
        const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
            filter: entry => !entry.name.endsWith('/') && /\.(?:png|jpe?g|gif|webp|bmp|apng)$/iu.test(entry.name),
        });
        const inputs: BulkObjectInput[] = [];
        for (const [entryName, bytes] of Object.entries(archive)) {
            const leaf = entryName.replaceAll('\\', '/').split('/').pop();
            if (!leaf) continue;
            const name = `${folder}/${cleanComponent(leaf, 'filename')}`;
            inputs.push({ kind: 'sprite', name, value: bytes, mimeType: mimeType(name), byteLength: bytes.byteLength });
            if (inputs.length === 40) break;
        }
        if (inputs.length === 0) throw new HttpError(400, 'Sprite pack contains no supported images');
        await putObjectsBulk(env, inputs);
        return json({ ok: true, count: inputs.length });
    });
    router.on('POST', '/api/sprites/delete', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const folder = spriteFolder(body.name);
        const target = cleanComponent(body.spriteName ?? body.label, 'spriteName').toLowerCase();
        const prefix = `${folder}/`;
        const matches = (await listObjects(env, 'sprite')).filter(item => item.name.startsWith(prefix) && baseName(item.name) === target);
        for (const item of matches) await deleteObject(env, 'sprite', item.name);
        return empty(200);
    });
    router.on('GET', '/characters/*', async ({ request, env, params }) => {
        const name = spritePath(params.wildcard);
        if (!await findObject(env, 'sprite', name)) throw new HttpError(404, 'Sprite not found');
        return serveObject(env, 'sprite', name, request);
    });
    router.on('HEAD', '/characters/*', async ({ request, env, params }) => {
        const name = spritePath(params.wildcard);
        if (!await findObject(env, 'sprite', name)) throw new HttpError(404, 'Sprite not found');
        return serveObject(env, 'sprite', name, request);
    });
}
