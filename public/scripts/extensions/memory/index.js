import { getStringHash, debounce, waitUntilCondition, extractAllWords, isTrueBoolean } from '../../utils.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import {
    activateSendButtons,
    deactivateSendButtons,
    animation_duration,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    is_send_press,
    saveSettingsDebounced,
    substituteParamsExtended,
    getMaxPromptTokens,
    setExtensionPrompt,
    streamingProcessor,
    animation_easing,
} from '../../../script.js';
import { is_group_generating, selected_group } from '../../group-chats.js';
import { loadMovingUIState, power_user } from '../../power-user.js';
import { dragElement } from '../../RossAscends-mods.js';
import { getTokenCountAsync } from '../../tokenizers.js';
import { debounce_timeout } from '../../constants.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { macros, MacroCategory } from '../../macros/macro-system.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { removeReasoningFromString } from '../../reasoning.js';
import { MacrosParser } from '/scripts/macros.js';
import { runAiCapability } from '../../ai-client.js';
export { MODULE_NAME };

const MODULE_NAME = '1_memory';

let lastMessageHash = null;
let lastMessageId = null;
let inApiCall = false;

async function summarizeWithGateway(text, prompt) {
    const result = await runAiCapability('text', {
        prompt: text,
        max_tokens: extension_settings.memory.overrideResponseLength,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: text }],
    });
    if (typeof result !== 'string' || !result.trim()) throw new Error('Text capability returned no summary');
    return removeReasoningFromString(result).trim();
}

/**
 * Count the number of tokens in the provided text.
 * @param {string} text Text to count tokens for
 * @param {number} padding Number of additional tokens to add to the count
 * @returns {Promise<number>} Number of tokens in the text
 */
async function countSourceTokens(text, padding = 0) {
    return await getTokenCountAsync(text, padding);
}

async function getSourceContextSize() {
    const overrideLength = extension_settings.memory.overrideResponseLength;

    return getMaxPromptTokens(overrideLength);
}

const formatMemoryValue = function (value) {
    if (!value) {
        return '';
    }

    value = value.trim();

    if (extension_settings.memory.template) {
        return substituteParamsExtended(extension_settings.memory.template, { summary: value });
    } else {
        return `Summary: ${value}`;
    }
};

const saveChatDebounced = debounce(() => getContext().saveChat(), debounce_timeout.relaxed);

const summary_sources = {
    'main': 'main',
};

const prompt_builders = {
    DEFAULT: 0,
    RAW_BLOCKING: 1,
    RAW_NON_BLOCKING: 2,
};

const defaultPrompt = 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.';
const defaultTemplate = '[Summary: {{summary}}]';

const defaultSettings = {
    memoryFrozen: false,
    SkipWIAN: false,
    source: summary_sources.main,
    prompt: defaultPrompt,
    template: defaultTemplate,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
    depth: 2,
    promptWords: 200,
    promptMinWords: 25,
    promptMaxWords: 1000,
    promptWordsStep: 25,
    promptInterval: 10,
    promptMinInterval: 0,
    promptMaxInterval: 250,
    promptIntervalStep: 1,
    promptForceWords: 0,
    promptForceWordsStep: 100,
    promptMinForceWords: 0,
    promptMaxForceWords: 10000,
    overrideResponseLength: 0,
    overrideResponseLengthMin: 0,
    overrideResponseLengthMax: 4096,
    overrideResponseLengthStep: 16,
    maxMessagesPerRequest: 0,
    maxMessagesPerRequestMin: 0,
    maxMessagesPerRequestMax: 250,
    maxMessagesPerRequestStep: 1,
    prompt_builder: prompt_builders.DEFAULT,
};

