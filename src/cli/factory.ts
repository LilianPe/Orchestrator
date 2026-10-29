#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { execCmd } from '../adapters/exec.js';
import { GitWorkspaces } from '../adapters/workspace/git-workspaces.js';
import { LinearApi } from '../adapters/tracker/linear/api.js';
import { TokenManager } from '../adapters/tracker/linear/oauth.js';
import { LinearTracker } from '../adapters/tracker/linear/tracker.js';
import { startFactory } from '../app/bootstrap.js';
import { repoRoot } from '../app/root.js';
import { effectiveInstance, homePaths, linearSettings, factoryHome, saveLinearTokens } from '../config/instance.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { createSmeeChannel } from '../relay/smee.js';
import { openStore } from '../store/open.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from './init.js';
import { runDoctorCommand } from './doctor.js';
import { formatPlan, planRows } from './plan.js';
import { runReplayCommand } from './replay.js';
import { runRepairCommand } from './repair.js';
import { runValidateCommand } from './validate.js';
import { PRODUCT_NAME } from '../product.js';

const USAGE = `Usage : factory <commande>
  init               configurer ${PRODUCT_NAME} pour le dépôt courant
  validate [repo]    vérifier .factory/config.yml contre le socle (il ne peut qu'ajouter)
  doctor [repo] [--json] refuser un dépôt dont la CI peut exposer des secrets aux branches de l'usine
  up [--fake-runner] démarrer ${PRODUCT_NAME} (interface sur http://localhost:4100)
  plan               voir quels tickets délégués seraient pris
  status             état de l'instance en cours
  pause | resume     suspendre ou reprendre la file
  stop <ID>          arrêter le run d'un ticket
  replay <journal>... rejouer des journaux exportés (régression bit à bit, --what-if <workflow.yml>, --export <ID>)
  run repair <ID> [replay|skip|force] [<événement>]  réparer un événement mis de côté (dead-letter)`;

/** Basic auth for an instance bound to a non-loopback host (FACTORY_UI_PASSWORD). */
function uiAuth(): Record<string, string> {
  const pw = process.env['FACTORY_UI_PASSWORD'];
  return pw ? { authorization: `Basic ${Buffer.from(`factory:${pw}`).toString('base64')}` } : {};
}

async function main(): Promise<number> {
  // Its own options, and no instance needed to replay a file (the CI has none).
  if (process.argv[2] === 'replay') return runReplayCommand(process.argv.slice(3));
  // A repository file only: no instance needed either.
  if (process.argv[2] === 'validate') return runValidateCommand({ repoPath: process.argv[3] ?? process.cwd(), out: (l) => console.log(l) });
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'fake-runner': { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const [cmd, arg] = positionals;
  const home = factoryHome();
  const cfg = effectiveInstance(home);
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
    case 'doctor':
      return runDoctorCommand({ repoPath: arg ?? process.cwd(), home, json: values.json });
    case 'up': {
      const app = await startFactory({ home, fakeRunner: values['fake-runner'] });
      console.log(`${PRODUCT_NAME} tourne : ${app.url}  (Ctrl+C pour arrêter)`);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      });
      await app.stop();
      return 0;
    }
    case 'plan': {
      const linear = linearSettings(home);
      if (!linear?.accessToken || !linear.appUserId) {
        console.log('Linear non connecté : lancez `factory up` puis connectez Linear.');
        return 1;
      }
      const tm = new TokenManager({
        clientId: linear.clientId,
        clientSecret: linear.clientSecret,
        load: () => ({ accessToken: linear.accessToken!, refreshToken: linear.refreshToken, expiresAt: linear.expiresAt }),
        save: (t) => saveLinearTokens(home, t),
      });
      const tracker = new LinearTracker(new LinearApi(() => tm.get()), linear.appUserId);
      const packDir = join(repoRoot(), 'packs/standard');
      const projects = cfg.projects.map((p) => {
        const f = join(p.repoPath, '.factory/workflow.yml');
        return { id: p.id, repoPath: p.repoPath, teamKey: p.linearTeamKey, workflow: loadWorkflow({ packDir, projectFile: existsSync(f) ? f : undefined }) };
      });
      // Read-only: the schema is the daemon's to migrate.
      const { store } = await openStore({ env: process.env, sqlitePath: homePaths(home).db, migrationsFolder: join(repoRoot(), 'drizzle'), migrate: false });
      console.log(formatPlan(await planRows({ tracker, store, projects, workspaces: new GitWorkspaces({ root: homePaths(home).workspaces }) })));
      await store.close();
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
        console.log(`Ticket ${arg} inconnu de ${PRODUCT_NAME}.`);
        return 1;
      }
      await fetch(`${api}/api/tickets/${t.projectId}/${arg}/stop`, { method: 'POST', headers: uiAuth() });
      console.log(`Arrêt demandé pour ${arg}.`);
      return 0;
    }
    case 'run':
      if (arg === 'repair') return runRepairCommand(home, positionals.slice(2));
      break;
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
