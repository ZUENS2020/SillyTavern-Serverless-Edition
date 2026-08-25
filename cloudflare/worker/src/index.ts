import { HttpError, json, withCors } from './http';
import { Router } from './router';
import { registerCharacterRoutes } from './routes/characters';
import { registerAssetRoutes } from './routes/assets';
import { registerBackupRoutes } from './routes/backups';
import { registerChatRoutes } from './routes/chats';
import { registerClassificationRoutes } from './routes/classification';
import { registerCompatibilityRoutes } from './routes/compatibility';
import { registerContentRoutes } from './routes/content';
import { registerExternalRoutes } from './routes/external';
import { registerExtensionRoutes } from './routes/extensions';
import { registerHordeRoutes } from './routes/horde';
import { registerMediaRoutes } from './routes/media';
import { registerMultimediaRoutes } from './routes/multimedia';
import { registerProviderRoutes } from './routes/providers';
import { registerSecretRoutes } from './routes/secrets';
import { registerSpriteRoutes } from './routes/sprites';
import { registerStableDiffusionRoutes } from './routes/stable-diffusion';
import { registerStateRoutes } from './routes/state';
import { registerSystemRoutes } from './routes/system';
import { registerTokenizerRoutes } from './routes/tokenizers';
import { registerVectorRoutes } from './routes/vectors';

const router = new Router();
registerSystemRoutes(router);
registerAssetRoutes(router);
registerBackupRoutes(router);
registerStateRoutes(router);
registerCharacterRoutes(router);
registerChatRoutes(router);
registerClassificationRoutes(router);
registerCompatibilityRoutes(router);
registerContentRoutes(router);
registerExternalRoutes(router);
registerExtensionRoutes(router);
registerHordeRoutes(router);
registerMediaRoutes(router);
registerMultimediaRoutes(router);
registerSecretRoutes(router);
registerProviderRoutes(router);
registerTokenizerRoutes(router);
registerSpriteRoutes(router);
registerStableDiffusionRoutes(router);
registerVectorRoutes(router);

export function registeredRoutes(): ReadonlyArray<{ method: string; pattern: string }> {
    return router.registrations();
}

function optionsResponse(): Response {
    return new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
            'access-control-allow-headers': 'content-type, x-csrf-token, authorization, x-api-key',
            'access-control-max-age': '86400',
        },
    });
}

function errorResponse(error: unknown): Response {
    if (error instanceof HttpError) {
        return json({ error: error.expose ? error.message : 'Internal server error' }, { status: error.status });
    }
    console.error('Unhandled Worker error', error);
    return json({ error: 'Internal server error' }, { status: 500 });
}

export default {
    async fetch(request, env, execution): Promise<Response> {
        if (request.method === 'OPTIONS') return optionsResponse();
        const url = new URL(request.url);
        try {
            const response = await router.dispatch({ request, env, execution, url });
            return withCors(response ?? json({ error: 'Not found' }, { status: 404 }));
        } catch (error) {
            return withCors(errorResponse(error));
        }
    },
} satisfies ExportedHandler<Env>;
