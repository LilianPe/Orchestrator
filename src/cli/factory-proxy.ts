#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { EgressProxy } from '../network/proxy.js';
import { sandboxAgentHost, serveEgressControl } from '../network/proxy-service.js';

/** The `proxy` service of compose.yaml (ORC-203): EgressProxy in a process of its own, with none of the daemon's secrets. */
const required = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} est requis par le service proxy.`);
  return v;
};
const log = (m: string) => console.log(`[proxy] ${m}`);

const dir = required('FACTORY_EGRESS_DIR');
const controlPath = required('FACTORY_EGRESS_CONTROL');
const agentPort = Number(required('FACTORY_AGENT_PORT'));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const proxy = new EgressProxy({
  dir,
  caDir: required('FACTORY_EGRESS_CA_DIR'),
  log,
  agentApi: { host: sandboxAgentHost(process.env), port: agentPort, to: { host: required('FACTORY_AGENT_UPSTREAM'), port: agentPort } },
});
const control = await serveEgressControl(proxy, controlPath);
log(`proxy de sortie prêt : ${controlPath}`);
await new Promise<void>((resolve) => {
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());
});
await control.close();
await proxy.closeAll();
