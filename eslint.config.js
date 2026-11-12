import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/node_modules/', '**/dist/', '**/.turbo/', 'coverage/'] },
  tseslint.configs.recommended,
]);
