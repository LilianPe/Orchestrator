import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GhCliForge } from '../adapters/forge/gh-cli.js';
import { GitHubAppForge } from '../adapters/forge/github-app.js';
import { repoRoot } from '../app/root.js';
import { FactoryYmlError, loadFactoryYml } from '../config/factory-yml.js';
import { resolveGithubApp } from '../config/github-app.js';
import { effectiveInstance, homePaths } from '../config/instance.js';
import { BASELINE_DAYS, BASELINE_MEASURES, DAY_MS, baselinePeriod, computeBaseline, type BaselineMeasure, type BaselineValue, type CompletedIssue, type MergedPr } from '../core/baseline.js';
import { openStore } from '../store/open.js';
import type { Store } from '../store/types.js';
import { cliLinearTracker } from './linear.js';

export const BASELINE_USAGE = `Usage: factory baseline <project> --since <YYYY-MM-DD> [--replace]
  Freezes the state of reference the overview compares with: the ${BASELINE_DAYS} days before the factory's start (the
  day given, UTC, left out), read from the project's Linear team and GitHub repository. One row per measure, in the store.
  --replace   compute the same period again, in place of the stored one`;

export interface BaselineOptions {
  store: Store;
  /** Linear and GitHub, as the adapters read them. */
  sources: {
    completedIssues(teamKey: string, since: number, until: number): Promise<CompletedIssue[]>;
    mergedPrs(repoPath: string, since: number, until: number): Promise<MergedPr[]>;
  };
  project: { id: string; repoPath: string; teamKey: string };
  /** The factory's start: the baseline covers the 90 days before it. */
  start: number;
  replace: boolean;
  now: number;
  print: (line: string) => void;
}

/** A calendar day, `YYYY-MM-DD`, as its UTC midnight; undefined for anything else. */
export function parseStartDate(raw: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return undefined;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(at).toISOString().startsWith(raw) ? at : undefined;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const orDash = (v: number | null, format: (n: number) => string) => (v === null ? '—' : format(v));

/** A measure as the command prints it. */
function line(measure: BaselineMeasure, r: BaselineValue): string {
  switch (measure) {
    case 'delivered':
      return `  Delivered: ${r.value} (of ${plural(r.over, 'issue')} completed)`;
    case 'lead_time':
      return `  Median lead time: ${orDash(r.value, (v) => `${(v / DAY_MS).toFixed(1)} days`)} (over ${plural(r.over, 'delivered issue')}${r.leftOut ? `, ${r.leftOut} without a start` : ''})`;
    case 'tokens_per_merged':
      return '  Tokens per merged ticket: no source (human work)';
    case 'first_try':
      return `  Ready at the first try: ${orDash(r.value, (v) => `${Math.round(v * 100)}%`)} (of ${plural(r.over, 'merged PR')})`;
  }
}

/**
 * `factory baseline` (ORC-230): the 90 days before the factory's start, read from the project's Linear team and GitHub
 * repository, frozen in the store, one row per measure. The same period again is refused unless `replace`: a baseline is
 * what the factory is measured against, never recomputed by accident; its figures are printed once stored, never figures
 * that are not the stored ones. A start still to come is refused: its period would not have happened yet.
 */
export async function runBaseline(o: BaselineOptions): Promise<number> {
  const period = baselinePeriod(o.start);
  if (period.until > o.now) {
    o.print(`The start ${day(o.start)} is still to come: the baseline is the ${BASELINE_DAYS} days before the factory started.`);
    return 1;
  }
  const [issues, prs] = await Promise.all([o.sources.completedIssues(o.project.teamKey, period.since, period.until), o.sources.mergedPrs(o.project.repoPath, period.since, period.until)]);
  const baseline = computeBaseline(o.project.id, period, issues, prs, o.now);
  const span = `${day(period.since)} → ${day(period.until)}`;
  if (!(await o.store.putBaseline(baseline, o.replace))) {
    o.print(`A baseline of ${o.project.id} over ${span} is already stored: --replace to compute it again.`);
    return 1;
  }
  o.print(`Baseline of ${o.project.id} over ${span} (${BASELINE_DAYS} days), from Linear ${o.project.teamKey} and GitHub:`);
  for (const measure of BASELINE_MEASURES) o.print(line(measure, baseline.measures[measure]!));
  o.print('Stored.');
  return 0;
}

/** The command line: `factory baseline <project> --since <YYYY-MM-DD> [--replace]`, on the daemon's credentials and store. */
export async function runBaselineCommand(home: string, args: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: [...args], allowPositionals: true, options: { since: { type: 'string' }, replace: { type: 'boolean' } } });
  const start = values.since === undefined ? undefined : parseStartDate(values.since);
  if (positionals.length !== 1 || start === undefined) {
    console.log(BASELINE_USAGE);
    return 1;
  }
  let yml;
  try {
    yml = loadFactoryYml(home);
  } catch (err) {
    if (!(err instanceof FactoryYmlError)) throw err;
    console.log(`${err.message}\n(baseline reads the Linear and GitHub credentials from factory.yml: run it with the daemon's environment.)`);
    return 1;
  }
  const instance = effectiveInstance(home, yml);
  const project = instance.projects.find((p) => p.id === positionals[0]);
  if (!project) {
    console.log(`No project ${positionals[0]}: one of ${instance.projects.map((p) => p.id).join(', ') || '(none)'}.`);
    return 1;
  }
  const tracker = cliLinearTracker(home, yml);
  if (typeof tracker === 'string') {
    console.log(tracker);
    return 1;
  }
  // The forge the daemon would use: the GitHub App when configured, otherwise the gh CLI.
  let githubApp;
  try {
    githubApp = resolveGithubApp(instance);
  } catch (err) {
    console.log((err as Error).message);
    return 1;
  }
  const forge = githubApp ? new GitHubAppForge(githubApp) : new GhCliForge();
  // The daemon migrates the schema; this only writes rows.
  const { store } = await openStore({ env: process.env, sqlitePath: homePaths(home).db, migrationsFolder: join(repoRoot(), 'drizzle'), migrate: false });
  try {
    return await runBaseline({
      store,
      sources: { completedIssues: (...a) => tracker.completedIssues(...a), mergedPrs: (...a) => forge.mergedPrs(...a) },
      project: { id: project.id, repoPath: project.repoPath, teamKey: project.linearTeamKey },
      start,
      replace: !!values.replace,
      now: Date.now(),
      print: (s) => console.log(s),
    });
  } finally {
    await store.close();
  }
}
