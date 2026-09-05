import { empty, HttpError, json, readJson, requireString } from '../http';
import type { RouteContext, Router } from '../router';
import { readSecret } from '../storage/secrets';
import { safeRemoteUrl } from './providers';

type JsonObject = Record<string, unknown>;
type VectorProvider = 'qdrant' | 'pinecone';

interface QdrantConnection {
    provider: 'qdrant';
    endpoint: URL;
    collection: string;
    model: string;
    namespace: string;
}

interface PineconeConnection {
    provider: 'pinecone';
    endpoint: URL;
    namespace: string;
}

type VectorConnection = QdrantConnection | PineconeConnection;

interface VectorResult {
    hashes: number[];
    scores: number[];
    metadata: JsonObject[];
}

const PROVIDERS = [
    {
        id: 'qdrant',
        label: 'Qdrant Cloud',
        capabilities: ['cloud-inference', 'batch-query', 'filtered-delete'],
        required: ['endpoint', 'collection', 'namespace'],
        defaults: {
            collection: 'sillytavern',
            namespace: 'sillytavern-serverless',
            model: 'sentence-transformers/all-MiniLM-L6-v2',
        },
    },
    {
        id: 'pinecone',
        label: 'Pinecone',
        capabilities: ['integrated-inference', 'metadata-filter', 'serverless-index'],
        required: ['host', 'namespace'],
        defaults: { namespace: 'sillytavern-serverless' },
    },
] as const;

const MAX_PROVIDER_JSON_BYTES = 262_144;
const MAX_VECTOR_REQUEST_BYTES = 65_536;
const MAX_VECTOR_ITEMS = 8;
const MAX_ITEM_TEXT = 16_384;
const MAX_COLLECTIONS = 8;
const MAX_TOP_K = 20;
const PROVIDER_TIMEOUT_MS = 15_000;

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), minimum), maximum) : fallback;
}

function topKValue(value: unknown): number {
    if (value === undefined || value === null || value === '') return 10;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) throw new HttpError(400, 'topK must be a positive integer');
    if (parsed > MAX_TOP_K) throw new HttpError(413, `topK must not exceed ${MAX_TOP_K}`);
    return Math.trunc(parsed);
}

function boundedThreshold(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : undefined;
}

function identifier(value: unknown, field: string, maxLength = 256): string {
    const result = requireString(value, field, maxLength).trim();
    if (!/^[\p{L}\p{N}_.:@/+-]+$/u.test(result)) throw new HttpError(400, `Invalid ${field}`);
    return result;
}

function providerEndpoint(value: unknown, provider: VectorProvider): URL {
    const endpoint = safeRemoteUrl(value, provider === 'qdrant' ? 'Qdrant endpoint' : 'Pinecone host');
    const hostname = endpoint.hostname.toLowerCase();
    const allowed = provider === 'qdrant'
        ? hostname.endsWith('.qdrant.io')
        : hostname.endsWith('.pinecone.io');
    if (!allowed) throw new HttpError(400, `${provider} endpoint is not an approved managed-service host`);
    endpoint.pathname = '/';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint;
}

function connection(body: JsonObject): VectorConnection {
    const value = objectValue(body.connection);
    const provider = requireString(value.provider ?? body.provider ?? body.source, 'connection.provider', 32);
    if (provider === 'qdrant') {
        return {
            provider,
            endpoint: providerEndpoint(value.endpoint, provider),
            collection: identifier(value.collection, 'connection.collection', 128),
            model: typeof value.model === 'string' && value.model
                ? identifier(value.model, 'connection.model', 256)
                : 'sentence-transformers/all-MiniLM-L6-v2',
            namespace: identifier(value.namespace, 'connection.namespace', 128),
        };
    }
    if (provider === 'pinecone') {
        return {
            provider,
            endpoint: providerEndpoint(value.host ?? value.endpoint, provider),
            namespace: identifier(value.namespace, 'connection.namespace', 128),
        };
    }
    throw new HttpError(400, 'Unsupported vector provider');
}

function collectionId(value: unknown): string {
    return requireString(value, 'collectionId', 256);
}

function apiUrl(base: URL, pathname: string, search?: Record<string, string>): URL {
    const result = new URL(base);
    result.pathname = pathname;
    result.search = '';
    for (const [key, value] of Object.entries(search ?? {})) result.searchParams.set(key, value);
    return result;
}

function qdrantPath(config: QdrantConnection, suffix: string): string {
    return `/collections/${encodeURIComponent(config.collection)}${suffix}`;
}

