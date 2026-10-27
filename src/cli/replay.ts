import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from '../app/root.js';
import { homePaths, loadInstance, factoryHome } from '../config/instance.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { exportJournal, formatReplay, readJournal, replayJournal, type ReplayOptions } from '../runtime/replay.js';
import { openStore } from '../store/open.js';

export const REPLAY_USAGE = `Usage : factory replay <journal.json | dossier>... [--what-if <workflow.yml>] [--pack <dossier>]
        factory replay --export <ID> [--project <id>] [--out <fichier>]
  Rejoue des journaux exportés : sans --what-if, chaque décision doit redonner bit à bit la projection
  et les effets enregistrés ; avec --what-if, les décisions tournent sur ce workflow (posé sur le pack)
  et le rejeu s'arrête à la première divergence. --export écrit le journal d'un ticket de l'instance.`;

export interface ReplayIo {
  print(line: string): void;
  /** Where `--export` finds the instance (`FACTORY_HOME`, `FACTORY_DATABASE_URL`). */
  env: NodeJS.ProcessEnv;
}

/** `.json` files of the paths given, a folder read in name order. */
function journalFiles(paths: string[]): string[] {
  return paths.flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => join(p, f))
      : [p],
  );
}

/** The instance's store, read-only: the daemon migrates it. */
async function exportFromInstance(env: NodeJS.ProcessEnv, ticketId: string, projectId: string | undefined): Promise<unknown> {
  const home = factoryHome(env);
  const projects = loadInstance(home).projects;
  const project = projectId ?? (projects.length === 1 ? projects[0]!.id : undefined);
  if (!project) throw new Error(`précisez --project (${projects.map((p) => p.id).join(', ') || 'aucun projet configuré'})`);
  const { store } = await openStore({ env, sqlitePath: homePaths(home).db, migrationsFolder: join(repoRoot(), 'drizzle'), migrate: false });
  try {
    return await exportJournal(store, project, ticketId);
  } finally {
    await store.close();
  }
}

/**
 * `factory replay` (ORC-174). Exit code 0 when every journal replays without divergence, 1 when one
 * diverges, 2 on a usage error.
 */
export async function runReplayCommand(argv: string[], io: ReplayIo = { print: (l) => console.log(l), env: process.env }): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'what-if': { type: 'string' },
      pack: { type: 'string' },
      export: { type: 'string' },
      project: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (values.export) {
    const journal = await exportFromInstance(io.env, values.export, values.project);
    const text = `${JSON.stringify(journal, null, 2)}\n`;
    if (values.out) {
      writeFileSync(values.out, text);
      io.print(`Journal de ${values.export} écrit dans ${values.out}.`);
    } else io.print(text.trimEnd());
    return 0;
  }
  if (positionals.length === 0) {
    io.print(REPLAY_USAGE);
    return 2;
  }
  const options: ReplayOptions = values['what-if']
    ? { mode: 'what-if', workflow: loadWorkflow({ packDir: values.pack ?? join(repoRoot(), 'packs/standard'), projectFile: values['what-if'] }) }
    : { mode: 'regression' };
  const files = journalFiles(positionals);
  if (files.length === 0) {
    io.print('Aucun journal à rejouer.');
    return 2;
  }
  let diverged = 0;
  for (const file of files) {
    const report = replayJournal(readJournal(readFileSync(file, 'utf8'), file), options);
    io.print(`${file} : ${formatReplay(report)}`);
    if (report.divergences.length > 0) diverged++;
  }
  io.print(diverged === 0 ? `${files.length} journal(aux) rejoué(s) sans divergence.` : `${diverged} journal(aux) sur ${files.length} divergent.`);
  return diverged === 0 ? 0 : 1;
}
