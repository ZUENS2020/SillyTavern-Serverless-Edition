# Compatibility matrix

| Area | Status | Notes |
| --- | --- | --- |
| Upstream web UI and bundled extensions | Supported | Pages serves the original 1.18.0 UI and built-in manifests/assets. Browser-only built-ins remain self-contained; compute-backed built-ins use Worker/remote APIs. |
| Settings, themes, presets, quick replies, moving UI | Supported | Stored in D1. |
| Character cards | Supported | JSON, PNG card metadata, YAML and CharX import paths; cards/avatars in R2. |
| Character and group chats | Supported | Save, load, list, search, import, export, rename, delete, recent list. |
| Automatic chat revision backups | Supported | Last 25 revisions retained by D1 pointer to existing R2 objects. |
| Worlds and groups | Supported | Bundled defaults merge with D1 user data. |
| User media, files, avatars, backgrounds, sprites, assets | Supported | R2-backed, range-capable streaming reads. |
| Secrets UI | Supported | Multiple labeled keys, rotate/rename/delete; AES-256-GCM at rest with `SECRET_ENCRYPTION_KEY`; general exposure disabled. |
| Chat/text generation | Supported | OpenAI-compatible, Anthropic, Gemini, Azure OpenAI, Workers AI, text-generation-webui and Kobold-compatible routes. |
| Image captioning | Supported for remote providers | OpenAI-compatible, Anthropic, Google AI Studio, Mistral, xAI, Moonshot, NanoGPT, AIMLAPI, Pollinations, Chutes, ElectronHub and Workers AI routes are present where offered by the UI. |
| Image generation | Supported for remote API providers | Comfy RunPod, Together, Pollinations, Stability, Hugging Face, Chutes, ElectronHub, NanoGPT, BFL, FAL, xAI, AIMLAPI, Z.AI and Workers AI. Local inference is not offered. Jobs are polled by the browser; binary output streams to the browser and is written to R2 only after explicit save. |
| Remote TTS/transcription | Supported for implemented providers | Google AI Studio TTS, ElevenLabs, Pollinations and upstream-compatible remote speech routes. Provider capabilities still depend on the configured account/model. |
| Translation and web search | Supported for implemented remote providers | Arbitrary targets are restricted to public HTTPS. |
| Tokenization | Compatibility mode | Low-CPU approximate local counts; exact remote tokenizer routes where configured. Approximate decode is intentionally limited. |
| Vector Storage API | Supported through external providers | Qdrant Cloud Inference and Pinecone integrated-embedding indexes; no D1 vectors, local models, split embedding sources, or Worker-side vector math. |
| Local transformer caption/classify/TTS/STT | Unavailable | Caption, Expressions, Memory, and TTS use declared external APIs; compatibility endpoints return 422. |
| Google/OpenAI video, NovelAI ZIP image output, MiniMax/Volcengine audio assembly | Unavailable in free-CPU profile | These paths require signing, archive extraction, or large in-Worker binary/hex/NDJSON transforms; the route returns an explicit 422 instead of risking the free CPU limit. Z.AI video is supported through browser polling and the provider's result URL. |
| ComfyUI workflows | Supported | The two bundled workflows remain immutable Pages assets; custom JSON is stored in browser IndexedDB with import/export. No workflow is written to D1. Private/LAN endpoints and redirects are rejected. |
| Runtime third-party extension install/update/delete | Disabled | Pages assets are immutable. Browser-only built-ins stay bundled; future extensions must be reviewed API integrations declared by `/api/extensions/catalog` and deployed from source. |
| YouTube transcript extraction | Unavailable in free-CPU profile | Returns 501; use a remote extension/service. |
| Server plugins and desktop/Electron features | Not applicable | Workers cannot execute arbitrary Node plugins or desktop processes. |

“Supported” means the serverless route and storage semantics are implemented; external-provider behavior, model availability, quotas, and billing are controlled by that provider. The route audit compares all `/api/` literals used by the bundled UI with the runtime Worker registry and currently reports zero unmatched literals.
