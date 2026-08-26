import { Popper } from '../lib.js';

import { eventSource, event_types, saveSettings, saveSettingsDebounced, getRequestHeaders, animation_duration, CLIENT_VERSION } from '../script.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';
import { renderTemplate, renderTemplateAsync } from './templates.js';
import { delay, deleteValueByPath, equalsIgnoreCaseAndAccents, escapeHtml, isSubsetOf, sanitizeSelector, setValueByPath, versionCompare } from './utils.js';
import { getContext } from './st-context.js';
import { isAdmin } from './user.js';
import { addLocaleData, getCurrentLocale, t } from './i18n.js';
import { debounce_timeout } from './constants.js';
import { accountStorage } from './util/AccountStorage.js';
import { SimpleMutex } from './util/SimpleMutex.js';

export {
    getContext,
    getApiUrl,
    SimpleMutex as ModuleWorkerWrapper,
};

/** @type {string[]} */
export let extensionNames = [];

/**
 * Holds the type of each extension.
 * Don't use this directly, use getExtensionType instead!
 * @type {Record<string, string>}
 */
export let extensionTypes = {};

/**
 * A list of active modules provided by the Extras API.
 * @type {string[]}
 */
export let modules = [];

/**
 * A set of active extensions.
 * @type {Set<string>}
 */
const activeExtensions = new Set();

/**
 * Errors that occurred while loading extensions.
 * @type {Set<string>}
 */
const extensionLoadErrors = new Set();

const getApiUrl = () => extension_settings.apiUrl;
const sortManifestsByOrder = (a, b) => parseInt(a.loading_order) - parseInt(b.loading_order) || String(a.display_name).localeCompare(String(b.display_name));
const sortManifestsByName = (a, b) => String(a.display_name).localeCompare(String(b.display_name)) || parseInt(a.loading_order) - parseInt(b.loading_order);
let connectedToApi = false;

/**
 * Holds manifest data for each extension.
 * @type {Record<string, object>}
 */
let manifests = {};

/**
 * Default URL for the Extras API.
 */
const defaultUrl = '';

const FALLBACK_EXTENSION_INTEGRATIONS = Object.freeze({
    assets: 'bundled',
    attachments: 'bundled',
    caption: 'worker-api',
    'connection-manager': 'bundled',
    expressions: 'worker-api',
    gallery: 'bundled',
    memory: 'worker-api',
    'quick-reply': 'bundled',
    regex: 'bundled',
    'stable-diffusion': 'worker-api',
    'token-counter': 'bundled',
    translate: 'worker-api',
    tts: 'worker-api',
    vectors: 'worker-api',
});

/**
 * Checks if the extension is officially supported by its URL pattern.
 * @param {string} url URL to check
 * @returns {boolean} True if the URL matches the pattern, false otherwise (or not a valid URL)
 */
export const isOfficialExtension = (url) => {
    try {
        return /^https:\/\/github\.com\/SillyTavern\/(.+)$/i.test(new URL(url).href);
    } catch (e) {
        return false;
    }
};

let requiresReload = false;
let stateChanged = false;
let saveMetadataTimeout = null;

export function cancelDebouncedMetadataSave() {
    if (saveMetadataTimeout) {
        console.debug('Debounced metadata save cancelled');
        clearTimeout(saveMetadataTimeout);
        saveMetadataTimeout = null;
    }
}

export function saveMetadataDebounced() {
    const context = getContext();
    const groupId = context.groupId;
    const characterId = context.characterId;

    cancelDebouncedMetadataSave();

    saveMetadataTimeout = setTimeout(async () => {
        const newContext = getContext();

        if (groupId !== newContext.groupId) {
            console.warn('Group changed, not saving metadata');
            return;
        }

        if (characterId !== newContext.characterId) {
            console.warn('Character changed, not saving metadata');
            return;
        }

        console.debug('Saving metadata...');
        await newContext.saveMetadata();
        console.debug('Saved metadata...');
    }, debounce_timeout.relaxed);
}

/**
 * Provides an ability for extensions to render HTML templates synchronously.
 * Templates sanitation and localization is forced.
 * @param {string} extensionName Extension name
 * @param {string} templateId Template ID
 * @param {object} templateData Additional data to pass to the template
 * @returns {string} Rendered HTML
 *
 * @deprecated Use renderExtensionTemplateAsync instead.
 */
export function renderExtensionTemplate(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplate(`scripts/extensions/${extensionName}/${templateId}.html`, templateData, sanitize, localize, true);
}

/**
 * Provides an ability for extensions to render HTML templates asynchronously.
 * Templates sanitation and localization is forced.
 * @param {string} extensionName Extension name
 * @param {string} templateId Template ID
 * @param {object} templateData Additional data to pass to the template
 * @returns {Promise<string>} Rendered HTML
 */
export function renderExtensionTemplateAsync(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplateAsync(`scripts/extensions/${extensionName}/${templateId}.html`, templateData, sanitize, localize, true);
}

export const extension_settings = {
    apiUrl: defaultUrl,
    apiKey: '',
    autoConnect: false,
    notifyUpdates: false,
    disabledExtensions: [],
    expressionOverrides: [],
    memory: {},
    note: {
        default: '',
        chara: [],
        wiAddition: [],
    },
    caption: {
        refine_mode: false,
    },
    expressions: {
        /** @type {number} see `EXPRESSION_API` */
        api: undefined,
        /** @type {string[]} */
        custom: [],
        showDefault: false,
        translate: false,
        /** @type {string} */
        fallback_expression: undefined,
        /** @type {string} */
        llmPrompt: undefined,
        allowMultiple: true,
        rerollIfSame: false,
        promptType: 'raw',
    },
    connectionManager: {
        selectedProfile: '',
        /** @type {import('./extensions/connection-manager/index.js').ConnectionProfile[]} */
        profiles: [],
    },
    dice: {},
    /** @type {import('./char-data.js').RegexScriptData[]} */
    regex: [],
    /** @type {import('./extensions/regex/index.js').RegexPreset[]} */
    regex_presets: [],
    /** @type {string[]} */
    character_allowed_regex: [],
    /** @type {Record<string, string[]>} */
    preset_allowed_regex: {},
    tts: {},
    sd: {
        prompts: {},
        character_prompts: {},
        character_negative_prompts: {},
    },
    chromadb: {},
    translate: {},
    objective: {},
    quickReply: {},
    randomizer: {
        controls: [],
        fluctuation: 0.1,
        enabled: false,
    },
    speech_recognition: {},
    rvc: {},
    hypebot: {},
    vectors: {},
    variables: {
        global: {},
    },
    /**
     * @type {import('./chats.js').FileAttachment[]}
     */
    attachments: [],
    /**
     * @type {Record<string, import('./chats.js').FileAttachment[]>}
     */
    character_attachments: {},
    /**
     * @type {string[]}
     */
    disabled_attachments: [],
    gallery: {
        /** @type {{[characterKey: string]: string}} */
        folders: {},
        /** @type {string} */
        sort: 'dateAsc',
    },
};

function showHideExtensionsMenu() {
    // Get the number of menu items that are not hidden
    const hasMenuItems = $('#extensionsMenu').children().filter((_, child) => $(child).css('display') !== 'none').length > 0;

    // We have menu items, so we can stop checking
    if (hasMenuItems) {
        clearInterval(menuInterval);
    }

    // Show or hide the menu button
    $('#extensionsMenuButton').toggle(hasMenuItems);
}

// Periodically check for new extensions
const menuInterval = setInterval(showHideExtensionsMenu, 1000);

