import { HttpError } from '../http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function expectedOrigin(env: Env): URL {
    const origin = new URL(env.APP_ORIGIN);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('APP_ORIGIN must be an HTTPS origin');
    }
    return origin;
}

function isTestRequest(request: Request, env: Env): boolean {
    if (String(env.TEST_BYPASS_ACCESS) !== 'true') return false;
    const hostname = new URL(request.url).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.test');
}

export function validateRequestBoundary(request: Request, env: Env): void {
    if (isTestRequest(request, env)) return;
    const expected = expectedOrigin(env);
    const actual = new URL(request.url);
    if (actual.origin !== expected.origin || request.headers.get('host') !== expected.host) {
        throw new HttpError(403, 'Request host is not allowed');
    }

    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        throw new HttpError(403, 'Cross-site requests are not allowed');
    }
    if (SAFE_METHODS.has(request.method)) return;

    const origin = request.headers.get('origin');
    if (origin !== expected.origin) throw new HttpError(403, 'Request origin is not allowed');
    const fetchMode = request.headers.get('sec-fetch-mode');
    if (fetchMode && fetchMode !== 'cors' && fetchMode !== 'same-origin' && fetchMode !== 'navigate') {
        throw new HttpError(403, 'Request mode is not allowed');
    }
}

export function optionsResponse(request: Request, env: Env): Response {
    validateRequestBoundary(request, env);
    const origin = expectedOrigin(env).origin;
    return new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
            'access-control-allow-headers': 'content-type, if-match, if-none-match',
            'access-control-max-age': '600',
            'vary': 'Origin',
        },
    });
}
