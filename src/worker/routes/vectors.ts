import { empty, HttpError, json, readJson, requireString } from '../http';
import type { Router } from '../router';

type JsonObject = Record<string, unknown>;

interface VectorItem {
    id: string;
    hash: number;
    text: string;
    index: number;
    metadata: JsonObject;
}

interface ManifestRow {
    id: string;
    hash: number;
    collection_id: string;
    source: string;
    schema_version: number;
    r2_source_key: string;
    metadata_json: string;
}

const MAX_ITEMS = 4;
const MAX_ITEM_BYTES = 8_192;
const MAX_TEXT_BYTES = 32_768;
const MAX_COLLECTIONS = 8;
const MAX_TOP_K = 20;
const MAX_DELETE_ITEMS = 100;
const textEncoder = new TextEncoder();

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function collectionId(value: unknown): string {
    const result = requireString(value, 'collectionId', 256).normalize('NFC').trim();
    if (/\p{C}/u.test(result)) throw new HttpError(400, 'Invalid collectionId');
    return result;
}

function sourceName(value: unknown): string {
    if (value === undefined || value === null || value === '') return 'unknown';
    return requireString(value, 'source', 64).replace(/[^a-zA-Z0-9_.:-]/gu, '-');
}

function topK(value: unknown): number {
    const parsed = value === undefined ? 10 : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, 'topK must be a positive integer');
    if (parsed > MAX_TOP_K) throw new HttpError(413, `topK must not exceed ${MAX_TOP_K}`);
    return parsed;
}

function threshold(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new HttpError(400, 'threshold must be between 0 and 1');
    return parsed;
}

async function deterministicId(collection: string, hash: number): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(`${collection}\0${hash}`));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function vectorItems(value: unknown, collection: string): Promise<VectorItem[]> {
    if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'items must be a non-empty array');
    if (value.length > MAX_ITEMS) throw new HttpError(413, `A vector batch may contain at most ${MAX_ITEMS} items`);
    let totalBytes = 0;
    const items: VectorItem[] = [];
    for (const raw of value) {
        const item = objectValue(raw);
        const text = requireString(item.text, 'items[].text', MAX_ITEM_BYTES);
        const bytes = textEncoder.encode(text).byteLength;
        if (bytes > MAX_ITEM_BYTES) throw new HttpError(413, `Vector text must not exceed ${MAX_ITEM_BYTES} bytes`);
        totalBytes += bytes;
        const hash = Number(item.hash);
        if (!Number.isSafeInteger(hash)) throw new HttpError(400, 'items[].hash must be a safe integer');
        const expectedId = await deterministicId(collection, hash);
        const id = requireString(item.id, 'items[].id', 64).toLowerCase();
        if (id !== expectedId) throw new HttpError(400, 'items[].id does not match the deterministic collection/hash ID');
        const index = Number(item.index ?? 0);
        const metadata = objectValue(item.metadata);
        if (JSON.stringify(metadata).length > 1_024) throw new HttpError(413, 'items[].metadata is too large');
        items.push({
            id,
            hash,
            text,
            index: Number.isSafeInteger(index) ? index : 0,
            metadata,
        });
    }
    if (totalBytes > MAX_TEXT_BYTES) throw new HttpError(413, `Vector batch text must not exceed ${MAX_TEXT_BYTES} bytes`);
    return items;
}