/**
 * Gets the type of an extension based on its external ID.
 * @param {string} externalId External ID of the extension (excluding or including the leading 'third-party/')
 * @returns {string} Type of the extension (global, local, system, or empty string if not found)
 */
function getExtensionType(externalId) {
    const id = Object.keys(extensionTypes).find(id => id === externalId || (id.startsWith('third-party') && id.endsWith(externalId)));
    return id ? extensionTypes[id] : '';
}

/**
 * Performs a fetch of the Extras API.
 * @param {string|URL} endpoint Extras API endpoint
 * @param {RequestInit} args Request arguments
 * @returns {Promise<Response>} Response from the fetch
 */
export async function doExtrasFetch(endpoint, args = {}) {
    if (!args) {
        args = {};
    }

    if (!args.method) {
        Object.assign(args, { method: 'GET' });
    }

    if (!args.headers) {
        args.headers = {};
    }

    if (extension_settings.apiKey) {
        Object.assign(args.headers, {
            'Authorization': `Bearer ${extension_settings.apiKey}`,
        });
    }

    return await fetch(endpoint, args);
}

/**
 * Discovers extensions from the API.
 * @returns {Promise<{name: string, type: string}[]>}
 */
async function discoverExtensions() {
    try {
        const response = await fetch('/api/extensions/discover');

        if (response.ok) {
            const extensions = await response.json();
            return extensions;
        } else {
            return [];
        }
    } catch (err) {
        console.error(err);
        return [];
    }
}

function onDisableExtensionClick() {
    const name = $(this).data('name');
    disableExtension(name, false);
}

function onEnableExtensionClick() {
    const name = $(this).data('name');
    enableExtension(name, false);
}

/**
 * Checks whether an extension has a specific hook defined in its manifest.
 * @param {string} name Extension name (with or without 'third-party' prefix)
 * @param {'install' | 'update' | 'delete' | 'clean' | 'enable' | 'disable' | 'activate'} hookName The hook to check
 * @returns {boolean}
 */
function hasExtensionHook(name, hookName) {
    const fullName = name.startsWith('third-party') ? name : `third-party${name}`;
    const manifest = manifests[fullName];
    if (!manifest || !manifest.hooks || typeof manifest.hooks !== 'object') {
        return false;
    }
    const hookFunctionName = manifest.hooks[hookName];
    return typeof hookFunctionName === 'string' && hookFunctionName.length > 0;
}

/**
 * Calls a manifest hook for an extension.
 * Hooks are optional function names exported from the extension's JS entry point module.
 * The hook function can optionally return a Promise that will be awaited.
 * @param {string} name Extension name
 * @param {'install' | 'update' | 'delete' | 'clean' | 'enable' | 'disable' | 'activate'} hookName The hook to call
 * @returns {Promise<void>}
 */
async function callExtensionHook(name, hookName) {
    const manifest = manifests[name];

    if (!manifest) {
        console.debug(`callExtensionHook: Extension "${name}" has no manifest, skipping hook "${hookName}"`);
        return;
    }

    if (!manifest.hooks || typeof manifest.hooks !== 'object') {
        return;
    }

    if (!Object.hasOwn(manifest.hooks, hookName)) {
        return;
    }

    const hookFunctionName = manifest.hooks[hookName];

    if (typeof hookFunctionName !== 'string' || !hookFunctionName) {
        console.warn(`callExtensionHook: Extension "${name}" hook "${hookName}" is not a valid string`);
        return;
    }

    if (!manifest.js) {
        console.warn(`callExtensionHook: Extension "${name}" has hook "${hookName}" but no JS entry point defined in manifest`);
        return;
    }

    const url = `/scripts/extensions/${name}/${manifest.js}`;
    console.debug(`callExtensionHook: Calling hook "${hookName}" (function "${hookFunctionName}") for extension "${name}"`);

    try {
        const module = await import(url);

        if (typeof module[hookFunctionName] !== 'function') {
            console.warn(`callExtensionHook: Extension "${name}" hook "${hookName}" references "${hookFunctionName}" which is not an exported function`);
            return;
        }

        const hookCallResult = module[hookFunctionName]();

        const HOOK_TIMEOUT = 5000;
        const HOOK_RESULT = {
            OK: 'ok',
            TIMEOUT: 'timeout',
        };

        const result = await Promise.race([
            (hookCallResult instanceof Promise ? hookCallResult : Promise.resolve(hookCallResult)).then(() => HOOK_RESULT.OK),
            delay(HOOK_TIMEOUT).then(() => HOOK_RESULT.TIMEOUT),
        ]);

        if (result === HOOK_RESULT.TIMEOUT) {
            console.warn(`callExtensionHook: Hook "${hookName}" for extension "${name}" timed out after ${HOOK_TIMEOUT}ms`);
        } else {
            console.debug(`callExtensionHook: Hook "${hookName}" completed for extension "${name}"`);
        }
    } catch (error) {
        console.error(`callExtensionHook: Error calling hook "${hookName}" for extension "${name}":`, error);
    }
}

/**
 * Enables an extension by name.
 * @param {string} name Extension name
 * @param {boolean} [reload=true] If true, reload the page after enabling the extension
 */
export async function enableExtension(name, reload = true) {
    await callExtensionHook(name, 'enable');
    extension_settings.disabledExtensions = extension_settings.disabledExtensions.filter(x => x !== name);
    stateChanged = true;
    await saveSettings();
    if (reload) {
        location.reload();
    } else {
        requiresReload = true;
    }
}

/**
 * Disables an extension by name.
 * @param {string} name Extension name
 * @param {boolean} [reload=true] If true, reload the page after disabling the extension
 */
export async function disableExtension(name, reload = true) {
    await callExtensionHook(name, 'disable');
    extension_settings.disabledExtensions.push(name);
    stateChanged = true;
    await saveSettings();
    if (reload) {
        location.reload();
    } else {
        requiresReload = true;
    }
}

/**
 * Finds an extension by name, allowing omission of the "third-party/" prefix.
 *
 * @param {string} name - The name of the extension to find
 * @returns {{name: string, enabled: boolean}|null} Object with name and enabled properties, or null if not found
 */
export function findExtension(name) {
    const internalExtensionName = extensionNames.find(extName => {
        return equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`);
    });
    if (!internalExtensionName) return null;
    const isEnabled = !extension_settings.disabledExtensions.includes(internalExtensionName);
    return { name: internalExtensionName, enabled: isEnabled };
}

/**
 * Returns a deep clone of the manifest for the given extension name.
 * Accepts either the short name (e.g. `SillyTavern-MyExtension`) or the full internal key
 * (e.g. `third-party/SillyTavern-MyExtension`). Returns null if the extension is not found.
 * @param {string} name - Extension name or internal key
 * @returns {object|null} Cloned manifest object, or null if not found
 */
export function getExtensionManifest(name) {
    const found = extensionNames.find(extName =>
        equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`),
    );
    const manifest = found ? manifests[found] : null;
    return manifest ? structuredClone(manifest) : null;
}

/**
 * Loads manifest.json files for extensions.
 * @param {string[]} names Array of extension names
 * @returns {Promise<Record<string, object>>} Object with extension names as keys and their manifests as values
 */
async function getManifests(names) {
    const obj = {};
    const promises = [];

    for (const name of names) {
        const promise = new Promise((resolve, reject) => {
            fetch(`/scripts/extensions/${name}/manifest.json`).then(async response => {
                if (response.ok) {
                    const json = await response.json();
                    obj[name] = json;
                    resolve();
                } else {
                    reject();
                }
            }).catch(err => {
                reject();
                console.log('Could not load manifest.json for ' + name, err);
            });
        });

        promises.push(promise);
    }

    await Promise.allSettled(promises);
    return obj;
}

