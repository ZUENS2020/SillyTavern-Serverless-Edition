import { strFromU8, unzipSync } from 'fflate';
import YAML from 'yaml';

import { DEFAULT_CHARACTER } from '../defaults.generated';
import {
    empty,
    HttpError,
    json,
    maxJsonBytes,
    maxUploadBytes,
    readFormData,
    readJson,
    safeName,
    text,
} from '../http';
import { readPngCharacter, writePngCharacter } from '../png-card';
import type { Router } from '../router';
import { listChats } from '../storage/chats';
import { deleteObject, findObject, putObject, renameObject, serveObject } from '../storage/objects';
import { deleteState, getState, listState, putState } from '../storage/state';

type JsonObject = Record<string, unknown>;

const DEFAULT_AVATAR = 'default_Seraphina.png';
const UNSET_SENTINEL = '__@@UNSET@@__';

interface CharacterInput {
    fields: JsonObject;
    file?: File;
}

interface ChatStatsRow {
    owner_id: string;
    chat_size: number;
    date_last_chat: number;
}

function objectValue(value: unknown): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Expected an object');
    return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function cloneObject(value: JsonObject): JsonObject {
    return structuredClone(value);
}

function booleanValue(value: unknown): boolean {
    return value === true || value === 'true';
}

function stringValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
    return [];
}

function setCardFields(card: JsonObject, fields: JsonObject): JsonObject {
    const name = safeName(fields.ch_name ?? fields.name ?? card.name ?? optionalObject(card.data).name, 'ch_name');
    const data = optionalObject(card.data);
    const existingExtensions = optionalObject(data.extensions);
    let submittedExtensions: JsonObject = {};
    if (typeof fields.extensions === 'string' && fields.extensions) {
        try {
            submittedExtensions = optionalObject(JSON.parse(fields.extensions));
        } catch {
            throw new HttpError(400, 'Invalid extensions JSON');
        }
    } else if (typeof fields.extensions === 'object' && fields.extensions !== null) {
        submittedExtensions = optionalObject(fields.extensions);
    }
    const tags = fields.tags === undefined ? stringArray(data.tags ?? card.tags) : stringArray(fields.tags);
    const alternateGreetings = fields.alternate_greetings === undefined
        ? stringArray(data.alternate_greetings)
        : stringArray(fields.alternate_greetings);
    const talkativeness = Number(fields.talkativeness ?? existingExtensions.talkativeness ?? card.talkativeness ?? 0.5);
    const fav = fields.fav === undefined ? booleanValue(existingExtensions.fav ?? card.fav) : booleanValue(fields.fav);
    const depth = optionalObject(existingExtensions.depth_prompt);
    const extensions = {
        ...existingExtensions,
        ...submittedExtensions,
        talkativeness: Number.isFinite(talkativeness) ? talkativeness : 0.5,
        fav,
        world: stringValue(fields.world, stringValue(existingExtensions.world)),
        depth_prompt: {
            ...depth,
            prompt: stringValue(fields.depth_prompt_prompt, stringValue(depth.prompt)),
            depth: Number(fields.depth_prompt_depth ?? depth.depth ?? 4),
            role: stringValue(fields.depth_prompt_role, stringValue(depth.role, 'system')),
        },
    };
    const description = stringValue(fields.description, stringValue(data.description ?? card.description));
    const personality = stringValue(fields.personality, stringValue(data.personality ?? card.personality));
    const scenario = stringValue(fields.scenario, stringValue(data.scenario ?? card.scenario));
    const firstMessage = stringValue(fields.first_mes, stringValue(data.first_mes ?? card.first_mes));
    const messageExample = stringValue(fields.mes_example, stringValue(data.mes_example ?? card.mes_example));
    const creatorNotes = stringValue(fields.creator_notes, stringValue(data.creator_notes ?? card.creatorcomment));
    return {
        ...card,
        name,
        description,
        personality,
        scenario,
        first_mes: firstMessage,
        mes_example: messageExample,
        creatorcomment: creatorNotes,
        avatar: 'none',
        chat: stringValue(fields.chat, stringValue(card.chat, `${name} - ${new Date().toISOString()}`)),
        create_date: stringValue(fields.create_date, stringValue(card.create_date, new Date().toISOString())),
        talkativeness: extensions.talkativeness,
        fav,
        tags,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            ...data,
            name,
            description,
            personality,
            scenario,
            first_mes: firstMessage,
            mes_example: messageExample,
            creator_notes: creatorNotes,
            system_prompt: stringValue(fields.system_prompt, stringValue(data.system_prompt)),
            post_history_instructions: stringValue(fields.post_history_instructions, stringValue(data.post_history_instructions)),
            tags,
            creator: stringValue(fields.creator, stringValue(data.creator)),
            character_version: stringValue(fields.character_version, stringValue(data.character_version)),
            alternate_greetings: alternateGreetings,
            extensions,
        },
    };
}

