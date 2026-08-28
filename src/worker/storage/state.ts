interface StateRow {
    namespace: string;
    key: string;
    value: string;
    value_type: string;
    etag: string;
    created_at: number;
    updated_at: number;
}

export interface StateRecord<T = unknown> {
    namespace: string;
    key: string;
    value: T;
    etag: string;
    createdAt: number;
    updatedAt: number;
}

interface StateTable {
    table: 'settings' | 'settings_snapshots' | 'presets' | 'themes' | 'world_books' | 'characters' | 'groups' | 'app_stats';
    keyColumn: 'key' | 'name' | 'id' | 'avatar';
    valueColumn: 'value_json' | 'card_json';
    discriminatorColumn?: 'section' | 'kind';
    discriminator?: string;
}

const CACHEABLE_NAMESPACES = new Set([
    'settings', 'theme', 'world', 'character', 'group', 'system', 'image-metadata', 'hidden-background',
]);

export const SETTINGS_VIEW_CACHE_KEY = 'view:settings-payload:v1';

function isCacheable(namespace: string): boolean {
    return CACHEABLE_NAMESPACES.has(namespace) || namespace.startsWith('preset:');
}

function recordCacheKey(namespace: string, key: string): string {
    return `state:${encodeURIComponent(namespace)}:${encodeURIComponent(key)}`;
}

function listCacheKey(namespace: string): string {
    return `state-list:${encodeURIComponent(namespace)}`;
}

function parseCached<T>(value: string | null): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

function tableFor(namespace: string): StateTable {
    if (namespace.startsWith('preset:')) {
        return {
            table: 'presets',
            keyColumn: 'name',
            valueColumn: 'value_json',
            discriminatorColumn: 'kind',
            discriminator: namespace.slice('preset:'.length),
        };
    }
    switch (namespace) {
        case 'settings_snapshot': return { table: 'settings_snapshots', keyColumn: 'name', valueColumn: 'value_json' };
        case 'theme': return { table: 'themes', keyColumn: 'name', valueColumn: 'value_json' };
        case 'world': return { table: 'world_books', keyColumn: 'id', valueColumn: 'value_json' };
        case 'character': return { table: 'characters', keyColumn: 'avatar', valueColumn: 'card_json' };
        case 'group': return { table: 'groups', keyColumn: 'id', valueColumn: 'value_json' };
        case 'stats': return { table: 'app_stats', keyColumn: 'key', valueColumn: 'value_json' };
        case 'settings':
        case 'system':
        case 'image-metadata':
        case 'hidden-background':
            return {
                table: 'settings',
                keyColumn: 'key',
                valueColumn: 'value_json',
                discriminatorColumn: 'section',
                discriminator: namespace,
            };
        default:
            throw new Error(`Unsupported core state namespace: ${namespace}`);
    }
}