function pineconePath(config: PineconeConnection, suffix: string): string {
    return `/records/namespaces/${encodeURIComponent(config.namespace)}${suffix}`;
}

async function providerKey(env: Env, provider: VectorProvider): Promise<string> {
    const key = await readSecret(env, provider === 'qdrant' ? 'api_key_qdrant' : 'api_key_pinecone');
    if (!key) throw new HttpError(400, `Missing ${provider} API key`);
    return key;
}

function providerHeaders(provider: VectorProvider, apiKey: string, contentType = 'application/json'): Headers {
    const headers = new Headers({ accept: 'application/json', 'content-type': contentType });
    if (provider === 'qdrant') headers.set('api-key', apiKey);
    else {
        headers.set('api-key', apiKey);
        headers.set('x-pinecone-api-version', '2026-04');
    }
    return headers;
}

async function providerFetch(
    context: RouteContext,
    provider: VectorProvider,
    url: URL,
    apiKey: string,
    init: RequestInit = {},
): Promise<Response> {
    const started = Date.now();
    try {
        const response = await fetch(url, {
            ...init,
            headers: init.headers ?? providerHeaders(provider, apiKey),
            signal: AbortSignal.any([context.request.signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]),
            redirect: 'error',
        });
        console.log(JSON.stringify({ event: 'vector_provider', provider, status: response.status, latencyMs: Date.now() - started }));
        return response;
    } catch (error) {
        const cancelled = context.request.signal.aborted;
        const timedOut = !cancelled && error instanceof DOMException && error.name === 'TimeoutError';
        const status = cancelled ? 499 : timedOut ? 504 : 502;
        console.log(JSON.stringify({ event: 'vector_provider', provider, status, latencyMs: Date.now() - started }));
        throw new HttpError(status, cancelled ? `${provider} request cancelled` : timedOut ? `${provider} request timed out` : `${provider} request failed`);
    }
}

async function readBoundedJson(response: Response, provider: VectorProvider): Promise<JsonObject> {
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_PROVIDER_JSON_BYTES) throw new HttpError(502, `${provider} response is too large`);
    if (!response.body) return {};
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PROVIDER_JSON_BYTES) {
            await reader.cancel('provider response exceeded limit');
            throw new HttpError(502, `${provider} response is too large`);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new HttpError(502, `${provider} returned invalid JSON`);
    }
    return objectValue(parsed);
}

async function checkedJson(response: Response, provider: VectorProvider): Promise<JsonObject> {
    const value = await readBoundedJson(response, provider);
    if (!response.ok) throw new HttpError(502, `${provider} returned HTTP ${response.status}`);
    return value;
}

async function checkedMutation(response: Response, provider: VectorProvider): Promise<void> {
    if (response.ok) {
        await response.body?.cancel();
        return;
    }
    await checkedJson(response, provider);
}

function qdrantFilter(config: QdrantConnection, id?: string): JsonObject {
    const must: JsonObject[] = [{ key: 'st_namespace', match: { value: config.namespace } }];
    if (id !== undefined) must.push({ key: 'st_collection', match: { value: id } });
    return { must };
}

function vectorResult(points: unknown[], threshold?: number): VectorResult {
    const hashes: number[] = [];
    const scores: number[] = [];
    const metadata: JsonObject[] = [];
    for (const value of points) {
        const point = objectValue(value);
        const score = Number(point.score ?? point._score ?? 0);
        if (threshold !== undefined && score < threshold) continue;
        const payload = Object.keys(objectValue(point.payload)).length > 0 ? objectValue(point.payload) : objectValue(point.fields);
        const hash = Number(payload.st_hash);
        if (!Number.isFinite(hash)) continue;
        hashes.push(hash);
        scores.push(score);
        metadata.push({ hash, text: typeof payload.chunk_text === 'string' ? payload.chunk_text : '', index: Number(payload.st_index ?? 0), score });
    }
    return { hashes, scores, metadata };
}

async function queryQdrant(
    context: RouteContext,
    config: QdrantConnection,
    apiKey: string,
    id: string,
    searchText: string,
    topK: number,
    threshold?: number,
): Promise<VectorResult> {
    const response = await providerFetch(context, 'qdrant', apiUrl(config.endpoint, qdrantPath(config, '/points/query')), apiKey, {
        method: 'POST',
        headers: providerHeaders('qdrant', apiKey),
        body: JSON.stringify({
            query: { text: searchText, model: config.model },
            filter: qdrantFilter(config, id),
            limit: topK,
            ...(threshold === undefined ? {} : { score_threshold: threshold }),
            with_payload: ['st_hash', 'st_index', 'chunk_text'],
            with_vector: false,
        }),
    });
    const data = await checkedJson(response, 'qdrant');
    return vectorResult(Array.isArray(objectValue(data.result).points) ? objectValue(data.result).points as unknown[] : [], threshold);
}

