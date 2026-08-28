import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import initialSql from '../../migrations/0001_single_instance.sql?raw';
import { HttpError } from '../../src/worker/http';
import { registeredRoutes } from '../../src/worker/index';
import { invokeCapability } from '../../src/worker/routes/ai';
import { requireAccess, verifyAccessJwt } from '../../src/worker/security/access';
import { validateRequestBoundary } from '../../src/worker/security/request';
import { MAINTENANCE_MAX_BATCH_STEPS } from '../../src/worker/workflows/maintenance';

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
    return SELF.fetch(`https://sillytavern.test${path}`, options);
}

async function responseJson<T>(response: Response): Promise<T> {
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json<T>();
}

async function vectorId(collection: string, hash: number): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${collection}\0${hash}`));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
    await applyD1Migrations(env.DB, [{ name: '0001_single_instance.sql', queries: sqlQueries(initialSql) }]);
});

describe('Cloudflare Access boundary', () => {
    it('rejects requests without an Access assertion outside the test bypass', async () => {
        const boundaryEnv = {
            ACCESS_TEAM_DOMAIN: 'https://sillytavern-test.cloudflareaccess.com',
            ACCESS_AUD: 'test-audience',
            TEST_BYPASS_ACCESS: 'false',
        } as unknown as Env;
        await expect(requireAccess(new Request('https://sillytavern.example/api/ping'), boundaryEnv))
            .rejects.toMatchObject({ status: 403 });
    });

    it('verifies signature, issuer, audience and expiry', async () => {
        const { publicKey, privateKey } = await generateKeyPair('RS256');
        const jwk = await exportJWK(publicKey);
        jwk.kid = 'test-key';
        const keys = createLocalJWKSet({ keys: [jwk] });
        const issuer = 'https://sillytavern-test.cloudflareaccess.com';
        const sign = (audience: string, tokenIssuer = issuer, expires = '5 minutes') => new SignJWT({ sub: 'opaque-access-subject' })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuedAt()
            .setIssuer(tokenIssuer)
            .setAudience(audience)
            .setExpirationTime(expires)
            .sign(privateKey);

        const valid = await verifyAccessJwt(await sign('test-audience'), { issuer, audience: 'test-audience' }, keys);
        expect(valid.subject).toBe('opaque-access-subject');
        expect(valid.diagnosticId).toMatch(/^[a-f0-9]{24}$/u);

        const serviceToken = await new SignJWT({ sub: '', common_name: 'service-client-id' })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuedAt()
            .setIssuer(issuer)
            .setAudience('test-audience')
            .setExpirationTime('5 minutes')
            .sign(privateKey);
        const serviceIdentity = await verifyAccessJwt(serviceToken, { issuer, audience: 'test-audience' }, keys);
        expect(serviceIdentity.subject).toBe('service-token:service-client-id');
        expect(serviceIdentity.diagnosticId).toMatch(/^[a-f0-9]{24}$/u);

        for (const token of [
            await sign('wrong-audience'),
            await sign('test-audience', 'https://wrong.cloudflareaccess.com'),
            await sign('test-audience', issuer, '-1 minute'),
        ]) {
            await expect(verifyAccessJwt(token, { issuer, audience: 'test-audience' }, keys))
                .rejects.toMatchObject({ status: 403 });
        }
    });

    it('rejects cross-origin writes and mismatched hosts', () => {
        const boundaryEnv = {
            APP_ORIGIN: 'https://sillytavern.zuens2020.work',
            TEST_BYPASS_ACCESS: 'false',
        } as Env;
        const valid = new Request('https://sillytavern.zuens2020.work/api/ping', {
            method: 'POST',
            headers: { host: 'sillytavern.zuens2020.work', origin: 'https://sillytavern.zuens2020.work', 'sec-fetch-site': 'same-origin' },
        });
        expect(() => validateRequestBoundary(valid, boundaryEnv)).not.toThrow();
        const invalid = new Request(valid, { headers: { host: 'sillytavern.zuens2020.work', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
        expect(() => validateRequestBoundary(invalid, boundaryEnv)).toThrow(HttpError);
    });
});

describe('single-instance storage and routes', () => {
    it('has no account, session, secret or D1 embedding storage', async () => {
        const result = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
        const names = result.results.map(row => row.name);
        for (const forbidden of ['users', 'accounts', 'sessions', 'roles', 'permissions', 'secrets', 'vectors']) {
            expect(names).not.toContain(forbidden);
        }
        const vectorColumns = await env.DB.prepare('PRAGMA table_info(vector_manifest)').all<{ name: string }>();
        expect(vectorColumns.results.map(row => row.name)).not.toContain('embedding');
        expect((await request('/api/users/me')).status).toBe(404);
        expect((await request('/api/secrets/read', {})).status).toBe(404);
    });

    it('round-trips settings, worlds, groups and explicit group members', async () => {
        expect((await request('/api/settings/save', { theme: 'dark', amount_gen: 512 })).ok).toBe(true);
        const settings = await responseJson<{ settings: string }>(await request('/api/settings/get', {}));
        expect(JSON.parse(settings.settings)).toMatchObject({ theme: 'dark', amount_gen: 512 });

        expect((await request('/api/worldinfo/edit', { name: 'Tea', data: { entries: { 0: { content: 'oolong' } } } })).ok).toBe(true);
        expect(await responseJson<Record<string, unknown>>(await request('/api/worldinfo/get', { name: 'Tea' })))
            .toMatchObject({ entries: { 0: { content: 'oolong' } } });

        const group = await responseJson<{ id: string }>(await request('/api/groups/create', {
            name: 'Test', members: ['a.png', 'b.png'], disabled_members: ['b.png'],
        }));
        const members = await env.DB.prepare('SELECT character_avatar, disabled FROM group_members WHERE group_id = ? ORDER BY position')
            .bind(group.id).all<{ character_avatar: string; disabled: number }>();
        expect(members.results).toEqual([
            { character_avatar: 'a.png', disabled: 0 },
            { character_avatar: 'b.png', disabled: 1 },
        ]);
    });

    it('uses immutable R2 chat revisions and compare-and-swap', async () => {
        const first = [{ chat_metadata: {} }, { name: 'Seraphina', mes: 'First', is_user: false }];
        const saved = await responseJson<{ revision: number }>(await request('/api/chats/save', {
            avatar_url: 'default_Seraphina.png', file_name: 'cas-chat', chat: first, revision: 0,
        }));
        expect(saved.revision).toBe(1);
        const loaded = await request('/api/chats/get', { avatar_url: 'default_Seraphina.png', file_name: 'cas-chat' });
        expect(loaded.headers.get('x-chat-revision')).toBe('1');
        expect(await loaded.json()).toEqual(first);

        expect((await request('/api/chats/save', {
            avatar_url: 'default_Seraphina.png', file_name: 'cas-chat', chat: first, revision: 0,
        })).status).toBe(409);

        const second = [...first, { name: 'User', mes: 'Second', is_user: true }];
        const updated = await responseJson<{ revision: number }>(await request('/api/chats/save', {
            avatar_url: 'default_Seraphina.png', file_name: 'cas-chat', chat: second, revision: 1,
        }));
        expect(updated.revision).toBe(2);
        const revisions = await env.DB.prepare(`
            SELECT revision, r2_key FROM chat_revisions ORDER BY revision
        `).all<{ revision: number; r2_key: string }>();
        expect(revisions.results.map(row => row.revision)).toEqual([1, 2]);
        expect(revisions.results[0]?.r2_key).not.toBe(revisions.results[1]?.r2_key);
        const snapshot = await env.DB.prepare('SELECT chat_revision FROM snapshots').first<{ chat_revision: number }>();
        expect(snapshot?.chat_revision).toBe(1);
    });

    it('keeps runtime extension installation gone and exposes Gateway capabilities', async () => {
        const catalog = await responseJson<{
            runtimeInstallation: boolean;
            gatewayCapabilities: Array<{ name: string; integration: string }>;
        }>(await request('/api/extensions/catalog'));
        expect(catalog.runtimeInstallation).toBe(false);
        expect(catalog.gatewayCapabilities).toContainEqual(expect.objectContaining({ name: 'vectors', integration: 'gateway-capability' }));
        expect((await request('/api/extensions/install', {})).status).toBe(410);
        const paths = registeredRoutes().map(route => route.pattern);
        expect(paths.some(path => /openai|anthropic|google|openrouter|horde|ollama|kobold|comfy/iu.test(path))).toBe(false);
    });

    it('invalidates poisoned KV records after a D1 write', async () => {
        await env.CACHE.put('state:settings:current', JSON.stringify({
            namespace: 'settings', key: 'current', value: { poisoned: true }, etag: 'bad', createdAt: 0, updatedAt: 0,
        }));
        await request('/api/settings/save', { poisoned: false, source: 'd1' });
        const loaded = await responseJson<{ settings: string }>(await request('/api/settings/get', {}));
        expect(JSON.parse(loaded.settings)).toEqual({ poisoned: false, source: 'd1' });
        const version = await env.DB.prepare("SELECT version FROM cache_versions WHERE namespace = 'settings'")
            .first<{ version: number }>();
        expect(version?.version).toBeGreaterThan(0);
    });

    it('falls back to Static Assets for non-API GET requests only', async () => {
        const assets = vi.spyOn(env.ASSETS, 'fetch').mockResolvedValue(new Response(null, {
            status: 200,
            headers: { 'x-static-fallback': 'yes' },
        }));
        try {
            expect((await request('/not-a-real-static-file')).headers.get('x-static-fallback')).toBe('yes');
            expect(assets).toHaveBeenCalledOnce();
            expect((await request('/api/not-a-real-route')).status).toBe(404);
            expect(assets).toHaveBeenCalledOnce();
        } finally {
            assets.mockRestore();
        }
    });
});

describe('AI Gateway and Vectorize bindings', () => {
    it('routes configured capabilities through one AI binding with Gateway logging disabled', async () => {
        expect((await request('/api/ai/run/chat', { messages: [{ role: 'user', content: 'test' }] })).status).toBe(422);
        await responseJson(await request('/api/ai/capabilities/chat', {
            modelId: 'openai/gpt-5-mini', enabled: true, declarations: { streaming: true },
        }, { method: 'PUT' }));

        const run = vi.spyOn(env.AI, 'run').mockResolvedValue(new Response(null, {
            headers: { 'content-type': 'application/json' },
        }) as never);
        try {
            const response = await request('/api/ai/run/chat', {
                model: 'must-be-ignored', messages: [{ role: 'user', content: 'test' }], stream: false,
            });
            expect(response.status).toBe(200);
            expect(run).toHaveBeenCalledOnce();
            const [model, payload, options] = run.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>];
            expect(model).toBe('openai/gpt-5-mini');
            expect(payload).not.toHaveProperty('model');
            expect(options).toMatchObject({
                gateway: { id: 'sillytavern', collectLog: false, skipCache: true, metadata: { capability: 'chat' } },
                returnRawResponse: true,
            });
        } finally {
            run.mockRestore();
        }
    });

    it('embeds through AI Gateway, stores rebuild source in R2 and keeps embeddings out of D1', async () => {
        const aiRun = vi.spyOn(env.AI, 'run').mockResolvedValue({ data: [Array.from({ length: 1024 }, () => 0.01)] } as never);
        const upsert = vi.spyOn(env.VECTOR_INDEX, 'upsert').mockResolvedValue({ ids: [], count: 1 });
        const query = vi.spyOn(env.VECTOR_INDEX, 'query').mockResolvedValue({
            count: 1,
            matches: [{ id: await vectorId('world:tea', 42), score: 0.91, metadata: { hash: 42, collection_id: 'world:tea', source: 'world', schema_version: 1 } }],
        });
        try {
            const id = await vectorId('world:tea', 42);
            expect((await request('/api/vector/insert', {
                collectionId: 'world:tea', source: 'world', items: [{ id, hash: 42, text: 'oolong tea', index: 7 }],
            })).status).toBe(200);
            expect(upsert).toHaveBeenCalledOnce();
            const manifest = await env.DB.prepare('SELECT id, r2_source_key FROM vector_manifest WHERE id = ?')
                .bind(id).first<{ id: string; r2_source_key: string }>();
            expect(manifest?.r2_source_key).toBe(`vector-source/1/${id}.json`);
            expect(await env.BUCKET.get(manifest?.r2_source_key ?? '')).not.toBeNull();

            const result = await responseJson<{ hashes: number[] }>(await request('/api/vector/query', {
                collectionId: 'world:tea', searchText: 'tea', topK: 5,
            }));
            expect(result.hashes).toEqual([42]);
            expect(query).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
                filter: { collection_id: 'world:tea', schema_version: 1 },
            }));
            const aiOptions = aiRun.mock.calls[0]?.[2];
            expect(aiOptions).toMatchObject({ gateway: { id: 'sillytavern', collectLog: false } });
        } finally {
            aiRun.mockRestore();
            upsert.mockRestore();
            query.mockRestore();
        }
    });

    it('strips every client-supplied connection field and rejects invalid samplers', async () => {
        const run = vi.spyOn(env.AI, 'run').mockResolvedValue(new Response(null) as never);
        try {
            const response = await request('/api/ai/run/chat', {
                messages: [{ role: 'user', content: 'test' }],
                provider: 'forbidden', endpoint: 'https://example.com', api_key: 'secret', reverse_proxy: 'https://example.com',
                stream: false,
            });
            expect(response.status).toBe(200);
            const payload = run.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
            expect(payload).not.toHaveProperty('provider');
            expect(payload).not.toHaveProperty('endpoint');
            expect(payload).not.toHaveProperty('api_key');
            expect(payload).not.toHaveProperty('reverse_proxy');
            expect((await request('/api/ai/run/chat', {
                messages: [{ role: 'user', content: 'test' }], temperature: 99,
            })).status).toBe(400);
            expect(run).toHaveBeenCalledOnce();
        } finally {
            run.mockRestore();
        }
    });

    it('maps cancellation and Gateway quota failures without leaking error text', async () => {
        const controller = new AbortController();
        controller.abort();
        const abortedRequest = new Request('https://sillytavern.test/api/ai/run/chat', { signal: controller.signal });
        const abortRun = vi.spyOn(env.AI, 'run').mockRejectedValue(new DOMException('cancelled', 'AbortError'));
        try {
            await expect(invokeCapability({ env, request: abortedRequest }, 'chat', {
                messages: [{ role: 'user', content: 'cancel' }],
            })).rejects.toMatchObject({ status: 499 });
        } finally {
            abortRun.mockRestore();
        }

        const quota = new Error('sensitive upstream detail');
        quota.name = 'QuotaExceededError';
        const run = vi.spyOn(env.AI, 'run').mockRejectedValue(quota);
        try {
            await expect(invokeCapability({ env, request: new Request('https://sillytavern.test') }, 'chat', {
                messages: [{ role: 'user', content: 'quota' }],
            })).rejects.toMatchObject({ status: 429, message: 'AI Gateway limit reached' });
        } finally {
            run.mockRestore();
        }
    });

    it('rejects oversized vector batches before invoking AI', async () => {
        const run = vi.spyOn(env.AI, 'run');
        const items = await Promise.all([1, 2, 3, 4, 5].map(async hash => ({
            id: await vectorId('world:limit', hash), hash, text: 'x', index: hash,
        })));
        expect((await request('/api/vector/insert', { collectionId: 'world:limit', source: 'world', items })).status).toBe(413);
        expect((await request('/api/vector/query', { collectionId: 'world:limit', searchText: 'x', topK: 21 })).status).toBe(413);
        expect(run).not.toHaveBeenCalled();
        run.mockRestore();
    });

    it('rejects embedding dimensions that do not match the fixed schema', async () => {
        const run = vi.spyOn(env.AI, 'run').mockResolvedValue({ data: [[0.1, 0.2]] } as never);
        try {
            const hash = 9001;
            expect((await request('/api/vector/insert', {
                collectionId: 'world:dimension', source: 'world',
                items: [{ id: await vectorId('world:dimension', hash), hash, text: 'dimension mismatch' }],
            })).status).toBe(502);
            expect(await env.DB.prepare("SELECT id FROM vector_manifest WHERE collection_id = 'world:dimension'").first()).toBeNull();
        } finally {
            run.mockRestore();
        }
    });

    it('queries up to eight collections with one embedding and one Vectorize lookup', async () => {
        const aiRun = vi.spyOn(env.AI, 'run').mockResolvedValue({ data: [Array.from({ length: 1024 }, () => 0.02)] } as never);
        const query = vi.spyOn(env.VECTOR_INDEX, 'query').mockResolvedValue({
            count: 2,
            matches: [
                { id: 'a', score: 0.9, metadata: { hash: 1, collection_id: 'world:a', source: 'world', schema_version: 1 } },
                { id: 'b', score: 0.8, metadata: { hash: 2, collection_id: 'chat:b', source: 'chat', schema_version: 1 } },
            ],
        });
        try {
            const result = await responseJson<Record<string, { hashes: number[] }>>(await request('/api/vector/query-multi', {
                collectionIds: ['world:a', 'chat:b'], searchText: 'recall', topK: 5,
            }));
            expect(result['world:a']?.hashes).toEqual([1]);
            expect(result['chat:b']?.hashes).toEqual([2]);
            expect(aiRun).toHaveBeenCalledOnce();
            expect(query).toHaveBeenCalledOnce();
            expect(query).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
                filter: { collection_id: { $in: ['world:a', 'chat:b'] }, schema_version: 1 },
            }));
        } finally {
            aiRun.mockRestore();
            query.mockRestore();
        }
    });

    it('paginates vector manifests at 256 entries', async () => {
        await env.DB.prepare(`
            WITH RECURSIVE counter(value) AS (
                SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 257
            )
            INSERT INTO vector_manifest(id, hash, collection_id, source, schema_version, r2_source_key, metadata_json, created_at, updated_at)
            SELECT printf('%064x', value), value, 'world:page', 'world', 1,
                   'vector-source/1/page-' || value || '.json', '{}', 1, 1 FROM counter
        `).run();
        const first = await responseJson<{ hashes: number[]; cursor: string }>(await request('/api/vector/list', { collectionId: 'world:page' }));
        expect(first.hashes).toHaveLength(256);
        expect(first.cursor).toBeTruthy();
        const second = await responseJson<{ hashes: number[]; cursor: null }>(await request('/api/vector/list', {
            collectionId: 'world:page', cursor: first.cursor,
        }));
        expect(second.hashes).toEqual([257]);
        expect(second.cursor).toBeNull();
    });
});

describe('maintenance job contract', () => {
    it('stays below the Workers Free per-instance step ceiling', () => {
        expect(MAINTENANCE_MAX_BATCH_STEPS).toBeLessThanOrEqual(1_018);
    });

    it('allows only one active large job and supports cancellation', async () => {
        const create = vi.spyOn(env.MAINTENANCE, 'create').mockResolvedValue({} as never);
        const terminate = vi.fn().mockResolvedValue(undefined);
        const get = vi.spyOn(env.MAINTENANCE, 'get').mockResolvedValue({ terminate } as never);
        try {
            const started = await responseJson<{ id: string; status: string }>(await request('/api/jobs', { type: 'backup', params: {} }));
            expect(started.status).toBe('queued');
            expect((await request('/api/jobs', { type: 'r2-gc', params: {} })).status).toBe(409);
            const cancelled = await responseJson<{ status: string }>(await request(`/api/jobs/${started.id}/cancel`, {}));
            expect(cancelled.status).toBe('cancelled');
            expect(get).toHaveBeenCalledWith(started.id);
            expect(terminate).toHaveBeenCalledOnce();
        } finally {
            create.mockRestore();
            get.mockRestore();
        }
    });
});
