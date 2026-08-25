import { HttpError } from '../http';
import { archiveChatRevision } from './snapshots';

export type ChatScope = 'character' | 'group';

interface ChatRow {
    id: string;
    scope: ChatScope;
    owner_id: string;
    name: string;
    r2_key: string;
    metadata: string;
    last_message: string;
    message_count: number;
    byte_length: number;
    created_at: number;
    updated_at: number;
}

export interface StoredChat {
    id: string;
    scope: ChatScope;
    ownerId: string;
    name: string;
    r2Key: string;
    metadata: Record<string, unknown>;
    lastMessage: string;
    messageCount: number;
    byteLength: number;
    createdAt: number;
    updatedAt: number;
}

function recordValue(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function decodeRow(row: ChatRow): StoredChat {
    let metadata: unknown = {};
    try {
        metadata = JSON.parse(row.metadata);
    } catch {
        // Treat a damaged optional metadata field as empty; the chat body remains recoverable from R2.
    }
    return {
        id: row.id,
        scope: row.scope,
        ownerId: row.owner_id,
        name: row.name,
        r2Key: row.r2_key,
        metadata: recordValue(metadata),
        lastMessage: row.last_message,
        messageCount: row.message_count,
        byteLength: row.byte_length,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const CHAT_COLUMNS = `
    id, scope, owner_id, name, r2_key, metadata, last_message,
    message_count, byte_length, created_at, updated_at
`;

export async function findChat(env: Env, scope: ChatScope, ownerId: string, name: string): Promise<StoredChat | null> {
    const row = await env.DB.prepare(`
        SELECT ${CHAT_COLUMNS} FROM chats WHERE scope = ? AND owner_id = ? AND name = ?
    `).bind(scope, ownerId, name).first<ChatRow>();
    return row ? decodeRow(row) : null;
}

export async function listChats(env: Env, scope: ChatScope, ownerId?: string, limit = 250): Promise<StoredChat[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const query = ownerId === undefined
        ? env.DB.prepare(`SELECT ${CHAT_COLUMNS} FROM chats WHERE scope = ? ORDER BY updated_at DESC LIMIT ?`).bind(scope, boundedLimit)
        : env.DB.prepare(`SELECT ${CHAT_COLUMNS} FROM chats WHERE scope = ? AND owner_id = ? ORDER BY updated_at DESC LIMIT ?`).bind(scope, ownerId, boundedLimit);
    const result = await query.all<ChatRow>();
    return result.results.map(decodeRow);
}

interface SaveChatInput {
    scope: ChatScope;
    ownerId: string;
    name: string;
    serialized: string;
    metadata: Record<string, unknown>;
    lastMessage: string;
    searchText: string;
    messageCount: number;
}

export async function saveChat(env: Env, execution: ExecutionContext, input: SaveChatInput): Promise<StoredChat> {
    const existing = await findChat(env, input.scope, input.ownerId, input.name);
    const id = existing?.id ?? crypto.randomUUID();
    const now = Date.now();
    const revision = crypto.randomUUID();
    const r2Key = `chats/${input.scope}/${encodeURIComponent(id)}/${revision}.json`;
    const written = await env.BUCKET.put(r2Key, input.serialized, {
        httpMetadata: {
            contentType: 'application/json; charset=utf-8',
            cacheControl: 'private, no-store',
        },
        customMetadata: { scope: input.scope, owner: input.ownerId.slice(0, 128) },
    });
    if (!written) throw new Error('R2 chat upload failed');

    try {
        await env.DB.prepare(`
            INSERT INTO chats(
                id, scope, owner_id, name, r2_key, metadata, last_message,
                search_text, message_count, byte_length, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, owner_id, name) DO UPDATE SET
                r2_key = excluded.r2_key,
                metadata = excluded.metadata,
                last_message = excluded.last_message,
                search_text = excluded.search_text,
                message_count = excluded.message_count,
                byte_length = excluded.byte_length,
                updated_at = excluded.updated_at
        `).bind(
            id,
            input.scope,
            input.ownerId,
            input.name,
            r2Key,
            JSON.stringify(input.metadata),
            input.lastMessage.slice(-400),
            input.searchText,
            input.messageCount,
            written.size,
            existing?.createdAt ?? now,
            now,
        ).run();
    } catch (error) {
        execution.waitUntil(env.BUCKET.delete(r2Key));
        throw error;
    }

    if (existing && existing.r2Key !== r2Key) {
        execution.waitUntil(archiveChatRevision(env, existing).catch(async error => {
            console.error('Unable to archive previous chat revision', error);
            await env.BUCKET.delete(existing.r2Key);
        }));
    }
    const stored = await findChat(env, input.scope, input.ownerId, input.name);
    if (!stored) throw new Error('D1 chat index write did not persist');
    return stored;
}

export async function searchChats(
    env: Env,
    scope: ChatScope,
    ownerId: string | undefined,
    fragments: readonly string[],
    limit = 100,
): Promise<StoredChat[]> {
    const conditions = ['scope = ?'];
    const bindings: Array<string | number> = [scope];
    if (ownerId !== undefined) {
        conditions.push('owner_id = ?');
        bindings.push(ownerId);
    }
    for (const fragment of fragments.slice(0, 8)) {
        conditions.push('(lower(name) LIKE ? ESCAPE \'\\\' OR lower(search_text) LIKE ? ESCAPE \'\\\')');
        const escaped = fragment.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
        bindings.push(`%${escaped}%`, `%${escaped}%`);
    }
    bindings.push(Math.min(Math.max(limit, 1), 250));
    const result = await env.DB.prepare(`
        SELECT ${CHAT_COLUMNS} FROM chats
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC LIMIT ?
    `).bind(...bindings).all<ChatRow>();
    return result.results.map(decodeRow);
}

export async function readChat(env: Env, chat: StoredChat): Promise<R2ObjectBody> {
    const object = await env.BUCKET.get(chat.r2Key);
    if (!object) throw new HttpError(404, 'Chat content not found');
    return object;
}

export async function deleteChat(env: Env, chat: StoredChat): Promise<void> {
    await env.BUCKET.delete(chat.r2Key);
    await env.DB.prepare('DELETE FROM chats WHERE id = ?').bind(chat.id).run();
}

export async function renameChat(env: Env, chat: StoredChat, newName: string): Promise<void> {
    const conflict = await findChat(env, chat.scope, chat.ownerId, newName);
    if (conflict) throw new HttpError(409, 'Destination chat already exists');
    await env.DB.prepare(
        'UPDATE chats SET name = ?, updated_at = ? WHERE id = ?',
    ).bind(newName, Date.now(), chat.id).run();
}
