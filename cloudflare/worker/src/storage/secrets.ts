export interface SecretValue {
    id: string;
    value: string;
    label: string;
    active: boolean;
}

interface SecretRow {
    value: string;
}

interface EncryptedEnvelope {
    v: 1;
    alg: 'A256GCM';
    iv: string;
    ciphertext: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Encode(value: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
    let binary: string;
    try {
        binary = atob(value);
    } catch {
        throw new Error('Invalid encrypted secret encoding');
    }
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
    return result;
}

function encryptionSecret(env: Env): string {
    const value: unknown = Reflect.get(env, 'SECRET_ENCRYPTION_KEY');
    if (typeof value !== 'string' || !value) {
        throw new Error('SECRET_ENCRYPTION_KEY is not configured');
    }
    return value;
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
    const raw = base64Decode(encryptionSecret(env));
    if (raw.byteLength !== 32) throw new Error('SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function encryptedEnvelope(value: unknown): value is EncryptedEnvelope {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.v === 1 && record.alg === 'A256GCM'
        && typeof record.iv === 'string' && typeof record.ciphertext === 'string';
}

async function encodeValues(env: Env, key: string, values: readonly SecretValue[]): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(key), tagLength: 128 },
        await encryptionKey(env),
        encoder.encode(JSON.stringify(values)),
    );
    return JSON.stringify({ v: 1, alg: 'A256GCM', iv: base64Encode(iv), ciphertext: base64Encode(ciphertext) } satisfies EncryptedEnvelope);
}

async function decodeValues(env: Env, key: string, stored: string): Promise<{ values: SecretValue[]; legacy: boolean }> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return { values: [], legacy: false };
    }
    if (Array.isArray(parsed)) return { values: parsed.filter(validSecret), legacy: true };
    if (!encryptedEnvelope(parsed)) return { values: [], legacy: false };
    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: base64Decode(parsed.iv), additionalData: encoder.encode(key), tagLength: 128 },
            await encryptionKey(env),
            base64Decode(parsed.ciphertext),
        );
        const values: unknown = JSON.parse(decoder.decode(plaintext));
        return { values: Array.isArray(values) ? values.filter(validSecret) : [], legacy: false };
    } catch {
        throw new Error(`Unable to decrypt secret row: ${key}`);
    }
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
    const decoded = await decodeValues(env, key, row.value);
    if (decoded.legacy) await saveSecretValues(env, key, decoded.values);
    return decoded.values;
}

export async function saveSecretValues(env: Env, key: string, values: readonly SecretValue[]): Promise<void> {
    if (values.length === 0) {
        await env.DB.prepare('DELETE FROM secrets WHERE key = ?').bind(key).run();
        return;
    }
    const encoded = await encodeValues(env, key, values);
    await env.DB.prepare(`
        INSERT INTO secrets(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(key, encoded, Date.now()).run();
}

export async function readSecret(env: Env, key: string, id?: string): Promise<string> {
    const values = await secretValues(env, key);
    return values.find(secret => id ? secret.id === id : secret.active)?.value ?? '';
}

export async function listSecretRows(env: Env): Promise<Array<{ key: string; values: SecretValue[] }>> {
    const rows = await env.DB.prepare('SELECT key, value FROM secrets ORDER BY key').all<{ key: string; value: string }>();
    const result: Array<{ key: string; values: SecretValue[] }> = [];
    for (const row of rows.results) {
        const decoded = await decodeValues(env, row.key, row.value);
        if (decoded.legacy) await saveSecretValues(env, row.key, decoded.values);
        result.push({ key: row.key, values: decoded.values });
    }
    return result;
}
