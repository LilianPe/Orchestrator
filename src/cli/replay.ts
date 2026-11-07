import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from '../app/root.js';
import { homePaths, loadInstance, factoryHome } from '../config/instance.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { exportJournal, formatReplay, readJournal, replayJournal, type ReplayOptions } from '../runtime/replay.js';
import { DATABASE_URL_ENV, openStore } from '../store/open.js';

export const REPLAY_USAGE = `Usage: factory replay <journal.json | directory>... [--what-if <workflow.yml>] [--pack <directory>]
       factory replay --export <ID> [--project <id>] [--out <file>]
  Replays exported journals: without --what-if, each decision must give back, bit for bit, the recorded
  projection and effects; with --what-if, the decisions run on this workflow (laid over the pack)
  and the replay stops at the first divergence. --export writes the journal of a ticket of the instance.`;

export interface ReplayIo {
  print(line: string): void;
  /** Where `--export` finds the instance (`FACTORY_HOME`, `FACTORY_DATABASE_URL`). */
  env: NodeJS.ProcessEnv;
}

/** `.json` files of the paths given, a folder read in name order; a missing path is kept, and reported as unreadable. */
function journalFiles(paths: string[]): string[] {
  return paths.flatMap((p) =>
    existsSync(p) && statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => join(p, f))
      : [p],
  );
}

/**
 * The journal of a ticket of the instance. Postgres is opened without migration (the daemon's to
 * run); SQLite only when its file exists, as its store creates any table it lacks on opening.
 */
async function exportFromInstance(env: NodeJS.ProcessEnv, ticketId: string, projectId: string | undefined): Promise<unknown> {
  const home = factoryHome(env);
  const projects = loadInstance(home).projects;
  const project = projectId ?? (projects.length === 1 ? projects[0]!.id : undefined);
  if (!project) throw new Error(`give --project (${projects.map((p) => p.id).join(', ') || 'no project configured'})`);
  const sqlitePath = homePaths(home).db;
  if (!env[DATABASE_URL_ENV]?.trim() && !existsSync(sqlitePath)) throw new Error(`no instance database: neither ${DATABASE_URL_ENV} nor ${sqlitePath}`);
  const { store } = await openStore({ env, sqlitePath, migrationsFolder: join(repoRoot(), 'drizzle'), migrate: false });
  try {
    const journal = await exportJournal(store, project, ticketId);
    if (journal.entries.length === 0) throw new Error(`no event journaled for ${ticketId} in the project ${project}`);
    return journal;
  } finally {
    await store.close();
  }
}

/** Replays the given journals: 0 without divergence, 1 when one diverges, 2 when one cannot be read or replays nothing. */
function replayFiles(paths: string[], options: ReplayOptions, io: ReplayIo): number {
  const files = journalFiles(paths);
  if (files.length === 0) {
    io.print('No journal to replay.');
    return 2;
  }
  let diverged = 0;
  let broken = 0;
  for (const file of files) {
    try {
      const report = replayJournal(readJournal(readFileSync(file, 'utf8'), file), options);
      io.print(`${file}: ${formatReplay(report)}`);
      if (report.divergences.length > 0) diverged++;
      // A journal with no decision to compare checks nothing: refused, not passed.
      else if (report.replayed === 0) broken++;
    } catch (err) {
      io.print(`${file}: unreadable or impossible to replay: ${(err as Error).message}`);
      broken++;
    }
  }
  const failed = diverged + broken;
  io.print(failed === 0 ? `${files.length} journal(s) replayed without divergence.` : `${diverged} journal(s) of ${files.length} diverge, ${broken} in error or without decisions.`);
  return broken > 0 ? 2 : diverged > 0 ? 1 : 0;
}

/**
 * `factory replay` (ORC-174). Exit code 0 when every journal replays without divergence, 1 when one
 * diverges, 2 on a usage error, a journal that cannot be read or replayed, or one without a decision.
 */
export async function runReplayCommand(argv: string[], io: ReplayIo = { print: (l) => console.log(l), env: process.env }): Promise<number> {
  let args;
  try {
    args = parseArgs({
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
  } catch (err) {
    io.print(`${(err as Error).message}
${REPLAY_USAGE}`);
    return 2;
  }
  const { positionals, values } = args;
  if (values.export) {
    const journal = await exportFromInstance(io.env, values.export, values.project);
    const text = `${JSON.stringify(journal, null, 2)}
`;
    if (values.out) {
      writeFileSync(values.out, text);
      io.print(`Journal of ${values.export} written to ${values.out}.`);
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
  return replayFiles(positionals, options, io);
}
