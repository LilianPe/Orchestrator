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
import { FactoryYmlError, loadFactoryBudgets, loadFactoryYml } from '../config/factory-yml.js';
import { homePaths, linearSettings, loadInstance, factoryHome, saveLinearTokens } from '../config/instance.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { createSmeeChannel } from '../relay/smee.js';
import { openStore } from '../store/open.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runStatusCommand, runStopCommand } from './control.js';
import { runInit } from './init.js';
import { runDoctorCommand } from './doctor.js';
import { runFlakyCommand } from './flaky.js';
import { formatPlan, planRows } from './plan.js';
import { runReplayCommand } from './replay.js';
import { runRepairCommand } from './repair.js';
import { runValidateCommand } from './validate.js';
import { PRODUCT_NAME } from '../product.js';

const USAGE = `Usage: factory <command>
  init               set up ${PRODUCT_NAME} for the current repository
  validate [repo]    check .factory/config.yml against the baseline (it can only add)
  doctor [repo] [--json] refuse a repository whose CI can expose secrets to the factory's branches
  up [--fake-runner] start ${PRODUCT_NAME} (interface on http://localhost:4100)
  plan               see which delegated tickets would be taken
  status             state of the running instance
  pause | resume     suspend or resume the queue
  stop <ID>          stop a ticket's run
  replay <journal>... replay exported journals (bit-for-bit regression, --what-if <workflow.yml>, --export <ID>)
  run repair <ID> [replay|skip|force] [<event>]  repair an event set aside (dead letter)
  flaky <project> [add <test> --reason <why> [--frozen] | remove <test>]  the known flaky tests verify marks indicative`;

/** Basic auth for an instance bound to a non-loopback host (FACTORY_UI_PASSWORD). */
function uiAuth(): Record<string, string> {
  const pw = process.env['FACTORY_UI_PASSWORD'];
  return pw ? { authorization: `Basic ${Buffer.from(`factory:${pw}`).toString('base64')}` } : {};
}

async function main(): Promise<number> {
  // Its own options, and no instance needed to replay a file (the CI has none).
  if (process.argv[2] === 'replay') return runReplayCommand(process.argv.slice(3));
  // Its own options, on the store alone.
  if (process.argv[2] === 'flaky') return runFlakyCommand(factoryHome(), process.argv.slice(3));
  // The repository's file and the budgets of factory.yml (ORC-216), its secrets left unresolved: no running instance needed.
  if (process.argv[2] === 'validate') return runValidateCommand({ repoPath: process.argv[3] ?? process.cwd(), out: (l) => console.log(l), factoryYml: () => ({ budgets: loadFactoryBudgets(factoryHome()) }) });
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'fake-runner': { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const [cmd, arg] = positionals;
  const home = factoryHome();
  // config.yaml only: factory.yml and its env: secrets are the daemon's, a plain shell may lack them.
  const cfg = loadInstance(home);
  const api = `http://127.0.0.1:${cfg.port}`;
  const control = { api, headers: uiAuth(), out: (l: string) => console.log(l) };

  switch (cmd) {
    case 'init': {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await runInit({
        home,
        cwd: process.cwd(),
        exec: execCmd,
        createSmee: () => createSmeeChannel(),
        io: {
          ask: async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def || '',
          confirm: async (q, def = false) => {
            const a = (await rl.question(`${q} ${def ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
            return a ? a.startsWith('y') || a.startsWith('o') : def;
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
      console.log(`${PRODUCT_NAME} is running: ${app.url}  (Ctrl+C to stop)`);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      });
      await app.stop();
      return 0;
    }
    case 'plan': {
      let linear;
      try {
        linear = linearSettings(home, loadFactoryYml(home));
      } catch (err) {
        if (!(err instanceof FactoryYmlError)) throw err;
        console.log(`${err.message}\n(plan reads the Linear credentials from factory.yml: run it with the daemon's environment.)`);
        return 1;
      }
      if (!linear?.accessToken || !linear.appUserId) {
        console.log('Linear not connected: run `factory up`, then connect Linear.');
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
    case 'status':
      return runStatusCommand(control);
    case 'pause':
    case 'resume':
      await fetch(`${api}/api/control/${cmd}`, { method: 'POST', headers: uiAuth() });
      console.log(cmd === 'pause' ? 'Queue paused.' : 'Queue resumed.');
      return 0;
    case 'stop':
      if (!arg) break;
      return runStopCommand(control, arg);
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
