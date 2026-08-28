function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text ?? '').join('');
    return '';
}

export class AiCapabilityError extends Error {
    constructor(message, { status, code, capability } = {}) {
        super(message);
        this.name = 'AiCapabilityError';
        this.status = status;
        this.code = code;
        this.capability = capability;
    }
}

export function extractAiText(data) {
    if (typeof data === 'string') return data;
    if (!data || typeof data !== 'object') return '';
    return textFromContent(data.choices?.[0]?.message?.content)
        || textFromContent(data.choices?.[0]?.text)
        || textFromContent(data.response)
        || textFromContent(data.result)
        || textFromContent(data.output_text)
        || textFromContent(data.description)
        || textFromContent(data.translated_text)
        || textFromContent(data.translation);
}

export async function runAiCapability(capability, payload, { raw = false, signal } = {}) {
    const response = await fetch(`/api/ai/run/${encodeURIComponent(capability)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        signal,
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = detail?.error;
        const message = error?.message || error || `AI capability ${capability} failed (${response.status})`;
        throw new AiCapabilityError(String(message), {
            status: response.status,
            code: typeof error === 'object' && error !== null ? error.code : undefined,
            capability,
        });
    }
    if (raw) return response;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) return response.text();
    const data = await response.json();
    const text = extractAiText(data);
    return text || data;
}
