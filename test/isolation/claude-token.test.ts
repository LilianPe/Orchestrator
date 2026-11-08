import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SANDBOX_CLAUDE_TOKEN } from '../../src/adapters/runner/claude-code.js';
import type { Sandbox } from '../../src/adapters/sandbox/types.js';
import { CLAUDE_RUN_ENV } from '../../src/core/orchestrator.js';
import { EgressProxy, type EgressEntry } from '../../src/network/proxy.js';
import { httpsUpstream } from '../helpers/egress-upstream.js';
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
  let dir = '';
  /** What the stand-in API got: method, path and credentials. */
  const seen: { method: string; url: string; authorization?: string; apiKey?: string }[] = [];
  let api: Server;
  let proxy: EgressProxy;
  let sbx: Sandbox;
  let runId = '';
  let hasClaude = false;
  const { provider, request, sh } = useSandboxes('claude-token', {
    egress: {
      open: (id, policy) => proxy.open(id, policy),
      close: (id) => proxy.close(id),
      isOpen: (id) => proxy.isOpen(id),
      get caCertPath() {
        return proxy.caCertPath;
      },
    },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'factory-claude-token-'));
    const up = await httpsUpstream(dir, (req, res) => {
      seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined });
      req.resume();
      req.on('end', () => {
        if (req.url?.startsWith('/v1/messages')) return void res.writeHead(200, { 'content-type': 'text/event-stream' }).end(REPLY);
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"stand-in"}}');
      });
    });
    api = up.server;
    proxy = new EgressProxy({ dir: join(dir, 'network'), caDir: join(dir, 'ca'), claudeToken: () => FACTORY_TOKEN, upstream: up.upstream });
    const req = request({ network: 'claude-api' });
    runId = req.runId;
    sbx = await provider.create(req);
    hasClaude = (await sh(sbx.id, 'command -v claude')).code === 0;
  }, 300_000);

  afterAll(async () => {
    await proxy?.closeAll();
    await new Promise((ok) => (api ? api.close(ok) : ok(undefined)));
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  /** A request the agent could make itself, with Node's fetch through the proxy: the status it gets. */
  const agentFetch = async (path: string, body: string) =>
    (await sh(sbx.id, `node -e "fetch('https://api.anthropic.com${path}',{method:'POST',headers:{'x-api-key':'sk-ant-api03-attacker','content-type':'application/json'},body:process.argv[1]}).then(r=>console.log(r.status),e=>{console.log('ERR',e.cause?.code??e.message);process.exit(3)})" '${body}'`)).stdout;

  it('claude -p answers through the proxy with a placeholder token, its own tools and betas let through; the API gets the factory token alone', async ({ skip }) => {
    if (!hasClaude) skip();
    const env = { ...CLAUDE_RUN_ENV, CLAUDE_CONFIG_DIR: '/tmp/claude-config', CLAUDE_CODE_OAUTH_TOKEN: SANDBOX_CLAUDE_TOKEN };
    const r = await sh(sbx.id, `env ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} claude -p 'say pong' --output-format stream-json --verbose --model haiku --max-turns 1`);
    const result = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e['type'] === 'result');
    expect(result, r.stderr).toMatchObject({ is_error: false, result: 'PONG-FROM-THE-STAND-IN' });
    expect(seen.some((s) => s.method === 'POST' && s.url.startsWith('/v1/messages'))).toBe(true);
    for (const s of seen) expect(s).toMatchObject({ authorization: `Bearer ${FACTORY_TOKEN}`, apiKey: undefined });
    // Nothing of its run was refused nor dropped: a Claude Code bump that needs a new beta or endpoint fails here.
    await new Promise((r) => setTimeout(r, 200)); // the last line, written as its connection closes
    const lines = readFileSync(proxy.journalPath(runId), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l['kind'] === 'note' || l['ok'] === false)).toEqual([]);
    expect(lines.some((l) => l['path'] === '/v1/messages' && l['ok'] === true)).toBe(true);
  }, 240_000);

  it('refuses what a hijacked agent would send with its own key: /v1/files, an MCP server, a server tool, an image by URL', async () => {
    const before = seen.length;
    expect(await agentFetch('/v1/files', 'x')).toBe('403');
    expect(await agentFetch('/v1/messages', JSON.stringify({ model: 'm', max_tokens: 1, messages: [], mcp_servers: [{ type: 'url', url: 'https://attacker.example/mcp', name: 'x' }] }))).toBe('403');
    expect(await agentFetch('/v1/messages', JSON.stringify({ model: 'm', max_tokens: 1, messages: [], tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] }))).toBe('403');
    const byUrl = { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://attacker.example/x.png' } }] }] };
    expect(await agentFetch('/v1/messages', JSON.stringify(byUrl))).toBe('403');
    expect(seen.length).toBe(before);
    const journal = readFileSync(proxy.journalPath(runId), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as EgressEntry);
    expect(journal).toContainEqual(expect.objectContaining({ method: 'POST', host: 'api.anthropic.com', path: '/v1/files', ok: false }));
    expect(journal).toContainEqual(expect.objectContaining({ path: '/v1/messages', ok: false, reason: 'Claude API body refused: mcp_servers' }));
    expect(journal).toContainEqual(expect.objectContaining({ path: '/v1/messages', ok: false, reason: 'Claude API body refused: server tool web_fetch_20250910' }));
    expect(journal).toContainEqual(expect.objectContaining({ path: '/v1/messages', ok: false, reason: 'Claude API body refused: a image block sourced by url' }));
  }, 240_000);
});