/**
 * Tries to activate all available extensions that are not already active.
 * @returns {Promise<void>}
 */
async function activateExtensions() {
    extensionLoadErrors.clear();
    const clientVersion = CLIENT_VERSION.split(':')[1];
    const extensions = Object.entries(manifests).sort((a, b) => sortManifestsByOrder(a[1], b[1]));
    const extensionNames = extensions.map(x => x[0]);
    const promises = [];

    for (let entry of extensions) {
        const name = entry[0];
        const manifest = entry[1];
        const extrasRequirements = manifest.requires;
        const extensionDependencies = manifest.dependencies;
        const minClientVersion = manifest.minimum_client_version;
        const displayName = manifest.display_name || name;

        if (activeExtensions.has(name)) {
            continue;
        }
        // Client version requirement: pass if 'minimum_client_version' is undefined or null.
        let meetsClientMinimumVersion = true;
        if (minClientVersion !== undefined) {
            meetsClientMinimumVersion = versionCompare(clientVersion, minClientVersion);
        }

        // Module requirements: pass if 'requires' is undefined, null, or not an array; check subset if it's an array
        let meetsModuleRequirements = true;
        let missingModules = [];
        if (extrasRequirements !== undefined) {
            if (Array.isArray(extrasRequirements)) {
                meetsModuleRequirements = isSubsetOf(modules, extrasRequirements);
                missingModules = extrasRequirements.filter(req => !modules.includes(req));
            } else {
                console.warn(`Extension ${name}: manifest.json 'requires' field is not an array. Loading allowed, but any intended requirements were not verified to exist.`);
            }
        }

        // Extension dependencies: pass if 'dependencies' is undefined or not an array; check subset and disabled status if it's an array
        let meetsExtensionDeps = true;
        let missingDependencies = [];
        let disabledDependencies = [];
        if (extensionDependencies !== undefined) {
            if (Array.isArray(extensionDependencies)) {
                // Check if all dependencies exist
                meetsExtensionDeps = isSubsetOf(extensionNames, extensionDependencies);
                missingDependencies = extensionDependencies.filter(dep => !extensionNames.includes(dep));
                // Check for disabled dependencies
                if (meetsExtensionDeps) {
                    disabledDependencies = extensionDependencies.filter(dep => extension_settings.disabledExtensions.includes(dep));
                    if (disabledDependencies.length > 0) {
                        // Fail if any dependencies are disabled
                        meetsExtensionDeps = false;
                    }
                }
            } else {
                console.warn(`Extension ${name}: manifest.json 'dependencies' field is not an array. Loading allowed, but any intended requirements were not verified to exist.`);
            }
        }

        const isDisabled = extension_settings.disabledExtensions.includes(name);

        if (meetsModuleRequirements && meetsExtensionDeps && meetsClientMinimumVersion && !isDisabled) {
            try {
                console.debug('Activating extension', name);
                const promise = addExtensionLocale(name, manifest).finally(() =>
                    Promise.all([addExtensionScript(name, manifest), addExtensionStyle(name, manifest)]),
                );
                await promise
                    .then(() => {
                        activeExtensions.add(name);
                        return callExtensionHook(name, 'activate');
                    })
                    .catch(err => {
                        console.log('Could not activate extension', name, err);
                        extensionLoadErrors.add(t`Extension "${displayName}" failed to load: ${err}`);
                    });
                promises.push(promise);
            } catch (error) {
                console.error('Could not activate extension', name, error);
            }
        } else if (!meetsModuleRequirements && !isDisabled) {
            console.warn(t`Extension "${name}" did not load. Missing required Extras module(s): "${missingModules.join(', ')}"`);
            extensionLoadErrors.add(t`Extension "${displayName}" did not load. Missing required Extras module(s): "${missingModules.join(', ')}"`);
        } else if (!meetsExtensionDeps && !isDisabled) {
            if (disabledDependencies.length > 0) {
                console.warn(t`Extension "${name}" did not load. Required extensions exist but are disabled: "${disabledDependencies.join(', ')}". Enable them first, then reload.`);
                extensionLoadErrors.add(t`Extension "${displayName}" did not load. Required extensions exist but are disabled: "${disabledDependencies.join(', ')}". Enable them first, then reload.`);
            } else {
                console.warn(t`Extension "${name}" did not load. Missing required extensions: "${missingDependencies.join(', ')}"`);
                extensionLoadErrors.add(t`Extension "${displayName}" did not load. Missing required extensions: "${missingDependencies.join(', ')}"`);
            }
        } else if (!meetsClientMinimumVersion && !isDisabled) {
            console.warn(t`Extension "${name}" did not load. Requires ST client version ${minClientVersion}, but current version is ${clientVersion}.`);
            extensionLoadErrors.add(t`Extension "${displayName}" did not load. Requires ST client version ${minClientVersion}, but current version is ${clientVersion}.`);
        }
    }

    await Promise.allSettled(promises);
    $('#extensions_details').toggleClass('warning', extensionLoadErrors.size > 0);
}

async function connectClickHandler() {
    const baseUrl = String($('#extensions_url').val());
    extension_settings.apiUrl = baseUrl;
    const testApiKey = $('#extensions_api_key').val();
    extension_settings.apiKey = String(testApiKey);
    saveSettingsDebounced();
    await connectToApi(baseUrl);
}

function autoConnectInputHandler() {
    const value = $(this).prop('checked');
    extension_settings.autoConnect = !!value;

    if (value && !connectedToApi) {
        $('#extensions_connect').trigger('click');
    }

    saveSettingsDebounced();
}

async function addExtensionsButtonAndMenu() {
    const buttonHTML = await renderTemplateAsync('wandButton');
    const extensionsMenuHTML = await renderTemplateAsync('wandMenu');

    $(document.body).append(extensionsMenuHTML);
    $('#leftSendForm').append(buttonHTML);

    const button = $('#extensionsMenuButton');
    const dropdown = $('#extensionsMenu');
    let isDropdownVisible = false;

    let popper = Popper.createPopper(button.get(0), dropdown.get(0), {
        placement: 'top-start',
    });

    $(button).on('click', function () {
        if (isDropdownVisible) {
            dropdown.fadeOut(animation_duration);
            isDropdownVisible = false;
        } else {
            dropdown.fadeIn(animation_duration);
            isDropdownVisible = true;
        }
        popper.update();
    });

    $('html').on('click', function (e) {
        if (!isDropdownVisible) return;
        const clickTarget = $(e.target);
        const noCloseTargets = ['#sd_gen', '#extensionsMenuButton', '#roll_dice'];
        if (!noCloseTargets.some(id => clickTarget.closest(id).length > 0)) {
            dropdown.fadeOut(animation_duration);
            isDropdownVisible = false;
        }
    });
}

function notifyUpdatesInputHandler() {
    extension_settings.notifyUpdates = !!$('#extensions_notify_updates').prop('checked');
    saveSettingsDebounced();

    if (extension_settings.notifyUpdates) {
        checkForExtensionUpdates(true);
    }
}

/**
 * Connects to the Extras API.
 * @param {string} baseUrl Extras API base URL
 * @returns {Promise<void>}
 */
