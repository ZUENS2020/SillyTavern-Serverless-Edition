import { HttpError, json, withSecurityHeaders } from './http';
import { Router } from './router';
import { requireAccess } from './security/access';
import { optionsResponse, validateRequestBoundary } from './security/request';
import { registerCharacterRoutes } from './routes/characters';
import { registerAssetRoutes } from './routes/assets';
import { registerBackupRoutes } from './routes/backups';
import { registerChatRoutes } from './routes/chats';
import { registerAiRoutes } from './routes/ai';
import { registerExtensionRoutes } from './routes/extensions';
import { registerJobRoutes } from './routes/jobs';
import { registerMediaRoutes } from './routes/media';
import { registerSpriteRoutes } from './routes/sprites';
import { registerStateRoutes } from './routes/state';
import { registerSystemRoutes } from './routes/system';
import { registerVectorRoutes } from './routes/vectors';
export { MaintenanceWorkflow } from './workflows/maintenance';

const router = new Router();
registerSystemRoutes(router);
registerAssetRoutes(router);
registerBackupRoutes(router);
registerStateRoutes(router);
registerCharacterRoutes(router);
registerChatRoutes(router);
registerExtensionRoutes(router);
registerAiRoutes(router);
registerJobRoutes(router);
registerMediaRoutes(router);
registerSpriteRoutes(router);
registerVectorRoutes(router);

export function registeredRoutes(): ReadonlyArray<{ method: string; pattern: string }> {
    return router.registrations();
}

function errorResponse(error: unknown): Response {
    if (error instanceof HttpError) {
        return json({ error: error.expose ? error.message : 'Internal server error' }, { status: error.status });
    }
    console.error('Unhandled Worker error', {
        name: error instanceof Error ? error.name : 'UnknownError',
    });
    return json({ error: 'Internal server error' }, { status: 500 });
}

function mayFallBackToAssets(request: Request): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    return !new URL(request.url).pathname.startsWith('/api/');
}

export default {
    async fetch(request, env, execution): Promise<Response> {
        if (request.method === 'OPTIONS') return optionsResponse(request, env);
        const url = new URL(request.url);
        try {
            validateRequestBoundary(request, env);
            await requireAccess(request, env);
            const response = await router.dispatch({ request, env, execution, url });
            if (response) return withSecurityHeaders(response, env.APP_ORIGIN);
            if (mayFallBackToAssets(request)) return withSecurityHeaders(await env.ASSETS.fetch(request));
            return withSecurityHeaders(json({ error: 'Not found' }, { status: 404 }), env.APP_ORIGIN);
        } catch (error) {
            return withSecurityHeaders(errorResponse(error), env.APP_ORIGIN);
        }
    },
} satisfies ExportedHandler<Env>;
