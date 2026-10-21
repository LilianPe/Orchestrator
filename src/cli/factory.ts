#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { execCmd } from '../adapters/exec.js';
import { GitWorkspaces } from '../adapters/workspace/git-workspaces.js';
import { LinearApi } from '../adapters/tracker/linear/api.js';
import { TokenManager } from '../adapters/tracker/linear/oauth.js';
import { LinearTracker } from '../adapters/tracker/linear/tracker.js';
import { startRelais } from '../app/bootstrap.js';
import { repoRoot } from '../app/root.js';
import { homePaths, loadInstance, loadSecrets, relaisHome, saveSecrets } from '../config/instance.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { createSmeeChannel } from '../relay/smee.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from './init.js';
import { formatPlan, planRows } from './plan.js';

const USAGE = `Usage : relais <commande>
  init               configurer Relais pour le dépôt courant
  up [--fake-runner] démarrer Relais (interface sur http://localhost:4100)
  plan               voir quels tickets délégués seraient pris
  status             état de l'instance en cours
  pause | resume     suspendre ou reprendre la file
  stop <ID>          arrêter le run d'un ticket`;

/** Basic auth for a Relais bound to a non-loopback host (RELAIS_UI_PASSWORD). */
function uiAuth(): Record<string, string> {
  const pw = process.env['RELAIS_UI_PASSWORD'];
  return pw ? { authorization: `Basic ${Buffer.from(`relais:${pw}`).toString('base64')}` } : {};
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'fake-runner': { type: 'boolean' } } });
  const [cmd, arg] = positionals;
  const home = relaisHome();
  const cfg = loadInstance(home);
  const api = `http://127.0.0.1:${cfg.port}`;

  switch (cmd) {
    case 'init': {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await runInit({
        home,
        cwd: process.cwd(),
        exec: execCmd,
        createSmee: () => createSmeeChannel(),
        io: {
          ask: async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ''} : `)).trim() || def || '',
          confirm: async (q, def = false) => {
            const a = (await rl.question(`${q} ${def ? '[O/n]' : '[o/N]'} : `)).trim().toLowerCase();
            return a ? a.startsWith('o') || a.startsWith('y') : def;
          },
          print: (s) => console.log(s),
        },
      });
      rl.close();
      return 0;
    }
    case 'up': {
      const app = await startRelais({ home, fakeRunner: values['fake-runner'] });
      console.log(`Relais tourne : ${app.url}  (Ctrl+C pour arrêter)`);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      });
      await app.stop();
      return 0;
    }
    case 'plan': {
      const linear = loadSecrets(home).linear;
      if (!linear?.accessToken || !linear.appUserId) {
        console.log('Linear non connecté : lancez `relais up` puis connectez Linear.');
        return 1;
      }
      const tm = new TokenManager({
        clientId: linear.clientId,
        clientSecret: linear.clientSecret,
        load: () => ({ accessToken: linear.accessToken!, refreshToken: linear.refreshToken, expiresAt: linear.expiresAt }),
        save: (t) => saveSecrets(home, { ...loadSecrets(home), linear: { ...linear, ...t } }),
      });
      const tracker = new LinearTracker(new LinearApi(() => tm.get()), linear.appUserId);
      const packDir = join(repoRoot(), 'packs/standard');
      const projects = cfg.projects.map((p) => {
        const f = join(p.repoPath, '.relais/workflow.yml');
        return { id: p.id, repoPath: p.repoPath, teamKey: p.linearTeamKey, workflow: loadWorkflow({ packDir, projectFile: existsSync(f) ? f : undefined }) };
      });
      const store = new SqliteStore(homePaths(home).db);
      console.log(formatPlan(await planRows({ tracker, store, projects, workspaces: new GitWorkspaces({ root: homePaths(home).workspaces }) })));
      store.close();
      return 0;
    }
    case 'status': {
      const s = (await (await fetch(`${api}/api/state`, { headers: uiAuth() })).json()) as any;
      console.log(`Linear : ${s.linearConnected ? 'connecté' : 'non connecté'} · file : ${s.paused ? 'en pause' : 'active'} · places dev ${s.capacity.dev.used}/${s.capacity.dev.total} · coût du jour ${s.costTodayUsd.toFixed(2)} $`);
      for (const t of s.tickets) console.log(`  ${t.ticketId}  ${t.logical}${t.blocked ? ' (bloqué)' : ''}  ${t.title}`);
      return 0;
    }
    case 'pause':
    case 'resume':
      await fetch(`${api}/api/control/${cmd}`, { method: 'POST', headers: uiAuth() });
      console.log(cmd === 'pause' ? 'File en pause.' : 'File relancée.');
      return 0;
    case 'stop': {
      if (!arg) break;
      const s = (await (await fetch(`${api}/api/state`, { headers: uiAuth() })).json()) as any;
      const t = s.tickets.find((x: any) => x.ticketId === arg);
      if (!t) {
        console.log(`Ticket ${arg} inconnu de Relais.`);
        return 1;
      }
      await fetch(`${api}/api/tickets/${t.projectId}/${arg}/stop`, { method: 'POST', headers: uiAuth() });
      console.log(`Arrêt demandé pour ${arg}.`);
      return 0;
    }
    default:
      break;
  }
  console.log(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
