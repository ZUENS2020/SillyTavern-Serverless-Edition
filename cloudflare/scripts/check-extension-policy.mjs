import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const select = (html, id) => {
    const match = html.match(new RegExp(`<select[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'u'));
    assert.ok(match, `Missing #${id} select`);
    return match[1];
};

const [index, vectors, expressions, memory, caption, stableDiffusion, tts, extensionManager] = await Promise.all([
    read('public/index.html'),
    read('public/scripts/extensions/vectors/settings.html'),
    read('public/scripts/extensions/expressions/settings.html'),
    read('public/scripts/extensions/memory/settings.html'),
    read('public/scripts/extensions/caption/settings.html'),
    read('public/scripts/extensions/stable-diffusion/settings.html'),
    read('public/scripts/extensions/tts/index.js'),
    read('public/scripts/extensions.js'),
]);

assert.match(index, /id="third_party_extension_button"[^>]*disabled/u, 'Extension install button must stay disabled');
assert.doesNotMatch(index, /id="extensions_api_url"|id="extensions_api_key"/u, 'Extras connection controls must stay removed');
assert.match(extensionManager, /Runtime extension installation is disabled/u);
assert.doesNotMatch(extensionManager, /fetch\(['"]\/api\/extensions\/install/u, 'Browser code must not call extension installation');

assert.match(select(vectors, 'vectors_source'), /value="serverless"/u);
assert.doesNotMatch(select(vectors, 'vectors_source'), /transformers|ollama|webllm|llamacpp|koboldcpp|extras|vllm/iu);
assert.doesNotMatch(vectors, /localhost|ollama pull|click here to install|--embedding/iu, 'Vector UI must not contain local deployment instructions');
assert.doesNotMatch(select(vectors, 'vectors_summary_source'), /extras|webllm/iu);
assert.doesNotMatch(select(expressions, 'expression_api'), /Extras|WebLLM|>Local</iu);
assert.doesNotMatch(select(memory, 'summary_source'), /extras|webllm/iu);
assert.doesNotMatch(select(caption, 'caption_source'), /local|extras|ollama/iu);
assert.doesNotMatch(caption, /localhost|ollama pull|data-type="(?:ollama|llamacpp|koboldcpp|ooba|vllm)"/iu);
assert.doesNotMatch(select(stableDiffusion, 'sd_source'), /automatic1111|sd\.next|stable-diffusion\.cpp|drawthings|extras/iu);
assert.doesNotMatch(stableDiffusion, /data-sd-source="(?:auto|sdcpp|drawthings|vlad)"|data-sd-comfy-type="standard"/iu);
assert.doesNotMatch(tts, /new (?:AllTalk|Coqui|Edge|Kokoro|Silero|SpeechT5|Vits|Xtts)TtsProvider/u);

console.log('Extension policy checks passed');