async function connectToApi(baseUrl) {
    if (!baseUrl) {
        return;
    }

    const url = new URL(baseUrl);
    url.pathname = '/api/modules';

    try {
        const getExtensionsResult = await doExtrasFetch(url);

        if (getExtensionsResult.ok) {
            const data = await getExtensionsResult.json();
            modules = data.modules;
            await activateExtensions();
            await eventSource.emit(event_types.EXTRAS_CONNECTED, modules);
        }

        updateStatus(getExtensionsResult.ok);
    } catch {
        updateStatus(false);
    }
}

/**
 * Updates the status of Extras API connection.
 * @param {boolean} success Whether the connection was successful
 */
function updateStatus(success) {
    connectedToApi = success;
    const _text = success ? t`Connected to API` : t`Could not connect to API`;
    const _class = success ? 'success' : 'failure';
    $('#extensions_status').text(_text);
    $('#extensions_status').attr('class', _class);
}

/**
 * Adds a CSS file for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Extension manifest
 * @returns {Promise<void>} When the CSS is loaded
 */
function addExtensionStyle(name, manifest) {
    if (!manifest.css) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const url = `/scripts/extensions/${name}/${manifest.css}`;
        const id = sanitizeSelector(`${name}-css`);

        if ($(`link[id="${id}"]`).length === 0) {
            const link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            link.type = 'text/css';
            link.href = url;
            link.onload = function () {
                resolve();
            };
            link.onerror = function (e) {
                reject(e);
            };
            document.head.appendChild(link);
        }
    });
}

/**
 * Loads a JS file for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Extension manifest
 * @returns {Promise<void>} When the script is loaded
 */
function addExtensionScript(name, manifest) {
    if (!manifest.js) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const url = `/scripts/extensions/${name}/${manifest.js}`;
        const id = sanitizeSelector(`${name}-js`);
        let ready = false;

        if ($(`script[id="${id}"]`).length === 0) {
            const script = document.createElement('script');
            script.id = id;
            script.type = 'module';
            script.src = url;
            script.async = true;
            script.onerror = function (err) {
                reject(err);
            };
            script.onload = function () {
                if (!ready) {
                    ready = true;
                    resolve();
                }
            };
            document.body.appendChild(script);
        }
    });
}

/**
 * Adds a localization data for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Manifest object
 */
function addExtensionLocale(name, manifest) {
    // No i18n data in the manifest
    if (!manifest.i18n || typeof manifest.i18n !== 'object') {
        return Promise.resolve();
    }

    const currentLocale = getCurrentLocale();
    const localeFile = manifest.i18n[currentLocale];

    // Manifest doesn't provide a locale file for the current locale
    if (!localeFile) {
        return Promise.resolve();
    }

    return fetch(`/scripts/extensions/${name}/${localeFile}`)
        .then(async response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (data && typeof data === 'object') {
                addLocaleData(currentLocale, data);
            }
        })
        .catch(err => {
            console.log('Could not load extension locale data for ' + name, err);
        });
}

/**
 * Generates an element for displaying an extension in the UI.
 *
 * @param {string} name - The name of the extension.
 * @param {object} manifest - The manifest of the extension.
 * @param {boolean} isActive - Whether the extension is active or not.
 * @param {boolean} isDisabled - Whether the extension is disabled or not.
 * @param {boolean} isExternal - Whether the extension is external or not.
 * @param {string} checkboxClass - The class for the checkbox HTML element.
 * @return {HTMLElement} - The element that represents the extension.
 */
function generateExtensionElement(name, manifest, isActive, isDisabled, isExternal, checkboxClass) {
    function getExtensionIcon() {
        const type = getExtensionType(name);
        const icon = document.createElement('i');
        icon.classList.add('fa-sm', 'fa-fw', 'fa-solid');
        switch (type) {
            case 'global':
                icon.classList.add('fa-server');
                icon.title = t`This is a global extension, available for all users.`;
                break;
            case 'local':
                icon.classList.add('fa-user');
                icon.title = t`This is a local extension, available only for you.`;
                break;
            case 'system':
                icon.classList.add('fa-cog');
                icon.title = t`This is a built-in extension. It cannot be deleted and updates with the app.`;
                break;
            default:
                icon.classList.add('fa-question');
                icon.title = t`Unknown extension type.`;
                break;
        }
        return icon;
    }

    const isUserAdmin = isAdmin();
    const displayName = manifest.display_name;
    const displayVersion = manifest.version || '';
    const externalId = name.replace('third-party', '');

    // Root block
    const block = document.createElement('div');
    block.classList.add('extension_block');
    block.dataset.name = externalId;

    // Toggle
    const toggleDiv = document.createElement('div');
    toggleDiv.classList.add('extension_toggle');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.dataset.name = name;
    if (isActive || isDisabled) {
        toggle.title = t`Click to toggle`;
        toggle.classList.add(isActive ? 'toggle_disable' : 'toggle_enable');
        if (checkboxClass) toggle.classList.add(checkboxClass);
        toggle.checked = isActive;
    } else {
        toggle.title = t`Cannot enable extension`;
        toggle.classList.add('extension_missing');
        if (checkboxClass) toggle.classList.add(checkboxClass);
        toggle.disabled = true;
    }
    toggleDiv.appendChild(toggle);
    block.appendChild(toggleDiv);

    // Icon
    const iconDiv = document.createElement('div');
    iconDiv.classList.add('extension_icon');
    iconDiv.appendChild(getExtensionIcon());
    block.appendChild(iconDiv);

    // Text block
    const textBlock = document.createElement('div');
    textBlock.classList.add('flexGrow', 'extension_text_block');

    const statusSpan = document.createElement('span');
    statusSpan.className = isActive ? 'extension_enabled' : isDisabled ? 'extension_disabled' : 'extension_missing';

    const nameSpan = document.createElement('span');
    nameSpan.classList.add('extension_name');
    nameSpan.textContent = displayName;

    const authorSpan = document.createElement('span');
    authorSpan.classList.add('extension_author');

    const versionSpan = document.createElement('span');
    versionSpan.classList.add('extension_version');
    versionSpan.textContent = displayVersion;

    statusSpan.append(nameSpan, authorSpan, versionSpan);

    if (isActive && Array.isArray(manifest.optional)) {
        const optional = new Set(manifest.optional);
        modules.forEach(x => optional.delete(x));
        if (optional.size > 0) {
            const modulesDiv = document.createElement('div');
            modulesDiv.classList.add('extension_modules');
            const optionalSpan = document.createElement('span');
            optionalSpan.classList.add('optional');
            optionalSpan.textContent = [...optional].join(', ');
            modulesDiv.append(t`Optional modules:`, ' ', optionalSpan);
            statusSpan.appendChild(modulesDiv);
        }
    } else if (!isDisabled) {
        // Neither active nor disabled
        const requirements = new Set(manifest.requires);
        modules.forEach(x => requirements.delete(x));
        if (requirements.size > 0) {
            const modulesDiv = document.createElement('div');
            modulesDiv.classList.add('extension_modules');
            const failureSpan = document.createElement('span');
            failureSpan.classList.add('failure');
            failureSpan.textContent = [...requirements].join(', ');
            modulesDiv.append(t`Missing modules:`, ' ', failureSpan);
            statusSpan.appendChild(modulesDiv);
        }
    }

    // if external, wrap the name in a link to the repo
    if (isExternal) {
        const originLink = document.createElement('a');
        originLink.appendChild(statusSpan);
        textBlock.appendChild(originLink);
    } else {
        textBlock.appendChild(statusSpan);
    }

    block.appendChild(textBlock);

    // Actions
    const actionsDiv = document.createElement('div');
    actionsDiv.classList.add('extension_actions', 'flex-container', 'alignItemsCenter');

    /**
     * Helper function to create an action button for an extension.
     * @param {string} cls Class name
     * @param {string} dataName Name of the extension
     * @param {string} title Title of the button
     * @param {string} iconClasses Classes for the icon
     * @returns {HTMLButtonElement} The created button element
     */
    function makeActionButton(cls, dataName, title, iconClasses) {
        const btn = document.createElement('button');
        btn.classList.add(cls, 'menu_button');
        btn.dataset.name = dataName;
        btn.title = title;
        const icon = document.createElement('i');
        icon.classList.add(...iconClasses.split(' '));
        btn.appendChild(icon);
        return btn;
    }

    if (isExternal) {
        const updateBtn = makeActionButton('btn_update', externalId, t`Update available`, 'fa-solid fa-download fa-fw');
        updateBtn.classList.add('displayNone');
        actionsDiv.appendChild(updateBtn);
    }

    if (isExternal && hasExtensionHook(externalId, 'clean')) {
        actionsDiv.appendChild(makeActionButton('btn_clean', externalId,  t`Clean extension data`, 'fa-fw fa-solid fa-broom'));
    }

    if (isExternal && isUserAdmin) {
        actionsDiv.appendChild(makeActionButton('btn_branch', externalId, t`Switch branch`, 'fa-solid fa-code-branch fa-fw'));
        actionsDiv.appendChild(makeActionButton('btn_move', externalId, t`Move`, 'fa-solid fa-folder-tree fa-fw'));
    }

    if (isExternal) {
        actionsDiv.appendChild(makeActionButton('btn_delete', externalId, t`Delete`, 'fa-fw fa-solid fa-trash-can'));
    }

    block.appendChild(actionsDiv);

    return block;
}

