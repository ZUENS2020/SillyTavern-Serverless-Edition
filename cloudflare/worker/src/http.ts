export class HttpError extends Error {
    readonly status: number;
    readonly expose: boolean;

    constructor(status: number, message: string, expose = true) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.expose = expose;
    }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return new Response(JSON.stringify(data), { ...init, headers });
}

export function text(data: string, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response(data, { ...init, headers });
}

export function empty(status = 204, headers?: HeadersInit): Response {
    return new Response(null, headers === undefined ? { status } : { status, headers });
}

export async function readJsonValue(request: Request, maxBytes: number): Promise<unknown> {
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > maxBytes) throw new HttpError(413, `JSON payload exceeds ${maxBytes} bytes`);
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
        throw new HttpError(413, `JSON payload exceeds ${maxBytes} bytes`);
    }
    if (!body) return {};
    let value: unknown;
    try {
        value = JSON.parse(body);
    } catch {
        throw new HttpError(400, 'Invalid JSON payload');
    }
    return value;
}

export async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
    const value = await readJsonValue(request, maxBytes);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new HttpError(400, 'Expected a JSON object');
    }
    return value as Record<string, unknown>;
}

export async function readFormData(request: Request, maxBytes: number): Promise<FormData> {
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > maxBytes) throw new HttpError(413, `Upload exceeds ${maxBytes} bytes`);
    return request.formData();
}

export function requireString(value: unknown, field: string, maxLength = 512): string {
    if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `Missing ${field}`);
    if (value.length > maxLength) throw new HttpError(400, `${field} is too long`);
    return value;
}

export function optionalString(value: unknown, maxLength = 512): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > maxLength) throw new HttpError(400, 'Invalid string value');
    return value;
}

export function safeName(value: unknown, field = 'name', maxLength = 180): string {
    const name = requireString(value, field, maxLength).normalize('NFC').trim();
    if (!name || /[\\/\0\r\n]/u.test(name) || name === '.' || name === '..') {
        throw new HttpError(400, `Invalid ${field}`);
    }
    return name;
}

export function positiveInteger(value: string | null, fallback: number, maximum: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, maximum);
}

export function maxJsonBytes(env: Env): number {
    return positiveInteger(env.MAX_JSON_BYTES, 1_048_576, 4_194_304);
}

export function maxUploadBytes(env: Env): number {
    return positiveInteger(env.MAX_UPLOAD_BYTES, 26_214_400, 100_000_000);
}

export function withCors(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', '*');
    headers.set('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set('access-control-allow-headers', 'content-type, x-csrf-token, authorization, x-api-key');
    headers.set('access-control-expose-headers', 'content-length, content-disposition, etag, x-request-id');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
