import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['dist/', 'node_modules/', 'public/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser } } },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    // scripts also hold page.evaluate callbacks that run in the browser
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  prettier,
]);