/**
 * Gets extension data and generates the corresponding element for displaying the extension.
 *
 * @param {Array} extension - An array where the first element is the extension name and the second element is the extension manifest.
 * @return {{name: string, isExternal: boolean, extensionElement: HTMLElement}} Extension display data.
 */
function getExtensionData(extension) {
    const name = extension[0];
    const manifest = extension[1];
    const isActive = activeExtensions.has(name);
    const isDisabled = extension_settings.disabledExtensions.includes(name);
    const isExternal = name.startsWith('third-party');

    const checkboxClass = isDisabled ? 'checkbox_disabled' : '';
    const extensionElement = generateExtensionElement(name, manifest, isActive, isDisabled, isExternal, checkboxClass);

    return { name, isExternal, extensionElement };
}


/**
 * Gets the module information to be displayed.
 *
 * @return {HTMLElement} - The element containing the module information.
 */
function getModuleInformation() {
    const container = document.createElement('div');

    const heading = document.createElement('h3');
    heading.textContent = 'Worker API capabilities:';
    container.appendChild(heading);

    const moduleInfo = document.createElement('p');
    if (modules.length) {
        moduleInfo.textContent = modules.join(', ');
    } else {
        moduleInfo.classList.add('failure');
        moduleInfo.textContent = 'Worker API capabilities are unavailable.';
    }
    container.appendChild(moduleInfo);

    return container;
}

async function getServerlessExtensionIntegrations() {
    try {
        const response = await fetch('/api/extensions/catalog');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const catalog = await response.json();
        return Object.fromEntries((catalog.builtIn ?? []).map(extension => [extension.name, extension.integration]));
    } catch (error) {
        console.warn('Could not load the serverless extension catalog', error);
        return FALLBACK_EXTENSION_INTEGRATIONS;
    }
}

/**
 * Generates HTMLElement for the extension load errors.
 * @returns {HTMLElement} - The element containing the extension load errors.
 */
function getExtensionLoadErrors() {
    if (extensionLoadErrors.size === 0) {
        return document.createElement('div');
    }

    const container = document.createElement('div');
    container.classList.add('info-block', 'error');

    for (const error of extensionLoadErrors) {
        const errorElement = document.createElement('div');
        errorElement.textContent = error;
        container.appendChild(errorElement);
    }

    return container;
}

/**
 * Generates the HTML strings for all extensions and displays them in a popup.
 */
async function showExtensionsDetails() {
    let popupPromise;
    try {
        let initialScrollTop = 0;
        const oldPopup = Popup.util.popups.find(popup => popup.content.querySelector('.extensions_info'));
        if (oldPopup) {
            initialScrollTop = oldPopup.content.scrollTop;
            await oldPopup.completeCancelled();
        }
        const errors = getExtensionLoadErrors();

        const defaultContainer = document.createElement('div');
        defaultContainer.classList.add('marginBot10');
        const defaultHeading = document.createElement('h3');
        defaultHeading.textContent = 'Bundled browser extensions:';
        defaultContainer.appendChild(defaultHeading);

        const workerApiContainer = document.createElement('div');
        workerApiContainer.classList.add('marginBot10');
        const workerApiHeading = document.createElement('h3');
        workerApiHeading.textContent = 'Built-in API integrations:';
        workerApiContainer.appendChild(workerApiHeading);

        const externalApiContainer = document.createElement('div');
        externalApiContainer.classList.add('info-block', 'hint', 'marginBot10');
        const externalApiHeading = document.createElement('h3');
        externalApiHeading.classList.add('margin0');
        externalApiHeading.textContent = 'External API extensions';
        const externalApiEmpty = document.createElement('p');
        externalApiEmpty.textContent = 'No external API extension is connected yet. Runtime Git installation is disabled; future extensions will be declared remote API integrations.';
        externalApiContainer.append(externalApiHeading, externalApiEmpty);

        const sortOrderKey = 'extensions_sortByName';
        const sortByName = accountStorage.getItem(sortOrderKey) === 'true';
        const sortFn = sortByName ? sortManifestsByName : sortManifestsByOrder;
        const integrations = await getServerlessExtensionIntegrations();
        const extensions = Object.entries(manifests).sort((a, b) => sortFn(a[1], b[1])).map(getExtensionData);

        extensions.forEach(value => {
            const { name, isExternal, extensionElement } = value;
            if (isExternal) return;
            const container = integrations[name] === 'worker-api' ? workerApiContainer : defaultContainer;
            container.appendChild(extensionElement);
        });

        const extensionsMenu = $('<div></div>')
            .addClass('extensions_info')
            .append(errors)
            .append(defaultContainer)
            .append(workerApiContainer)
            .append(externalApiContainer)
            .append(getModuleInformation());

        let waitingForSave = false;

        const popup = new Popup(extensionsMenu, POPUP_TYPE.TEXT, '', {
            okButton: t`Close`,
            wide: true,
            large: true,
            customButtons: [],
            allowVerticalScrolling: true,
            onClosing: async () => {
                if (waitingForSave) {
                    return false;
                }

                if (stateChanged) {
                    waitingForSave = true;
                    const toast = toastr.info(t`The page will be reloaded shortly...`, t`Extensions state changed`);
                    await saveSettings();
                    toastr.clear(toast);
                    waitingForSave = false;
                    requiresReload = true;
                }

                return true;
            },
        });
        popupPromise = popup.show();
        popup.content.scrollTop = initialScrollTop;
    } catch (error) {
        toastr.error(t`Error loading extensions. See browser console for details.`);
        console.error(error);
    }
    if (popupPromise) {
        await popupPromise;
    }
    if (requiresReload) {
        location.reload();
    }
}

/**
 * Handles the click event for the update button of an extension.
 * This function makes a POST request to '/api/extensions/update' with the extension's name.
 * If the extension is already up to date, it displays a success message.
 * If the extension is not up to date, it updates the extension and displays a success message with the new commit hash.
 */
