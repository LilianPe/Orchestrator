import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ORC-202 AC1: no dead link between README.md and docs/. Every relative link of these pages names a file of the
// repository, and its #anchor, on a Markdown page, a heading of that page as GitHub renders it. No network: links to
// other sites are not followed.
const root = join(import.meta.dirname, '..');

/** README.md and every Markdown page under docs/, as repository paths with `/`. */
function docPages(): string[] {
  const docs = readdirSync(join(root, 'docs'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'));
  return ['README.md', ...docs.sort()];
}

/** A fenced block, ``` or ~~~, up to its closing fence. */
const FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
/** A link's target, `<a b.md>` or `a.md`, then its optional title, "t", 't' or (t). */
const TARGET = String.raw`(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?`;
const INLINE = new RegExp(String.raw`\]\(\s*${TARGET}\s*\)`, 'g');
const REFERENCE = new RegExp(String.raw`^\s*\[[^\]]+\]:\s*${TARGET}\s*$`);

/** The page without its fenced blocks and inline code, which hold no links; lines kept, so a line number stays right. */
function prose(markdown: string): string {
  return markdown
    .replace(FENCE, (block) => block.replace(/[^\n]/g, ''))
    .replace(/(`+)[^`\n][\s\S]*?\1/g, (code) => code.replace(/[^\n]/g, ' '));
}

/** GitHub's anchor of a heading: its text lowercased, punctuation dropped but `-` and `_`, each space a `-`. */
function slug(heading: string): string {
  // Outside inline code, a link keeps its text and an HTML tag goes; inside it, `<project>` is text.
  const text = heading
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')))
    .join('')
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/ /g, '-');
}

/** The anchors of a page: its headings (a repeated one gets `-1`, `-2`…, as GitHub numbers it) and its `id=` / `name=` tags. */
function anchors(markdown: string): Set<string> {
  const found = new Set<string>();
  const seen = new Map<string, number>();
  const text = markdown.replace(FENCE, '');
  for (const [, heading] of text.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const base = slug(heading!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    found.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const [, id] of text.matchAll(/<a\s[^>]*(?:id|name)="([^"]+)"/g)) found.add(id!);
  return found;
}

/** The relative links of a page, inline `[text](target)` and reference `[label]: target`, with their line. */
function links(markdown: string): { line: number; target: string }[] {
  return prose(markdown)
    .split('\n')
    .flatMap((text, i) =>
      [...text.matchAll(INLINE), ...[REFERENCE.exec(text) ?? []]]
        .filter((m) => m.length)
        .map((m) => (m[1] ?? m[2])!)
        // A scheme (https:, mailto:) or `//host` leaves the repository: not followed.
        .filter((target) => !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target))
        .map((target) => ({ line: i + 1, target })),
    );
}

const pageCache = new Map<string, Set<string>>();
const anchorsOf = (path: string): Set<string> => {
  let found = pageCache.get(path);
  if (!found) pageCache.set(path, (found = anchors(readFileSync(join(root, path), 'utf8'))));
  return found;
};

/** Why a link of `page` is dead, or undefined when it resolves. */
function deadLink(page: string, target: string): string | undefined {
  const [rawPath = '', anchor] = target.split('#', 2);
  const path = decodeURIComponent(rawPath);
  // A leading `/` is the repository's root on GitHub, anything else the page's directory.
  const base = path.startsWith('/') ? root : join(root, dirname(page));
  const file = path === '' ? page : relative(root, join(base, path)).split(sep).join('/');
  if (file.startsWith('..')) return `${target}: outside the repository`;
  if (!existsSync(join(root, file))) return `${target}: no file ${file}`;
  if (!anchor || !file.endsWith('.md')) return undefined;
  return anchorsOf(file).has(decodeURIComponent(anchor)) ? undefined : `${target}: no heading #${anchor} in ${file}`;
}

describe('links between README.md and docs/ (ORC-202)', () => {
  it.each(docPages())('every relative link of %s resolves, its #anchor included', (page) => {
    const dead = links(readFileSync(join(root, page), 'utf8')).flatMap(({ line, target }) => {
      const why = deadLink(page, target);
      return why ? [`${page}:${line} ${why}`] : [];
    });
    expect(dead).toEqual([]);
  });

  it('reads headings and links as GitHub does', () => {
    expect(slug('`factory.yml` (ORC-209)')).toBe('factoryyml-orc-209');
    expect(slug('3. Webhooks: production and development')).toBe('3-webhooks-production-and-development');
    expect(slug('Branch protection, required by `factory doctor`')).toBe('branch-protection-required-by-factory-doctor');
    expect(slug('The blocking comment — ORC-196')).toBe('the-blocking-comment--orc-196');
    expect([...anchors('# A\n## A\n```\n# B\n```\n<a id="c"></a>\n')]).toEqual(['a', 'a-1', 'c']);
    const md = "See [x](a.md#b), `[y](no.md)`, [z](https://e.org/a.md), [u](//e.org) and [w](#c).\n```\n[v](no.md)\n```\n[r]: d.md\n[t](<e f.md> 'T') [s](g.md (G))\n";
    expect(links(md)).toEqual([
      { line: 1, target: 'a.md#b' },
      { line: 1, target: '#c' },
      { line: 5, target: 'd.md' },
      { line: 6, target: 'e f.md' },
      { line: 6, target: 'g.md' },
    ]);
  });

  it('finds a dead file and a dead anchor', () => {
    expect(deadLink('docs/first-run.md', 'nowhere.md')).toMatch(/no file docs\/nowhere\.md/);
    expect(deadLink('docs/first-run.md', 'github.md#no-such-heading')).toMatch(/no heading/);
    expect(deadLink('README.md', 'docs/first-run.md#0-what-you-must-create-first')).toBeUndefined();
    expect(deadLink('docs/ports/README.md', '/docs/cli.md')).toBeUndefined();
  });
});
