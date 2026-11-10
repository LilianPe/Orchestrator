import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { execCmd, mustExec } from '../adapters/exec.js';
import { repoRoot } from '../app/root.js';
import { homePaths, loadInstance } from '../config/instance.js';
import { cloneAtStart, knowledgeAt } from '../ghost/history.js';
import { blindPairs, ghostReport, GRADE_LABELS, GRADES, KEPT_PR, parseThreshold, type GhostGrade, type GhostReplay, type GhostSide, type GhostTicket } from '../ghost/replay.js';
import { projectEffects } from '../presets/fantome.js';
import { openStore } from '../store/open.js';
import type { Store } from '../store/types.js';

export const GHOST_USAGE = `Usage: factory ghost <command>
  start <project> --threshold <share> --tickets <ID>=<PR>,... [--memory off] [--id <replay>]
              write the replay and its threshold (0.6, or 60%: the share of the factory's PRs to be mergeable), before any
              ticket runs; then rebuild each ticket at the parent of its PR's merge commit. The threshold never changes after.
  collect <replay>  read what each ticket ran to on the project without effects: its kept PR, its cost, its assumptions
  judge <replay> [--judge <name>]  the blind screen: each pair as PR A and PR B, graded 1 mergeable as is, 2 after edits, 3 to reject
  report <replay>   ticket by ticket, environment failures apart, the total cost and the verdict against the threshold
  list              the replays, the last started first`;

/** The human PR of a replayed ticket, as the forge has it: merged, its merge commit and its diff. */
export interface HumanPr {
  number: number;
  url: string;
  author: string;
  mergeSha?: string;
  diff: string;
}

export interface GhostOptions {
  args: readonly string[];
  store: Store;
  print: (line: string) => void;
  now: () => number;
  /** Who starts or judges, recorded with what they do. */
  user: string;
  newId: () => string;
  /** Where each replay keeps its tickets' environments: `<dir>/<replay>/<ticket>/`. */
  dir: string;
  /** The instance's projects: a replay runs on one without effects only. */
  projects: readonly { id: string; repoPath: string; noEffect: boolean }[];
  humanPr(repoPath: string, number: number): Promise<HumanPr>;
  /**
   * The ticket's environment as the human found it (`ghost/history.ts`), in `dir`: the clone at the parent of `mergeSha`, then the
   * knowledge base at its last commit before that start, unless `memory` is off. Throws when it cannot be rebuilt.
   */
  environment(o: { ticketId: string; repoPath: string; mergeSha: string; dir: string; memory: boolean }): Promise<{ start: string; knowledge?: string }>;
  /** A line typed by the judge. */
  ask(question: string): Promise<string>;
}

/** Says why, and exits 1. */
function refuse(o: GhostOptions, why: string): number {
  o.print(why);
  return 1;
}

const percent = (v: number) => `${Math.round(v * 1000) / 10}%`;
const dollars = (v: number) => `$${v.toFixed(2)}`;

/** `REL-1=12,REL-2=34`: each ticket and its human PR's number; undefined when one is malformed. */
function parseTickets(raw: string | undefined): { ticketId: string; pr: number }[] | undefined {
  const pairs = (raw ?? '').split(',').filter(Boolean).map((p) => /^([A-Za-z][\w]*-\d+)=#?(\d+)$/.exec(p.trim()));
  if (!pairs.length || pairs.some((m) => !m)) return undefined;
  return pairs.map((m) => ({ ticketId: m![1]!, pr: Number(m![2]) }));
}

/**
 * `factory ghost` (ORC-231): the replay of closed tickets. `start` writes the replay with its threshold before anything runs, and
 * rebuilds each ticket's environment; the tickets run on a project without effects (`effects: none`, the `factory/fantome` preset),
 * whose PRs stay artifacts; `collect` reads them back; `judge` grades the pairs blind; `report` says how the factory did.
 */
export async function runGhost(o: GhostOptions): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...o.args],
    allowPositionals: true,
    options: { threshold: { type: 'string' }, tickets: { type: 'string' }, memory: { type: 'string' }, id: { type: 'string' }, judge: { type: 'string' } },
  });
  const [cmd, arg] = positionals;
  if (cmd === 'list') return list(o);
  if (!arg) return refuse(o, GHOST_USAGE);
  switch (cmd) {
    case 'start':
      return start(o, arg, values);
    case 'collect':
      return collect(o, arg);
    case 'judge':
      return judge(o, arg, values.judge ?? o.user);
    case 'report':
      return report(o, arg);
    default:
      return refuse(o, GHOST_USAGE);
  }
}