async function queryPinecone(
    context: RouteContext,
    config: PineconeConnection,
    apiKey: string,
    id: string,
    searchText: string,
    topK: number,
    threshold?: number,
): Promise<VectorResult> {
    const response = await providerFetch(context, 'pinecone', apiUrl(config.endpoint, pineconePath(config, '/search')), apiKey, {
        method: 'POST',
        headers: providerHeaders('pinecone', apiKey),
        body: JSON.stringify({
            query: { inputs: { text: searchText }, top_k: topK, filter: { st_collection: { $eq: id } } },
            fields: ['chunk_text', 'st_hash', 'st_index', 'st_collection', 'st_namespace'],
        }),
    });
    const data = await checkedJson(response, 'pinecone');
    const hits = objectValue(data.result).hits;
    return vectorResult(Array.isArray(hits) ? hits : [], threshold);
}

function vectorItems(value: unknown): Array<{ id: string; hash: number; text: string; index: number }> {
    if (!Array.isArray(value)) throw new HttpError(400, 'Items must be an array');
    if (value.length > MAX_VECTOR_ITEMS) throw new HttpError(413, `At most ${MAX_VECTOR_ITEMS} vector items may be inserted at once`);
    return value.map(raw => {
        const item = objectValue(raw);
        const hash = Number(item.hash);
        const text = requireString(item.text, 'item.text', MAX_ITEM_TEXT);
        const id = requireString(item.id, 'item.id', 128);
        if (!Number.isFinite(hash) || !/^[a-z0-9:_-]+$/iu.test(id)) throw new HttpError(400, 'Invalid vector item');
        return { id, hash, text, index: boundedInteger(item.index, 0, 0, 1_000_000) };
    });
}

async function testConnection(context: RouteContext, config: VectorConnection, apiKey: string): Promise<Response> {
    if (config.provider === 'qdrant') {
        const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '')), apiKey, {
            headers: providerHeaders(config.provider, apiKey),
        });
        if (response.status === 404) return json({ ok: true, provider: config.provider, initialized: false });
        await checkedJson(response, config.provider);
        return json({ ok: true, provider: config.provider, initialized: true });
    }
    const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, pineconePath(config, '/search')), apiKey, {
        method: 'POST',
        headers: providerHeaders(config.provider, apiKey),
        body: JSON.stringify({ query: { inputs: { text: 'connection test' }, top_k: 1 }, fields: ['st_hash'] }),
    });
    await checkedJson(response, config.provider);
    return json({ ok: true, provider: config.provider, initialized: true });
}