export async function embedTexts(env: Env, texts: string[], signal: AbortSignal): Promise<number[][]> {
    let output: Ai_Cf_Baai_Bge_M3_Output;
    try {
        output = await env.AI.run('@cf/baai/bge-m3', { text: texts, truncate_inputs: false }, {
            gateway: {
                id: env.AI_GATEWAY_ID,
                collectLog: false,
                skipCache: true,
                requestTimeoutMs: 30_000,
                retries: { maxAttempts: 1 },
                metadata: { capability: 'embedding' },
            },
            signal,
        });
    } catch (error) {
        if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') throw new HttpError(499, 'Embedding request was cancelled');
        const name = error instanceof Error ? error.name : '';
        if (/limit|quota|rate/iu.test(name)) throw new HttpError(429, 'AI Gateway embedding limit reached');
        throw new HttpError(502, 'AI Gateway embedding failed');
    }
    if (!('data' in output) || !Array.isArray(output.data) || output.data.length !== texts.length) {
        throw new HttpError(502, 'Embedding model returned an invalid batch');
    }
    for (const vector of output.data) {
        if (!Array.isArray(vector) || vector.length !== 1024) throw new HttpError(502, 'Embedding dimensions do not match Vectorize');
    }
    return output.data;
}

async function sourceObject(env: Env, item: VectorItem, collection: string, source: string): Promise<{ key: string; etag: string }> {
    const schemaVersion = Number(env.EMBEDDING_SCHEMA_VERSION);
    const key = `vector-source/${schemaVersion}/${item.id}.json`;
    const body = JSON.stringify({
        id: item.id,
        hash: item.hash,
        collectionId: collection,
        source,
        text: item.text,
        index: item.index,
        metadata: item.metadata,
        schemaVersion,
    });
    const result = await env.BUCKET.put(key, body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
        customMetadata: { source: 'vector-rebuild', schema: String(schemaVersion) },
    });
    if (!result) throw new Error('Unable to store vector rebuild source');
    return { key, etag: result.httpEtag };
}

async function insert(env: Env, request: Request, body: JsonObject): Promise<Response> {
    const collection = collectionId(body.collectionId);
    const source = sourceName(body.source);
    const items = await vectorItems(body.items, collection);
    const vectors = await embedTexts(env, items.map(item => item.text), request.signal);
    const storedSources: string[] = [];
    try {
        const sourceRows: Array<{ key: string; item: VectorItem }> = [];
        for (const item of items) {
            const stored = await sourceObject(env, item, collection, source);
            storedSources.push(stored.key);
            sourceRows.push({ key: stored.key, item });
        }
        await env.VECTOR_INDEX.upsert(items.map((item, index) => ({
            id: item.id,
            values: vectors[index] ?? [],
            metadata: {
                collection_id: collection,
                source,
                schema_version: Number(env.EMBEDDING_SCHEMA_VERSION),
                hash: item.hash,
                index: item.index,
            },
        })));
        const now = Date.now();
        await env.DB.batch(sourceRows.map(row => env.DB.prepare(`
            INSERT INTO vector_manifest(
                id, hash, collection_id, source, schema_version, r2_source_key, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, collection_id = excluded.collection_id,
                source = excluded.source, schema_version = excluded.schema_version,
                r2_source_key = excluded.r2_source_key, metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at
        `).bind(
            row.item.id, row.item.hash, collection, source, Number(env.EMBEDDING_SCHEMA_VERSION), row.key,
            JSON.stringify({ ...row.item.metadata, index: row.item.index }), now, now,
        )));
        return json({ ok: true, count: items.length });
    } catch (error) {
        await Promise.allSettled([
            env.VECTOR_INDEX.deleteByIds(items.map(item => item.id)),
            env.BUCKET.delete(storedSources),
        ]);
        throw error;
    }
}

function decodedCursor(value: unknown): string {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > 128) throw new HttpError(400, 'Invalid cursor');
    try {
        const decoded = atob(value);
        if (!/^[a-f0-9]{64}$/u.test(decoded)) throw new Error('invalid');
        return decoded;
    } catch {
        throw new HttpError(400, 'Invalid cursor');
    }
}