function loadSettings() {
    if (Object.keys(extension_settings.memory).length === 0) {
        Object.assign(extension_settings.memory, defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.memory[key] === undefined) {
            extension_settings.memory[key] = defaultSettings[key];
        }
    }

    if (extension_settings.memory.source !== summary_sources.main) {
        extension_settings.memory.source = summary_sources.main;
        saveSettingsDebounced();
    }

    $('#summary_source').val(extension_settings.memory.source).trigger('change');
    $('#memory_frozen').prop('checked', extension_settings.memory.memoryFrozen).trigger('input');
    $('#memory_skipWIAN').prop('checked', extension_settings.memory.SkipWIAN).trigger('input');
    $('#memory_prompt').val(extension_settings.memory.prompt).trigger('input');
    $('#memory_prompt_words').val(extension_settings.memory.promptWords).trigger('input');
    $('#memory_prompt_interval').val(extension_settings.memory.promptInterval).trigger('input');
    $('#memory_template').val(extension_settings.memory.template).trigger('input');
    $('#memory_depth').val(extension_settings.memory.depth).trigger('input');
    $('#memory_role').val(extension_settings.memory.role).trigger('input');
    $(`input[name="memory_position"][value="${extension_settings.memory.position}"]`).prop('checked', true).trigger('input');
    $('#memory_prompt_words_force').val(extension_settings.memory.promptForceWords).trigger('input');
    $(`input[name="memory_prompt_builder"][value="${extension_settings.memory.prompt_builder}"]`).prop('checked', true).trigger('input');
    $('#memory_override_response_length').val(extension_settings.memory.overrideResponseLength).trigger('input');
    $('#memory_max_messages_per_request').val(extension_settings.memory.maxMessagesPerRequest).trigger('input');
    $('#memory_include_wi_scan').prop('checked', extension_settings.memory.scan).trigger('input');
    switchSourceControls(extension_settings.memory.source);
}

async function onPromptForceWordsAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const averageMessageWordCount = messagesWordCount / allMessages.length;
    const tokensPerWord = await countSourceTokens(allMessages.join('\n')) / messagesWordCount;
    const wordsPerToken = 1 / tokensPerWord;
    const maxPromptLengthWords = Math.round(maxPromptLength * wordsPerToken);
    // How many words should pass so that messages will start be dropped out of context;
    const wordsPerPrompt = Math.floor(maxPromptLength / tokensPerWord);
    // How many words will be needed to fit the allowance buffer
    const summaryPromptWords = extractAllWords(extension_settings.memory.prompt).length;
    const promptAllowanceWords = maxPromptLengthWords - extension_settings.memory.promptWords - summaryPromptWords;
    const averageMessagesPerPrompt = Math.floor(promptAllowanceWords / averageMessageWordCount);
    const maxMessagesPerSummary = extension_settings.memory.maxMessagesPerRequest || 0;
    const targetMessagesInPrompt = maxMessagesPerSummary > 0 ? maxMessagesPerSummary : Math.max(0, averageMessagesPerPrompt);
    const targetSummaryWords = (targetMessagesInPrompt * averageMessageWordCount) + (promptAllowanceWords / 4);

    console.table({
        maxPromptLength,
        maxPromptLengthWords,
        promptAllowanceWords,
        averageMessagesPerPrompt,
        targetMessagesInPrompt,
        targetSummaryWords,
        wordsPerPrompt,
        wordsPerToken,
        tokensPerWord,
        messagesWordCount,
    });

    const ROUNDING = 100;
    extension_settings.memory.promptForceWords = Math.max(1, Math.floor(targetSummaryWords / ROUNDING) * ROUNDING);
    $('#memory_prompt_words_force').val(extension_settings.memory.promptForceWords).trigger('input');
}

async function onPromptIntervalAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const messagesTokenCount = await countSourceTokens(allMessages.join('\n'));
    const tokensPerWord = messagesTokenCount / messagesWordCount;
    const averageMessageTokenCount = messagesTokenCount / allMessages.length;
    const targetSummaryTokens = Math.round(extension_settings.memory.promptWords * tokensPerWord);
    const promptTokens = await countSourceTokens(extension_settings.memory.prompt);
    const promptAllowance = maxPromptLength - promptTokens - targetSummaryTokens;
    const maxMessagesPerSummary = extension_settings.memory.maxMessagesPerRequest || 0;
    const averageMessagesPerPrompt = Math.floor(promptAllowance / averageMessageTokenCount);
    const targetMessagesInPrompt = maxMessagesPerSummary > 0 ? maxMessagesPerSummary : Math.max(0, averageMessagesPerPrompt);
    const adjustedAverageMessagesPerPrompt = targetMessagesInPrompt + (averageMessagesPerPrompt - targetMessagesInPrompt) / 4;

    console.table({
        maxPromptLength,
        promptAllowance,
        targetSummaryTokens,
        promptTokens,
        messagesWordCount,
        messagesTokenCount,
        tokensPerWord,
        averageMessageTokenCount,
        averageMessagesPerPrompt,
        targetMessagesInPrompt,
        adjustedAverageMessagesPerPrompt,
        maxMessagesPerSummary,
    });

    const ROUNDING = 5;
    extension_settings.memory.promptInterval = Math.max(1, Math.floor(adjustedAverageMessagesPerPrompt / ROUNDING) * ROUNDING);

    $('#memory_prompt_interval').val(extension_settings.memory.promptInterval).trigger('input');
}

