const FALLBACK_TO_PAGES_PREFIXES = [
    '/backgrounds/',
    '/characters/',
    '/User%20Avatars/',
    '/assets/',
    '/scripts/extensions/third-party/',
] as const;

function mayUseStaticFallback(pathname: string): boolean {
    return FALLBACK_TO_PAGES_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export const onRequest: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const headers = new Headers(context.request.headers);
    headers.set('x-sillytavern-pages-origin', url.origin);

    const upstreamRequest = new Request(context.request, { headers });
    const response = await context.env.API.fetch(upstreamRequest);

    if ((context.request.method === 'GET' || context.request.method === 'HEAD')
        && response.status === 404
        && mayUseStaticFallback(url.pathname)) {
        return context.next();
    }

    return response;
};
