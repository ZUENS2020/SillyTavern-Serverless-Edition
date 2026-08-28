export let koboldai_settings = [];
export let koboldai_setting_names = {};

export const kai_settings = {
    temp: 1,
    rep_pen: 1,
    rep_pen_range: 0,
    rep_pen_slope: 0.9,
    top_p: 1,
    min_p: 0,
    top_a: 1,
    top_k: 0,
    typical: 1,
    tfs: 1,
    sampler_order: [],
    mirostat: 0,
    mirostat_tau: 5,
    mirostat_eta: 0.1,
    use_default_badwordsids: false,
    grammar: '',
    seed: -1,
    api_server: '',
    preset_settings: 'gateway',
    streaming_kobold: false,
    extensions: {},
};

export const kai_flags = Object.freeze({
    can_use_tokenization: false,
    can_use_stop_sequence: false,
    can_use_streaming: false,
    can_use_default_badwordsids: false,
    can_use_mirostat: false,
    can_use_grammar: false,
    can_use_min_p: false,
});

export function formatKoboldUrl() {
    return null;
}

export function loadKoboldSettings(data = {}, preset = {}) {
    koboldai_settings = Array.isArray(data.koboldai_settings)
        ? data.koboldai_settings.map(value => typeof value === 'string' ? JSON.parse(value) : value)
        : [];
    koboldai_setting_names = {};
    Object.assign(kai_settings, Object.fromEntries(Object.entries(preset).filter(([key]) => key in kai_settings)));
    kai_settings.api_server = '';
    kai_settings.streaming_kobold = false;
}

export function getKoboldGenerationData(finalPrompt, settings = {}, maxLength = 256) {
    return {
        prompt: String(finalPrompt ?? ''),
        max_tokens: Number(maxLength),
        temperature: Number(settings.temperature ?? kai_settings.temp),
        top_p: Number(settings.top_p ?? kai_settings.top_p),
        stream: false,
    };
}

export async function generateKoboldWithStreaming() {
    throw new Error('Legacy Kobold connections were removed; use the AI Gateway chat capability.');
}

export function setKoboldFlags() {}

export async function getStatusKobold() {
    return false;
}

export function initKoboldSettings() {}
