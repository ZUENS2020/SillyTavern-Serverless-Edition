import {
    empty,
    HttpError,
    json,
    maxJsonBytes,
    maxUploadBytes,
    readFormData,
    readJson,
    requireString,
    safeName,
} from '../http';
import type { Router } from '../router';
import {
    deleteChat,
    findChat,
    listChats,
    readChat,
    renameChat,
    saveChat,
    searchChats,
    type ChatScope,
    type StoredChat,
} from '../storage/chats';
import { getState, listState } from '../storage/state';

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function normalizedChatName(value: unknown, field = 'file_name'): string {
    const name = safeName(value, field);
    return name.toLowerCase().endsWith('.jsonl') ? name.slice(0, -6) : name;
}

function characterOwner(value: unknown): string {
    const avatar = safeName(value, 'avatar_url');
    return avatar.toLowerCase().endsWith('.png') ? avatar.slice(0, -4) : avatar;
}

function stringifyChat(chat: unknown[]): { serialized: string; metadata: JsonObject; lastMessage: string; searchText: string } {
    const serialized = JSON.stringify(chat);
    const header = objectValue(chat[0]);
    const metadata = objectValue(header.chat_metadata);
    let lastMessage = '';
    const searchable: string[] = [];
    let searchLength = 0;
    for (let index = 1; index < chat.length; index += 1) {
        const message = objectValue(chat[index]);
        if (typeof message.mes !== 'string') continue;
        lastMessage = message.mes;
        if (searchLength < 65_536) {
            const part = message.mes.slice(0, 16_384).toLowerCase();
            searchable.push(part);
            searchLength += part.length + 1;
        }
    }
    return { serialized, metadata, lastMessage, searchText: searchable.join('\n').slice(0, 65_536) };
}

async function saveFromBody(
    env: Env,
    execution: ExecutionContext,
    body: JsonObject,
    scope: ChatScope,
    ownerId: string,
    name: string,
): Promise<Response> {
    if (!Array.isArray(body.chat)) throw new HttpError(400, "The request's body.chat is not an array.");
    const prepared = stringifyChat(body.chat);
    const existing = await findChat(env, scope, ownerId, name);
    const incomingIntegrity = prepared.metadata.integrity;
    if (!body.force && existing && typeof incomingIntegrity === 'string') {
        const storedIntegrity = existing.metadata.integrity;
        if (typeof storedIntegrity === 'string' && storedIntegrity !== incomingIntegrity) {
            return json({ error: 'integrity' }, { status: 400 });
        }
    }
    const requestedRevision = Number(body.revision);
    const expectedRevision = body.force && existing
        ? existing.revision
        : Number.isInteger(requestedRevision) && requestedRevision >= 0
            ? requestedRevision
            : existing ? -1 : 0;
    if (expectedRevision < 0) throw new HttpError(409, `Chat revision is required; current revision is ${existing?.revision ?? 0}`);
    const saved = await saveChat(env, execution, {
        scope,
        ownerId,
        name,
        serialized: prepared.serialized,
        expectedRevision,
        metadata: prepared.metadata,
        lastMessage: prepared.lastMessage,
        searchText: prepared.searchText,
        messageCount: Math.max(0, body.chat.length - 1),
    });
    return json({ ok: true, revision: saved.revision });
}

function humanFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function chatInfo(chat: StoredChat, additions: JsonObject = {}): JsonObject {
    return {
        match: true,
        file_id: chat.name,
        file_name: `${chat.name}.jsonl`,
        file_size: humanFileSize(chat.byteLength),
        chat_items: chat.messageCount,
        mes: chat.lastMessage || '[The chat is empty]',
        last_mes: new Date(chat.updatedAt).toISOString(),
        chat_metadata: chat.metadata,
        revision: chat.revision,
        ...additions,
    };
}

async function chatJsonResponse(env: Env, chat: StoredChat): Promise<Response> {
    const object = await readChat(env, chat);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.set('etag', object.httpEtag);
    headers.set('x-chat-revision', String(chat.revision));
    return new Response(object.body, { headers });
}

function expectedRevision(request: Request): number {
    const source = request.headers.get('if-match')?.replaceAll('"', '').trim();
    const parsed = Number(source);
    if (!Number.isInteger(parsed) || parsed < 0) throw new HttpError(428, 'If-Match chat revision is required');
    return parsed;
}

