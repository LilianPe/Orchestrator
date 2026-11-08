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

  it("reads the PR again through the factory, without network (ORC-322)", async () => {
    const { f, calls } = fetchStub({ '/pr': { number: 3, url: 'https://github.test/pr/3', state: 'OPEN', branch: 'b', base: 'main', mergeable: 'MERGEABLE', mergeState: 'BEHIND', head: 'a'.repeat(40), baseSha: 'b'.repeat(40) } });
    const out: string[] = [];
    expect(await runAgentCli(['pr'], env, f, (s) => out.push(s))).toBe(0);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4100/agent/pr');
    expect(out.join('')).toContain('#3 — OPEN — base `main` — mergeable: MERGEABLE (BEHIND)');
    expect(out.join('')).toContain(`\`origin/b\` at ${'a'.repeat(12)}`);
  });

  it('says so when the run has no PR to read', async () => {
    const { f } = fetchStub({});
    const out: string[] = [];
    expect(await runAgentCli(['pr'], env, f, (s) => out.push(s))).toBe(1);
    expect(out.join('')).toContain('HTTP 404');
  });

  it('searches the knowledge base and asks a question', async () => {
    const { f, calls } = fetchStub({ '/kb/search': [{ file: 'notes/a.md', line: 3, text: 'agrégats' }], '/ask': { ok: true } });
    const out: string[] = [];
    await runAgentCli(['kb', 'search', 'agrégats', 'serveur'], env, f, (s) => out.push(s));
    expect(calls[0]!.url).toBe('http://127.0.0.1:4100/agent/kb/search?q=agr%C3%A9gats%20serveur');
    expect(out.join('')).toContain('notes/a.md:3: agrégats');
    await runAgentCli(['ask', 'Quelle', 'base', '?'], env, f, () => {});
    expect(calls[1]!.init!.body).toBe(JSON.stringify({ text: 'Quelle base ?' }));
  });
});
