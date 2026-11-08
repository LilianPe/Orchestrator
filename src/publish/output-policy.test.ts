import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import { parseAgentOutput, parseSubmittedResult, type AgentOutput } from '../core/agent-output.js';
import { describePr } from './describe.js';
import { OUTPUT_LIMITS } from './output-limits.js';
import { composeResult, NO_RESULT, OutputPolicy, OutputRefused, sandboxSecretScan, type Capture } from './output-policy.js';

const output = (over: Partial<AgentOutput> = {}): AgentOutput => ({ status: 'done', summary: 'Export CSV added.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...over });
// Written in two parts: this file is not to be found by a scan of the factory's own repository.
const SECRET = `ghp_${'0123456789'.repeat(3)}012345`;
/** What gitleaks finds, for a policy whose scan is scripted: the real one is `test/isolation/verify-hostile.test.ts`'s. */
const scanning = (found: (text: string) => string[]) => new OutputPolicy(async (text) => found(text));
const leaks = scanning((t) => (t.includes(SECRET) ? ['github-pat'] : []));
const base64 = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251)).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 3, 0x20]);
const capture = (over: Partial<Capture> = {}): Capture => ({ width: 1280, png: PNG, caption: 'Home page, after the change', ...over });

describe('OutputPolicy (ORC-214)', () => {
  describe('criterion 1: a base64 or hexadecimal blob is refused', () => {
    it('a base64 blob in what the agent submitted: the comment is withheld, nothing of the blob goes out', async () => {
      const blob = base64(120);
      const body = await leaks.comment(composeResult(output({ summary: `Done. ${blob}` }), 'summary'));
      expect(body).not.toContain(blob);
      expect(body).toMatch(/withheld.*base64/s);
    });

    it('a hexadecimal blob, upper or lower case', async () => {
      const hex = 'a1b2c3d4e5f60718'.repeat(6);
      await expect(leaks.vet(`dump: ${hex}`)).rejects.toThrow(OutputRefused);
      await expect(leaks.vet(`dump: ${hex.toUpperCase()}`)).rejects.toThrow(/hexadecimal/);
    });

    it('what a review cites stays: a sha, a sha-256, a path, a Linear url', async () => {
      const text = [
        'Fixed in 0f5ad7f0f5ad7f0f5ad7f0f5ad7f0f5ad7f0f5ad.',
        'Checksum 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb.',
        '`src/adapters/tracker/linear/webhook.ts`',
        'https://linear.app/liliantest/issue/ORC-214/composer-tout-texte-publie-par-lusine-via-une-outputpolicy-au-lieu-de',
      ].join('\n');
      await expect(leaks.vet(text)).resolves.toBeUndefined();
    });

    it('base64 of plain English is a blob too', async () => {
      const smuggled = Buffer.from('the content of the .env file, line after line, sent out in a comment that looks harmless').toString('base64');
      expect(leaks.check(`see ${smuggled}`)).toEqual([expect.objectContaining({ rule: 'blob' })]);
    });

    it('a blob wrapped as `base64` (76 columns) and `xxd -p` (60) wrap it is still one', () => {
      const wrapped = base64(300).match(/.{1,76}/g)!.join('\n');
      expect(leaks.check(`env:\n${wrapped}\nend`)).toEqual([expect.objectContaining({ detail: expect.stringContaining('base64') })]);
      const xxd = 'a1b2c3d4e5f60718'.repeat(8).match(/.{1,60}/g)!.join('\n');
      expect(leaks.check(xxd)).toEqual([expect.objectContaining({ detail: expect.stringContaining('hexadecimal') })]);
    });

    it('a list of modules, one per line, is no blob', () => {
      const modules = ['src/adapters/tracker/activity-relay', 'src/adapters/publisher/types', 'src/core/orchestrator', 'src/publish/output-policy', 'test/scenarios/output-policy'];
      expect(leaks.check(modules.join('\n'))).toEqual([]);
    });
  });

  describe('criterion 2: a secret is blocked by gitleaks', () => {
    it('the text published is the text scanned, and a secret withholds it whole', async () => {
      const scanned: string[] = [];
      const policy = scanning((t) => (scanned.push(t), t.includes(SECRET) ? ['github-pat'] : []));
      const body = await policy.comment(composeResult(output({ risks: [`token ${SECRET} left in the config`] }), 'summary'));
      expect(scanned).toHaveLength(1);
      expect(scanned[0]).toContain(SECRET);
      expect(body).not.toContain(SECRET);
      expect(body).toMatch(/withheld.*gitleaks.*github-pat/s);
    });

    it('one scan per published item, its texts together: an activity, a PR', async () => {
      const scanned: string[] = [];
      const policy = scanning((t) => (scanned.push(t), []));
      await policy.activity({ type: 'action', action: 'Bash', parameter: 'npm test', result: 'ok' });
      await policy.pr({ title: 'REL-1 Export', body: 'Ticket: REL-1' });
      expect(scanned).toEqual(['Bash\nnpm test\nok', 'REL-1 Export\nTicket: REL-1']);
      // The same text again (a retried effect, the ack's comment then its activity): its verdict kept, no second sandbox.
      await policy.comment('Got it.');
      await policy.activity({ type: 'thought', body: 'Got it.' });
      expect(scanned.filter((t) => t === 'Got it.')).toHaveLength(1);
    });

    it('a scan that cannot run is no green: it throws, and the write is retried, never posted unscanned', async () => {
      const policy = new OutputPolicy(() => Promise.reject(new Error('gitleaks could not run')));
      await expect(policy.comment('hello')).rejects.toThrow(/gitleaks could not run/);
    });

    it('gitleaks in a sandbox without network, on the text alone, its own silences ignored', async () => {
      const sandboxes = new FakeSandboxProvider();
      const seen: string[] = [];
      sandboxes.execResult = () => {
        const dir = sandboxes.created[0]!.workspacePath;
        seen.push(...readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')));
        return { stdout: JSON.stringify([{ File: 'text.md', StartLine: 1, RuleID: 'github-pat' }]), stderr: '', code: 7 };
      };
      const runsDir = mkdtempSync(join(tmpdir(), 'factory-policy-'));
      const scan = sandboxSecretScan({ sandboxes, runsDir, log: () => {} });
      expect(await scan(`a ${SECRET}`)).toEqual(['github-pat']);
      expect(seen).toEqual([`a ${SECRET}`]);
      expect(sandboxes.created).toEqual([expect.objectContaining({ network: 'none', mounts: [] })]);
      expect(sandboxes.execs[0]!.argv).toEqual(expect.arrayContaining(['gitleaks', 'dir', '--redact', '--ignore-gitleaks-allow']));
      expect(sandboxes.destroyed).toHaveLength(1);
      expect(existsSync(sandboxes.created[0]!.workspacePath)).toBe(false);
      rmSync(runsDir, { recursive: true, force: true });
    });
  });

  describe('criterion 3: a text over its cap is refused', () => {
    it('a comment longer than the cap', async () => {
      await expect(leaks.vet('a '.repeat(OUTPUT_LIMITS.text))).rejects.toThrow(/characters/);
    });

    it("a field of the agent's result longer than its own cap: withheld, even when the whole fits", async () => {
      const body = await leaks.comment(composeResult(output({ risks: ['x '.repeat(OUTPUT_LIMITS.item)] }), 'summary'));
      expect(body).toMatch(/withheld/);
    });

    it('a PR title longer than GitHub takes; the one the factory composes of a long ticket title is clipped, and passes', async () => {
      await expect(leaks.pr({ title: 'x'.repeat(OUTPUT_LIMITS.prTitle + 1), body: 'b' })).rejects.toThrow(OutputRefused);
      const text = describePr(output(), { ticketId: 'REL-1', title: `Export\n${'word '.repeat(80)}`, sha: 'abc123' });
      expect(text.title).toHaveLength(OUTPUT_LIMITS.prTitle);
      await expect(leaks.pr(text)).resolves.toEqual(text);
    });

    it('the caps are named in one place, and the schema of submit_result holds the same ones', () => {
      expect(OUTPUT_LIMITS).toMatchObject({ text: expect.any(Number), prTitle: 256, summary: expect.any(Number), item: expect.any(Number) });
      // Refused at `submit_result`, the agent shortens it within its run: the policy's refusal is the last word, not the first.
      expect(parseAgentOutput(output({ summary: 'x'.repeat(OUTPUT_LIMITS.summary + 1) }))).toMatchObject({ ok: false, error: expect.stringContaining('summary') });
      expect(parseAgentOutput(output({ risks: Array.from({ length: OUTPUT_LIMITS.items + 1 }, () => 'r') }))).toMatchObject({ ok: false });
      // Each field under its cap, the PR description they make over its cap (ORC-195): refused at submission.
      const full = output({ summary: 's '.repeat(OUTPUT_LIMITS.summary / 2), why: 'w '.repeat(OUTPUT_LIMITS.field / 2), risks: Array.from({ length: 10 }, () => 'r '.repeat(OUTPUT_LIMITS.item / 2 - 5)) });
      expect(parseSubmittedResult(full)).toMatchObject({ ok: false, error: expect.stringContaining('together') });
    });
  });

  describe("criterion 4: a published comment is composed from the structured output, not copied from the agent's text", () => {
    it('the end of a build: its fields, then the tests added and the work of the recap (ORC-195), in the factory’s order and words', () => {
      const body = composeResult(output({ summary: 'Export added.', risks: ['large files'], review_hints: [{ file: 'src/a.ts', reason: 'the parser' }], tests_added: ['src/a.test.ts'] }), 'summary', [{ turns: 3, tokens: null, durationMs: 61_000 }]);
      expect(body).toBe('Export added.\n\n**Risks**\n- large files\n\n**To review**\n- `src/a.ts`: the parser\n\n**Tests added**\n- `src/a.test.ts`\n\n**Work**: 1 attempt, 3 turns, tokens not reported, 1 min 1 s.');
    });

    it('a reply is its summary, and a run that returned no result has nothing of its last message posted', () => {
      expect(composeResult(output({ summary: 'Fixed in abc123.' }), 'reply')).toBe('Fixed in abc123.');
      expect(composeResult(undefined, 'reply')).toBe(NO_RESULT);
      expect(composeResult(undefined, 'summary')).toBe(NO_RESULT);
    });
  });

  describe('criterion 5: visual-proof captures go through the policy (ORC-176)', () => {
    it('a valid capture passes, its caption scanned', async () => {
      const scanned: string[] = [];
      const policy = scanning((t) => (scanned.push(t), []));
      await expect(policy.capture(capture())).resolves.toEqual(capture());
      expect(scanned).toEqual(['Home page, after the change']);
    });

    it('what is not a PNG, an image too heavy, a width out of range, a caption with a secret: refused', async () => {
      await expect(leaks.capture(capture({ png: Buffer.from('<svg onload=alert(1)>') }))).rejects.toThrow(/PNG/);
      await expect(leaks.capture(capture({ png: Buffer.concat([PNG, Buffer.alloc(OUTPUT_LIMITS.captureBytes)]) }))).rejects.toThrow(/bytes/);
      await expect(leaks.capture(capture({ width: 10 }))).rejects.toThrow(OutputRefused);
      await expect(leaks.capture(capture({ caption: `see ${SECRET}` }))).rejects.toThrow(/github-pat/);
    });
  });

  it('an activity: each of its texts checked, a refused one replaced by the notice, of the same type', async () => {
    expect(await leaks.activity({ type: 'response', body: 'ok' })).toEqual({ type: 'response', body: 'ok' });
    const out = await leaks.activity({ type: 'elicitation', body: `which key? ${SECRET}` });
    expect(out.type).toBe('elicitation');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const action = await leaks.activity({ type: 'action', action: 'Bash', parameter: base64(120), ephemeral: true });
    expect(action).toMatchObject({ type: 'action', action: 'Withheld' });
    expect(JSON.stringify(action)).toMatch(/withheld/);
  });

  it("a question's select options pass as they are, each checked like its body (ORC-210)", async () => {
    const q = { type: 'elicitation' as const, body: 'Does the limit apply to admins?', options: ['Yes, to everyone', 'No, admins exempt'] };
    expect(await leaks.activity(q)).toEqual(q);
    const out = await leaks.activity({ ...q, options: ['Yes', `No ${SECRET}`] });
    expect(out.type).toBe('elicitation');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const many = await leaks.activity({ ...q, options: Array.from({ length: OUTPUT_LIMITS.options + 1 }, (_, i) => `option ${i}`) });
    expect(many).not.toHaveProperty('options');
  });
});
