import { describe, expect, it } from 'vitest';
import { runAgentCli } from './factory-agent.js';
import { PRODUCT_NAME } from '../product.js';

function fetchStub(responses: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? responses[key] : {}), { status: key ? 200 : 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const env = { FACTORY_API: 'http://127.0.0.1:4100/agent', FACTORY_RUN_TOKEN: 'tok' } as NodeJS.ProcessEnv;

describe('factory-agent', () => {
  it('refuses to run outside the factory', async () => {
    const out: string[] = [];
    expect(await runAgentCli(['issue', 'REL-1'], {} as NodeJS.ProcessEnv, fetch, (s) => out.push(s))).toBe(2);
    expect(out.join('')).toContain(`must be started by ${PRODUCT_NAME}`);
  });

  it('reads an issue with the bearer token', async () => {
    const { f, calls } = fetchStub({ '/issue/REL-1': { identifier: 'REL-1', title: 'Export', stateName: 'Todo', url: 'u', description: 'D' } });
    const out: string[] = [];
    expect(await runAgentCli(['issue', 'REL-1'], env, f, (s) => out.push(s))).toBe(0);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4100/agent/issue/REL-1');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(out.join('')).toContain('REL-1 — Export (Todo)');
  });

  it('asks a question', async () => {
    const { f, calls } = fetchStub({ '/ask': { ok: true } });
    await runAgentCli(['ask', 'Quelle', 'base', '?'], env, f, () => {});
    expect(calls[0]!.init!.body).toBe(JSON.stringify({ text: 'Quelle base ?' }));
  });

  it("searches the knowledge base no more: the factory MCP's kb_search does (ORC-232)", async () => {
    const { f, calls } = fetchStub({});
    const out: string[] = [];
    expect(await runAgentCli(['kb', 'search', 'agrégats'], env, f, (s) => out.push(s))).toBe(1);
    expect(calls).toEqual([]);
    expect(out.join('')).not.toContain('kb search');
  });
});
