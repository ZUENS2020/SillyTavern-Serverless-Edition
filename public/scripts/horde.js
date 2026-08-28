export const MIN_LENGTH = 16;

export let horde_settings = {
    models: [],
    auto_adjust_response_length: false,
    auto_adjust_context_length: false,
    trusted_workers_only: false,
};

export async function checkHordeStatus() {
    return false;
}

export async function getStatusHorde() {
    return false;
}

export async function adjustHordeGenerationParams(maxContextLength, maxLength) {
    return { maxContextLength, maxLength };
}

export async function generateHorde() {
    throw new Error('Kobold Horde was removed; use an AI Gateway capability.');
}

export async function getHordeModels() {
    return [];
}

export function loadHordeSettings() {
    horde_settings = { ...horde_settings, models: [] };
}

export function isHordeGenerationNotAllowed() {
    // Kobold Horde was removed in the serverless build. Keep this legacy
    // predicate permissive so callers can continue into the configured
    // AI Gateway capability instead of aborting every generation.
    return false;
}

export function initHorde() {}
