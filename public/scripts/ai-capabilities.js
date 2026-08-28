const CAPABILITY_LABELS = {
    chat: 'Chat',
    text: 'Text',
    embedding: 'Embedding / Vectorize',
    'web-search': 'Native web search',
    caption: 'Image captioning',
    classification: 'Expression classification',
    image: 'Image generation',
    tts: 'Text to speech',
    stt: 'Speech to text',
    translation: 'Translation',
    reasoning: 'Reasoning',
    tools: 'Tool calling',
    'structured-output': 'Structured output',
};

function requestHeaders() {
    return { 'content-type': 'application/json' };
}

async function api(path, init = {}) {
    const response = await fetch(path, { cache: 'no-store', ...init });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = data?.error?.message || data?.error || `Request failed (${response.status})`;
        throw new Error(message);
    }
    return data;
}

function row(profile) {
    const container = document.createElement('div');
    container.className = 'flex-container flexFlowColumn capability-profile';

    const label = document.createElement('label');
    label.className = 'flex-container alignitemscenter';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = profile.enabled;
    enabled.disabled = Boolean(profile.fixed);
    label.append(enabled, document.createTextNode(CAPABILITY_LABELS[profile.capability] ?? profile.capability));

    const model = document.createElement('input');
    model.className = 'text_pole wide100p';
    model.placeholder = 'AI Gateway model ID';
    model.value = profile.modelId;
    model.disabled = Boolean(profile.fixed);
    model.autocomplete = 'off';
    model.spellcheck = false;

    const actions = document.createElement('div');
    actions.className = 'flex-container';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'menu_button menu_button_icon';
    save.textContent = profile.fixed ? 'Managed by Vectorize schema' : 'Save';
    save.disabled = Boolean(profile.fixed);
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'menu_button menu_button_icon';
    test.textContent = 'Test';
    test.disabled = !profile.enabled && profile.fixed;
    const status = document.createElement('small');
    status.className = 'flex1';
    actions.append(save, test, status);

    const saveProfile = async () => {
        status.textContent = 'Saving…';
        await api(`/api/ai/capabilities/${encodeURIComponent(profile.capability)}`, {
            method: 'PUT',
            headers: requestHeaders(),
            body: JSON.stringify({ modelId: model.value.trim(), enabled: enabled.checked, declarations: {} }),
        });
        status.textContent = 'Saved';
    };
    save.addEventListener('click', async () => {
        try {
            await saveProfile();
        } catch (error) {
            status.textContent = error.message;
        }
    });

    test.addEventListener('click', async () => {
        status.textContent = 'Testing…';
        try {
            if (!profile.fixed) await saveProfile();
            await api('/api/ai/test', {
                method: 'POST',
                headers: requestHeaders(),
                body: JSON.stringify({ capability: profile.capability }),
            });
            status.textContent = 'Available';
        } catch (error) {
            status.textContent = error.message;
        }
    });

    container.append(label, model, actions);
    return container;
}

export async function initAiCapabilities() {
    const panel = document.getElementById('rm_api_block');
    if (!panel) return;
    panel.replaceChildren();

    const title = document.createElement('h3');
    title.className = 'margin0';
    title.textContent = 'AI Gateway Capabilities';
    const explanation = document.createElement('p');
    explanation.className = 'notes';
    explanation.textContent = 'Enter AI Gateway model IDs only. Provider credentials remain in Cloudflare AI Gateway and are never exposed to this Worker.';
    const profiles = document.createElement('div');
    profiles.className = 'flex-container flexFlowColumn';
    panel.append(title, explanation, profiles);

    try {
        const data = await api('/api/ai/capabilities');
        for (const profile of data.profiles) profiles.append(row(profile));
        document.getElementById('API-status-top')?.classList.replace('fa-plug-circle-exclamation', 'fa-cloud');
    } catch (error) {
        profiles.textContent = `Unable to load capability profiles: ${error.message}`;
    }
}
