import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

import showdown from 'showdown';

const root = new URL('../../', import.meta.url);
const packageData = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const dependencies = new Set(Object.keys(packageData.dependencies ?? {}));
for (const forbidden of [
    '@xenova/transformers', '@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web',
    'sharp', 'jimp', 'express', 'multer', 'playwright', 'puppeteer', 'simple-git',
]) {
    assert(!dependencies.has(forbidden), `Forbidden server/local-model dependency: ${forbidden}`);
}

for (const removed of [
    'public/scripts/extensions/vectors/webllm.js',
    'public/scripts/extensions/tts/kokoro-worker.js',
    'src/transformers.js',
    'src/tokenizers',
]) {
    await assert.rejects(access(new URL(removed, root)), `${removed} must stay removed`);
}

const converter = new showdown.Converter({ metadata: true, completeHTMLDocument: true });
const metadataPayload = '---\ntitle: </title><script>alert(1)</script>\n---\n\n# safe\n';
const metadataHtml = converter.makeHtml(metadataPayload);
assert(!metadataHtml.includes('</title><script>'), 'Showdown metadata title escaping regressed');
assert(metadataHtml.includes('&lt;/title&gt;&lt;script&gt;'), 'Showdown metadata payload was not escaped');

const redosInput = `www.example.com/a${')'.repeat(80_000)}`;
const started = performance.now();
new showdown.Converter({ simplifiedAutoLink: true }).makeHtml(redosInput);
const redosMs = Math.round(performance.now() - started);
assert(redosMs < 5_000, `Showdown URL parsing exceeded the 5 s ReDoS guard (${redosMs} ms)`);

console.log(JSON.stringify({ metadataEscaped: true, redosMs, localMlRemoved: true }));
