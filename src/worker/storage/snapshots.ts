import { HttpError } from '../http';
import type { StoredChat } from './chats';

interface SnapshotRow {
    id: string;
    kind: string;
    source_key: string;
    chat_id: string;
    chat_revision: number;
    r2_key: string;
    byte_length: number;
    created_at: number;
    metadata_json: string;
}

export interface Snapshot {
    id: string;
    kind: string;
    sourceKey: string;
    chatId: string;
    chatRevision: number;
    r2Key: string;
    byteLength: number;
    createdAt: number;
    metadata: Record<string, unknown>;
}

function decode(row: SnapshotRow): Snapshot {
    let metadata: Record<string, unknown> = {};
    try {
        const value: unknown = JSON.parse(row.metadata_json);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) metadata = value as Record<string, unknown>;
    } catch {
        // The immutable chat revision remains recoverable without optional metadata.
    }
    return {
        id: row.id,
        kind: row.kind,
        sourceKey: row.source_key,
        chatId: row.chat_id,
        chatRevision: row.chat_revision,
        r2Key: row.r2_key,
        byteLength: row.byte_length,
        createdAt: row.created_at,
        metadata,
    };
}

const COLUMNS = `
    s.id, s.kind, s.source_key, s.chat_id, s.chat_revision, r.r2_key,
    r.byte_length, s.created_at, s.metadata_json
`;

export async function archiveChatRevision(env: Env, chat: StoredChat): Promise<void> {
    const createdAt = Date.now();
    const safeOwner = chat.ownerId.replace(/[^a-zA-Z0-9_-]+/gu, '_').slice(0, 64) || chat.scope;
    const safeName = chat.name.replace(/[^a-zA-Z0-9_.-]+/gu, '_').slice(0, 80) || 'chat';
    const backupName = `chat_${safeOwner}_${safeName}_r${chat.revision}_${createdAt}.jsonl`;
    await env.DB.prepare(`
        INSERT OR IGNORE INTO snapshots(id, kind, source_key, chat_id, chat_revision, metadata_json, created_at)
        VALUES (?, 'chat', ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), backupName, chat.id, chat.revision, JSON.stringify({
        scope: chat.scope,
        ownerId: chat.ownerId,
        chatName: chat.name,
        messageCount: chat.messageCount,
        lastMessage: chat.lastMessage,
        updatedAt: chat.updatedAt,
    }), createdAt).run();

    const stale = await env.DB.prepare(`
        SELECT id FROM snapshots WHERE kind = 'chat' ORDER BY created_at DESC LIMIT 100 OFFSET 25
    `).all<{ id: string }>();
    if (stale.results.length > 0) {
        await env.DB.batch(stale.results.map(row => env.DB.prepare('DELETE FROM snapshots WHERE id = ?').bind(row.id)));
    }
}

export async function listSnapshots(env: Env, kind: string, limit = 50): Promise<Snapshot[]> {
    const result = await env.DB.prepare(`
        SELECT ${COLUMNS} FROM snapshots s
        JOIN chat_revisions r ON r.chat_id = s.chat_id AND r.revision = s.chat_revision
        WHERE s.kind = ? ORDER BY s.created_at DESC LIMIT ?
    `).bind(kind, Math.min(Math.max(limit, 1), 100)).all<SnapshotRow>();
    return result.results.map(decode);
}

export async function findSnapshot(env: Env, kind: string, sourceKey: string): Promise<Snapshot | null> {
    const row = await env.DB.prepare(`
        SELECT ${COLUMNS} FROM snapshots s
        JOIN chat_revisions r ON r.chat_id = s.chat_id AND r.revision = s.chat_revision
        WHERE s.kind = ? AND s.source_key = ? ORDER BY s.created_at DESC LIMIT 1
    `).bind(kind, sourceKey).first<SnapshotRow>();
    return row ? decode(row) : null;
}

export async function readSnapshot(env: Env, snapshot: Snapshot): Promise<R2ObjectBody> {
    const object = await env.BUCKET.get(snapshot.r2Key);
    if (!object) throw new HttpError(404, 'Backup content not found');
    return object;
}

export async function deleteSnapshot(env: Env, snapshot: Snapshot): Promise<void> {
    await env.DB.prepare('DELETE FROM snapshots WHERE id = ?').bind(snapshot.id).run();
}
