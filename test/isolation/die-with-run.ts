/**
 * A daemon that starts an attempt in its sandbox and dies under `kill -9` right after (ORC-220): `reattach.test.ts`
 * looks at what is left.
 *
 *   node --import tsx die-with-run.ts <transcripts dir> <engine cli> <image> <run id> <script>
 */
import { ClaudeCodeRunner } from '../../src/adapters/runner/claude-code.js';
import { ContainerSandboxProvider } from '../../src/adapters/sandbox/docker-rootless.js';
import { WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';

const [transcriptsDir, cli, image, runId, script] = process.argv.slice(2);
if (!transcriptsDir || !cli || !image || !runId || !script) throw new Error('usage: die-with-run.ts <dir> <cli> <image> <run> <script>');
const sandboxes = new ContainerSandboxProvider({ cli, image, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });
const sandbox = await sandboxes.findByAttempt(runId);
if (!sandbox) throw new Error(`no sandbox for ${runId}`);
new ClaudeCodeRunner({ transcriptsDir, sandboxes, command: ['sh', '-c', script, 'sh'] }).start({
  runId,
  cwd: WORKSPACE_TARGET,
  prompt: 'p',
  claudeSessionId: 's',
  resume: false,
  model: 'haiku',
  pluginDir: '/factory/pack',
  settingsPath: '/factory/pack/settings.json',
  readOnly: false,
  limits: { turns: 5, durationMs: 120_000, usd: 0 },
  env: {},
  sandboxId: sandbox.id,
});
// The kernel's kill, once `docker exec` is under way: no cleanup of any kind.
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1_000);
