# Serverless architecture

## Request path

Static requests are answered directly by Pages. `_routes.json` sends only API, callbacks, and dynamic user-file namespaces to the Pages Function. That Function calls the API Worker through a service binding, avoiding a public HTTP hop. If the Worker returns 404 for a bundled character, avatar, background, asset, or extension file, Pages serves the immutable bundled copy.

The Pages build adds the source commit to local JavaScript, module-import, stylesheet, and extension-template URLs. This keeps browser caching efficient while preventing a deployment from combining new HTML with stale extension code.

## Persistence map

| Data | Primary store | Index/metadata |
| --- | --- | --- |
| Settings, presets, themes, worlds, groups | D1 `app_state` | D1 |
| Provider secrets | D1 `secrets` | AES-256-GCM envelopes; master key is Worker Secret `SECRET_ENCRYPTION_KEY` |
| Chats | R2 revision object | D1 `chats` |
| Automatic chat backups | Existing R2 revision object | D1 `snapshots` |
| Cards, avatars, backgrounds, sprites, assets, uploads | R2 object | D1 `objects` |
| User-saved generated media | R2 core gallery/attachment object | D1 `objects`; never staged before the user saves |
| Embeddings and vectors | Qdrant Cloud or Pinecone | Provider-side inference, storage, filtering, and search |
| Custom ComfyUI workflows | Browser IndexedDB | JSON import/export; bundled defaults remain Pages assets |

Chat writes are copy-on-revision: a new object is written once, D1 atomically points at it, and the previous object becomes a bounded backup. R2 reads and remote model/media responses are streamed. Provider media is decoded only in the browser and uploaded as multipart binary after the user saves it. The Worker does not buffer or stage generated media.

## Free-tier resource controls

- JSON and upload sizes are bounded by Worker variables.
- Bulk object uploads are capped at 40 to stay below the per-request subrequest ceiling.
- List and search queries have hard limits and use D1 indexes.
- Vector requests contain at most 8 records, 64 KiB total, 16 KiB per text, 8 collections, and `topK <= 20`; the Worker never computes embeddings or parses vector arrays.
- Token counts are deliberately approximate unless a remote tokenizer is configured.
- Local transformer inference, image manipulation, archive-wide Git installs, media transcoding, and long CPU loops are not run inside the Worker.
- Long-running media jobs use browser submit/poll/result requests. Each Worker invocation performs a bounded provider operation; it never sleeps in a polling loop.
- Pinecone multi-collection search runs at most four outbound requests concurrently and accepts at most eight collections. Qdrant uses its batch query API.
- Provider JSON is size-bounded; binary media is returned as a stream. Redirects from user-configured endpoints are rejected.
- Observability sampling is low to reduce log volume.

## Extension policy

The browser-only built-ins (`assets`, `attachments`, `connection-manager`, `gallery`, `quick-reply`, `regex`, and `token-counter`) stay bundled and do not need an extra API. Caption, Expressions, Memory, Image Generation, Translate, TTS, and Vectors are `external-api` integrations. The Worker is limited to credential injection, validation, bounded response mapping, and streaming proxy behavior.

Runtime Git installation, extension update/switch/delete operations, local inference, browser-hosted model inference, and local extension service discovery are disabled. `/api/extensions/catalog` publishes separate `bundled` and `externalApi` groups. New integrations require a reviewed manifest and provider adapter in source; there is no arbitrary URL proxy.

Cloudflare publishes the current quotas in the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/) documentation.

## Security boundary

There is deliberately no SillyTavern login or session layer. Provider responses are stripped of cookies, configured remote endpoints must be public HTTPS targets, redirects are rejected, common private/local addresses are blocked, filenames are sanitized, and stored secrets are never returned by general secret APIs. D1 encryption protects copied rows, not use of keys through the public application. Operators remain responsible for restricting access to the deployed hostname if the service must be private.
