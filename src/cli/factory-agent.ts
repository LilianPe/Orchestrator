#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { PRODUCT_NAME } from '../product.js';

const USAGE = 'Usage: factory-agent issue <ID> | search <text> | kb search <words> | ask <question>';

export async function runAgentCli(argv: string[], env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, out: (s: string) => void): Promise<number> {
  const api = env['FACTORY_API'];
  const token = env['FACTORY_RUN_TOKEN'];
  if (!api || !token) {
    out(`factory-agent must be started by ${PRODUCT_NAME} (FACTORY_API and FACTORY_RUN_TOKEN missing).\n`);
    return 2;
  }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const get = async (path: string) => {
    const res = await fetchImpl(`${api}${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'issue' && rest[0]) {
      const i = await get(`/issue/${encodeURIComponent(rest[0])}`);
      out(`${i.identifier} — ${i.title} (${i.stateName})\n${i.url}\n\n${i.description}\n`);
      return 0;
    }
    if (cmd === 'search' && rest.length) {
      const hits = (await get(`/search?q=${encodeURIComponent(rest.join(' '))}`)) as any[];
      out(hits.map((h) => `${h.identifier} — ${h.title} (${h.stateName}) ${h.url}`).join('\n') + '\n');
      return 0;
    }
    if (cmd === 'kb' && rest[0] === 'search' && rest.length > 1) {
      const hits = (await get(`/kb/search?q=${encodeURIComponent(rest.slice(1).join(' '))}`)) as any[];
      out((hits.length ? hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n') : 'No result.') + '\n');
      return 0;
    }
    if (cmd === 'ask' && rest.length) {
      const res = await fetchImpl(`${api}/ask`, { method: 'POST', headers, body: JSON.stringify({ text: rest.join(' ') }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out('Question asked in Linear. End your turn now.\n');
      return 0;
    }
  } catch (err) {
    out(`factory-agent: ${(err as Error).message}\n`);
    return 1;
  }
  out(`${USAGE}\n`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runAgentCli(process.argv.slice(2), process.env, fetch, (s) => process.stdout.write(s)).then((code) => process.exit(code));
}
