export const textgen_types = Object.freeze({ GATEWAY: 'gateway' });
export const APHRODITE_DEFAULT_ORDER = [];
export let MANCER_SERVER = '';
export let TOGETHERAI_SERVER = '';
export let INFERMATICAI_SERVER = '';
export let DREAMGEN_SERVER = '';
export let OPENROUTER_SERVER = '';
export let FEATHERLESS_SERVER = '';
export const SERVER_INPUTS = Object.freeze({});

export const textgenerationwebui_settings = {
    temp: 0.7,
    top_p: 1,
    top_k: 0,
    min_p: 0,
    rep_pen: 1,
    type: textgen_types.GATEWAY,
    preset: 'Default',
    streaming: false,
    json_schema: null,
    logit_bias: [],
    sampler_order: [],
    sampler_priority: [],
    samplers: [],
    samplers_priorities: [],
    send_banned_tokens: false,
    server_urls: {},
    extensions: {},
};

export let textgenerationwebui_banned_in_macros = [];
export let textgenerationwebui_presets = [];
export let textgenerationwebui_preset_names = [];

export const setting_names = [
    'temp', 'temperature', 'top_p', 'top_k', 'min_p', 'rep_pen', 'repetition_penalty',
    'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'json_schema',
];

export function validateTextGenUrl() { return false; }
export function getTextGenServer() { return ''; }
export function formatTextGenURL() { return ''; }

export async function loadTextGenSettings(data = {}, loadedSettings = {}) {
    const presets = data.textgenerationwebui_presets ?? [];
    textgenerationwebui_presets = presets.map(value => typeof value === 'string' ? JSON.parse(value) : value);
    textgenerationwebui_preset_names = Array.isArray(data.textgenerationwebui_preset_names)
        ? [...data.textgenerationwebui_preset_names]
        : [];
    const source = loadedSettings.textgenerationwebui_settings ?? loadedSettings;
    Object.assign(textgenerationwebui_settings, Object.fromEntries(Object.entries(source || {}).filter(([key]) => key in textgenerationwebui_settings)));
    textgenerationwebui_settings.type = textgen_types.GATEWAY;
    textgenerationwebui_settings.streaming = false;
    textgenerationwebui_settings.server_urls = {};
}

export function initTextGenSettings() {}

export async function generateTextGenWithStreaming() {
    throw new Error('Legacy text-completion endpoints were removed; use the AI Gateway text capability.');
}

export function parseTextgenLogprobs(token, logprobs) {
    if (!token || !Array.isArray(logprobs)) return null;
    return {
        token,
        topLogprobs: logprobs.map(item => ({ token: item.token ?? item.content ?? '', logprob: Number(item.logprob ?? item.probability ?? 0) })),
    };
}

export function parseTabbyLogprobs(data) {
    return data?.logprobs ?? null;
}

export function getTextGenModel() { return ''; }
export function isJsonSchemaSupported() { return true; }
export function getLogprobsNumber() { return 0; }

export function replaceMacrosInList(value) {
    if (Array.isArray(value)) return value.map(item => String(item));
    return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

export function createTextGenGenerationData(settings = {}, _model, finalPrompt = '', maxTokens = 256) {
    return Object.fromEntries(Object.entries({
        prompt: String(finalPrompt ?? ''),
        max_tokens: Number(maxTokens ?? settings.max_tokens ?? 256),
        temperature: Number(settings.temperature ?? settings.temp ?? textgenerationwebui_settings.temp),
        top_p: Number(settings.top_p ?? textgenerationwebui_settings.top_p),
        top_k: Number(settings.top_k ?? textgenerationwebui_settings.top_k),
        min_p: Number(settings.min_p ?? textgenerationwebui_settings.min_p),
        repetition_penalty: Number(settings.repetition_penalty ?? settings.rep_pen ?? textgenerationwebui_settings.rep_pen),
        json_schema: settings.json_schema ?? null,
        stream: false,
    }).filter(([, value]) => value !== undefined && value !== null));
}

export async function getTextGenGenerationData(finalPrompt, maxTokens, _isImpersonate, _isContinue, _cfgValues, _type) {
    return createTextGenGenerationData(textgenerationwebui_settings, '', finalPrompt, maxTokens);
}

export function showTGSamplerControls() {}