function normalizeImportedCard(value: unknown): JsonObject {
    const card = objectValue(value);
    const data = optionalObject(card.data);
    return setCardFields(card, {
        name: card.name ?? data.name,
        description: card.description ?? data.description,
        personality: card.personality ?? data.personality,
        scenario: card.scenario ?? data.scenario,
        first_mes: card.first_mes ?? data.first_mes,
        mes_example: card.mes_example ?? data.mes_example,
        creator_notes: card.creatorcomment ?? data.creator_notes,
        tags: card.tags ?? data.tags,
    });
}

async function characterInput(request: Request, env: Env): Promise<CharacterInput> {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return { fields: await readJson(request, maxJsonBytes(env)) };
    }
    const form = await readFormData(request, maxUploadBytes(env));
    const fields: JsonObject = {};
    let file: File | undefined;
    form.forEach((value, key) => {
        if (value instanceof File) {
            if (!file && (key === 'avatar' || key === 'file')) file = value;
        } else {
            fields[key] = value;
        }
    });
    return file ? { fields, file } : { fields };
}

async function deletedDefault(env: Env): Promise<boolean> {
    return (await getState<boolean>(env, 'system', 'default-character-deleted'))?.value === true;
}

async function characterCard(env: Env, avatar: string): Promise<JsonObject | null> {
    const saved = await getState<JsonObject>(env, 'character', avatar);
    if (saved) return saved.value;
    if (avatar === DEFAULT_AVATAR && !await deletedDefault(env)) return cloneObject(DEFAULT_CHARACTER);
    return null;
}

async function uniqueAvatar(env: Env, preferred: string, current?: string): Promise<string> {
    const base = safeName(preferred, 'name').replace(/\.png$/iu, '');
    const characters = await listState<JsonObject>(env, 'character');
    const names = new Set(characters.map(item => item.key));
    if (!await deletedDefault(env)) names.add(DEFAULT_AVATAR);
    if (current) names.delete(current);
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
        const avatar = `${base}${suffix === 0 ? '' : suffix}.png`;
        if (!names.has(avatar)) return avatar;
    }
    throw new HttpError(409, 'Could not allocate a unique character name');
}

async function chatStats(env: Env): Promise<Map<string, ChatStatsRow>> {
    const result = await env.DB.prepare(`
        SELECT owner_id, COALESCE(SUM(byte_length), 0) AS chat_size, COALESCE(MAX(updated_at), 0) AS date_last_chat
        FROM chats WHERE scope = 'character' GROUP BY owner_id
    `).all<ChatStatsRow>();
    return new Map(result.results.map(row => [row.owner_id, row]));
}

function presentCharacter(card: JsonObject, avatar: string, stats?: ChatStatsRow): JsonObject {
    const data = optionalObject(card.data);
    return {
        ...card,
        avatar,
        json_data: JSON.stringify(card),
        date_added: typeof card.date_added === 'number' ? card.date_added : Date.parse(stringValue(card.create_date)) || 0,
        date_last_chat: stats?.date_last_chat ?? 0,
        chat_size: stats?.chat_size ?? 0,
        data_size: JSON.stringify(data).length,
    };
}

function safeMerge(target: JsonObject, update: JsonObject): JsonObject {
    const result = cloneObject(target);
    for (const [key, value] of Object.entries(update)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor' || key === 'json_data') continue;
        if (value === UNSET_SENTINEL) {
            delete result[key];
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            result[key] = safeMerge(optionalObject(result[key]), value as JsonObject);
        } else {
            result[key] = value;
        }
    }
    return result;
}