function onSummarySourceChange(event) {
    const value = event.target.value;
    extension_settings.memory.source = value;
    switchSourceControls(value);
    saveSettingsDebounced();
}

function switchSourceControls(value) {
    $('#summaryExtensionDrawerContents [data-summary-source], #memory_settings [data-summary-source]').each((_, element) => {
        const source = element.dataset.summarySource.split(',').map(s => s.trim());
        $(element).toggle(source.includes(value));
    });
}

function onMemoryFrozenInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings.memory.memoryFrozen = value;
    saveSettingsDebounced();
}

function onMemorySkipWIANInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings.memory.SkipWIAN = value;
    saveSettingsDebounced();
}

function onMemoryPromptWordsInput() {
    const value = $(this).val();
    extension_settings.memory.promptWords = Number(value);
    $('#memory_prompt_words_value').text(extension_settings.memory.promptWords);
    saveSettingsDebounced();
}

function onMemoryPromptIntervalInput() {
    const value = $(this).val();
    extension_settings.memory.promptInterval = Number(value);
    $('#memory_prompt_interval_value').text(extension_settings.memory.promptInterval);
    saveSettingsDebounced();
}

function onMemoryPromptRestoreClick() {
    $('#memory_prompt').val(defaultPrompt).trigger('input');
}

function onMemoryPromptInput() {
    const value = $(this).val();
    extension_settings.memory.prompt = value;
    saveSettingsDebounced();
}

