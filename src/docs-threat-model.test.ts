import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const doc = readFileSync(join(root, 'docs/threat-model.md'), 'utf8');
const THREATS = ['Compromised agent', 'Trapped repository or dependency', 'Malicious ticket or comment', 'Compromised member account', 'Server access'];

interface Row { threat: string; attack: string; defense: string; tests: string }

// The rows of each threat's table: `| Attack | Defense | Tests |`, under `## <n>. <threat>`.
const sections = doc.split(/^## /m).slice(1).map((s) => ({ title: s.slice(0, s.indexOf('\n')), body: s }));
const rows: Row[] = sections.flatMap(({ title, body }) =>
  body.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*(Attack\s*\||-)/.test(l)).map((line) => {
    const [attack = '', defense = '', tests = ''] = line.split('|').slice(1, -1).map((c) => c.trim());
    return { threat: title, attack, defense, tests };
  }),
);

// A cited test: a backticked `*.test.ts` path, then optionally « a fragment of a test title in it ».
const citations = (tests: string) => [...tests.matchAll(/`([^`]+\.test\.ts)`(?:\s*«\s*([^»]+?)\s*»)?/g)].map((m) => ({ file: m[1]!, title: m[2] }));

describe('docs/threat-model.md', () => {
  it('covers the five threats, in order, each with rows', () => {
    expect(sections.filter((s) => /^\d+\. /.test(s.title)).map((s) => s.title)).toEqual(THREATS.map((t, i) => `${i + 1}. ${t}`));
    for (const t of THREATS) expect(rows.filter((r) => r.threat.endsWith(t)).length, t).toBeGreaterThan(0);
  });

  it('gives every attack a defense, and a test or an open hole', () => {
    expect(rows.length).toBeGreaterThan(20);
    const bare = rows.filter((r) => !r.attack || !r.defense || (citations(r.tests).length === 0 && !r.defense.includes('**Open**')));
    expect(bare).toEqual([]);
  });

  it('cites only test files that exist, and titles that are in them', () => {
    const missing: string[] = [];
    for (const { file, title } of rows.flatMap((r) => citations(r.tests))) {
      if (!existsSync(join(root, file))) missing.push(file);
      // Titles are matched on the source with its escapes undone, as the doc writes them.
      else if (title && !readFileSync(join(root, file), 'utf8').replace(/\\(['`])/g, '$1').includes(title)) missing.push(`${file} « ${title} »`);
    }
    expect(missing).toEqual([]);
  });

  it('cites the paths of the tests it names in its prose and history too', () => {
    const cited = [...doc.matchAll(/`((?:src|test)\/[^`]+\.test\.ts)`/g)].map((m) => m[1]!);
    expect(cited.filter((f) => !existsSync(join(root, f)))).toEqual([]);
  });

  it('is linked from the README and from the security page', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('(docs/threat-model.md)');
    expect(readFileSync(join(root, 'docs/interface-and-security.md'), 'utf8')).toContain('(threat-model.md)');
  });
});
