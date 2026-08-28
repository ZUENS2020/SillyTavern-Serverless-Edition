import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
                bindings: {
                    APP_ORIGIN: 'https://sillytavern.test',
                    ACCESS_AUD: 'test-audience',
                    ACCESS_TEAM_DOMAIN: 'https://sillytavern-test.cloudflareaccess.com',
                    TEST_BYPASS_ACCESS: 'true',
                },
            },
        }),
    ],
    test: {
        include: ['tests/worker/**/*.test.ts'],
        sequence: { concurrent: false },
    },
});
