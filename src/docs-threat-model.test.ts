import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const doc = readFileSync(join(root, 'docs/threat-model.md'), 'utf8');
const THREATS = ['Compromised agent', 'Trapped repository or dependency', 'Malicious ticket or comment', 'Compromised member account', 'Server access'];

// The rows of each threat's table: `| Attack | Defense | Tests |`, under `## <n>. <threat>`.
const sections = doc.split(/^## /m).slice(1).map((s) => ({ title: s.slice(0, s.indexOf('\n')), body: s }));
const rows = sections.flatMap(({ title, body }) =>
  body.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*(Attack\s*\||-)/.test(l)).map((line) => {
    const [attack = '', defense = '', tests = ''] = line.split('|').slice(1, -1).map((c) => c.trim());
    return { threat: title, attack, defense, tests };
  }),
);

// A cited test: a backticked `*.test.ts` path, then optionally « a fragment of a test title in it ».
const citations = (text: string) => [...text.matchAll(/`([^`]+\.test\.ts)`(?:\s*«\s*([^»]+?)\s*»)?/g)].map((m) => ({ file: m[1]!, title: m[2] }));

// The titles a test file declares: the string opening an `it(` or `test(` call, or the call after `it.each(…)`, escapes
// undone as the doc writes them. Never an `it.todo` nor an `it.skip`, which test nothing, nor a `describe`.
const titlesOf = (file: string) =>
  [...readFileSync(join(root, file), 'utf8').matchAll(/(?:\b(?:it|test)|\))\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]!.replace(/\\(.)/g, '$1'));

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

  it('cites only test files that exist, and titles of tests they declare', () => {
    const missing = citations(doc).filter(({ file, title }) => !existsSync(join(root, file)) || (title !== undefined && !titlesOf(file).some((t) => t.includes(title))));
    expect(missing).toEqual([]);
  });

  it('is linked from the README and from the security page', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('(docs/threat-model.md)');
    expect(readFileSync(join(root, 'docs/interface-and-security.md'), 'utf8')).toContain('(threat-model.md)');
  });
});
