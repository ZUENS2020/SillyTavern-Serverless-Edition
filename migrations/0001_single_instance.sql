PRAGMA foreign_keys = ON;

CREATE TABLE settings (
    section TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    value_type TEXT NOT NULL DEFAULT 'json' CHECK (value_type IN ('json', 'text')),
    etag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (section, key)
) WITHOUT ROWID;

CREATE TABLE settings_snapshots (
    name TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    etag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE presets (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    value_json TEXT NOT NULL,
    etag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (kind, name)
) WITHOUT ROWID;

CREATE TABLE themes (
    name TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    etag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE world_books (
    id TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    etag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    avatar TEXT NOT NULL UNIQUE,
    card_json TEXT NOT NULL,
    etag TEXT NOT NULL,
    is_builtin_override INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin_override IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    etag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    character_avatar TEXT NOT NULL,
    position INTEGER NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    PRIMARY KEY (group_id, character_avatar)
) WITHOUT ROWID;

CREATE INDEX idx_group_members_position ON group_members(group_id, position);

CREATE TABLE objects (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    byte_length INTEGER NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
    etag TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (kind, name)
);

CREATE INDEX idx_objects_kind_updated ON objects(kind, updated_at DESC);

CREATE TABLE chat_index (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('character', 'group')),
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    current_r2_key TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    last_message TEXT NOT NULL DEFAULT '',
    message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    byte_length INTEGER NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
    tombstoned_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (scope, owner_id, name)
);

CREATE INDEX idx_chat_owner_updated ON chat_index(scope, owner_id, updated_at DESC);
CREATE INDEX idx_chat_tombstones ON chat_index(tombstoned_at) WHERE tombstoned_at IS NOT NULL;

CREATE TABLE chat_revisions (
    chat_id TEXT NOT NULL REFERENCES chat_index(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    r2_key TEXT NOT NULL UNIQUE,
    etag TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, revision)
) WITHOUT ROWID;

CREATE TABLE chat_search (
    chat_id TEXT PRIMARY KEY REFERENCES chat_index(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    search_text TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE snapshots (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    chat_id TEXT REFERENCES chat_index(id) ON DELETE CASCADE,
    chat_revision INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    UNIQUE (chat_id, chat_revision),
    FOREIGN KEY (chat_id, chat_revision) REFERENCES chat_revisions(chat_id, revision) ON DELETE CASCADE
);

CREATE INDEX idx_snapshots_kind_created ON snapshots(kind, created_at DESC);

CREATE TABLE content_catalog (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    builtin_path TEXT,
    object_id TEXT REFERENCES objects(id) ON DELETE SET NULL,
    content_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE ai_capability_profiles (
    capability TEXT PRIMARY KEY,
    model_id TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    declarations_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE embedding_schema (
    version INTEGER PRIMARY KEY,
    model_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    metric TEXT NOT NULL CHECK (metric IN ('cosine', 'euclidean', 'dot-product')),
    index_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_embedding_schema_active ON embedding_schema(active) WHERE active = 1;

CREATE TABLE vector_manifest (
    id TEXT PRIMARY KEY,
    hash INTEGER NOT NULL,
    collection_id TEXT NOT NULL,
    source TEXT NOT NULL,
    schema_version INTEGER NOT NULL REFERENCES embedding_schema(version),
    r2_source_key TEXT NOT NULL UNIQUE,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (collection_id, hash, schema_version)
);

CREATE INDEX idx_vector_collection ON vector_manifest(collection_id, id);
CREATE INDEX idx_vector_source ON vector_manifest(source, collection_id);

CREATE TABLE app_stats (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    etag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE cache_versions (
    namespace TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('data-maid', 'backup', 'vector-rebuild', 'embedding-migration', 'r2-gc')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancelled', 'failed', 'complete')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    params_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE INDEX idx_jobs_status_updated ON jobs(status, updated_at DESC);
CREATE UNIQUE INDEX idx_jobs_single_active ON jobs((1)) WHERE status IN ('queued', 'running');

CREATE TABLE tombstones (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_key TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    processed_at INTEGER
);

CREATE INDEX idx_tombstones_pending ON tombstones(created_at) WHERE processed_at IS NULL;

CREATE TABLE migration_records (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
) WITHOUT ROWID;

INSERT INTO embedding_schema(version, model_id, dimensions, metric, index_name, active, created_at)
VALUES (1, '@cf/baai/bge-m3', 1024, 'cosine', 'sillytavern-serverless-vector', 1, unixepoch() * 1000);
