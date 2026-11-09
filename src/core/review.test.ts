import { describe, expect, it } from 'vitest';
import type { Finding } from './agent-output.js';
import { blockingFindings, capDiff, contestedInput, DIFF_MAX, findingsInput, inlineComment, onItsLine, reviewBody, reviewVerdict, type ReviewFinding } from './review.js';

const finding = (patch: Partial<ReviewFinding> = {}): ReviewFinding => ({
  file: 'src/auth.ts', line: 12, severity: 'blocking', explanation: 'The token is compared with ==.', suggestion: 'Use timingSafeEqual.', lens: 'security', runId: 'r2', ...patch,
});

describe('capDiff (ORC-183)', () => {
  it('gives the diff as it is under the cap, and never reads the stat', async () => {
    let read = false;
    expect(await capDiff('diff --git a/x b/x', async () => ((read = true), 'stat'))).toBe('diff --git a/x b/x');
    expect(read).toBe(false);
  });

  it('gives the changed files in place of a diff past the cap, saying the files are in the clone', async () => {
    const out = await capDiff('+'.repeat(DIFF_MAX + 1), async () => ' src/a.ts | 2 +-\n 1 file changed');
    expect(out).toContain(' src/a.ts | 2 +-');
    expect(out).toMatch(/more than 60000 characters.*read the changed files in the clone/s);
    expect(out).not.toContain('++++');
    // A reading stopped past the cap: the same.
    expect(await capDiff(undefined, async () => ' src/a.ts | 2 +-')).toMatch(/more than 60000 characters: read the changed files in the clone/);
    // A clone without the changes says so (ORC-182).
    expect(await capDiff(undefined, async () => 'src/a.ts', DIFF_MAX, 'the clone holds none of them')).toMatch(/characters: the clone holds none of them\./);
  });

  it('says when the commit changes nothing against the trunk', async () => {
    expect(await capDiff('', async () => '')).toMatch(/no change/);
  });
});

describe('reviewVerdict (ORC-183)', () => {
  it('fails factory/review on any blocking finding, whichever lens found it', () => {
    expect(reviewVerdict([finding(), finding({ severity: 'minor', lens: 'correctness' })])).toEqual({ conclusion: 'failure', summary: '1 blocking finding, 1 minor, 0 out of scope' });
  });

  it('does not fail on minor or out-of-scope findings alone, nor on none', () => {
    expect(reviewVerdict([finding({ severity: 'minor' }), finding({ severity: 'minor' }), finding({ severity: 'out_of_scope' })])).toEqual({ conclusion: 'success', summary: '0 blocking findings, 2 minor, 1 out of scope' });
    expect(reviewVerdict([])).toEqual({ conclusion: 'success', summary: '0 blocking findings, 0 minor, 0 out of scope' });
  });
});

