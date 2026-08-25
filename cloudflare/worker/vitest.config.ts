import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './cloudflare/worker/wrangler.jsonc' },
        }),
    ],
    test: {
        include: ['cloudflare/worker/test/**/*.test.ts'],
        sequence: { concurrent: false },
    },
});
