import { HttpError } from '../http';
import type { StoredChat } from './chats';

interface SnapshotRow {
    id: string;
    kind: string;
    source_key: string;
    r2_key: string;
    byte_length: number;
    created_at: number;
    metadata: string;
}

export interface Snapshot {
    id: string;
    kind: string;
    sourceKey: string;
    r2Key: string;
    byteLength: number;
    createdAt: number;
    metadata: Record<string, unknown>;
}

function decode(row: SnapshotRow): Snapshot {
    let metadata: Record<string, unknown> = {};
    try {
        const value: unknown = JSON.parse(row.metadata);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) metadata = value as Record<string, unknown>;
    } catch {
        // A damaged description must not make the underlying R2 revision unrecoverable.
    }
    return {
        id: row.id,
        kind: row.kind,
        sourceKey: row.source_key,
        r2Key: row.r2_key,
        byteLength: row.byte_length,
        createdAt: row.created_at,
        metadata,
    };
}

const COLUMNS = 'id, kind, source_key, r2_key, byte_length, created_at, metadata';

export async function archiveChatRevision(env: Env, chat: StoredChat): Promise<void> {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const safeOwner = chat.ownerId.replace(/[^a-zA-Z0-9_-]+/gu, '_').slice(0, 64) || chat.scope;
    const safeName = chat.name.replace(/[^a-zA-Z0-9_.-]+/gu, '_').slice(0, 80) || 'chat';
    const backupName = `chat_${safeOwner}_${safeName}_${createdAt}.jsonl`;
    await env.DB.prepare(`
        INSERT INTO snapshots(id, kind, source_key, r2_key, byte_length, created_at, metadata)
        VALUES (?, 'chat', ?, ?, ?, ?, ?)
    `).bind(id, backupName, chat.r2Key, chat.byteLength, createdAt, JSON.stringify({
        scope: chat.scope,
        ownerId: chat.ownerId,
        chatName: chat.name,
        messageCount: chat.messageCount,
        lastMessage: chat.lastMessage,
        updatedAt: chat.updatedAt,
    })).run();

    const stale = await env.DB.prepare(`
        SELECT ${COLUMNS} FROM snapshots WHERE kind = 'chat'
        ORDER BY created_at DESC LIMIT 50 OFFSET 25
    `).all<SnapshotRow>();
    if (stale.results.length === 0) return;
    await env.DB.batch(stale.results.map(row => env.DB.prepare('DELETE FROM snapshots WHERE id = ?').bind(row.id)));
    await env.BUCKET.delete(stale.results.map(row => row.r2_key));
}

export async function listSnapshots(env: Env, kind: string, limit = 50): Promise<Snapshot[]> {
    const result = await env.DB.prepare(`
        SELECT ${COLUMNS} FROM snapshots WHERE kind = ? ORDER BY created_at DESC LIMIT ?
    `).bind(kind, Math.min(Math.max(limit, 1), 100)).all<SnapshotRow>();
    return result.results.map(decode);
}

export async function findSnapshot(env: Env, kind: string, sourceKey: string): Promise<Snapshot | null> {
    const row = await env.DB.prepare(`
        SELECT ${COLUMNS} FROM snapshots WHERE kind = ? AND source_key = ? ORDER BY created_at DESC LIMIT 1
    `).bind(kind, sourceKey).first<SnapshotRow>();
    return row ? decode(row) : null;
}

export async function readSnapshot(env: Env, snapshot: Snapshot): Promise<R2ObjectBody> {
    const object = await env.BUCKET.get(snapshot.r2Key);
    if (!object) throw new HttpError(404, 'Backup content not found');
    return object;
}

export async function deleteSnapshot(env: Env, snapshot: Snapshot): Promise<void> {
    await env.BUCKET.delete(snapshot.r2Key);
    await env.DB.prepare('DELETE FROM snapshots WHERE id = ?').bind(snapshot.id).run();
}
