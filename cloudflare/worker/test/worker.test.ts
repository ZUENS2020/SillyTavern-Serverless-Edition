import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import initialSql from '../migrations/0001_initial.sql?raw';
import snapshotSql from '../migrations/0002_snapshot_metadata.sql?raw';
import externalExtensionsSql from '../migrations/0003_external_extensions.sql?raw';
import { normalizeOpenRouterCredits, normalizeOpenRouterModels } from '../src/routes/multimedia';
import { openRouterBody } from '../src/routes/providers';

function sqlQueries(source: string): string[] {
    return source.split(';').map(query => query.trim()).filter(Boolean);
}

async function request(path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const options: RequestInit = {
        ...init,
        method: init.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    return SELF.fetch(`https://example.test${path}`, options);
}

async function responseJson<T>(response: Response): Promise<T> {
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json<T>();
}

beforeAll(async () => {
    await applyD1Migrations(env.DB, [
        { name: '0001_initial.sql', queries: sqlQueries(initialSql) },
        { name: '0002_snapshot_metadata.sql', queries: sqlQueries(snapshotSql) },
        { name: '0003_external_extensions.sql', queries: sqlQueries(externalExtensionsSql) },
    ]);
});

describe('SillyTavern serverless Worker', () => {
    it('exposes the no-auth single-user shell and bundled extensions', async () => {
        const user = await responseJson<{ handle: string; admin: boolean }>(await request('/api/users/me'));
        expect(user).toMatchObject({ handle: 'default-user', admin: true });

        const extensions = await responseJson<Array<{ type: string; name: string }>>(await request('/api/extensions/discover'));
        expect(extensions).toContainEqual({ type: 'system', name: 'vectors' });
        const catalog = await responseJson<{
            runtimeInstallation: boolean;
            builtIn: Array<{ name: string; integration: string }>;
            externalApi: unknown[];
        }>(await request('/api/extensions/catalog'));
        expect(catalog.runtimeInstallation).toBe(false);
        expect(catalog.builtIn).toContainEqual(expect.objectContaining({ name: 'vectors', integration: 'external-api' }));
        expect(catalog.externalApi).toContainEqual(expect.objectContaining({ name: 'vectors', providers: ['qdrant', 'pinecone'] }));

        const version = await responseJson<{ pkgName: string; pkgVersion: string }>(await request('/version'));
        expect(version.pkgName).toBe('sillytavern-serverless-edition');
        expect(version.pkgVersion).toContain('serverless');
    });

    it('round-trips settings and keeps secrets masked', async () => {
        expect((await request('/api/settings/save', { theme: 'dark', amount_gen: 512 })).ok).toBe(true);
        const settings = await responseJson<{ settings: string }>(await request('/api/settings/get', {}));
        expect(JSON.parse(settings.settings)).toMatchObject({ theme: 'dark', amount_gen: 512 });

        const written = await responseJson<{ id: string }>(await request('/api/secrets/write', {
            key: 'api_key_openai', value: 'fake-openai-key-for-tests', label: 'test',
        }));
        expect(written.id).toBeTruthy();
        const secrets = await responseJson<Record<string, Array<{ value: string }>>>(await request('/api/secrets/read', {}));
        expect(secrets.api_key_openai?.[0]?.value).not.toBe('fake-openai-key-for-tests');
        const stored = await env.DB.prepare('SELECT value FROM secrets WHERE key = ?').bind('api_key_openai').first<{ value: string }>();
        expect(stored?.value).not.toContain('fake-openai-key-for-tests');
        expect(JSON.parse(stored?.value ?? '{}')).toMatchObject({ v: 1, alg: 'A256GCM' });

        const legacyValue = JSON.stringify([{ id: 'legacy', value: 'legacy-plaintext-key', label: 'legacy', active: true }]);
        await env.DB.prepare('INSERT INTO secrets(key, value, updated_at) VALUES (?, ?, ?)')
            .bind('api_key_groq', legacyValue, Date.now()).run();
        const migrated = await responseJson<Record<string, Array<{ id: string }>>>(await request('/api/secrets/read', {}));
        expect(migrated.api_key_groq).toContainEqual(expect.objectContaining({ id: 'legacy' }));
        const migratedRow = await env.DB.prepare('SELECT value FROM secrets WHERE key = ?').bind('api_key_groq').first<{ value: string }>();
        expect(migratedRow?.value).not.toContain('legacy-plaintext-key');
        expect(JSON.parse(migratedRow?.value ?? '{}')).toMatchObject({ v: 1, alg: 'A256GCM' });
        expect((await request('/api/secrets/view', {})).status).toBe(403);
    });

    it('covers settings snapshots, stats, singleton-user callbacks, and reset semantics', async () => {
        expect((await request('/api/ping', {})).status).toBe(204);
        expect(await responseJson<Array<{ handle: string }>>(await request('/api/users/get', {})))
            .toContainEqual(expect.objectContaining({ handle: 'default-user' }));
        for (const path of ['change-name', 'change-password', 'change-avatar']) {
            expect((await request(`/api/users/${path}`, {})).status).toBe(204);
        }

        expect((await request('/api/settings/save', { snapshot_marker: 'before' })).ok).toBe(true);
        expect((await request('/api/settings/make-snapshot', {})).status).toBe(204);
        const snapshots = await responseJson<Array<{ name: string; size: number }>>(await request('/api/settings/get-snapshots', {}));
        expect(snapshots[0]?.name).toMatch(/^settings_default-user_/u);
        expect(snapshots[0]?.size).toBeGreaterThan(0);
        const snapshotName = snapshots[0]?.name ?? '';
        expect(await responseJson<Record<string, unknown>>(await request('/api/settings/load-snapshot', { name: snapshotName })))
            .toMatchObject({ snapshot_marker: 'before' });

        expect((await request('/api/settings/save', { snapshot_marker: 'after' })).ok).toBe(true);
        expect((await request('/api/settings/restore-snapshot', { name: snapshotName })).status).toBe(204);
        const restored = await responseJson<{ settings: string }>(await request('/api/settings/get', {}));
        expect(JSON.parse(restored.settings)).toMatchObject({ snapshot_marker: 'before' });

        expect((await request('/api/stats/update', { chats: 3 })).ok).toBe(true);
        expect(await responseJson<Record<string, unknown>>(await request('/api/stats/get', {})))
            .toMatchObject({ chats: 3, timestamp: expect.any(Number) });
        expect((await request('/api/stats/recreate', {})).ok).toBe(true);
        expect(await responseJson<Record<string, unknown>>(await request('/api/stats/get', {})))
            .toEqual({ timestamp: expect.any(Number) });

        expect((await request('/api/moving-ui/save', { name: 'test-layout', panels: [] })).ok).toBe(true);
        const movingUi = await responseJson<{ movingUIPresets: Array<{ name: string }> }>(await request('/api/settings/get', {}));
        expect(movingUi.movingUIPresets).toContainEqual(expect.objectContaining({ name: 'test-layout' }));

        const callback = await request('/callback/openrouter?code=abc', undefined, { redirect: 'manual' });
        expect(callback.status).toBe(307);
        expect(callback.headers.get('location')).toContain('source=openrouter');
        expect(callback.headers.get('location')).toContain('query=code%3Dabc');
        const genericCallback = await request('/callback?state=xyz', undefined, { redirect: 'manual' });
        expect(genericCallback.status).toBe(307);
        expect(genericCallback.headers.get('location')).toContain('query=state%3Dxyz');

        expect((await request('/api/users/reset-settings', {})).status).toBe(204);
        const reset = await responseJson<{ settings: string }>(await request('/api/settings/get', {}));
        expect(JSON.parse(reset.settings)).not.toHaveProperty('snapshot_marker');
    });

    it('persists chats in R2, indexes them in D1, and archives revisions', async () => {
        const header = { user_name: 'User', character_name: 'Seraphina', chat_metadata: { integrity: 'one' } };
        const first = [header, { name: 'Seraphina', is_user: false, mes: 'Hello from R2', extra: {} }];
        expect((await request('/api/chats/save', { avatar_url: 'default_Seraphina.png', file_name: 'test-chat', chat: first })).ok).toBe(true);

        const loaded = await responseJson<unknown[]>(await request('/api/chats/get', { avatar_url: 'default_Seraphina.png', file_name: 'test-chat' }));
        expect(loaded).toEqual(first);

        const second = [{ ...header, chat_metadata: { integrity: 'one' } }, ...first.slice(1), { name: 'User', is_user: true, mes: 'Second revision', extra: {} }];
        expect((await request('/api/chats/save', { avatar_url: 'default_Seraphina.png', file_name: 'test-chat', chat: second })).ok).toBe(true);

        const backups = await responseJson<Array<{ file_name: string; chat_items: number }>>(await request('/api/backups/chat/get', {}));
        expect(backups[0]?.file_name).toMatch(/^chat_/u);
        expect(backups[0]?.chat_items).toBe(1);
    });

    it('imports, renames, exports, and deletes character and group chats', async () => {
        const importedChat = [
            { user_name: 'User', character_name: 'Importee', chat_metadata: {} },
            { name: 'Importee', is_user: false, mes: 'Imported hello', extra: {} },
        ];
        const characterForm = new FormData();
        characterForm.set('file_type', 'jsonl');
        characterForm.set('character_name', 'Importee');
        characterForm.set('avatar_url', 'Importee.png');
        characterForm.set('file', new File([importedChat.map(item => JSON.stringify(item)).join('\n')], 'chat.jsonl', { type: 'application/jsonl' }));
        const imported = await responseJson<{ fileNames: string[] }>(await SELF.fetch('https://example.test/api/chats/import', {
            method: 'POST', body: characterForm,
        }));
        const importedName = imported.fileNames[0]?.replace(/\.jsonl$/u, '') ?? '';
        expect(importedName).toContain('Importee');
        expect(await responseJson<unknown[]>(await request('/api/chats/get', {
            avatar_url: 'Importee.png', file_name: importedName,
        }))).toEqual(importedChat);

        const renamedName = 'renamed-imported-chat';
        expect(await responseJson<{ sanitizedFileName: string }>(await request('/api/chats/rename', {
            avatar_url: 'Importee.png', original_file: importedName, renamed_file: renamedName,
        }))).toMatchObject({ sanitizedFileName: renamedName });
        const textExport = await responseJson<{ result: string }>(await request('/api/chats/export', {
            avatar_url: 'Importee.png', file: renamedName, format: 'txt',
        }));
        expect(textExport.result).toContain('Importee: Imported hello');
        expect((await request('/api/chats/delete', { avatar_url: 'Importee.png', chatfile: renamedName })).ok).toBe(true);

        const groupForm = new FormData();
        groupForm.set('file_type', 'json');
        groupForm.set('file', new File([JSON.stringify(importedChat)], 'group.json', { type: 'application/json' }));
        const groupImported = await responseJson<{ res: string }>(await SELF.fetch('https://example.test/api/chats/group/import', {
            method: 'POST', body: groupForm,
        }));
        const renamedGroup = 'renamed-imported-group-chat';
        expect((await request('/api/chats/rename', {
            is_group: true, original_file: groupImported.res, renamed_file: renamedGroup,
        })).ok).toBe(true);
        expect(await responseJson<unknown[]>(await request('/api/chats/group/get', { id: renamedGroup }))).toEqual(importedChat);
        expect((await request('/api/chats/group/delete', { id: renamedGroup })).ok).toBe(true);
    });

    it('stores and streams user media without loading reads into Worker memory', async () => {
        const form = new FormData();
        form.append('image', new Blob(['hello'], { type: 'image/png' }), 'tiny.png');
        form.append('format', 'png');
        form.append('filename', 'tiny');
        form.append('ch_name', 'Seraphina');
        const uploaded = await responseJson<{ path: string }>(await SELF.fetch('https://example.test/api/images/upload', {
            method: 'POST', body: form,
        }));
        expect(uploaded.path).toBe('user/images/Seraphina/tiny.png');
        const served = await request('/user/images/Seraphina/tiny.png');
        expect(served.status).toBe(200);
        expect(served.headers.get('accept-ranges')).toBe('bytes');
        expect(new TextDecoder().decode(await served.arrayBuffer())).toBe('hello');
        const ranged = await request('/user/images/Seraphina/tiny.png', undefined, { headers: { range: 'bytes=1-3' } });
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get('content-range')).toBe('bytes 1-3/5');
        expect(new TextDecoder().decode(await ranged.arrayBuffer())).toBe('ell');

        const promoted = await request('/api/images/upload', {
            source: '/generated-media/generated.png', format: 'png', filename: 'promoted', ch_name: 'Seraphina',
        });
        expect(promoted.status).toBe(400);
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM objects WHERE kind = 'generated-media'").first<{ count: number }>()).toMatchObject({ count: 0 });
    });

    it('keeps local vector storage and expression classification disabled', async () => {
        await expect(env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vectors'").first()).resolves.toBeNull();
        expect((await request('/api/classify', { text: 'I am so happy, thank you!' })).status).toBe(422);
        expect((await request('/api/sd/comfy/save-workflow', { file_name: 'custom.json', workflow: '{}' })).status).toBe(422);
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM app_state WHERE namespace = 'comfy-workflow'").first<{ count: number }>()).toMatchObject({ count: 0 });
    });

    it('uses Qdrant Cloud inference for vector lifecycle and batch retrieval', async () => {
        const connection = {
            provider: 'qdrant', endpoint: 'https://unit-test.qdrant.io', collection: 'sillytavern',
            namespace: 'tests', model: 'sentence-transformers/all-MiniLM-L6-v2',
        };
        expect((await request('/api/vector/test', { connection })).status).toBe(400);
        await responseJson(await request('/api/secrets/write', { key: 'api_key_qdrant', value: 'qdrant-test-key', label: 'test' }));

        const outbound: Array<{ method: string; path: string; body: string }> = [];
        let collectionReads = 0;
        const externalFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = String(init?.method ?? 'GET').toUpperCase();
            const body = typeof init?.body === 'string' ? init.body : '';
            outbound.push({ method, path: `${url.pathname}${url.search}`, body });
            const headers = { 'content-type': 'application/json' };
            if (url.pathname === '/collections/sillytavern' && method === 'GET') {
                collectionReads += 1;
                if (collectionReads <= 2) return new Response(JSON.stringify({ status: 'not found' }), { status: 404, headers });
            }
            if (url.pathname.endsWith('/points/scroll')) {
                return new Response(JSON.stringify({ result: { points: [{ payload: { st_hash: 11 } }], next_page_offset: null } }), { headers });
            }
            if (url.pathname.endsWith('/points/query/batch')) {
                return new Response(JSON.stringify({ result: [
                    { points: [{ score: 0.91, payload: { st_hash: 11, st_index: 2, chunk_text: 'tea memory' } }] },
                    { points: [{ score: 0.82, payload: { st_hash: 22, st_index: 3, chunk_text: 'world entry' } }] },
                ] }), { headers });
            }
            if (url.pathname.endsWith('/points/query')) {
                return new Response(JSON.stringify({ result: { points: [{ score: 0.91, payload: { st_hash: 11, st_index: 2, chunk_text: 'tea memory' } }] } }), { headers });
            }
            return new Response(JSON.stringify({ result: { status: 'ok' } }), { headers });
        });
        vi.stubGlobal('fetch', externalFetch);
        try {
            expect(await responseJson(await request('/api/vector/test', { connection }))).toMatchObject({ ok: true, provider: 'qdrant', initialized: false });
            expect(await responseJson(await request('/api/vector/initialize', { connection }))).toMatchObject({ initialized: true, created: true });
            expect((await request('/api/vector/insert', {
                connection, collectionId: 'chat-test', items: [{ id: '01234567-89ab-cdef-0123-456789abcdef', hash: 11, text: 'tea memory', index: 2 }],
            })).status).toBe(200);
            expect(await responseJson(await request('/api/vector/list', { connection, collectionId: 'chat-test' })))
                .toEqual({ hashes: [11], cursor: null });
            expect(await responseJson(await request('/api/vector/query', {
                connection, collectionId: 'chat-test', searchText: 'tea', topK: 3,
            }))).toMatchObject({ hashes: [11], scores: [0.91] });
            expect(await responseJson(await request('/api/vector/query-multi', {
                connection, collectionIds: ['chat-test', 'world-test'], searchText: 'tea', topK: 3,
            }))).toMatchObject({ 'chat-test': { hashes: [11] }, 'world-test': { hashes: [22] } });
            expect((await request('/api/vector/delete', { connection, collectionId: 'chat-test', hashes: [11] })).status).toBe(200);
            expect((await request('/api/vector/purge', { connection, collectionId: 'chat-test' })).status).toBe(200);
            expect((await request('/api/vector/purge-all', { connection })).status).toBe(200);
            expect((await request('/api/vector/list', { connection, collectionId: 'chat-test', cursor: 'not-base64!' })).status).toBe(400);
            expect((await request('/api/vector/query', { connection, collectionId: 'chat-test', searchText: 'tea', topK: 21 })).status).toBe(413);

            const insert = outbound.find(item => item.path.includes('/points?wait=true'));
            expect(JSON.parse(insert?.body ?? '{}').points[0]).toMatchObject({
                vector: { text: 'tea memory', model: connection.model },
                payload: { st_namespace: 'tests', st_collection: 'chat-test', st_hash: 11 },
            });
            expect(insert?.body).not.toMatch(/"embedding"\s*:/u);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('uses Pinecone integrated embedding and enforces vector request bounds', async () => {
        const connection = { provider: 'pinecone', host: 'https://unit-test.pinecone.io', namespace: 'tests' };
        await responseJson(await request('/api/secrets/write', { key: 'api_key_pinecone', value: 'pinecone-test-key', label: 'test' }));
        const outbound: Array<{ method: string; path: string; body: string }> = [];
        const externalFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = String(init?.method ?? 'GET').toUpperCase();
            const body = typeof init?.body === 'string' ? init.body : '';
            outbound.push({ method, path: `${url.pathname}${url.search}`, body });
            if (url.pathname.endsWith('/search')) {
                return new Response(JSON.stringify({ result: { hits: [{ _score: 0.88, fields: { st_hash: 31, st_index: 4, chunk_text: 'data bank note' } }] } }), { headers: { 'content-type': 'application/json' } });
            }
            if (url.pathname === '/vectors/fetch_by_metadata') {
                return new Response(JSON.stringify({ vectors: { '997c6611-d470-8f98-b9a3-73821ba537e8': { metadata: { st_hash: 31 } } }, pagination: {} }), { headers: { 'content-type': 'application/json' } });
            }
            if (url.pathname.endsWith('/upsert') || url.pathname === '/vectors/delete') return new Response(null, { status: 200 });
            return new Response(JSON.stringify({ namespaces: [] }), { headers: { 'content-type': 'application/json' } });
        });
        vi.stubGlobal('fetch', externalFetch);
        try {
            expect(await responseJson(await request('/api/vector/test', { connection }))).toMatchObject({ ok: true, provider: 'pinecone' });
            expect((await request('/api/vector/insert', {
                connection, collectionId: 'data-bank', items: [{ id: '997c6611-d470-8f98-b9a3-73821ba537e8', hash: 31, text: 'data bank note', index: 4 }],
            })).status).toBe(200);
            expect(await responseJson(await request('/api/vector/list', {
                connection, collectionId: 'data-bank',
            }))).toEqual({ hashes: [31], cursor: null });
            expect(await responseJson(await request('/api/vector/query', {
                connection, collectionId: 'data-bank', searchText: 'note', topK: 20,
            }))).toMatchObject({ hashes: [31], scores: [0.88] });
            expect((await request('/api/vector/delete', {
                connection, collectionId: 'data-bank', hashes: [31], ids: ['997c6611-d470-8f98-b9a3-73821ba537e8'],
            })).status).toBe(200);
            expect((await request('/api/vector/purge-all', { connection })).status).toBe(200);

            const upsert = outbound.find(item => item.path.endsWith('/upsert'));
            expect(JSON.parse(upsert?.body.trim() ?? '{}')).toMatchObject({ chunk_text: 'data bank note', st_collection: 'data-bank' });
            expect((await request('/api/vector/insert', {
                connection, collectionId: 'too-many', items: Array.from({ length: 9 }, (_, index) => ({ id: `item-${index}`, hash: index, text: 'x' })),
            })).status).toBe(413);
            expect((await request('/api/vector/query-multi', {
                connection, collectionIds: Array.from({ length: 9 }, (_, index) => `collection-${index}`), searchText: 'x',
            })).status).toBe(413);
            expect((await request('/api/vector/query', { connection, collectionId: 'bad', searchText: 'x', topK: 21 })).status).toBe(413);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('maps vector provider network and timeout failures without leaking request content', async () => {
        const connection = {
            provider: 'qdrant', endpoint: 'https://unit-test.qdrant.io', collection: 'sillytavern',
            namespace: 'tests', model: 'sentence-transformers/all-MiniLM-L6-v2',
        };
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('provider unavailable'); }));
        try {
            expect((await request('/api/vector/test', { connection })).status).toBe(502);
        } finally {
            vi.unstubAllGlobals();
        }
        vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
        try {
            expect((await request('/api/vector/test', { connection })).status).toBe(504);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('keeps AI Horde image and caption polling in the browser', async () => {
        const paths: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            paths.push(url.pathname);
            const headers = { 'content-type': 'application/json' };
            if (url.pathname === '/api/v2/generate/async') return new Response(JSON.stringify({ id: 'image-job' }), { headers });
            if (url.pathname === '/api/v2/generate/check/image-job') return new Response(JSON.stringify({ done: false }), { headers });
            if (url.pathname === '/api/v2/generate/status/image-job') return new Response(JSON.stringify({ generations: [{ img: 'https://cdn.example/image.webp' }] }), { headers });
            if (url.pathname === '/api/v2/interrogate/async') return new Response(JSON.stringify({ id: 'caption-job' }), { headers });
            if (url.pathname === '/api/v2/interrogate/status/caption-job') return new Response(JSON.stringify({ state: 'done', forms: [{ result: { caption: 'A test image' } }] }), { headers });
            return new Response('{}', { status: 404, headers });
        }));
        try {
            expect(await responseJson(await request('/api/horde/generate-image', { action: 'submit', prompt: 'tea', model: 'model' })))
                .toEqual({ status: 'submitted', jobId: 'image-job' });
            expect((await request('/api/horde/generate-image', { action: 'status', jobId: 'image-job' })).status).toBe(202);
            expect(await responseJson(await request('/api/horde/generate-image', { action: 'result', jobId: 'image-job' })))
                .toMatchObject({ status: 'complete', image: 'https://cdn.example/image.webp' });
            expect(await responseJson(await request('/api/horde/caption-image', { action: 'submit', image: 'aGVsbG8=' })))
                .toEqual({ status: 'submitted', jobId: 'caption-job' });
            expect(await responseJson(await request('/api/horde/caption-image', { action: 'status', jobId: 'caption-job' })))
                .toMatchObject({ status: 'complete', caption: 'A test image' });
            expect(paths).toHaveLength(5);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('blocks private-network proxy targets', async () => {
        const response = await request('/api/backends/text-completions/status', {
            api_type: 'generic', api_server: 'http://127.0.0.1:5000',
        });
        expect(response.status).toBe(400);
        expect(await response.json<{ error: string }>()).toMatchObject({ error: expect.stringContaining('public HTTPS') });
    });

    it('normalizes current OpenRouter request and response contracts', () => {
        const outbound = openRouterBody({
            model: 'openrouter/free',
            messages: [{ role: 'user', content: 'Hello' }],
            provider: ['Cloudflare'],
            quantizations: ['fp8'],
            allow_fallbacks: false,
            middleout: 'on',
            include_reasoning: false,
            reasoning_effort: 'medium',
            enable_web_search: true,
        });
        expect(outbound).toMatchObject({
            model: 'openrouter/free',
            transforms: ['middle-out'],
            plugins: [{ id: 'web' }],
            reasoning: { exclude: true, effort: 'medium' },
            provider: { allow_fallbacks: false, order: ['Cloudflare'], quantizations: ['fp8'] },
        });
        expect(outbound).not.toHaveProperty('include_reasoning');

        expect(normalizeOpenRouterModels({ data: { endpoints: [
            { provider_name: 'A' }, { provider_name: 'A' }, { provider_name: 'B' },
        ] } }, 'providers')).toEqual(['A', 'B']);

        const models = { data: [
            { id: 'vision', name: 'Vision', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
            { id: 'embed', name: 'Embed', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
            { id: 'image', name: 'Image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
        ] };
        expect(normalizeOpenRouterModels(models, 'multimodal')).toEqual(['vision']);
        expect(normalizeOpenRouterModels(models, 'embedding')).toEqual([{ id: 'embed', name: 'Embed' }]);
        expect(normalizeOpenRouterModels(models, 'image')).toEqual([{ value: 'image', text: 'Image' }]);
        expect(normalizeOpenRouterCredits({ data: { total_credits: 10, total_usage: 3 } })).toEqual({
            remaining: 7, total_credits: 10, total_usage: 3,
        });
    });

    it('keeps singleton-account and free-CPU compatibility routes explicit', async () => {
        expect(await (await request('/api/users/slugify', { text: 'Crème Brûlée' })).text()).toBe('creme-brulee');
        expect((await request('/api/users/create', { handle: 'second', name: 'Second' })).status).toBe(409);

        const report = await responseJson<{ report: { images: unknown[] }; token: string }>(await request('/api/data-maid/report', {}));
        expect(report.report.images).toEqual([]);
        expect(report.token).toBeTruthy();
        expect((await request('/api/data-maid/finalize', { token: report.token })).status).toBe(204);
        expect((await request('/api/data-maid/delete', { token: report.token, files: [] })).status).toBe(204);
        expect((await request('/api/data-maid/view?hash=missing', undefined, { method: 'GET' })).status).toBe(404);

        expect((await request('/api/content/importURL', { url: 'http://127.0.0.1/card.png' })).status).toBe(400);
        expect((await request('/api/content/importURL', { url: 'https://example.com/card.png' })).status).toBe(404);
        expect((await request('/api/content/importUUID', { url: 'not-a-supported-id' })).status).toBe(404);

        const localTts = await request('/api/text-to-speech/coqui/generate-tts', {});
        expect(localTts.status).toBe(422);
        expect(await localTts.json<{ error: string }>()).toMatchObject({ error: expect.stringContaining('free-CPU') });

        const embedding = await request('/api/backends/kobold/embed', {
            server: 'https://127.0.0.1', items: ['blocked before fetch'],
        });
        expect(embedding.status).toBe(400);
    });

    it('serves bundled ComfyUI workflows without extension-owned D1 state', async () => {
        const defaults = await responseJson<string[]>(await request('/api/sd/comfy/workflows', {}));
        expect(defaults).toContain('Default_Comfy_Workflow.json');
        expect(defaults).toContain('Char_Avatar_Comfy_Workflow.json');
        expect((await request('/api/sd/comfy/workflow', { file_name: 'Custom.json' })).status).toBe(404);
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM app_state WHERE namespace = 'comfy-workflow'").first<{ count: number }>()).toMatchObject({ count: 0 });
    });
});
