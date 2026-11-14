import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'web/dist/**', 'node_modules/**', 'coverage/**', 'spikes/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // The old orchestrator's pieces left core/ (ORC-390): the live feed is the server's, the queue capacity the runtime's.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/core/bus', '**/core/bus.js', './bus.js', './bus'], message: 'core/bus is now src/server/live-feed.ts (ORC-390).' },
            { group: ['**/core/scheduler', '**/core/scheduler.js', './scheduler.js', './scheduler'], message: 'core/scheduler is now src/runtime/capacity.ts (ORC-390).' },
          ],
        },
      ],
    },
  },
);
