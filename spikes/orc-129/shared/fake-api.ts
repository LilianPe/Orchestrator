// Stand-in for an external API (Linear comments) that the effect calls.
// It applies the comment as soon as it receives the call, then holds the response HOLD_MS:
// that window is where the spike kills the worker (effect applied outside, result not yet back).
// It honours an Idempotency-Key header unless IGNORE_IDEMPOTENCY=1.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.env.FAKE_API_PORT ?? 4129);
const holdMs = Number(process.env.HOLD_MS ?? 3000);
const log = process.env.FAKE_API_LOG ?? 'fake-api.jsonl';
const honourKey = process.env.IGNORE_IDEMPOTENCY !== '1';

const byKey = new Map<string, string>();
let received = 0;
let applied = 0;
writeFileSync(log, '');
const record = (line: object) => appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n');

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.end(JSON.stringify({ received, applied }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const key = req.headers['idempotency-key'] as string | undefined;
    received++;
    record({ type: 'received', key, body });
    const known = honourKey && key ? byKey.get(key) : undefined;
    if (known) {
      record({ type: 'deduplicated', key, commentId: known });
      res.end(JSON.stringify({ commentId: known }));
      return;
    }
    applied++;
    const commentId = `comment-${applied}`;
    if (key) byKey.set(key, commentId);
    record({ type: 'applied', key, commentId });
    setTimeout(() => res.end(JSON.stringify({ commentId })), holdMs);
  });
}).listen(port, () => record({ type: 'listening', port, holdMs, honourKey }));
