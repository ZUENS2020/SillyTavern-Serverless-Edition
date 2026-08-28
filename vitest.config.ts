import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        cloudflareTest({
            // CI must run entirely against Miniflare. Remote bindings are useful for
            // production-like smoke tests, but they require a Cloudflare API token and
            // would make the normal unit-test job depend on external credentials.
            remoteBindings: false,
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