async function onUpdateClick() {
    const isCurrentUserAdmin = isAdmin();
    const extensionName = $(this).data('name');
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to update global extensions.`);
        return;
    }

    const icon = $(this).find('i');
    icon.addClass('fa-spin');
    await updateExtension(extensionName, false);
    // updateExtension eats the error, but we can at least stop the spinner
    icon.removeClass('fa-spin');
}

/**
 * Updates a third-party extension via the API.
 * @param {string} extensionName Extension folder name
 * @param {boolean} quiet If true, don't show a success message
 * @param {number?} timeout Timeout in milliseconds to wait for the update to complete. If null, no timeout is set.
 */
async function updateExtension(extensionName, quiet, timeout = null) {
    try {
        const signal = timeout ? AbortSignal.timeout(timeout) : undefined;
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            signal: signal,
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension update failed`, { timeOut: 5000 });
            console.error('Extension update failed', response.status, response.statusText, text);
            return;
        }

        const data = await response.json();

        if (!quiet) {
            void showExtensionsDetails();
        }

        if (data.isUpToDate) {
            if (!quiet) {
                toastr.success('Extension is already up to date');
            }
        } else {
            const fullExtensionName = extensionName.startsWith('third-party') ? extensionName : `third-party${extensionName}`;
            await callExtensionHook(fullExtensionName, 'update');
            toastr.success(t`Extension ${extensionName} updated to ${data.shortCommitHash}`, t`Reload the page to apply updates`);
        }
    } catch (error) {
        console.error('Extension update error:', error);
    }
}

/**
 * Handles the click event for the delete button of an extension.
 * This function makes a POST request to '/api/extensions/delete' with the extension's name.
 * If the extension is deleted, it displays a success message.
 * Creates a popup for the user to confirm before delete.
 * If the extension has a 'clean' hook, an optional checkbox to also run the cleanup is shown.
 */
async function onDeleteClick() {
    const extensionName = $(this).data('name');
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to delete global extensions.`);
        return;
    }

    const hasCleanHook = hasExtensionHook(extensionName, 'clean');

    /** @type {import('./popup.js').CustomPopupInput[]} */
    const customInputs = hasCleanHook ? [{ id: 'extension_delete_cleanup', label: t`Also clean up extension data`, defaultState: false }] : null;

    const popup = new Popup(t`Are you sure you want to delete ${escapeHtml(extensionName)}?`, POPUP_TYPE.CONFIRM, '', { customInputs });
    const confirmation = await popup.show();
    if (confirmation === POPUP_RESULT.AFFIRMATIVE) {
        const shouldClean = hasCleanHook && Boolean(popup.inputResults?.get('extension_delete_cleanup'));
        await deleteExtension(extensionName, shouldClean);
    }
}

/**
 * Handles the click event for the clean button of an extension.
 * Runs the extension's 'clean' hook after user confirmation, then reloads the page.
 */
async function onCleanClick() {
    const extensionName = $(this).data('name');

    const confirmation = await Popup.show.confirm(t`Clean extension data`, t`Are you sure you want to clean up data for ${escapeHtml(extensionName)}? This action cannot be undone.`);
    if (!confirmation) {
        return;
    }

    await cleanExtension(extensionName);
}

/**
 * Runs the 'clean' hook for an extension and reloads the page.
 * @param {string} extensionName Extension name (without 'third-party' prefix)
 * @returns {Promise<void>}
 */
async function cleanExtension(extensionName) {
    const fullExtensionName = extensionName.startsWith('third-party') ? extensionName : `third-party${extensionName}`;
    await callExtensionHook(fullExtensionName, 'clean');

    // Clean might have updated settings, which could race with the page reload, so we'll force save here
    await saveSettings();

    toastr.success(t`Extension ${extensionName} data cleaned`);
    delay(1000).then(() => location.reload());
}

async function onBranchClick() {
    const extensionName = $(this).data('name');
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to switch branch.`);
        return;
    }

    let newBranch = '';

    const branches = await getExtensionBranches(extensionName, isGlobal);
    const selectElement = document.createElement('select');
    selectElement.classList.add('text_pole', 'wide100p');
    selectElement.addEventListener('change', function () {
        newBranch = this.value;
    });
    for (const branch of branches) {
        const option = document.createElement('option');
        option.value = branch.name;
        option.textContent = `${branch.name} (${branch.commit}) [${branch.label}]`;
        option.selected = branch.current;
        selectElement.appendChild(option);
    }

    const popup = new Popup(selectElement, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Switch`,
        cancelButton: t`Cancel`,
    });
    const popupResult = await popup.show();

    if (!popupResult || !newBranch) {
        return;
    }

    await switchExtensionBranch(extensionName, isGlobal, newBranch);
}

async function onMoveClick() {
    const extensionName = $(this).data('name');
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to move extensions.`);
        return;
    }

    const source = getExtensionType(extensionName);
    const destination = source === 'global' ? 'local' : 'global';

    const confirmationHeader = t`Move extension`;
    const confirmationText = source == 'global'
        ? t`Are you sure you want to move ${escapeHtml(extensionName)} to your local extensions? This will make it available only for you.`
        : t`Are you sure you want to move ${escapeHtml(extensionName)} to the global extensions? This will make it available for all users.`;

    const confirmation = await Popup.show.confirm(confirmationHeader, confirmationText);

    if (!confirmation) {
        return;
    }

    $(this).find('i').addClass('fa-spin');
    await moveExtension(extensionName, source, destination);
}

/**
 * Moves an extension via the API.
 * @param {string} extensionName Extension name
 * @param {string} source Source type
 * @param {string} destination Destination type
 * @returns {Promise<void>}
 */
async function moveExtension(extensionName, source, destination) {
    try {
        const result = await fetch('/api/extensions/move', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                source,
                destination,
            }),
        });

        if (!result.ok) {
            const text = await result.text();
            toastr.error(text || result.statusText, t`Extension move failed`, { timeOut: 5000 });
            console.error('Extension move failed', result.status, result.statusText, text);
            return;
        }

        toastr.success(t`Extension ${extensionName} moved.`);
        await loadExtensionSettings({}, false, false);
        void showExtensionsDetails();
    } catch (error) {
        console.error('Error:', error);
    }
}

/**
 * Deletes an extension via the API.
 * @param {string} extensionName Extension name to delete
 * @param {boolean} [shouldClean=false] Whether to also run the 'clean' hook before deleting
 */
export async function deleteExtension(extensionName, shouldClean = false) {
    const fullExtensionName = extensionName.startsWith('third-party') ? extensionName : `third-party${extensionName}`;

    if (shouldClean) {
        await callExtensionHook(fullExtensionName, 'clean');
    }

    await callExtensionHook(fullExtensionName, 'delete');

    try {
        await fetch('/api/extensions/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
        });
    } catch (error) {
        console.error('Error:', error);
    }

    // Delete or clean might have updated settings, which could race with the page reload, so we'll force save here
    await saveSettings();

    toastr.success(t`Extension ${extensionName} deleted`);
    delay(1000).then(() => location.reload());
}

/**
 * Fetches the version details of a specific extension.
 *
 * @param {string} extensionName - The name of the extension.
 * @param {AbortSignal} [abortSignal] - The signal to abort the operation.
 * @return {Promise<object>} - An object containing the extension's version details.
 * This object includes the currentBranchName, currentCommitHash, isUpToDate, and remoteUrl.
 * @throws {error} - If there is an error during the fetch operation, it logs the error to the console.
 */
