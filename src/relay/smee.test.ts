import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyLinearSignature } from '../adapters/tracker/linear/webhook.js';
import { startSmeeRelay } from './smee.js';

let server: Server | undefined;
afterEach(() => {
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

function firstWebhook(url: string): Promise<{ raw: string; headers: Record<string, string | undefined> }> {
  return new Promise((resolve) => {
    const relay = startSmeeRelay({
      url,
      log: () => {},
      onWebhook: (raw, headers) => {
        relay.close();
        resolve({ raw, headers });
        return { status: 200 };
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
    let relayed = '';
    const logged = await new Promise<string>((resolve) => {
      const relay = startSmeeRelay({
        url,
        log: (m) => {
          if (!m.startsWith('relay: webhook rejected')) return;
          relay.close();
          resolve(m);
        },
        onWebhook: (r, h) => {
          relayed = r;
          return { status: verifyLinearSignature(r, h['linear-signature'], SECRET) ? 200 : 401 };
        },
      });
    });
    expect(relayed).not.toBe(raw);
    expect(logged).toMatch(/^relay: webhook rejected with 401/);
    expect(logged).toMatch(/smee\.io re-serializes/);
    expect(logged).toMatch(/publicUrl/);
  });
});
