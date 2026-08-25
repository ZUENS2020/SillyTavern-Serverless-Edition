import { HttpError, json, maxJsonBytes, readJson, requireString } from '../http';
import type { Router } from '../router';
import { proxyResponse } from './providers';

type JsonObject = Record<string, unknown>;

interface Download {
    response: Response;
    fileName: string;
    contentType: 'character' | 'lorebook';
}

function objectValue(value: unknown): JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function cleanName(value: unknown, fallback = 'character'): string {
    const source = typeof value === 'string' && value.trim() ? value : fallback;
    const cleaned = source.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_').trim().slice(0, 120);
    return cleaned || fallback;
}

function attachment(download: Download): Response {
    const headers = new Headers(download.response.headers);
    headers.delete('set-cookie');
    headers.delete('content-length');
    headers.set('content-disposition', `attachment; filename="${download.fileName.replaceAll('"', '')}"`);
    headers.set('x-custom-content-type', download.contentType);
    headers.set('cache-control', 'no-store');
    return new Response(download.response.body, { status: download.response.status, headers });
}

async function chub(id: string, type: 'character' | 'lorebook', signal: AbortSignal): Promise<Download> {
    const segments = id.split('/').filter(Boolean).map(encodeURIComponent);
    if (segments.length < 2 || segments.length > 3) throw new HttpError(404, 'Invalid Chub content identifier');
    if (type === 'lorebook') {
        const path = segments[0] === 'lorebooks' ? segments : ['lorebooks', ...segments];
        const metadataResponse = await fetch(`https://api.chub.ai/api/${path.join('/')}`, { headers: { accept: 'application/json' }, signal });
        const metadata = objectValue(await metadataResponse.json().catch(() => ({})));
        if (!metadataResponse.ok) throw new HttpError(metadataResponse.status, 'Unable to read Chub lorebook');
        const node = objectValue(metadata.node);
        const projectId = typeof node.id === 'number' || typeof node.id === 'string' ? String(node.id) : '';
        if (!projectId) throw new HttpError(502, 'Chub lorebook metadata has no project ID');
        const response = await fetch(`https://api.chub.ai/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/raw%252Fsillytavern_raw.json/raw`, { signal });
        return { response, fileName: `${cleanName(path.at(-1), 'lorebook')}.json`, contentType: 'lorebook' };
    }
    const [creator = '', project = ''] = segments.slice(-2);
    const response = await fetch(`https://api.chub.ai/api/characters/${creator}/${project}?full=true`, { headers: { accept: 'application/json' }, signal });
    const metadata = objectValue(await response.json().catch(() => ({})));
    if (!response.ok) throw new HttpError(response.status, 'Unable to read Chub character');
    const node = objectValue(metadata.node);
    const definition = objectValue(node.definition);
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: definition.name ?? decodeURIComponent(project),
            description: definition.personality ?? '',
            personality: definition.tavern_personality ?? '',
            scenario: definition.scenario ?? '',
            first_mes: definition.first_message ?? '',
            mes_example: definition.example_dialogs ?? '',
            creator_notes: definition.description ?? '',
            system_prompt: definition.system_prompt ?? '',
            post_history_instructions: definition.post_history_instructions ?? '',
            alternate_greetings: Array.isArray(definition.alternate_greetings) ? definition.alternate_greetings : [],
            tags: Array.isArray(node.topics) ? node.topics : [],
            creator: decodeURIComponent(creator),
            character_version: '',
            character_book: definition.embedded_lorebook ?? undefined,
            extensions: objectValue(definition.extensions),
        },
    };
    const cardName = cleanName(definition.name, decodeURIComponent(project));
    return { response: json(card), fileName: `${cardName}.json`, contentType: 'character' };
}

function uuidFrom(source: string): string | null {
    return /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.exec(source)?.[0] ?? null;
}

async function pygmalion(id: string, signal: AbortSignal): Promise<Download> {
    if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new HttpError(404, 'Invalid Pygmalion character ID');
    const response = await fetch(`https://server.pygmalion.chat/api/export/character/${encodeURIComponent(id)}/v2`, { signal });
    return { response, fileName: `${id}.json`, contentType: 'character' };
}

