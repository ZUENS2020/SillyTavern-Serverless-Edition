import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const thirdPartyRoot = path.join(projectRoot, 'public/scripts/extensions/third-party');
const EXTENSION_ID = /^[A-Za-z0-9._-]+$/u;

async function listDeployTimeExtensions() {
    let entries;
    try {
        entries = await readdir(thirdPartyRoot, { withFileTypes: true });
    } catch (error) {
        if (error && error.code === 'ENOENT') return [];
        throw error;
    }

    const names = [];
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (!EXTENSION_ID.test(entry.name)) {
            throw new Error(`Invalid third-party extension folder name: ${entry.name}`);
        }
        let manifest;
        try {
            manifest = await readFile(path.join(thirdPartyRoot, entry.name, 'manifest.json'), 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') continue;
            throw error;
        }
        JSON.parse(manifest);
        names.push(entry.name);
    }
    return names;
}

const names = await listDeployTimeExtensions();
const list = names.length === 0
    ? '[]'
    : `[\n${names.map(name => `    ${JSON.stringify(name)},`).join('\n')}\n]`;
const source = '// Generated from public/scripts/extensions/third-party by cloudflare/scripts/generate-third-party-catalog.mjs.\n'
    + '// Do not edit by hand.\n'
    + `export const THIRD_PARTY_EXTENSIONS = ${list} as const;\n`;

const destination = path.join(projectRoot, 'src/worker/third-party-extensions.generated.ts');
await writeFile(destination, source, 'utf8');
console.log(`Generated ${path.relative(projectRoot, destination)} (${names.length} extension${names.length === 1 ? '' : 's'})`);
