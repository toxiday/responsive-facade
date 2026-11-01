import { defineConfig } from 'vitest/config';

// Served from the root of facade.tonydai.com (a subdomain), not /repo-name/.
export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
