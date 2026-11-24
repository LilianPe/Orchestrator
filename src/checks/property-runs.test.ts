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

  it('turns it off past the leading comments, where jest reads its docblock (its environment pragma)', () => {
    // Split, or vitest reads the pragma of this very file.
    const docblock = `/**\n * @${'jest'}-environment jsdom\n */\n// a note\n`;
    const out = underFactorySettings('a.test.ts', `${docblock}import fc from 'fast-check';\nfc.assert(p);`, at).source;
    expect(out.startsWith(`${docblock}// @ts-nocheck\nimport fc`)).toBe(true);
    expect(underFactorySettings('a.test.ts', "/* x */ import fc from 'fast-check';\nfc.assert(p);", at).source).toMatch(/^\/\* x \*\/\n\/\/ @ts-nocheck\n import fc/);
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

  it('names a settled file by the path pytest 7 gives its items, or by the fspath of earlier ones, which have no path', () => {
    expect(HYPOTHESIS_PLUGIN).toContain('settled.add(os.path.basename(str(getattr(item, "path", None) or item.fspath)))');
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
      // A life-cycle plugin of the test stays: the property may need it.
      'export const before = [];',
      "fc.assert(fc.property(fc.integer(), (n) => { busy(); seen.push(n); }), { numRuns: 3, seed: 7, path: '0:0', plugins: [fc.beforeEach(() => before.push(1))] });",
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
    const loaded = (await import(pathToFileURL(join(dir, 'a.mjs')).href)) as { hidden: boolean; before: number[] };
    expect(loaded.hidden).toBe(true);
    expect(loaded.before).toHaveLength(50);
  });
});

