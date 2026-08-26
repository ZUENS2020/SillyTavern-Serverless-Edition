import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './cloudflare/worker/wrangler.jsonc' },
            miniflare: {
                bindings: {
                    SECRET_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
                },
            },
        }),
    ],
    test: {
        include: ['cloudflare/worker/test/**/*.test.ts'],
        sequence: { concurrent: false },
    },
});
