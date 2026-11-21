#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { execCmd } from '../adapters/exec.js';
import { startFactory } from '../app/bootstrap.js';
import { loadFactoryLimits } from '../config/factory-yml.js';
import { homePaths, loadInstance, factoryHome } from '../config/instance.js';
import { createSmeeChannel } from '../relay/smee.js';
import { runBaselineCommand } from './baseline.js';
import { runDryRunCommand, runStatusCommand, runStopCommand } from './control.js';
import { instanceCards, runInit } from './init.js';
import { runDoctorCommand } from './doctor.js';
import { runFlakyCommand } from './flaky.js';
import { runGhostCommand } from './ghost.js';
import { runReplayCommand } from './replay.js';
import { runRepairCommand } from './repair.js';
import { runValidateCommand } from './validate.js';
import { PRODUCT_NAME } from '../product.js';
import { COMMANDS, USAGE } from './usage.js';

async function main(): Promise<number> {
  // Its own options, and no instance needed to replay a file (the CI has none).
  if (process.argv[2] === 'replay') return runReplayCommand(process.argv.slice(3));
  // Its own options, on the store alone.
  if (process.argv[2] === 'flaky') return runFlakyCommand(process.argv.slice(3));
  // Its own options; Linear, GitHub and the store, no running instance needed.
  if (process.argv[2] === 'baseline') return runBaselineCommand(factoryHome(), process.argv.slice(3));
  // Its own options, on the store and the projects; GitHub through the App, no running instance needed (ORC-231).
  if (process.argv[2] === 'ghost') return runGhostCommand(factoryHome(), process.argv.slice(3));
  // Its own option, `--dev` (ORC-411): a Smee channel without a public URL.
  if (process.argv[2] === 'init') return runInitCommand(process.argv.slice(3));
  // The repository's file, the budgets, max_diff and tools of factory.yml (ORC-216, ORC-381, ORC-383), its secrets left unresolved: no running instance needed.
  if (process.argv[2] === 'validate') return runValidateCommand({ repoPath: process.argv[3] ?? process.cwd(), out: (l) => console.log(l), factoryYml: () => loadFactoryLimits(factoryHome()) });
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  });
  const [cmd, arg] = positionals;
  // The help, before any configuration is read: `factory` alone, or a command it does not have (`plan`, `pause` and `resume`
  // are gone, ORC-200).
  if (cmd === undefined || !COMMANDS.has(cmd)) {
    if (cmd !== undefined) console.log(`Unknown command: ${cmd}`);
    console.log(USAGE);
    return 1;
  }
  const home = factoryHome();
  // config.yaml only: factory.yml and its env: secrets are the daemon's, a plain shell may lack them.
  const cfg = loadInstance(home);
  const api = `http://127.0.0.1:${cfg.port}`;
  // No credential: on the server, the daemon's socket in FACTORY_HOME, its file mode the guard (ORC-405); else HTTP on the
  // loopback, where an exposed daemon asks for a GitHub sign-in (ORC-399), which only the dashboard gives.
  const control = { api, ...(process.platform === 'win32' ? {} : { socket: homePaths(home).socket }), out: (l: string) => console.log(l) };

  switch (cmd) {
    case 'doctor':
      return runDoctorCommand({ repoPath: arg ?? process.cwd(), home, json: values.json });
    case 'up': {
      const app = await startFactory({ home });
      console.log(`${PRODUCT_NAME} is running: ${app.url}  (Ctrl+C to stop)`);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      });
      await app.stop();
      return 0;
    }
    case 'status':
      return runStatusCommand(control);
    case 'stop':
      if (!arg) break;
      return runStopCommand(control, arg);
    case 'dry-run':
      if (!arg) break;
      return runDryRunCommand(control, arg);
    case 'run':
      if (arg === 'repair') return runRepairCommand(positionals.slice(2));
      break;
  }
  console.log(USAGE);
  return 1;
}

async function runInitCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { dev: { type: 'boolean' } } });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const home = factoryHome();
  await runInit({
    home,
    cwd: process.cwd(),
    dev: values.dev,
    exec: execCmd,
    createSmee: () => createSmeeChannel(),
    storeCards: instanceCards,
    io: {
      ask: async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def || '',
      print: (s) => console.log(s),
    },
  });
  rl.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