async function getExtensionVersion(extensionName, abortSignal) {
    try {
        const response = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
            signal: abortSignal,
        });

        const data = await response.json();
        return data;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            return;
        }
        console.error('Error:', error);
    }
}

/**
 * Gets the list of branches for a specific extension.
 * @param {string} extensionName The name of the extension
 * @param {boolean} isGlobal Whether the extension is global or not
 * @returns {Promise<ExtensionBranch[]>} List of branches for the extension
 * @typedef {object} ExtensionBranch
 * @property {string} name The name of the branch
 * @property {string} commit The commit hash of the branch
 * @property {boolean} current Whether this branch is the current one
 * @property {string} label The commit label of the branch
 */
async function getExtensionBranches(extensionName, isGlobal) {
    try {
        const response = await fetch('/api/extensions/branches', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: isGlobal,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension branches fetch failed`);
            console.error('Extension branches fetch failed', response.status, response.statusText, text);
            return [];
        }

        return await response.json();
    } catch (error) {
        console.error('Error:', error);
        return [];
    }
}

/**
 * Switches the branch of an extension.
 * @param {string} extensionName The name of the extension
 * @param {boolean} isGlobal If the extension is global
 * @param {string} branch Branch name to switch to
 * @returns {Promise<void>}
 */
async function switchExtensionBranch(extensionName, isGlobal, branch) {
    try {
        const response = await fetch('/api/extensions/switch', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                branch,
                global: isGlobal,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension branch switch failed`);
            console.error('Extension branch switch failed', response.status, response.statusText, text);
            return;
        }

        toastr.success(t`Extension ${extensionName} switched to ${branch}`, t`Reload the page to apply updates`);
        await loadExtensionSettings({}, false, false);
        void showExtensionsDetails();
    } catch (error) {
        console.error('Error:', error);
    }
}

/**
 * Installs a third-party extension via the API.
 * @param {string} url Extension repository URL
 * @param {boolean} global Is the extension global?
 * @param {string} [branch] Optional branch to install, if not provided the default branch will be used
 * @returns {Promise<boolean>} True if the extension was installed successfully, false otherwise
 */
export async function installExtension(url, global, branch = '') {
    void url;
    void global;
    void branch;
    toastr.warning(
        'Runtime extension installation is disabled. Future extensions connect through declared remote APIs.',
        'Extension installation disabled',
        { timeOut: 10_000 },
    );
    return false;
}

/**
 * Loads extension settings from the app settings.
 * @param {object} settings App Settings
 * @param {boolean} versionChanged Is this a version change?
 * @param {boolean} enableAutoUpdate Enable auto-update
 */
export async function loadExtensionSettings(settings, versionChanged, enableAutoUpdate) {
    if (settings.extension_settings) {
        Object.assign(extension_settings, settings.extension_settings);
    }

    void versionChanged;
    void enableAutoUpdate;
    extension_settings.apiUrl = '';
    extension_settings.apiKey = '';
    extension_settings.autoConnect = false;
    extension_settings.notifyUpdates = false;

    // Activate offline extensions
    await eventSource.emit(event_types.EXTENSIONS_FIRST_LOAD);
    const extensions = await discoverExtensions();
    extensionNames = extensions.map(x => x.name);
    extensionTypes = Object.fromEntries(extensions.map(x => [x.name, x.type]));
    manifests = await getManifests(extensionNames);

    await connectToApi(location.origin);
    await activateExtensions();
}

export function doDailyExtensionUpdatesCheck() {
    // Runtime extension updates are intentionally disabled for immutable Pages assets.
}

const concurrencyLimit = 5;
let activeRequestsCount = 0;
const versionCheckQueue = [];

function enqueueVersionCheck(fn) {
    return new Promise((resolve, reject) => {
        versionCheckQueue.push(() => fn().then(resolve).catch(reject));
        processVersionCheckQueue();
    });
}

function processVersionCheckQueue() {
    if (activeRequestsCount >= concurrencyLimit || versionCheckQueue.length === 0) {
        return;
    }
    activeRequestsCount++;
    const fn = versionCheckQueue.shift();
    fn().finally(() => {
        activeRequestsCount--;
        processVersionCheckQueue();
    });
}

/**
 * Checks if there are updates available for enabled 3rd-party extensions.
 * @param {boolean} force Skip nag check
 * @returns {Promise<any>}
 */
async function checkForExtensionUpdates(force) {
    if (!force) {
        const STORAGE_NAG_KEY = 'extension_update_nag';
        const currentDate = new Date().toDateString();

        // Don't nag more than once a day
        if (accountStorage.getItem(STORAGE_NAG_KEY) === currentDate) {
            return;
        }

        accountStorage.setItem(STORAGE_NAG_KEY, currentDate);
    }

    const isCurrentUserAdmin = isAdmin();
    const updatesAvailable = [];
    const promises = [];

    for (const [id, manifest] of Object.entries(manifests)) {
        const isDisabled = extension_settings.disabledExtensions.includes(id);
        if (isDisabled) {
            console.debug(`Skipping extension: ${manifest.display_name} (${id}) for non-admin user`);
            continue;
        }
        const isGlobal = getExtensionType(id) === 'global';
        if (isGlobal && !isCurrentUserAdmin) {
            console.debug(`Skipping global extension: ${manifest.display_name} (${id}) for non-admin user`);
            continue;
        }

        if (manifest.auto_update && id.startsWith('third-party')) {
            const promise = enqueueVersionCheck(async () => {
                try {
                    const data = await getExtensionVersion(id.replace('third-party', ''));
                    if (!data) {
                        return;
                    }
                    if (!data.isUpToDate) {
                        updatesAvailable.push(manifest.display_name);
                    }
                } catch (error) {
                    console.error('Error checking for extension updates', error);
                }
            });
            promises.push(promise);
        }
    }

    await Promise.allSettled(promises);

    if (updatesAvailable.length > 0) {
        toastr.info(`${updatesAvailable.map(x => `• ${x}`).join('\n')}`, t`Extension updates available`);
    }
}

/**
 * Runs the generate interceptors for all extensions.
 * @param {any[]} chat Chat array
 * @param {number} contextSize Context size
 * @param {string} type Generation type
 * @returns {Promise<boolean>} True if generation should be aborted
 */
export async function runGenerationInterceptors(chat, contextSize, type) {
    let aborted = false;
    let exitImmediately = false;

    const abort = (/** @type {boolean} */ immediately) => {
        aborted = true;
        exitImmediately = immediately;
    };

    for (const manifest of Object.values(manifests).filter(x => x.generate_interceptor).sort((a, b) => sortManifestsByOrder(a, b))) {
        const interceptorKey = manifest.generate_interceptor;
        if (typeof globalThis[interceptorKey] === 'function') {
            try {
                await globalThis[interceptorKey](chat, contextSize, abort, type);
            } catch (e) {
                console.error(`Failed running interceptor for ${manifest.display_name}`, e);
            }
        }

        if (exitImmediately) {
            break;
        }
    }

    return aborted;
}

/**
 * Sentinel value that signals a field should be completely removed (unset)
 * from the character card rather than being set to any value. Pass this as
 * the `value` argument to {@link writeExtensionField} or
 * {@link writeExtensionFieldBulk} to delete the key entirely.
 *
 * Using `null` as a value will set the field to `null` (the key remains).
 * Using this sentinel will delete the key from the character card.
 * @type {string}
 */
export const UNSET_VALUE = '__@@UNSET@@__';

/**
 * Writes a field to the character's data extensions object.
 * @param {number|string} characterId Index in the character array
 * @param {string} key Field name
 * @param {any} value Field value
 * @returns {Promise<void>} When the field is written
 */