async function list(env: Env, body: JsonObject): Promise<Response> {
    const collection = collectionId(body.collectionId);
    const cursor = decodedCursor(body.cursor);
    const result = await env.DB.prepare(`
        SELECT id, hash FROM vector_manifest
        WHERE collection_id = ? AND schema_version = ? AND id > ? ORDER BY id LIMIT 257
    `).bind(collection, Number(env.EMBEDDING_SCHEMA_VERSION), cursor).all<Pick<ManifestRow, 'id' | 'hash'>>();
    const page = result.results.slice(0, 256);
    return json({
        hashes: page.map(row => row.hash),
        cursor: result.results.length > 256 && page.at(-1) ? btoa(page.at(-1)?.id ?? '') : null,
    });
}

async function hydratedMatches(env: Env, matches: VectorizeMatches, includeText: boolean): Promise<VectorizeMatch[]> {
    if (!includeText) return matches.matches;
    const hydrated: VectorizeMatch[] = [];
    for (let offset = 0; offset < matches.matches.length; offset += MAX_ITEMS) {
        const batch = matches.matches.slice(offset, offset + MAX_ITEMS);
        const resolved = await Promise.all(batch.map(async match => {
            const key = `vector-source/${env.EMBEDDING_SCHEMA_VERSION}/${match.id}.json`;
            const object = await env.BUCKET.get(key);
            if (!object) return match;
            try {
                const source = await object.json<{ text?: unknown; index?: unknown }>();
                const metadata = objectValue(match.metadata);
                return {
                    ...match,
                    metadata: {
                        ...metadata,
                        ...(typeof source.text === 'string' ? { text: source.text } : {}),
                        ...(Number.isSafeInteger(source.index) ? { index: Number(source.index) } : {}),
                    },
                };
            } catch {
                return match;
            }
        }));
        hydrated.push(...resolved);
    }
    return hydrated;
}

async function queryResult(env: Env, matches: VectorizeMatches, minimum: number | undefined, includeText: boolean): Promise<{ hashes: number[]; scores: number[]; metadata: JsonObject[] }> {
    const hydrated = await hydratedMatches(env, matches, includeText);
    const filtered = hydrated.filter(match => minimum === undefined || match.score >= minimum);
    return {
        hashes: filtered.map(match => Number(objectValue(match.metadata).hash)),
        scores: filtered.map(match => match.score),
        metadata: filtered.map(match => objectValue(match.metadata)),
    };
}

async function query(env: Env, request: Request, body: JsonObject): Promise<Response> {
    const collection = collectionId(body.collectionId);
    const searchText = requireString(body.searchText ?? body.text, 'searchText', MAX_ITEM_BYTES);
    const requestedTopK = topK(body.topK);
    const [vector] = await embedTexts(env, [searchText], request.signal);
    if (!vector) throw new HttpError(502, 'Embedding model returned no query vector');
    const matches = await env.VECTOR_INDEX.query(vector, {
        topK: requestedTopK,
        returnMetadata: 'all',
        returnValues: false,
        filter: {
            collection_id: collection,
            schema_version: Number(env.EMBEDDING_SCHEMA_VERSION),
        },
    });
    return json(await queryResult(env, matches, threshold(body.threshold), body.includeText === true));
}

async function queryMulti(env: Env, request: Request, body: JsonObject): Promise<Response> {
    if (!Array.isArray(body.collectionIds) || body.collectionIds.length === 0) throw new HttpError(400, 'collectionIds must be a non-empty array');
    if (body.collectionIds.length > MAX_COLLECTIONS) throw new HttpError(413, `At most ${MAX_COLLECTIONS} collections may be queried`);
    const collections = [...new Set(body.collectionIds.map(collectionId))];
    const searchText = requireString(body.searchText ?? body.text, 'searchText', MAX_ITEM_BYTES);
    const requestedTopK = topK(body.topK);
    const [vector] = await embedTexts(env, [searchText], request.signal);
    if (!vector) throw new HttpError(502, 'Embedding model returned no query vector');
    const matches = await env.VECTOR_INDEX.query(vector, {
        topK: requestedTopK,
        returnMetadata: 'all',
        returnValues: false,
        filter: {
            collection_id: { $in: collections },
            schema_version: Number(env.EMBEDDING_SCHEMA_VERSION),
        },
    });
    const minimum = threshold(body.threshold);
    const hydrated = await hydratedMatches(env, matches, body.includeText === true);
    const grouped: Record<string, { hashes: number[]; scores: number[]; metadata: JsonObject[] }> = {};
    for (const collection of collections) grouped[collection] = { hashes: [], scores: [], metadata: [] };
    for (const match of hydrated) {
        if (minimum !== undefined && match.score < minimum) continue;
        const metadata = objectValue(match.metadata);
        const target = typeof metadata.collection_id === 'string' ? grouped[metadata.collection_id] : undefined;
        if (!target) continue;
        target.hashes.push(Number(metadata.hash));
        target.scores.push(match.score);
        target.metadata.push(metadata);
    }
    return json(grouped);
}

