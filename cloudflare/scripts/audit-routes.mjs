import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function files(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...await files(fullPath));
        else result.push(fullPath);
    }
    return result;
}

function routeExpression(pattern) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const parameters = escaped.replace(/:[a-zA-Z0-9_-]+/gu, '[^/]+').replaceAll('\\*', '.*');
    return new RegExp(`^${parameters}$`, 'u');
}

const uiRoutes = new Set();
for (const file of await files(path.join(root, 'public'))) {
    if (!/\.(?:html|js)$/u.test(file) || file.endsWith('.min.js') || file.includes(`${path.sep}lib${path.sep}`)) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/[\x27"`](\/api\/[a-zA-Z0-9_./${}-]+)/gu)) {
        const value = match[1]?.replace(/\$\{[^}]+\}/gu, '*');
        if (value) uiRoutes.add(value.replace(/\/$/u, ''));
    }
}

const bundle = await build({
    entryPoints: [path.join(root, 'cloudflare/worker/src/index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Unable to inspect Worker routes');
const compiledModule = { exports: {} };
const evaluate = new Function('require', 'module', 'exports', bundledSource);
evaluate(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const workerModule = compiledModule.exports;
if (typeof workerModule.registeredRoutes !== 'function') throw new Error('Worker route registry is unavailable');
const workerRoutes = new Set(workerModule.registeredRoutes().map(route => route.pattern));

const expressions = [...workerRoutes].map(routeExpression);
const missing = [...uiRoutes].filter(route => (
    !expressions.some(expression => expression.test(route)) &&
    // Template literals such as `${basePath}/generate` are split by the source
    // scanner at the interpolation. A registered child route proves the prefix.
    ![...workerRoutes].some(workerRoute => workerRoute.startsWith(`${route}/`))
)).sort();

console.log(`UI API literals: ${uiRoutes.size}`);
console.log(`Worker route patterns: ${workerRoutes.size}`);
console.log(`Unmatched UI literals: ${missing.length}`);
for (const route of missing) console.log(route);
