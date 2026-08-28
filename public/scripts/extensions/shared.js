import { runAiCapability } from '../ai-client.js';
import { createThumbnail } from '../utils.js';

/**
 * Caption an image through the configured AI Gateway capability.
 * The browser performs the only image resize; no provider endpoint is accepted.
 */
export async function getMultimodalCaption(base64Img, prompt) {
    const mimeType = base64Img?.split(';')?.[0]?.split(':')?.[1] || 'image/jpeg';
    if (!mimeType.startsWith('image/')) throw new Error('Only images can be captioned');
    if (base64Img.length > 2 * 1024 * 1024) base64Img = await createThumbnail(base64Img, 2048, 2048);
    const result = await runAiCapability('caption', { image: base64Img, prompt });
    return String(result?.caption ?? result).trim();
}

const BUILTIN_PROFILES = Object.freeze([
    { id: 'chat', name: 'AI Gateway · Chat', capability: 'chat' },
    { id: 'text', name: 'AI Gateway · Text', capability: 'text' },
]);

/**
 * Source-extension compatibility facade. A "profile" is now a fixed Gateway
 * capability and never contains a provider, URL, proxy, or secret.
 */
export class ConnectionManagerRequestService {
    static defaultSendRequestParams = {
        stream: false,
        signal: null,
        extractData: true,
        includePreset: true,
        includeInstruct: true,
        instructSettings: {},
    };

    static getAllowedTypes() {
        return { chat: 'AI Gateway · Chat', text: 'AI Gateway · Text' };
    }

    static async sendRequest(profileId, prompt, maxTokens, custom = this.defaultSendRequestParams, overridePayload = {}) {
        const profile = this.getProfile(profileId || 'chat');
        const { stream, signal, extractData, includePreset, includeInstruct, instructSettings } = {
            ...this.defaultSendRequestParams,
            ...custom,
        };
        const context = SillyTavern.getContext();
        if (profile.capability === 'text') {
            return context.TextCompletionService.processRequest({
                stream,
                prompt,
                max_tokens: maxTokens,
                ...overridePayload,
            }, {
                presetName: includePreset ? overridePayload.preset : undefined,
                instructName: includeInstruct ? overridePayload.instruct : undefined,
                instructSettings,
            }, extractData, signal);
        }
        const messages = Array.isArray(prompt) ? prompt : [{ role: 'user', content: prompt }];
        return context.ChatCompletionService.processRequest({
            stream,
            messages,
            max_tokens: maxTokens,
            ...overridePayload,
        }, {
            presetName: includePreset ? overridePayload.preset : undefined,
        }, extractData, signal);
    }

    static constructPrompt(prompt, profileId, instructSettings = null) {
        const profile = this.getProfile(profileId || 'chat');
        if (profile.capability === 'chat') return prompt;
        return SillyTavern.getContext().TextCompletionService.constructPrompt(prompt, undefined, instructSettings);
    }

    static getSupportedProfiles() {
        return [...BUILTIN_PROFILES];
    }

    static getProfile(profileId) {
        const profile = BUILTIN_PROFILES.find(item => item.id === profileId);
        if (!profile) throw new Error(`Unknown Gateway capability profile: ${profileId}`);
        return profile;
    }

    static getProfileIcon() {
        return null;
    }

    static isProfileSupported(profile) {
        return BUILTIN_PROFILES.some(item => item.id === profile?.id);
    }

    static validateProfile(profile) {
        if (!this.isProfileSupported(profile)) throw new Error('Unsupported Gateway capability profile');
        return { selected: profile.capability, capability: profile.capability };
    }

    static handleDropdown(selector, initialSelectedProfileId, onChange = () => {}) {
        const dropdown = $(selector);
        if (!dropdown.length) throw new Error(`Could not find dropdown with selector ${selector}`);
        dropdown.empty();
        for (const profile of BUILTIN_PROFILES) {
            dropdown.append(new Option(profile.name, profile.id, false, profile.id === initialSelectedProfileId));
        }
        dropdown.off('change.gatewayProfiles').on('change.gatewayProfiles', () => {
            void onChange(this.getProfile(String(dropdown.val())));
        });
        return dropdown;
    }

    static watchProfile() {
        return () => {};
    }
}
