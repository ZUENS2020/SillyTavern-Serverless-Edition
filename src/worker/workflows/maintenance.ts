import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { embedTexts } from '../routes/vectors';

export const MAINTENANCE_JOB_TYPES = [
    'data-maid',
    'backup',
    'vector-rebuild',
    'embedding-migration',
    'r2-gc',
] as const;

export type MaintenanceJobType = typeof MAINTENANCE_JOB_TYPES[number];

// Workers Free permits 1,024 persisted steps per instance. Reserve steps for
// initialization, completion, error bookkeeping, and platform evolution.
export const MAINTENANCE_MAX_BATCH_STEPS = 1_018;

export interface MaintenanceJobParams {
    jobId: string;
    type: MaintenanceJobType;
}

interface BatchState {
    done: boolean;
    phase: 'tombstone' | 'r2' | 'd1';
    cursor: string;
    scopeIndex: number;
    tableIndex: number;
    processed: number;
    total: number;
    parts: number;
    r2Parts: number;
    d1Parts: number;
    orphanCount: number;
    orphanBytes: number;
    orphanParts: number;
}

interface JobRow {
    cancel_requested: number;
    status: string;
}

interface TombstoneRow {
    id: string;
    kind: string;
    target_key: string;
}

interface RevisionRow {
    revision: number;
    r2_key: string;
}

interface VectorRow {
    id: string;
    r2_source_key: string;
}

interface VectorSource {
    id: string;
    hash: number;
    collectionId: string;
    source: string;
    text: string;
    index: number;
    schemaVersion: number;
}

function emptyState(): BatchState {
    return {
        done: false,
        phase: 'r2',
        cursor: '',
        scopeIndex: 0,
        tableIndex: 0,
        processed: 0,
        total: 0,
        parts: 0,
        r2Parts: 0,
        d1Parts: 0,
        orphanCount: 0,
        orphanBytes: 0,
        orphanParts: 0,
    };
}

const R2_BACKUP_PREFIXES = [
    'avatars/', 'characters/', 'chats/', 'worlds/', 'backgrounds/', 'sprites/',
    'gallery/', 'assets/', 'files/', 'data-bank/', 'thumbnails/', 'vector-source/',
] as const;

const D1_BACKUP_TABLES = [
    { table: 'settings', cursor: "section || char(0) || key" },
    { table: 'settings_snapshots', cursor: 'name' },
    { table: 'presets', cursor: "kind || char(0) || name" },
    { table: 'themes', cursor: 'name' },
    { table: 'world_books', cursor: 'id' },
    { table: 'characters', cursor: 'id' },
    { table: 'groups', cursor: 'id' },
    { table: 'group_members', cursor: "group_id || char(0) || character_avatar" },
    { table: 'objects', cursor: 'id' },
    { table: 'chat_index', cursor: 'id' },
    { table: 'chat_revisions', cursor: "chat_id || char(0) || printf('%020d', revision)" },
    { table: 'chat_search', cursor: 'chat_id' },
    { table: 'snapshots', cursor: 'id' },
    { table: 'content_catalog', cursor: 'key' },
    { table: 'ai_capability_profiles', cursor: 'capability' },
    { table: 'embedding_schema', cursor: "printf('%020d', version)" },
    { table: 'vector_manifest', cursor: 'id' },
    { table: 'app_stats', cursor: 'key' },
    { table: 'cache_versions', cursor: 'namespace' },
    { table: 'jobs', cursor: 'id' },
    { table: 'tombstones', cursor: 'id' },
    { table: 'migration_records', cursor: 'name' },
] as const;

async function cancelled(env: Env, jobId: string): Promise<boolean> {
    const job = await env.DB.prepare('SELECT cancel_requested, status FROM jobs WHERE id = ?').bind(jobId).first<JobRow>();
    return !job || job.cancel_requested === 1 || job.status === 'cancelled';
}

async function updateProgress(env: Env, jobId: string, state: BatchState): Promise<void> {
    const progress = state.done ? 100 : state.total > 0 ? Math.min(99, Math.floor(state.processed * 100 / state.total)) : 0;
    await env.DB.prepare(`
        UPDATE jobs SET status = 'running', progress = ?, output_json = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
    `).bind(progress, JSON.stringify(state), Date.now(), jobId).run();
}

