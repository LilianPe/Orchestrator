import { describe, expect, it } from 'vitest';
import { loadGoldenSet, type GoldenTicket } from './golden-set.js';
import { compareGoldenReports, formatGoldenReport, replayGoldenSet, type GoldenPass, type GoldenReport } from './replay.js';

const set = loadGoldenSet();
const pass = (verdict: GoldenPass['verdict'], inputs = 'in-1'): GoldenPass => ({ verdict, inputs });

/** A report where every pass opened its PR, but the passes `changed` gives. */
function report(changed: Record<string, GoldenPass['verdict'][]> = {}, inputs = 'in-1'): GoldenReport {
  return {
    set: set.fingerprint,
    passes: 3,
    tickets: set.tickets.map((t) => ({ ticket: t.ticket, risk: t.risk, passes: (changed[t.ticket] ?? ['pr', 'pr', 'pr']).map((v) => pass(v, inputs)) })),
  };
}

describe('the golden replay (ORC-236)', () => {
  it('replays each golden ticket as many times as the set says, one pass after the other, and reports every pass', async () => {
    const calls: string[] = [];
    let running = 0;
    const out = await replayGoldenSet(set, async (t: GoldenTicket, n: number) => {
      expect(running++).toBe(0);
      calls.push(`${t.ticket}#${n}`);
      await Promise.resolve();
      running--;
      return pass(t.ticket === 'ORC-277' && n === 2 ? 'blocked' : 'pr');
    });
    expect(calls).toHaveLength(30);
    expect(calls.slice(0, 3)).toEqual(['V3-705#1', 'V3-705#2', 'V3-705#3']);
    expect(out.set).toBe(set.fingerprint);
    expect(out.tickets.map((t) => t.passes.length)).toEqual(Array(10).fill(3));
    expect(out.tickets.find((t) => t.ticket === 'ORC-277')!.passes.map((p) => p.verdict)).toEqual(['pr', 'blocked', 'pr']);
  });

  it('lists the tickets of which at least one pass changed its verdict, even when the total does not move', () => {
    // One ticket loses a PR on its second pass, another gains one on its third: 28 PRs before and after.
    const before = report({ 'V3-582': ['pr', 'pr', 'pr'], 'ORC-305': ['pr', 'pr', 'blocked'], 'ORC-145': ['pr', 'blocked', 'pr'] });
    const after = report({ 'V3-582': ['pr', 'blocked', 'pr'], 'ORC-305': ['pr', 'pr', 'pr'], 'ORC-145': ['pr', 'blocked', 'pr'] });
    const count = (r: GoldenReport) => r.tickets.flatMap((t) => t.passes).filter((p) => p.verdict === 'pr').length;
    expect(count(after)).toBe(count(before));
    expect(compareGoldenReports(before, after)).toEqual([
      { ticket: 'V3-582', passes: [{ pass: 2, before: 'pr', after: 'blocked' }], inputsChanged: false },
      { ticket: 'ORC-305', passes: [{ pass: 3, before: 'blocked', after: 'pr' }], inputsChanged: false },
    ]);
  });

  it('lists the tickets whose run received other inputs, a prompt, a skill or a preset changed, verdict unchanged', () => {
    expect(compareGoldenReports(report(), report({}, 'in-2')).map((c) => [c.ticket, c.inputsChanged, c.passes])).toEqual(
      set.tickets.map((t) => [t.ticket, true, []]),
    );
  });

  it('lists the passes and the tickets the replay no longer has', () => {
    const after = report();
    after.tickets[0]!.passes.pop();
    after.tickets.pop();
    expect(compareGoldenReports(report(), after)).toEqual([
      { ticket: 'V3-705', passes: [{ pass: 3, before: 'pr', after: undefined }], inputsChanged: true },
      { ticket: 'ORC-341', passes: [1, 2, 3].map((n) => ({ pass: n, before: 'pr', after: undefined })), inputsChanged: true },
    ]);
  });

  it('compares nothing with a baseline of another set: every ticket is new', () => {
    const before = { ...report(), set: 'another' };
    expect(compareGoldenReports(before, report())).toHaveLength(10);
    expect(compareGoldenReports(before, report())[0]).toEqual({
      ticket: 'V3-705', inputsChanged: true,
      passes: [1, 2, 3].map((n) => ({ pass: n, before: undefined, after: 'pr' })),
    });
  });

  it('writes the report ticket by ticket, each pass, then the changed tickets', () => {
    const after = report({ 'V3-582': ['pr', 'blocked', 'pr'] });
    const text = formatGoldenReport(after, compareGoldenReports(report(), after));
    expect(text).toContain('| V3-582 | medium | pr | blocked | pr |');
    expect(text).toContain('| ORC-341 | high | pr | pr | pr |');
    expect(text).toMatch(/Changed since the baseline: 1 ticket\n\n- V3-582: pass 2 pr → blocked/);
    expect(formatGoldenReport(report(), [])).toMatch(/Changed since the baseline: none/);
  });
});
