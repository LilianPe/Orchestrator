import { appendFileSync, readFileSync } from 'node:fs';

if (process.env.FAKE_CLAUDE_ARGS) appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)) + '\n');
if (process.env.FAKE_CLAUDE_PATH) appendFileSync(process.env.FAKE_CLAUDE_PATH, process.env.PATH ?? '');
const lines = readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8').split('\n').filter(Boolean);
for (const l of lines) process.stdout.write(l + '\n');
if (process.env.FAKE_CLAUDE_HANG) {
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
}
