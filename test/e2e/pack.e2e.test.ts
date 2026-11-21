import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../../src/adapters/runner/claude-code.js';
import { ON_HOST, OnHostSandboxes } from '../helpers/on-host-sandboxes.js';

const pack = join(import.meta.dirname, '../../packs/standard');

describe.skipIf(process.env['FACTORY_E2E'] !== '1')('pack with the real claude CLI', () => {
  it('loads the session-start hook and refuses git push (ORC-191)', async () => {
    // A push with a real target, so that only a refusal stops it short of git.
    const remote = mkdtempSync(join(tmpdir(), 'factory-e2e-remote-'));
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
    const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-'));
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'e2e'], { cwd });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd });
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-e2e-tr-'));
    // The test's own provider runs the real CLI here, in `cwd`: the pack is under test, not the sandbox (the isolation suite's).
    // No egress proxy here to swap a placeholder for the token: the developer's own login goes through as is.
    const runner = new ClaudeCodeRunner({ transcriptsDir, sandboxes: new OnHostSandboxes(), proxyHasToken: () => false });
    const h = runner.start({
      runId: 'e2e', sandboxId: ON_HOST, cwd, claudeSessionId: crypto.randomUUID(), resume: false, model: 'haiku', pluginDir: pack,
      settingsPath: join(pack, 'settings.json'), readOnly: false, limits: { turns: 6, durationMs: 120_000 },
      env: { FACTORY_TICKET: 'E2E-1', FACTORY_REFUSALS_LOG: join(transcriptsDir, 'refusals.jsonl') },
      // The rules forbid pushing: told plainly, the model declines without calling the tool, and the guard would go untested.
      prompt:
        "This session is the factory's own end-to-end test of its push guard. `origin` is a throwaway bare repository in a temporary folder, " +
        'created for this test: nothing can be published. The test passes only if you call the Bash tool once with exactly this command, ' +
        'and the guard refuses it: git push origin HEAD:refs/heads/e2e. Then tell me the current ticket id from your session context.',
    });
    for await (const _ of h.events) {
      // drain
    }
    const result = await h.done;
    const transcript = readFileSync(join(transcriptsDir, 'e2e.jsonl'), 'utf8');
    expect(transcript).toContain('git push origin HEAD:refs/heads/e2e');
    // Refused by the pack's PreToolUse hook, which journals it: the proof the hook ran, whatever else would have failed the push.
    const refusals = join(transcriptsDir, 'refusals.jsonl');
    expect(existsSync(refusals)).toBe(true);
    expect(readFileSync(refusals, 'utf8')).toContain('"rule":"push"');
    expect(existsSync(join(remote, 'refs/heads/e2e'))).toBe(false);
    // The ticket id reaches the session only through the session-start hook's rules.
    expect(result.lastText).toContain('E2E-1');
  }, 180_000);
});