describe('the texts of the review (ORC-183)', () => {
  it('writes an inline comment from the fields, in the factory\'s words around them', () => {
    expect(inlineComment(finding({ fact: 'F-12' }))).toBe('**Blocking** · security lens\n\nThe token is compared with ==.\n\n**Suggestion**: Use timingSafeEqual.\n\nViolates fact `F-12`.');
    expect(inlineComment(finding({ severity: 'out_of_scope', suggestion: '', lens: 'correctness' }))).toBe('**Out of scope** · correctness lens\n\nThe token is compared with ==.');
  });

  it('heads the review with the verdict; findings not inline are listed in it, with their place', () => {
    const fs: ReviewFinding[] = [finding(), finding({ severity: 'minor', file: 'src/b.ts', line: 3, lens: 'correctness' })];
    const inline = reviewBody('0123456789abcdef', fs, { inline: true });
    expect(inline).toBe('**AI review** of `0123456789ab` (correctness and security lenses): 1 blocking finding, 1 minor, 0 out of scope.\n\nEach blocking or minor finding is a comment on its line.');
    const listed = reviewBody('0123456789abcdef', fs, { inline: false });
    expect(listed).toContain('`src/auth.ts:12`\n**Blocking** · security lens');
    expect(listed).toContain('`src/b.ts:3`\n**Minor** · correctness lens');
  });

  it('lists the out-of-scope findings in the text: their lines are out of the diff, where GitHub places no comment', () => {
    const outOfScope = finding({ severity: 'out_of_scope', file: 'src/old.ts', line: 90, lens: 'correctness' });
    expect(onItsLine(outOfScope)).toBe(false);
    expect(onItsLine(finding())).toBe(true);
    const body = reviewBody('0123456789abcdef', [finding(), outOfScope], { inline: true });
    expect(body).toContain('Each blocking or minor finding is a comment on its line.');
    expect(body).toContain('`src/old.ts:90`\n**Out of scope** · correctness lens');
    expect(body).not.toContain('`src/auth.ts:12`');
  });

  it('keeps a listed review under the cap of a text: the findings shortened, then their places alone', () => {
    const long = Array.from({ length: 12 }, (_, i) => finding({ line: i + 1, explanation: 'x'.repeat(1_900) }));
    const shortened = reviewBody('0123456789abcdef', long, { inline: false });
    expect(shortened.length).toBeLessThanOrEqual(10_000);
    expect(shortened).toContain('`src/auth.ts:12` **Blocking** · security lens: ' + 'x'.repeat(200) + '…');
    const many = Array.from({ length: 100 }, (_, i) => finding({ line: i + 1, explanation: 'x'.repeat(1_900) }));
    const places = reviewBody('0123456789abcdef', many, { inline: false });
    expect(places.length).toBeLessThanOrEqual(10_000);
    expect(places).toContain('`src/auth.ts:100` **Blocking** · security lens');
  });

  it('cuts the changed files given past the cap too', async () => {
    const out = await capDiff(undefined, async () => 'f'.repeat(DIFF_MAX * 2));
    expect(out.length).toBeLessThan(DIFF_MAX + 200);
    expect(out).toContain('more changed files');
  });

  it('says when no finding was made', () => {
    expect(reviewBody('0123456789abcdef', [], { inline: true })).toBe('**AI review** of `0123456789ab` (correctness and security lenses): 0 blocking findings, 0 minor, 0 out of scope.\n\nNo finding.');
  });

  it('takes the findings of the schema unchanged', () => {
    const f: Finding = { file: 'a', line: 1, severity: 'minor', explanation: 'e', suggestion: 's' };
    expect(inlineComment({ ...f, lens: 'correctness', runId: 'r' })).toContain('**Minor**');
  });
});

describe('the inputs of the review loop (ORC-184)', () => {
  const kept: ReviewFinding[] = [
    finding({ lens: 'correctness', file: 'src/export.ts', line: 7, explanation: 'Header written twice.' }),
    finding({ lens: 'correctness', severity: 'minor', line: 3 }),
    finding({ lens: 'correctness', file: 'src/list.ts', line: 9, explanation: 'Off by one.', suggestion: '' }),
    finding(),
  ];

  it('names each blocking finding by its lens and its rank among that lens\'s blocking ones', () => {
    expect(blockingFindings(kept).map((f) => [f.id, f.file])).toEqual([['correctness-1', 'src/export.ts'], ['correctness-2', 'src/list.ts'], ['security-1', 'src/auth.ts']]);
  });

  it('criterion 1: gives the fix each finding under its id, and asks one commit per finding fixed or a contest', () => {
    const text = findingsInput('0123456789abcdef', blockingFindings(kept));
    expect(text).toContain('The AI review of `0123456789ab` left 3 blocking findings.');
    expect(text).toContain('### correctness-1 · `src/export.ts:7`\nHeader written twice.\n**Suggestion**: Use timingSafeEqual.');
    expect(text).toContain('### correctness-2 · `src/list.ts:9`\nOff by one.\n\n');
    expect(text).toContain('in a commit of its own');
    expect(text).toContain('`fixed`, with the commit that fixes it, or in `contested`');
    expect(findingsInput('0123456789abcdef', [])).toMatch(/^No blocking finding is kept/);
  });

  it('criterion 2: gives the next lens the contested findings, still open, with their justification; an unknown id is left out', () => {
    const text = contestedInput(kept, [{ finding: 'security-1', justification: 'The token is hashed first.' }, { finding: 'security-9', justification: 'Gone.' }])!;
    expect(text).toContain('Each one is still open');
    expect(text).toContain('### security-1 · `src/auth.ts:12`\nThe token is compared with ==.\n**Suggestion**: Use timingSafeEqual.\n**Contested by the implementer**: The token is hashed first.');
    expect(text).not.toContain('Gone.');
    expect(contestedInput(kept, [{ finding: 'security-9', justification: 'Gone.' }])).toBeUndefined();
  });
});
