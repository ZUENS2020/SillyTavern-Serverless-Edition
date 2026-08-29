import { Popper } from '../lib.js';

import { animation_duration, eventSource, event_types, getRequestHeaders, saveSettings } from '../script.js';
import { Popup } from './popup.js';
import { renderTemplate, renderTemplateAsync } from './templates.js';
import { deleteValueByPath, equalsIgnoreCaseAndAccents, sanitizeSelector, setValueByPath } from './utils.js';
import { getContext } from './st-context.js';
import { addLocaleData, getCurrentLocale } from './i18n.js';
import { debounce_timeout } from './constants.js';
import { SimpleMutex } from './util/SimpleMutex.js';

export { getContext, SimpleMutex as ModuleWorkerWrapper };

export let extensionNames = [];
export let extensionTypes = {};
export let modules = [];

const activeExtensions = new Set();
const extensionModules = new Map();
let manifests = {};
let saveMetadataTimeout = null;
const extensionAssetVersion = new URL(import.meta.url).searchParams.get('v') ?? '';

export const getApiUrl = () => location.origin;
export const isOfficialExtension = () => false;

const GATEWAY_CONNECTION_PROFILES = Object.freeze([
    { id: 'chat', name: 'AI Gateway · Chat', capability: 'chat' },
    { id: 'text', name: 'AI Gateway · Text', capability: 'text' },
]);

function versionExtensionAsset(url) {
    if (!extensionAssetVersion) return url;
    return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(extensionAssetVersion)}`;
}

function shortExtensionName(name) {
    return String(name ?? '').replace(/^third-party\//iu, '');
}

function matchesExtensionName(candidate, name) {
    return equalsIgnoreCaseAndAccents(candidate, name)
        || equalsIgnoreCaseAndAccents(shortExtensionName(candidate), shortExtensionName(name));
}

function isExtensionDisabled(name) {
    return extension_settings.disabledExtensions.some(value => matchesExtensionName(value, name));
}

function ensureGatewayConnectionProfiles() {
    const manager = extension_settings.connectionManager;
    const profiles = GATEWAY_CONNECTION_PROFILES.map(profile => ({ ...profile }));
    if (!manager || typeof manager !== 'object' || Array.isArray(manager)) {
        extension_settings.connectionManager = { selectedProfile: 'chat', profiles };
        return;
    }
    if (!Array.isArray(manager.profiles) || manager.profiles.length === 0) {
        manager.profiles = profiles;
    }
    if (!manager.selectedProfile) manager.selectedProfile = 'chat';
}

function sortByOrder([nameA, manifestA], [nameB, manifestB]) {
    return Number(manifestA.loading_order || 0) - Number(manifestB.loading_order || 0)
        || String(manifestA.display_name || nameA).localeCompare(String(manifestB.display_name || nameB));
}

export function cancelDebouncedMetadataSave() {
    if (!saveMetadataTimeout) return;
    clearTimeout(saveMetadataTimeout);
    saveMetadataTimeout = null;
}

export function saveMetadataDebounced() {
    const initial = getContext();
    const groupId = initial.groupId;
    const characterId = initial.characterId;
    cancelDebouncedMetadataSave();
    saveMetadataTimeout = setTimeout(async () => {
        const current = getContext();
        if (current.groupId !== groupId || current.characterId !== characterId) return;
        await current.saveMetadata();
    }, debounce_timeout.relaxed);
}

export function renderExtensionTemplate(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplate(versionExtensionAsset(`scripts/extensions/${extensionName}/${templateId}.html`), templateData, sanitize, localize, true);
}

export function renderExtensionTemplateAsync(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplateAsync(versionExtensionAsset(`scripts/extensions/${extensionName}/${templateId}.html`), templateData, sanitize, localize, true);
}

export const extension_settings = {
    disabledExtensions: [],
    expressionOverrides: [],
    memory: {},
    note: { default: '', chara: [], wiAddition: [] },
    caption: { refine_mode: false },
    expressions: {
        custom: [],
        showDefault: false,
        translate: false,
        fallback_expression: undefined,
        llmPrompt: undefined,
        allowMultiple: true,
        rerollIfSame: false,
        promptType: 'raw',
    },
    connectionManager: { selectedProfile: '', profiles: [] },
    regex: [],
    regex_presets: [],
    character_allowed_regex: [],
    preset_allowed_regex: {},
    tts: {},
    sd: {},
    translate: {},
    quickReply: {},
    vectors: {},
    variables: { global: {} },
    attachments: [],
    character_attachments: {},
    disabled_attachments: [],
    gallery: { folders: {}, sort: 'dateAsc' },
};

/** Arbitrary extension HTTP clients are not part of the immutable serverless runtime. */
export async function doExtrasFetch() {
    throw new Error('Extras API connections are disabled; use a declared AI Gateway capability.');
}

async function discoverExtensions() {
    const response = await fetch('/api/extensions/discover', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Extension catalog failed (${response.status})`);
    return response.json();
}

