import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HYPOTHESIS_PLUGIN, PROPERTY_RUNS, UNCUT, drawSeed, rerunProperties, underFactorySettings, type RerunDeps } from './property-runs.js';

const at = { runs: 50, seed: 42 };
const SET = `numRuns: 50, seed: 42, ${UNCUT}`;

describe('the factory settings written into a property test (ORC-261)', () => {
  it('puts its runs and seed after those of fast-check calls, so they win, and counts the calls', () => {
    const source = "import fc from 'fast-check';\nfc.assert(fc.property(fc.integer(), () => true), { numRuns: 5, seed: 1 });\nfc.check(p);";
    const out = underFactorySettings('a.test.ts', source, at);
    expect(out.calls).toBe(2);
    expect(out.source).toContain(`fc.assert(fc.property(fc.integer(), () => true), { ...({ numRuns: 5, seed: 1 }), ${SET} });`);
    expect(out.source).toContain(`fc.check(p, { ${SET} });`);
  });

  it('reads a namespace import, named imports under an alias, and a require', () => {
    const named = underFactorySettings('a.test.ts', "import { assert as check, property } from 'fast-check';\ncheck(property(), params);", at);
    expect(named).toEqual({ source: `// @ts-nocheck\nimport { assert as check, property } from 'fast-check';\ncheck(property(), { ...(params), ${SET} });`, calls: 1 });
    expect(underFactorySettings('a.test.ts', "import * as f from 'fast-check';\nf.assert(p);", at).calls).toBe(1);
    expect(underFactorySettings('a.test.js', "const fc = require('fast-check');\nfc.assert(p);", at).calls).toBe(1);
    expect(underFactorySettings('a.test.js', "const { assert } = require('fast-check');\nassert(p);", at).calls).toBe(1);
  });

  it('reads the test.prop of @fast-check/vitest and @fast-check/jest, and their fc', () => {
    const source = "import { test, fc } from '@fast-check/vitest';\ntest.prop([fc.integer()], { numRuns: 1 })('x', (n) => {});\nfc.assert(p);";
    const out = underFactorySettings('a.test.ts', source, at);
    expect(out.calls).toBe(2);
    expect(out.source).toContain(`test.prop([fc.integer()], { ...({ numRuns: 1 }), ${SET} })('x'`);
    expect(underFactorySettings('a.test.ts', "import { it as t } from '@fast-check/jest';\nt.prop([a])('x', () => {});", at).source).toContain(`t.prop([a], { ${SET} })`);
    expect(underFactorySettings('a.test.ts', "import { test } from '@fast-check/vitest';\ntest.skip.prop([a])('x', () => {});\ntest.concurrent.prop([a], p)('y', () => {});", at).calls).toBe(2);
  });

  it('turns type checking off in a file it rewrites, its shebang kept first, so that its settings cannot fail a typed run', () => {
    expect(underFactorySettings('a.test.ts', "import fc from 'fast-check';\nfc.assert(p);", at).source).toMatch(/^\/\/ @ts-nocheck\nimport fc/);
    expect(underFactorySettings('a.test.js', "#!/usr/bin/env node\nconst fc = require('fast-check');\nfc.assert(p);", at).source).toMatch(/^#!\/usr\/bin\/env node\n\/\/ @ts-nocheck\nconst fc/);
    expect(underFactorySettings('a.test.ts', 'other.assert(x);', at).source).toBe('other.assert(x);');
  });

  it('leaves alone what is not fast-check: another assert, a shadowing name, a file without it', () => {
    expect(underFactorySettings('a.test.ts', "import { assert } from 'node:assert';\nassert(x);", at).calls).toBe(0);
    expect(underFactorySettings('a.test.ts', "import { test } from 'vitest';\ntest.prop([a]);", at).calls).toBe(0);
    expect(underFactorySettings('a.test.ts', 'other.assert(x);', at)).toEqual({ source: 'other.assert(x);', calls: 0 });
  });

  it('settles nothing without Hypothesis installed, so that the tests run as written instead of pytest failing to load the plugin', () => {
    expect(HYPOTHESIS_PLUGIN).toMatch(/try:\n {4}from hypothesis import Phase, settings\nexcept ImportError:\n {4}settings = None/);
    expect(HYPOTHESIS_PLUGIN).toContain('for item in items if settings else []:');
  });

  it('draws a seed fast-check takes: a positive 32-bit integer', () => {
    const seed = drawSeed();
    expect(Number.isInteger(seed) && seed > 0 && seed < 2 ** 31).toBe(true);
    expect(PROPERTY_RUNS).toBe(1000);
  });
});

describe('a rewritten fast-check test runs under the factory settings, whatever the file sets (ORC-261)', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('runs the factory number of times with its seed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-261-'));
    const source = [
      "import fc from 'fast-check';",
      'export const seen = [];',
      // What a setup file or the code under test could set, past the test's own parameters, to end the runs early.
      'fc.configureGlobal({ numRuns: 2, interruptAfterTimeLimit: 1, skipAllAfterTimeLimit: 1, ignoreEqualValues: true, skipEqualValues: true });',
      'const busy = () => { const end = Date.now() + 1; while (Date.now() < end); };',
      "fc.assert(fc.property(fc.integer(), (n) => { busy(); seen.push(n); }), { numRuns: 3, seed: 7, path: '0:0', plugins: [fc.interruptAfterTimeLimit(1)] });",
      // A reporter that does not throw would hide a failure.
      "export const hidden = (() => { try { fc.assert(fc.property(fc.integer(), () => false), { reporter: () => {} }); return false; } catch { return true; } })();",
    ].join('\n');
    const rewritten = underFactorySettings('p.test.mjs', source, at).source;
    const fastCheck = pathToFileURL(createRequire(import.meta.url).resolve('fast-check')).href;
    const load = async (name: string) => {
      writeFileSync(join(dir!, name), rewritten.replace("'fast-check'", JSON.stringify(fastCheck)));
      return ((await import(pathToFileURL(join(dir!, name)).href)) as { seen: number[] }).seen;
    };
    const [first, second] = [await load('a.mjs'), await load('b.mjs')];
    expect(first).toHaveLength(50);
    expect(second).toEqual(first);
    expect(((await import(pathToFileURL(join(dir, 'a.mjs')).href)) as { hidden: boolean }).hidden).toBe(true);
  });
});

