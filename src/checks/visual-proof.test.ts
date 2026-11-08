import { describe, expect, it } from 'vitest';
import { fakePng } from '../adapters/browser/fake.js';
import type { Shots } from '../adapters/browser/types.js';
import { agentOutputSchema } from '../core/agent-output.js';
import { OutputPolicy } from '../publish/output-policy.js';
import { decideVisualProof, judgeShots, scenarioPath, VISUAL_PROOF_CHECK } from './visual-proof.js';

const VISUAL = ['src/components/**', 'app/**'];
const shots = (label: string, widths = [1280, 768, 375]): Shots => ({ started: true, pages: widths.map((width) => ({ width, png: fakePng(`${label}@${width}`), consoleErrors: [] })) });
const SHAS = { before: 'b'.repeat(40), after: 'a'.repeat(40) };
const gate = (c: Parameters<OutputPolicy['capture']>[0]) => new OutputPolicy().capture(c);

describe('the decision of the visual proof, on the real diff (ORC-176)', () => {
  it('criterion 1: a diff in visual_paths makes it required, with the paths that trigger it', () => {
    expect(decideVisualProof({ intake: false, changed: ['src/components/Button.tsx', 'README.md', 'app/page.tsx'], visualPaths: VISUAL })).toEqual({
      decision: 'required',
      triggers: ['src/components/Button.tsx', 'app/page.tsx'],
    });
  });

  it('criterion 2: a diff outside visual_paths needs none', () => {
    expect(decideVisualProof({ intake: false, changed: ['src/api/export.ts'], visualPaths: VISUAL })).toEqual({ decision: 'not_applicable', triggers: [] });
    expect(decideVisualProof({ intake: false, changed: ['app/page.tsx'], visualPaths: [] })).toEqual({ decision: 'not_applicable', triggers: [] });
  });

  it('intake can only harden: a ticket that asked for it needs it whatever the diff touches', () => {
    expect(decideVisualProof({ intake: true, changed: ['src/api/export.ts'], visualPaths: VISUAL })).toEqual({ decision: 'required', triggers: [], intake: true });
  });

  it("criterion 4: a model's not_applicable has no way in: the decision reads only the intake, the diff and visual_paths", () => {
    const fromModel = { intake: true, changed: ['app/page.tsx'], visualPaths: VISUAL, visual_proof: 'not_applicable', decision: 'not_applicable' };
    expect(decideVisualProof(fromModel).decision).toBe('required');
  });

  it('criterion 4: submit_result has no field to ask for not_applicable: a result that tries is refused', () => {
    const done = { status: 'done', summary: 'Done.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] };
    expect(agentOutputSchema.safeParse(done).success).toBe(true);
    expect(agentOutputSchema.safeParse({ ...done, visual_proof: 'not_applicable' }).success).toBe(false);
  });
});

describe('the controls on the captures (ORC-176)', () => {
  it('criterion 1: six captures kept, before on the base and after on the commit, at the three widths, by their hash', async () => {
    const r = await judgeShots({ before: shots('base'), after: shots('head') }, SHAS, gate);
    expect(r.failures).toEqual([]);
    expect(r.files.map((f) => [f.capture.side, f.capture.sha, f.capture.width])).toEqual([
      ['before', SHAS.before, 1280], ['before', SHAS.before, 768], ['before', SHAS.before, 375],
      ['after', SHAS.after, 1280], ['after', SHAS.after, 768], ['after', SHAS.after, 375],
    ]);
    expect(r.files.every((f) => /^[0-9a-f]{64}$/.test(f.capture.sha256))).toBe(true);
  });

  it('criterion 3: before and after identical at every width fail the check, which goes back to build', async () => {
    const r = await judgeShots({ before: shots('same'), after: shots('same') }, SHAS, gate);
    expect(r.failures).toEqual([{ command: VISUAL_PROOF_CHECK, exitCode: 1, output: expect.stringContaining('identical') }]);
    expect(r.files).toEqual([]);
  });

  it('a change seen at one width only is a change', async () => {
    const after: Shots = { started: true, pages: [{ width: 1280, png: fakePng('same@1280'), consoleErrors: [] }, { width: 375, png: fakePng('new@375'), consoleErrors: [] }] };
    expect((await judgeShots({ before: shots('same', [1280, 375]), after }, SHAS, gate)).failures).toEqual([]);
  });

  it('criterion 3: an application that does not start on the commit fails the check', async () => {
    const r = await judgeShots({ before: shots('base'), after: { started: false, detail: 'Error: Cannot find module next' } }, SHAS, gate);
    expect(r.failures).toEqual([{ command: VISUAL_PROOF_CHECK, exitCode: 1, output: expect.stringMatching(/did not start[\s\S]*Cannot find module next/) }]);
  });

  it('a blocking console error on the page after fails the check', async () => {
    const after: Shots = { started: true, pages: [{ width: 1280, png: fakePng('x'), consoleErrors: ['TypeError: x is undefined'] }] };
    const r = await judgeShots({ before: shots('base', [1280]), after }, SHAS, gate);
    expect(r.failures).toEqual([{ command: VISUAL_PROOF_CHECK, exitCode: 1, output: expect.stringContaining('TypeError: x is undefined') }]);
  });

  it("a capture the output policy refuses (not a PNG) fails the commit's check, never kept", async () => {
    const after: Shots = { started: true, pages: [{ width: 1280, png: new TextEncoder().encode('<svg/>'), consoleErrors: [] }] };
    const r = await judgeShots({ before: shots('base', [1280]), after }, SHAS, gate);
    expect(r.failures).toEqual([{ command: VISUAL_PROOF_CHECK, exitCode: 1, output: expect.stringContaining('not a PNG') }]);
    expect(r.files).toEqual([]);
  });

  it("a base that does not start is no fault of the branch: the proof is unavailable, and nothing fails", async () => {
    const r = await judgeShots({ before: { started: false, detail: 'port in use' }, after: shots('head') }, SHAS, gate);
    expect(r).toEqual({ failures: [], unavailable: expect.stringContaining('port in use'), files: [] });
  });
});

describe("the page shot, from the agent's visual_scenario (ORC-176)", () => {
  it('a path of the app is kept; anything else, another host included, falls back to the root', () => {
    expect(scenarioPath('/settings?tab=2')).toBe('/settings?tab=2');
    expect(scenarioPath(undefined)).toBe('/');
    for (const url of ['https://evil.example/x', '//evil.example/x', 'settings', '/\\evil.example', '/a b']) expect(scenarioPath(url)).toBe('/');
  });
});
