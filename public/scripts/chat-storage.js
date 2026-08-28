const revisions = new Map();

function key(scope, owner, name) {
    return `${scope}\0${owner}\0${name}`;
}

function base64Json(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function normalizedOwner(scope, owner) {
    if (scope === 'group') return 'group';
    return String(owner).replace(/\.png$/iu, '');
}

export function rememberChatRevision(scope, owner, name, response) {
    const revision = Number(response.headers.get('x-chat-revision') ?? 0);
    if (Number.isInteger(revision) && revision >= 0) {
        revisions.set(key(scope, normalizedOwner(scope, owner), name), revision);
    }
}

export async function saveChatContent({ scope, owner, name, chat }) {
    const normalized = normalizedOwner(scope, owner);
    const revisionKey = key(scope, normalized, name);
    const revision = revisions.get(revisionKey) ?? 0;
    const metadata = chat[0]?.chat_metadata ?? {};
    const messages = chat.slice(1);
    const lastMessage = [...messages].reverse().find(message => typeof message?.mes === 'string')?.mes ?? '';
    const headers = new Headers({
        'content-type': 'application/json',
        'if-match': String(revision),
        'x-st-chat-metadata': base64Json(metadata),
        'x-st-message-count': String(messages.length),
        'x-st-last-message': base64Json(String(lastMessage).slice(-400)),
    });
    const path = `/api/chats/content/${encodeURIComponent(scope)}/${encodeURIComponent(normalized)}/${encodeURIComponent(name)}`;
    const response = await fetch(path, {
        method: 'PUT',
        headers,
        cache: 'no-store',
        body: JSON.stringify(chat),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(detail?.error || `Chat save failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    const saved = await response.json();
    revisions.set(revisionKey, saved.revision);

    const searchText = messages
        .filter(message => typeof message?.mes === 'string')
        .map(message => message.mes.toLowerCase().slice(0, 16_384))
        .join('\n')
        .slice(0, 65_536);
    void fetch('/api/chats/search-project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, ownerId: normalized, name, revision: saved.revision, searchText }),
    }).catch(() => undefined);
    return saved;
}