async function list(o: GhostOptions): Promise<number> {
  const replays = await o.store.ghostReplays();
  if (!replays.length) o.print('No replay yet.');
  for (const r of replays) o.print(`${r.id}  ${r.projectId}  ${r.tickets.length} tickets  threshold ${percent(r.threshold)}  started ${new Date(r.startedAt).toISOString()} by ${r.startedBy}`);
  return 0;
}

async function start(o: GhostOptions, projectId: string, values: { threshold?: string | undefined; tickets?: string | undefined; memory?: string | undefined; id?: string | undefined }): Promise<number> {
  const threshold = parseThreshold(values.threshold);
  if (threshold === undefined) {
    o.print(`${values.threshold === undefined ? 'No threshold' : `No threshold in « ${values.threshold} »`}: --threshold is required, a share (0.6) or a percentage (60%) of the factory's PRs to be mergeable, written before the replay and never changed after (ORC-143).`);
    return 1;
  }
  const tickets = parseTickets(values.tickets);
  if (!tickets) {
    o.print('--tickets: each ticket and its human PR, as REL-1=12,REL-2=34.');
    return 1;
  }
  if (values.memory !== undefined && values.memory !== 'on' && values.memory !== 'off') return refuse(o, '--memory: on or off.');
  const project = o.projects.find((p) => p.id === projectId);
  if (!project) return refuse(o, `No project ${projectId}.`);
  if (!project.noEffect) {
    o.print(`${projectId} has effects: a replay runs on a project with \`effects: none\` or the factory/fantome preset, which push nothing, open no PR and write no comment.`);
    return 1;
  }
  // Every PR read before anything is written: a replay is never left half-made by a ticket that cannot be replayed.
  const prs = new Map<string, HumanPr>();
  for (const t of tickets) {
    const pr = await o.humanPr(project.repoPath, t.pr);
    if (!pr.mergeSha) return refuse(o, `${t.ticketId}: PR #${t.pr} is not merged, there is no human work to compare with.`);
    prs.set(t.ticketId, pr);
  }
  const replay: GhostReplay = {
    id: values.id ?? o.newId(),
    projectId,
    threshold,
    memory: values.memory !== 'off',
    seed: randomUUID(),
    tickets: tickets.map((t) => t.ticketId),
    startedAt: o.now(),
    startedBy: o.user,
  };
  if (!(await o.store.putGhostReplay(replay))) {
    o.print(`A replay ${replay.id} exists already: its threshold was written when it started, and stays as it is.`);
    return 1;
  }
  o.print(`Replay ${replay.id} of ${projectId}: threshold ${percent(threshold)}, written now and never changed; memory ${replay.memory ? 'on' : 'off'}.`);
  for (const { ticketId } of tickets) {
    const pr = prs.get(ticketId)!;
    const base: GhostTicket = {
      replayId: replay.id, ticketId, humanPr: { number: pr.number, url: pr.url, author: pr.author }, mergeSha: pr.mergeSha!,
      // The dry run on the start commit is ORC-208's (criterion 3): until it exists, the environment is not checked, and the report says so.
      env: 'unchecked', outcome: 'no_pr', costUsd: 0, assumptions: 0, at: o.now(),
    };
    try {
      const env = await o.environment({ ticketId, repoPath: project.repoPath, mergeSha: pr.mergeSha!, dir: join(o.dir, replay.id, ticketId), memory: replay.memory });
      await o.store.putGhostTicket({ ...base, start: env.start, ...(env.knowledge ? { knowledge: env.knowledge } : {}) });
      o.print(`  ${ticketId}: at ${env.start.slice(0, 12)}, the parent of PR #${pr.number}'s merge commit${env.knowledge ? `; knowledge base at ${env.knowledge.slice(0, 12)}` : ''}.`);
    } catch (err) {
      await o.store.putGhostTicket({ ...base, env: 'failed', envReason: (err as Error).message });
      o.print(`  ${ticketId}: environment not rebuilt (${(err as Error).message}): counted apart, out of the comparison.`);
    }
  }
  o.print('Environments not checked by a dry run yet (ORC-208): the report counts them as unchecked.');
  return 0;
}

async function replayOf(o: GhostOptions, id: string): Promise<GhostReplay | undefined> {
  const replay = await o.store.ghostReplay(id);
  if (!replay) o.print(`No replay ${id}.`);
  return replay;
}

