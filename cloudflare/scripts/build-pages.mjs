import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import webpack from 'webpack';

import getPublicLibConfig from '../../webpack.config.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const outputDirectory = path.join(projectRoot, 'dist/pages');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(path.join(projectRoot, 'public'), outputDirectory, { recursive: true });

const webpackConfig = getPublicLibConfig({ forceDist: true });
webpackConfig.cache = false;
webpackConfig.output = {
    ...webpackConfig.output,
    path: outputDirectory,
    filename: 'lib.js',
    libraryTarget: 'module',
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
await copyFile(path.join(projectRoot, 'cloudflare/pages/_routes.json'), path.join(outputDirectory, '_routes.json'));
await copyFile(path.join(projectRoot, 'cloudflare/pages/_headers'), path.join(outputDirectory, '_headers'));

console.log(`Pages bundle written to ${path.relative(projectRoot, outputDirectory)}`);
