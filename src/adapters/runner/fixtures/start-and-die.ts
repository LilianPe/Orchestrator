/**
 * A daemon that starts an attempt and dies under `kill -9` right after (ORC-220): what it spawned goes on
 * without it, writing to the run's stream file.
 *
 *   node --import tsx start-and-die.ts <transcripts dir> <run id> <fake claude> <env as JSON>
 */
import { ClaudeCodeRunner } from '../claude-code.js';

const [transcriptsDir, runId, fake, env] = process.argv.slice(2);
if (!transcriptsDir || !runId || !fake || !env) throw new Error('usage: start-and-die.ts <dir> <run> <fake> <env>');
new ClaudeCodeRunner({ transcriptsDir, command: [process.execPath, fake] }).start({
  runId,
  cwd: process.cwd(),
  prompt: '/factory:dev',
  claudeSessionId: 'uuid-1',
  resume: false,
  model: 'sonnet',
  pluginDir: '/pack',
  settingsPath: '/pack/settings.json',
  readOnly: false,
  limits: { turns: 50, durationMs: 60_000, usd: 5 },
  env: JSON.parse(env) as Record<string, string>,
});
// The kernel's kill, at once: no cleanup of any kind, and the attempt has not even written yet.
process.kill(process.pid, 'SIGKILL');
