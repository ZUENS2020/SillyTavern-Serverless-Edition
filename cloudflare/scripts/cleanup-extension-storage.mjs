import { spawnSync } from 'node:child_process';

const database = process.env.D1_DATABASE_NAME;
const bucket = process.env.R2_BUCKET_NAME;
const config = process.env.WRANGLER_CONFIG || 'cloudflare/worker/wrangler.jsonc';

if (!database || !bucket) {
    throw new Error('Set D1_DATABASE_NAME and R2_BUCKET_NAME before running extension storage cleanup.');
}

function wrangler(args, capture = false) {
    const result = spawnSync('npx', ['--no-install', 'wrangler', ...args, '--config', config], {
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    if (result.status !== 0) throw new Error(`Wrangler exited with status ${result.status}`);
    return result.stdout || '';
}

const query = "SELECT r2_key FROM objects WHERE kind = 'generated-media' ORDER BY r2_key";
const raw = wrangler(['d1', 'execute', database, '--remote', '--json', '--command', query], true);
const payload = JSON.parse(raw);
const rows = Array.isArray(payload)
    ? payload.flatMap(item => Array.isArray(item?.results) ? item.results : [])
    : [];
const keys = rows.map(row => row?.r2_key).filter(key => typeof key === 'string' && key.length > 0);

for (const key of keys) {
    if (key === '/' || key.includes('\0')) throw new Error(`Refusing unsafe R2 key: ${JSON.stringify(key)}`);
    wrangler(['r2', 'object', 'delete', `${bucket}/${key}`, '--remote']);
}

wrangler([
    'd1', 'execute', database, '--remote',
    '--command', "DELETE FROM objects WHERE kind = 'generated-media'",
]);

console.log(`Deleted ${keys.length} generated-media R2 object(s) and their D1 indexes.`);
