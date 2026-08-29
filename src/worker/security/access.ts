import {
    createRemoteJWKSet,
    errors as joseErrors,
    jwtVerify,
    type JWTPayload,
    type JWTVerifyGetKey,
} from 'jose';

import { HttpError } from '../http';
import { isTestBypassRequest } from './request';

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export interface AccessIdentity {
    subject: string;
    diagnosticId: string;
    expiresAt: number;
}

export interface AccessVerificationConfig {
    issuer: string;
    audience: string;
}

function normalizedIssuer(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('ACCESS_TEAM_DOMAIN must be an HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('ACCESS_TEAM_DOMAIN must be an HTTPS origin');
    }
    return url.origin;
}

function remoteKeySet(issuer: string): ReturnType<typeof createRemoteJWKSet> {
    const existing = remoteKeySets.get(issuer);
    if (existing) return existing;
    const created = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', `${issuer}/`), {
        timeoutDuration: 3_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 3_600_000,
    });
    remoteKeySets.set(issuer, created);
    return created;
}

async function diagnosticId(subject: string): Promise<string> {
    const encoded = new TextEncoder().encode(subject);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return [...new Uint8Array(digest).slice(0, 12)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function subjectFromPayload(payload: JWTPayload): string {
    if (typeof payload.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 512) {
        return payload.sub;
    }
    // Access intentionally leaves `sub` empty for service-token application JWTs.
    // Hash the signed client ID as the diagnostic principal without retaining it.
    const commonName = payload.common_name;
    if (typeof commonName === 'string' && commonName.length > 0 && commonName.length <= 512) {
        return `service-token:${commonName}`;
    }
    throw new HttpError(403, 'Cloudflare Access identity is invalid');
}

export async function verifyAccessJwt(
    token: string,
    config: AccessVerificationConfig,
    getKey?: JWTVerifyGetKey,
): Promise<AccessIdentity> {
    const issuer = normalizedIssuer(config.issuer);
    if (!config.audience || config.audience.startsWith('SET_')) {
        throw new Error('ACCESS_AUD is not configured');
    }
    try {
        const { payload } = await jwtVerify(token, getKey ?? remoteKeySet(issuer), {
            issuer,
            audience: config.audience,
            algorithms: ['RS256'],
            clockTolerance: 5,
        });
        const subject = subjectFromPayload(payload);
        if (typeof payload.exp !== 'number') throw new HttpError(403, 'Cloudflare Access token has no expiry');
        return { subject, diagnosticId: await diagnosticId(subject), expiresAt: payload.exp };
    } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof joseErrors.JOSEError) throw new HttpError(403, 'Cloudflare Access token is invalid');
        throw error;
    }
}

export async function requireAccess(request: Request, env: Env): Promise<AccessIdentity> {
    if (isTestBypassRequest(request, env)) {
        return { subject: 'test', diagnosticId: 'test', expiresAt: Number.MAX_SAFE_INTEGER };
    }
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) throw new HttpError(403, 'Cloudflare Access authentication is required');
    return verifyAccessJwt(token, { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
}