async function janny(id: string, signal: AbortSignal): Promise<Download> {
    if (!/^[a-f0-9-]{8,64}$/iu.test(id)) throw new HttpError(404, 'Invalid Janitor character ID');
    const linkResponse = await fetch('https://api.jannyai.com/api/v1/download', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: id }), signal,
    });
    const data = objectValue(await linkResponse.json().catch(() => ({})));
    if (!linkResponse.ok || typeof data.downloadUrl !== 'string') throw new HttpError(linkResponse.status || 502, 'JanitorAI download failed');
    const downloadUrl = new URL(data.downloadUrl);
    if (downloadUrl.protocol !== 'https:' || !downloadUrl.hostname) throw new HttpError(502, 'JanitorAI returned an invalid download URL');
    const response = await fetch(downloadUrl, { signal });
    return { response, fileName: `${id}.png`, contentType: 'character' };
}

async function knownDirect(url: URL, signal: AbortSignal): Promise<Download> {
    const host = url.hostname.toLowerCase();
    if (host === 'aicharactercards.com' || host === 'www.aicharactercards.com') {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 2) throw new HttpError(404, 'Invalid AI Character Cards URL');
        const id = parts.slice(-2).map(encodeURIComponent).join('/');
        return { response: await fetch(`https://aicharactercards.com/wp-json/pngapi/v1/image/${id}`, { signal }), fileName: `${cleanName(parts.at(-1))}.png`, contentType: 'character' };
    }
    if (host === 'realm.risuai.net') {
        const id = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
        if (!/^[a-f0-9-]{32,80}$/iu.test(id)) throw new HttpError(404, 'Invalid RisuAI character ID');
        return { response: await fetch(`https://realm.risuai.net/api/v1/download/png-v3/${encodeURIComponent(id)}?non_commercial=true`, { signal }), fileName: `${id}.png`, contentType: 'character' };
    }
    throw new HttpError(404, 'Content source is not supported');
}

function parseChubUrl(url: URL): { id: string; type: 'character' | 'lorebook' } {
    const parts = url.pathname.split('/').filter(Boolean);
    const marker = parts[0]?.toLowerCase();
    if (marker === 'lorebooks') return { id: parts.join('/'), type: 'lorebook' };
    if (marker === 'characters') return { id: parts.slice(1).join('/'), type: 'character' };
    return { id: parts.slice(-2).join('/'), type: 'character' };
}

async function importUrl(source: string, signal: AbortSignal): Promise<Download> {
    let url: URL;
    try {
        url = new URL(source);
    } catch {
        throw new HttpError(400, 'Invalid content URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(400, 'Content URL must use public HTTPS');
    const host = url.hostname.toLowerCase();
    if (host === 'chub.ai' || host === 'www.chub.ai' || host === 'characterhub.org' || host === 'www.characterhub.org') {
        const parsed = parseChubUrl(url);
        return chub(parsed.id, parsed.type, signal);
    }
    if (host.includes('pygmalion.chat')) {
        const id = uuidFrom(source);
        if (!id) throw new HttpError(404, 'No character UUID in URL');
        return pygmalion(id, signal);
    }
    if (host.includes('janitorai')) {
        const id = uuidFrom(source);
        if (!id) throw new HttpError(404, 'No character UUID in URL');
        return janny(id, signal);
    }
    return knownDirect(url, signal);
}

async function importUuid(source: string, signal: AbortSignal): Promise<Download> {
    if (/^[a-f0-9-]{36}$/iu.test(source)) return pygmalion(source, signal);
    if (source.endsWith('_character')) return janny(source.slice(0, -10), signal);
    if (source.startsWith('AICC/')) {
        const path = source.slice(5).split('/').filter(Boolean);
        if (path.length !== 2) throw new HttpError(404, 'Invalid AICC identifier');
        const url = new URL(`https://aicharactercards.com/${path.map(encodeURIComponent).join('/')}`);
        return knownDirect(url, signal);
    }
    const type = source.includes('lorebook') ? 'lorebook' : 'character';
    return chub(source, type, signal);
}

export function registerContentRoutes(router: Router): void {
    router.on('POST', '/api/content/importURL', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const result = await importUrl(requireString(body.url, 'url', 2_048), request.signal);
        return attachment(result);
    });
    router.on('POST', '/api/content/importUUID', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const result = await importUuid(requireString(body.url, 'url', 512), request.signal);
        return attachment(result);
    });
}
