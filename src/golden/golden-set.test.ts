import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { GOLDEN_SET_PATH, GoldenSetError, loadGoldenSet, parseGoldenSet, PILOT_REPOS } from './golden-set.js';

const pilot = readFileSync(GOLDEN_SET_PATH, 'utf8');

/** The pilot file as data, changed by `edit`, its last decision re-signed unless `resign` is false. */
function variant(edit: (doc: Record<string, unknown> & { tickets: Record<string, unknown>[] }) => void, { resign = true } = {}): string {
  const doc = parse(pilot) as Record<string, unknown> & { tickets: Record<string, unknown>[]; decisions: { fingerprint: string }[] };
  edit(doc);
  // Signed with the fingerprint the loader's refusal names, when it gets that far.
  const unsigned = stringify(doc);
  const fingerprint = violations(unsigned).join('\n').match(/with fingerprint ([0-9a-f]{64})/)?.[1];
  if (resign && fingerprint) doc.decisions.at(-1)!.fingerprint = fingerprint;
  return stringify(doc);
}

const violations = (text: string): string[] => {
  try {
    parseGoldenSet(text);
  } catch (err) {
    if (err instanceof GoldenSetError) return err.violations;
    throw err;
  }
  return [];
};

describe('the golden tickets (ORC-236)', () => {
  it('freezes 10 tickets of the pilot repositories, each with its start commit and its risk', () => {
    const set = loadGoldenSet();
    expect(set.tickets).toHaveLength(10);
    expect(new Set(set.tickets.map((t) => t.ticket)).size).toBe(10);
    for (const t of set.tickets) {
      expect(t.startCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(['low', 'medium', 'high']).toContain(t.risk);
    }
    // ORC-137: 5 from each pilot repository, 3 low, 4 medium, 3 high.
    expect(PILOT_REPOS.map((r) => set.tickets.filter((t) => t.repo === r).length)).toEqual([5, 5]);
    expect(['low', 'medium', 'high'].map((r) => set.tickets.filter((t) => t.risk === r).length)).toEqual([3, 4, 3]);
    expect(set.passes).toBe(3);
  });

  it('refuses a set whose tickets changed without a written decision', () => {
    const swapped = variant((doc) => void (doc.tickets[0]!.start_commit = 'a'.repeat(40)), { resign: false });
    expect(violations(swapped)).toEqual([expect.stringMatching(/changed without a written decision.*decisions/)]);
    // The same change with a decision naming the new fingerprint is the set's next version.
    const decided = variant((doc) => {
      doc.tickets[0]!.start_commit = 'a'.repeat(40);
      (doc.decisions as unknown[]).push({ date: '2026-12-01', decision: 'ORC-999', fingerprint: '' });
    });
    expect(violations(decided)).toEqual([]);
  });

  it('keeps the fingerprint of the set whatever the order of the keys or the comments of the file', () => {
    const reordered = variant((doc) => {
      doc.tickets = doc.tickets.map((t) => Object.fromEntries(Object.entries(t).reverse()));
    }, { resign: false });
    expect(parseGoldenSet(reordered).fingerprint).toBe(loadGoldenSet().fingerprint);
  });

  it('refuses a set that is not 10 distinct tickets', () => {
    expect(violations(variant((doc) => void doc.tickets.pop()))).toContainEqual(expect.stringMatching(/10 tickets, not 9/));
    expect(violations(variant((doc) => void (doc.tickets[1]!.ticket = doc.tickets[0]!.ticket)))).toContainEqual(expect.stringMatching(/V3-705 is listed twice/));
  });

  it('refuses a split other than 5 and 5 unless the set says why, and a repository outside the pilot', () => {
    const moved = (doc: { tickets: Record<string, unknown>[] }) => void (doc.tickets[0]!.repo = 'LilianPe/Orchestrator');
    expect(violations(variant(moved))).toContainEqual(expect.stringMatching(/5 tickets from each pilot repository.*shortfall/));
    expect(violations(variant((doc) => {
      moved(doc);
      doc.shortfall = 'intersektion-platform had 4 eligible tickets on 08/11: completed from Orchestrator.';
    }))).toEqual([]);
    expect(violations(variant((doc) => void (doc.tickets[0]!.repo = 'acme/other')))).toContainEqual(expect.stringMatching(/acme\/other is not a pilot repository/));
  });

  it('refuses another risk mix than 3 low, 4 medium, 3 high', () => {
    expect(violations(variant((doc) => void (doc.tickets[0]!.risk = 'high')))).toContainEqual(expect.stringMatching(/risk mix.*3 low, 4 medium, 3 high.*2 low, 4 medium, 4 high/));
  });

  it('refuses a ticket past max_diff outside tests, a commit that is not a full sha, an unknown key', () => {
    expect(violations(variant((doc) => void (doc.tickets[0]!.non_test_lines = 401)))).toContainEqual(expect.stringMatching(/V3-705.*401 lines outside tests.*400/));
    expect(violations(variant((doc) => void (doc.tickets[0]!.start_commit = 'abc123')))).toContainEqual(expect.stringMatching(/start_commit/));
    expect(violations(variant((doc) => void (doc.tickets[0]!.notes = 'easy')))).toContainEqual(expect.stringMatching(/notes/));
  });
});
