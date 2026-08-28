import { HttpError } from '../http';
import { archiveChatRevision } from './snapshots';

export type ChatScope = 'character' | 'group';

interface ChatRow {
    id: string;
    scope: ChatScope;
    owner_id: string;
    name: string;
    current_revision: number;
    current_r2_key: string;
    metadata_json: string;
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
    revision: number;
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
        metadata = JSON.parse(row.metadata_json);
    } catch {
        // Optional metadata can be rebuilt from the immutable R2 revision.
    }
    return {
        id: row.id,
        scope: row.scope,
        ownerId: row.owner_id,
        name: row.name,
        revision: row.current_revision,
        r2Key: row.current_r2_key,
        metadata: recordValue(metadata),
        lastMessage: row.last_message,
        messageCount: row.message_count,
        byteLength: row.byte_length,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const CHAT_COLUMNS = `
    id, scope, owner_id, name, current_revision, current_r2_key,
    metadata_json, last_message, message_count, byte_length, created_at, updated_at
`;

export async function findChat(env: Env, scope: ChatScope, ownerId: string, name: string): Promise<StoredChat | null> {
    const row = await env.DB.prepare(`
        SELECT ${CHAT_COLUMNS} FROM chat_index
        WHERE scope = ? AND owner_id = ? AND name = ? AND tombstoned_at IS NULL
    `).bind(scope, ownerId, name).first<ChatRow>();
    return row ? decodeRow(row) : null;
}

export async function listChats(env: Env, scope: ChatScope, ownerId?: string, limit = 250): Promise<StoredChat[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const query = ownerId === undefined
        ? env.DB.prepare(`SELECT ${CHAT_COLUMNS} FROM chat_index WHERE scope = ? AND tombstoned_at IS NULL ORDER BY updated_at DESC LIMIT ?`).bind(scope, boundedLimit)
        : env.DB.prepare(`SELECT ${CHAT_COLUMNS} FROM chat_index WHERE scope = ? AND owner_id = ? AND tombstoned_at IS NULL ORDER BY updated_at DESC LIMIT ?`).bind(scope, ownerId, boundedLimit);
    const result = await query.all<ChatRow>();
    return result.results.map(decodeRow);
}

interface SaveChatInput {
    scope: ChatScope;
    ownerId: string;
    name: string;
    serialized: string | ReadableStream;
    expectedRevision: number;
    metadata: Record<string, unknown>;
    lastMessage: string;
    searchText: string;
    messageCount: number;
}

async function compensateRevision(env: Env, chatId: string, revision: number, r2Key: string): Promise<void> {
    await env.DB.prepare('DELETE FROM chat_revisions WHERE chat_id = ? AND revision = ? AND r2_key = ?')
        .bind(chatId, revision, r2Key).run();
    await env.BUCKET.delete(r2Key);
}

export async function saveChat(env: Env, execution: ExecutionContext, input: SaveChatInput): Promise<StoredChat> {
    const existing = await findChat(env, input.scope, input.ownerId, input.name);
    const expectedRevision = Math.max(0, Math.trunc(input.expectedRevision));
    if ((existing?.revision ?? 0) !== expectedRevision) {
        throw new HttpError(409, `Chat revision conflict; current revision is ${existing?.revision ?? 0}`);
    }

    const id = existing?.id ?? crypto.randomUUID();
    const now = Date.now();
    const revision = expectedRevision + 1;
    // Every attempt gets an immutable object key. A losing compare-and-swap can
    // therefore delete only its own object and can never overwrite the winner.
    const r2Key = `chats/${input.scope}/${encodeURIComponent(id)}/${revision}-${crypto.randomUUID()}.json`;
    const written = await env.BUCKET.put(r2Key, input.serialized, {
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
        customMetadata: { scope: input.scope, revision: String(revision) },
    });
    if (!written) throw new Error('R2 chat upload failed');

    try {
        if (!existing) {
            await env.DB.batch([
                env.DB.prepare(`
                    INSERT INTO chat_index(
                        id, scope, owner_id, name, current_revision, current_r2_key, metadata_json,
                        last_message, message_count, byte_length, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    id, input.scope, input.ownerId, input.name, revision, r2Key, JSON.stringify(input.metadata),
                    input.lastMessage.slice(-400), input.messageCount, written.size, now, now,
                ),
                env.DB.prepare(`
                    INSERT INTO chat_revisions(chat_id, revision, r2_key, etag, byte_length, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).bind(id, revision, r2Key, written.httpEtag, written.size, now),
                env.DB.prepare(`
                    INSERT INTO chat_search(chat_id, revision, search_text, updated_at) VALUES (?, ?, ?, ?)
                `).bind(id, revision, input.searchText, now),
            ]);
        } else {
            const results = await env.DB.batch([
                env.DB.prepare(`
                    INSERT INTO chat_revisions(chat_id, revision, r2_key, etag, byte_length, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).bind(id, revision, r2Key, written.httpEtag, written.size, now),
                env.DB.prepare(`
                    UPDATE chat_index SET current_revision = ?, current_r2_key = ?, metadata_json = ?,
                        last_message = ?, message_count = ?, byte_length = ?, updated_at = ?
                    WHERE id = ? AND current_revision = ? AND tombstoned_at IS NULL
                `).bind(
                    revision, r2Key, JSON.stringify(input.metadata), input.lastMessage.slice(-400),
                    input.messageCount, written.size, now, id, expectedRevision,
                ),
            ]);
            if (Number(results[1]?.meta.changes ?? 0) !== 1) {
                await compensateRevision(env, id, revision, r2Key);
                throw new HttpError(409, 'Chat revision conflict');
            }
            // Search is a rebuildable browser projection, not part of the chat
            // commit. Never roll back an immutable revision because projection
            // refresh failed after a successful compare-and-swap.
            await env.DB.prepare(`
                INSERT INTO chat_search(chat_id, revision, search_text, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET revision = excluded.revision,
                    search_text = excluded.search_text, updated_at = excluded.updated_at
            `).bind(id, revision, input.searchText, now).run().catch(() => undefined);
            execution.waitUntil(archiveChatRevision(env, existing).catch(() => undefined));
        }
    } catch (error) {
        if (!(error instanceof HttpError && error.status === 409)) {
            execution.waitUntil(compensateRevision(env, id, revision, r2Key));
        }
        throw error;
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
    const conditions = ['c.scope = ?', 'c.tombstoned_at IS NULL'];
    const bindings: Array<string | number> = [scope];
    if (ownerId !== undefined) {
        conditions.push('c.owner_id = ?');
        bindings.push(ownerId);
    }
    for (const fragment of fragments.slice(0, 8)) {
        conditions.push('(lower(c.name) LIKE ? ESCAPE \'\\\' OR lower(s.search_text) LIKE ? ESCAPE \'\\\')');
        const escaped = fragment.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
        bindings.push(`%${escaped}%`, `%${escaped}%`);
    }
    bindings.push(Math.min(Math.max(limit, 1), 250));
    const columns = CHAT_COLUMNS.replaceAll(
        /\b(id|scope|owner_id|name|current_revision|current_r2_key|metadata_json|last_message|message_count|byte_length|created_at|updated_at)\b/gu,
        'c.$1',
    );
    const result = await env.DB.prepare(`
        SELECT ${columns} FROM chat_index c LEFT JOIN chat_search s ON s.chat_id = c.id
        WHERE ${conditions.join(' AND ')} ORDER BY c.updated_at DESC LIMIT ?
    `).bind(...bindings).all<ChatRow>();
    return result.results.map(decodeRow);
}

export async function readChat(env: Env, chat: StoredChat): Promise<R2ObjectBody> {
    const object = await env.BUCKET.get(chat.r2Key);
    if (!object) throw new HttpError(404, 'Chat content not found');
    return object;
}

export async function deleteChat(env: Env, chat: StoredChat): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('UPDATE chat_index SET tombstoned_at = ?, updated_at = ? WHERE id = ? AND tombstoned_at IS NULL')
            .bind(now, now, chat.id),
        env.DB.prepare(`
            INSERT INTO tombstones(id, kind, target_key, payload_json, created_at)
            VALUES (?, 'chat', ?, ?, ?)
        `).bind(crypto.randomUUID(), chat.id, JSON.stringify({ collectionId: `chat:${chat.id}` }), now),
    ]);
}

export async function renameChat(env: Env, chat: StoredChat, newName: string): Promise<void> {
    const conflict = await findChat(env, chat.scope, chat.ownerId, newName);
    if (conflict) throw new HttpError(409, 'Destination chat already exists');
    await env.DB.prepare('UPDATE chat_index SET name = ?, updated_at = ? WHERE id = ? AND tombstoned_at IS NULL')
        .bind(newName, Date.now(), chat.id).run();
}
