import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'public/worklets/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ['src/renderer/**', 'src/audio/worklets/**'],
    languageOptions: {
      globals: {
        ...globals.browser,
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        // Substituted by the bundler, so they exist at build time and nowhere
        // in the source. See `define` in vite.config.ts.
        __APP_VERSION__: 'readonly',
        __BUILD_COMMIT__: 'readonly',
        __BUILD_DATE__: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**', 'electron/**', 'tools/**', 'e2e/**', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        // Substituted by esbuild — see `define` in scripts/build-electron.mjs.
        __BUILD_COMMIT__: 'readonly',
        __BUILD_DATE__: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.svelte'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
