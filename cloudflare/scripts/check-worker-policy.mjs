import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function files(directory, predicate = () => true) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...await files(fullPath, predicate));
        else if (predicate(fullPath)) result.push(fullPath);
    }
    return result;
}

const workerFiles = await files(path.join(root, 'src/worker'), file => file.endsWith('.ts') && !file.includes(' 2.ts'));
const workerSources = await Promise.all(workerFiles.map(async file => ({ file, source: await readFile(file, 'utf8') })));
const failures = [];
const bannedWorkerPatterns = [
    [/from\s+['"]node:/u, 'Node built-in import'],
    [/from\s+['"](?:fs|child_process|cluster|worker_threads)['"]/u, 'Node server API import'],
    [/\b(?:eval|Function)\s*\(/u, 'dynamic code execution'],
    [/fetch\(\s*['"]https?:\/\//u, 'direct external fetch'],
    [/Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*/u, 'wildcard CORS'],
    [/['"]\/(?:csrf-token|api\/users(?:\/|['"])|api\/secrets(?:\/|['"]))/u, 'application account or secret route'],
    [/\b(?:npm|pnpm|yarn)\s+(?:install|add)\b/u, 'dynamic package installation'],
];

for (const { file, source } of workerSources) {
    for (const [pattern, label] of bannedWorkerPatterns) {
        if (pattern.test(source)) failures.push(`${path.relative(root, file)}: ${label}`);
    }
    if (/\.AI\.run\(/u.test(source) && !/gateway:\s*\{[\s\S]*?id:\s*(?:env|context\.env)\.AI_GATEWAY_ID/u.test(source)) {
        failures.push(`${path.relative(root, file)}: AI binding call without the configured Gateway`);
    }
}

const browserFiles = await files(path.join(root, 'public'), file => /\.(?:html|js)$/u.test(file) && !file.includes(`${path.sep}lib${path.sep}`));
for (const file of browserFiles) {
    const source = await readFile(file, 'utf8');
    if (/fetch\(\s*['"]https?:\/\//u.test(source) || /new\s+WebSocket\(\s*['"]wss?:\/\//u.test(source)) {
        failures.push(`${path.relative(root, file)}: browser Provider connection`);
    }
}

const migration = await readFile(path.join(root, 'migrations/0001_single_instance.sql'), 'utf8');
assert.doesNotMatch(migration, /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:users|accounts|sessions|roles|permissions|secrets|vectors)\b/iu);
assert.doesNotMatch(migration, /\bembedding\s+(?:BLOB|TEXT)\b/iu);

const wrangler = await readFile(path.join(root, 'wrangler.jsonc'), 'utf8');
assert.match(wrangler, /"workers_dev"\s*:\s*false/u);
assert.match(wrangler, /"preview_urls"\s*:\s*false/u);
assert.doesNotMatch(wrangler, /"cpu_ms"\s*:\s*(?:[1-9]\d{1,}|[2-9])/u, 'Do not raise the 10 ms CPU design budget');
assert.doesNotMatch(wrangler, /nodejs_compat/u);
for (const binding of ['ASSETS', 'DB', 'CACHE', 'BUCKET', 'VECTOR_INDEX', 'AI', 'MAINTENANCE']) {
    assert.match(wrangler, new RegExp(`"${binding}"`, 'u'), `Missing ${binding} binding`);
}

for (const removedPath of ['server.js', 'src/endpoints', 'src/electron', 'docker', 'colab', 'plugins']) {
    await assert.rejects(access(path.join(root, removedPath)), `${removedPath} must stay removed`);
}

if (failures.length > 0) throw new Error(`Worker policy violations:\n${failures.join('\n')}`);
console.log(`Worker policy checks passed (${workerFiles.length} Worker files, ${browserFiles.length} browser files)`);
