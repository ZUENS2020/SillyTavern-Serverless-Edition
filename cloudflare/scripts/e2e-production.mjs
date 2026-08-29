const baseUrl = new URL(process.env.SILLYTAVERN_E2E_URL ?? 'https://sillytavern.zuens2020.work');
const runId = process.env.SILLYTAVERN_E2E_RUN_ID ?? `e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const accessCookie = process.env.SILLYTAVERN_ACCESS_COOKIE ?? '';
const accessClientId = process.env.SILLYTAVERN_ACCESS_CLIENT_ID ?? '';
const accessClientSecret = process.env.SILLYTAVERN_ACCESS_CLIENT_SECRET ?? '';
const selectedSuites = new Set((process.env.SILLYTAVERN_E2E_ONLY ?? '')
    .split(',').map(value => value.trim()).filter(Boolean));
const cleanupTasks = [];
const results = [];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function cleanup(task) {
    cleanupTasks.push(task);
}

async function request(path, options = {}) {
    const url = new URL(path, baseUrl);
    const headers = new Headers(options.headers);
    if (accessCookie) headers.set('cookie', accessCookie.includes('=') ? accessCookie : `CF_Authorization=${accessCookie}`);
    if (accessClientId && accessClientSecret) {
        headers.set('cf-access-client-id', accessClientId);
        headers.set('cf-access-client-secret', accessClientSecret);
    }
    let body = options.body;
    if (options.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(options.json);
    }
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    if (method !== 'GET') {
        headers.set('origin', baseUrl.origin);
        headers.set('sec-fetch-site', 'same-origin');
    }
    const response = await fetch(url, {
        method,
        headers,
        body,
        redirect: options.redirect ?? 'manual',
        signal: AbortSignal.timeout(options.timeout ?? 60_000),
    });
    const type = response.headers.get('content-type') ?? '';
    const data = options.readBody === false
        ? null
        : type.includes('application/json') ? await response.json() : await response.text();
    const expected = options.expected ?? [200];
    if (!expected.includes(response.status)) {
        const detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
        throw new Error(`${options.method ?? (body === undefined ? 'GET' : 'POST')} ${path}: ${response.status} ${detail}`);
    }
    return { response, data };
}

async function test(name, task) {
    const started = performance.now();
    try {
        const detail = await task();
        results.push({ name, status: 'passed', durationMs: Math.round(performance.now() - started), detail });
        console.log(`PASS ${name}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ name, status: 'failed', durationMs: Math.round(performance.now() - started), error: message });
        console.error(`FAIL ${name}: ${message}`);
    }
}

