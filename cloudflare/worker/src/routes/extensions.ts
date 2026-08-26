import { HttpError, json, readJson, requireString } from '../http';
import type { Router } from '../router';

const EXTENSION_CATALOG = [
    { name: 'assets', integration: 'bundled' },
    { name: 'attachments', integration: 'bundled' },
    { name: 'caption', integration: 'worker-api' },
    { name: 'connection-manager', integration: 'bundled' },
    { name: 'expressions', integration: 'worker-api' },
    { name: 'gallery', integration: 'bundled' },
    { name: 'memory', integration: 'worker-api' },
    { name: 'quick-reply', integration: 'bundled' },
    { name: 'regex', integration: 'bundled' },
    { name: 'stable-diffusion', integration: 'worker-api' },
    { name: 'token-counter', integration: 'bundled' },
    { name: 'translate', integration: 'worker-api' },
    { name: 'tts', integration: 'worker-api' },
    { name: 'vectors', integration: 'worker-api' },
] as const;

const BUILT_IN_EXTENSIONS = EXTENSION_CATALOG.map(extension => extension.name);

const SERVERLESS_MODULES = [
    'caption',
    'classify',
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
        builtIn: EXTENSION_CATALOG,
        externalApi: [],
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
