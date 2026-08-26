# Serverless architecture

## Request path

Static requests are answered directly by Pages. `_routes.json` sends only API, callbacks, and dynamic user-file namespaces to the Pages Function. That Function calls the API Worker through a service binding, avoiding a public HTTP hop. If the Worker returns 404 for a bundled character, avatar, background, asset, or extension file, Pages serves the immutable bundled copy.

## Persistence map

| Data | Primary store | Index/metadata |
| --- | --- | --- |
| Settings, presets, themes, worlds, groups | D1 `app_state` | D1 |
| Provider secrets | D1 `secrets` | Values are masked by public read APIs |
| Chats | R2 revision object | D1 `chats` |
| Automatic chat backups | Existing R2 revision object | D1 `snapshots` |
| Cards, avatars, backgrounds, sprites, assets, uploads | R2 object | D1 `objects` |
| Generated image/video hand-off | R2 `generated-media` object | D1 `objects`, bounded to 50 entries |
| Vector Storage API entries | D1 `vectors` | Bounded D1 keyword scoring |

Chat writes are copy-on-revision: a new object is written once, D1 atomically points at it, and the previous object becomes a bounded backup. R2 reads and remote model responses are streamed. Binary image-provider responses go directly from the provider stream into R2; final saves promote that object with an R2-to-R2 stream. Other browser-generated images are decoded in the browser and uploaded as multipart binary. This keeps large base64 transforms out of Worker CPU time.

## Free-tier resource controls

- JSON and upload sizes are bounded by Worker variables.
- Bulk object uploads are capped at 40 to stay below the per-request subrequest ceiling.
- List and search queries have hard limits and use D1 indexes.
- Retrieval uses bounded SQL keyword scoring instead of CPU-heavy in-Worker embeddings.
- Token counts are deliberately approximate unless a remote tokenizer is configured.
- Local transformer inference, image manipulation, archive-wide Git installs, media transcoding, and long CPU loops are not run inside the Worker.
- Provider polling uses network wait time and fixed attempt limits; streaming paths do not call `arrayBuffer()` or `text()` for binary output.
- Generated provider media is capped by `MAX_UPLOAD_BYTES`, retained as at most 50 hand-off objects, and cleaned in batches of no more than five.
- Model/job enumerations and polling loops have hard page/attempt limits so one request cannot consume unbounded subrequests.
- Observability sampling is low to reduce log volume.

## Extension policy

The browser-only built-ins (`assets`, `attachments`, `connection-manager`, `gallery`, `quick-reply`, `regex`, and `token-counter`) stay bundled and do not need an extra API. Compute-backed built-ins use same-origin Worker or declared remote-provider APIs. Vector Storage uses `/api/vector/*` backed by bounded D1 I/O; it never downloads an embedding model or connects to a local vector process.

Runtime Git installation, extension update/switch/delete operations, Extras servers, browser-hosted inference models, and local extension service discovery are disabled. `/api/extensions/catalog` publishes the active policy. The `externalApi` catalog is intentionally empty until extensions are added as reviewed API integrations in source and redeployed.

Cloudflare publishes the current quotas in the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/) documentation.

## Security boundary

There is deliberately no SillyTavern login or session layer. This is not the same as having no security boundary: provider responses are stripped of cookies, arbitrary proxy URLs must be public HTTPS targets, common private/local network addresses are rejected, filenames are sanitized, and stored secrets are never returned by general secret APIs. Operators remain responsible for restricting access to the deployed hostname if the service must be private.