async function loadManifests(names) {
    const loaded = {};
    await Promise.all(names.map(async name => {
        try {
            const response = await fetch(versionExtensionAsset(`/scripts/extensions/${name}/manifest.json`), { cache: 'no-store' });
            if (!response.ok) throw new Error(`Manifest ${name} failed (${response.status})`);
            loaded[name] = await response.json();
        } catch (error) {
            console.error(`Could not load manifest ${name}`, error);
        }
    }));
    return loaded;
}

async function loadLocale(name, manifest) {
    const file = manifest.i18n?.[getCurrentLocale()];
    if (!file) return;
    const response = await fetch(versionExtensionAsset(`/scripts/extensions/${name}/${file}`));
    if (!response.ok) throw new Error(`Locale ${name} failed (${response.status})`);
    addLocaleData(getCurrentLocale(), await response.json());
}

async function loadStyle(name, manifest) {
    if (!manifest.css) return;
    const id = sanitizeSelector(`${name}-css`);
    if (document.getElementById(id)) return;
    await new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = versionExtensionAsset(`/scripts/extensions/${name}/${manifest.css}`);
        link.onload = resolve;
        link.onerror = reject;
        document.head.append(link);
    });
}

async function loadModule(name, manifest) {
    if (!manifest.js) return null;
    const module = await import(versionExtensionAsset(`/scripts/extensions/${name}/${manifest.js}`));
    extensionModules.set(name, module);
    return module;
}

async function callExtensionHook(name, hookName) {
    const hook = manifests[name]?.hooks?.[hookName];
    if (!hook) return;
    const module = extensionModules.get(name) ?? await loadModule(name, manifests[name]);
    if (typeof module?.[hook] !== 'function') throw new Error(`Extension ${name} does not export hook ${hook}`);
    await module[hook]();
}

async function activateExtensions() {
    const available = new Set(extensionNames);
    for (const [name, manifest] of Object.entries(manifests).sort(sortByOrder)) {
        if (activeExtensions.has(name) || isExtensionDisabled(name)) continue;
        const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
        if (dependencies.some(dependency => isExtensionDisabled(dependency) || (!available.has(dependency) && !findExtension(dependency)))) {
            console.warn(`Extension ${name} has an unavailable dependency`);
            continue;
        }
        try {
            await loadLocale(name, manifest);
            await Promise.all([loadStyle(name, manifest), loadModule(name, manifest)]);
            activeExtensions.add(name);
            await callExtensionHook(name, 'activate');
        } catch (error) {
            console.error(`Could not activate extension ${name}`, error);
        }
    }
}

export async function enableExtension(name, reload = true) {
    const extension = findExtension(name);
    if (!extension) throw new Error('Unknown extension');
    extension_settings.disabledExtensions = extension_settings.disabledExtensions.filter(value => !matchesExtensionName(value, extension.name));
    await callExtensionHook(extension.name, 'enable');
    await saveSettings();
    if (reload) location.reload();
}

export async function disableExtension(name, reload = true) {
    const extension = findExtension(name);
    if (!extension) throw new Error('Unknown extension');
    if (!isExtensionDisabled(extension.name)) extension_settings.disabledExtensions.push(extension.name);
    await callExtensionHook(extension.name, 'disable');
    await saveSettings();
    if (reload) location.reload();
}

export function findExtension(name) {
    const found = extensionNames.find(candidate => matchesExtensionName(candidate, name));
    return found ? { name: found, enabled: !isExtensionDisabled(found) } : null;
}

export function getExtensionManifest(name) {
    const found = extensionNames.find(candidate => matchesExtensionName(candidate, name));
    return found && manifests[found] ? structuredClone(manifests[found]) : null;
}

export async function installExtension() {
    toastr.warning('Runtime git/zip installation is disabled. Place a reviewed folder in public/scripts/extensions/third-party and redeploy.', 'Extensions');
    return false;
}

export async function deleteExtension() {
    toastr.warning('Extensions cannot be deleted at runtime. Remove a third-party folder and redeploy.', 'Extensions');
    return false;
}

export async function loadExtensionSettings(settings) {
    if (settings.extension_settings) Object.assign(extension_settings, settings.extension_settings);
    for (const obsolete of ['apiUrl', 'apiKey', 'autoConnect', 'notifyUpdates', 'chromadb', 'speech_recognition', 'rvc']) {
        delete extension_settings[obsolete];
    }
    ensureGatewayConnectionProfiles();
    await eventSource.emit(event_types.EXTENSIONS_FIRST_LOAD);
    const discovered = await discoverExtensions();
    extensionNames = discovered.map(item => item.name);
    extensionTypes = Object.fromEntries(discovered.map(item => [item.name, item.type === 'local' ? 'local' : 'system']));
    manifests = await loadManifests(extensionNames);
    const response = await fetch('/api/modules', { cache: 'no-store' });
    modules = response.ok ? (await response.json()).modules ?? [] : [];
    await activateExtensions();
}

export function doDailyExtensionUpdatesCheck() {
    // Bundled manifests deploy atomically with the Worker; there is no runtime updater.
}