async function gcBatch(env: Env, state: BatchState): Promise<BatchState> {
    const tombstone = await env.DB.prepare(`
        SELECT id, kind, target_key FROM tombstones WHERE processed_at IS NULL ORDER BY created_at LIMIT 1
    `).first<TombstoneRow>();
    if (!tombstone) return { ...state, phase: 'r2', cursor: '', scopeIndex: 0 };
    if (tombstone.kind !== 'chat') {
        await env.DB.prepare('UPDATE tombstones SET processed_at = ? WHERE id = ?').bind(Date.now(), tombstone.id).run();
        return { ...state, processed: state.processed + 1 };
    }

    const revisions = await env.DB.prepare(`
        SELECT revision, r2_key FROM chat_revisions WHERE chat_id = ? ORDER BY revision LIMIT 101
    `).bind(tombstone.target_key).all<RevisionRow>();
    const revisionBatch = revisions.results.slice(0, 100);
    if (revisionBatch.length > 0) {
        await env.BUCKET.delete(revisionBatch.map(row => row.r2_key));
        await env.DB.batch(revisionBatch.map(row => env.DB.prepare(
            'DELETE FROM chat_revisions WHERE chat_id = ? AND revision = ?',
        ).bind(tombstone.target_key, row.revision)));
        return { ...state, processed: state.processed + revisionBatch.length };
    }

    const collection = `chat:${tombstone.target_key}`;
    const vectors = await env.DB.prepare(`
        SELECT id, r2_source_key FROM vector_manifest WHERE collection_id = ? ORDER BY id LIMIT 101
    `).bind(collection).all<VectorRow>();
    const vectorBatch = vectors.results.slice(0, 100);
    if (vectorBatch.length > 0) {
        await env.VECTOR_INDEX.deleteByIds(vectorBatch.map(row => row.id));
        await env.BUCKET.delete(vectorBatch.map(row => row.r2_source_key));
        await env.DB.batch(vectorBatch.map(row => env.DB.prepare('DELETE FROM vector_manifest WHERE id = ?').bind(row.id)));
        return { ...state, processed: state.processed + vectorBatch.length };
    }

    await env.DB.batch([
        env.DB.prepare('DELETE FROM chat_index WHERE id = ?').bind(tombstone.target_key),
        env.DB.prepare('UPDATE tombstones SET processed_at = ? WHERE id = ?').bind(Date.now(), tombstone.id),
    ]);
    return { ...state, processed: state.processed + 1 };
}

interface ListedR2Object {
    key: string;
    size: number;
    etag: string;
    uploaded: string;
}

async function indexedR2Keys(env: Env, keys: readonly string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const placeholders = keys.map(() => '?').join(',');
    const result = await env.DB.prepare(`
        SELECT r2_key FROM objects WHERE r2_key IN (${placeholders})
        UNION SELECT r2_key FROM chat_revisions WHERE r2_key IN (${placeholders})
        UNION SELECT r2_source_key AS r2_key FROM vector_manifest WHERE r2_source_key IN (${placeholders})
    `).bind(...keys, ...keys, ...keys).all<{ r2_key: string }>();
    return new Set(result.results.map(row => row.r2_key));
}

