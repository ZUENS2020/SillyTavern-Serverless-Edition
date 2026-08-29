import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

const [
    index,
    extensionManager,
    extensionWorker,
    vectorUi,
    vectorSettings,
    vectorWorker,
    aiWorker,
    caption,
    expressions,
    memory,
    image,
    translate,
    tts,
] = await Promise.all([
    read('public/index.html'),
    read('public/scripts/extensions.js'),
    read('src/worker/routes/extensions.ts'),
    read('public/scripts/extensions/vectors/index.js'),
    read('public/scripts/extensions/vectors/settings.html'),
    read('src/worker/routes/vectors.ts'),
    read('src/worker/routes/ai.ts'),
    read('public/scripts/extensions/caption/index.js'),
    read('public/scripts/extensions/expressions/index.js'),
    read('public/scripts/extensions/memory/index.js'),
    read('public/scripts/extensions/stable-diffusion/index.js'),
    read('public/scripts/extensions/translate/index.js'),
    read('public/scripts/extensions/tts/index.js'),
]);

assert.match(index, /id="third_party_extension_button"[^>]*disabled/u);
assert.doesNotMatch(index, /id="main_api"|api_key_|extensions_api_(?:url|key)|horde_api_key/u);
assert.match(index, /Cloudflare AI Gateway/u);
assert.match(index, /scripts\/extensions\/third-party/u);

assert.match(extensionWorker, /runtimeInstallation:\s*false/u);
assert.match(extensionWorker, /deployTimeThirdParty:\s*true/u);
assert.match(extensionWorker, /type:\s*'local'/u);
assert.match(extensionWorker, /third-party\/\$\{/u);
assert.match(extensionWorker, /gatewayCapabilities/u);
assert.match(extensionWorker, /HttpError\(\s*410/u);
assert.match(extensionWorker, /\/scripts\/extensions\/third-party\/\*/u);
assert.doesNotMatch(extensionWorker, /worker-api|externalApi/u);

assert.match(extensionManager, /Runtime git\/zip installation is disabled/u);
assert.match(extensionManager, /scripts\/extensions\/third-party/u);
assert.match(extensionManager, /catalog\.gatewayCapabilities/u);
assert.match(extensionManager, /item\.type === 'local'/u);
assert.doesNotMatch(extensionManager, /extension_settings\.(?:apiUrl|apiKey)|\/api\/extensions\/(?:install|update|delete|switch|branches|move)/u);
assert.doesNotMatch(extensionManager, /Authorization.*Bearer/u);

for (const [name, source, capability] of [
    ['caption', caption, 'caption'],
    ['expressions', expressions, 'classification'],
    ['memory', memory, 'text'],
    ['image', image, 'image'],
    ['translate', translate, 'translation'],
    ['tts', tts, 'tts'],
]) {
    assert.match(source, new RegExp(`runAiCapability\\(['"]${capability}['"]`, 'u'), `${name} must use its Gateway capability`);
    assert.doesNotMatch(source, /fetch\([^)]*https?:\/\//u, `${name} must not contact a Provider directly`);
}
assert.match(tts, /runAiCapability\(['"]stt['"]/u);

assert.match(vectorSettings, /@cf\/baai\/bge-m3/u);
assert.match(vectorSettings, /Cloudflare Vectorize/u);
assert.doesNotMatch(`${vectorUi}\n${vectorSettings}`, /qdrant|pinecone|openrouter|ollama|webllm|cohere|vllm|togetherai|alt_endpoint/iu);
assert.match(vectorUi, /crypto\.subtle\.digest\(['"]SHA-256/u);
assert.match(vectorUi, /const getBatchSize = \(\) => 4/u);
assert.doesNotMatch(vectorUi, /\/api\/vector\/(?:providers|test|initialize|purge-all)/u);
assert.match(vectorWorker, /env\.VECTOR_INDEX/u);
assert.match(vectorWorker, /env\.AI\.run\('@cf\/baai\/bge-m3'/u);
assert.match(vectorWorker, /gateway:\s*\{/u);
assert.doesNotMatch(vectorWorker, /FROM\s+vectors|INTO\s+vectors|embedding\s+(?:BLOB|TEXT)/iu);
assert.match(aiWorker, /collectLog:\s*false/u);
assert.match(aiWorker, /skipCache:\s*true/u);

const ttsFiles = (await readdir(new URL('public/scripts/extensions/tts/', root))).sort();
assert.deepEqual(ttsFiles, ['index.js', 'manifest.json', 'settings.html', 'style.css']);
await assert.rejects(access(new URL('public/scripts/extensions/vectors/webllm.js', root)));

const probeManifest = await read('public/scripts/extensions/third-party/st-serverless-probe/manifest.json');
assert.match(probeManifest, /"generate_interceptor":\s*"interceptGeneration"/u);
assert.match(probeManifest, /"activate":\s*"activate"/u);
const probeSource = await read('public/scripts/extensions/third-party/st-serverless-probe/index.js');
assert.doesNotMatch(probeSource, /fetch\([^)]*https?:\/\//u);

console.log('Extension and AI Gateway policy checks passed');