function onMemoryTemplateInput() {
    const value = $(this).val();
    extension_settings.memory.template = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryDepthInput() {
    const value = $(this).val();
    extension_settings.memory.depth = Number(value);
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryRoleInput() {
    const value = $(this).val();
    extension_settings.memory.role = Number(value);
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryPositionChange(e) {
    const value = e.target.value;
    extension_settings.memory.position = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryIncludeWIScanInput() {
    const value = !!$(this).prop('checked');
    extension_settings.memory.scan = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryPromptWordsForceInput() {
    const value = $(this).val();
    extension_settings.memory.promptForceWords = Number(value);
    $('#memory_prompt_words_force_value').text(extension_settings.memory.promptForceWords);
    saveSettingsDebounced();
}

function onOverrideResponseLengthInput() {
    const value = $(this).val();
    extension_settings.memory.overrideResponseLength = Number(value);
    $('#memory_override_response_length_value').text(extension_settings.memory.overrideResponseLength);
    saveSettingsDebounced();
}

function onMaxMessagesPerRequestInput() {
    const value = $(this).val();
    extension_settings.memory.maxMessagesPerRequest = Number(value);
    $('#memory_max_messages_per_request_value').text(extension_settings.memory.maxMessagesPerRequest);
    saveSettingsDebounced();
}

/**
 * Get the latest memory summary from the chat.
 * @param {ChatMessage[]} chat Chat messages
 * @returns {string} Latest memory summary or empty string
 */
function getLatestMemoryFromChat(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return '';
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory) {
            return mes.extra.memory;
        }
    }

    return '';
}

/**
 * Get the index of the latest memory summary from the chat.
 * @param {ChatMessage[]} chat Chat messages
 * @returns {number} Index of the latest memory summary or -1 if not found
 */
function getIndexOfLatestChatSummary(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return -1;
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory) {
            return chat.indexOf(mes);
        }
    }

    return -1;
}

/**
 * Check if something is changed during the summarization process.
 * @param {{ groupId: any; chatId: any; characterId: any; }} context
 * @returns {boolean} True if the context has changed and the summary should be discarded
 */
function isContextChanged(context) {
    const newContext = getContext();
    if (newContext.groupId !== context.groupId
        || newContext.chatId !== context.chatId
        || (!newContext.groupId && (newContext.characterId !== context.characterId))) {
        console.log('Context changed, summary discarded');
        return true;
    }

    return false;
}

function onChatChanged() {
    const context = getContext();
    const latestMemory = getLatestMemoryFromChat(context.chat);
    setMemoryContext(latestMemory, false);
}

async function onChatEvent() {
    // Streaming in-progress
    if (streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    // Currently summarizing or frozen state - skip
    if (inApiCall || extension_settings.memory.memoryFrozen) {
        return;
    }

    const context = getContext();
    const chat = context.chat;
    // Chat can't be empty.
    if (chat.length === 0) return;

    const lastMessage = chat[chat.length - 1];

    // No new messages - do nothing
    if ((lastMessageId === chat.length && getStringHash(lastMessage.mes) === lastMessageHash)) {
        return;
    }

    // Messages has been deleted - rewrite the context with the latest available memory
    if (chat.length < lastMessageId) {
        const latestMemory = getLatestMemoryFromChat(chat);
        setMemoryContext(latestMemory, false);
    }

    // Message has been edited / regenerated - delete the saved memory
    if (chat.length
        && lastMessage.extra
        && lastMessage.extra.memory
        && lastMessageId === chat.length
        && getStringHash(lastMessage.mes) !== lastMessageHash) {
        delete lastMessage.extra.memory;
    }

    summarizeChat(context)
        .catch(console.error)
        .finally(() => {
            lastMessageId = context.chat?.length ?? null;
            lastMessageHash = getStringHash((context.chat.length && context.chat[context.chat.length - 1].mes) ?? '');
        });
}

/**
 * Forces a summary generation for the current chat.
 * @param {boolean} quiet If an informational toast should be displayed
 * @returns {Promise<string>} Summarized text
 */
async function forceSummarizeChat(quiet) {
    const context = getContext();
    const skipWIAN = extension_settings.memory.SkipWIAN;

    const toast = quiet ? jQuery() : toastr.info('Summarizing chat...', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
    const value = await summarizeChatMain(context, true, skipWIAN);

    toastr.clear(toast);

    if (!value) {
        toastr.warning('Failed to summarize chat');
        return '';
    }

    return value;
}

/**
 * Callback for the summarize command.
 * @param {object} args Command arguments
 * @param {string} text Text to summarize
 */
async function summarizeCallback(args, text) {
    text = text.trim();

    // Summarize the current chat if no text provided
    if (!text) {
        const quiet = isTrueBoolean(args.quiet);
        return await forceSummarizeChat(quiet);
    }

    const prompt = substituteParamsExtended((args.prompt || extension_settings.memory.prompt), { words: extension_settings.memory.promptWords });

    try {
        return await summarizeWithGateway(text, prompt);
    } catch (error) {
        toastr.error(String(error), 'Failed to summarize text');
        console.log(error);
        return '';
    }
}

async function summarizeChat(context) {
    const skipWIAN = extension_settings.memory.SkipWIAN;
    await summarizeChatMain(context, false, skipWIAN);
}

/**
 * Check if the chat should be summarized based on the current conditions.
 * Return summary prompt if it should be summarized.
 * @param {any} context ST context
 * @param {boolean} force Summarize the chat regardless of the conditions
 * @returns {Promise<string>} Summary prompt or empty string
 */
async function getSummaryPromptForNow(context, force) {
    if (extension_settings.memory.promptInterval === 0 && !force) {
        console.debug('Prompt interval is set to 0, skipping summarization');
        return '';
    }

    try {
        // Wait for group to finish generating
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 1000, 10);
        }
        // Wait for the send button to be released
        await waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug('Timeout waiting for is_send_press');
        return '';
    }

    if (!context.chat.length) {
        console.debug('No messages in chat to summarize');
        return '';
    }

    if (context.chat.length < extension_settings.memory.promptInterval && !force) {
        console.debug(`Not enough messages in chat to summarize (chat: ${context.chat.length}, interval: ${extension_settings.memory.promptInterval})`);
        return '';
    }

    let messagesSinceLastSummary = 0;
    let wordsSinceLastSummary = 0;
    let conditionSatisfied = false;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i].extra && context.chat[i].extra.memory) {
            break;
        }
        messagesSinceLastSummary++;
        wordsSinceLastSummary += extractAllWords(context.chat[i].mes).length;
    }

    if (messagesSinceLastSummary >= extension_settings.memory.promptInterval) {
        conditionSatisfied = true;
    }

    if (extension_settings.memory.promptForceWords && wordsSinceLastSummary >= extension_settings.memory.promptForceWords) {
        conditionSatisfied = true;
    }

    if (!conditionSatisfied && !force) {
        console.debug(`Summary conditions not satisfied (messages: ${messagesSinceLastSummary}, interval: ${extension_settings.memory.promptInterval}, words: ${wordsSinceLastSummary}, force words: ${extension_settings.memory.promptForceWords})`);
        return '';
    }

    console.log('Summarizing chat, messages since last summary: ' + messagesSinceLastSummary, 'words since last summary: ' + wordsSinceLastSummary);
    const prompt = substituteParamsExtended(extension_settings.memory.prompt, { words: extension_settings.memory.promptWords });

    if (!prompt) {
        console.debug('Summarization prompt is empty. Skipping summarization.');
        return '';
    }

    return prompt;
}

