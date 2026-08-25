PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_state (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    value_type TEXT NOT NULL DEFAULT 'json',
    etag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_app_state_namespace_updated
ON app_state(namespace, updated_at DESC);

CREATE TABLE IF NOT EXISTS objects (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    byte_length INTEGER NOT NULL DEFAULT 0,
    etag TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (kind, name)
);

CREATE INDEX IF NOT EXISTS idx_objects_kind_updated
ON objects(kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('character', 'group')),
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    metadata TEXT NOT NULL DEFAULT '{}',
    last_message TEXT NOT NULL DEFAULT '',
    search_text TEXT NOT NULL DEFAULT '',
    message_count INTEGER NOT NULL DEFAULT 0,
    byte_length INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (scope, owner_id, name)
);

CREATE INDEX IF NOT EXISTS idx_chats_owner_updated
ON chats(scope, owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS secrets (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    byte_length INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_kind_created
ON snapshots(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS vectors (
    collection_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, source, source_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_vectors_collection_updated
ON vectors(collection_id, updated_at DESC);
