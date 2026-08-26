# SillyTavern Serverless Edition

An independent Cloudflare serverless rewrite of the SillyTavern 1.18.0 user interface and core service APIs. The browser UI is served by Cloudflare Pages, API requests run on Workers, structured state and indexes live in D1, and chats/media/files live in R2.

This is a new repository, not a GitHub fork. It is an unofficial modified version of [SillyTavern](https://github.com/SillyTavern/SillyTavern) and is not endorsed by its maintainers.

Live deployment: <https://sillytavern-serverless.pages.dev>

## Important security note

Application authentication is intentionally disabled for this edition. Anyone who can reach a deployment can use its UI, change its data, and invoke configured provider keys. Deploy it only behind a private hostname or a Cloudflare security policy you control. No provider key is bundled in the source or Pages assets.

## Architecture

- Pages serves the upstream UI and bundled default content as immutable static assets.
- A catch-all Pages Function forwards same-origin API and dynamic-file requests through a Worker service binding.
- The Worker uses a small native router and streams provider/R2 responses without buffering them.
- D1 stores core settings, presets, metadata, encrypted provider secrets, and chat/object indexes. It does not store vectors or extension-owned model state.
- R2 stores chats, automatic chat revisions, character cards, avatars, backgrounds, sprites, assets, and user files.
- Qdrant Cloud or Pinecone owns embedding, vector persistence, filtering, and similarity search. The Worker only validates requests, injects credentials, and proxies bounded calls.
- Expensive local ML, media transcoding, and Git operations are excluded from request paths to remain compatible with the Workers Free CPU budget.
- Browser-only built-in extensions remain bundled. Runtime extension installation is disabled; compute-backed and future extensions connect through reviewed provider adapters. Generated media streams to the browser and reaches R2 only after an explicit save.

See [serverless architecture](docs/SERVERLESS_ARCHITECTURE.md) and the [compatibility matrix](docs/COMPATIBILITY.md).

## Deploy

Prerequisites: Node.js 20+ and a Cloudflare account authenticated in Wrangler.

```sh
npm install --ignore-scripts
npm run cf:types
npm run check:worker
npm run check:pages
npm run test:worker
npm run deploy:worker
npm run deploy:pages
```

Create the 32-byte master key as a Worker Secret before the first deployment. Never put it in Wrangler variables, Pages variables, or the repository:

```sh
openssl rand 32 | openssl base64 | npx wrangler secret put SECRET_ENCRYPTION_KEY --config cloudflare/worker/wrangler.jsonc
```

Wrangler provisions the D1 database and R2 bucket declared by the Worker configuration. Apply migrations before first production use if Wrangler does not prompt for them:

```sh
npx wrangler d1 migrations apply DB --remote --config cloudflare/worker/wrangler.jsonc
```

Add model-provider keys through the SillyTavern UI after deployment. D1 stores AES-256-GCM envelopes; legacy plaintext rows are encrypted on first read. Encryption protects a copied database, but does not create user isolation: authentication is disabled and every visitor can invoke or replace configured keys.

For Vector Storage, choose either Qdrant Cloud or Pinecone in the extension panel. Qdrant uses Cloud Inference with the configured model. Pinecone requires a pre-created integrated-embedding index whose text field is mapped to `chunk_text`.

When upgrading an existing deployment, export custom ComfyUI workflows first, then delete legacy extension media before applying migration `0003_external_extensions.sql`:

```sh
D1_DATABASE_NAME=your-d1-name npm run cf:export-comfy-workflows
D1_DATABASE_NAME=your-d1-name R2_BUCKET_NAME=your-r2-bucket npm run cf:cleanup-extension-storage
npx wrangler d1 migrations apply DB --remote --config cloudflare/worker/wrangler.jsonc
```

The export command writes each legacy D1 workflow as an importable JSON file plus a manifest in a new, owner-only directory. The cleanup command resolves exact `generated-media` keys from D1, deletes those R2 objects individually, and only then removes their D1 indexes. Custom ComfyUI workflows now live in browser IndexedDB and support JSON import/export; import the exported files in the extension panel after deployment.

## Development and verification

```sh
npm run build:pages
npm run cf:dry-run
npm run check:browser-deps
npm run test:worker
npm run test:production
npm run audit:security
```

The local integration suite runs inside Cloudflare's Workers runtime and exercises D1/R2 core storage, encrypted-secret migration, streamed media, Qdrant/Pinecone contracts, extension storage boundaries, and private-network proxy rejection. The production suite defaults to the live Pages deployment, creates uniquely named temporary core data, tests configured external providers, then removes and audits every temporary object. It never prints secret values.

Set `SILLYTAVERN_E2E_URL` to test another deployment, or select comma-separated suites with `SILLYTAVERN_E2E_ONLY`. OpenRouter image generation is opt-in because it may incur provider charges:

```sh
SILLYTAVERN_E2E_ONLY=openrouter OPENROUTER_E2E_IMAGE=1 npm run test:production
```

External vector E2E is opt-in. The provider key must already be saved in the deployed UI:

```sh
VECTOR_E2E_PROVIDER=qdrant QDRANT_E2E_ENDPOINT=https://YOUR-CLUSTER.qdrant.io npm run test:production
VECTOR_E2E_PROVIDER=pinecone PINECONE_E2E_HOST=https://YOUR-INDEX.svc.REGION.pinecone.io npm run test:production
```

`npm run audit:routes` checks every `/api/` literal referenced by the bundled UI against the actual runtime route registry.
`npm run audit:security` checks production dependencies against the official npm advisory service. The browser bundle pins Showdown's security-hardened 3.0 release-candidate source to an exact upstream commit until that release is published to npm.

## License and source

This modified program is licensed under GNU AGPL-3.0, the same license as the upstream work. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The corresponding source for the deployed service is published at <https://github.com/ZUENS2020/SillyTavern-Serverless-Edition>.

Upstream resources: [project](https://github.com/SillyTavern/SillyTavern), [documentation](https://docs.sillytavern.app/), [Discord](https://discord.gg/sillytavern), and [Reddit](https://reddit.com/r/SillyTavernAI).