async function deterministicVectorId(collectionId, hash) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${collectionId}\0${hash}`));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function systemSuite() {
    const root = await request('/');
    assert(typeof root.data === 'string' && root.data.includes('SillyTavern'), 'Static Assets shell is missing');
    const version = await request('/version');
    assert(version.data.pkgName === 'sillytavern-serverless-edition', 'Unexpected package name');
    assert((await request('/api/users/me', { expected: [404] })).response.status === 404, 'Account API still exists');
    assert((await request('/csrf-token', { expected: [404] })).response.status === 404, 'CSRF compatibility stub still exists');
    const catalog = await request('/api/extensions/catalog');
    assert(catalog.data.runtimeInstallation === false, 'Runtime extension installation is enabled');
    assert(catalog.data.deployTimeThirdParty === true, 'Deploy-time third-party loading is missing');
    assert(catalog.data.gatewayCapabilities.some(item => item.name === 'vectors'), 'Vectorize extension is missing');
    await request('/api/extensions/install', { json: {}, expected: [410] });
    const capabilities = await request('/api/ai/capabilities');
    assert(capabilities.data.gatewayId === 'sillytavern', 'Wrong AI Gateway');
    assert(capabilities.data.profiles.some(profile => profile.capability === 'embedding' && profile.fixed), 'Fixed embedding profile is missing');
    return { version: version.data.pkgVersion, capabilities: capabilities.data.profiles.length };
}

async function coreSuite() {
    await request('/api/settings/save', { json: { e2e_marker: runId, main_api: 'openai' } });
    const settings = await request('/api/settings/get', { json: {} });
    assert(JSON.parse(settings.data.settings).e2e_marker === runId, 'Settings did not round-trip');

    const worldName = `${runId}-world`;
    await request('/api/worldinfo/edit', { json: { name: worldName, data: { entries: { 0: { key: ['oolong'], content: `tea ${runId}` } } } } });
    cleanup(() => request('/api/worldinfo/delete', { json: { name: worldName }, expected: [200, 404] }));
    const world = await request('/api/worldinfo/get', { json: { name: worldName } });
    assert(world.data.entries?.[0]?.content === `tea ${runId}`, 'World book did not round-trip');

    const group = await request('/api/groups/create', { json: { name: runId, members: ['default_Seraphina.png'] } });
    cleanup(() => request('/api/groups/delete', { json: { id: group.data.id }, expected: [200, 404] }));
    assert(group.data.id, 'Group creation did not return an id');

    const chatName = `${runId}-chat`;
    const first = [{ chat_metadata: {} }, { name: 'Seraphina', mes: `first ${runId}`, is_user: false }];
    const saved = await request('/api/chats/save', { json: {
        avatar_url: 'default_Seraphina.png', file_name: chatName, chat: first, revision: 0,
    } });
    cleanup(() => request('/api/chats/delete', { json: { avatar_url: 'default_Seraphina.png', chatfile: chatName }, expected: [200, 404] }));
    assert(saved.data.revision === 1, 'First immutable chat revision was not created');
    await request('/api/chats/save', { json: {
        avatar_url: 'default_Seraphina.png', file_name: chatName, chat: first, revision: 0,
    }, expected: [409] });
    const loaded = await request('/api/chats/get', { json: { avatar_url: 'default_Seraphina.png', file_name: chatName } });
    assert(loaded.response.headers.get('x-chat-revision') === '1', 'Chat revision header is missing');
    assert(loaded.data[1]?.mes === `first ${runId}`, 'Chat body did not round-trip');
    return { worldName, groupId: group.data.id, chatName };
}

async function aiSuite() {
    const capabilities = await request('/api/ai/capabilities');
    const enabled = capabilities.data.profiles.filter(profile => profile.enabled && !profile.fixed);
    const tested = [];
    for (const profile of enabled) {
        await request('/api/ai/test', { json: { capability: profile.capability }, timeout: 90_000 });
        tested.push(profile.capability);
    }
    if (enabled.some(profile => profile.capability === 'chat')) {
        await request('/api/ai/run/chat', { json: { messages: [] }, expected: [400] });
        const streamed = await request('/api/ai/run/chat', {
            json: { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 8, stream: true },
            readBody: false,
            timeout: 90_000,
        });
        assert(streamed.response.body, 'Streaming chat returned no response body');
        const reader = streamed.response.body.getReader();
        const first = await reader.read();
        assert(!first.done && first.value?.byteLength > 0, 'Streaming chat returned no data');
        await reader.cancel('acceptance-stop');
        await request('/api/ai/test', { json: { capability: 'chat' }, timeout: 90_000 });
    }
    return { tested, streamingChat: tested.includes('chat') };
}

async function vectorSuite() {
    const baseHash = Date.now();
    const marker = `retrieval marker ${runId}`;
    const specifications = [
        { collectionId: `world:${runId}`, source: 'world', hash: baseHash, text: `oolong world book ${marker}` },
        { collectionId: `chat:${runId}`, source: 'chat', hash: baseHash + 1, text: `lighthouse chat history ${marker}` },
        { collectionId: `data-bank:${runId}`, source: 'data-bank', hash: baseHash + 2, text: `saffron attachment ${marker}` },
    ];
    for (const item of specifications) {
        cleanup(() => request('/api/vector/purge', { json: { collectionId: item.collectionId }, expected: [200, 204, 404] }));
        await request('/api/vector/insert', { json: {
            collectionId: item.collectionId,
            source: item.source,
            items: [{ id: await deterministicVectorId(item.collectionId, item.hash), hash: item.hash, text: item.text, index: 0 }],
        }, timeout: 90_000 });
        const listed = await request('/api/vector/list', { json: { collectionId: item.collectionId } });
        assert(listed.data.hashes.includes(item.hash), `Vector manifest list is missing the ${item.source} hash`);
    }

    let recalled;
    for (let attempt = 0; attempt < 60; attempt += 1) {
        recalled = await request('/api/vector/query-multi', { json: {
            collectionIds: specifications.map(item => item.collectionId), searchText: marker, topK: 20,
        }, timeout: 90_000 });
        if (specifications.every(item => recalled.data[item.collectionId]?.hashes.includes(item.hash))) break;
        await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    for (const item of specifications) {
        assert(recalled.data[item.collectionId]?.hashes.includes(item.hash), `Vectorize did not recall the ${item.source} chunk`);
        let individual;
        for (let attempt = 0; attempt < 30; attempt += 1) {
            individual = await request('/api/vector/query', { json: {
                collectionId: item.collectionId, searchText: item.text, topK: 5, includeText: true,
            }, timeout: 90_000 });
            if (individual.data.hashes.includes(item.hash)) break;
            await new Promise(resolve => setTimeout(resolve, 1_000));
        }
        assert(individual.data.hashes.includes(item.hash), `Individual ${item.source} recall failed`);
    }
    return { collections: specifications.map(item => item.collectionId), multiCollectionRecall: true };
}

async function storageSuite() {
    const characterName = `${runId}-character`;
    const created = await request('/api/characters/create', { json: {
        name: characterName, description: 'Serverless acceptance character', first_mes: 'Hello',
    } });
    const avatar = created.data;
    assert(typeof avatar === 'string' && avatar.endsWith('.png'), 'Character creation did not return an avatar');
    cleanup(() => request('/api/characters/delete', { json: { avatar_url: avatar, delete_chats: true }, expected: [200, 404] }));
    const character = await request('/api/characters/get', { json: { avatar_url: avatar } });
    assert(character.data.name === characterName, 'Character did not round-trip');
    const exported = await request('/api/characters/export', { json: { avatar_url: avatar, format: 'json' } });
    const imported = await request('/api/characters/import', { json: { json_data: JSON.stringify(exported.data) } });
    const importedAvatar = `${imported.data.file_name}.png`;
    cleanup(() => request('/api/characters/delete', { json: { avatar_url: importedAvatar, delete_chats: true }, expected: [200, 404] }));

    const avatarFile = new FormData();
    avatarFile.append('avatar', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'persona.png', { type: 'image/png' }));
    avatarFile.append('overwrite_name', `${runId}-persona.png`);
    const persona = await request('/api/avatars/upload', { body: avatarFile });
    cleanup(() => request('/api/avatars/delete', { json: { avatar: persona.data.path }, expected: [200, 404] }));
    assert((await request('/api/avatars/get', { json: {} })).data.includes(persona.data.path), 'Persona avatar list is missing the upload');
    assert((await request(`/User%20Avatars/${encodeURIComponent(persona.data.path)}`)).response.status === 200, 'Persona avatar stream failed');

    const attachmentForm = new FormData();
    attachmentForm.append('file', new File([`attachment ${runId}`], `${runId}.txt`, { type: 'text/plain' }));
    const attachment = await request('/api/files/upload', { body: attachmentForm });
    cleanup(() => request('/api/files/delete', { json: { path: attachment.data.path }, expected: [200, 404] }));
    const verified = await request('/api/files/verify', { json: { urls: [attachment.data.path] } });
    assert(verified.data[attachment.data.path] === true, 'Attachment verification failed');
    assert((await request(`/${attachment.data.path}`)).data === `attachment ${runId}`, 'Attachment stream failed');

    const galleryFolder = `${runId}-gallery`;
    const imageForm = new FormData();
    imageForm.append('image', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'pixel.png', { type: 'image/png' }));
    imageForm.append('filename', 'pixel');
    imageForm.append('format', 'png');
    imageForm.append('ch_name', galleryFolder);
    const image = await request('/api/images/upload', { body: imageForm });
    cleanup(() => request('/api/images/delete', { json: { path: image.data.path }, expected: [200, 404] }));
    const gallery = await request('/api/images/list', { json: { folder: galleryFolder, sortOrder: 'asc' } });
    assert(gallery.data.includes('pixel.png'), 'Gallery list is missing the upload');
    assert((await request(`/${image.data.path}`)).response.status === 200, 'Gallery object stream failed');

    const themeName = `${runId}-theme`;
    await request('/api/themes/save', { json: { name: themeName, blur_strength: 1 } });
    cleanup(() => request('/api/themes/delete', { json: { name: themeName }, expected: [200, 404] }));
    const quickReplyName = `${runId}-quick-reply`;
    await request('/api/quick-replies/save', { json: { name: quickReplyName, quickReplySlots: [] } });
    cleanup(() => request('/api/quick-replies/delete', { json: { name: quickReplyName }, expected: [200, 404] }));
    const presetName = `${runId}-preset`;
    await request('/api/presets/save', { json: { apiId: 'openai', name: presetName, preset: { temperature: 0.7 } } });
    cleanup(() => request('/api/presets/delete', { json: { apiId: 'openai', name: presetName }, expected: [200, 404] }));

    await request('/api/settings/save', { json: { snapshot_marker: runId } });
    await request('/api/settings/make-snapshot', { json: {}, expected: [200, 204] });
    const snapshots = await request('/api/settings/get-snapshots', { json: {} });
    const snapshot = snapshots.data.find(item => item.name?.startsWith('settings_default-user_'));
    assert(snapshot, 'Settings snapshot was not created');
    await request('/api/settings/save', { json: { snapshot_marker: 'changed' } });
    await request('/api/settings/restore-snapshot', { json: { name: snapshot.name }, expected: [200, 204] });
    const restored = await request('/api/settings/get', { json: {} });
    assert(JSON.parse(restored.data.settings).snapshot_marker === runId, 'Settings snapshot restore failed');
    return { characterImportExport: true, persona: true, attachment: true, gallery: true, settingsRestore: true };
}

async function waitForJob(id, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const current = await request(`/api/jobs/${id}`);
        if (['complete', 'failed', 'cancelled'].includes(current.data.status)) return current.data;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Maintenance job ${id} timed out`);
}