export async function runGenerationInterceptors(chat, contextSize, type) {
    let aborted = false;
    let exitImmediately = false;
    const abort = immediately => {
        aborted = true;
        exitImmediately = Boolean(immediately);
    };
    for (const [name, manifest] of Object.entries(manifests).sort(sortByOrder)) {
        if (!activeExtensions.has(name) || !manifest.generate_interceptor) continue;
        const module = extensionModules.get(name);
        const interceptor = module?.[manifest.generate_interceptor]
            ?? globalThis[manifest.generate_interceptor];
        if (typeof interceptor === 'function') await interceptor(chat, contextSize, abort, type);
        if (exitImmediately) break;
    }
    return aborted;
}

export const UNSET_VALUE = '__@@UNSET@@__';

export async function writeExtensionField(characterId, key, value) {
    const context = getContext();
    const character = context.characters[characterId];
    if (!character) return;
    const path = `data.extensions.${key}`;
    if (value === UNSET_VALUE) deleteValueByPath(character, path);
    else setValueByPath(character, path, value);
    if (character.json_data) {
        const json = JSON.parse(character.json_data);
        if (value === UNSET_VALUE) deleteValueByPath(json, path);
        else setValueByPath(json, path, value);
        character.json_data = JSON.stringify(json);
        if (Number(characterId) === Number(context.characterId)) $('#character_json_data').val(character.json_data);
    }
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar: character.avatar, data: { extensions: { [key]: value } } }),
    });
    if (!response.ok) throw new Error(`Could not save extension field (${response.status})`);
}

export async function writeExtensionFieldBulk(avatars, key, value, { filterPath } = {}) {
    void filterPath;
    const body = {
        avatars: Array.isArray(avatars) ? avatars : [],
        data: { data: { extensions: { [key]: value } } },
    };
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Could not save extension fields (${response.status})`);
    const result = await response.json();
    const updated = new Set(result.updated ?? []);
    for (const character of getContext().characters) {
        if (!updated.has(character?.avatar)) continue;
        const path = `data.extensions.${key}`;
        if (value === UNSET_VALUE) deleteValueByPath(character, path);
        else setValueByPath(character, path, value);
    }
    return result;
}

export async function openThirdPartyExtensionMenu() {
    let catalog;
    try {
        const response = await fetch('/api/extensions/catalog', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Catalog failed (${response.status})`);
        catalog = await response.json();
    } catch (error) {
        return toastr.error(error.message, 'Extension catalog');
    }
    const container = $('<div class="flex-container flexFlowColumn flexGap10">');
    container.append($('<div class="info-block">').text('Runtime git/zip installation is disabled. Drop a reviewed folder into public/scripts/extensions/third-party and redeploy. AI features use configured Gateway capabilities.'));
    const bundled = $('<div>').append($('<h4>').text('Bundled browser extensions'));
    bundled.append($('<div>').text(catalog.bundled.map(item => item.name).join(', ')));
    const thirdParty = $('<div>').append($('<h4>').text('Deploy-time third-party extensions'));
    const thirdPartyNames = Array.isArray(catalog.thirdParty) ? catalog.thirdParty.map(item => item.name) : [];
    thirdParty.append($('<div>').text(thirdPartyNames.length ? thirdPartyNames.join(', ') : 'None in this deployment'));
    const gateway = $('<div>').append($('<h4>').text('AI Gateway capabilities'));
    for (const item of catalog.gatewayCapabilities) {
        gateway.append($('<div>').text(`${item.name}: ${item.capabilities.join(', ')}`));
    }
    container.append(bundled, thirdParty, gateway);
    await Popup.show.text('Extension catalog', container);
}

export const EMPTY_AUTHOR = Object.freeze({ name: '', url: '' });

export function getAuthorFromUrl(url) {
    try {
        const parsed = new URL(url);
        const [name] = parsed.pathname.split('/').filter(Boolean);
        return parsed.hostname === 'github.com' && name
            ? { name, url: `${parsed.protocol}//${parsed.hostname}/${name}` }
            : structuredClone(EMPTY_AUTHOR);
    } catch {
        return structuredClone(EMPTY_AUTHOR);
    }
}

async function addExtensionsButtonAndMenu() {
    $(document.body).append(await renderTemplateAsync('wandMenu'));
    $('#leftSendForm').append(await renderTemplateAsync('wandButton'));
    const button = $('#extensionsMenuButton').css('display', 'flex');
    const dropdown = $('#extensionsMenu');
    const popper = Popper.createPopper(button.get(0), dropdown.get(0), { placement: 'top-start' });
    button.on('click', () => {
        dropdown.fadeToggle(animation_duration);
        popper.update();
    });
    $('html').on('click', event => {
        if ($(event.target).closest('#extensionsMenuButton, #extensionsMenu').length === 0) dropdown.fadeOut(animation_duration);
    });
}

export async function initExtensions() {
    await addExtensionsButtonAndMenu();
    $('#extensions_details').on('click', () => openThirdPartyExtensionMenu());
    $('#third_party_extension_button').prop('disabled', true).attr('aria-disabled', 'true');
}
