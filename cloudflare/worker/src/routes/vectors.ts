import { empty, HttpError, json, maxJsonBytes, readJson, requireString } from '../http';
import type { Router } from '../router';

type JsonObject = Record<string, unknown>;

interface VectorRow {
    collection_id: string;
    source_id: string;
    content: string;
    metadata: string;
    score?: number;
}

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function collection(value: unknown): string {
    return requireString(value, 'collectionId', 256);
}

function source(value: unknown): string {
    return typeof value === 'string' && value ? value.slice(0, 64) : 'transformers';
}

function decodeMetadata(row: VectorRow): JsonObject {
    try {
        return objectValue(JSON.parse(row.metadata));
    } catch {
        return { hash: Number(row.source_id), text: row.content };
    }
}

async function queryOne(env: Env, collectionId: string, sourceName: string, searchText: string, topK: number): Promise<{ hashes: number[]; metadata: JsonObject[] }> {
    const fragments = searchText.toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 8);
    const scoreParts = fragments.length > 0 ? fragments.map(() => "CASE WHEN instr(lower(content), ?) > 0 THEN 1 ELSE 0 END") : ['0'];
    const bindings: Array<string | number> = [...fragments, collectionId, sourceName, Math.min(Math.max(topK, 1), 50)];
    const result = await env.DB.prepare(`
        SELECT collection_id, source_id, content, metadata, (${scoreParts.join(' + ')}) AS score
        FROM vectors WHERE collection_id = ? AND source = ?
        ORDER BY score DESC, updated_at DESC LIMIT ?
    `).bind(...bindings).all<VectorRow>();
    const rows = fragments.length > 0 ? result.results.filter(row => Number(row.score ?? 0) > 0) : result.results;
    return {
        hashes: rows.map(row => Number(row.source_id)).filter(Number.isFinite),
        metadata: rows.map(decodeMetadata),
    };
}

export function registerVectorRoutes(router: Router): void {
    router.on('POST', '/api/vector/insert', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env) * 4);
        const collectionId = collection(body.collectionId);
        const sourceName = source(body.source);
        if (!Array.isArray(body.items)) throw new HttpError(400, 'Items must be an array');
        if (body.items.length > 100) throw new HttpError(413, 'At most 100 vector items may be inserted at once');
        const now = Date.now();
        const statements = body.items.map(value => {
            const item = objectValue(value);
            const hash = Number(item.hash);
            if (!Number.isFinite(hash) || typeof item.text !== 'string') throw new HttpError(400, 'Invalid vector item');
            const metadata = { hash, text: item.text, index: Number(item.index ?? 0) };
            return env.DB.prepare(`
                INSERT INTO vectors(collection_id, source, source_id, content_hash, content, embedding, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
                ON CONFLICT(collection_id, source, source_id) DO UPDATE SET
                    content_hash = excluded.content_hash,
                    content = excluded.content,
                    metadata = excluded.metadata,
                    updated_at = excluded.updated_at
            `).bind(collectionId, sourceName, String(hash), String(hash), item.text.slice(0, 262_144), JSON.stringify(metadata), now, now);
        });
        if (statements.length > 0) await env.DB.batch(statements);
        return empty(200);
    });
    router.on('POST', '/api/vector/list', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        const result = await env.DB.prepare(
            'SELECT source_id FROM vectors WHERE collection_id = ? AND source = ? ORDER BY updated_at',
        ).bind(collection(body.collectionId), source(body.source)).all<{ source_id: string }>();
        return json(result.results.map(row => Number(row.source_id)).filter(Number.isFinite));
    });
    router.on('POST', '/api/vector/delete', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        if (!Array.isArray(body.hashes) || body.hashes.length === 0) return empty(200);
        const hashes = body.hashes.slice(0, 100).map(Number).filter(Number.isFinite).map(String);
        const placeholders = hashes.map(() => '?').join(',');
        await env.DB.prepare(`
            DELETE FROM vectors WHERE collection_id = ? AND source = ? AND source_id IN (${placeholders})
        `).bind(collection(body.collectionId), source(body.source), ...hashes).run();
        return empty(200);
    });
    router.on('POST', '/api/vector/query', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const result = await queryOne(env, collection(body.collectionId), source(body.source), requireString(body.searchText, 'searchText', 262_144), Number(body.topK) || 10);
        return json(result);
    });
    router.on('POST', '/api/vector/query-multi', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        if (!Array.isArray(body.collectionIds)) throw new HttpError(400, 'collectionIds must be an array');
        const ids = body.collectionIds.filter((value): value is string => typeof value === 'string').slice(0, 20);
        const results: Record<string, { hashes: number[]; metadata: JsonObject[] }> = {};
        for (const id of ids) results[id] = await queryOne(env, collection(id), source(body.source), requireString(body.searchText, 'searchText', 262_144), Number(body.topK) || 10);
        return json(results);
    });
    router.on('POST', '/api/vector/purge', async ({ request, env }) => {
        const body = await readJson(request, 65_536);
        await env.DB.prepare('DELETE FROM vectors WHERE collection_id = ?').bind(collection(body.collectionId)).run();
        return empty(200);
    });
    router.on('POST', '/api/vector/purge-all', async ({ env }) => {
        await env.DB.prepare('DELETE FROM vectors').run();
        return empty(200);
    });
}
