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

export async function getState<T>(env: Env, namespace: string, key: string): Promise<StateRecord<T> | null> {
    const row = await env.DB.prepare(
        'SELECT namespace, key, value, value_type, etag, created_at, updated_at FROM app_state WHERE namespace = ? AND key = ?',
    ).bind(namespace, key).first<StateRow>();
    return row ? decodeState<T>(row) : null;
}

export async function listState<T>(env: Env, namespace: string, limit = 500): Promise<StateRecord<T>[]> {
    const result = await env.DB.prepare(
        'SELECT namespace, key, value, value_type, etag, created_at, updated_at FROM app_state WHERE namespace = ? ORDER BY key LIMIT ?',
    ).bind(namespace, Math.min(Math.max(limit, 1), 500)).all<StateRow>();
    return result.results.map(row => decodeState<T>(row));
}

export async function putState(
    env: Env,
    namespace: string,
    key: string,
    value: unknown,
    valueType: 'json' | 'text' = 'json',
): Promise<StateRecord> {
    const now = Date.now();
    const etag = crypto.randomUUID();
    const encoded = valueType === 'text' ? String(value) : JSON.stringify(value);
    await env.DB.prepare(`
        INSERT INTO app_state(namespace, key, value, value_type, etag, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET
            value = excluded.value,
            value_type = excluded.value_type,
            etag = excluded.etag,
            updated_at = excluded.updated_at
    `).bind(namespace, key, encoded, valueType, etag, now, now).run();
    const stored = await getState(env, namespace, key);
    if (!stored) throw new Error('D1 state write did not persist');
    return stored;
}

export async function deleteState(env: Env, namespace: string, key: string): Promise<boolean> {
    const result = await env.DB.prepare(
        'DELETE FROM app_state WHERE namespace = ? AND key = ?',
    ).bind(namespace, key).run();
    return Number(result.meta.changes ?? 0) > 0;
}

export async function renameState(env: Env, namespace: string, oldKey: string, newKey: string): Promise<boolean> {
    const now = Date.now();
    const result = await env.DB.prepare(
        'UPDATE app_state SET key = ?, etag = ?, updated_at = ? WHERE namespace = ? AND key = ?',
    ).bind(newKey, crypto.randomUUID(), now, namespace, oldKey).run();
    return Number(result.meta.changes ?? 0) > 0;
}
