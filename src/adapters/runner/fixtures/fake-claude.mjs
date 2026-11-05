import { appendFileSync, existsSync, readFileSync } from 'node:fs';

if (process.env.FAKE_CLAUDE_ARGS) appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)) + '\n');
if (process.env.FAKE_CLAUDE_PATH) appendFileSync(process.env.FAKE_CLAUDE_PATH, process.env.PATH ?? '');
const lines = readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8').split('\n').filter(Boolean);
// The last line waits for this file: the attempt is still running when a test kills its daemon (ORC-220).
const gate = process.env.FAKE_CLAUDE_GATE;
for (const l of gate ? lines.slice(0, -1) : lines) process.stdout.write(l + '\n');
if (gate) {
  const waiting = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(waiting);
    process.stdout.write(lines.at(-1) + '\n');
  }, 20);
}
if (process.env.FAKE_CLAUDE_HANG) {
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
}
