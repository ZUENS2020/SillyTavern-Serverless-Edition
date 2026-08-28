# Single-Worker architecture

## Request path

`sillytavern.zuens2020.work` is covered by Cloudflare Access. After Access allows the request, one Worker validates the request boundary and Access JWT. API and dynamic content paths enter the native router; ordinary GET and HEAD misses fall through to the `ASSETS` binding.

Writes require the exact production Origin and Host. Cross-site Fetch Metadata is rejected. API responses never use wildcard CORS. Logs contain only bounded operational metadata and never JWTs, email addresses, cookies, prompts, chat text, or credentials.

## Storage boundaries

| Binding | Purpose | Explicitly excluded |
| --- | --- | --- |
| D1 `DB` | Core metadata, current pointers, settings, worlds, cards, groups, capability profiles, vector manifests, jobs | Users, sessions, roles, credentials, embeddings |
| R2 `BUCKET` | Immutable chat bodies, user-saved media, attachments, rebuild sources, backup parts | Unsaved generated media, Provider responses |
| KV `CACHE` | Disposable read-through cache | Authoritative business state |
| Vectorize `VECTOR_INDEX` | Embeddings and similarity search | Source text authority |
| AI `AI` | Model execution through Gateway `sillytavern` | Direct Provider HTTP |
| Workflow `MAINTENANCE` | Bounded backup, rebuild, Data Maid, GC | Long polling inside a request |

Chats use immutable R2 keys. D1 compare-and-swap advances an integer revision; a stale revision returns 409 and its newly written R2 object is compensating-deleted. Snapshots point to existing revisions.

R2 uses the prefixes `avatars/`, `characters/`, `chats/`, `worlds/`, `backgrounds/`, `sprites/`, `gallery/`, `assets/`, `files/`, `data-bank/`, `backups/`, `thumbnails/`, and `vector-source/`. Bundled defaults stay in Static Assets until a user modification creates an R2 override.

## AI capabilities

The browser sends capability-neutral payloads to `/api/ai/run/:capability`. D1 profiles contain only the capability, enabled state, declarations, and AI Gateway model ID. The Worker strips connection fields, validates size and ranges, and calls:

```ts
env.AI.run(modelId, payload, {
  gateway: { id: 'sillytavern', collectLog: false, skipCache: true },
  returnRawResponse: true,
  signal: request.signal,
})
```

Responses stream directly to the browser and cancellation propagates through the request signal. Provider URLs, API keys, fallback chains, reverse proxies, local models, browser ML runtimes, and arbitrary URL fetching are absent.

## Vector lifecycle

The active schema is `@cf/baai/bge-m3`, 1024 dimensions, cosine. IDs are SHA-256 of `collection_id + NUL + hash`. D1 stores the ID, source, collection, schema, hash, and R2 source key. R2 stores the exact already-chunked source text so a Workflow can rebuild without re-running browser parsing.

Insert calls contain at most four chunks, each at most 8 KiB and at most 32 KiB in total. Query `topK` is capped at 20. Multi-collection recall uses one embedding and a single Vectorize `$in` metadata filter for at most eight collections.

Schema migration binds a temporary destination index only for the migration deployment, replays R2 sources in four-item steps, validates the manifest count, switches the production binding in a separate deployment, and then removes the old index. Normal production exposes one Vectorize binding.

## Long work and CPU budget

The request path performs validation, indexed storage operations, and at most one AI call. Binary responses are streamed and generated media is saved only after explicit browser upload.

Maintenance jobs use `/api/jobs`, allow one active large job, support cancellation, and process at most 100 storage records or four embeddings per Workflow step. Each instance reserves bookkeeping steps and runs at most 1,018 batch steps under the Workers Free 1,024-step ceiling and 3,000-step daily allowance. Backup parts contain R2 object manifests and D1 row chunks; ZIP assembly remains in the browser. Workers Free rejects configurable CPU limits, so the 10 ms CPU design budget is enforced through route and Workflow batch limits and verified from production telemetry instead of a paid-plan-only `cpu_ms` setting.
