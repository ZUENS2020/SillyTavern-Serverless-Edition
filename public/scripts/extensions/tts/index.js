import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { extractAiText, runAiCapability } from '../../ai-client.js';

export const MODULE_NAME = 'tts';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    auto_generation: false,
    narrate_user: false,
    voice: '',
    playback_rate: 1,
});

const audio = new Audio();
let currentObjectUrl = '';
let currentAbortController = null;

export function getPreviewString(lang) {
    return lang?.startsWith('zh') ? '我能吞下玻璃而不伤身体。' : 'The quick brown fox jumps over the lazy dog.';
}

/** Runtime provider installation is deliberately unsupported in the serverless edition. */
export function registerTtsProvider() {
    throw new Error('Runtime TTS providers are disabled; configure the AI Gateway tts capability instead.');
}

function setStatus(message, isError = false) {
    $('#tts_status').text(message).toggleClass('error', isError);
}

function cleanText(value) {
    const container = document.createElement('div');
    container.innerHTML = String(value ?? '');
    return (container.textContent || '').replace(/\s+/gu, ' ').trim();
}

function stopPlayback() {
    currentAbortController?.abort();
    currentAbortController = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = '';
    $('#tts_media_control').removeClass('fa-stop').addClass('fa-play');
    setStatus('Ready');
}

function base64Blob(value, mime = 'audio/mpeg') {
    const source = value.startsWith('data:') ? value : `data:${mime};base64,${value}`;
    const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/u.exec(source);
    if (!match) throw new Error('TTS returned invalid embedded audio');
    const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
    return new Blob([bytes], { type: match[1] || mime });
}

async function audioFromResponse(response) {
    const type = response.headers.get('content-type') || '';
    if (type.startsWith('audio/')) return response.blob();
    const data = await response.json();
    const value = data?.audio ?? data?.data?.[0]?.audio ?? data?.result?.audio ?? data?.b64_json;
    if (typeof value !== 'string' || !value) throw new Error('TTS capability returned no audio');
    if (/^https?:/iu.test(value)) {
        throw new Error('TTS capability must return streamed audio or embedded base64, not a provider URL');
    }
    return base64Blob(value, data?.mime_type || data?.content_type || 'audio/mpeg');
}

async function speak(text, { voice = '', preview = false } = {}) {
    const normalized = cleanText(text);
    if (!normalized) return;
    stopPlayback();
    currentAbortController = new AbortController();
    setStatus('Generating audio…');
    $('#tts_media_control').removeClass('fa-play').addClass('fa-stop');
    try {
        const response = await runAiCapability('tts', {
            text: normalized,
            voice: voice || extension_settings.tts.voice || undefined,
            preview,
        }, { raw: true, signal: currentAbortController.signal });
        const blob = await audioFromResponse(response);
        currentObjectUrl = URL.createObjectURL(blob);
        audio.src = currentObjectUrl;
        audio.playbackRate = Number(extension_settings.tts.playback_rate) || 1;
        await audio.play();
        setStatus('Playing');
    } catch (error) {
        if (error?.name !== 'AbortError') {
            console.error(error);
            setStatus(error?.message || String(error), true);
            toastr.error(error?.message || String(error), 'TTS failed');
        }
        $('#tts_media_control').removeClass('fa-stop').addClass('fa-play');
    } finally {
        currentAbortController = null;
    }
}

function messageById(messageId) {
    return getContext().chat?.[Number(messageId)];
}

async function narrateMessage(messageId) {
    const message = messageById(messageId);
    if (!message || message.is_user && !extension_settings.tts.narrate_user) return;
    await speak(message.extra?.display_text || message.mes);
}

async function onNarrateClick() {
    const id = $(this).closest('.mes').attr('mesid');
    await narrateMessage(id);
}

async function transcribe(file) {
    if (!file || file.size > 4 * 1024 * 1024) throw new Error('Audio must be 4 MiB or smaller');
    const audioData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Could not read audio'));
        reader.readAsDataURL(file);
    });
    setStatus('Transcribing audio…');
    const result = await runAiCapability('stt', { audio: audioData, mime_type: file.type });
    const text = typeof result === 'string' ? result : extractAiText(result);
    if (!text) throw new Error('STT capability returned no text');
    const textarea = $('#send_textarea');
    const prefix = textarea.val() ? `${textarea.val()} ` : '';
    textarea.val(prefix + text).trigger('input').trigger('focus');
    setStatus('Transcription inserted');
}

function saveSetting(name, value) {
    extension_settings.tts[name] = value;
    saveSettingsDebounced();
}

function addPlaybackControl() {
    const button = $('<div id="tts_media_control" class="fa-solid fa-play extensionsMenuExtensionButton interactable" tabindex="0" title="Play or stop the latest message"></div>');
    $('#tts_wand_container').append(button);
    button.on('click', async () => {
        if (!audio.paused || currentAbortController) return stopPlayback();
        const context = getContext();
        const message = [...(context.chat || [])].reverse().find(item => item && (!item.is_user || extension_settings.tts.narrate_user));
        if (!message) return toastr.info('No message to narrate.');
        await speak(message.extra?.display_text || message.mes);
    });
}

export async function initVoiceMap() {
    return { default: extension_settings.tts?.voice || '' };
}

export async function init() {
    extension_settings.tts = { ...DEFAULT_SETTINGS, ...(extension_settings.tts ?? {}) };
    for (const key of Object.keys(extension_settings.tts)) {
        if (!(key in DEFAULT_SETTINGS)) delete extension_settings.tts[key];
    }

    $('#tts_container').append(await renderExtensionTemplateAsync(MODULE_NAME, 'settings'));
    $('#tts_enabled').prop('checked', extension_settings.tts.enabled).on('change', event => saveSetting('enabled', event.target.checked));
    $('#tts_auto_generation').prop('checked', extension_settings.tts.auto_generation).on('change', event => saveSetting('auto_generation', event.target.checked));
    $('#tts_narrate_user').prop('checked', extension_settings.tts.narrate_user).on('change', event => saveSetting('narrate_user', event.target.checked));
    $('#tts_voice').val(extension_settings.tts.voice).on('input', event => saveSetting('voice', event.target.value.trim()));
    $('#tts_playback_rate').val(extension_settings.tts.playback_rate).on('input', event => {
        const value = Math.max(0.5, Math.min(2, Number(event.target.value) || 1));
        audio.playbackRate = value;
        saveSetting('playback_rate', value);
    });
    $('#tts_preview').on('click', () => speak(getPreviewString(document.documentElement.lang), { preview: true }));
    $('#stt_select').on('click', () => $('#stt_file').trigger('click'));
    $('#stt_file').on('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            await transcribe(file);
        } catch (error) {
            setStatus(error?.message || String(error), true);
            toastr.error(error?.message || String(error), 'STT failed');
        }
    });

    addPlaybackControl();
    $(document).on('click', '.mes_narrate', onNarrateClick);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, id => extension_settings.tts.enabled && extension_settings.tts.auto_generation && narrateMessage(id));
    eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, id => extension_settings.tts.enabled && extension_settings.tts.auto_generation && narrateMessage(id));
    audio.addEventListener('ended', stopPlayback);
    audio.addEventListener('error', () => setStatus('Audio playback failed', true));
    setStatus('Ready — AI Gateway only');
}
