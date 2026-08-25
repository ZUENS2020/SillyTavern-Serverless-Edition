import { empty, HttpError, json, readJson } from '../http';
import type { Router } from '../router';

const EMPTY_DATA_MAID_REPORT = {
    images: [],
    files: [],
    chats: [],
    groupChats: [],
    avatarThumbnails: [],
    backgroundThumbnails: [],
    personaThumbnails: [],
    chatBackups: [],
    settingsBackups: [],
} as const;

function unavailable(feature: string): never {
    throw new HttpError(422, `${feature} is unavailable in the Cloudflare free-CPU profile`);
}

export function registerCompatibilityRoutes(router: Router): void {
    // R2 objects are explicitly indexed in D1, so there is no loose filesystem to scan.
    router.on('POST', '/api/data-maid/report', () => json({ report: EMPTY_DATA_MAID_REPORT, token: crypto.randomUUID() }));
    router.on('POST', '/api/data-maid/finalize', async ({ request }) => {
        await readJson(request, 16_384);
        return empty();
    });
    router.on('POST', '/api/data-maid/delete', async ({ request }) => {
        await readJson(request, 65_536);
        return empty();
    });
    router.on('GET', '/api/data-maid/view', () => json({ error: 'No loose R2 object exists for this hash' }, { status: 404 }));

    router.on('POST', '/api/google/generate-video', () => unavailable('Google video generation and base64 repackaging'));
    router.on('POST', '/api/openai/generate-video', () => unavailable('OpenAI video generation and base64 repackaging'));
    router.on('POST', '/api/novelai/generate-image', () => unavailable('NovelAI ZIP image extraction and upscaling'));
    router.on('POST', '/api/minimax/generate-voice', () => unavailable('MiniMax hex-audio conversion'));
    router.on('POST', '/api/volcengine/generate-voice', () => unavailable('Volcengine NDJSON audio assembly'));

    router.on('POST', '/api/edge-tts/generate', () => unavailable('Local Edge TTS plugin'));
    router.on('POST', '/api/edge-tts/list', () => unavailable('Local Edge TTS plugin'));
    router.on('POST', '/api/plugins/edge-tts/generate', () => unavailable('Edge TTS server plugin'));
    router.on('POST', '/api/plugins/edge-tts/list', () => unavailable('Edge TTS server plugin'));
    router.on('POST', '/api/plugins/edge-tts/probe', () => unavailable('Edge TTS server plugin'));
    router.on('POST', '/api/plugins/fandom/probe', () => unavailable('Fandom server plugin'));
    router.on('POST', '/api/plugins/fandom/probe-mediawiki', () => unavailable('Fandom server plugin'));
    router.on('POST', '/api/plugins/fandom/scrape', () => unavailable('Fandom server plugin'));
    router.on('POST', '/api/plugins/fandom/scrape-mediawiki', () => unavailable('Fandom server plugin'));
    router.on('POST', '/api/plugins/office/parse', () => unavailable('Office document parsing plugin'));
    router.on('POST', '/api/plugins/office/probe', () => unavailable('Office document parsing plugin'));

    router.on('POST', '/api/text-to-speech/coqui/coqui-api/check-model-state', () => unavailable('Local Coqui model management'));
    router.on('POST', '/api/text-to-speech/coqui/coqui-api/install-model', () => unavailable('Local Coqui model management'));
    router.on('POST', '/api/text-to-speech/coqui/generate-tts', () => unavailable('Local Coqui inference'));
    router.on('POST', '/api/text-to-speech/coqui/local/get-models', () => unavailable('Local Coqui inference'));

    // These are normally hosted by a separately configured SillyTavern Extras/XTTS endpoint.
    router.on('POST', '/api/image', () => unavailable('SillyTavern Extras image generation'));
    router.on('GET', '/api/image/model', () => unavailable('SillyTavern Extras image generation'));
    router.on('POST', '/api/image/model', () => unavailable('SillyTavern Extras image generation'));
    router.on('GET', '/api/image/models', () => unavailable('SillyTavern Extras image generation'));
    router.on('GET', '/api/image/samplers', () => unavailable('SillyTavern Extras image generation'));
    router.on('GET', '/api/tts', () => unavailable('External XTTS/Silero service'));
    router.on('POST', '/api/tts', () => unavailable('External XTTS/Silero service'));
}