describe('the rerun of the property tests (ORC-261)', () => {
  const fake = (files: Record<string, string>, exit: (line: string) => number = () => 0) => {
    const written: Record<string, string> = {};
    const lines: { line: string; env: Record<string, string> }[] = [];
    const deps: RerunDeps = {
      write: async (p, content) => void (written[p] = content),
      run: async (line, env) => {
        lines.push({ line, env });
        const settled = env.FACTORY_PROPERTY_SETTLED;
        if (settled) written[settled] = 'test_orc_1_property_2.py';
        return { exitCode: exit(line), output: 'out' };
      },
      read: async (p) => written[p] ?? '',
    };
    return { deps, written, lines };
  };
  const files = {
    'src/orc-1.property-1.test.ts': "import fc from 'fast-check';\nfc.assert(p);",
    'tests/test_orc_1_property_2.py': 'from hypothesis import given',
    'src/orc-1.property-3.test.ts': "it('x', () => {});",
  };
  const paths = Object.keys(files);
  const sources = new Map(Object.entries(files));
  const vitest = { line: 'npx vitest run', runner: 'vitest' as const };

  it('writes the settled files, runs each language with its command, and says the runs and the seed', async () => {
    const { deps, written, lines } = fake(files);
    const out = await rerunProperties(sources, { js: vitest, py: 'pytest' }, deps, at);
    expect(written['src/orc-1.property-1.test.ts']).toContain(SET);
    expect(written['src/orc-1.property-3.test.ts']).toBeUndefined();
    expect(lines[0]!.line).toBe("npx vitest run 'src/orc-1.property-1.test.ts' 'src/orc-1.property-3.test.ts'");
    expect(lines[1]!.line).toMatch(/^export PYTHONPATH=\S+; pytest -p factory_properties 'tests\/test_orc_1_property_2.py'$/);
    expect(lines[1]!.env).toMatchObject({ FACTORY_PROPERTY_RUNS: '50', FACTORY_PROPERTY_SEED: '42' });
    expect(Object.values(written).some((c) => c.includes('_hypothesis_internal_use_seed'))).toBe(true);
    expect(out).toEqual({ rerun: { runs: 50, seed: 42, files: paths, unsettled: ['src/orc-1.property-3.test.ts'], notRun: [], found: false }, failures: [] });
  });

  it('a red rerun is a failure that names the runs and the seed, and a defect the properties found', async () => {
    const { deps } = fake(files, (line) => (line.includes('vitest') ? 1 : 0));
    const out = await rerunProperties(sources, { js: vitest, py: 'pytest' }, deps, at);
    expect(out.rerun.found).toBe(true);
    expect(out.failures).toEqual([{ command: "npx vitest run 'src/orc-1.property-1.test.ts' 'src/orc-1.property-3.test.ts'", exitCode: 1, output: expect.stringMatching(/^Property tests rerun by the factory: 50 runs, seed 42[^\n]*\n[\s\S]*out$/) }]);
  });

  it('gives jest its files as patterns, escaped', async () => {
    const { deps, lines } = fake({ 'app/[id]/orc-1.property-1.test.ts': "import fc from 'fast-check';\nfc.assert(p);" });
    await rerunProperties(new Map([['app/[id]/orc-1.property-1.test.ts', "import fc from 'fast-check';\nfc.assert(p);"]]), { js: { line: 'npx jest', runner: 'jest' } }, deps, at);
    expect(lines[0]!.line).toBe("npx jest 'app/\\[id\\]/orc-1\\.property-1\\.test\\.ts'");
  });

  it('runs nothing of a language no test command runs, and says so', async () => {
    const { deps, lines } = fake(files);
    const out = await rerunProperties(sources, { js: vitest }, deps, at);
    expect(lines).toHaveLength(1);
    expect(out.rerun.notRun).toEqual(['tests/test_orc_1_property_2.py']);
  });
});
