/**
 * SillyTavern Serverless is a single-instance application. Cloudflare Access
 * protects the deployment, while Persona settings define the in-app identity.
 * No Access identity is converted into an application account.
 */
export const currentUser = null;
export const accountsEnabled = false;

/** Hide legacy account controls retained in older HTML templates. */
export async function setUserControls() {
    $('#logout_button, #admin_button, #account_button').remove();
}

/** Administrative account roles do not exist in a single-instance deployment. */
export function isAdmin() {
    return false;
}

/** Stable local namespace used only for browser preferences. */
export function getCurrentUserHandle() {
    return 'single-instance';
}
