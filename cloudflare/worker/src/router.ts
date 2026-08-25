export interface RouteContext {
    request: Request;
    env: Env;
    execution: ExecutionContext;
    url: URL;
    params: Readonly<Record<string, string>>;
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>;

interface DynamicRoute {
    readonly expression: RegExp;
    readonly parameterNames: readonly string[];
    readonly handler: RouteHandler;
}

function compilePattern(pattern: string): Pick<DynamicRoute, 'expression' | 'parameterNames'> {
    const parameterNames: string[] = [];
    const segments = pattern.split('/').map(segment => {
        if (segment === '*') {
            parameterNames.push('wildcard');
            return '(.*)';
        }
        if (segment.startsWith(':')) {
            parameterNames.push(segment.slice(1));
            return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    });
    return { expression: new RegExp(`^${segments.join('/')}$`, 'u'), parameterNames };
}

export class Router {
    readonly #exact = new Map<string, RouteHandler>();
    readonly #dynamic = new Map<string, DynamicRoute[]>();
    readonly #registrations: Array<{ method: string; pattern: string }> = [];

    on(method: string, pattern: string, handler: RouteHandler): this {
        const normalizedMethod = method.toUpperCase();
        this.#registrations.push({ method: normalizedMethod, pattern });
        if (!pattern.includes(':') && !pattern.includes('*')) {
            this.#exact.set(`${normalizedMethod} ${pattern}`, handler);
            return this;
        }
        const compiled = compilePattern(pattern);
        const routes = this.#dynamic.get(normalizedMethod) ?? [];
        routes.push({ ...compiled, handler });
        this.#dynamic.set(normalizedMethod, routes);
        return this;
    }

    registrations(): ReadonlyArray<{ method: string; pattern: string }> {
        return this.#registrations.map(route => ({ ...route }));
    }

    async dispatch(context: Omit<RouteContext, 'params'>): Promise<Response | null> {
        const exact = this.#exact.get(`${context.request.method} ${context.url.pathname}`)
            ?? (context.request.method === 'HEAD' ? this.#exact.get(`GET ${context.url.pathname}`) : undefined);
        if (exact) return exact({ ...context, params: {} });

        const methodRoutes = this.#dynamic.get(context.request.method)
            ?? (context.request.method === 'HEAD' ? this.#dynamic.get('GET') : undefined)
            ?? [];
        for (const route of methodRoutes) {
            const match = route.expression.exec(context.url.pathname);
            if (!match) continue;
            const params: Record<string, string> = {};
            for (let index = 0; index < route.parameterNames.length; index += 1) {
                const parameterName = route.parameterNames[index];
                const value = match[index + 1];
                if (parameterName && value !== undefined) params[parameterName] = decodeURIComponent(value);
            }
            return route.handler({ ...context, params });
        }
        return null;
    }
}
