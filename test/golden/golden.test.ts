import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadGoldenSet } from '../../src/golden/golden-set.js';
import { compareGoldenReports, formatGoldenReport, replayGoldenSet, type GoldenReport } from '../../src/golden/replay.js';
import { packDir } from '../helpers/harness.js';
import { fakeGoldenPass } from './fake-pass.js';

/** Every process the replay would start: none, no `git push`, no `gh`, no `claude` (ORC-236). */
const spawned = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const refuse = (name: string) => (...args: unknown[]) => {
    spawned.push(`${name} ${String(args[0])}`);
    throw new Error(`the golden replay started a process: ${String(args[0])}`);
  };
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  return { ...real, ...Object.fromEntries(names.map((n) => [n, refuse(n)])) };
});
// Nor the small model of messages (ORC-336): any call to it fails this file.
vi.mock('../../src/adapters/runner/message-classifier.js', () => {
  const never = () => {
    throw new Error('the small model was called by the golden replay');
  };
  return { messageClassifier: never, apiClassifier: never, cliClassifier: never };
});

const set = loadGoldenSet();
const baselinePath = join(import.meta.dirname, 'baseline.json');
const fetched = vi.fn(() => Promise.reject(new Error('the golden replay reached the network')));
let report: GoldenReport;

beforeAll(async () => {
  vi.stubGlobal('fetch', fetched);
  report = await replayGoldenSet(set, fakeGoldenPass());
});
afterAll(() => void vi.unstubAllGlobals());

describe('the golden tickets replayed on fake runners (ORC-236)', () => {
  it('replays each of the 10 golden tickets 3 times and reports every pass', () => {
    expect(report.set).toBe(set.fingerprint);
    expect(report.tickets.map((t) => t.ticket)).toEqual(set.tickets.map((t) => t.ticket));
    expect(report.tickets.map((t) => t.passes.length)).toEqual(Array(10).fill(3));
  });

  it('has no external effect: no model, no process, no network, the PR kept as an artifact of the pass', () => {
    expect(spawned).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    for (const t of report.tickets) {
      for (const p of t.passes) expect(p).toMatchObject({ verdict: 'pr', pr: { title: expect.stringContaining(t.ticket) } });
    }
  });

  it('gives back its baseline: no ticket changed a verdict or the inputs of its runs', () => {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as GoldenReport;
    const changes = compareGoldenReports(baseline, report);
    expect(changes, `${formatGoldenReport(report, changes)}\nIf the change is intended, re-record the baseline: npm run golden:record (docs/tests.md).`).toEqual([]);
  });

  it('shows a changed skill on every golden ticket whose run reads it, verdicts unchanged', async () => {
    const pack = mkdtempSync(join(tmpdir(), 'golden-pack-'));
    try {
      cpSync(packDir, pack, { recursive: true });
      appendFileSync(join(pack, 'skills/dev/SKILL.md'), '\nAlways write the tests last.\n');
      // The engine runs on the changed pack; one pass each is enough to compare what the runs received.
      const changed = await replayGoldenSet({ ...set, passes: 1 }, fakeGoldenPass({ packDir: pack }));
      const changes = compareGoldenReports(report, changed);
      expect(changes.map((c) => c.ticket)).toEqual(set.tickets.map((t) => t.ticket));
      expect(changes.every((c) => c.inputsChanged && c.passes.length === 0)).toBe(true);
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });
});