function decodeState<T>(row: StateRow): StateRecord<T> {
    const value = row.value_type === 'text' ? row.value : JSON.parse(row.value) as T;
    return {
        namespace: row.namespace,
        key: row.key,
        value: value as T,
        etag: row.etag,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function selectSql(namespace: string, table: StateTable, withKey: boolean): { sql: string; bindings: string[] } {
    const conditions: string[] = [];
    const bindings: string[] = [namespace];
    if (table.discriminatorColumn && table.discriminator !== undefined) {
        conditions.push(`${table.discriminatorColumn} = ?`);
        bindings.push(table.discriminator);
    }
    if (withKey) conditions.push(`${table.keyColumn} = ?`);
    return {
        sql: `
            SELECT ? AS namespace, ${table.keyColumn} AS key, ${table.valueColumn} AS value,
                   'json' AS value_type, etag, created_at, updated_at
            FROM ${table.table}
            ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
        `,
        bindings,
    };
}

export async function getState<T>(env: Env, namespace: string, key: string): Promise<StateRecord<T> | null> {
    if (isCacheable(namespace)) {
        const cached = parseCached<StateRecord<T>>(await env.CACHE.get(recordCacheKey(namespace, key)));
        if (cached) return cached;
    }
    const table = tableFor(namespace);
    const query = selectSql(namespace, table, true);
    const row = await env.DB.prepare(query.sql).bind(...query.bindings, key).first<StateRow>();
    const decoded = row ? decodeState<T>(row) : null;
    if (decoded && isCacheable(namespace)) {
        await env.CACHE.put(recordCacheKey(namespace, key), JSON.stringify(decoded), { expirationTtl: 3_600 });
    }
    return decoded;
}

export async function listState<T>(env: Env, namespace: string, limit = 500): Promise<StateRecord<T>[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    if (isCacheable(namespace)) {
        const cached = parseCached<StateRecord<T>[]>(await env.CACHE.get(listCacheKey(namespace)));
        if (cached) return cached.slice(0, boundedLimit);
    }
    const table = tableFor(namespace);
    const query = selectSql(namespace, table, false);
    const result = await env.DB.prepare(`${query.sql} ORDER BY ${table.keyColumn} LIMIT ?`)
        .bind(...query.bindings, 500).all<StateRow>();
    const decoded = result.results.map(row => decodeState<T>(row));
    if (isCacheable(namespace)) {
        await env.CACHE.put(listCacheKey(namespace), JSON.stringify(decoded), { expirationTtl: 900 });
    }
    return decoded.slice(0, boundedLimit);
}

async function invalidateNamespace(env: Env, namespace: string, key?: string): Promise<void> {
    const now = Date.now();
    await env.DB.prepare(`
        INSERT INTO cache_versions(namespace, version, updated_at) VALUES (?, 1, ?)
        ON CONFLICT(namespace) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at
    `).bind(namespace, now).run();
    await Promise.all([
        env.CACHE.delete(listCacheKey(namespace)),
        ...(key === undefined ? [] : [env.CACHE.delete(recordCacheKey(namespace, key))]),
        ...(namespace === 'settings' || namespace === 'theme' || namespace === 'world' || namespace.startsWith('preset:')
            ? [env.CACHE.delete(SETTINGS_VIEW_CACHE_KEY)]
            : []),
    ]);
}

export async function putState(
    env: Env,
    namespace: string,
    key: string,
    value: unknown,
    valueType: 'json' | 'text' = 'json',
): Promise<void> {
    const table = tableFor(namespace);
    const now = Date.now();
    const etag = crypto.randomUUID();
    const encoded = valueType === 'text' ? JSON.stringify(String(value)) : JSON.stringify(value);

    if (table.table === 'characters') {
        await env.DB.prepare(`
            INSERT INTO characters(id, avatar, card_json, etag, is_builtin_override, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(avatar) DO UPDATE SET card_json = excluded.card_json, etag = excluded.etag,
                is_builtin_override = 1, updated_at = excluded.updated_at
        `).bind(key, key, encoded, etag, now, now).run();
    } else if (table.discriminatorColumn && table.discriminator !== undefined) {
        await env.DB.prepare(`
            INSERT INTO ${table.table}(${table.discriminatorColumn}, ${table.keyColumn}, ${table.valueColumn}, etag, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(${table.discriminatorColumn}, ${table.keyColumn}) DO UPDATE SET
                ${table.valueColumn} = excluded.${table.valueColumn}, etag = excluded.etag, updated_at = excluded.updated_at
        `).bind(table.discriminator, key, encoded, etag, now, now).run();
    } else {
        await env.DB.prepare(`
            INSERT INTO ${table.table}(${table.keyColumn}, ${table.valueColumn}, etag, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(${table.keyColumn}) DO UPDATE SET
                ${table.valueColumn} = excluded.${table.valueColumn}, etag = excluded.etag, updated_at = excluded.updated_at
        `).bind(key, encoded, etag, now, now).run();
    }
    await invalidateNamespace(env, namespace, key);
}

export async function deleteState(env: Env, namespace: string, key: string): Promise<boolean> {
    const table = tableFor(namespace);
    const conditions = [`${table.keyColumn} = ?`];
    const bindings: string[] = [key];
    if (table.discriminatorColumn && table.discriminator !== undefined) {
        conditions.push(`${table.discriminatorColumn} = ?`);
        bindings.push(table.discriminator);
    }
    const result = await env.DB.prepare(`DELETE FROM ${table.table} WHERE ${conditions.join(' AND ')}`).bind(...bindings).run();
    if (Number(result.meta.changes ?? 0) > 0) await invalidateNamespace(env, namespace, key);
    return Number(result.meta.changes ?? 0) > 0;
}

export async function renameState(env: Env, namespace: string, oldKey: string, newKey: string): Promise<boolean> {
    const table = tableFor(namespace);
    const now = Date.now();
    const conditions = [`${table.keyColumn} = ?`];
    const bindings: string[] = [newKey, crypto.randomUUID(), String(now), oldKey];
    if (table.discriminatorColumn && table.discriminator !== undefined) {
        conditions.push(`${table.discriminatorColumn} = ?`);
        bindings.push(table.discriminator);
    }
    const additional = table.table === 'characters' ? ', id = ?' : '';
    if (additional) bindings.splice(1, 0, newKey);
    const result = await env.DB.prepare(`
        UPDATE ${table.table} SET ${table.keyColumn} = ?${additional}, etag = ?, updated_at = ?
        WHERE ${conditions.join(' AND ')}
    `).bind(...bindings).run();
    if (Number(result.meta.changes ?? 0) > 0) {
        await Promise.all([
            invalidateNamespace(env, namespace, oldKey),
            env.CACHE.delete(recordCacheKey(namespace, newKey)),
        ]);
    }
    return Number(result.meta.changes ?? 0) > 0;
}
