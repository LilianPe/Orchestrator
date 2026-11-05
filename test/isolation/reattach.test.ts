import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drain } from '../contracts/agent-runtime.contract.js';
import { ClaudeCodeRunner } from '../../src/adapters/runner/claude-code.js';
import { cli, enabled, image, useSandboxes } from './helpers.js';

/** The last line the agent writes, once the daemon that started it is dead. */
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 1, result: 'Fini sans le démon.' });
const AGENT = `sleep 6; echo vivant > /work/after-kill; echo '${RESULT}'`;

/** ORC-220, on a real engine: a kill -9 of the daemon leaves the attempt running in its container. */
describe.skipIf(!enabled)(`an attempt outlives its daemon (${cli})`, () => {
  const { provider, request, workspace } = useSandboxes('reattach');

  it('goes on in its container, and the next daemon reattaches to it and takes its real result', { timeout: 120_000 }, async () => {
    const ws = workspace();
    const req = request({ workspacePath: ws });
    const sandbox = await provider.create(req);
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-iso-tr-'));
    try {
      const died = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'die-with-run.ts'), transcriptsDir, cli, image, req.runId, AGENT], { stdio: 'pipe', encoding: 'utf8' });
      expect(died.status, died.stderr).not.toBe(0);
      expect(existsSync(join(ws, 'after-kill'))).toBe(false);

      // As the next daemon's recover(): by the label, from a process that never saw the container.
      expect(await provider.reattach(req.runId)).toMatchObject({ id: sandbox.id });
      const h = new ClaudeCodeRunner({ transcriptsDir, sandboxes: provider }).attach({ runId: req.runId, limits: { turns: 5, durationMs: 120_000, usd: 0 }, elapsedMs: 1_000, env: {} });
      expect(h).toBeDefined();
      const events = await drain(h!.events);
      expect(await h!.done).toMatchObject({ outcome: 'success', lastText: 'Fini sans le démon.', costUsd: 0.1 });
      expect(events.map((e) => e.kind)).toContain('result');
      expect(existsSync(join(ws, 'after-kill'))).toBe(true);
    } finally {
      rmSync(transcriptsDir, { recursive: true, force: true });
    }
  });
});