/** What each ticket ran to on the replay's project: its PR kept (the last one), its runs' cost, the assumptions of its spec. */
async function collect(o: GhostOptions, id: string): Promise<number> {
  const replay = await replayOf(o, id);
  if (!replay) return 1;
  for (const t of await o.store.ghostTickets(id)) {
    if (t.env === 'failed') continue;
    const [state, runs, artifacts] = await Promise.all([o.store.getTicket(replay.projectId, t.ticketId), o.store.ticketRuns(replay.projectId, t.ticketId), o.store.artifacts(t.ticketId)]);
    const pr = artifacts.filter((a) => a.kind === KEPT_PR).at(-1);
    const outcome: GhostTicket['outcome'] = pr ? 'pr' : state?.blocked ? 'blocked' : 'no_pr';
    const { factoryPr: _, ...rest } = t;
    const assumptions = state?.spec?.spec.assumed?.length ?? state?.assumed?.length ?? 0;
    await o.store.putGhostTicket({ ...rest, outcome, ...(pr ? { factoryPr: pr.id } : {}), costUsd: runs.reduce((s, r) => s + r.costUsd, 0), assumptions, at: o.now() });
    o.print(`  ${t.ticketId}: ${outcome === 'pr' ? 'a PR kept' : outcome === 'blocked' ? 'blocked' : 'no PR yet'}, ${dollars(runs.reduce((s, r) => s + r.costUsd, 0))}, ${assumptions} assumption(s).`);
  }
  return 0;
}

/** The diff of one side of a pair: the factory's from its kept PR, the human's from the forge. */
async function diffOf(o: GhostOptions, replay: GhostReplay, t: GhostTicket, side: GhostSide): Promise<string> {
  if (side === 'human') {
    const repoPath = o.projects.find((p) => p.id === replay.projectId)?.repoPath ?? '';
    return (await o.humanPr(repoPath, t.humanPr.number)).diff;
  }
  const kept = (await o.store.artifacts(t.ticketId)).find((a) => a.id === t.factoryPr);
  if (!kept) return '(the kept PR is gone)';
  return ((JSON.parse(await readFile(kept.path, 'utf8')) as { pr?: { diff?: string } }).pr?.diff ?? '').trim() || '(no diff)';
}

const GRID = GRADES.map((g, i) => `${i + 1} ${GRADE_LABELS[g]}`).join(' · ');

/** A grade on the grid, asked until the answer is one. */
async function gradeOf(o: GhostOptions, label: string): Promise<GhostGrade> {
  for (;;) {
    const answer = (await o.ask(`${label} (${GRID}): `)).trim();
    const g = GRADES[Number(answer) - 1];
    if (/^[123]$/.test(answer) && g) return g;
    o.print(`« ${answer} » is not on the grid: ${GRID}.`);
  }
}

/**
 * Criterion 5, the blind screen: each pair in the replay's drawn order, its two PRs as A and B, their diffs only (a branch, a
 * description or an author would tell whose it is), graded one by one on the fixed grid. A PR graded keeps its grade.
 */
async function judge(o: GhostOptions, id: string, judgeName: string): Promise<number> {
  const replay = await replayOf(o, id);
  if (!replay) return 1;
  const tickets = await o.store.ghostTickets(id);
  const done = new Set((await o.store.ghostJudgments(id)).map((j) => `${j.ticketId}:${j.side}`));
  const pairs = blindPairs(replay, tickets, judgeName).filter((p) => !done.has(`${p.ticketId}:${p.a}`) || !done.has(`${p.ticketId}:${p.b}`));
  if (!pairs.length) {
    o.print(`Nothing left to judge in ${id} for ${judgeName}.`);
    return 0;
  }
  for (const [i, pair] of pairs.entries()) {
    const t = tickets.find((x) => x.ticketId === pair.ticketId)!;
    o.print(`\n=== Pair ${i + 1} of ${pairs.length} · ${pair.ticketId} ===`);
    const sides = [['A', pair.a], ['B', pair.b]] as const;
    for (const [label, side] of sides) o.print(`\n--- PR ${label} ---\n${await diffOf(o, replay, t, side)}`);
    o.print(`\nGrade each PR: ${GRID}.`);
    for (const [label, side] of sides) {
      if (done.has(`${pair.ticketId}:${side}`)) continue;
      const grade = await gradeOf(o, `PR ${label}`);
      await o.store.putGhostJudgment({ replayId: id, ticketId: pair.ticketId, side, grade, judge: judgeName, at: o.now() });
    }
  }
  o.print(`\nAll the pairs of ${id} are graded.`);
  return 0;
}

