import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import initialSql from '../migrations/0001_initial.sql?raw';
import snapshotSql from '../migrations/0002_snapshot_metadata.sql?raw';
import { normalizeOpenRouterCredits, normalizeOpenRouterModels } from '../src/routes/multimedia';
import { openRouterBody } from '../src/routes/providers';
import { findObject, putObject } from '../src/storage/objects';

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
    ]);
});

describe('SillyTavern serverless Worker', () => {
    it('exposes the no-auth single-user shell and bundled extensions', async () => {
        const user = await responseJson<{ handle: string; admin: boolean }>(await request('/api/users/me'));
        expect(user).toMatchObject({ handle: 'default-user', admin: true });

        const extensions = await responseJson<Array<{ type: string; name: string }>>(await request('/api/extensions/discover'));
        expect(extensions).toContainEqual({ type: 'system', name: 'vectors' });

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
        expect((await request('/api/secrets/view', {})).status).toBe(403);
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
        expect(served.headers.get('accept-ranges')).toBe('bytes');
        expect(new TextDecoder().decode(await served.arrayBuffer())).toBe('hello');

        await putObject(env, 'generated-media', 'generated.png', new TextEncoder().encode('streamed'), {
            mimeType: 'image/png', byteLength: 8,
        });
        const promoted = await responseJson<{ path: string }>(await request('/api/images/upload', {
            source: '/generated-media/generated.png', format: 'png', filename: 'promoted', ch_name: 'Seraphina',
        }));
        expect(promoted.path).toBe('user/images/Seraphina/promoted.png');
        expect(await findObject(env, 'generated-media', 'generated.png')).toBeNull();
        expect(new TextDecoder().decode(await (await request('/user/images/Seraphina/promoted.png')).arrayBuffer())).toBe('streamed');
    });

    it('supports low-CPU vector retrieval and expression classification', async () => {
        expect((await request('/api/vector/insert', {
            collectionId: 'test', source: 'chat', items: [{ hash: 1, text: 'Seraphina likes tea', index: 0 }],
        })).ok).toBe(true);
        const result = await responseJson<{ hashes: number[]; metadata: unknown[] }>(await request('/api/vector/query', {
            collectionId: 'test', source: 'chat', searchText: 'tea', topK: 3,
        }));
        expect(result.hashes).toContain(1);

        const classified = await responseJson<{ classification: Array<{ label: string }> }>(await request('/api/classify', { text: 'I am so happy, thank you!' }));
        expect(classified.classification[0]?.label).toBe('joy');
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

        const localTts = await request('/api/text-to-speech/coqui/generate-tts', {});
        expect(localTts.status).toBe(422);
        expect(await localTts.json<{ error: string }>()).toMatchObject({ error: expect.stringContaining('free-CPU') });

        const embedding = await request('/api/backends/kobold/embed', {
            server: 'https://127.0.0.1', items: ['blocked before fetch'],
        });
        expect(embedding.status).toBe(400);
    });

    it('stores ComfyUI workflows in D1 while preserving bundled defaults', async () => {
        const defaults = await responseJson<string[]>(await request('/api/sd/comfy/workflows', {}));
        expect(defaults).toContain('Default_Comfy_Workflow.json');
        expect(defaults).toContain('Char_Avatar_Comfy_Workflow.json');

        const workflow = JSON.stringify({ 1: { class_type: 'KSampler', inputs: { seed: '"%seed%"' } } });
        const saved = await responseJson<string[]>(await request('/api/sd/comfy/save-workflow', {
            file_name: 'Custom.json', workflow,
        }));
        expect(saved).toContain('Custom.json');
        expect(await responseJson<string>(await request('/api/sd/comfy/workflow', { file_name: 'Custom.json' }))).toBe(workflow);

        expect((await request('/api/sd/comfy/rename-workflow', { old_name: 'Custom.json', new_name: 'Renamed.json' })).status).toBe(204);
        expect((await request('/api/sd/comfy/delete-workflow', { file_name: 'Renamed.json' })).ok).toBe(true);
    });
});
