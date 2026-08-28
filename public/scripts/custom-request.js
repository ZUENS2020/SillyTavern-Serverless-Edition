import { getPresetManager } from './preset-manager.js';
import { name1, name2 } from '../script.js';
import { formatInstructModeChat, formatInstructModePrompt, getInstructStoppingSequences } from './instruct-mode.js';
import { extractAiText, runAiCapability } from './ai-client.js';
import EventSourceStream from './sse-stream.js';

/** @typedef {{role: string, content: string, name?: string, ignoreInstruct?: boolean}} ChatCompletionMessage */
/** @typedef {{content: any, reasoning: string}} ExtractedData */
/** @typedef {{text: string, swipes: string[], state: Record<string, any>}} StreamResponse */

const ALLOWED_GENERATION_FIELDS = new Set([
    'stream', 'prompt', 'messages', 'max_tokens', 'temperature', 'top_p', 'top_k', 'min_p',
    'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed', 'stop', 'response_format',
    'tools', 'tool_choice', 'json_schema',
]);

function cleanPayload(input) {
    return Object.fromEntries(Object.entries(input)
        .filter(([key, value]) => ALLOWED_GENERATION_FIELDS.has(key) && value !== undefined));
}

function errorMessage(value, fallback) {
    if (value && typeof value === 'object') {
        return String(value.error?.message || value.error || value.message || fallback);
    }
    return fallback;
}

function extractReasoning(data) {
    return String(data?.choices?.[0]?.message?.reasoning
        || data?.choices?.[0]?.delta?.reasoning
        || data?.reasoning
        || '');
}

function extractStreamText(data) {
    return String(data?.choices?.[0]?.delta?.content
        || data?.choices?.[0]?.text
        || data?.response
        || data?.text
        || data?.output_text
        || '');
}

async function readJsonResponse(response, extractData) {
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json?.error) throw new Error(errorMessage(json, `AI Gateway request failed (${response.status})`));
    if (!extractData) return json;
    return { content: extractAiText(json), reasoning: extractReasoning(json) };
}

async function createStream(response) {
    if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(errorMessage(detail, `AI Gateway request failed (${response.status})`));
    }

    const eventStream = new EventSourceStream();
    response.body.pipeThrough(eventStream);
    const reader = eventStream.readable.getReader();
    return async function* streamData() {
        let text = '';
        const swipes = [];
        const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
        while (true) {
            const { done, value } = await reader.read();
            if (done || value.data === '[DONE]') return;
            let data;
            try {
                data = JSON.parse(value.data);
            } catch {
                text += value.data;
                yield { text, swipes, state };
                continue;
            }
            if (data?.error) throw new Error(errorMessage(data, 'AI Gateway stream failed'));
            const chunk = extractStreamText(data);
            state.reasoning += extractReasoning(data);
            const choiceIndex = Number(data?.choices?.[0]?.index || 0);
            if (choiceIndex > 0) swipes[choiceIndex - 1] = (swipes[choiceIndex - 1] || '') + chunk;
            else text += chunk;
            yield { text, swipes, state };
        }
    };
}

async function send(capability, data, extractData, signal) {
    const response = await runAiCapability(capability, data, { raw: true, signal });
    return data.stream ? createStream(response) : readJsonResponse(response, extractData);
}

/** Compatibility API for source extensions. Requests always use the configured Gateway text capability. */
export class TextCompletionService {
    static TYPE = 'text';

    static createRequestData(custom) {
        const payload = cleanPayload(custom);
        if (typeof payload.prompt !== 'string' && !Array.isArray(payload.prompt)) throw new Error('A text prompt is required');
        return payload;
    }

    static async sendRequest(data, extractData = true, signal = null) {
        return send('text', this.createRequestData(data), extractData, signal);
    }

    static constructPrompt(prompt, instructPreset, instructSettings) {
        if (typeof instructPreset === 'string') {
            instructPreset = getPresetManager('instruct')?.getCompletionPresetByName(instructPreset);
        }
        if (!instructPreset || typeof instructPreset !== 'object') return prompt.map(message => message.content).join('\n\n');
        instructPreset = { ...structuredClone(instructPreset), ...instructSettings };
        const prefillActive = prompt.at(-1)?.role === 'assistant';
        return prompt.map((message, index) => {
            if (message.ignoreInstruct) return message.content;
            const isLastMessage = index === prompt.length - 1;
            let content = !isLastMessage || !prefillActive
                ? formatInstructModeChat(message.name ?? message.role, message.content, message.role === 'user', message.role === 'system', undefined, name1, name2, undefined, instructPreset)
                : message.content;
            if (isLastMessage) {
                const suffix = formatInstructModePrompt('assistant', false, prefillActive ? message.content : undefined, name1, name2, true, false, instructPreset);
                content = prefillActive ? suffix : content + suffix;
            }
            return content;
        }).join('');
    }

    static async processRequest(requestData, options = {}, extractData = true, signal = null) {
        let data = this.createRequestData(requestData);
        if (Array.isArray(data.prompt)) {
            data.prompt = options.instructName
                ? this.constructPrompt(data.prompt, options.instructName, options.instructSettings)
                : data.prompt.map(message => message.content).join('\n\n');
            if (options.instructName) {
                const preset = getPresetManager('instruct')?.getCompletionPresetByName(options.instructName);
                if (preset) data.stop = getInstructStoppingSequences({ customInstruct: preset, useStopStrings: false });
            }
        }
        if (options.presetName) {
            const preset = getPresetManager('text')?.getCompletionPresetByName(options.presetName);
            if (preset) data = this.presetToGeneratePayload(preset, {}, data);
        }
        return this.sendRequest(data, extractData, signal);
    }

    static presetToGeneratePayload(preset, overridePreset = {}, overridePayload = {}) {
        if (!preset || typeof preset !== 'object') throw new Error('Invalid preset: must be an object');
        return this.createRequestData({ ...cleanPayload({ ...preset, ...overridePreset }), ...overridePayload });
    }
}

/** Compatibility API for source extensions. Requests always use the configured Gateway chat capability. */
export class ChatCompletionService {
    static TYPE = 'chat';

    static createRequestData(custom) {
        const payload = cleanPayload(custom);
        if (!Array.isArray(payload.messages)) throw new Error('Chat messages are required');
        return payload;
    }

    static async sendRequest(data, extractData = true, signal = null) {
        const payload = this.createRequestData(data);
        const result = await send('chat', payload, extractData, signal);
        if (!payload.stream && extractData && payload.json_schema && result?.content) {
            result.content = JSON.parse(result.content);
        }
        return result;
    }

    static async processRequest(requestData, options = {}, extractData = true, signal = null) {
        let data = this.createRequestData(requestData);
        if (options.presetName) {
            const preset = getPresetManager('chat')?.getCompletionPresetByName(options.presetName);
            if (preset) data = await this.presetToGeneratePayload(preset, {}, data);
        }
        return this.sendRequest(data, extractData, signal);
    }

    static async presetToGeneratePayload(preset, overridePreset = {}, overridePayload = {}) {
        if (!preset || typeof preset !== 'object') throw new Error('Invalid preset: must be an object');
        return this.createRequestData({ ...cleanPayload({ ...preset, ...overridePreset }), ...overridePayload });
    }
}
