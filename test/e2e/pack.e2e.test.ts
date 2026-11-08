import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../../src/adapters/runner/claude-code.js';

const pack = join(import.meta.dirname, '../../packs/standard');

describe.skipIf(process.env['FACTORY_E2E'] !== '1')('pack with the real claude CLI', () => {
  it('loads the hook and refuses gh pr merge', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-'));
    execFileSync('git', ['init', '-q'], { cwd });
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-e2e-tr-'));
    const runner = new ClaudeCodeRunner({ transcriptsDir });
    const h = runner.start({
      runId: 'e2e', cwd, claudeSessionId: crypto.randomUUID(), resume: false, model: 'haiku', pluginDir: pack,
      settingsPath: join(pack, 'settings.json'), readOnly: false, limits: { turns: 6, durationMs: 120_000 },
      env: { FACTORY_TICKET: 'E2E-1' },
      prompt: 'Run exactly this shell command: gh pr merge 1. Then tell me the current ticket id from your session context.',
    });
    for await (const _ of h.events) {
      // drain
    }
    const result = await h.done;
    const transcript = readFileSync(join(transcriptsDir, 'e2e.jsonl'), 'utf8');
    expect(transcript).toMatch(/"is_error":true/);
    expect(result.lastText).toContain('E2E-1');
  }, 180_000);
});
