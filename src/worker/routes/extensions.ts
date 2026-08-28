import { HttpError, json, readJson, requireString } from '../http';
import type { Router } from '../router';

const BUNDLED_EXTENSIONS = [
    { name: 'assets', integration: 'bundled' },
    { name: 'attachments', integration: 'bundled' },
    { name: 'gallery', integration: 'bundled' },
    { name: 'quick-reply', integration: 'bundled' },
    { name: 'regex', integration: 'bundled' },
    { name: 'token-counter', integration: 'bundled' },
] as const;

const GATEWAY_CAPABILITY_EXTENSIONS = [
    { name: 'caption', integration: 'gateway-capability', capabilities: ['caption'] },
    { name: 'expressions', integration: 'gateway-capability', capabilities: ['classification'] },
    { name: 'memory', integration: 'gateway-capability', capabilities: ['text'] },
    { name: 'stable-diffusion', integration: 'gateway-capability', capabilities: ['image'] },
    { name: 'translate', integration: 'gateway-capability', capabilities: ['translation'] },
    { name: 'tts', integration: 'gateway-capability', capabilities: ['tts', 'stt'] },
    { name: 'vectors', integration: 'gateway-capability', capabilities: ['embedding', 'vectorize'] },
    { name: 'capability-profiles', integration: 'gateway-capability', capabilities: ['configuration'] },
] as const;

const EXTENSION_CATALOG = [...BUNDLED_EXTENSIONS, ...GATEWAY_CAPABILITY_EXTENSIONS] as const;

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
        410,
        'Runtime extension installation has been permanently removed; extensions are reviewed source manifests backed by Gateway capabilities',
    );
}

export function registerExtensionRoutes(router: Router): void {
    router.on('GET', '/api/extensions/discover', () => json(BUILT_IN_EXTENSIONS.map(name => ({ type: 'system', name }))));
    router.on('GET', '/api/extensions/catalog', () => json({
        runtimeInstallation: false,
        bundled: BUNDLED_EXTENSIONS,
        gatewayCapabilities: GATEWAY_CAPABILITY_EXTENSIONS,
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
