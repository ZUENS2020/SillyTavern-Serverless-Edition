import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const database = process.env.D1_DATABASE_NAME;
const config = process.env.WRANGLER_CONFIG || 'cloudflare/worker/wrangler.jsonc';
const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z');
const outputDirectory = resolve(process.env.COMFY_EXPORT_DIR || `comfy-workflows-export-${timestamp}`);

if (!database) throw new Error('Set D1_DATABASE_NAME before exporting ComfyUI workflows.');

const result = spawnSync('npx', [
    '--no-install', 'wrangler', 'd1', 'execute', database, '--remote', '--json',
    '--command', "SELECT key, value FROM app_state WHERE namespace = 'comfy-workflow' ORDER BY key",
    '--config', config,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

if (result.status !== 0) throw new Error(`Wrangler exited with status ${result.status}`);

const payload = JSON.parse(result.stdout || '[]');
const rows = Array.isArray(payload)
    ? payload.flatMap(item => Array.isArray(item?.results) ? item.results : [])
    : [];

mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
const manifest = [];
for (const row of rows) {
    if (typeof row?.key !== 'string' || typeof row?.value !== 'string') continue;
    const name = row.key.endsWith('.json') ? row.key : `${row.key}.json`;
    if (basename(name) !== name || name.includes('\0')) throw new Error(`Refusing unsafe workflow name: ${JSON.stringify(name)}`);
    const workflow = JSON.parse(row.value);
    writeFileSync(resolve(outputDirectory, name), `${JSON.stringify(workflow, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    manifest.push(name);
}

writeFileSync(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify({ version: 1, workflows: manifest }, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
});

console.log(`Exported ${manifest.length} ComfyUI workflow(s) to ${outputDirectory}`);
