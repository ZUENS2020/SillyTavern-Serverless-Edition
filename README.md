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
- D1 stores settings, presets, metadata, secrets, chat indexes, and lightweight retrieval indexes.
- R2 stores chats, automatic chat revisions, character cards, avatars, backgrounds, sprites, assets, and user files.
- Expensive local ML, media transcoding, and Git operations are excluded from request paths to remain compatible with the Workers Free CPU budget.

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

Wrangler provisions the D1 database and R2 bucket declared by the Worker configuration. Apply migrations before first production use if Wrangler does not prompt for them:

```sh
npx wrangler d1 migrations apply DB --remote --config cloudflare/worker/wrangler.jsonc
```

Add model-provider keys through the SillyTavern UI after deployment. Do not put keys in Pages variables, committed files, or client-side JavaScript.

## Development and verification

```sh
npm run build:pages
npm run cf:dry-run
npm run test:worker
npm run test:production
```

The local integration suite runs inside Cloudflare's Workers runtime and exercises D1, R2, route dispatch, chat revisions, settings and snapshots, secrets, media streaming, ComfyUI workflow persistence, lightweight retrieval, and private-network proxy rejection. The production suite defaults to the live Pages deployment, creates uniquely named temporary data, tests the public provider paths and any active OpenRouter key, then removes and audits every temporary object. It never prints secret values.

Set `SILLYTAVERN_E2E_URL` to test another deployment, or select comma-separated suites with `SILLYTAVERN_E2E_ONLY`. OpenRouter image generation is opt-in because it may incur provider charges:

```sh
SILLYTAVERN_E2E_ONLY=openrouter OPENROUTER_E2E_IMAGE=1 npm run test:production
```

`npm run audit:routes` checks every `/api/` literal referenced by the bundled UI against the actual runtime route registry.

## License and source

This modified program is licensed under GNU AGPL-3.0, the same license as the upstream work. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The corresponding source for the deployed service is published at <https://github.com/ZUENS2020/SillyTavern-Serverless-Edition>.

Upstream resources: [project](https://github.com/SillyTavern/SillyTavern), [documentation](https://docs.sillytavern.app/), [Discord](https://discord.gg/sillytavern), and [Reddit](https://reddit.com/r/SillyTavernAI).
