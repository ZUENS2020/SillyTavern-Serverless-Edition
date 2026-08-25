import { empty, HttpError, json, readJson, requireString, text } from '../http';
import type { Router } from '../router';

const DEFAULT_USER = {
    handle: 'default-user',
    name: 'User',
    avatar: '/User%20Avatars/user-default.png',
    admin: true,
    password: false,
    created: 0,
} as const;

export function registerSystemRoutes(router: Router): void {
    router.on('GET', '/csrf-token', () => json({ token: 'disabled' }));
    router.on('GET', '/version', ({ env }) => json({
        agent: `${env.APP_NAME}/${env.APP_VERSION}`,
        pkgVersion: env.APP_VERSION,
        pkgName: 'sillytavern-serverless-edition',
        gitRevision: '8172dcd0',
        gitBranch: 'main',
        commitDate: '2026-07-07T17:36:20.000Z',
        isLatest: true,
    }));
    router.on('POST', '/api/ping', () => empty());
    router.on('GET', '/api/users/me', () => json(DEFAULT_USER));
    router.on('POST', '/api/users/list', () => json([DEFAULT_USER]));
    router.on('POST', '/api/users/login', () => json({ handle: DEFAULT_USER.handle }));
    router.on('POST', '/api/users/logout', () => empty());
    router.on('POST', '/api/users/get', () => json([DEFAULT_USER]));
    router.on('POST', '/api/users/change-name', () => empty());
    router.on('POST', '/api/users/change-password', () => empty());
    router.on('POST', '/api/users/change-avatar', () => empty());
    router.on('POST', '/api/users/slugify', async ({ request }) => {
        const body = await readJson(request, 16_384);
        const value = requireString(body.text, 'text', 512).normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
            .toLowerCase().trim().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
        return text(value);
    });
    for (const operation of ['create', 'delete', 'promote', 'demote', 'disable', 'enable']) {
        router.on('POST', `/api/users/${operation}`, () => {
            throw new HttpError(409, 'This deployment intentionally uses one shared user and has no account administration');
        });
    }
    router.on('POST', '/api/users/backup', () => {
        throw new HttpError(422, 'Full ZIP export is unavailable in the free-CPU profile; export chats and cards from their respective screens');
    });
    for (const operation of ['recover-step1', 'recover-step2', 'reset-step1', 'reset-step2']) {
        router.on('POST', `/api/users/${operation}`, () => {
            throw new HttpError(409, 'Password recovery and account reset do not apply because application authentication is disabled');
        });
    }
    router.on('POST', '/api/users/reset-settings', async ({ env }) => {
        await env.DB.prepare("DELETE FROM app_state WHERE namespace = 'settings' AND key = 'current'").run();
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
