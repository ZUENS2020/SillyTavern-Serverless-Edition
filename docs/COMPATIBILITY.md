# Compatibility matrix

| Area | Status | Serverless behavior |
| --- | --- | --- |
| Chat and streaming | Supported | AI Gateway response streams to the browser; abort propagates |
| Chat history | Supported | Immutable R2 revisions with D1 compare-and-swap |
| Characters, groups, Persona | Supported | D1 metadata plus R2/Static Assets media |
| World books | Supported | Keyword activation stays in-browser; semantic recall uses Vectorize |
| Data Bank and attachments | Supported | Core R2 storage plus Vectorize manifests |
| Settings, presets, themes, Quick Reply | Supported | D1 source of truth with KV cache |
| Gallery and saved generated media | Supported | R2 only after an explicit save |
| Caption, Expressions, Memory, image, translation, TTS/STT | Supported when configured | Reviewed AI Gateway capability profiles |
| Vector storage | Supported | AI Gateway embedding plus Cloudflare Vectorize |
| Backups and Data Maid | Supported | Maintenance Workflow with browser-side ZIP assembly |
| Application accounts and passwords | Removed | Cloudflare Access is the only authentication boundary |
| Provider secrets UI | Removed | Credentials stay in AI Gateway/Secrets Store |
| Direct Provider endpoints and reverse proxies | Removed | Worker uses only Cloudflare bindings |
| Runtime extension installation/update/delete | Removed | No git clone, zip upload, or install API |
| Deploy-time third-party UI extensions | Supported | Folders in `public/scripts/extensions/third-party` are scanned at build and loaded as `third-party/<id>`; JavaScript must pass the Worker policy scan |
| Node server, Electron, Docker, Colab, Replit | Removed | Not part of the Worker deployment |
| Local/browser model runtimes | Removed | No Transformers, Stable Diffusion runtime, local TTS, WebLLM, Ollama, or ComfyUI |
| URL scraping/search adapters | Removed | Web search is a native capability of a configured model only |

Legacy provider names may still be recognized while importing old cards or prompt-format presets, but they cannot select a connection, store a key, or create a Provider request.
