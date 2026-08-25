export interface SecretValue {
    id: string;
    value: string;
    label: string;
    active: boolean;
}

interface SecretRow {
    value: string;
}

function validSecret(value: unknown): value is SecretValue {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string'
        && typeof record.value === 'string'
        && typeof record.label === 'string'
        && typeof record.active === 'boolean';
}

export async function secretValues(env: Env, key: string): Promise<SecretValue[]> {
    const row = await env.DB.prepare('SELECT value FROM secrets WHERE key = ?').bind(key).first<SecretRow>();
    if (!row) return [];
    try {
        const parsed: unknown = JSON.parse(row.value);
        return Array.isArray(parsed) ? parsed.filter(validSecret) : [];
    } catch {
        return [];
    }
}

export async function saveSecretValues(env: Env, key: string, values: readonly SecretValue[]): Promise<void> {
    if (values.length === 0) {
        await env.DB.prepare('DELETE FROM secrets WHERE key = ?').bind(key).run();
        return;
    }
    await env.DB.prepare(`
        INSERT INTO secrets(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(key, JSON.stringify(values), Date.now()).run();
}

export async function readSecret(env: Env, key: string, id?: string): Promise<string> {
    const values = await secretValues(env, key);
    return values.find(secret => id ? secret.id === id : secret.active)?.value ?? '';
}

export async function listSecretRows(env: Env): Promise<Array<{ key: string; values: SecretValue[] }>> {
    const rows = await env.DB.prepare('SELECT key, value FROM secrets ORDER BY key').all<{ key: string; value: string }>();
    return rows.results.map(row => {
        let values: SecretValue[] = [];
        try {
            const parsed: unknown = JSON.parse(row.value);
            if (Array.isArray(parsed)) values = parsed.filter(validSecret);
        } catch {
            // Preserve availability if one optional secret row is damaged.
        }
        return { key: row.key, values };
    });
}
