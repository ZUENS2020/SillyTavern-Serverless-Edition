import { HttpError, json, readJson, requireString } from '../http';
import type { RouteContext, Router } from '../router';
import { THIRD_PARTY_EXTENSIONS } from '../third-party-extensions.generated';

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

const THIRD_PARTY_EXTENSION_IDS: readonly string[] = THIRD_PARTY_EXTENSIONS;

const SERVERLESS_MODULES = [
    'caption',
    'expressions',
    'translate',
    'tts',
    'vectors',
] as const;

const ASSET_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function immutableExtensionError(): never {
    throw new HttpError(
        410,
        'Runtime extension installation has been permanently removed; extensions are reviewed source manifests backed by Gateway capabilities',
    );
}

function discoverEntries(): Array<{ type: 'system' | 'local'; name: string }> {
    return [
        ...BUILT_IN_EXTENSIONS.map(name => ({ type: 'system' as const, name })),
        ...THIRD_PARTY_EXTENSION_IDS.map(name => ({ type: 'local' as const, name: `third-party/${name}` })),
    ];
}

function isBundledExtension(name: string): boolean {
    return BUILT_IN_EXTENSIONS.some(item => item === name);
}

function isDeployTimeThirdParty(name: string): boolean {
    const id = name.replace(/^third-party\//u, '');
    return THIRD_PARTY_EXTENSION_IDS.includes(id);
}

function versionPayload(kind: 'bundled' | 'deploy-time') {
    return {
        currentBranch: kind,
        branch: kind,
        isUpToDate: true,
        remoteUrl: '',
        commitHash: kind === 'bundled' ? '8172dcd0' : '',
        commitDate: kind === 'bundled' ? '2026-07-07T17:36:20.000Z' : '',
    };
}

function assertThirdPartyAssetPath(wildcard: string): string {
    const parts = wildcard.replaceAll('\\', '/').split('/').filter(Boolean);
    if (parts.length < 2) throw new HttpError(400, 'Invalid extension asset path');
    if (parts.some(part => part === '.' || part === '..' || part.startsWith('.') || !ASSET_SEGMENT.test(part))) {
        throw new HttpError(400, 'Invalid extension asset path');
    }
    return parts.join('/');
}

async function serveThirdPartyExtension({ request, env, params }: RouteContext): Promise<Response> {
    assertThirdPartyAssetPath(params.wildcard ?? '');
    // Zip overlay: look up R2 object `extensions/${wildcard}` before falling through to Static Assets.
    // Return the ASSETS response as-is, including HTML 307 rewrites. Converting
    // those to JSON 404 breaks settings.html and other extension documents.
    return env.ASSETS.fetch(request);
}

export function registerExtensionRoutes(router: Router): void {
    router.on('GET', '/api/extensions/discover', () => json(discoverEntries()));
    router.on('GET', '/api/extensions/catalog', () => json({
        runtimeInstallation: false,
        deployTimeThirdParty: true,
        bundled: BUNDLED_EXTENSIONS,
        thirdParty: THIRD_PARTY_EXTENSION_IDS.map(name => ({ name, integration: 'deploy-time' })),
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
        if (isDeployTimeThirdParty(normalized)) return json(versionPayload('deploy-time'));
        if (!isBundledExtension(normalized)) throw new HttpError(404, 'Extension not found');
        return json(versionPayload('bundled'));
    });

    router.on('GET', '/scripts/extensions/third-party/*', serveThirdPartyExtension);
    router.on('HEAD', '/scripts/extensions/third-party/*', serveThirdPartyExtension);
}
