import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// ORC-169 AC2: nothing in src/ imports the old orchestrator, its bus or its scheduler from core/. The lint rule of
// eslint.config.js refuses it, and CI runs the lint: this holds that the rule is still wired, and that the files stay gone.
const root = join(import.meta.dirname, '..');
const OLD = ['orchestrator', 'bus', 'scheduler'];

const eslint = new ESLint({ cwd: root });

const lintErrors = async (filePath: string, code: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
};

describe('the old orchestrator is gone from core/ (ORC-169)', () => {
  it('has no core/orchestrator, core/bus or core/scheduler left', () => {
    expect(OLD.map((m) => `src/core/${m}.ts`).filter((p) => existsSync(join(root, p)))).toEqual([]);
  });

  it.each(OLD)('refuses an import of core/%s, from outside core/ and from inside it', async (m) => {
    expect(await lintErrors('src/app/probe.ts', `import '../core/${m}.js';\nexport * from '../core/${m}';\n`)).toHaveLength(2);
    expect(await lintErrors('src/core/probe.ts', `import './${m}.js';\n`)).toHaveLength(1);
  });

  it('lets the modules that replaced them be imported', async () => {
    const code = "import '../server/live-feed.js';\nimport '../runtime/capacity.js';\nimport '../runtime/daemon.js';\n";
    expect(await lintErrors('src/app/probe.ts', code)).toEqual([]);
  });
});
