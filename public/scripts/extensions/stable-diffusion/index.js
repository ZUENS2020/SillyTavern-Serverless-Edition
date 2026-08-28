import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { saveSettingsDebounced } from '../../../script.js';
import { Popup } from '../../popup.js';
import { runAiCapability } from '../../ai-client.js';
import { saveBase64AsFile } from '../../utils.js';

export const MODULE_NAME = 'stable-diffusion';

function imageFromJson(data) {
    const value = data?.data?.[0]?.b64_json ?? data?.image ?? data?.result?.image ?? data?.url ?? data?.data?.[0]?.url;
    if (typeof value !== 'string' || !value) throw new Error('Image capability returned no image');
    return value.startsWith('http') || value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
}

async function generateImage(prompt) {
    const response = await runAiCapability('image', { prompt }, { raw: true });
    const type = response.headers.get('content-type') ?? '';
    if (type.startsWith('image/')) return URL.createObjectURL(await response.blob());
    return imageFromJson(await response.json());
}

async function openGenerator(initialPrompt = '') {
    const prompt = await Popup.show.input('Generate image', 'Describe the image to generate with the configured AI Gateway capability.', initialPrompt, { rows: 6, okButton: 'Generate' });
    if (!prompt) return '';
    const toast = toastr.info('Generating image…', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const imageUrl = await generateImage(String(prompt));
        const container = $('<div class="flex-container flexFlowColumn">');
        const image = $('<img class="wide100p">').attr('src', imageUrl);
        const save = $('<button class="menu_button">Save to gallery</button>');
        save.on('click', async () => {
            const saved = await saveBase64AsFile(imageUrl, 'generated', `image-${Date.now()}`, 'png');
            toastr.success(`Saved ${saved}`, 'Image generation');
        });
        container.append(image, save);
        await Popup.show.text('Generated image', container);
        return imageUrl;
    } finally {
        toastr.clear(toast);
    }
}

export async function SD_ProcessTriggers(type, args) {
    if (type !== 'sd') return;
    await openGenerator(args?.prompt || '');
}

export async function init() {
    extension_settings.sd = { prompt_prefix: '', ...(extension_settings.sd ?? {}) };
    for (const key of Object.keys(extension_settings.sd)) {
        if (key !== 'prompt_prefix') delete extension_settings.sd[key];
    }
    $('#sd_container').append(await renderExtensionTemplateAsync(MODULE_NAME, 'settings'));
    const button = $(`<div id="sd_gen" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <div class="fa-solid fa-paintbrush extensionsMenuExtensionButton"></div><span>Generate image</span></div>`);
    $('#extensionsMenu').append(button);
    button.on('click', () => openGenerator(extension_settings.sd.prompt_prefix));
    $('#sd_prompt_prefix').val(extension_settings.sd.prompt_prefix).on('input', event => {
        extension_settings.sd.prompt_prefix = event.target.value;
        saveSettingsDebounced();
    });
}