function decodedMetadata(request: Request): JsonObject {
    const encoded = request.headers.get('x-st-chat-metadata');
    if (!encoded) return {};
    if (encoded.length > 10_922) throw new HttpError(431, 'Chat metadata header is too large');
    try {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        return objectValue(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    } catch {
        throw new HttpError(400, 'Invalid chat metadata header');
    }
}

function decodedLastMessage(request: Request): string {
    const encoded = request.headers.get('x-st-last-message');
    if (!encoded) return '';
    if (encoded.length > 2_200) throw new HttpError(431, 'Last-message header is too large');
    try {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        return new TextDecoder().decode(bytes).slice(-400);
    } catch {
        throw new HttpError(400, 'Invalid last-message header');
    }
}

async function parseImportedChat(file: File, body: FormData): Promise<unknown[]> {
    const raw = await file.text();
    const formatValue = body.get('file_type');
    const format = typeof formatValue === 'string' ? formatValue.toLowerCase() : file.name.split('.').pop()?.toLowerCase();
    if (format === 'jsonl') {
        const messages: unknown[] = [];
        for (const line of raw.split(/\r?\n/u)) {
            if (!line.trim()) continue;
            try {
                messages.push(JSON.parse(line));
            } catch {
                throw new HttpError(400, 'Invalid JSONL chat');
            }
        }
        if (messages.length === 0) throw new HttpError(400, 'The chat is empty');
        return messages;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new HttpError(400, 'Invalid JSON chat');
    }
    if (Array.isArray(parsed)) return parsed;
    const data = objectValue(parsed);
    const userName = typeof body.get('user_name') === 'string' ? String(body.get('user_name')) : 'User';
    const characterName = typeof body.get('character_name') === 'string' ? String(body.get('character_name')) : 'Character';
    const output: unknown[] = [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }];
    const visible = data.data_visible;
    if (Array.isArray(visible)) {
        for (const pair of visible) {
            if (!Array.isArray(pair)) continue;
            if (typeof pair[0] === 'string' && pair[0]) output.push({ name: userName, is_user: true, send_date: new Date().toISOString(), mes: pair[0], extra: {} });
            if (typeof pair[1] === 'string' && pair[1]) output.push({ name: characterName, is_user: false, send_date: new Date().toISOString(), mes: pair[1], extra: {} });
        }
        return output;
    }
    const messages = data.messages;
    if (Array.isArray(messages)) {
        for (const item of messages) {
            const message = objectValue(item);
            const isUser = Boolean(message.userId) || message.role === 'user';
            const content = typeof message.msg === 'string' ? message.msg : typeof message.data === 'string' ? message.data : '';
            output.push({ name: isUser ? userName : characterName, is_user: isUser, send_date: new Date().toISOString(), mes: content, extra: {} });
        }
        return output;
    }
    throw new HttpError(400, 'Unsupported JSON chat format');
}

function importedName(characterName: string): string {
    return `${characterName} - ${new Date().toISOString().replaceAll(':', '-') } imported`;
}

