import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Shared packages must run unchanged in Node, the Chrome extension and React Native.
const PLATFORM_FREE = ['packages/contracts/**', 'packages/core/**'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'infra/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: PLATFORM_FREE,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['node:*', 'fs', 'path', 'crypto', 'pg', 'fastify'], message: 'Shared packages must not use Node-only modules.' },
          { group: ['react-native', 'react-native/*', 'expo*'], message: 'Shared packages must not use React Native.' },
        ],
      }],
      'no-restricted-globals': ['error',
        { name: 'chrome', message: 'Shared packages must not use Chrome extension APIs.' },
        { name: 'window', message: 'Shared packages must not use browser globals.' },
        { name: 'document', message: 'Shared packages must not use browser globals.' },
        { name: 'process', message: 'Shared packages must not read process.' },
      ],
    },
  },
);
