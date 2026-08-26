-- Extension-owned state is external from this release onward.
-- Run cloudflare/scripts/cleanup-extension-storage.mjs before applying this
-- migration so the indexed generated-media R2 objects are deleted first.

DROP INDEX IF EXISTS idx_vectors_collection_updated;
DROP TABLE IF EXISTS vectors;

DELETE FROM app_state WHERE namespace = 'comfy-workflow';
DELETE FROM objects WHERE kind = 'generated-media';