async function summarizeChatMain(context, force, skipWIAN) {
    const prompt = await getSummaryPromptForNow(context, force);

    if (!prompt) {
        return;
    }

    console.log('sending summary prompt');
    let summary = '';
    let index = null;

    if (prompt_builders.DEFAULT === extension_settings.memory.prompt_builder) {
        try {
            inApiCall = true;
            const source = context.chat.map(message => `${message.name || (message.is_user ? 'User' : 'Assistant')}: ${message.mes || ''}`).join('\n').slice(-32_768);
            summary = await summarizeWithGateway(source, prompt);
            index = context.chat.length - 1;
        } finally {
            inApiCall = false;
        }
    }

    if ([prompt_builders.RAW_BLOCKING, prompt_builders.RAW_NON_BLOCKING].includes(extension_settings.memory.prompt_builder)) {
        const lock = extension_settings.memory.prompt_builder === prompt_builders.RAW_BLOCKING;
        try {
            inApiCall = true;
            if (lock) {
                deactivateSendButtons();
            }

            const { rawPrompt, lastUsedIndex } = await getRawSummaryPrompt(context, prompt);

            if (lastUsedIndex === null || lastUsedIndex === -1) {
                if (force) {
                    toastr.info('To try again, remove the latest summary.', 'No messages found to summarize');
                }

                return null;
            }

            summary = await summarizeWithGateway(rawPrompt, prompt);
            index = lastUsedIndex;
        } finally {
            inApiCall = false;
            if (lock) {
                activateSendButtons();
            }
        }
    }

    if (!summary) {
        console.warn('Empty summary received');
        return;
    }

    if (isContextChanged(context)) {
        return;
    }

    setMemoryContext(summary, true, index);
    return summary;
}

/**
 * Get the raw summarization prompt from the chat context.
 * @param {object} context ST context
 * @param {string} prompt Summarization system prompt
 * @returns {Promise<{rawPrompt: string, lastUsedIndex: number}>} Raw summarization prompt
 */
async function getRawSummaryPrompt(context, prompt) {
    /**
     * Get the memory string from the chat buffer.
     * @param {boolean} includeSystem Include prompt into the memory string
     * @returns {string} Memory string
     */
    function getMemoryString(includeSystem) {
        const delimiter = '\n\n';
        const stringBuilder = [];
        const bufferString = chatBuffer.slice().join(delimiter);

        if (includeSystem) {
            stringBuilder.push(prompt);
        }

        if (latestSummary) {
            stringBuilder.push(latestSummary);
        }

        stringBuilder.push(bufferString);

        return stringBuilder.join(delimiter).trim();
    }

    const chat = context.chat.slice();
    const latestSummary = getLatestMemoryFromChat(chat);
    const latestSummaryIndex = getIndexOfLatestChatSummary(chat);
    chat.pop(); // We always exclude the last message from the buffer
    const chatBuffer = [];
    const PADDING = 64;
    const PROMPT_SIZE = await getSourceContextSize();
    let latestUsedMessage = null;

    for (let index = latestSummaryIndex + 1; index < chat.length; index++) {
        const message = chat[index];

        if (!message) {
            break;
        }

        if (message.is_system || !message.mes) {
            continue;
        }

        const entry = `${message.name}:\n${message.mes}`;
        chatBuffer.push(entry);

        const tokens = await countSourceTokens(getMemoryString(true), PADDING);

        if (tokens > PROMPT_SIZE) {
            chatBuffer.pop();
            break;
        }

        latestUsedMessage = message;

        if (extension_settings.memory.maxMessagesPerRequest > 0 && chatBuffer.length >= extension_settings.memory.maxMessagesPerRequest) {
            break;
        }
    }

    const lastUsedIndex = context.chat.indexOf(latestUsedMessage);
    const rawPrompt = getMemoryString(false);
    return { rawPrompt, lastUsedIndex };
}

