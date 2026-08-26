import { HttpError, json, readJson, requireString } from '../http';
import type { Router } from '../router';

const BUNDLED_EXTENSIONS = [
    { name: 'assets', integration: 'bundled' },
    { name: 'attachments', integration: 'bundled' },
    { name: 'connection-manager', integration: 'bundled' },
    { name: 'gallery', integration: 'bundled' },
    { name: 'quick-reply', integration: 'bundled' },
    { name: 'regex', integration: 'bundled' },
    { name: 'token-counter', integration: 'bundled' },
] as const;

const EXTERNAL_API_EXTENSIONS = [
    { name: 'caption', integration: 'external-api', capabilities: ['image-caption'], providers: ['main-model', 'openai-compatible', 'google', 'ai-horde'] },
    { name: 'expressions', integration: 'external-api', capabilities: ['expression-classification'], providers: ['main-model', 'openai-compatible'] },
    { name: 'memory', integration: 'external-api', capabilities: ['summarization'], providers: ['main-model'] },
    { name: 'stable-diffusion', integration: 'external-api', capabilities: ['image-generation'], providers: ['ai-horde', 'aimlapi', 'bfl', 'chutes', 'comfyui-remote', 'electronhub', 'fal-ai', 'google', 'huggingface', 'nanogpt', 'openai', 'openrouter', 'pollinations', 'stability', 'together', 'workers-ai', 'xai', 'zai'] },
    { name: 'translate', integration: 'external-api', capabilities: ['translation'], providers: ['deepl', 'google', 'libretranslate-remote', 'openai-compatible'] },
    { name: 'tts', integration: 'external-api', capabilities: ['speech-synthesis'], providers: ['azure', 'chutes', 'electronhub', 'elevenlabs', 'google', 'novelai', 'openai-compatible', 'pollinations'] },
    { name: 'vectors', integration: 'external-api', capabilities: ['embedding', 'vector-storage', 'similarity-search'], providers: ['qdrant', 'pinecone'] },
] as const;

const EXTENSION_CATALOG = [...BUNDLED_EXTENSIONS, ...EXTERNAL_API_EXTENSIONS] as const;

const BUILT_IN_EXTENSIONS = EXTENSION_CATALOG.map(extension => extension.name);

const SERVERLESS_MODULES = [
    'caption',
    'expressions',
    'translate',
    'tts',
    'vectors',
] as const;

function immutableExtensionError(): never {
    throw new HttpError(
        409,
        'Runtime extension installation is disabled in the serverless edition; future extensions connect through declared remote APIs',
    );
}

export function registerExtensionRoutes(router: Router): void {
    router.on('GET', '/api/extensions/discover', () => json(BUILT_IN_EXTENSIONS.map(name => ({ type: 'system', name }))));
    router.on('GET', '/api/extensions/catalog', () => json({
        runtimeInstallation: false,
        bundled: BUNDLED_EXTENSIONS,
        externalApi: EXTERNAL_API_EXTENSIONS,
        builtIn: EXTENSION_CATALOG,
    }));
    router.on('GET', '/api/modules', () => json({ modules: SERVERLESS_MODULES }));

    for (const operation of ['install', 'update', 'branches', 'switch', 'move', 'delete']) {
        router.on('POST', `/api/extensions/${operation}`, immutableExtensionError);
    }

    router.on('POST', '/api/extensions/version', async ({ request }) => {
        const body = await readJson(request, 32_768);
        const extensionName = requireString(body.extensionName ?? body.name, 'extensionName', 180);
        const normalized = extensionName.replace(/^third-party\//u, '');
        if (!BUILT_IN_EXTENSIONS.some(name => name === normalized)) throw new HttpError(404, 'Extension not found');
        return json({
            currentBranch: 'bundled',
            branch: 'bundled',
            isUpToDate: true,
            remoteUrl: '',
            commitHash: '8172dcd0',
            commitDate: '2026-07-07T17:36:20.000Z',
        });
    });
}
