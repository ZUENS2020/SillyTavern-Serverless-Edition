import { getBase64Async, getFileExtension, saveBase64AsFile } from '../../utils.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { chat_metadata, eventSource, event_types, saveSettingsDebounced, substituteParams } from '../../../script.js';
import { getMessageTimeStamp } from '../../RossAscends-mods.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../constants.js';
import { Popup } from '../../popup.js';
import { runAiCapability } from '../../ai-client.js';

export const MODULE_NAME = 'caption';
const PROMPT_DEFAULT = 'Describe this image accurately and concisely.';
const TEMPLATE_DEFAULT = '[{{user}} sends {{char}} a picture that contains: {{caption}}]';

async function captionDataUrl(dataUrl, prompt = '') {
    const instruction = substituteParams(prompt || extension_settings.caption.prompt || PROMPT_DEFAULT);
    const caption = await runAiCapability('caption', {
        prompt: instruction,
        image: dataUrl,
        messages: [{
            role: 'user',
            content: [{ type: 'text', text: instruction }, { type: 'image_url', image_url: { url: dataUrl } }],
        }],
    });
    if (typeof caption !== 'string' || !caption.trim()) throw new Error('Caption capability returned no text');
    return caption.trim();
}

async function captionFile(file, prompt = '') {
    if (!file.type.startsWith('image/')) throw new Error('Only images are supported by the caption capability');
    return captionDataUrl(await getBase64Async(file), prompt);
}

async function wrappedCaption(caption) {
    let template = extension_settings.caption.template || TEMPLATE_DEFAULT;
    if (!/\{\{caption\}\}/iu.test(template)) template += ' {{caption}}';
    let result = substituteParams(template, { dynamicMacros: { caption } });
    if (extension_settings.caption.refine_mode) {
        result = await Popup.show.input('Review caption', 'Edit the caption before it is sent.', result, { rows: 8, okButton: 'Send' });
        if (!result) throw new Error('Caption was cancelled');
    }
    return result;
}

async function sendCaptionedImage(file) {
    const context = getContext();
    const dataUrl = await getBase64Async(file);
    const caption = await captionDataUrl(dataUrl);
    const messageText = await wrappedCaption(caption);
    const extension = getFileExtension(file) || 'png';
    const imagePath = await saveBase64AsFile(dataUrl, context.name2, '', extension);
    const media = {
        url: imagePath,
        type: MEDIA_TYPE.IMAGE,
        title: messageText,
        captioned: true,
        source: MEDIA_SOURCE.CAPTIONED,
    };
    const message = {
        name: context.name1,
        is_user: true,
        send_date: getMessageTimeStamp(),
        mes: messageText,
        extra: { media: [media], media_display: MEDIA_DISPLAY.GALLERY, media_index: 0, inline_image: Boolean(extension_settings.caption.show_in_chat) },
    };
    chat_metadata.tainted = true;
    context.chat.push(message);
    const id = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_SENT, id);
    context.addOneMessage(message);
    await eventSource.emit(event_types.USER_MESSAGE_RENDERED, id);
    await context.saveChat();
}

async function captionExistingMessage(messageId) {
    const context = getContext();
    const message = context.chat[messageId];
    if (!message?.extra?.media?.length) return;
    for (const media of message.extra.media) {
        if (media.type !== MEDIA_TYPE.IMAGE || media.captioned) continue;
        const response = await fetch(media.url);
        if (!response.ok) continue;
        const caption = await captionFile(new File([await response.blob()], 'image', { type: response.headers.get('content-type') || 'image/png' }));
        const text = await wrappedCaption(caption);
        media.title = text;
        media.captioned = true;
        media.append_title = true;
    }
    await context.saveChat();
}

export async function init() {
    extension_settings.caption ??= {};
    Object.assign(extension_settings.caption, {
        prompt: extension_settings.caption.prompt || PROMPT_DEFAULT,
        template: extension_settings.caption.template || TEMPLATE_DEFAULT,
        refine_mode: Boolean(extension_settings.caption.refine_mode),
        auto_mode: Boolean(extension_settings.caption.auto_mode),
        show_in_chat: Boolean(extension_settings.caption.show_in_chat),
    });
    for (const key of ['source', 'local', 'multimodal_api', 'multimodal_model', 'alt_endpoint_url', 'custom_model']) delete extension_settings.caption[key];

    $('#caption_container').append(await renderExtensionTemplateAsync('caption', 'settings', { TEMPLATE_DEFAULT, PROMPT_DEFAULT }));
    const input = $('<input>', { type: 'file', accept: 'image/*', hidden: true });
    const button = $(`<div id="send_picture" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <div class="fa-solid fa-image extensionsMenuExtensionButton"></div><span>Caption image</span></div>`);
    $('#extensionsMenu').append(button, input);
    button.on('click', () => input.trigger('click'));
    input.on('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            await sendCaptionedImage(file);
        } catch (error) {
            console.error(error);
            toastr.error(String(error), 'Failed to caption image');
        }
    });

    $('#caption_prompt').val(extension_settings.caption.prompt).on('input', event => {
        extension_settings.caption.prompt = event.target.value;
        saveSettingsDebounced();
    });
    $('#caption_template').val(extension_settings.caption.template).on('input', event => {
        extension_settings.caption.template = event.target.value;
        saveSettingsDebounced();
    });
    for (const key of ['refine_mode', 'auto_mode', 'show_in_chat']) {
        $(`#caption_${key}`).prop('checked', extension_settings.caption[key]).on('input', event => {
            extension_settings.caption[key] = event.target.checked;
            saveSettingsDebounced();
        });
    }
    eventSource.on(event_types.USER_MESSAGE_RENDERED, id => extension_settings.caption.auto_mode && captionExistingMessage(id));
}