async function jobsSuite() {
    const scanStart = await request('/api/jobs', { json: { type: 'data-maid', params: {} }, expected: [202] });
    const scan = await waitForJob(scanStart.data.id);
    assert(scan.status === 'complete', `Data Maid failed: ${scan.errorCode || scan.status}`);
    assert(Number(scan.output?.orphanCount ?? 0) === 0, 'Data Maid found unindexed test objects');

    const backupStart = await request('/api/jobs', { json: { type: 'backup', params: {} }, expected: [202] });
    const backup = await waitForJob(backupStart.data.id);
    assert(backup.status === 'complete', `System backup failed: ${backup.errorCode || backup.status}`);
    const manifest = await request(`/api/backups/system/${backupStart.data.id}/manifest`);
    assert(manifest.data.version === 1, 'System backup manifest has an unsupported version');
    assert(manifest.data.r2Parts > 0 && manifest.data.d1Parts > 0, 'System backup did not create storage parts');
    const firstR2 = await request(`/api/backups/system/${backupStart.data.id}/parts/r2-000001.json`);
    const firstD1 = await request(`/api/backups/system/${backupStart.data.id}/parts/d1-000001.json`);
    assert(Array.isArray(firstR2.data.objects), 'R2 backup part is invalid');
    assert(typeof firstD1.data.table === 'string' && Array.isArray(firstD1.data.rows), 'D1 backup part is invalid');
    return { dataMaid: true, browserAssemblableBackup: true, r2Parts: manifest.data.r2Parts, d1Parts: manifest.data.d1Parts };
}

const suites = {
    system: systemSuite,
    core: coreSuite,
    storage: storageSuite,
    ai: aiSuite,
    vectors: vectorSuite,
    jobs: jobsSuite,
};

if (!accessCookie && !(accessClientId && accessClientSecret)) {
    console.warn('No Cloudflare Access cookie or service-token pair was supplied for production tests.');
}

for (const [name, suite] of Object.entries(suites)) {
    if (selectedSuites.size === 0 || selectedSuites.has(name)) await test(name, suite);
}

for (const task of cleanupTasks.reverse()) {
    try {
        await task();
    } catch (error) {
        console.warn(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

console.log(JSON.stringify({ baseUrl: baseUrl.origin, runId, results }, null, 2));
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