async function scanR2Batch(env: Env, jobId: string, state: BatchState, removeOrphans: boolean): Promise<BatchState> {
    const prefix = R2_BACKUP_PREFIXES[state.scopeIndex];
    if (!prefix) return { ...state, done: true };
    const listed = await env.BUCKET.list(state.cursor
        ? { prefix, limit: 100, cursor: state.cursor }
        : { prefix, limit: 100 });
    const known = await indexedR2Keys(env, listed.objects.map(object => object.key));
    const orphans: ListedR2Object[] = listed.objects
        .filter(object => !known.has(object.key))
        .map(object => ({
            key: object.key,
            size: object.size,
            etag: object.httpEtag,
            uploaded: object.uploaded.toISOString(),
        }));
    let orphanParts = state.orphanParts;
    if (orphans.length > 0) {
        if (removeOrphans) {
            await env.BUCKET.delete(orphans.map(object => object.key));
        } else {
            orphanParts += 1;
            await env.BUCKET.put(
                `backups/data-maid-${jobId}/orphan-${String(orphanParts).padStart(6, '0')}.json`,
                JSON.stringify({ prefix, objects: orphans }),
                { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' } },
            );
        }
    }
    const nextScope = listed.truncated ? state.scopeIndex : state.scopeIndex + 1;
    return {
        ...state,
        done: nextScope >= R2_BACKUP_PREFIXES.length,
        cursor: listed.truncated ? listed.cursor ?? '' : '',
        scopeIndex: nextScope,
        processed: state.processed + listed.objects.length,
        orphanCount: state.orphanCount + orphans.length,
        orphanBytes: state.orphanBytes + orphans.reduce((sum, object) => sum + object.size, 0),
        orphanParts,
    };
}

async function backupBatch(env: Env, jobId: string, state: BatchState): Promise<BatchState> {
    if (state.phase === 'r2') {
        const prefix = R2_BACKUP_PREFIXES[state.scopeIndex];
        if (!prefix) return { ...state, phase: 'd1', cursor: '', scopeIndex: 0 };
        const listed = await env.BUCKET.list(state.cursor
            ? { prefix, limit: 100, cursor: state.cursor }
            : { prefix, limit: 100 });
        const objects = listed.objects.map(object => ({
            key: object.key,
            size: object.size,
            etag: object.httpEtag,
            uploaded: object.uploaded.toISOString(),
        }));
        const part = state.r2Parts + 1;
        await env.BUCKET.put(`backups/${jobId}/r2-${String(part).padStart(6, '0')}.json`, JSON.stringify({ prefix, objects }), {
            httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
        });
        const nextScope = listed.truncated ? state.scopeIndex : state.scopeIndex + 1;
        return {
            ...state,
            phase: nextScope >= R2_BACKUP_PREFIXES.length ? 'd1' : 'r2',
            cursor: listed.truncated ? listed.cursor ?? '' : '',
            scopeIndex: nextScope,
            processed: state.processed + objects.length,
            parts: state.parts + 1,
            r2Parts: part,
        };
    }

    const specification = D1_BACKUP_TABLES[state.tableIndex];
    if (!specification) return { ...state, done: true };
    const result = await env.DB.prepare(`
        SELECT *, ${specification.cursor} AS __backup_cursor
        FROM ${specification.table}
        WHERE ${specification.cursor} > ?
        ORDER BY ${specification.cursor}
        LIMIT 100
    `).bind(state.cursor).all<Record<string, unknown> & { __backup_cursor: string }>();
    if (result.results.length === 0) {
        return { ...state, cursor: '', tableIndex: state.tableIndex + 1 };
    }
    const cursor = String(result.results.at(-1)?.__backup_cursor ?? '');
    const rows = result.results.map(({ __backup_cursor: _cursor, ...row }) => row);
    const part = state.d1Parts + 1;
    await env.BUCKET.put(`backups/${jobId}/d1-${String(part).padStart(6, '0')}.json`, JSON.stringify({
        table: specification.table,
        rows,
    }), {
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
    });
    return {
        ...state,
        cursor,
        processed: state.processed + rows.length,
        parts: state.parts + 1,
        d1Parts: part,
    };
}

function rebuildTarget(env: Env, type: MaintenanceJobType): VectorizeIndex {
    if (type !== 'embedding-migration') return env.VECTOR_INDEX;
    const target = (env as Env & { VECTOR_INDEX_MIGRATION?: VectorizeIndex }).VECTOR_INDEX_MIGRATION;
    if (!target) throw new Error('VECTOR_MIGRATION_BINDING_REQUIRED');
    return target;
}

async function rebuildBatch(env: Env, state: BatchState, target: VectorizeIndex): Promise<BatchState> {
    const result = await env.DB.prepare(`
        SELECT id, r2_source_key FROM vector_manifest
        WHERE schema_version = ? AND id > ? ORDER BY id LIMIT 5
    `).bind(Number(env.EMBEDDING_SCHEMA_VERSION), state.cursor).all<VectorRow>();
    const rows = result.results.slice(0, 4);
    if (rows.length === 0) return { ...state, done: true };

    const sources: VectorSource[] = [];
    for (const row of rows) {
        const object = await env.BUCKET.get(row.r2_source_key);
        if (!object) throw new Error('VECTOR_SOURCE_MISSING');
        const source = await object.json<VectorSource>();
        if (source.id !== row.id || source.schemaVersion !== Number(env.EMBEDDING_SCHEMA_VERSION)) {
            throw new Error('VECTOR_SOURCE_SCHEMA_MISMATCH');
        }
        sources.push(source);
    }
    const abort = new AbortController();
    const values = await embedTexts(env, sources.map(source => source.text), abort.signal);
    await target.upsert(sources.map((source, index) => ({
        id: source.id,
        values: values[index] ?? [],
        metadata: {
            hash: source.hash,
            collection_id: source.collectionId,
            source: source.source,
            index: source.index,
            schema_version: source.schemaVersion,
        },
    })));
    return {
        ...state,
        done: result.results.length <= 4,
        cursor: rows.at(-1)?.id ?? state.cursor,
        processed: state.processed + rows.length,
    };
}

async function initialState(env: Env, type: MaintenanceJobType): Promise<BatchState> {
    const state = emptyState();
    if (type === 'r2-gc') state.phase = 'tombstone';
    if (type === 'vector-rebuild' || type === 'embedding-migration') {
        rebuildTarget(env, type);
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM vector_manifest WHERE schema_version = ?')
            .bind(Number(env.EMBEDDING_SCHEMA_VERSION)).first<{ count: number }>();
        state.total = count?.count ?? 0;
    }
    return state;
}

export class MaintenanceWorkflow extends WorkflowEntrypoint<Env, MaintenanceJobParams> {
    override async run(event: Readonly<WorkflowEvent<MaintenanceJobParams>>, step: WorkflowStep): Promise<unknown> {
        const { jobId, type } = event.payload;
        let state = await step.do('initialize', async () => {
            if (await cancelled(this.env, jobId)) return { ...emptyState(), done: true };
            const created = await initialState(this.env, type);
            await updateProgress(this.env, jobId, created);
            return created;
        });

        try {
            for (let index = 0; !state.done && index < MAINTENANCE_MAX_BATCH_STEPS; index += 1) {
                state = await step.do(`batch-${index + 1}`, {
                    retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
                    timeout: '2 minutes',
                }, async () => {
                    if (await cancelled(this.env, jobId)) return { ...state, done: true };
                    let next: BatchState;
                    if (type === 'backup') next = await backupBatch(this.env, jobId, state);
                    else if (type === 'vector-rebuild' || type === 'embedding-migration') {
                        next = await rebuildBatch(this.env, state, rebuildTarget(this.env, type));
                    }
                    else if (type === 'data-maid') next = await scanR2Batch(this.env, jobId, state, false);
                    else next = state.phase === 'tombstone'
                        ? await gcBatch(this.env, state)
                        : await scanR2Batch(this.env, jobId, state, true);
                    await updateProgress(this.env, jobId, next);
                    return next;
                });
            }
            if (!state.done) throw new Error('WORKFLOW_STEP_BUDGET_EXCEEDED');
            await step.do('complete', async () => {
                const job = await this.env.DB.prepare('SELECT cancel_requested, status FROM jobs WHERE id = ?')
                    .bind(jobId).first<JobRow>();
                const status = job?.cancel_requested === 1 || job?.status === 'cancelled' ? 'cancelled' : 'complete';
                if (type === 'backup' && status === 'complete') {
                    await this.env.BUCKET.put(`backups/${jobId}/manifest.json`, JSON.stringify({
                        version: 1,
                        createdAt: new Date().toISOString(),
                        d1Tables: D1_BACKUP_TABLES.map(table => table.table),
                        r2Prefixes: R2_BACKUP_PREFIXES,
                        parts: state.parts,
                        r2Parts: state.r2Parts,
                        d1Parts: state.d1Parts,
                        entries: state.processed,
                    }), {
                        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
                    });
                }
                if (type === 'data-maid' && status === 'complete') {
                    await this.env.BUCKET.put(`backups/data-maid-${jobId}/manifest.json`, JSON.stringify({
                        version: 1,
                        createdAt: new Date().toISOString(),
                        scannedObjects: state.processed,
                        orphanObjects: state.orphanCount,
                        orphanBytes: state.orphanBytes,
                        parts: state.orphanParts,
                    }), {
                        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
                    });
                }
                await this.env.DB.prepare(`
                    UPDATE jobs SET status = ?, progress = ?, output_json = ?, updated_at = ?, completed_at = ? WHERE id = ?
                `).bind(status, status === 'complete' ? 100 : 0, JSON.stringify(state), Date.now(), Date.now(), jobId).run();
                return { status };
            });
            return state;
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            const errorCode = /^[A-Z][A-Z0-9_]{2,63}$/u.test(message) ? message : 'WORKFLOW_ERROR';
            await this.env.DB.prepare(`
                UPDATE jobs SET status = 'failed', error_code = ?, updated_at = ?, completed_at = ? WHERE id = ?
            `).bind(errorCode, Date.now(), Date.now(), jobId).run();
            throw error;
        }
    }
}