describe('the rerun of the property tests (ORC-261)', () => {
  /** A vitest JSON report: each file with its tests, `failed` those named. */
  const vitestReport = (tests: Record<string, Record<string, 'passed' | 'failed'>>) =>
    JSON.stringify({ testResults: Object.entries(tests).map(([name, results]) => ({ name, assertionResults: Object.entries(results).map(([title, status]) => ({ fullName: title, status })) })) });
  const junit = (file: string) => `<testsuite><testcase classname="tests.test_orc_1_property_2" name="test_p" file="${file}"/></testsuite>`;
  type Answer = { exitCode: number; report?: string };
  const fake = (answer: (line: string) => Answer = (line) => ({ exitCode: 0, report: line.includes('pytest') ? junit('tests/test_orc_1_property_2.py') : vitestReport({ 'src/orc-1.property-1.test.ts': { p: 'passed' }, 'src/orc-1.property-3.test.ts': { x: 'passed' } }) }), known: string[] = []) => {
    const written: Record<string, string> = {};
    const lines: { line: string; runner: string; env: Record<string, string> }[] = [];
    const deps: RerunDeps = {
      write: async (p, content) => void (written[p] = content),
      run: async (line, runner, env) => {
        lines.push({ line, runner, env });
        const settled = env.FACTORY_PROPERTY_SETTLED;
        if (settled) written[settled] = 'test_orc_1_property_2.py';
        return { ...answer(line), output: 'out' };
      },
      read: async (p) => written[p] ?? '',
      counts: (t) => !known.includes(t.id),
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
  const js = new Map([...sources].filter(([f]) => f.endsWith('.ts')));
  const vitest = { line: 'npx vitest run', runner: 'vitest' as const };
  const vitestLine = "npx vitest run --passWithNoTests 'src/orc-1.property-1.test.ts' 'src/orc-1.property-3.test.ts'";

  it('writes the settled files, runs each language with its command and its report, and says the runs and the seed', async () => {
    const { deps, written, lines } = fake();
    const out = await rerunProperties(sources, { js: vitest, py: 'pytest' }, deps, at);
    expect(written['src/orc-1.property-1.test.ts']).toContain(SET);
    expect(written['src/orc-1.property-3.test.ts']).toBeUndefined();
    expect(lines[0]).toMatchObject({ line: vitestLine, runner: 'vitest' });
    expect(lines[1]!.line).toMatch(/^export PYTHONPATH=\S+; pytest -p factory_properties 'tests\/test_orc_1_property_2.py'$/);
    expect(lines[1]).toMatchObject({ runner: 'pytest', env: { FACTORY_PROPERTY_RUNS: '50', FACTORY_PROPERTY_SEED: '42' } });
    expect(Object.values(written).some((c) => c.includes('_hypothesis_internal_use_seed'))).toBe(true);
    expect(out).toEqual({ rerun: { runs: 50, seed: 42, files: paths, unsettled: ['src/orc-1.property-3.test.ts'], notRun: [], found: false }, failures: [] });
  });

  it('gives the code under test no sign of the rerun in JS and TS: the settings are in the files, not in its environment', async () => {
    const { deps, lines } = fake();
    await rerunProperties(js, { js: vitest }, deps, at);
    expect(lines[0]!.env).toEqual({});
  });

  it('a failing test of its report is a failure that names the runs and the seed, and a defect the properties found', async () => {
    const { deps } = fake(() => ({ exitCode: 1, report: vitestReport({ 'src/orc-1.property-1.test.ts': { p: 'failed' }, 'src/orc-1.property-3.test.ts': { x: 'passed' } }) }));
    const out = await rerunProperties(js, { js: vitest }, deps, at);
    expect(out.rerun!.found).toBe(true);
    expect(out.failures).toEqual([{ command: vitestLine, exitCode: 1, output: expect.stringMatching(/^Property tests rerun by the factory: 50 runs, seed 42[^\n]*\n[\s\S]*out$/) }]);
  });

  it('a red exit whose report names no failing test that counts is no failure: a coverage threshold missed on a few files, a known flaky test', async () => {
    const threshold = fake(() => ({ exitCode: 1, report: vitestReport({ 'src/orc-1.property-1.test.ts': { p: 'passed' }, 'src/orc-1.property-3.test.ts': { x: 'passed' } }) }));
    expect(await rerunProperties(js, { js: vitest }, threshold.deps, at)).toMatchObject({ rerun: { found: false }, failures: [] });
    const flaky = fake(() => ({ exitCode: 1, report: vitestReport({ 'src/orc-1.property-1.test.ts': { p: 'passed', 'cart total': 'failed' }, 'src/orc-1.property-3.test.ts': { x: 'passed' } }) }), ['src/orc-1.property-1.test.ts > cart total']);
    expect(await rerunProperties(js, { js: vitest }, flaky.deps, at)).toMatchObject({ rerun: { found: false }, failures: [] });
  });

  it('a red exit without a report that names its tests is a failure: the files did not load', async () => {
    const { deps } = fake(() => ({ exitCode: 1 }));
    expect((await rerunProperties(js, { js: vitest }, deps, at)).failures).toHaveLength(1);
  });

  it('a file its run did not report did not run again, and no file run again is no rerun', async () => {
    const some = fake(() => ({ exitCode: 0, report: vitestReport({ 'src/orc-1.property-1.test.ts': { p: 'passed' } }) }));
    expect((await rerunProperties(js, { js: vitest }, some.deps, at)).rerun!.notRun).toEqual(['src/orc-1.property-3.test.ts']);
    const none = fake(() => ({ exitCode: 1, report: vitestReport({}) }));
    expect(await rerunProperties(js, { js: vitest }, none.deps, at)).toEqual({ failures: [] });
  });

  it('a failing test its report names under another file still fails it, and the rerun is said and measured', async () => {
    const { deps } = fake(() => ({ exitCode: 1, report: vitestReport({ 'src/base.ts': { inherited: 'failed' } }) }));
    const out = await rerunProperties(js, { js: vitest }, deps, at);
    expect(out.failures).toHaveLength(1);
    expect(out.rerun).toMatchObject({ found: true, notRun: [...js.keys()] });
  });

  it('gives jest its files as patterns, escaped', async () => {
    const { deps, lines } = fake();
    await rerunProperties(new Map([['app/[id]/orc-1.property-1.test.ts', "import fc from 'fast-check';\nfc.assert(p);"]]), { js: { line: 'npx jest', runner: 'jest' } }, deps, at);
    expect(lines[0]!.line).toBe("npx jest --passWithNoTests 'app/\\[id\\]/orc-1\\.property-1\\.test\\.ts'");
  });

  it('runs nothing of a language no test command runs, and says so; with nothing run again, no rerun', async () => {
    const { deps, lines } = fake();
    const out = await rerunProperties(sources, { js: vitest }, deps, at);
    expect(lines).toHaveLength(1);
    expect(out.rerun!.notRun).toEqual(['tests/test_orc_1_property_2.py']);
    expect(await rerunProperties(sources, {}, fake().deps, at)).toEqual({ failures: [] });
  });
});
