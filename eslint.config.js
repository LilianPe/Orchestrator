import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The old orchestrator's pieces left core/ (ORC-390, ORC-394): the live feed is the server's, the queue capacity and the daemon the runtime's.
const movedOutOfCore = (prefixes) => [
  { group: prefixes.flatMap((p) => [`${p}bus`, `${p}bus.js`]), message: 'core/bus is now src/server/live-feed.ts (ORC-390).' },
  { group: prefixes.flatMap((p) => [`${p}scheduler`, `${p}scheduler.js`]), message: 'core/scheduler is now src/runtime/capacity.ts (ORC-390).' },
  { group: prefixes.flatMap((p) => [`${p}orchestrator`, `${p}orchestrator.js`]), message: 'core/orchestrator is now the Daemon of src/runtime/daemon.ts (ORC-394).' },
  // The YAML workflow is gone (ORC-389): the workflow is built by defaultWorkflow, its types are core/workflow's.
  { group: ['**/config/load-workflow', '**/config/load-workflow.js'], message: 'The YAML loader is gone: defaultWorkflow() in src/presets/workflow.ts (ORC-389).' },
  { group: ['**/config/workflow-schema', '**/config/workflow-schema.js'], message: 'The workflow types are in src/core/workflow.ts (ORC-389).' },
  // The `when` grammar of the rules is gone (ORC-392, ORC-177 AC3): the reactions are coded in decide.
  { group: prefixes.flatMap((p) => [`${p}conditions`, `${p}conditions.js`]), message: 'The `when` grammar is gone: the default reactions are coded in decide (ORC-392).' },
];

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
      'no-restricted-imports': ['error', { patterns: movedOutOfCore(['**/core/']) }],
    },
  },
  {
    // Inside core/, a sibling import names them too.
    files: ['src/core/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: movedOutOfCore(['**/core/', './']) }] },
  },
);
