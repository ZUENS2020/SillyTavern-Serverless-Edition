import {
    DEFAULT_PRESETS,
    DEFAULT_SETTINGS_TEXT,
    DEFAULT_THEMES,
    DEFAULT_WORLDS,
} from '../defaults.generated';
import { empty, HttpError, json, maxJsonBytes, maxUploadBytes, readFormData, readJson, safeName } from '../http';
import type { Router } from '../router';
import { deleteState, getState, listState, putState } from '../storage/state';

type JsonObject = Record<string, unknown>;

interface NamedText {
    readonly name: string;
    readonly text: string;
}

function objectValue(value: unknown): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Expected an object');
    return value as JsonObject;
}

function defaultsFor(key: keyof typeof DEFAULT_PRESETS): readonly NamedText[] {
    return DEFAULT_PRESETS[key] as readonly NamedText[];
}

async function mergedPresetList(env: Env, key: keyof typeof DEFAULT_PRESETS): Promise<NamedText[]> {
    const merged = new Map(defaultsFor(key).map(item => [item.name, item]));
    const saved = await listState<JsonObject>(env, `preset:${key}`);
    for (const item of saved) merged.set(item.key, { name: item.key, text: JSON.stringify(item.value) });
    return [...merged.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

async function settingsPayload(env: Env): Promise<JsonObject> {
    const [
        settings,
        kobold,
        novel,
        openai,
        textgen,
        instruct,
        context,
        sysprompt,
        reasoning,
        quickReplies,
        movingUI,
        userThemes,
        userWorlds,
    ] = await Promise.all([
        getState<JsonObject>(env, 'settings', 'current'),
        mergedPresetList(env, 'kobold'),
        mergedPresetList(env, 'novel'),
        mergedPresetList(env, 'openai'),
        mergedPresetList(env, 'textgenerationwebui'),
        mergedPresetList(env, 'instruct'),
        mergedPresetList(env, 'context'),
        mergedPresetList(env, 'sysprompt'),
        mergedPresetList(env, 'reasoning'),
        mergedPresetList(env, 'quickReplies'),
        mergedPresetList(env, 'movingUI'),
        listState<JsonObject>(env, 'theme'),
        listState<JsonObject>(env, 'world'),
    ]);

    const themeMap = new Map<string, JsonObject>(
        DEFAULT_THEMES.map(item => [item.name, objectValue(JSON.parse(item.text))]),
    );
    for (const theme of userThemes) themeMap.set(theme.key, theme.value);
    const worldNames = new Set<string>(Object.keys(DEFAULT_WORLDS));
    for (const world of userWorlds) worldNames.add(world.key);

    return {
        settings: settings ? JSON.stringify(settings.value) : DEFAULT_SETTINGS_TEXT,
        koboldai_settings: kobold.map(item => item.text),
        koboldai_setting_names: kobold.map(item => item.name),
        novelai_settings: novel.map(item => item.text),
        novelai_setting_names: novel.map(item => item.name),
        openai_settings: openai.map(item => item.text),
        openai_setting_names: openai.map(item => item.name),
        textgenerationwebui_presets: textgen.map(item => item.text),
        textgenerationwebui_preset_names: textgen.map(item => item.name),
        world_names: [...worldNames].toSorted((a, b) => a.localeCompare(b)),
        themes: [...themeMap.values()],
        movingUIPresets: movingUI.map(item => JSON.parse(item.text)),
        quickReplyPresets: quickReplies.map(item => JSON.parse(item.text)),
        instruct: instruct.map(item => JSON.parse(item.text)),
        context: context.map(item => JSON.parse(item.text)),
        sysprompt: sysprompt.map(item => JSON.parse(item.text)),
        reasoning: reasoning.map(item => JSON.parse(item.text)),
        enable_extensions: true,
        enable_extensions_auto_update: false,
        enable_accounts: false,
        request_compression: { enabled: false, minPayloadSize: 0, maxPayloadSize: 0, timeout: 0 },
    };
}

const PRESET_API_IDS: Record<string, keyof typeof DEFAULT_PRESETS> = {
    kobold: 'kobold',
    koboldhorde: 'kobold',
    novel: 'novel',
    textgenerationwebui: 'textgenerationwebui',
    openai: 'openai',
    instruct: 'instruct',
    context: 'context',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
};

function presetKey(apiId: unknown): keyof typeof DEFAULT_PRESETS {
    if (typeof apiId !== 'string' || !PRESET_API_IDS[apiId]) throw new HttpError(400, 'Unsupported preset API');
    return PRESET_API_IDS[apiId];
}

async function saveNamedBody(env: Env, namespace: string, body: JsonObject): Promise<Response> {
    const name = safeName(body.name);
    await putState(env, namespace, name, body);
    return empty(200);
}

async function deleteNamedBody(env: Env, namespace: string, body: JsonObject): Promise<Response> {
    const name = safeName(body.name);
    const deleted = await deleteState(env, namespace, name);
    return empty(deleted ? 200 : 404);
}

export function registerStateRoutes(router: Router): void {
    router.on('POST', '/api/stats/get', async ({ env }) => json((await getState<JsonObject>(env, 'stats', 'current'))?.value ?? { timestamp: Date.now() }));
    router.on('POST', '/api/stats/update', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        await putState(env, 'stats', 'current', { ...body, timestamp: Date.now() });
        return empty(200);
    });
    router.on('POST', '/api/stats/recreate', async ({ env }) => {
        await putState(env, 'stats', 'current', { timestamp: Date.now() });
        return empty(200);
    });
    router.on('POST', '/api/settings/get', ({ env }) => settingsPayload(env).then(json));
    router.on('POST', '/api/settings/save', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        await putState(env, 'settings', 'current', body);
        return json({ result: 'ok' });
    });
    router.on('POST', '/api/settings/make-snapshot', async ({ env }) => {
        const current = await getState<JsonObject>(env, 'settings', 'current');
        const value = current?.value ?? JSON.parse(DEFAULT_SETTINGS_TEXT) as JsonObject;
        const key = `settings_default-user_${Date.now()}.json`;
        await putState(env, 'settings_snapshot', key, value);
        return empty();
    });
    router.on('POST', '/api/settings/get-snapshots', async ({ env }) => {
        const snapshots = await listState<JsonObject>(env, 'settings_snapshot', 50);
        return json(snapshots.map(snapshot => ({
            date: snapshot.createdAt,
            name: snapshot.key,
            size: JSON.stringify(snapshot.value).length,
        })).toSorted((a, b) => b.date - a.date));
    });
    router.on('POST', '/api/settings/load-snapshot', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const name = safeName(body.name);
        const snapshot = await getState<JsonObject>(env, 'settings_snapshot', name);
        if (!snapshot) throw new HttpError(404, 'Snapshot not found');
        return json(snapshot.value);
    });
    router.on('POST', '/api/settings/restore-snapshot', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const name = safeName(body.name);
        const snapshot = await getState<JsonObject>(env, 'settings_snapshot', name);
        if (!snapshot) throw new HttpError(404, 'Snapshot not found');
        await putState(env, 'settings', 'current', snapshot.value);
        return empty();
    });

    router.on('POST', '/api/themes/save', async ({ request, env }) => saveNamedBody(env, 'theme', await readJson(request, maxJsonBytes(env))));
    router.on('POST', '/api/themes/delete', async ({ request, env }) => deleteNamedBody(env, 'theme', await readJson(request, maxJsonBytes(env))));
    router.on('POST', '/api/quick-replies/save', async ({ request, env }) => saveNamedBody(env, 'preset:quickReplies', await readJson(request, maxJsonBytes(env))));
    router.on('POST', '/api/quick-replies/delete', async ({ request, env }) => deleteNamedBody(env, 'preset:quickReplies', await readJson(request, maxJsonBytes(env))));
    router.on('POST', '/api/moving-ui/save', async ({ request, env }) => saveNamedBody(env, 'preset:movingUI', await readJson(request, maxJsonBytes(env))));

    router.on('POST', '/api/presets/save', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const name = safeName(body.name);
        const preset = objectValue(body.preset);
        await putState(env, `preset:${presetKey(body.apiId)}`, name, preset);
        return json({ name });
    });
    router.on('POST', '/api/presets/delete', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const deleted = await deleteState(env, `preset:${presetKey(body.apiId)}`, safeName(body.name));
        return empty(deleted ? 200 : 404);
    });
    router.on('POST', '/api/presets/restore', async ({ request }) => {
        const body = await readJson(request, 16_384);
        const key = presetKey(body.apiId);
        const name = safeName(body.name);
        const found = defaultsFor(key).find(item => item.name === name);
        return json({ isDefault: Boolean(found), preset: found ? JSON.parse(found.text) : {} });
    });

    router.on('POST', '/api/worldinfo/list', async ({ env }) => {
        const saved = await listState<JsonObject>(env, 'world');
        const merged = new Map<string, JsonObject>();
        for (const [name, value] of Object.entries(DEFAULT_WORLDS)) merged.set(name, value as JsonObject);
        for (const item of saved) merged.set(item.key, item.value);
        return json([...merged.entries()].map(([fileId, value]) => ({
            file_id: fileId,
            name: typeof value.name === 'string' ? value.name : fileId,
            extensions: typeof value.extensions === 'object' && value.extensions !== null ? value.extensions : {},
        })).toSorted((a, b) => a.file_id.localeCompare(b.file_id)));
    });
    router.on('POST', '/api/worldinfo/get', async ({ request, env }) => {
        const body = await readJson(request, 16_384);
        const name = safeName(body.name);
        const stored = await getState<JsonObject>(env, 'world', name);
        return json(stored?.value ?? (DEFAULT_WORLDS as Record<string, JsonObject>)[name] ?? { entries: {} });
    });
    router.on('POST', '/api/worldinfo/edit', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const name = safeName(body.name);
        const data = objectValue(body.data);
        if (!('entries' in data)) throw new HttpError(400, 'World info must contain entries');
        await putState(env, 'world', name, data);
        return json({ ok: true });
    });
    router.on('POST', '/api/worldinfo/delete', async ({ request, env }) => {
        const body = await readJson(request, 16_384);
        const deleted = await deleteState(env, 'world', safeName(body.name));
        return empty(deleted ? 200 : 404);
    });
    router.on('POST', '/api/worldinfo/import', async ({ request, env }) => {
        const form = await readFormData(request, maxUploadBytes(env));
        const converted = form.get('convertedData');
        const file = form.get('avatar') ?? form.get('file');
        let raw: string;
        let suggestedName: string;
        if (typeof converted === 'string' && converted) {
            raw = converted;
            suggestedName = typeof form.get('name') === 'string' ? String(form.get('name')) : 'Imported World';
        } else if (file instanceof File) {
            raw = await file.text();
            suggestedName = pathlessBaseName(file.name);
        } else {
            throw new HttpError(400, 'Missing world info file');
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw) as unknown;
        } catch {
            throw new HttpError(400, 'Invalid world info JSON');
        }
        const value = objectValue(parsed);
        if (!('entries' in value)) throw new HttpError(400, 'World info must contain entries');
        const name = safeName(suggestedName);
        await putState(env, 'world', name, value);
        return json({ name });
    });

    router.on('POST', '/api/groups/all', async ({ env }) => {
        const groups = await listState<JsonObject>(env, 'group');
        return json(groups.map(group => ({
            ...group.value,
            date_added: group.createdAt,
            create_date: new Date(group.createdAt).toISOString(),
            date_last_chat: group.updatedAt,
            chat_size: 0,
        })));
    });
    router.on('POST', '/api/groups/create', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const id = String(Date.now());
        const group = {
            id,
            name: typeof body.name === 'string' ? body.name : 'New Group',
            members: Array.isArray(body.members) ? body.members : [],
            avatar_url: body.avatar_url,
            allow_self_responses: Boolean(body.allow_self_responses),
            activation_strategy: body.activation_strategy ?? 0,
            generation_mode: body.generation_mode ?? 0,
            disabled_members: Array.isArray(body.disabled_members) ? body.disabled_members : [],
            fav: body.fav,
            chat_id: typeof body.chat_id === 'string' ? body.chat_id : id,
            chats: Array.isArray(body.chats) ? body.chats : [id],
            auto_mode_delay: body.auto_mode_delay ?? 5,
            generation_mode_join_prefix: body.generation_mode_join_prefix ?? '',
            generation_mode_join_suffix: body.generation_mode_join_suffix ?? '',
        };
        await putState(env, 'group', id, group);
        return json(group);
    });
    router.on('POST', '/api/groups/edit', async ({ request, env }) => {
        const body = await readJson(request, maxJsonBytes(env));
        const id = safeName(body.id, 'id');
        await putState(env, 'group', id, body);
        return json({ ok: true });
    });
    router.on('POST', '/api/groups/delete', async ({ request, env }) => {
        const body = await readJson(request, 16_384);
        await deleteState(env, 'group', safeName(body.id, 'id'));
        return json({ ok: true });
    });
}

function pathlessBaseName(fileName: string): string {
    const normalized = fileName.replaceAll('\\', '/');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}
