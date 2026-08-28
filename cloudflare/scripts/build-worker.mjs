import { execFile } from 'node:child_process';
import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import webpack from 'webpack';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const outputDirectory = path.join(projectRoot, 'dist');
const execFileAsync = promisify(execFile);

async function getAssetVersion() {
    const deploymentCommit = String(process.env.CF_VERSION_METADATA_ID ?? process.env.GITHUB_SHA ?? '').trim();
    if (deploymentCommit) return deploymentCommit.slice(0, 12).replace(/[^a-zA-Z0-9_-]/gu, '');

    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: projectRoot });
        const commit = stdout.trim().replace(/[^a-zA-Z0-9_-]/gu, '');
        if (commit) return commit;
    } catch {
        // Source archives may not contain Git metadata; fall back to package version.
    }

    const packageData = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    return String(packageData.version ?? 'serverless').replace(/[^a-zA-Z0-9_-]/gu, '-');
}

async function versionBrowserAssets(directory, assetVersion, rewriteIndex = true) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await versionBrowserAssets(entryPath, assetVersion, false);
            continue;
        }

        if (!/\.(?:js|mjs)$/u.test(entry.name)) continue;
        const source = await readFile(entryPath, 'utf8');
        const versioned = source.replace(
            /(["'])((?:(?:\.\.?)\/|\/)[^"'?\r\n]+?\.(?:js|mjs))\1/gu,
            (_, quote, url) => `${quote}${url}?v=${assetVersion}${quote}`,
        );
        if (versioned !== source) await writeFile(entryPath, versioned);
    }

    if (!rewriteIndex) return;

    const indexPath = path.join(directory, 'index.html');
    const index = await readFile(indexPath, 'utf8');
    const versionedIndex = index.replace(
        /((?:src|href)=["'])((?!https?:|data:)[^"'?#]+?\.(?:css|js|mjs))(["'])/gu,
        (_, prefix, url, suffix) => `${prefix}${url}?v=${assetVersion}${suffix}`,
    );
    if (!versionedIndex.includes(`src="script.js?v=${assetVersion}"`)) {
        throw new Error('Failed to version the main browser module');
    }
    await writeFile(indexPath, versionedIndex);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(path.join(projectRoot, 'public'), outputDirectory, { recursive: true });

const webpackConfig = {
    mode: 'production',
    entry: path.join(projectRoot, 'public/lib.js'),
    cache: false,
    devtool: false,
    watch: false,
    module: {},
    plugins: [new webpack.IgnorePlugin({ resourceRegExp: /^happy-dom$/u })],
    stats: { preset: 'minimal', assets: false, modules: false, colors: true, timings: true },
    experiments: { outputModule: true },
    performance: { hints: false },
    output: {
        path: outputDirectory,
        filename: 'lib.js',
        libraryTarget: 'module',
    },
};

await new Promise((resolve, reject) => {
    const compiler = webpack(webpackConfig);
    compiler.run((error, stats) => {
        const close = (resultError) => compiler.close(() => resultError ? reject(resultError) : resolve());
        if (error) return close(error);
        if (stats?.hasErrors()) {
            return close(new Error(stats.toString({ all: false, errors: true, warnings: true })));
        }
        return close();
    });
});

await cp(path.join(projectRoot, 'default/content'), path.join(outputDirectory, 'defaults'), { recursive: true });
await cp(path.join(projectRoot, 'default/content/backgrounds'), path.join(outputDirectory, 'backgrounds'), { recursive: true });
await mkdir(path.join(outputDirectory, 'characters'), { recursive: true });
await copyFile(
    path.join(projectRoot, 'default/content/default_Seraphina.png'),
    path.join(outputDirectory, 'characters/default_Seraphina.png'),
);
await cp(
    path.join(projectRoot, 'default/content/Seraphina'),
    path.join(outputDirectory, 'characters/Seraphina'),
    { recursive: true },
);
await mkdir(path.join(outputDirectory, 'User Avatars'), { recursive: true });
await copyFile(
    path.join(projectRoot, 'default/content/user-default.png'),
    path.join(outputDirectory, 'User Avatars/user-default.png'),
);
await copyFile(path.join(projectRoot, 'default/content/user.css'), path.join(outputDirectory, 'css/user.css'));
await copyFile(path.join(projectRoot, 'LICENSE'), path.join(outputDirectory, 'LICENSE.txt'));
await copyFile(path.join(projectRoot, 'NOTICE'), path.join(outputDirectory, 'NOTICE.txt'));

const assetVersion = await getAssetVersion();
await versionBrowserAssets(outputDirectory, assetVersion);

console.log(`Worker Static Assets bundle written to ${path.relative(projectRoot, outputDirectory)} (assets ${assetVersion})`);
