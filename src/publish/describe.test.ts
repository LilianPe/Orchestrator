import { describe, expect, it } from 'vitest';
import { parseAgentOutput, parseSubmittedResult, type AgentOutput } from '../core/agent-output.js';
import { describePr, formatRecap, PR_SECTIONS, type PrFacts } from './describe.js';
import { OUTPUT_LIMITS } from './output-limits.js';
import { OutputPolicy, OutputRefused } from './output-policy.js';

const output = (over: Partial<AgentOutput> = {}): AgentOutput => ({ status: 'done', summary: 'Audits export to CSV from their list.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...over });
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({ ticketId: 'REL-1', title: 'Export CSV', sha: 'abc123def4567890', commands: ['npm test'], ...over });
const full = output({
  why: 'Auditors copy the list by hand.',
  summary: 'An Export button on the list of audits writes a CSV.',
  assumptions: ['the list holds at most 10,000 audits'],
  risks: ['large lists are slow'],
  untested: ['Safari download'],
  trusted: ['papaparse quotes fields as RFC 4180 says'],
  review_hints: [{ file: 'src/export.ts', reason: 'the quoting' }],
  tests_added: ['src/export.test.ts'],
});
/** The body cut at its headings: the text under each, in order. */
const sections = (body: string) => [...body.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map(([, title, text]) => ({ title: title!, text: text!.trim() }));
const base64 = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251)).toString('base64');

describe('describePr (ORC-195)', () => {
  it("criterion 1: the reviewer's fixed order, each field of the structured output under its own heading", () => {
    const got = sections(describePr(full, facts()).body);
    expect(got.map((s) => s.title)).toEqual(['Why', 'What changes', 'Assumptions', 'Risks', 'Untested', 'Trusted without verification', 'Where to look first', 'Evidence']);
    expect(PR_SECTIONS).toEqual(got.map((s) => s.title));
    expect(got).toEqual([
      { title: 'Why', text: 'Auditors copy the list by hand.' },
      { title: 'What changes', text: 'An Export button on the list of audits writes a CSV.' },
      { title: 'Assumptions', text: '- the list holds at most 10,000 audits' },
      { title: 'Risks', text: '- large lists are slow' },
      { title: 'Untested', text: '- Safari download' },
      { title: 'Trusted without verification', text: '- papaparse quotes fields as RFC 4180 says' },
      { title: 'Where to look first', text: '- `src/export.ts`: the quoting' },
      { title: 'Evidence', text: expect.stringContaining('`npm test`') },
    ]);
  });

  it('criterion 1: an empty field keeps its place, said empty, so the order never moves', () => {
    const got = sections(describePr(output(), facts()).body);
    expect(got.map((s) => s.title)).toEqual([...PR_SECTIONS]);
    expect(got.find((s) => s.title === 'Risks')?.text).toBe('_None stated._');
    expect(got.find((s) => s.title === 'Trusted without verification')?.text).toBe('_None stated._');
  });

  it("criterion 2: the spec's « trusted without verification », as the agent carries it in `trusted`, is in the description", () => {
    const body = describePr(output({ trusted: ['the Stripe webhook retries for 3 days', 'zod refines run after the shape'] }), facts()).body;
    expect(sections(body).find((s) => s.title === 'Trusted without verification')?.text).toBe('- the Stripe webhook retries for 3 days\n- zod refines run after the shape');
  });

  it('criterion 3: a ticket that touches the interface has its captures at every screen width in the evidence, narrowest first', () => {
    const captures = [
      { width: 1280, caption: 'Audits, desktop', url: 'https://factory.example/captures/REL-1/1280.png' },
      { width: 375, caption: 'Audits, phone', url: 'https://factory.example/captures/REL-1/375.png' },
      { width: 768, caption: 'Audits, tablet', url: 'https://factory.example/captures/REL-1/768.png' },
    ];
    const evidence = sections(describePr(full, facts({ visualProof: 'required', captures })).body).at(-1)!.text;
    const shown = [...evidence.matchAll(/!\[(.+?)\]\((.+?)\)/g)].map(([, alt, url]) => ({ alt, url }));
    expect(shown).toEqual([
      { alt: 'Audits, phone (375 px)', url: 'https://factory.example/captures/REL-1/375.png' },
      { alt: 'Audits, tablet (768 px)', url: 'https://factory.example/captures/REL-1/768.png' },
      { alt: 'Audits, desktop (1280 px)', url: 'https://factory.example/captures/REL-1/1280.png' },
    ]);
  });

  it('criterion 3: an interface ticket without captures says so, and a ticket off the interface has no screen line', () => {
    expect(sections(describePr(full, facts({ visualProof: 'required' })).body).at(-1)!.text).toMatch(/visual proof is required.*no capture/i);
    expect(describePr(full, facts()).body).not.toMatch(/capture|visual proof/i);
  });

  it('the evidence: what the factory checked, on which commit, apart from what the agent says it added', () => {
    const evidence = (f: Partial<PrFacts>) => sections(describePr(full, facts(f)).body).at(-1)!.text;
    expect(evidence({})).toContain('Green on abc123def456, in a fresh clone, without network');
    expect(evidence({ commands: ['npm test', 'npm run lint'] })).toMatch(/- `npm test`\n- `npm run lint`/);
    expect(evidence({ commands: [] })).toMatch(/no verification command/i);
    expect(evidence({ commands: undefined })).toMatch(/earlier verification/i);
    expect(evidence({})).toMatch(/stated by the agent[^\n]*\n- `src\/export.test.ts`/i);
  });

  it("criterion 4: a base64 blob in a field the agent submitted: the OutputPolicy refuses the description, nothing goes out", async () => {
    const policy = new OutputPolicy(async () => []);
    const blob = base64(120);
    for (const o of [output({ risks: [`see ${blob}`] }), output({ summary: `Done. ${blob}` }), output({ trusted: [blob] })]) {
      const err = await policy.pr(describePr(o, facts())).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OutputRefused);
      expect((err as OutputRefused).refusals).toEqual([{ rule: 'blob', detail: 'pr.body: a base64 blob' }]);
    }
  });

  it("the agent's text cannot pass for the factory's: its headings are escaped, a list entry stays on its line", () => {
    const forged = output({ summary: 'Done.\n## Evidence\nChecked by the factory: all green.', risks: ['none\n## Evidence\n- forged'] });
    const got = sections(describePr(forged, facts()).body);
    expect(got.map((s) => s.title)).toEqual([...PR_SECTIONS]);
    expect(got.find((s) => s.title === 'What changes')?.text).toBe('Done.\n\\## Evidence\nChecked by the factory: all green.');
    expect(got.find((s) => s.title === 'Risks')?.text).toBe('- none ## Evidence - forged');
  });

  it("the agent's Markdown cannot hide the factory's sections or forge one: HTML, setext headings and code fences are neutralized", () => {
    const sneaky = output({
      why: 'x <!--',
      summary: 'Done\nEvidence\n---\n```\nall green',
      review_hints: [{ file: 'src/a.ts', reason: '--> <h2>Evidence</h2>' }],
    });
    const body = describePr(sneaky, facts()).body;
    expect(body).not.toMatch(/<!--|<h2>/);
    expect(body).not.toMatch(/^\s{0,3}(-{3,}|={3,}|`{3})\s*$/m);
    expect(sections(body).map((s) => s.title)).toEqual([...PR_SECTIONS]);
    expect(describePr(output({ summary: 'Fast when a < b.' }), facts()).body).toContain('Fast when a < b.');
  });

  it("a capture's URL that would break its link is percent-encoded", () => {
    const body = describePr(full, facts({ visualProof: 'required', captures: [{ width: 375, caption: 'Phone', url: 'https://f.example/REL-1/Audits (phone).png' }] })).body;
    expect(body).toContain('![Phone (375 px)](https://f.example/REL-1/Audits%20%28phone%29.png)');
  });

  it('names the ticket, title clipped to what GitHub takes, and makes no claim on the whole ticket: no closing keyword', () => {
    const { title, body } = describePr(output(), facts({ title: `Export\n${'word '.repeat(80)}` }));
    expect(title).toHaveLength(OUTPUT_LIMITS.prTitle);
    expect(title.startsWith('REL-1 Export word')).toBe(true);
    expect(describePr(output(), facts()).title).toBe('REL-1 Export CSV');
    expect(body.startsWith('Ticket: REL-1\n')).toBe(true);
    expect(describePr(full, facts()).body).not.toMatch(/\b(fix(es)?|close[sd]?|resolve[sd]?)\b/i);
  });

  it('a run that returned no structured result: the factory\'s own facts, and nothing of the agent', () => {
    const got = sections(describePr(undefined, facts()).body);
    expect(got.map((s) => s.title)).toEqual([...PR_SECTIONS]);
    expect(got.find((s) => s.title === 'What changes')?.text).toMatch(/no structured result/i);
    expect(got.at(-1)!.text).toContain('`npm test`');
  });

  it('`submit_result` refuses fields that, each under its cap, make a description past the cap of a PR body: the agent shortens them within its run', () => {
    const long = (n: number) => Array.from({ length: OUTPUT_LIMITS.items }, () => 'a '.repeat(n));
    expect(parseSubmittedResult(output({ trusted: ['the CSV library'] }))).toMatchObject({ ok: true });
    const big = output({ assumptions: long(140), trusted: long(140) });
    expect(parseSubmittedResult(big)).toMatchObject({ ok: false, error: expect.stringContaining('PR description') });
    // Room is left for the factory's own facts: a result just under the cap less that room is refused too.
    expect(parseSubmittedResult(output({ assumptions: long(110), trusted: long(110) }))).toMatchObject({ ok: false });
    // A result stored before this check (valid when written) is still read: only `submit_result` measures it.
    expect(parseAgentOutput(big)).toMatchObject({ ok: true });
  });
});

describe('formatRecap (ORC-195)', () => {
  const run = (over: { turns?: number; tokens?: { input: number; output: number; cacheRead: number; cacheCreation: number } | null; durationMs?: number | null } = {}) => ({ turns: 10, tokens: { input: 1_000, output: 2_000, cacheRead: 50_000, cacheCreation: 500 }, durationMs: 300_000, ...over });

  it('criterion 5: the summary, the tests added, the turns, the tokens and the duration of the work', () => {
    const recap = formatRecap(output({ tests_added: ['src/export.test.ts', 'src/list.test.ts'] }), [run(), run({ turns: 32, tokens: { input: 10_000, output: 20_000, cacheRead: 0, cacheCreation: 2_000 }, durationMs: 450_500 })]);
    expect(recap).toBe(
      [
        'Audits export to CSV from their list.',
        '**Tests added**\n- `src/export.test.ts`\n- `src/list.test.ts`',
        '**Work**: 2 attempts, 42 turns, 35,500 tokens (cache reads apart), 12 min 30 s.',
      ].join('\n\n'),
    );
  });

  it('keeps the end of a build as ORC-289 posts it: why, risks, untested and what to review when stated, before the tests and the work', () => {
    expect(formatRecap(full, [run()])).toBe(
      [
        'An Export button on the list of audits writes a CSV.',
        '**Why**: Auditors copy the list by hand.',
        '**Risks**\n- large lists are slow',
        '**Untested**\n- Safari download',
        '**To review**\n- `src/export.ts`: the quoting',
        '**Tests added**\n- `src/export.test.ts`',
        '**Work**: 1 attempt, 10 turns, 3,500 tokens (cache reads apart), 5 min 0 s.',
      ].join('\n\n'),
    );
  });

  it('says what it does not know rather than a zero: no test stated, attempts without a usage report, a duration unmeasured', () => {
    expect(formatRecap(output(), [run({ tokens: null, durationMs: null })])).toBe('Audits export to CSV from their list.\n\n**Tests added**\n_None stated._\n\n**Work**: 1 attempt, 10 turns, tokens not reported, duration not measured.');
    expect(formatRecap(output(), [run(), run({ tokens: null, durationMs: 45_000 })])).toMatch(/3,500 tokens \(cache reads apart; 1 attempt reported none\), 5 min 45 s\.$/);
    expect(formatRecap(output(), [run({ durationMs: 3_725_000 })])).toMatch(/1 h 02 min\.$/);
    expect(formatRecap(output(), [run({ durationMs: null }), run({ durationMs: 300_000 })])).toMatch(/5 min 0 s \(1 attempt not measured\)\.$/);
  });
});