function onMemoryRestoreClick() {
    const context = getContext();
    const content = $('#memory_contents').val();
    const reversedChat = context.chat.slice().reverse();
    reversedChat.shift();

    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory == content) {
            delete mes.extra.memory;
            break;
        }
    }

    const newContent = getLatestMemoryFromChat(context.chat);
    setMemoryContext(newContent, false);
}

function onMemoryContentInput() {
    const value = $(this).val();
    setMemoryContext(value, true);
}

function onMemoryPromptBuilderInput(e) {
    const value = Number(e.target.value);
    extension_settings.memory.prompt_builder = value;
    saveSettingsDebounced();
}

function reinsertMemory() {
    const existingValue = String($('#memory_contents').val());
    setMemoryContext(existingValue, false);
}

/**
 * Set the summary value to the context and save it to the chat message extra.
 * @param {string} value Value of a summary
 * @param {boolean} saveToMessage Should the summary be saved to the chat message extra
 * @param {number|null} index Index of the chat message to save the summary to. If null, the pre-last message is used.
 */
function setMemoryContext(value, saveToMessage, index = null) {
    setExtensionPrompt(MODULE_NAME, formatMemoryValue(value), extension_settings.memory.position, extension_settings.memory.depth, extension_settings.memory.scan, extension_settings.memory.role);
    $('#memory_contents').val(value);

    const summaryLog = value
        ? `Summary set to: ${value}. Position: ${extension_settings.memory.position}. Depth: ${extension_settings.memory.depth}. Role: ${extension_settings.memory.role}`
        : 'Summary has no content';
    console.debug(summaryLog);

    const context = getContext();
    if (saveToMessage && context.chat.length) {
        const idx = index ?? context.chat.length - 2;
        const mes = context.chat[idx < 0 ? 0 : idx];

        if (!mes.extra) {
            mes.extra = {};
        }

        mes.extra.memory = value;
        saveChatDebounced();
    }
}

