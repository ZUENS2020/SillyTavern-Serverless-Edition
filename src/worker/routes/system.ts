import { empty, json } from '../http';
import type { Router } from '../router';

export function registerSystemRoutes(router: Router): void {
    router.on('GET', '/version', ({ env }) => json({
        agent: `${env.APP_NAME}/${env.APP_VERSION}`,
        pkgVersion: env.APP_VERSION,
        pkgName: 'sillytavern-serverless-edition',
        serverless: true,
        singleInstance: true,
        authentication: 'cloudflare-access',
    }));
    router.on('POST', '/api/ping', () => empty());
    router.on('POST', '/api/settings/reset', async ({ env }) => {
        await env.DB.prepare("DELETE FROM settings WHERE section = 'settings' AND key = 'current'").run();
        await Promise.all([
            env.CACHE.delete('state:settings:current'),
            env.CACHE.delete('state-list:settings'),
        ]);
        return empty();
    });
    router.on('GET', '/callback/:source', ({ url, params }) => {
        const target = new URL('/', url);
        target.searchParams.set('source', params.source ?? '');
        const originalQuery = url.searchParams.toString();
        if (originalQuery) target.searchParams.set('query', originalQuery);
        return Response.redirect(target, 307);
    });
    router.on('GET', '/callback', ({ url }) => {
        const target = new URL('/', url);
        const originalQuery = url.searchParams.toString();
        if (originalQuery) target.searchParams.set('query', originalQuery);
        return Response.redirect(target, 307);
    });
}
