import { HttpError, json, readJson, requireString } from '../http';
import type { Router } from '../router';

const BUILT_IN_EXTENSIONS = [
    'assets',
    'attachments',
    'caption',
    'connection-manager',
    'expressions',
    'gallery',
    'memory',
    'quick-reply',
    'regex',
    'stable-diffusion',
    'token-counter',
    'translate',
    'tts',
    'vectors',
] as const;

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
        'Runtime extension installation is unavailable on immutable Pages assets; add the extension to the source repository and redeploy',
    );
}

export function registerExtensionRoutes(router: Router): void {
    router.on('GET', '/api/extensions/discover', () => json(BUILT_IN_EXTENSIONS.map(name => ({ type: 'system', name }))));
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
