import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const config = await readFile(new URL('wrangler.jsonc', root), 'utf8');
assert.match(config, /"APP_ORIGIN"\s*:\s*"https:\/\/sillytavern\.zuens2020\.work"/u);
assert.match(config, /"ACCESS_TEAM_DOMAIN"\s*:\s*"https:\/\/zuens2020\.cloudflareaccess\.com"/u);
assert.doesNotMatch(config, /"ACCESS_AUD"\s*:\s*"(?:SET_|CHANGE_|TODO)/u, 'ACCESS_AUD must be the production Access application AUD');
assert.match(config, /"workers_dev"\s*:\s*false/u);
assert.match(config, /"preview_urls"\s*:\s*false/u);
console.log('Cloudflare Access deployment configuration is pinned');
