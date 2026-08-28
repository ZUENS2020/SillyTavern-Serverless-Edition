const defaultPreamble = '[ Style: chat, complex, sensory, visceral ]';

export let novelai_settings = [];
export let novelai_setting_names = {};

export const nai_settings = {
    temperature: 1,
    repetition_penalty: 1,
    repetition_penalty_range: 0,
    repetition_penalty_slope: 0,
    repetition_penalty_frequency: 0,
    repetition_penalty_presence: 0,
    tail_free_sampling: 1,
    top_k: 0,
    top_p: 1,
    top_a: 0,
    typical_p: 1,
    min_p: 0,
    math1_temp: 1,
    math1_quad: 0,
    math1_quad_entropy_scale: 0,
    min_length: 1,
    model_novel: '',
    preset_settings_novel: 'gateway',
    streaming_novel: false,
    preamble: defaultPreamble,
    prefix: '',
    banned_tokens: '',
    order: [],
    logit_bias: [],
    extensions: {},
};

export function setNovelData() {}
export function getKayraMaxContextTokens() { return null; }
export function getNovelMaxResponseTokens() { return 256; }
export function getNovelTier() { return 'not_available'; }
export function getNovelAnlas() { return 0; }
export function getNovelUnlimitedImageGeneration() { return false; }
export async function loadNovelSubscriptionData() { return false; }

export function convertNovelPreset(data) {
    return data;
}

export function loadNovelPreset(preset = {}) {
    Object.assign(nai_settings, Object.fromEntries(Object.entries(preset).filter(([key]) => key in nai_settings)));
}

export function loadNovelSettings(data = {}, settings = {}) {
    novelai_settings = Array.isArray(data.novelai_settings)
        ? data.novelai_settings.map(value => typeof value === 'string' ? JSON.parse(value) : value)
        : [];
    novelai_setting_names = {};
    loadNovelPreset(settings);
    nai_settings.model_novel = '';
    nai_settings.streaming_novel = false;
}

export function getNovelGenerationData(finalPrompt, settings = {}, maxLength = 256) {
    return {
        prompt: String(finalPrompt ?? ''),
        max_tokens: Number(maxLength),
        temperature: Number(settings.temperature ?? nai_settings.temperature),
        top_p: Number(settings.top_p ?? nai_settings.top_p),
        stream: false,
    };
}

export function adjustNovelInstructionPrompt(prompt) { return prompt; }
export async function generateNovelWithStreaming() {
    throw new Error('NovelAI connections were removed; use the AI Gateway chat capability.');
}
export function parseNovelAILogprobs() { return null; }
export async function getStatusNovel() { return false; }
export function initNovelAISettings() {}