export function registerVectorRoutes(router: Router): void {
    router.on('GET', '/api/vector/providers', () => json({ providers: PROVIDERS }));

    router.on('POST', '/api/vector/test', async context => {
        const body = await readJson(context.request, 16_384);
        const config = connection(body);
        return testConnection(context, config, await providerKey(context.env, config.provider));
    });

    router.on('POST', '/api/vector/initialize', async context => {
        const body = await readJson(context.request, 16_384);
        const config = connection(body);
        const apiKey = await providerKey(context.env, config.provider);
        if (config.provider === 'pinecone') return testConnection(context, config, apiKey);
        const existing = await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '')), apiKey, {
            headers: providerHeaders(config.provider, apiKey),
        });
        if (existing.ok) {
            await existing.body?.cancel();
            return json({ ok: true, provider: config.provider, initialized: true, created: false });
        }
        if (existing.status !== 404) await checkedJson(existing, config.provider);
        const created = await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '')), apiKey, {
            method: 'PUT',
            headers: providerHeaders(config.provider, apiKey),
            body: JSON.stringify({ vectors: { size: 384, distance: 'Cosine' } }),
        });
        await checkedJson(created, config.provider);
        for (const field of ['st_namespace', 'st_collection']) {
            const indexed = await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '/index')), apiKey, {
                method: 'PUT',
                headers: providerHeaders(config.provider, apiKey),
                body: JSON.stringify({ field_name: field, field_schema: 'keyword' }),
            });
            await checkedJson(indexed, config.provider);
        }
        return json({ ok: true, provider: config.provider, initialized: true, created: true });
    });

    router.on('POST', '/api/vector/insert', async context => {
        const body = await readJson(context.request, MAX_VECTOR_REQUEST_BYTES);
        const config = connection(body);
        const id = collectionId(body.collectionId);
        const items = vectorItems(body.items);
        if (items.length === 0) return empty(200);
        const apiKey = await providerKey(context.env, config.provider);
        if (config.provider === 'qdrant') {
            const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '/points'), { wait: 'true' }), apiKey, {
                method: 'PUT',
                headers: providerHeaders(config.provider, apiKey),
                body: JSON.stringify({ points: items.map(item => ({
                    id: item.id,
                    vector: { text: item.text, model: config.model },
                    payload: {
                        st_namespace: config.namespace,
                        st_collection: id,
                        st_hash: item.hash,
                        st_index: item.index,
                        chunk_text: item.text,
                    },
                })) }),
            });
            await checkedJson(response, config.provider);
        } else {
            const ndjson = items.map(item => JSON.stringify({
                _id: item.id,
                chunk_text: item.text,
                st_namespace: config.namespace,
                st_collection: id,
                st_hash: item.hash,
                st_index: item.index,
            })).join('\n');
            const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, pineconePath(config, '/upsert')), apiKey, {
                method: 'POST',
                headers: providerHeaders(config.provider, apiKey, 'application/x-ndjson'),
                body: ndjson,
            });
            if (!response.ok) await checkedJson(response, config.provider);
            else await response.body?.cancel();
        }
        return empty(200);
    });

    router.on('POST', '/api/vector/list', async context => {
        const body = await readJson(context.request, 16_384);
        const config = connection(body);
        const id = collectionId(body.collectionId);
        const cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor.slice(0, 2_048) : undefined;
        const apiKey = await providerKey(context.env, config.provider);
        if (config.provider === 'qdrant') {
            let offset: unknown;
            try {
                offset = cursor ? JSON.parse(atob(cursor)) as unknown : undefined;
            } catch {
                throw new HttpError(400, 'Invalid vector cursor');
            }
            const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '/points/scroll')), apiKey, {
                method: 'POST',
                headers: providerHeaders(config.provider, apiKey),
                body: JSON.stringify({
                    filter: qdrantFilter(config, id), limit: 256, with_payload: ['st_hash'], with_vector: false,
                    ...(offset === undefined ? {} : { offset }),
                }),
            });
            const data = await checkedJson(response, config.provider);
            const result = objectValue(data.result);
            const points = Array.isArray(result.points) ? result.points : [];
            const hashes = points.map(point => Number(objectValue(objectValue(point).payload).st_hash)).filter(Number.isFinite);
            const next = result.next_page_offset;
            return json({ hashes, cursor: next === undefined || next === null ? null : btoa(JSON.stringify(next)) });
        }
        const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, '/vectors/fetch_by_metadata'), apiKey, {
            method: 'POST',
            headers: providerHeaders(config.provider, apiKey),
            body: JSON.stringify({
                namespace: config.namespace,
                filter: { st_namespace: { $eq: config.namespace }, st_collection: { $eq: id } },
                limit: 32,
                ...(cursor ? { paginationToken: cursor } : {}),
            }),
        });
        const data = await checkedJson(response, config.provider);
        const vectors = Object.values(objectValue(data.vectors));
        const hashes = vectors.map(value => Number(objectValue(objectValue(value).metadata).st_hash)).filter(Number.isFinite);
        const next = objectValue(data.pagination).next;
        return json({ hashes, cursor: typeof next === 'string' && next ? next : null });
    });

    router.on('POST', '/api/vector/delete', async context => {
        const body = await readJson(context.request, 32_768);
        const config = connection(body);
        const id = collectionId(body.collectionId);
        const hashes = Array.isArray(body.hashes) ? body.hashes.slice(0, 100).map(Number).filter(Number.isFinite) : [];
        if (hashes.length === 0) return empty(200);
        const apiKey = await providerKey(context.env, config.provider);
        if (config.provider === 'qdrant') {
            const filter = qdrantFilter(config, id);
            (filter.must as JsonObject[]).push({ key: 'st_hash', match: { any: hashes } });
            const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '/points/delete'), { wait: 'true' }), apiKey, {
                method: 'POST', headers: providerHeaders(config.provider, apiKey), body: JSON.stringify({ filter }),
            });
            await checkedMutation(response, config.provider);
        } else {
            const ids = Array.isArray(body.ids) ? body.ids.slice(0, 100).filter(value => typeof value === 'string') : [];
            if (ids.length !== hashes.length) throw new HttpError(400, 'Pinecone delete requires deterministic item ids');
            const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, '/vectors/delete'), apiKey, {
                method: 'POST', headers: providerHeaders(config.provider, apiKey), body: JSON.stringify({ ids, namespace: config.namespace }),
            });
            await checkedJson(response, config.provider);
        }
        return empty(200);
    });

    router.on('POST', '/api/vector/query', async context => {
        const body = await readJson(context.request, MAX_VECTOR_REQUEST_BYTES);
        const config = connection(body);
        const id = collectionId(body.collectionId);
        const text = requireString(body.searchText, 'searchText', MAX_ITEM_TEXT);
        const topK = topKValue(body.topK);
        const threshold = boundedThreshold(body.threshold);
        const apiKey = await providerKey(context.env, config.provider);
        return json(config.provider === 'qdrant'
            ? await queryQdrant(context, config, apiKey, id, text, topK, threshold)
            : await queryPinecone(context, config, apiKey, id, text, topK, threshold));
    });

    router.on('POST', '/api/vector/query-multi', async context => {
        const body = await readJson(context.request, MAX_VECTOR_REQUEST_BYTES);
        const config = connection(body);
        if (!Array.isArray(body.collectionIds)) throw new HttpError(400, 'collectionIds must be an array');
        if (body.collectionIds.length > MAX_COLLECTIONS) throw new HttpError(413, `At most ${MAX_COLLECTIONS} collections may be queried at once`);
        const ids = body.collectionIds.map(collectionId);
        const text = requireString(body.searchText, 'searchText', MAX_ITEM_TEXT);
        const topK = topKValue(body.topK);
        const threshold = boundedThreshold(body.threshold);
        const apiKey = await providerKey(context.env, config.provider);
        const results: Record<string, VectorResult> = {};
        if (config.provider === 'qdrant') {
            const response = await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '/points/query/batch')), apiKey, {
                method: 'POST',
                headers: providerHeaders(config.provider, apiKey),
                body: JSON.stringify({ searches: ids.map(id => ({
                    query: { text, model: config.model },
                    filter: qdrantFilter(config, id),
                    limit: topK,
                    ...(threshold === undefined ? {} : { score_threshold: threshold }),
                    with_payload: ['st_hash', 'st_index', 'chunk_text'],
                    with_vector: false,
                })) }),
            });
            const data = await checkedJson(response, config.provider);
            const batches = Array.isArray(data.result) ? data.result : [];
            ids.forEach((id, index) => {
                const points = objectValue(batches[index]).points;
                results[id] = vectorResult(Array.isArray(points) ? points : [], threshold);
            });
        } else {
            for (let offset = 0; offset < ids.length; offset += 4) {
                const group = ids.slice(offset, offset + 4);
                const groupResults = await Promise.all(group.map(id => queryPinecone(context, config, apiKey, id, text, topK, threshold)));
                group.forEach((id, index) => { results[id] = groupResults[index] ?? { hashes: [], scores: [], metadata: [] }; });
            }
        }
        return json(results);
    });

    router.on('POST', '/api/vector/purge', async context => {
        const body = await readJson(context.request, 16_384);
        const config = connection(body);
        const id = collectionId(body.collectionId);
        const apiKey = await providerKey(context.env, config.provider);
        const response = config.provider === 'qdrant'
            ? await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '/points/delete'), { wait: 'true' }), apiKey, {
                method: 'POST', headers: providerHeaders(config.provider, apiKey), body: JSON.stringify({ filter: qdrantFilter(config, id) }),
            })
            : await providerFetch(context, config.provider, apiUrl(config.endpoint, '/vectors/delete'), apiKey, {
                method: 'POST', headers: providerHeaders(config.provider, apiKey),
                body: JSON.stringify({ namespace: config.namespace, filter: { st_collection: { $eq: id } } }),
            });
        await checkedMutation(response, config.provider);
        return empty(200);
    });

    router.on('POST', '/api/vector/purge-all', async context => {
        const body = await readJson(context.request, 16_384);
        const config = connection(body);
        const apiKey = await providerKey(context.env, config.provider);
        const response = config.provider === 'qdrant'
            ? await providerFetch(context, config.provider, apiUrl(config.endpoint, qdrantPath(config, '/points/delete'), { wait: 'true' }), apiKey, {
                method: 'POST', headers: providerHeaders(config.provider, apiKey), body: JSON.stringify({ filter: qdrantFilter(config) }),
            })
            : await providerFetch(context, config.provider, apiUrl(config.endpoint, '/vectors/delete'), apiKey, {
                method: 'POST', headers: providerHeaders(config.provider, apiKey),
                body: JSON.stringify({ namespace: config.namespace, filter: { st_namespace: { $eq: config.namespace } } }),
            });
        await checkedMutation(response, config.provider);
        return empty(200);
    });
}
