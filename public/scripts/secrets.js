/**
 * Compatibility surface for legacy UI modules. Application-level secrets do
 * not exist in the single-Worker edition; provider credentials are owned by
 * Cloudflare AI Gateway / Secrets Store and cannot be read by the browser.
 */
export const SECRET_KEYS = Object.freeze({});
export const secret_state = Object.freeze({});

export function resolveSecretKey() {
    return null;
}

export function getSecretLabelById() {
    return 'Managed by Cloudflare AI Gateway';
}

export function updateSecretDisplay() {
    $('#viewSecrets').remove();
}

export async function canViewSecrets() {
    return false;
}

function unavailable() {
    throw new Error('Application secret storage is disabled; configure credentials in Cloudflare AI Gateway');
}

export async function writeSecret() {
    unavailable();
}

export async function deleteSecret() {
    unavailable();
}

export async function readSecretState() {
    return secret_state;
}

export async function findSecret() {
    return null;
}

export async function rotateSecret() {
    unavailable();
}

export async function renameSecret() {
    unavailable();
}

export async function checkOpenRouterAuth() {
    return false;
}

export async function initSecrets() {
    updateSecretDisplay();
}
