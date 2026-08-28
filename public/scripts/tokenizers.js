import { localforage } from '../lib.js';
import { power_user, registerDebugFunction } from './power-user.js';

export const BYTES_PER_TOKEN = 3.35;
export { BYTES_PER_TOKEN as CHARACTERS_PER_TOKEN_RATIO };
export const TOKENIZER_WARNING_KEY = 'tokenizationWarningShown';
export const TOKENIZER_SUPPORTED_KEY = 'tokenizationSupported';

// Numeric values remain stable for imported settings and source-extension compatibility.
export const tokenizers = Object.freeze({
    NONE: 0,
    GPT2: 1,
    OPENAI: 2,
    LLAMA: 3,
    NERD: 4,
    NERD2: 5,
    API_CURRENT: 6,
    MISTRAL: 7,
    YI: 8,
    API_TEXTGENERATIONWEBUI: 9,
    API_KOBOLD: 10,
    CLAUDE: 11,
    LLAMA3: 12,
    GEMMA: 13,
    JAMBA: 14,
    QWEN2: 15,
    COMMAND_R: 16,
    NEMO: 17,
    DEEPSEEK: 18,
    COMMAND_A: 19,
    BEST_MATCH: 99,
});

export const ENCODE_TOKENIZERS = Object.values(tokenizers).filter(value => Number.isInteger(value) && value !== tokenizers.BEST_MATCH);
export const TEXTGEN_TOKENIZERS = [];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const cacheStore = localforage.createInstance({ name: 'SillyTavern_TokenEstimates' });
let tokenCache = {};

export function guesstimate(str) {
    return Math.ceil(encoder.encode(String(str ?? '')).length / BYTES_PER_TOKEN);
}

function cacheKey(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${hash >>> 0}`;
}

async function loadTokenCache() {
    try {
        tokenCache = await cacheStore.getItem('counts') || {};
    } catch {
        tokenCache = {};
    }
}

export async function saveTokenCache() {
    try {
        await cacheStore.setItem('counts', tokenCache);
    } catch (error) {
        console.warn('Unable to persist browser token estimates', error);
    }
}

async function resetTokenCache() {
    tokenCache = {};
    await cacheStore.removeItem('counts');
}

/** @typedef {{tokenizerId: number, tokenizerName: string}} Tokenizer */

export function getAvailableTokenizers() {
    return [{ tokenizerId: tokenizers.NONE, tokenizerName: 'Browser estimate' }];
}

export function selectTokenizer() {
    power_user.tokenizer = tokenizers.NONE;
    return tokenizers.NONE;
}

export function getFriendlyTokenizerName() {
    return 'Browser estimate';
}

export function getTokenizerBestMatch() {
    return tokenizers.NONE;
}

export async function getTokenCountAsync(str, padding = undefined) {
    return getTokenCount(str, padding);
}

export function getTokenCount(str, padding = undefined) {
    if (typeof str !== 'string' || str.length === 0) return 0;
    const key = cacheKey(str);
    const cached = tokenCache[key];
    const count = typeof cached === 'number' ? cached : guesstimate(str);
    tokenCache[key] = count;
    return count + Number(padding || 0);
}

export function getTokenizerModel() {
    return 'browser-estimate';
}

export function countTokensOpenAI(messages, full = false) {
    if (!Array.isArray(messages)) messages = [messages];
    const framing = full ? 0 : 2;
    return Math.max(0, messages.reduce((total, message) => total + guesstimate(JSON.stringify(message)) + 4, framing));
}

export async function countTokensOpenAIAsync(messages, full = false) {
    return countTokensOpenAI(messages, full);
}

/**
 * Return reversible UTF-8 byte IDs. These are for UI inspection only and are
 * never sent to a model as provider token IDs.
 */
export function getTextTokens(_tokenizerType, str) {
    return Array.from(encoder.encode(String(str ?? '')));
}

export function decodeTextTokens(_tokenizerType, ids) {
    if (!Array.isArray(ids)) return { text: '', chunks: [] };
    const bytes = Uint8Array.from(ids.map(value => Math.max(0, Math.min(255, Number(value) || 0))));
    const text = decoder.decode(bytes);
    return { text, chunks: Array.from(text) };
}

export async function initTokenizers() {
    power_user.tokenizer = tokenizers.NONE;
    sessionStorage.setItem(TOKENIZER_SUPPORTED_KEY, 'browser-estimate');
    await loadTokenCache();
    registerDebugFunction('resetTokenCache', 'Reset token cache', 'Purges browser token estimates.', resetTokenCache);
}