function hashes(value: unknown): number[] {
    if (!Array.isArray(value)) throw new HttpError(400, 'hashes must be an array');
    if (value.length > MAX_DELETE_ITEMS) throw new HttpError(413, `At most ${MAX_DELETE_ITEMS} vectors may be deleted at once`);
    const result = value.map(Number);
    if (!result.every(Number.isSafeInteger)) throw new HttpError(400, 'hashes must contain safe integers');
    return result;
}

async function deleteRows(env: Env, rows: ManifestRow[]): Promise<void> {
    if (rows.length === 0) return;
    await env.VECTOR_INDEX.deleteByIds(rows.map(row => row.id));
    await env.BUCKET.delete(rows.map(row => row.r2_source_key));
    await env.DB.batch(rows.map(row => env.DB.prepare('DELETE FROM vector_manifest WHERE id = ?').bind(row.id)));
}

async function deleteItems(env: Env, body: JsonObject): Promise<Response> {
    const collection = collectionId(body.collectionId);
    const selectedHashes = hashes(body.hashes);
    if (selectedHashes.length === 0) return empty();
    const placeholders = selectedHashes.map(() => '?').join(',');
    const result = await env.DB.prepare(`
        SELECT id, hash, collection_id, source, schema_version, r2_source_key, metadata_json
        FROM vector_manifest WHERE collection_id = ? AND hash IN (${placeholders})
    `).bind(collection, ...selectedHashes).all<ManifestRow>();
    await deleteRows(env, result.results);
    return json({ ok: true, count: result.results.length });
}

async function purge(env: Env, body: JsonObject): Promise<Response> {
    const collection = collectionId(body.collectionId);
    const result = await env.DB.prepare(`
        SELECT id, hash, collection_id, source, schema_version, r2_source_key, metadata_json
        FROM vector_manifest WHERE collection_id = ? ORDER BY id LIMIT ?
    `).bind(collection, MAX_DELETE_ITEMS + 1).all<ManifestRow>();
    const rows = result.results.slice(0, MAX_DELETE_ITEMS);
    await deleteRows(env, rows);
    return json({ ok: true, count: rows.length, remaining: result.results.length > MAX_DELETE_ITEMS });
}

export function registerVectorRoutes(router: Router): void {
    router.on('POST', '/api/vector/list', async ({ request, env }) => list(env, await readJson(request, 32_768)));
    router.on('POST', '/api/vector/insert', async ({ request, env }) => insert(env, request, await readJson(request, 65_536)));
    router.on('POST', '/api/vector/delete', async ({ request, env }) => deleteItems(env, await readJson(request, 32_768)));
    router.on('POST', '/api/vector/query', async ({ request, env }) => query(env, request, await readJson(request, 32_768)));
    router.on('POST', '/api/vector/query-multi', async ({ request, env }) => queryMulti(env, request, await readJson(request, 32_768)));
    router.on('POST', '/api/vector/purge', async ({ request, env }) => purge(env, await readJson(request, 32_768)));
}