function doPopout(e) {
    const target = e.target;
    //repurposes the zoomed avatar template to server as a floating div
    if ($('#summaryExtensionPopout').length === 0) {
        console.debug('did not see popout yet, creating');
        const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
        const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="summaryExtensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="summaryExtensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
    </div>`;
        const newElement = $(template);
        newElement.attr('id', 'summaryExtensionPopout')
            .css('opacity', 0)
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();
        const prevSummaryBoxContents = $('#memory_contents').val().toString(); //copy summary box before emptying
        originalElement.empty();
        originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newElement.append(controlBarHtml).append(originalHTMLClone);
        $('#movingDivs').append(newElement);
        newElement.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });
        $('#summaryExtensionDrawerContents').addClass('scrollableInnerFull');
        setMemoryContext(prevSummaryBoxContents, false); //paste prev summary box contents into popout box
        setupListeners();
        loadSettings();
        loadMovingUIState();

        dragElement(newElement);

        //setup listener for close button to restore extensions menu
        $('#summaryExtensionPopoutClose').off('click').on('click', function () {
            $('#summaryExtensionDrawerContents').removeClass('scrollableInnerFull');
            const summaryPopoutHTML = $('#summaryExtensionDrawerContents');
            $('#summaryExtensionPopout').fadeOut(animation_duration, () => {
                originalElement.empty();
                originalElement.append(summaryPopoutHTML);
                $('#summaryExtensionPopout').remove();
            });
            loadSettings();
        });
    } else {
        console.debug('saw existing popout, removing');
        $('#summaryExtensionPopout').fadeOut(animation_duration, () => { $('#summaryExtensionPopoutClose').trigger('click'); });
    }
}

function setupListeners() {
    //setup shared listeners for popout and regular ext menu
    $('#memory_restore').off('click').on('click', onMemoryRestoreClick);
    $('#memory_contents').off('input').on('input', onMemoryContentInput);
    $('#memory_frozen').off('input').on('input', onMemoryFrozenInput);
    $('#memory_skipWIAN').off('input').on('input', onMemorySkipWIANInput);
    $('#summary_source').off('change').on('change', onSummarySourceChange);
    $('#memory_prompt_words').off('input').on('input', onMemoryPromptWordsInput);
    $('#memory_prompt_interval').off('input').on('input', onMemoryPromptIntervalInput);
    $('#memory_prompt').off('input').on('input', onMemoryPromptInput);
    $('#memory_force_summarize').off('click').on('click', () => forceSummarizeChat(false));
    $('#memory_template').off('input').on('input', onMemoryTemplateInput);
    $('#memory_depth').off('input').on('input', onMemoryDepthInput);
    $('#memory_role').off('input').on('input', onMemoryRoleInput);
    $('input[name="memory_position"]').off('change').on('change', onMemoryPositionChange);
    $('#memory_prompt_words_force').off('input').on('input', onMemoryPromptWordsForceInput);
    $('#memory_prompt_builder_default').off('input').on('input', onMemoryPromptBuilderInput);
    $('#memory_prompt_builder_raw_blocking').off('input').on('input', onMemoryPromptBuilderInput);
    $('#memory_prompt_builder_raw_non_blocking').off('input').on('input', onMemoryPromptBuilderInput);
    $('#memory_prompt_restore').off('click').on('click', onMemoryPromptRestoreClick);
    $('#memory_prompt_interval_auto').off('click').on('click', onPromptIntervalAutoClick);
    $('#memory_prompt_words_auto').off('click').on('click', onPromptForceWordsAutoClick);
    $('#memory_override_response_length').off('input').on('input', onOverrideResponseLengthInput);
    $('#memory_max_messages_per_request').off('input').on('input', onMaxMessagesPerRequestInput);
    $('#memory_include_wi_scan').off('input').on('input', onMemoryIncludeWIScanInput);
    $('#summarySettingsBlockToggle').off('click').on('click', function () {
        $('#summarySettingsBlock').slideToggle(200, 'swing');
    });
}

export async function init() {
    async function addExtensionControls() {
        const settingsHtml = await renderExtensionTemplateAsync('memory', 'settings', { defaultSettings });
        $('#summarize_container').append(settingsHtml);
        setupListeners();
        $('#summaryExtensionPopoutButton').off('click').on('click', function (e) {
            doPopout(e);
            e.stopPropagation();
        });
    }

    await addExtensionControls();
    loadSettings();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);
    for (const event of [event_types.MESSAGE_DELETED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(event, onChatEvent);
    }
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarize',
        callback: summarizeCallback,
        namedArgumentList: [
            new SlashCommandNamedArgument('source', 'API to use for summarization', [ARGUMENT_TYPE.STRING], false, false, '', Object.values(summary_sources)),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt',
                description: 'prompt to use for summarization',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'suppress the toast message when summarizing the chat',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to summarize', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        helpString: 'Summarizes the given text. If no text is provided, the current chat will be summarized. Can specify the source and the prompt to use.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    const summaryMacroHandler = () => {
        // Checking content of the UI summary box first
        const uiSummary = $('#memory_contents').val().toString();
        if (uiSummary.trim().length > 0) {
            return uiSummary;
        }
        // Fallback to scanning the chat for the latest summary if the UI summary box is empty
        return getLatestMemoryFromChat(getContext().chat);
    };
    if (power_user.experimental_macro_engine) {
        macros.register('summary', {
            category: MacroCategory.CHAT,
            description: 'Returns the latest memory/summary from the current chat.',
            handler: () => summaryMacroHandler(),
        });
    } else {
        // TODO: Remove this when the experimental macro engine is replacing the old macro engine
        MacrosParser.registerMacro('summary',
            () => summaryMacroHandler(),
            'Returns the latest memory/summary from the current chat.');
    }
}
