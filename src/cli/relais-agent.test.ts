import { describe, expect, it } from 'vitest';
import { runAgentCli } from './relais-agent.js';

function fetchStub(responses: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? responses[key] : {}), { status: key ? 200 : 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const env = { RELAIS_API: 'http://127.0.0.1:4100/agent', RELAIS_RUN_TOKEN: 'tok' } as NodeJS.ProcessEnv;

describe('relais-agent', () => {
  it('refuses to run outside Relais', async () => {
    const out: string[] = [];
    expect(await runAgentCli(['issue', 'REL-1'], {} as NodeJS.ProcessEnv, fetch, (s) => out.push(s))).toBe(2);
    expect(out.join('')).toContain('doit être lancé par Relais');
  });

  it('reads an issue with the bearer token', async () => {
    const { f, calls } = fetchStub({ '/issue/REL-1': { identifier: 'REL-1', title: 'Export', stateName: 'Todo', url: 'u', description: 'D' } });
    const out: string[] = [];
    expect(await runAgentCli(['issue', 'REL-1'], env, f, (s) => out.push(s))).toBe(0);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4100/agent/issue/REL-1');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(out.join('')).toContain('REL-1 — Export (Todo)');
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
