import { HttpError } from '../http';

export interface ObjectRow {
    id: string;
    kind: string;
    name: string;
    r2_key: string;
    mime_type: string;
    byte_length: number;
    etag: string;
    metadata_json: string;
    created_at: number;
    updated_at: number;
}

export interface StoredObject {
    id: string;
    kind: string;
    name: string;
    r2Key: string;
    mimeType: string;
    byteLength: number;
    etag: string;
    metadata: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
}

function decodeRow(row: ObjectRow): StoredObject {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        r2Key: row.r2_key,
        mimeType: row.mime_type,
        byteLength: row.byte_length,
        etag: row.etag,
        metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function objectKey(kind: string, name: string): string {
    const prefix: Record<string, string> = {
        'character-avatar': 'characters',
        'user-avatar': 'avatars',
        background: 'backgrounds',
        sprite: 'sprites',
        'user-image': 'gallery',
        'user-file': 'files',
        asset: 'assets',
        attachment: 'files',
        'data-bank': 'data-bank',
        backup: 'backups',
        thumbnail: 'thumbnails',
    };
    const directory = prefix[kind];
    if (!directory) throw new HttpError(400, `Unsupported core object kind: ${kind}`);
    return `${directory}/${encodeURIComponent(name)}`;
}

export async function findObject(env: Env, kind: string, name: string): Promise<StoredObject | null> {
    const row = await env.DB.prepare(`
        SELECT id, kind, name, r2_key, mime_type, byte_length, etag, metadata_json, created_at, updated_at
        FROM objects WHERE kind = ? AND name = ?
    `).bind(kind, name).first<ObjectRow>();
    return row ? decodeRow(row) : null;
}

export async function listObjects(env: Env, kind: string, limit = 500): Promise<StoredObject[]> {
    const result = await env.DB.prepare(`
        SELECT id, kind, name, r2_key, mime_type, byte_length, etag, metadata_json, created_at, updated_at
        FROM objects WHERE kind = ? ORDER BY name LIMIT ?
    `).bind(kind, Math.min(Math.max(limit, 1), 500)).all<ObjectRow>();
    return result.results.map(decodeRow);
}

export async function putObject(
    env: Env,
    kind: string,
    name: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options: { mimeType?: string; byteLength?: number; metadata?: Record<string, unknown> } = {},
): Promise<StoredObject> {
    const existing = await findObject(env, kind, name);
    const id = existing?.id ?? crypto.randomUUID();
    const now = Date.now();
    const key = existing?.r2Key ?? objectKey(kind, name);
    const mimeType = options.mimeType ?? 'application/octet-stream';
    const r2Object = await env.BUCKET.put(key, value, {
        httpMetadata: { contentType: mimeType, cacheControl: 'private, max-age=0, must-revalidate' },
        customMetadata: { kind, name: name.slice(0, 512) },
    });
    if (!r2Object) throw new Error('R2 upload failed');
    const byteLength = options.byteLength ?? r2Object.size;
    const etag = r2Object.httpEtag;
    try {
        await env.DB.prepare(`
            INSERT INTO objects(id, kind, name, r2_key, mime_type, byte_length, etag, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, name) DO UPDATE SET
                r2_key = excluded.r2_key,
                mime_type = excluded.mime_type,
                byte_length = excluded.byte_length,
                etag = excluded.etag,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at
        `).bind(
            id, kind, name, key, mimeType, byteLength, etag,
            JSON.stringify(options.metadata ?? {}), existing?.createdAt ?? now, now,
        ).run();
    } catch (error) {
        if (!existing) await env.BUCKET.delete(key);
        throw error;
    }
    const stored = await findObject(env, kind, name);
    if (!stored) throw new Error('D1 object index write did not persist');
    return stored;
}

export interface BulkObjectInput {
    kind: string;
    name: string;
    value: ArrayBuffer | ArrayBufferView;
    mimeType: string;
    byteLength: number;
}

export async function putObjectsBulk(env: Env, inputs: readonly BulkObjectInput[]): Promise<void> {
    if (inputs.length === 0) return;
    if (inputs.length > 40) throw new HttpError(413, 'Too many objects in one request');
    const rows: Array<{ input: BulkObjectInput; id: string; key: string; etag: string; now: number }> = [];
    for (const input of inputs) {
        const key = objectKey(input.kind, input.name);
        const written = await env.BUCKET.put(key, input.value, {
            httpMetadata: { contentType: input.mimeType, cacheControl: 'private, max-age=0, must-revalidate' },
            customMetadata: { kind: input.kind, name: input.name.slice(0, 512) },
        });
        if (!written) throw new Error(`R2 upload failed for ${input.name}`);
        rows.push({ input, id: crypto.randomUUID(), key, etag: written.httpEtag, now: Date.now() });
    }
    const statements = rows.map(row => env.DB.prepare(`
        INSERT INTO objects(id, kind, name, r2_key, mime_type, byte_length, etag, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
        ON CONFLICT(kind, name) DO UPDATE SET
            r2_key = excluded.r2_key,
            mime_type = excluded.mime_type,
            byte_length = excluded.byte_length,
            etag = excluded.etag,
            updated_at = excluded.updated_at
    `).bind(
        row.id, row.input.kind, row.input.name, row.key, row.input.mimeType,
        row.input.byteLength, row.etag, row.now, row.now,
    ));
    await env.DB.batch(statements);
}

export async function deleteObject(env: Env, kind: string, name: string): Promise<boolean> {
    const object = await findObject(env, kind, name);
    if (!object) return false;
    await env.BUCKET.delete(object.r2Key);
    await env.DB.prepare('DELETE FROM objects WHERE id = ?').bind(object.id).run();
    return true;
}

export async function renameObject(env: Env, kind: string, oldName: string, newName: string): Promise<boolean> {
    const object = await findObject(env, kind, oldName);
    if (!object) return false;
    if (await findObject(env, kind, newName)) throw new HttpError(409, 'Destination already exists');
    const source = await env.BUCKET.get(object.r2Key);
    if (!source) throw new HttpError(404, 'Object content not found');
    await putObject(env, kind, newName, source.body, {
        mimeType: object.mimeType,
        byteLength: object.byteLength,
        metadata: object.metadata,
    });
    await deleteObject(env, kind, oldName);
    return true;
}

export async function serveObject(env: Env, kind: string, name: string, request: Request): Promise<Response> {
    const indexed = await findObject(env, kind, name);
    if (!indexed) throw new HttpError(404, 'Object not found');
    const options: R2GetOptions = {};
    const rangeRequested = request.headers.has('range');
    if (rangeRequested) options.range = request.headers;
    if (['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'].some(header => request.headers.has(header))) {
        options.onlyIf = request.headers;
    }
    const object = await env.BUCKET.get(indexed.r2Key, options);
    if (!object) throw new HttpError(404, 'Object content not found');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', 'private, max-age=0, must-revalidate');
    if (!('body' in object)) return new Response(null, { status: 304, headers });
    if (rangeRequested && object.range) {
        const offset = 'offset' in object.range ? object.range.offset : 0;
        const length = 'length' in object.range ? object.range.length : object.size;
        headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
        headers.set('content-length', String(length));
        return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
    }
    headers.set('content-length', String(object.size));
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}
