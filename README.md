# SillyTavern Serverless Edition

An independent, single-Worker Cloudflare rewrite of the SillyTavern 1.18.0 UI and core service APIs.

This repository is not a GitHub fork. It is an unofficial modified version of [SillyTavern](https://github.com/SillyTavern/SillyTavern) and is not endorsed by its maintainers.

Production origin: <https://sillytavern.zuens2020.work>

## Architecture

- One Cloudflare Worker serves the browser UI through Workers Static Assets and handles all dynamic routes.
- Cloudflare Access protects the hostname with OTP and Google login. The Worker verifies the Access JWT again for every dynamic request.
- The application has no accounts, passwords, sessions, roles, CSRF compatibility endpoint, or `/api/users/*` API. Persona remains a normal setting and avatar resource.
- D1 is the source of truth for core metadata, settings, presets, cards, groups, worlds, immutable chat revision pointers, capability profiles, vector manifests, jobs, and migrations. It stores no credentials or embedding arrays.
- R2 stores immutable chat revisions, cards, avatars, worlds, backgrounds, sprites, saved gallery media, attachments, backup parts, and vector rebuild source chunks.
- KV is a disposable read cache. Every cached value can be regenerated from D1.
- Models run only through the `AI` binding with AI Gateway `sillytavern`. Provider credentials and Unified Billing remain in Cloudflare and are not readable by the Worker.
- Embedding is fixed to `@cf/baai/bge-m3`; vectors live in one 1024-dimensional cosine Vectorize index.
- Long backups, garbage collection, Data Maid work, and vector rebuilds run in a Cloudflare Workflow with bounded batches.
- Runtime git/zip extension installation and arbitrary endpoint proxies are permanently disabled. Bundled browser extensions, reviewed Gateway capability adapters, and deploy-time folders under `public/scripts/extensions/third-party` remain.

See [architecture](docs/SERVERLESS_ARCHITECTURE.md) and [compatibility](docs/COMPATIBILITY.md).

## Required Cloudflare resources

The deployment uses exactly one resource of each application type:

- Worker: `sillytavern-serverless`
- D1: `sillytavern-serverless-db`
- KV: one namespace bound as `CACHE`
- R2: `sillytavern-serverless-bucket`
- Vectorize: `sillytavern-serverless-vector`, 1024 dimensions, cosine
- AI Gateway: `sillytavern`
- Workflow: `sillytavern-serverless-maintenance`

Set the generated D1 and KV IDs and the Access Application AUD in `wrangler.jsonc`. Keep `workers_dev`, preview URLs, and `nodejs_compat` disabled.

No application secret is required. Any BYOK credentials belong to the AI Gateway or its Secrets Store scope, never D1, Worker variables, browser storage, or the repository.

## Build and deploy

Requires Node.js 22+ and a Cloudflare account authenticated with Wrangler.

```sh
npm ci --ignore-scripts
npm run lint
npm run check:worker
npm run test:worker
npm run check:worker-policy
npm run check:extension-policy
npm run check:browser-deps
npm run audit:routes
npm run build
npm run cf:dry-run
npx wrangler d1 migrations apply sillytavern-serverless-db --remote
npm run deploy
```

Configure Cloudflare Access for `sillytavern.zuens2020.work` before production traffic. The policy duration is 24 hours and allows only the two operator emails through the existing OTP and Google identity providers. Static assets are protected by the domain-level Access application; dynamic routes additionally validate `Cf-Access-Jwt-Assertion` inside the Worker.

The first launch uses an empty database and bootstraps bundled defaults. Legacy D1 and R2 business data is intentionally not imported.

## AI and vectors

Open **AI Gateway Capabilities** in the UI and enter a Gateway model ID for each feature you want to enable. Chat, text, caption, classification, image, TTS, STT, translation, reasoning, tools, structured output, and native model web search are independent profiles. Unconfigured capabilities return `CAPABILITY_NOT_CONFIGURED`.

The embedding profile is fixed and cannot be edited in the UI. Vector insertion is limited to four 8 KiB chunks and 32 KiB total text per call; `topK` is at most 20; multi-collection queries accept at most eight collections and use one Vectorize lookup.

AI Gateway prompt/response payload logging and response caching must remain disabled. Configure a spend limit before enabling paid models.

## Verification

`npm run test:worker` runs the Workers-runtime integration suite. It covers Access validation, request boundaries, D1/R2/KV behavior, immutable chat compare-and-swap, extension policy, AI Gateway routing, Vectorize recall and limits, and Workflow job control.

Production tests target the Access-protected custom domain and never accept Provider credentials:

```sh
SILLYTAVERN_ACCESS_COOKIE='CF_Authorization=…' npm run test:production
SILLYTAVERN_ACCESS_COOKIE='CF_Authorization=…' SILLYTAVERN_E2E_ONLY=system,core npm run test:production
```

The `ai` and `vectors` suites consume configured Cloudflare AI capacity. The test runner creates uniquely named data and performs best-effort cleanup.

## License and source

The combined work is licensed under GNU AGPL-3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The corresponding source for the network service is published at <https://github.com/ZUENS2020/SillyTavern-Serverless-Edition>.
