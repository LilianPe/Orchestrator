import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('smee relay', () => {
  it('rebuilds raw body and headers from a smee message', async () => {
    const url = await sseServer({ 'linear-signature': 'abc', 'linear-delivery': 'd1', body: { type: 'Issue', n: 1 }, query: {}, timestamp: 1 });
    const got = await new Promise<{ raw: string; headers: Record<string, string | undefined> }>((resolve) => {
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
    expect(got.raw).toBe('{"type":"Issue","n":1}');
    expect(got.headers['linear-signature']).toBe('abc');
    expect(got.headers['linear-delivery']).toBe('d1');
  });
});