async function deleteCharacterChats(env: Env, owner: string): Promise<void> {
    const result = await env.DB.prepare(
        "SELECT r2_key FROM chats WHERE scope = 'character' AND owner_id = ?",
    ).bind(owner).all<{ r2_key: string }>();
    const keys = result.results.map(row => row.r2_key);
    if (keys.length > 0) await env.BUCKET.delete(keys);
    await env.DB.prepare("DELETE FROM chats WHERE scope = 'character' AND owner_id = ?").bind(owner).run();
}

async function staticAvatarResponse(request: Request, avatar: string): Promise<Response> {
    const pagesOrigin = request.headers.get('x-sillytavern-pages-origin');
    if (!pagesOrigin) throw new HttpError(404, 'Static avatar is only available through Pages');
    const path = avatar === DEFAULT_AVATAR ? '/defaults/default_Seraphina.png' : '/img/ai4.png';
    const response = await fetch(new URL(path, pagesOrigin), { cf: { cacheEverything: true, cacheTtl: 86_400 } });
    if (!response.ok) throw new HttpError(404, 'Avatar image not found');
    return response;
}

async function rawAvatar(env: Env, request: Request, avatar: string): Promise<Uint8Array> {
    const indexed = await findObject(env, 'character-avatar', avatar);
    if (indexed) {
        const object = await env.BUCKET.get(indexed.r2Key);
        if (!object) throw new HttpError(404, 'Avatar image not found');
        return new Uint8Array(await object.arrayBuffer());
    }
    return new Uint8Array(await (await staticAvatarResponse(request, avatar)).arrayBuffer());
}

async function saveAvatar(env: Env, avatar: string, file: File): Promise<void> {
    if (file.size <= 0) throw new HttpError(400, 'Avatar is empty');
    await putObject(env, 'character-avatar', avatar, file.stream(), {
        mimeType: file.type || 'image/png',
        byteLength: file.size,
    });
}

async function parseImport(file: File, format: string): Promise<{ card: JsonObject; avatarFile?: File }> {
    if (format === 'png') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return { card: normalizeImportedCard(readPngCharacter(bytes)), avatarFile: file };
    }
    if (format === 'json') {
        let value: unknown;
        try {
            value = JSON.parse(await file.text());
        } catch {
            throw new HttpError(400, 'Invalid character JSON');
        }
        return { card: normalizeImportedCard(value) };
    }
    if (format === 'yaml' || format === 'yml') {
        const source = objectValue(YAML.parse(await file.text()));
        return { card: normalizeImportedCard({
            name: source.name,
            description: source.context,
            first_mes: source.greeting,
        }) };
    }
    if (format === 'charx') {
        if (file.size > 10_000_000) throw new HttpError(413, 'CharX exceeds the serverless import limit');
        const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: entry => entry.name === 'card.json' });
        const cardBytes = archive['card.json'];
        if (!cardBytes) throw new HttpError(400, 'CharX is missing card.json');
        return { card: normalizeImportedCard(JSON.parse(strFromU8(cardBytes))) };
    }
    throw new HttpError(400, `Unsupported character format: ${format}`);
}

