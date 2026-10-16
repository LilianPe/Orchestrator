import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyLinearSignature } from '../adapters/tracker/linear/webhook.js';
import { startSmeeRelay } from './smee.js';

let server: Server | undefined;
let relay: { close(): void } | undefined;
afterEach(() => {
  relay?.close();
  relay = undefined;
  server?.closeAllConnections();
  server?.close();
});

function sseServer(payload: unknown): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: ready\ndata: {}\n\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/chan`)));
}

const SECRET = 's3cret';

function serveSigned(raw: string): Promise<{ url: string; sig: string }> {
  const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
  return sseServer({ 'linear-signature': sig, body: JSON.parse(raw) }).then((url) => ({ url, sig }));
}

type Relayed = { raw: string; headers: Record<string, string | undefined>; logs: string[] };

// Resolves on the first relayed webhook; the relay logs a rejection synchronously after onWebhook returns,
// so `logs` already holds it when the awaiting test resumes.
function firstWebhook(url: string, status: (raw: string, headers: Relayed['headers']) => number = () => 200): Promise<Relayed> {
  const logs: string[] = [];
  return new Promise((resolve) => {
    relay = startSmeeRelay({
      url,
      log: (m) => logs.push(m),
      onWebhook: (raw, headers) => {
        relay?.close();
        resolve({ raw, headers, logs });
        return { status: status(raw, headers) };
      },
    });
  });
}

describe('smee relay', () => {
  it('rebuilds raw body and headers from a smee message', async () => {
    const url = await sseServer({ 'linear-signature': 'abc', 'linear-delivery': 'd1', body: { type: 'Issue', n: 1 }, query: {}, timestamp: 1 });
    const got = await firstWebhook(url);
    expect(got.raw).toBe('{"type":"Issue","n":1}');
    expect(got.headers['linear-signature']).toBe('abc');
    expect(got.headers['linear-delivery']).toBe('d1');
  });

  it('keeps a JSON.stringify-shaped body byte-identical, so its signature stays valid', async () => {
    const raw = JSON.stringify({ type: 'Issue', t: 'é😀 a\nb "q" \\ \ud800 </x>', n: 1.5, big: 1e21, 2: 'k', b: [] });
    const { url, sig } = await serveSigned(raw);
    const got = await firstWebhook(url);
    expect(got.raw).toBe(raw);
    expect(verifyLinearSignature(got.raw, sig, SECRET)).toBe(true);
  });

  it('explains the smee limitation when a body whose bytes it cannot reproduce is rejected', async () => {
    const raw = '{"type": "Issue", "n": 1.0, "t": "a\\/b"}';
    const { url } = await serveSigned(raw);
    const got = await firstWebhook(url, (r, h) => (verifyLinearSignature(r, h['linear-signature'], SECRET) ? 200 : 401));
    expect(got.raw).not.toBe(raw);
    const logged = got.logs.find((m) => m.startsWith('relay: webhook rejected')) ?? '';
    expect(logged).toMatch(/^relay: webhook rejected with 401/);
    expect(logged).toMatch(/smee\.io re-serializes/);
    expect(logged).toMatch(/publicUrl/);
  });

  // The shapes docs/linear.md (section 3) lists as not reproducible through smee.
  it.each([
    ['spaces', '{"type": "Issue"}'],
    ['indentation', '{\n  "type": "Issue"\n}'],
    ['escaped slash', '{"t":"a\\/b"}'],
    ['optional unicode escape', '{"t":"\\u00e9"}'],
    ['1.0', '{"n":1.0}'],
    ['1e3', '{"n":1e3}'],
    ['-0', '{"n":-0}'],
    ['a float longer than its shortest form', '{"n":0.30000000000000001}'],
    ['an integer beyond 2^53 not exactly representable', '{"n":9007199254740993}'],
    ['an integer JSON.stringify writes in exponent form', '{"n":1000000000000000000000}'],
    ['duplicate keys', '{"a":1,"a":2}'],
    ['numeric key after a string key', '{"type":"Issue","2":"k"}'],
  ])('does not reproduce a body with %s', async (_shape, raw) => {
    const { url } = await serveSigned(raw);
    const got = await firstWebhook(url);
    expect(got.raw).toBe(JSON.stringify(JSON.parse(raw)));
    expect(got.raw).not.toBe(raw);
  });
});
