import { zipSync } from 'fflate';

const baseUrl = new URL(process.env.SILLYTAVERN_E2E_URL ?? 'https://sillytavern-serverless.pages.dev');
const runId = process.env.SILLYTAVERN_E2E_RUN_ID ?? `e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const openRouterKey = process.env.OPENROUTER_TEST_KEY ?? '';
const testOpenRouterImage = process.env.OPENROUTER_E2E_IMAGE === '1';
const selectedSuites = new Set((process.env.SILLYTAVERN_E2E_ONLY ?? '').split(',').map(value => value.trim()).filter(Boolean));
const assetSourceUrl = process.env.SILLYTAVERN_E2E_ASSET_URL
    ?? 'https://raw.githubusercontent.com/ZUENS2020/SillyTavern-Serverless-Edition/main/public/img/ai4.png';
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
    headers.set('x-sillytavern-e2e-run', runId);
    let body = options.body;
    if ('json' in options) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(options.json);
    } else if ('form' in options) {
        body = options.form;
    }
    const response = await fetch(url, {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
        redirect: options.redirect ?? 'follow',
    });
    const expected = options.expected ?? [200];
    const contentType = response.headers.get('content-type') ?? '';
    let data;
    if (options.binary) data = new Uint8Array(await response.arrayBuffer());
    else if (contentType.includes('application/json')) data = await response.json();
    else data = await response.text();
    if (!expected.includes(response.status)) {
        const detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
        throw new Error(`${options.method ?? (body === undefined ? 'GET' : 'POST')} ${path}: expected ${expected.join('/')}, received ${response.status}: ${detail}`);
    }
    return { response, data };
}

async function test(name, task) {
    const started = performance.now();
    try {
        const detail = await task();
        const status = detail?.skipped ? 'skipped' : 'passed';
        results.push({ name, status, durationMs: Math.round(performance.now() - started), detail });
        console.log(`${status === 'skipped' ? 'SKIP' : 'PASS'} ${name}`);
        return detail;
    } catch (error) {
        results.push({ name, status: 'failed', durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) });
        console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

function pngFile(name = 'pixel.png') {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    return new File([bytes], name, { type: 'image/png' });
}

async function systemSuite() {
    const root = await request('/', { expected: [200] });
    assert(typeof root.data === 'string' && root.data.includes('SillyTavern'), 'Pages shell is missing');
    const version = await request('/version');
    assert(version.data.pkgName === 'sillytavern-serverless-edition', 'Unexpected package name');
    const csrf = await request('/csrf-token');
    assert(csrf.data.token === 'disabled', 'Authentication compatibility token changed');
    const me = await request('/api/users/me');
    assert(me.data.handle === 'default-user' && me.data.admin === true, 'Shared user is unavailable');
    const users = await request('/api/users/list', { json: {} });
    assert(Array.isArray(users.data) && users.data.length === 1, 'Shared user list is invalid');
    await request('/api/users/login', { json: {} });
    await request('/api/users/logout', { json: {}, expected: [204] });
    const slug = await request('/api/users/slugify', { json: { text: 'Crème Brûlée E2E' } });
    assert(slug.data === 'creme-brulee-e2e', 'Slugify result is invalid');
    await request('/api/users/create', { json: {}, expected: [409] });
    await request('/api/users/backup', { json: {}, expected: [422] });
    const extensions = await request('/api/extensions/discover');
    assert(Array.isArray(extensions.data) && extensions.data.some(item => item.name === 'vectors'), 'Bundled extensions are missing');
    const modules = await request('/api/modules');
    assert(Array.isArray(modules.data.modules) && modules.data.modules.includes('tts'), 'Serverless modules are missing');
    const extensionVersion = await request('/api/extensions/version', { json: { extensionName: 'vectors' } });
    assert(extensionVersion.data.isUpToDate === true, 'Bundled extension version is invalid');
    await request('/api/extensions/install', { json: {}, expected: [409] });
    return { version: version.data.pkgVersion, extensions: extensions.data.length };
}

async function stateSuite() {
    const settings = await request('/api/settings/get', { json: {} });
    assert(typeof settings.data.settings === 'string', 'Settings payload is invalid');
    const stats = await request('/api/stats/get', { json: {} });
    assert(typeof stats.data.timestamp === 'number', 'Stats payload is invalid');

    const themeName = `${runId}-theme`;
    await request('/api/themes/save', { json: { name: themeName, blur_strength: 7 } });
    cleanup(() => request('/api/themes/delete', { json: { name: themeName }, expected: [200, 404] }));
    const settingsAfterTheme = await request('/api/settings/get', { json: {} });
    assert(settingsAfterTheme.data.themes.some(theme => theme.name === themeName), 'Saved theme was not merged');

    const quickReplyName = `${runId}-quick-reply`;
    await request('/api/quick-replies/save', { json: { name: quickReplyName, qrList: [] } });
    cleanup(() => request('/api/quick-replies/delete', { json: { name: quickReplyName }, expected: [200, 404] }));

    const presetName = `${runId}-preset`;
    await request('/api/presets/save', { json: { apiId: 'openai', name: presetName, preset: { temperature: 0.2 } } });
    cleanup(() => request('/api/presets/delete', { json: { apiId: 'openai', name: presetName }, expected: [200, 404] }));
    const restored = await request('/api/presets/restore', { json: { apiId: 'openai', name: presetName } });
    assert(restored.data.isDefault === false, 'Custom preset was reported as bundled');

    const worldName = `${runId}-world`;
    await request('/api/worldinfo/edit', { json: { name: worldName, data: { name: worldName, entries: { 0: { content: 'E2E world' } } } } });
    cleanup(() => request('/api/worldinfo/delete', { json: { name: worldName }, expected: [200, 404] }));
    const world = await request('/api/worldinfo/get', { json: { name: worldName } });
    assert(world.data.entries?.[0]?.content === 'E2E world', 'World info round-trip failed');
    const worlds = await request('/api/worldinfo/list', { json: {} });
    assert(worlds.data.some(item => item.file_id === worldName), 'World info list is missing saved world');

    const importedWorldName = `${runId}-imported-world`;
    const worldForm = new FormData();
    worldForm.set('name', importedWorldName);
    worldForm.set('convertedData', JSON.stringify({ name: importedWorldName, entries: {} }));
    const importedWorld = await request('/api/worldinfo/import', { form: worldForm });
    cleanup(() => request('/api/worldinfo/delete', { json: { name: importedWorld.data.name }, expected: [200, 404] }));

    const group = await request('/api/groups/create', { json: { name: `${runId}-group`, members: [], chats: [`${runId}-group-chat`] } });
    assert(typeof group.data.id === 'string', 'Group ID is missing');
    cleanup(() => request('/api/groups/delete', { json: { id: group.data.id }, expected: [200] }));
    await request('/api/groups/edit', { json: { ...group.data, name: `${runId}-group-edited` } });
    const groups = await request('/api/groups/all', { json: {} });
    assert(groups.data.some(item => item.id === group.data.id && item.name.endsWith('-edited')), 'Group edit did not persist');
    return { themeName, presetName, worldName, groupId: group.data.id };
}

async function secretsSuite() {
    const keyName = 'api_key_cometapi';
    const initial = await request('/api/secrets/read', { json: {} });
    const previousEntries = Array.isArray(initial.data[keyName]) ? initial.data[keyName] : [];
    const previousActive = previousEntries.find(item => item.active)?.id;
    const written = await request('/api/secrets/write', { json: { key: keyName, value: `not-a-real-key-${runId}`, label: runId } });
    const secretId = written.data.id;
    cleanup(async () => {
        await request('/api/secrets/delete', { json: { key: keyName, id: secretId }, expected: [204] });
        if (previousActive) await request('/api/secrets/rotate', { json: { key: keyName, id: previousActive }, expected: [204] });
    });
    await request('/api/secrets/rename', { json: { key: keyName, id: secretId, label: `${runId}-renamed` }, expected: [204] });
    await request('/api/secrets/rotate', { json: { key: keyName, id: secretId }, expected: [204] });
    const current = await request('/api/secrets/read', { json: {} });
    const found = current.data[keyName].find(item => item.id === secretId);
    assert(found?.label === `${runId}-renamed` && found.active === true, 'Secret rename/rotation failed');
    assert(!String(found.value).includes(runId), 'Secret value was exposed');
    await request('/api/secrets/view', { json: {}, expected: [403] });
    const settings = await request('/api/secrets/settings', { json: {} });
    assert(settings.data.allowKeysExposure === false, 'Secret exposure unexpectedly enabled');
    return { secretId, masked: found.value };
}

async function characterAndChatSuite() {
    const characterName = `${runId}-character`;
    const created = await request('/api/characters/create', { json: {
        ch_name: characterName,
        file_name: characterName,
        description: 'E2E character',
        first_mes: 'Hello from E2E',
        tags: ['e2e'],
    } });
    let avatar = created.data;
    assert(typeof avatar === 'string' && avatar.endsWith('.png'), 'Character avatar name is invalid');
    cleanup(() => request('/api/characters/delete', { json: { avatar_url: avatar, delete_chats: true }, expected: [200, 404] }));

    const avatarForm = new FormData();
    avatarForm.set('avatar_url', avatar);
    avatarForm.set('avatar', pngFile());
    await request('/api/characters/edit-avatar', { form: avatarForm });
    const character = await request('/api/characters/get', { json: { avatar_url: avatar } });
    assert(character.data.description === 'E2E character', 'Character create/get failed');
    await request('/api/characters/edit-attribute', { json: { avatar_url: avatar, field: 'personality', value: 'precise' } });
    await request('/api/characters/merge-attributes', { json: { avatars: [avatar], data: { data: { creator: 'E2E' } } } });
    const avatarGet = await request(`/characters/${encodeURIComponent(avatar)}`, { binary: true });
    assert(avatarGet.data.byteLength > 0, 'Character avatar streaming failed');
    await request(`/characters/${encodeURIComponent(avatar)}`, { method: 'HEAD' });
    await request(`/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`, { binary: true });
    const exportedJson = await request('/api/characters/export', { json: { avatar_url: avatar, format: 'json' } });
    assert(exportedJson.data.name === characterName, 'Character JSON export failed');
    const exportedPng = await request('/api/characters/export', { json: { avatar_url: avatar, format: 'png' }, binary: true });
    assert(exportedPng.data.byteLength > avatarGet.data.byteLength, 'Character PNG card export did not add metadata');

    const duplicate = await request('/api/characters/duplicate', { json: { avatar_url: avatar } });
    const duplicateAvatar = duplicate.data.path;
    cleanup(() => request('/api/characters/delete', { json: { avatar_url: duplicateAvatar, delete_chats: true }, expected: [200, 404] }));
    const renamed = await request('/api/characters/rename', { json: { avatar_url: avatar, new_name: `${characterName}-renamed` } });
    avatar = renamed.data.avatar;

    const chatName = `${runId}-chat`;
    const header = { user_name: 'User', character_name: characterName, chat_metadata: { integrity: runId } };
    const firstChat = [header, { name: characterName, is_user: false, mes: `hello ${runId}`, extra: {} }];
    await request('/api/chats/save', { json: { avatar_url: avatar, file_name: chatName, chat: firstChat } });
    cleanup(() => request('/api/chats/delete', { json: { avatar_url: avatar, chatfile: chatName }, expected: [200, 404] }));
    const loaded = await request('/api/chats/get', { json: { avatar_url: avatar, file_name: chatName } });
    assert(Array.isArray(loaded.data) && loaded.data[1]?.mes.includes(runId), 'Character chat round-trip failed');
    const listed = await request('/api/characters/chats', { json: { avatar_url: avatar } });
    assert(listed.data.some(item => item.file_id === chatName), 'Character chat list failed');
    const searched = await request('/api/chats/search', { json: { avatar_url: avatar, query: runId } });
    assert(searched.data.some(item => item.file_name === chatName), 'Character chat search failed');
    const recent = await request('/api/chats/recent', { json: { max: 100 } });
    assert(recent.data.some(item => item.file_id === chatName), 'Recent chat list failed');
    const chatExport = await request('/api/chats/export', { json: { avatar_url: avatar, file: chatName, format: 'jsonl' } });
    assert(chatExport.data.result.includes(runId), 'Character chat export failed');

    const beforeBackups = await request('/api/backups/chat/get', { json: {} });
    const secondChat = [...firstChat, { name: 'User', is_user: true, mes: `revision ${runId}`, extra: {} }];
    await request('/api/chats/save', { json: { avatar_url: avatar, file_name: chatName, chat: secondChat } });
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterBackups = await request('/api/backups/chat/get', { json: {} });
    const beforeNames = new Set(beforeBackups.data.map(item => item.file_name));
    const newBackup = afterBackups.data.find(item => !beforeNames.has(item.file_name) && item.mes.includes(runId));
    assert(newBackup, 'Automatic chat revision backup was not created');
    cleanup(() => request('/api/backups/chat/delete', { json: { name: newBackup.file_name }, expected: [200, 404] }));
    const backup = await request('/api/backups/chat/download', { json: { name: newBackup.file_name } });
    assert(backup.data[1]?.mes.includes(runId), 'Chat backup download failed');

    const importedCharacterName = `${runId}-imported-character`;
    const importForm = new FormData();
    importForm.set('file_type', 'json');
    importForm.set('file', new File([JSON.stringify({ name: importedCharacterName, first_mes: 'Imported' })], `${importedCharacterName}.json`, { type: 'application/json' }));
    const imported = await request('/api/characters/import', { form: importForm });
    const importedAvatar = `${imported.data.file_name}.png`;
    cleanup(() => request('/api/characters/delete', { json: { avatar_url: importedAvatar, delete_chats: true }, expected: [200, 404] }));

    const groupChatName = `${runId}-group-chat`;
    await request('/api/chats/group/save', { json: { id: groupChatName, chat: firstChat } });
    cleanup(() => request('/api/chats/group/delete', { json: { id: groupChatName }, expected: [200, 404] }));
    const groupChat = await request('/api/chats/group/get', { json: { id: groupChatName } });
    assert(Array.isArray(groupChat.data), 'Group chat get failed');
    const groupInfo = await request('/api/chats/group/info', { json: { id: groupChatName } });
    assert(groupInfo.data.file_id === groupChatName, 'Group chat info failed');
    await request('/api/chats/group/clear-metadata', { json: { id: groupChatName }, expected: [204] });
    return { avatar, duplicateAvatar, chatName, groupChatName };
}

async function mediaSuite() {
    const backgroundOriginal = `${runId}-background.png`;
    const backgroundRenamed = `${runId}-background-renamed.png`;
    const backgroundForm = new FormData();
    backgroundForm.set('file', pngFile(backgroundOriginal));
    await request('/api/backgrounds/upload', { form: backgroundForm });
    cleanup(() => request('/api/backgrounds/delete', { json: { bg: backgroundRenamed }, expected: [200, 404] }));
    await request('/api/backgrounds/rename', { json: { old_bg: backgroundOriginal, new_bg: backgroundRenamed } });
    const backgrounds = await request('/api/backgrounds/all', { json: {} });
    assert(backgrounds.data.images.some(item => item.filename === backgroundRenamed), 'Background list/rename failed');
    await request(`/backgrounds/${encodeURIComponent(backgroundRenamed)}`, { binary: true });
    await request(`/backgrounds/${encodeURIComponent(backgroundRenamed)}`, { method: 'HEAD' });

    const folder = await request('/api/image-metadata/folders/create', { json: { name: `${runId}-folder` } });
    cleanup(() => request('/api/image-metadata/folders/delete', { json: { id: folder.data.id }, expected: [200, 404] }));
    await request('/api/image-metadata/folders/update', { json: { id: folder.data.id, name: `${runId}-folder-updated` } });
    await request('/api/image-metadata/folders/assign', { json: { id: folder.data.id, paths: [`backgrounds/${backgroundRenamed}`] } });
    const metadata = await request('/api/image-metadata', { json: { path: `backgrounds/${backgroundRenamed}` } });
    assert(metadata.data.folderIds.includes(folder.data.id), 'Image folder assignment failed');
    await request('/api/image-metadata/all', { json: { prefix: 'backgrounds/' } });
    await request('/api/image-metadata/folders/set-thumbnails', { json: { updates: [{ id: folder.data.id, thumbnailFile: backgroundRenamed }] } });
    await request('/api/image-metadata/folders/unassign', { json: { id: folder.data.id, paths: [`backgrounds/${backgroundRenamed}`] } });
    await request('/api/image-metadata/cleanup', { json: {} });

    const personaName = `${runId}-persona.png`;
    const personaForm = new FormData();
    personaForm.set('file', pngFile());
    personaForm.set('overwrite_name', personaName);
    await request('/api/avatars/upload', { form: personaForm });
    cleanup(() => request('/api/avatars/delete', { json: { avatar: personaName }, expected: [200, 404] }));
    const personas = await request('/api/avatars/get', { json: {} });
    assert(personas.data.includes(personaName), 'Persona avatar list failed');
    await request(`/User%20Avatars/${encodeURIComponent(personaName)}`, { binary: true });
    await request(`/User%20Avatars/${encodeURIComponent(personaName)}`, { method: 'HEAD' });
    await request(`/thumbnail?type=persona&file=${encodeURIComponent(personaName)}`, { binary: true });

    const imageFolder = `${runId}-images`;
    const imageName = `${runId}-image`;
    const imageForm = new FormData();
    imageForm.set('image', pngFile());
    imageForm.set('format', 'png');
    imageForm.set('filename', imageName);
    imageForm.set('ch_name', imageFolder);
    const uploadedImage = await request('/api/images/upload', { form: imageForm });
    cleanup(() => request('/api/images/delete', { json: { path: uploadedImage.data.path }, expected: [200, 404] }));
    const images = await request(`/api/images/list/${encodeURIComponent(imageFolder)}`, { json: {} });
    assert(images.data.includes(`${imageName}.png`), 'User image list failed');
    const imagePath = `/${uploadedImage.data.path}`;
    await request(imagePath, { binary: true });
    await request(imagePath, { method: 'HEAD' });
    const imageFolders = await request('/api/images/folders', { json: {} });
    assert(imageFolders.data.includes(imageFolder), 'User image folders failed');

    const fileName = `${runId}.txt`;
    const uploadedFile = await request('/api/files/upload', { json: { name: fileName, data: Buffer.from(`file ${runId}`).toString('base64') } });
    cleanup(() => request('/api/files/delete', { json: { path: uploadedFile.data.path }, expected: [200, 404] }));
    const sanitized = await request('/api/files/sanitize-filename', { json: { fileName } });
    assert(sanitized.data.fileName === fileName, 'Filename sanitization changed safe input');
    const verified = await request('/api/files/verify', { json: { urls: [uploadedFile.data.path, 'user/files/missing.txt'] } });
    assert(verified.data[uploadedFile.data.path] === true, 'Uploaded file verification failed');
    await request(`/${uploadedFile.data.path}`, { binary: true });
    await request(`/${uploadedFile.data.path}`, { method: 'HEAD' });

    const spriteFolder = `${runId}-sprites`;
    const spriteForm = new FormData();
    spriteForm.set('name', spriteFolder);
    spriteForm.set('spriteName', 'happy');
    spriteForm.set('file', pngFile('happy.png'));
    await request('/api/sprites/upload', { form: spriteForm });
    cleanup(() => request('/api/sprites/delete', { json: { name: spriteFolder, spriteName: 'happy' }, expected: [200] }));
    const sprites = await request(`/api/sprites/get?name=${encodeURIComponent(spriteFolder)}`);
    assert(sprites.data.some(item => item.label === 'happy'), 'Sprite upload/list failed');
    const spritePath = `/characters/${encodeURIComponent(spriteFolder)}/happy.png`;
    await request(spritePath, { binary: true });
    await request(spritePath, { method: 'HEAD' });

    const zipFolder = `${runId}-zip-sprites`;
    const zipForm = new FormData();
    zipForm.set('name', zipFolder);
    zipForm.set('file', new File([zipSync({ 'sad.png': pngFile().stream ? Buffer.from(await pngFile().arrayBuffer()) : new Uint8Array() })], 'sprites.zip', { type: 'application/zip' }));
    const zipUpload = await request('/api/sprites/upload-zip', { form: zipForm });
    assert(zipUpload.data.count === 1, 'Sprite ZIP upload failed');
    cleanup(() => request('/api/sprites/delete', { json: { name: zipFolder, spriteName: 'sad' }, expected: [200] }));

    const assetName = `${runId}.png`;
    await request('/api/assets/download', { json: { category: 'blip', filename: assetName, url: assetSourceUrl } });
    cleanup(() => request('/api/assets/delete', { json: { category: 'blip', filename: assetName }, expected: [200, 404] }));
    const assets = await request('/api/assets/get', { json: {} });
    assert(assets.data.blip.includes(`assets/blip/${assetName}`), 'Asset list/download failed');
    await request(`/assets/blip/${encodeURIComponent(assetName)}`, { binary: true });
    await request(`/assets/blip/${encodeURIComponent(assetName)}`, { method: 'HEAD' });
    return { backgroundRenamed, personaName, imagePath, fileName, spriteFolder, assetName };
}

async function lightweightFeatureSuite() {
    const collectionId = `${runId}-vectors`;
    cleanup(() => request('/api/vector/purge', { json: { collectionId }, expected: [200] }));
    await request('/api/vector/insert', { json: { collectionId, source: 'chat', items: [
        { hash: 101, text: `tea memory ${runId}`, index: 0 },
        { hash: 102, text: `coffee memory ${runId}`, index: 1 },
    ] } });
    const listed = await request('/api/vector/list', { json: { collectionId, source: 'chat' } });
    assert(listed.data.includes(101) && listed.data.includes(102), 'Vector list failed');
    const queried = await request('/api/vector/query', { json: { collectionId, source: 'chat', searchText: 'tea', topK: 2 } });
    assert(queried.data.hashes.includes(101), 'Vector query failed');
    const multi = await request('/api/vector/query-multi', { json: { collectionIds: [collectionId], source: 'chat', searchText: 'coffee', topK: 2 } });
    assert(multi.data[collectionId].hashes.includes(102), 'Multi-collection vector query failed');
    await request('/api/vector/delete', { json: { collectionId, source: 'chat', hashes: [102] } });

    const tokenCount = await request('/api/tokenizers/openai/count', { json: { messages: [{ role: 'user', content: 'Hello' }] } });
    assert(tokenCount.data.token_count > 0 && tokenCount.data.approximate === true, 'OpenAI token count failed');
    const encoded = await request('/api/tokenizers/llama/encode', { json: { text: `hello ${runId}` } });
    assert(encoded.data.count > 0 && Array.isArray(encoded.data.ids), 'Approximate tokenizer encode failed');
    const decoded = await request('/api/tokenizers/llama/decode', { json: { ids: encoded.data.ids } });
    assert(decoded.data.approximate === true, 'Approximate tokenizer decode contract failed');

    const labels = await request('/api/classify/labels', { json: {} });
    assert(labels.data.labels.includes('joy'), 'Classifier labels failed');
    const classified = await request('/api/classify', { json: { text: 'I am very happy, thank you!' } });
    assert(classified.data.classification[0]?.label === 'joy', 'Expression classification failed');
    await request('/api/caption', { json: {}, expected: [422] });

    const workflows = await request('/api/sd/comfy/workflows', { json: {} });
    assert(workflows.data.includes('Default_Comfy_Workflow.json'), 'Bundled ComfyUI workflows are missing');
    const workflowName = `${runId}-workflow.json`;
    const renamedWorkflow = `${runId}-workflow-renamed.json`;
    await request('/api/sd/comfy/save-workflow', { json: { file_name: workflowName, workflow: JSON.stringify({ 1: { class_type: 'KSampler', inputs: {} } }) } });
    cleanup(() => request('/api/sd/comfy/delete-workflow', { json: { file_name: renamedWorkflow }, expected: [200, 404] }));
    const workflow = await request('/api/sd/comfy/workflow', { json: { file_name: workflowName } });
    assert(JSON.parse(workflow.data)['1'].class_type === 'KSampler', 'ComfyUI workflow get failed');
    await request('/api/sd/comfy/rename-workflow', { json: { old_name: workflowName, new_name: renamedWorkflow }, expected: [204] });
    return { collectionId, workflowName: renamedWorkflow };
}

async function publicProviderSuite() {
    const samplers = await request('/api/horde/sd-samplers', { json: {} });
    assert(Array.isArray(samplers.data) && samplers.data.length > 0, 'Horde sampler list failed');
    const hordeStatus = await request('/api/horde/status', { json: {} });
    assert(typeof hordeStatus.data.ok === 'boolean', 'Horde status failed');
    const textWorkers = await request('/api/horde/text-workers', { json: {} });
    assert(Array.isArray(textWorkers.data), 'Horde text worker list failed');
    const hordeUser = await request('/api/horde/user-info', { json: {} });
    assert(typeof hordeUser.data.anonymous === 'boolean', 'Horde user info failed');
    const textModels = await request('/api/horde/text-models', { json: {} });
    assert(Array.isArray(textModels.data), 'Horde text model list failed');
    const imageModels = await request('/api/horde/sd-models', { json: {} });
    assert(Array.isArray(imageModels.data), 'Horde image model list failed');
    const googleVoices = await request('/api/google/list-voices', { json: {} });
    assert(Array.isArray(googleVoices.data) && googleVoices.data.length > 0, 'Google voice list failed');
    const nativeVoices = await request('/api/google/list-native-voices', { json: {} });
    assert(Array.isArray(nativeVoices.data.voices) && nativeVoices.data.voices.length > 0, 'Google native voice list failed');
    const pollinationsVoices = await request('/api/speech/pollinations/voices', { json: {} });
    assert(Array.isArray(pollinationsVoices.data), 'Pollinations voice list failed');
    const openRouterImages = await request('/api/openrouter/models/image', { json: {} });
    const openRouterMultimodal = await request('/api/openrouter/models/multimodal', { json: {} });
    const openRouterEmbedding = await request('/api/openrouter/models/embedding', { json: {} });
    assert(Array.isArray(openRouterImages.data) && openRouterImages.data.length > 0, 'OpenRouter image models failed');
    assert(Array.isArray(openRouterMultimodal.data) && openRouterMultimodal.data.length > 0, 'OpenRouter multimodal models failed');
    assert(Array.isArray(openRouterEmbedding.data) && openRouterEmbedding.data.length > 0, 'OpenRouter embedding models failed');
    for (const provider of ['google', 'bing', 'lingva', 'yandex']) {
        const translated = await request(`/api/translate/${provider}`, { json: { text: 'hello', chunks: ['hello'], lang: 'zh-CN' } });
        assert(typeof translated.data === 'string' && translated.data.length > 0, `${provider} translation failed`);
    }
    const visited = await request('/api/search/visit', { json: { url: assetSourceUrl.replace('/public/img/ai4.png', '/README.md'), html: false } });
    assert(typeof visited.data === 'string' && visited.data.includes('SillyTavern'), 'Public URL visit failed');
    return {
        hordeTextWorkers: textWorkers.data.length,
        hordeTextModels: textModels.data.length,
        hordeImageModels: imageModels.data.length,
        openRouterImageModels: openRouterImages.data.length,
        openRouterMultimodalModels: openRouterMultimodal.data.length,
        openRouterEmbeddingModels: openRouterEmbedding.data.length,
        publicTranslations: 4,
        safeUrlVisit: true,
    };
}

async function openRouterSuite() {
    const initial = await request('/api/secrets/read', { json: {} });
    const previousEntries = Array.isArray(initial.data.api_key_openrouter) ? initial.data.api_key_openrouter : [];
    const previousActive = previousEntries.find(item => item.active)?.id;
    if (!openRouterKey && !previousActive) return { skipped: true, reason: 'No active OpenRouter key is configured' };
    let secretId = previousActive;
    if (openRouterKey) {
        const written = await request('/api/secrets/write', { json: { key: 'api_key_openrouter', value: openRouterKey, label: `${runId}-temporary` } });
        secretId = written.data.id;
        cleanup(async () => {
            await request('/api/secrets/delete', { json: { key: 'api_key_openrouter', id: secretId }, expected: [204] });
            if (previousActive) await request('/api/secrets/rotate', { json: { key: 'api_key_openrouter', id: previousActive }, expected: [204] });
        });
    }
    const status = await request('/api/backends/chat-completions/status', { json: { chat_completion_source: 'openrouter', secret_id: secretId } });
    assert(Array.isArray(status.data.data) && status.data.data.length > 0, 'OpenRouter chat models failed');
    const generated = await request('/api/backends/chat-completions/generate', { json: {
        chat_completion_source: 'openrouter',
        secret_id: secretId,
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'Reply only with OK.' }],
        max_tokens: 8,
        stream: false,
    } });
    assert(Array.isArray(generated.data.choices) && generated.data.choices.length > 0, 'OpenRouter chat generation failed');
    const credits = await request('/api/openrouter/credits', { json: { secret_id: secretId } });
    assert(typeof credits.data.remaining === 'number', 'OpenRouter credits failed');
    const model = status.data.data.map(item => item.id).find(id => typeof id === 'string' && id.includes('/') && !id.startsWith('openrouter/'));
    const providers = await request('/api/openrouter/models/providers', { json: { model, secret_id: secretId } });
    assert(Array.isArray(providers.data) && providers.data.length > 0, 'OpenRouter provider list failed');
    let imageGenerated = false;
    if (testOpenRouterImage) {
        const imageResult = await request('/api/openrouter/image/generate', { json: {
            secret_id: secretId,
            model: 'black-forest-labs/flux.2-klein-4b',
            prompt: 'A minimal red square centered on a plain white background, test image',
            aspect_ratio: '1:1',
            output_format: 'png',
        } });
        const generatedImage = imageResult.data?.data?.[0];
        assert(typeof generatedImage?.b64_json === 'string' && generatedImage.b64_json.length > 100, 'OpenRouter image generation failed');
        const bytes = Buffer.from(generatedImage.b64_json, 'base64');
        const form = new FormData();
        form.set('image', new File([bytes], `${runId}-openrouter.png`, { type: generatedImage.media_type || 'image/png' }));
        form.set('format', 'png');
        form.set('filename', `${runId}-openrouter`);
        form.set('ch_name', `${runId}-openrouter-images`);
        const uploaded = await request('/api/images/upload', { form });
        cleanup(() => request('/api/images/delete', { json: { path: uploaded.data.path }, expected: [200, 404] }));
        const streamed = await request(`/${uploaded.data.path}`, { binary: true });
        assert(streamed.data.byteLength === bytes.byteLength, 'OpenRouter image upload/stream length mismatch');
        imageGenerated = true;
    }
    return {
        models: status.data.data.length,
        choices: generated.data.choices.length,
        providers: providers.data.length,
        hasCredits: true,
        imageGenerated,
    };
}

async function googleSuite() {
    const initial = await request('/api/secrets/read', { json: {} });
    const entries = Array.isArray(initial.data.api_key_makersuite) ? initial.data.api_key_makersuite : [];
    const secretId = entries.find(item => item.active)?.id;
    if (!secretId) return { skipped: true, reason: 'No active Google AI Studio key is configured' };

    const status = await request('/api/backends/chat-completions/status', { json: {
        chat_completion_source: 'makersuite',
        secret_id: secretId,
    } });
    assert(Array.isArray(status.data.data) && status.data.data.length > 0, 'Google AI Studio model discovery failed');
    const modelIds = status.data.data.map(item => item.id).filter(id => typeof id === 'string');
    const textModel = ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash']
        .find(model => modelIds.includes(model));
    assert(textModel, 'No low-cost Google text model is available');
    const generated = await request('/api/backends/chat-completions/generate', { json: {
        chat_completion_source: 'makersuite',
        secret_id: secretId,
        model: textModel,
        messages: [{ role: 'user', content: 'Reply only with OK.' }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
    } });
    const generatedText = generated.data?.candidates?.[0]?.content?.parts
        ?.find(part => typeof part?.text === 'string')?.text;
    assert(typeof generatedText === 'string' && generatedText.length > 0, 'Google text generation failed');

    const captionModel = modelIds.includes('gemini-2.5-flash') ? 'gemini-2.5-flash' : textModel;
    const pixelBytes = Buffer.from(await pngFile().arrayBuffer());
    const caption = await request('/api/google/caption-image', { json: {
        api: 'makersuite',
        secret_id: secretId,
        model: captionModel,
        image: `data:image/png;base64,${pixelBytes.toString('base64')}`,
        prompt: 'Describe this image in no more than three words.',
    } });
    assert(typeof caption.data.caption === 'string' && caption.data.caption.length > 0, 'Google image captioning failed');

    const ttsModel = ['gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview']
        .find(model => modelIds.includes(model));
    assert(ttsModel, 'No Google native TTS model is available');
    const speech = await request('/api/google/generate-native-tts', { json: {
        api: 'makersuite',
        secret_id: secretId,
        model: ttsModel,
        text: 'Test.',
        voice: 'Kore',
    }, binary: true });
    assert(speech.data.byteLength > 44, 'Google native TTS returned empty audio');
    assert((speech.response.headers.get('content-type') ?? '').startsWith('audio/'), 'Google native TTS content type is invalid');

    return {
        models: modelIds.length,
        textGenerated: true,
        imageCaptioned: true,
        nativeTtsBytes: speech.data.byteLength,
    };
}

async function compatibilitySuite() {
    const unavailable = [
        '/api/google/generate-video',
        '/api/openai/generate-video',
        '/api/novelai/generate-image',
        '/api/minimax/generate-voice',
        '/api/volcengine/generate-voice',
        '/api/text-to-speech/coqui/generate-tts',
        '/api/plugins/office/parse',
        '/api/image',
    ];
    for (const path of unavailable) await request(path, { json: {}, expected: [422] });
    await request('/api/search/transcript', { json: {}, expected: [501] });
    const report = await request('/api/data-maid/report', { json: {} });
    assert(Array.isArray(report.data.report.images) && typeof report.data.token === 'string', 'Data Maid compatibility report failed');
    await request('/api/backends/text-completions/status', { json: { api_type: 'generic', api_server: 'http://127.0.0.1:5000' }, expected: [400] });
    return { explicitUnavailableRoutes: unavailable.length + 1, privateNetworkBlocked: true };
}

async function cleanupAudit() {
    const [
        secrets,
        settings,
        worlds,
        groups,
        characters,
        recentChats,
        backups,
        backgrounds,
        personas,
        imageFolders,
        metadataFolders,
        assets,
        workflows,
        sprites,
        vectors,
        files,
    ] = await Promise.all([
        request('/api/secrets/read', { json: {} }),
        request('/api/settings/get', { json: {} }),
        request('/api/worldinfo/list', { json: {} }),
        request('/api/groups/all', { json: {} }),
        request('/api/characters/all', { json: {} }),
        request('/api/chats/recent', { json: { max: 100 } }),
        request('/api/backups/chat/get', { json: {} }),
        request('/api/backgrounds/all', { json: {} }),
        request('/api/avatars/get', { json: {} }),
        request('/api/images/folders', { json: {} }),
        request('/api/image-metadata/folders/get', { json: {} }),
        request('/api/assets/get', { json: {} }),
        request('/api/sd/comfy/workflows', { json: {} }),
        request(`/api/sprites/get?name=${encodeURIComponent(`${runId}-sprites`)}`),
        request('/api/vector/list', { json: { collectionId: `${runId}-vectors`, source: 'chat' } }),
        request('/api/files/verify', { json: { urls: [`user/files/${runId}.txt`] } }),
    ]);
    const secretEntries = Object.values(secrets.data).flatMap(value => Array.isArray(value) ? value : []);
    assert(!secretEntries.some(item => String(item.label).includes(runId)), 'A temporary secret label remains');
    assert(!settings.data.themes.some(item => String(item.name).includes(runId)), 'A temporary theme remains');
    assert(!settings.data.openai_setting_names.some(name => String(name).includes(runId)), 'A temporary preset remains');
    assert(!settings.data.quickReplyPresets.some(item => String(item.name).includes(runId)), 'A temporary quick reply remains');
    assert(!worlds.data.some(item => String(item.file_id).includes(runId)), 'A temporary world remains');
    assert(!groups.data.some(item => String(item.name).includes(runId)), 'A temporary group remains');
    assert(!characters.data.some(item => String(item.avatar).includes(runId)), 'A temporary character remains');
    assert(!recentChats.data.some(item => String(item.file_id).includes(runId)), 'A temporary chat remains');
    assert(!backups.data.some(item => String(item.mes).includes(runId)), 'A temporary chat backup remains');
    assert(!backgrounds.data.images.some(item => String(item.filename).includes(runId)), 'A temporary background remains');
    assert(!personas.data.some(name => String(name).includes(runId)), 'A temporary persona remains');
    assert(!imageFolders.data.some(name => String(name).includes(runId)), 'A temporary image folder remains');
    assert(!metadataFolders.data.some(item => String(item.name).includes(runId)), 'A temporary metadata folder remains');
    assert(!JSON.stringify(assets.data).includes(runId), 'A temporary asset remains');
    assert(!workflows.data.some(name => String(name).includes(runId)), 'A temporary workflow remains');
    assert(sprites.data.length === 0, 'A temporary sprite remains');
    assert(vectors.data.length === 0, 'A temporary vector remains');
    assert(files.data[`user/files/${runId}.txt`] === false, 'A temporary file remains');
    return { temporaryArtifacts: 0 };
}

async function main() {
    console.log(`Running production E2E against ${baseUrl.origin} as ${runId}`);
    const suites = [
        ['system', 'Pages shell, shared user, modules, and immutable extensions', systemSuite],
        ['state', 'D1 settings-derived state, presets, worlds, and groups', stateSuite],
        ['secrets', 'D1 secret lifecycle and masking', secretsSuite],
        ['characters', 'R2 character cards, avatars, chats, backups, import, and export', characterAndChatSuite],
        ['media', 'R2 backgrounds, personas, images, files, sprites, and assets', mediaSuite],
        ['lightweight', 'D1 vectors, tokenizers, classification, and ComfyUI workflows', lightweightFeatureSuite],
        ['public-providers', 'Public provider discovery endpoints', publicProviderSuite],
        ['openrouter', 'OpenRouter authenticated generation', openRouterSuite],
        ['google', 'Google AI Studio text, vision, and native TTS', googleSuite],
        ['compatibility', 'Free-CPU compatibility and SSRF boundaries', compatibilitySuite],
    ];
    try {
        for (const [id, name, suite] of suites) {
            if (selectedSuites.size === 0 || selectedSuites.has(id)) await test(name, suite);
        }
    } finally {
        for (const task of cleanupTasks.reverse()) {
            try {
                await task();
            } catch (error) {
                results.push({ name: 'cleanup', status: 'failed', error: error instanceof Error ? error.message : String(error) });
                console.error(`CLEANUP FAIL: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    await test('Production cleanup audit', cleanupAudit);
    const failures = results.filter(result => result.status === 'failed');
    const skipped = results.filter(result => result.status === 'skipped');
    const passed = results.filter(result => result.status === 'passed');
    console.log(JSON.stringify({ baseUrl: baseUrl.origin, runId, passed: passed.length, skipped: skipped.length, failed: failures.length, results }, null, 2));
    if (failures.length > 0) process.exitCode = 1;
}

await main();