export function registerChatRoutes(router: Router): void {
    router.on('PUT', '/api/chats/content/:scope/:owner/:name', async ({ request, env, execution, params }) => {
        const declaredLength = Number(request.headers.get('content-length') ?? 0);
        if (declaredLength > maxUploadBytes(env)) throw new HttpError(413, 'Chat payload is too large');
        if (!request.body) throw new HttpError(400, 'Missing chat body');
        const scope = params.scope === 'group' ? 'group' : params.scope === 'character' ? 'character' : undefined;
        if (!scope) throw new HttpError(400, 'Invalid chat scope');
        const ownerId = safeName(params.owner, 'owner', 180);
        const name = normalizedChatName(params.name, 'name');
        const messageCount = Number(request.headers.get('x-st-message-count') ?? 0);
        const lastMessage = decodedLastMessage(request);
        const saved = await saveChat(env, execution, {
            scope,
            ownerId,
            name,
            serialized: request.body,
            expectedRevision: expectedRevision(request),
            metadata: decodedMetadata(request),
            lastMessage,
            searchText: '',
            messageCount: Number.isInteger(messageCount) && messageCount >= 0 ? messageCount : 0,
        });
        return json({ ok: true, id: saved.id, revision: saved.revision });
    });
    router.on('POST', '/api/chats/search-project', async ({ request, env }) => {
        const body = await readJson(request, 131_072);
        const scope: ChatScope = body.scope === 'group' ? 'group' : 'character';
        const ownerId = safeName(body.ownerId, 'ownerId');
        const name = normalizedChatName(body.name, 'name');
        const chat = await findChat(env, scope, ownerId, name);
        if (!chat) throw new HttpError(404, 'Chat not found');
        const revision = Number(body.revision);
        if (revision !== chat.revision) throw new HttpError(409, 'Chat search projection revision conflict');
        const searchText = typeof body.searchText === 'string' ? body.searchText.slice(0, 65_536) : '';
        await env.DB.prepare(`
            INSERT INTO chat_search(chat_id, revision, search_text, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET revision = excluded.revision,
                search_text = excluded.search_text, updated_at = excluded.updated_at
        `).bind(chat.id, chat.revision, searchText, Date.now()).run();
        return json({ ok: true });
    });
    router.on('POST', '/api/chats/save', async ({ request, env, execution }) => {
        const body = await readJson(request, maxJsonBytes(env));
        return saveFromBody(env, execution, body, 'character', characterOwner(body.avatar_url), normalizedChatName(body.file_name));
    });
    router.on('POST', '/api/chats/get', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        if (!body.file_name) return json({});
        const chat = await findChat(env, 'character', characterOwner(body.avatar_url), normalizedChatName(body.file_name));
        return chat ? chatJsonResponse(env, chat) : json({});
    });
    router.on('POST', '/api/chats/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const chat = await findChat(env, 'character', characterOwner(body.avatar_url), normalizedChatName(body.chatfile, 'chatfile'));
        if (!chat) throw new HttpError(404, 'Chat not found');
        await deleteChat(env, chat);
        return json({ ok: true });
    });
    router.on('POST', '/api/chats/rename', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const scope: ChatScope = body.is_group ? 'group' : 'character';
        const ownerId = scope === 'group' ? 'group' : characterOwner(body.avatar_url);
        const oldName = normalizedChatName(body.original_file, 'original_file');
        const newName = normalizedChatName(body.renamed_file, 'renamed_file');
        const chat = await findChat(env, scope, ownerId, oldName);
        if (!chat) throw new HttpError(404, 'Chat not found');
        await renameChat(env, chat, newName);
        return json({ ok: true, sanitizedFileName: newName });
    });
    router.on('POST', '/api/chats/group/save', async ({ request, env, execution }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const id = normalizedChatName(body.id, 'id');
        return saveFromBody(env, execution, body, 'group', 'group', id);
    });
    router.on('POST', '/api/chats/group/get', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const chat = await findChat(env, 'group', 'group', normalizedChatName(body.id, 'id'));
        return chat ? chatJsonResponse(env, chat) : json([]);
    });
    router.on('POST', '/api/chats/group/info', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const chat = await findChat(env, 'group', 'group', normalizedChatName(body.id, 'id'));
        if (!chat) throw new HttpError(404, 'Chat not found');
        return json(chatInfo(chat));
    });
    router.on('POST', '/api/chats/group/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const chat = await findChat(env, 'group', 'group', normalizedChatName(body.id, 'id'));
        if (!chat) throw new HttpError(404, 'Chat not found');
        await deleteChat(env, chat);
        return json({ ok: true });
    });
    router.on('POST', '/api/characters/chats', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const chats = await listChats(env, 'character', characterOwner(body.avatar_url));
        if (body.simple) return json(chats.map(chat => ({ file_name: `${chat.name}.jsonl`, file_id: chat.name })));
        return json(chats.map(chat => chatInfo(chat)));
    });
    router.on('POST', '/api/chats/search', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const query = typeof body.query === 'string' ? body.query.trim().toLowerCase() : '';
        const fragments = query.split(/\s+/u).filter(Boolean);
        let scope: ChatScope = 'character';
        let owner: string | undefined;
        let allowedGroupChats: Set<string> | undefined;
        if (typeof body.group_id === 'string' && body.group_id) {
            scope = 'group';
            owner = 'group';
            const group = await getState<JsonObject>(env, 'group', body.group_id);
            allowedGroupChats = new Set(Array.isArray(group?.value.chats) ? group.value.chats.filter((value): value is string => typeof value === 'string') : []);
        } else {
            owner = characterOwner(body.avatar_url);
        }
        const chats = await searchChats(env, scope, owner, fragments);
        return json(chats.filter(chat => !allowedGroupChats || allowedGroupChats.has(chat.name)).map(chat => ({
            file_name: chat.name,
            file_size: humanFileSize(chat.byteLength),
            message_count: chat.messageCount,
            last_mes: new Date(chat.updatedAt).toISOString(),
            preview_message: chat.lastMessage,
        })));
    });
    router.on('POST', '/api/chats/recent', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        const max = typeof body.max === 'number' && Number.isFinite(body.max) ? Math.min(Math.max(Math.trunc(body.max), 1), 100) : 25;
        const [characterChats, groupChats, groups] = await Promise.all([
            listChats(env, 'character', undefined, max + 50),
            listChats(env, 'group', undefined, max + 50),
            listState<JsonObject>(env, 'group'),
        ]);
        const groupByChat = new Map<string, string>();
        for (const group of groups) {
            const chats = group.value.chats;
            if (!Array.isArray(chats)) continue;
            for (const chat of chats) if (typeof chat === 'string') groupByChat.set(chat, group.key);
        }
        const recent = [
            ...characterChats.map(chat => ({ chat, additions: { avatar: `${chat.ownerId}.png` } })),
            ...groupChats.map(chat => ({ chat, additions: { group: groupByChat.get(chat.name) ?? '' } })),
        ].toSorted((a, b) => b.chat.updatedAt - a.chat.updatedAt).slice(0, max);
        return json(recent.map(item => chatInfo(item.chat, item.additions)));
    });
    router.on('POST', '/api/chats/export', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const scope: ChatScope = body.is_group ? 'group' : 'character';
        const owner = scope === 'group' ? 'group' : characterOwner(body.avatar_url);
        const chat = await findChat(env, scope, owner, normalizedChatName(body.file, 'file'));
        if (!chat) throw new HttpError(404, 'Chat not found');
        const object = await readChat(env, chat);
        const raw = await object.text();
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new HttpError(500, 'Stored chat is invalid', false);
        }
        if (!Array.isArray(parsed)) throw new HttpError(500, 'Stored chat is invalid', false);
        let result: string;
        if (body.format === 'jsonl') {
            result = parsed.map(value => JSON.stringify(value)).join('\n');
        } else {
            const lines: string[] = [];
            for (const item of parsed) {
                const message = objectValue(item);
                if (message.is_system || typeof message.mes !== 'string') continue;
                lines.push(`${typeof message.name === 'string' ? message.name : 'Unknown'}: ${message.mes}`);
            }
            result = lines.join('\n\n');
        }
        return json({ message: `Chat saved to ${String(body.exportfilename ?? chat.name)}`, result });
    });
    router.on('POST', '/api/chats/import', async ({ request, env, execution }) => {
        const form = await readFormData(request, maxUploadBytes(env));
        const file = form.get('avatar') ?? form.get('file');
        if (!(file instanceof File)) throw new HttpError(400, 'Missing chat file');
        const characterName = typeof form.get('character_name') === 'string' ? safeName(form.get('character_name'), 'character_name') : 'Character';
        const avatar = form.get('avatar_url');
        const owner = characterOwner(avatar);
        const chat = await parseImportedChat(file, form);
        const name = importedName(characterName);
        const prepared = stringifyChat(chat);
        await saveChat(env, execution, { scope: 'character', ownerId: owner, name, serialized: prepared.serialized, expectedRevision: 0, metadata: prepared.metadata, lastMessage: prepared.lastMessage, searchText: prepared.searchText, messageCount: Math.max(0, chat.length - 1) });
        return json({ res: true, fileNames: [`${name}.jsonl`] });
    });
    router.on('POST', '/api/chats/group/import', async ({ request, env, execution }) => {
        const form = await readFormData(request, maxUploadBytes(env));
        const file = form.get('avatar') ?? form.get('file');
        if (!(file instanceof File)) throw new HttpError(400, 'Missing chat file');
        const chat = await parseImportedChat(file, form);
        const name = new Date().toISOString().replaceAll(':', '-');
        const prepared = stringifyChat(chat);
        await saveChat(env, execution, { scope: 'group', ownerId: 'group', name, serialized: prepared.serialized, expectedRevision: 0, metadata: prepared.metadata, lastMessage: prepared.lastMessage, searchText: prepared.searchText, messageCount: Math.max(0, chat.length - 1) });
        return json({ res: name });
    });
    router.on('POST', '/api/chats/group/clear-metadata', () => empty());
}
