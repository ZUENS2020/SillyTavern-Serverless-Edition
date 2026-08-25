import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const contentRoot = path.join(projectRoot, 'default/content');

async function readJsonFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const values = [];
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
        const text = await readFile(path.join(directory, entry.name), 'utf8');
        JSON.parse(text);
        values.push({ name: path.basename(entry.name, '.json'), text });
    }
    return values;
}

function readPngTextChunk(buffer, keyword) {
    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const start = offset + 8;
        const end = start + length;
        if (end + 4 > buffer.length) break;
        if (type === 'tEXt') {
            const chunk = buffer.subarray(start, end);
            const separator = chunk.indexOf(0);
            if (separator > 0 && chunk.toString('latin1', 0, separator) === keyword) {
                return chunk.toString('latin1', separator + 1);
            }
        }
        offset = end + 4;
    }
    return null;
}

const presetDirectories = {
    kobold: 'kobold',
    novel: 'novel',
    textgenerationwebui: 'textgen',
    openai: 'openai',
    instruct: 'instruct',
    context: 'context',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    quickReplies: 'quick-replies',
    movingUI: 'moving-ui',
};

const presets = {};
for (const [key, directory] of Object.entries(presetDirectories)) {
    presets[key] = await readJsonFiles(path.join(contentRoot, 'presets', directory));
}

const themes = await readJsonFiles(path.join(contentRoot, 'themes'));
const backgrounds = (await readdir(path.join(contentRoot, 'backgrounds'), { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .toSorted((a, b) => a.localeCompare(b));
const sprites = (await readdir(path.join(contentRoot, 'Seraphina'), { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .toSorted((a, b) => a.localeCompare(b));
const settings = await readFile(path.join(contentRoot, 'settings.json'), 'utf8');
const eldoria = await readFile(path.join(contentRoot, 'Eldoria.json'), 'utf8');
const characterPng = await readFile(path.join(contentRoot, 'default_Seraphina.png'));
const encodedCharacter = readPngTextChunk(characterPng, 'chara');
const character = encodedCharacter ? JSON.parse(Buffer.from(encodedCharacter, 'base64').toString('utf8')) : null;

const source = `// Generated from default/content by cloudflare/scripts/generate-defaults.mjs.\n`
    + `// Do not edit by hand.\n`
    + `export const DEFAULT_SETTINGS_TEXT = ${JSON.stringify(settings)};\n`
    + `export const DEFAULT_PRESETS = ${JSON.stringify(presets)} as const;\n`
    + `export const DEFAULT_THEMES = ${JSON.stringify(themes)} as const;\n`
    + `export const DEFAULT_BACKGROUNDS = ${JSON.stringify(backgrounds)} as const;\n`
    + `export const DEFAULT_SPRITES = ${JSON.stringify(sprites)} as const;\n`
    + `export const DEFAULT_WORLDS = ${JSON.stringify({ Eldoria: JSON.parse(eldoria) })} as const;\n`
    + `export const DEFAULT_CHARACTER = ${JSON.stringify(character)} as const;\n`;

const destination = path.join(projectRoot, 'cloudflare/worker/src/defaults.generated.ts');
await writeFile(destination, source, 'utf8');
console.log(`Generated ${path.relative(projectRoot, destination)}`);
