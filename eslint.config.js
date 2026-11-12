import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/node_modules/', '**/dist/', '**/.turbo/', 'coverage/'] },
  tseslint.configs.recommended,
  {
    // The shared reducer must be pure: same log in, same board out (NFR-Convergence, SEC-12).
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', 'Date', 'performance', 'crypto', 'fetch', 'window', 'process'],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random' }],
      'no-restricted-imports': ['error', { patterns: ['node:*'] }],
    },
  },
]);