async function report(o: GhostOptions, id: string): Promise<number> {
  const replay = await replayOf(o, id);
  if (!replay) return 1;
  const r = ghostReport(replay, await o.store.ghostTickets(id), await o.store.ghostJudgments(id));
  const show = (g: string | null) => (g === null ? '—' : g in GRADE_LABELS ? GRADE_LABELS[g as GhostGrade] : g.replace('_', ' '));
  o.print(`Replay ${replay.id} of ${replay.projectId}, started ${new Date(replay.startedAt).toISOString()} by ${replay.startedBy}, threshold ${percent(replay.threshold)}, memory ${replay.memory ? 'on' : 'off'}.`);
  for (const row of r.rows) o.print(`  ${row.ticketId}  factory: ${show(row.factory)}  human: ${show(row.human)}  ${row.assumptions} assumption(s)  ${dollars(row.costUsd)}  (${row.humanPr}${row.start ? `, from ${row.start.slice(0, 12)}` : ''})`);
  o.print(`Environment failures (out of the comparison): ${r.envFailures.length ? r.envFailures.map((f) => `${f.ticketId} (${f.envReason})`).join(', ') : 'none'}.`);
  if (r.envUnchecked) o.print(`Environments not checked by a dry run: ${r.envUnchecked} (ORC-208).`);
  o.print(`Mergeable factory PRs: ${r.mergeable} of ${r.compared} compared (${percent(r.share)}), threshold ${percent(r.threshold)}.${r.unjudged ? ` ${r.unjudged} pair(s) still to judge.` : ''}`);
  o.print(`Assumptions written in the specs: ${r.assumptions}.`);
  o.print(`Total cost: ${dollars(r.totalCostUsd)}.`);
  o.print(`Verdict: ${r.verdict}.`);
  return 0;
}

/** The forge's view of a merged PR, through `gh` in the project's checkout. */
async function ghHumanPr(repoPath: string, number: number): Promise<HumanPr> {
  const view = JSON.parse(await mustExec(execCmd, 'gh', ['pr', 'view', String(number), '--json', 'number,url,author,mergeCommit'], { cwd: repoPath })) as {
    number: number; url: string; author?: { login?: string }; mergeCommit?: { oid?: string } | null;
  };
  const diff = await mustExec(execCmd, 'gh', ['pr', 'diff', String(number)], { cwd: repoPath });
  return { number: view.number, url: view.url, author: view.author?.login ?? '', ...(view.mergeCommit?.oid ? { mergeSha: view.mergeCommit.oid } : {}), diff };
}

/** The command line, on the instance's store and projects; the PRs read through `gh`, the clones from each project's origin. */
export async function runGhostCommand(home: string, args: readonly string[]): Promise<number> {
  const instance = loadInstance(home);
  // The daemon migrates the schema; this only reads and writes rows.
  const { store } = await openStore({ env: process.env, sqlitePath: homePaths(home).db, migrationsFolder: join(repoRoot(), 'drizzle'), migrate: false });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let user = 'cli';
    try {
      user = userInfo().username || user;
    } catch {
      // No user name (a container without passwd entry): recorded as `cli`.
    }
    return await runGhost({
      args, store, user, print: (l) => console.log(l), now: () => Date.now(), newId: () => `ghost-${randomUUID().slice(0, 8)}`,
      dir: join(home, 'ghost'),
      projects: instance.projects.map((p) => ({ id: p.id, repoPath: p.repoPath, noEffect: projectEffects(p) === 'none' })),
      humanPr: ghHumanPr,
      environment: async ({ repoPath, mergeSha, dir, memory }) => {
        const remote = (await mustExec(execCmd, 'git', ['-C', repoPath, 'remote', 'get-url', 'origin'])).trim();
        const start = await cloneAtStart({ remote, mergeSha, dir: join(dir, 'repo') });
        if (!memory || !instance.knowledge) return { start };
        // Transaction time: the knowledge base as it stood when the start commit was made.
        const at = Number((await mustExec(execCmd, 'git', ['-C', join(dir, 'repo'), 'log', '-1', '--format=%ct', start])).trim()) * 1000;
        const knowledge = await knowledgeAt({ repo: instance.knowledge.repoPath, before: at, dir: join(dir, 'knowledge') });
        return { start, ...(knowledge ? { knowledge } : {}) };
      },
      ask: (q) => rl.question(q),
    });
  } finally {
    rl.close();
    await store.close();
  }
}