export function registerCharacterRoutes(router: Router): void {
    router.on('POST', '/api/characters/all', async ({ env }) => {
        const [saved, stats, isDefaultDeleted] = await Promise.all([
            listState<JsonObject>(env, 'character'),
            chatStats(env),
            deletedDefault(env),
        ]);
        const cards = new Map(saved.map(item => [item.key, item.value]));
        if (!isDefaultDeleted && !cards.has(DEFAULT_AVATAR)) cards.set(DEFAULT_AVATAR, cloneObject(DEFAULT_CHARACTER));
        return json([...cards.entries()].map(([avatar, card]) => presentCharacter(card, avatar, stats.get(avatar.replace(/\.png$/iu, '')))));
    });
    router.on('POST', '/api/characters/get', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const avatar = safeName(body.avatar_url, 'avatar_url');
        const card = await characterCard(env, avatar);
        if (!card) throw new HttpError(404, 'Character not found');
        const stats = await chatStats(env);
        return json(presentCharacter(card, avatar, stats.get(avatar.replace(/\.png$/iu, ''))));
    });
    router.on('POST', '/api/characters/create', async ({ request, env }) => {
        const input = await characterInput(request, env);
        let seed: JsonObject = {};
        if (typeof input.fields.json_data === 'string' && input.fields.json_data) {
            try {
                seed = objectValue(JSON.parse(input.fields.json_data));
            } catch {
                throw new HttpError(400, 'Invalid json_data');
            }
        }
        const card = setCardFields(seed, input.fields);
        const avatar = await uniqueAvatar(env, stringValue(input.fields.file_name, stringValue(card.name)));
        await putState(env, 'character', avatar, card);
        if (input.file) await saveAvatar(env, avatar, input.file);
        return text(avatar);
    });
    router.on('POST', '/api/characters/edit', async ({ request, env }) => {
        const input = await characterInput(request, env);
        const avatar = safeName(input.fields.avatar_url, 'avatar_url');
        const existing = await characterCard(env, avatar);
        if (!existing) throw new HttpError(404, 'Character not found');
        let seed = existing;
        if (typeof input.fields.json_data === 'string' && input.fields.json_data) {
            try {
                seed = objectValue(JSON.parse(input.fields.json_data));
            } catch {
                throw new HttpError(400, 'Invalid json_data');
            }
        }
        await putState(env, 'character', avatar, setCardFields(seed, input.fields));
        if (input.file) await saveAvatar(env, avatar, input.file);
        return empty(200, { 'cache-control': 'no-store' });
    });
    router.on('POST', '/api/characters/edit-avatar', async ({ request, env }) => {
        const input = await characterInput(request, env);
        const avatar = safeName(input.fields.avatar_url, 'avatar_url');
        if (!await characterCard(env, avatar)) throw new HttpError(404, 'Character not found');
        if (!input.file) throw new HttpError(400, 'No avatar uploaded');
        await saveAvatar(env, avatar, input.file);
        return empty(200, { 'cache-control': 'no-store' });
    });
    router.on('POST', '/api/characters/rename', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        const oldAvatar = safeName(body.avatar_url, 'avatar_url');
        const card = await characterCard(env, oldAvatar);
        if (!card) throw new HttpError(404, 'Character not found');
        const newName = safeName(body.new_name, 'new_name');
        const newAvatar = await uniqueAvatar(env, newName, oldAvatar);
        const updated = cloneObject(card);
        updated.name = newName;
        const data = optionalObject(updated.data);
        updated.data = { ...data, name: newName };
        await putState(env, 'character', newAvatar, updated);
        await deleteState(env, 'character', oldAvatar);
        await renameObject(env, 'character-avatar', oldAvatar, newAvatar);
        const oldOwner = oldAvatar.replace(/\.png$/iu, '');
        const newOwner = newAvatar.replace(/\.png$/iu, '');
        await env.DB.prepare("UPDATE chats SET owner_id = ? WHERE scope = 'character' AND owner_id = ?").bind(newOwner, oldOwner).run();
        if (oldAvatar === DEFAULT_AVATAR) await putState(env, 'system', 'default-character-deleted', true);
        return json({ avatar: newAvatar });
    });
    router.on('POST', '/api/characters/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const avatar = safeName(body.avatar_url, 'avatar_url');
        if (!await characterCard(env, avatar)) throw new HttpError(404, 'Character not found');
        await Promise.all([deleteState(env, 'character', avatar), deleteObject(env, 'character-avatar', avatar)]);
        if (avatar === DEFAULT_AVATAR) await putState(env, 'system', 'default-character-deleted', true);
        if (body.delete_chats === true) await deleteCharacterChats(env, avatar.replace(/\.png$/iu, ''));
        return empty(200);
    });
    router.on('POST', '/api/characters/duplicate', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const avatar = safeName(body.avatar_url, 'avatar_url');
        const card = await characterCard(env, avatar);
        if (!card) throw new HttpError(404, 'Character not found');
        const base = avatar.replace(/\.png$/iu, '').replace(/_\d+$/u, '');
        const newAvatar = await uniqueAvatar(env, `${base}_1`);
        await putState(env, 'character', newAvatar, card);
        const source = await findObject(env, 'character-avatar', avatar);
        if (source) {
            const object = await env.BUCKET.get(source.r2Key);
            if (object) await putObject(env, 'character-avatar', newAvatar, object.body, { mimeType: source.mimeType, byteLength: source.byteLength });
        }
        return json({ path: newAvatar });
    });
    router.on('POST', '/api/characters/edit-attribute', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const avatar = safeName(body.avatar_url, 'avatar_url');
        const field = safeName(body.field, 'field');
        if (field === 'json_data') throw new HttpError(400, 'Cannot edit json_data');
        const card = await characterCard(env, avatar);
        if (!card) throw new HttpError(404, 'Character not found');
        card[field] = body.value;
        const data = optionalObject(card.data);
        data[field] = body.value;
        card.data = data;
        await putState(env, 'character', avatar, card);
        return empty(200);
    });
    router.on('POST', '/api/characters/merge-attributes', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        if (Array.isArray(body.avatars)) {
            const update = objectValue(body.data);
            const all = await listState<JsonObject>(env, 'character');
            const avatars = body.avatars.length > 0
                ? body.avatars.filter((value): value is string => typeof value === 'string').slice(0, 50)
                : all.map(item => item.key).slice(0, 50);
            const updated: string[] = [];
            const failed: string[] = [];
            for (const avatarValue of avatars) {
                try {
                    const avatar = safeName(avatarValue, 'avatar');
                    const card = await characterCard(env, avatar);
                    if (!card) throw new HttpError(404, 'Character not found');
                    await putState(env, 'character', avatar, safeMerge(card, update));
                    updated.push(avatar);
                } catch {
                    failed.push(avatarValue);
                }
            }
            return json({ updated, skipped: [], failed });
        }
        const avatar = safeName(body.avatar, 'avatar');
        const card = await characterCard(env, avatar);
        if (!card) throw new HttpError(404, 'Character not found');
        await putState(env, 'character', avatar, safeMerge(card, body));
        return empty(200);
    });
    router.on('POST', '/api/characters/import', async ({ request, env }) => {
        const input = await characterInput(request, env);
        if (!input.file) throw new HttpError(400, 'Missing character file');
        const format = stringValue(input.fields.file_type, input.file.name.split('.').pop()?.toLowerCase() ?? '');
        const parsed = await parseImport(input.file, format);
        const preserved = stringValue(input.fields.preserved_name).replace(/\.png$/iu, '');
        const avatar = preserved
            ? `${safeName(preserved, 'preserved_name')}.png`
            : await uniqueAvatar(env, stringValue(parsed.card.name, 'Character'));
        await putState(env, 'character', avatar, parsed.card);
        if (parsed.avatarFile) await saveAvatar(env, avatar, parsed.avatarFile);
        return json({ file_name: avatar.replace(/\.png$/iu, '') });
    });
    router.on('POST', '/api/characters/export', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const avatar = safeName(body.avatar_url, 'avatar_url');
        const card = await characterCard(env, avatar);
        if (!card) throw new HttpError(404, 'Character not found');
        const exported = cloneObject(card);
        exported.fav = false;
        delete exported.chat;
        const data = optionalObject(exported.data);
        const extensions = optionalObject(data.extensions);
        extensions.fav = false;
        data.extensions = extensions;
        exported.data = data;
        if (body.format === 'json') {
            return text(JSON.stringify(exported, null, 4), {
                headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${encodeURIComponent(avatar.replace(/\.png$/iu, '.json'))}"` },
            });
        }
        if (body.format === 'png') {
            const source = await rawAvatar(env, request, avatar);
            const output = writePngCharacter(source, exported);
            const responseBytes = new Uint8Array(output.byteLength);
            responseBytes.set(output);
            return new Response(responseBytes.buffer, {
                headers: { 'content-type': 'image/png', 'content-disposition': `attachment; filename="${encodeURIComponent(avatar)}"` },
            });
        }
        throw new HttpError(400, 'Unsupported export format');
    });
    router.on('GET', '/characters/:name', async ({ request, env, params }) => {
        const avatar = safeName(params.name, 'avatar');
        const object = await findObject(env, 'character-avatar', avatar);
        if (object) return serveObject(env, 'character-avatar', avatar, request);
        const card = await characterCard(env, avatar);
        if (card && avatar !== DEFAULT_AVATAR) return Response.redirect(new URL('/img/ai4.png', request.url), 302);
        throw new HttpError(404, 'Character avatar not found');
    });
    router.on('HEAD', '/characters/:name', async ({ request, env, params }) => {
        const avatar = safeName(params.name, 'avatar');
        const object = await findObject(env, 'character-avatar', avatar);
        if (object) return serveObject(env, 'character-avatar', avatar, request);
        throw new HttpError(404, 'Character avatar not found');
    });
}