export async function writeExtensionField(characterId, key, value) {
    const context = getContext();
    const character = context.characters[characterId];
    if (!character) {
        console.warn('Character not found', characterId);
        return;
    }
    const extensionPath = `data.extensions.${key}`;
    const isUnset = value === UNSET_VALUE;

    if (isUnset) {
        deleteValueByPath(character, extensionPath);
    } else {
        setValueByPath(character, extensionPath, value);
    }

    // Process JSON data
    if (character.json_data) {
        const jsonData = JSON.parse(character.json_data);
        if (isUnset) {
            deleteValueByPath(jsonData, extensionPath);
        } else {
            setValueByPath(jsonData, extensionPath, value);
        }
        character.json_data = JSON.stringify(jsonData);

        // Make sure the data doesn't get lost when saving the current character
        if (Number(characterId) === Number(context.characterId)) {
            $('#character_json_data').val(character.json_data);
        }
    }

    // Save data to the server
    const saveDataRequest = {
        avatar: character.avatar,
        data: {
            extensions: {
                [key]: value,
            },
        },
    };
    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(saveDataRequest),
    });

    if (!mergeResponse.ok) {
        console.error('Failed to save extension field', mergeResponse.statusText);
    }
}

/**
 * @typedef {object} BulkExtensionFieldResult
 * @property {string[]} updated  Avatar filenames that were successfully updated
 * @property {string[]} skipped  Avatar filenames skipped (filter didn't match or unreadable)
 * @property {string[]} failed   Avatar filenames where the update failed
 */

/**
 * Writes (or deletes) an extension field for multiple characters in a single
 * bulk request. Unlike {@link writeExtensionField}, this sends one API call
 * for all characters, and the server processes them in parallel.
 *
 * When `value` is {@link UNSET_VALUE} the extension key is **deleted** from
 * each matching character card. Passing `null` sets the field to `null`
 * (the key is preserved).
 *
 * @param {string[]|null} avatars Avatar filenames to update. Pass `null` or an
 *   empty array to target **all** characters in the user's character directory.
 * @param {string} key Extension field name (e.g. "greeting_tools")
 * @param {any} value Field value, `null` to set null, or
 *   {@link UNSET_VALUE} to delete the key entirely
 * @param {object} [options={}] Optional settings
 * @param {string} [options.filterPath] Dot-path filter — the server will only
 *   update characters where this path is present and not `undefined`;
 *   `null` still counts as a match. Useful when the frontend has shallow
 *   character data and cannot pre-filter.
 *   Defaults to `data.extensions.<key>` when unsetting, so deletion requests
 *   automatically skip characters where the field is missing/`undefined`.
 * @returns {Promise<BulkExtensionFieldResult>} Summary of the bulk operation
 */
export async function writeExtensionFieldBulk(avatars, key, value, { filterPath } = {}) {
    const context = getContext();
    const extensionPath = `data.extensions.${key}`;
    const isUnset = value === UNSET_VALUE;

    // Build the server request
    const requestBody = {
        avatars: Array.isArray(avatars) && avatars.length > 0 ? avatars : [],
        data: {
            data: {
                extensions: {
                    [key]: value,
                },
            },
        },
    };

    // Default filter: when unsetting, only touch characters that have the field
    const resolvedFilterPath = filterPath ?? (isUnset ? extensionPath : undefined);
    if (resolvedFilterPath) {
        requestBody.filter = { path: resolvedFilterPath };
    }

    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
    });

    if (!mergeResponse.ok) {
        console.error('Bulk extension field update failed', mergeResponse.statusText);
        return { updated: [], skipped: [], failed: [] };
    }

    /** @type {BulkExtensionFieldResult} */
    const result = await mergeResponse.json();

    // Sync in-memory character objects for successfully updated characters
    const updatedSet = new Set(result.updated);
    for (const character of context.characters) {
        if (!character || !updatedSet.has(character.avatar)) continue;

        if (isUnset) {
            deleteValueByPath(character, extensionPath);
        } else {
            setValueByPath(character, extensionPath, value);
        }

        // Keep json_data in sync
        if (character.json_data) {
            const jsonData = JSON.parse(character.json_data);
            if (isUnset) {
                deleteValueByPath(jsonData, extensionPath);
            } else {
                setValueByPath(jsonData, extensionPath, value);
            }
            character.json_data = JSON.stringify(jsonData);
        }
    }

    // If the currently active character was updated, sync the hidden input
    if (context.characterId !== undefined) {
        const activeChar = context.characters[context.characterId];
        if (activeChar && updatedSet.has(activeChar.avatar) && activeChar.json_data) {
            $('#character_json_data').val(activeChar.json_data);
        }
    }

    return result;
}

/**
 * Prompts the user to enter the Git URL of the extension to import.
 * After obtaining the Git URL, makes a POST request to '/api/extensions/install' to import the extension.
 * If the extension is imported successfully, a success message is displayed.
 * If the extension import fails, an error message is displayed and the error is logged to the console.
 * After successfully importing the extension, the extension settings are reloaded and a 'EXTENSION_SETTINGS_LOADED' event is emitted.
 * @param {string} [suggestUrl] Suggested URL to install
 * @returns {Promise<void>}
 */
export async function openThirdPartyExtensionMenu(suggestUrl = '') {
    await installExtension(suggestUrl, false);
}

/**
 * Sentinel value representing an empty author, used when author information cannot be extracted from a URL.
 * @type {{name: string, url: string}}
 */
export const EMPTY_AUTHOR = Object.freeze({
    name: '',
    url: '',
});

/**
 * Extracts the repository author from a given URL.
 * @param {string} url - The URL of the repository.
 * @returns {{name: string, url: string}} Object containing the author's name and URL, or empty strings if not found.
 */
export function getAuthorFromUrl(url) {
    const result = structuredClone(EMPTY_AUTHOR);

    try {
        const parsedUrl = new URL(url);
        const pathSegments = parsedUrl.pathname.split('/').filter(s => s.length > 0);

        // TODO: Handle non-GitHub URLs if needed
        if (parsedUrl.host === 'github.com' && pathSegments.length >= 2) {
            result.name = pathSegments[0];
            result.url = `${parsedUrl.protocol}//${parsedUrl.hostname}/${result.name}`;
        }
    } catch (error) {
        console.debug('Error parsing URL:', error);
    }

    return result;
}

export async function initExtensions() {
    await addExtensionsButtonAndMenu();
    $('#extensionsMenuButton').css('display', 'flex');

    // These selectors do not exist in the serverless UI, but keeping the
    // handlers makes upstream extension code fail closed if it injects them.
    $('#extensions_connect').on('click', connectClickHandler);
    $('#extensions_autoconnect').on('input', autoConnectInputHandler);
    $('#extensions_details').on('click', showExtensionsDetails);
    $('#extensions_notify_updates').on('input', notifyUpdatesInputHandler);
    $(document).on('click', '.extensions_info .extension_block .toggle_disable', onDisableExtensionClick);
    $(document).on('click', '.extensions_info .extension_block .toggle_enable', onEnableExtensionClick);
    $(document).on('click', '.extensions_info .extension_block .btn_update', onUpdateClick);
    $(document).on('click', '.extensions_info .extension_block .btn_delete', onDeleteClick);
    $(document).on('click', '.extensions_info .extension_block .btn_clean', onCleanClick);
    $(document).on('click', '.extensions_info .extension_block .btn_move', onMoveClick);
    $(document).on('click', '.extensions_info .extension_block .btn_branch', onBranchClick);
}
