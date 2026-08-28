export { translate };

import { eventSource, event_types, saveSettingsDebounced, substituteParams, updateMessageBlock } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { updateReasoningUI } from '../../reasoning.js';
import { runAiCapability } from '../../ai-client.js';

export const autoModeOptions = Object.freeze({ NONE: 'none', RESPONSES: 'responses', INPUT: 'inputs', BOTH: 'both' });

const languages = {
    English: 'en', 'Chinese (Simplified)': 'zh-CN', 'Chinese (Traditional)': 'zh-TW', Japanese: 'ja', Korean: 'ko',
    Spanish: 'es', French: 'fr', German: 'de', Italian: 'it', Portuguese: 'pt', Russian: 'ru', Arabic: 'ar', Hindi: 'hi',
    Dutch: 'nl', Polish: 'pl', Turkish: 'tr', Vietnamese: 'vi', Thai: 'th', Indonesian: 'id', Ukrainian: 'uk',
};

const defaults = { target_language: 'en', internal_language: 'en', auto_mode: autoModeOptions.NONE };

function shouldTranslate(direction) {
    const mode = extension_settings.translate.auto_mode;
    return mode === autoModeOptions.BOTH || mode === direction;
}

async function translateChunk(text, language) {
    const prompt = `Translate the user text to ${language}. Preserve Markdown, names, placeholders, and meaning. Return only the translation.`;
    const result = await runAiCapability('translation', {
        text,
        targetLanguage: language,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: text }],
    });
    if (typeof result !== 'string' || !result.trim()) throw new Error('Translation capability returned no text');
    return result.trim();
}

async function translate(text, lang) {
    if (!text) return '';
    const language = lang || extension_settings.translate.target_language;
    try {
        const parts = String(text).split(/(!\[.*?\]\([^)]*\))/gu);
        let result = '';
        for (const part of parts) {
            if (/^!\[.*?\]\([^)]*\)$/u.test(part)) {
                result += part;
                continue;
            }
            for (let offset = 0; offset < part.length; offset += 6_000) {
                result += await translateChunk(part.slice(offset, offset + 6_000), language);
            }
        }
        return result;
    } catch (error) {
        console.error('Translation failed', error);
        toastr.error(String(error), 'Failed to translate message');
        return text;
    }
}

async function translateIncoming(messageId) {
    const context = getContext();
    const message = context.chat[messageId];
    if (!message) return;
    message.extra ??= {};
    message.extra.display_text = await translate(substituteParams(message.mes, { name2Override: message.name }), extension_settings.translate.target_language);
    if (message.extra.reasoning) {
        message.extra.reasoning_display_text = await translate(message.extra.reasoning, extension_settings.translate.target_language);
        updateReasoningUI(Number(messageId));
    }
    updateMessageBlock(Number(messageId), message);
}

async function translateOutgoing(messageId) {
    const context = getContext();
    const message = context.chat[messageId];
    if (!message) return;
    message.extra ??= {};
    message.extra.display_text = message.mes;
    message.mes = await translate(message.mes, extension_settings.translate.internal_language);
    updateMessageBlock(Number(messageId), message);
}

async function translateChat() {
    const context = getContext();
    const toast = toastr.info('Translating chat…', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
    for (let index = 0; index < context.chat.length; index += 1) await translateIncoming(index);
    await context.saveChat();
    toastr.clear(toast);
}

function clearTranslations() {
    const context = getContext();
    for (const message of context.chat) {
        if (!message.extra) continue;
        delete message.extra.display_text;
        delete message.extra.reasoning_display_text;
    }
    context.reloadCurrentChat?.();
    void context.saveChat();
}

globalThis.translate = translate;

export async function init() {
    extension_settings.translate = { ...defaults, ...(extension_settings.translate ?? {}) };
    delete extension_settings.translate.provider;
    delete extension_settings.translate.deepl_endpoint;

    const html = await renderExtensionTemplateAsync('translate', 'index');
    const buttons = await renderExtensionTemplateAsync('translate', 'buttons');
    $('#translate_wand_container').append(buttons);
    $('#translation_container').append(html);
    for (const [name, code] of Object.entries(languages)) $('#translation_target_language').append($('<option>').val(code).text(name));
    $('#translation_target_language').val(extension_settings.translate.target_language).on('change', event => {
        extension_settings.translate.target_language = event.target.value;
        saveSettingsDebounced();
    });
    $('#translation_auto_mode').val(extension_settings.translate.auto_mode).on('change', event => {
        extension_settings.translate.auto_mode = event.target.value;
        saveSettingsDebounced();
    });
    $('#translate_chat').on('click', translateChat);
    $('#translation_clear').on('click', clearTranslations);
    $('#translate_input_message').on('click', async () => {
        const textarea = document.getElementById('send_textarea');
        if (!(textarea instanceof HTMLTextAreaElement) || !textarea.value) return;
        textarea.value = await translate(textarea.value, extension_settings.translate.internal_language);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    $(document).on('click', '.mes_translate', async function () {
        const id = Number($(this).closest('.mes').attr('mesid'));
        await translateIncoming(id);
        await getContext().saveChat();
    });
    eventSource.makeFirst(event_types.CHARACTER_MESSAGE_RENDERED, id => shouldTranslate(autoModeOptions.RESPONSES) && translateIncoming(id));
    eventSource.makeFirst(event_types.USER_MESSAGE_RENDERED, id => shouldTranslate(autoModeOptions.INPUT) && translateOutgoing(id));
    eventSource.on(event_types.MESSAGE_SWIPED, id => shouldTranslate(autoModeOptions.RESPONSES) && translateIncoming(id));
    document.body.classList.add('translate');
}
