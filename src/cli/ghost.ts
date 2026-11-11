import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { execCmd, mustExec } from '../adapters/exec.js';
import { repoRoot } from '../app/root.js';
import { homePaths, loadInstance } from '../config/instance.js';
import { originHeadOf } from '../adapters/workspace/git-workspaces.js';
import { HOST_RUNS_REFUSED, SANDBOXES_META } from '../ghost/delegate.js';
import { asRepository, cloneAtStart, knowledgeAt, startTime } from '../ghost/history.js';
import { blindPairs, ghostReport, GRADE_LABELS, GRADES, parseThreshold, type GhostGrade, type GhostReplay, type GhostSide, type GhostTicket } from '../ghost/replay.js';
import { isFantome } from '../presets/fantome.js';
import { openStore } from '../store/open.js';
import { KEPT_PR, type Store } from '../store/types.js';

export const GHOST_USAGE = `Usage: factory ghost <command>
  start <project> --threshold <share> --as-is <share> --tickets <ID>=<PR>,... [--memory off] [--id <replay>]
              write the replay and its two thresholds, shares of the compared tickets (0.6, or 60%: the factory's PRs to be
              mergeable, as is or after edits; --as-is, those to be mergeable as is), before any ticket runs; then rebuild each
              ticket at the parent of its PR's merge commit, which the daemon delegates to the project on factory/fantome,
              with sandboxes only. The thresholds never change after.
  collect <replay>  read what each ticket ran to on the project without effects: its kept PR, its cost, its assumptions
  judge <replay> --judge <GitHub login>  the blind screen: each pair as PR A and PR B, graded 1 mergeable as is, 2 after edits,
              3 to reject; the PRs the judge wrote are left to another judge
  report <replay>   ticket by ticket, environment failures apart, the total cost and the verdict against both thresholds
  list              the replays, the last started first`;

/** The human PR of a replayed ticket, as the forge has it: its author's login, its merge commit, its commits' headlines oldest first. */
export interface HumanPr {
  number: number;
  url: string;
  author: string;
  mergeSha?: string;
  commits: string[];
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
  /** The instance's projects: a replay runs on one on the `factory/fantome` preset only, which has no effects. */
  projects: readonly { id: string; repoPath: string; fantome: boolean }[];
  /**
   * Whether the daemon's runs have sandboxes, as it said at its last start (ORC-376); undefined when no daemon has said yet. A replay
   * runs with sandboxes only: on the host, the agent could push by itself.
   */
  sandboxes(): Promise<boolean | undefined>;
  humanPr(repoPath: string, number: number): Promise<HumanPr>;
  /** The diff of a human PR, read when it is judged. */
  humanDiff(repoPath: string, number: number): Promise<string>;
  /**
   * The ticket's environment as the human found it (`ghost/history.ts`), in `dir`: the clone at the parent of `mergeSha` (before the
   * first of `prCommits` for a rebase merge), then the knowledge base at its last commit before that start, unless `memory` is off.
   * Throws when it cannot be rebuilt.
   */
  environment(o: { ticketId: string; repoPath: string; mergeSha: string; prCommits: readonly string[]; dir: string; memory: boolean }): Promise<{ start: string; knowledge?: string }>;
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
/** The as-is threshold, not set on a replay recorded with one threshold (before ORC-385). */
const asIsLabel = (r: GhostReplay) => (r.asIsThreshold === undefined ? 'not set' : percent(r.asIsThreshold));
const thresholds = (r: GhostReplay) => `thresholds ${percent(r.threshold)} mergeable, as is ${asIsLabel(r)}`;

/** A threshold `start` requires (ORC-143), parsed; or why it is refused. */
function requiredShare(flag: string, name: string, raw: string | undefined, example: string, what: string): number | string {
  const v = parseThreshold(raw);
  if (v !== undefined) return v;
  const given = raw === undefined ? `No ${name}` : `No ${name} in « ${raw} »`;
  return `${given}: ${flag} is required, a share (${example}) or a percentage (${percent(Number(example))}) of the factory's PRs to be ${what}, written before the replay and never changed after (ORC-143).`;
}

/** `REL-1=12,REL-2=34`: each ticket and its human PR's number; undefined when one is malformed. */
function parseTickets(raw: string | undefined): { ticketId: string; pr: number }[] | undefined {
  const pairs = (raw ?? '').split(',').filter(Boolean).map((p) => /^([A-Za-z][\w]*-\d+)=#?(\d+)$/.exec(p.trim()));
  if (!pairs.length || pairs.some((m) => !m)) return undefined;
  return pairs.map((m) => ({ ticketId: m![1]!, pr: Number(m![2]) }));
}

/**
 * `factory ghost` (ORC-231): the replay of closed tickets. `start` writes the replay with its threshold before anything runs, and
 * rebuilds each ticket's environment, which the daemon delegates to the project on the `factory/fantome` preset (ORC-376), without
 * effects: their PRs stay artifacts; `collect` reads them back; `judge` grades the pairs blind; `report` says how the factory did.
 */
export async function runGhost(o: GhostOptions): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...o.args],
    allowPositionals: true,
    options: { threshold: { type: 'string' }, 'as-is': { type: 'string' }, tickets: { type: 'string' }, memory: { type: 'string' }, id: { type: 'string' }, judge: { type: 'string' } },
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
      // A GitHub login, as the human PRs' authors are: who wrote a human PR never judges it.
      if (!values.judge) return refuse(o, '--judge <GitHub login> is required: the PRs you wrote are left to another judge.');
      return judge(o, arg, values.judge);
    case 'report':
      return report(o, arg);
    default:
      return refuse(o, GHOST_USAGE);
  }
}

async function list(o: GhostOptions): Promise<number> {
  const replays = await o.store.ghostReplays();
  if (!replays.length) o.print('No replay yet.');
  for (const r of replays) o.print(`${r.id}  ${r.projectId}  ${r.tickets.length} tickets  ${thresholds(r)}  started ${new Date(r.startedAt).toISOString()} by ${r.startedBy}`);
  return 0;
}

async function start(o: GhostOptions, projectId: string, values: { threshold?: string | undefined; 'as-is'?: string | undefined; tickets?: string | undefined; memory?: string | undefined; id?: string | undefined }): Promise<number> {
  const threshold = requiredShare('--threshold', 'threshold', values.threshold, '0.6', 'mergeable, as is or after edits');
  if (typeof threshold === 'string') return refuse(o, threshold);
  const asIsThreshold = requiredShare('--as-is', 'as-is threshold', values['as-is'], '0.3', 'mergeable as is');
  if (typeof asIsThreshold === 'string') return refuse(o, asIsThreshold);
  if (asIsThreshold > threshold) return refuse(o, `--as-is ${percent(asIsThreshold)} is above --threshold ${percent(threshold)}: the PRs mergeable as is are some of the mergeable ones.`);
  const tickets = parseTickets(values.tickets);
  if (!tickets) return refuse(o, '--tickets: each ticket and its human PR, as REL-1=12,REL-2=34.');
  if (values.memory !== undefined && values.memory !== 'on' && values.memory !== 'off') return refuse(o, '--memory: on or off.');
  const project = o.projects.find((p) => p.id === projectId);
  if (!project) return refuse(o, `No project ${projectId}.`);
  if (!project.fantome) return refuse(o, `${projectId} is not on the factory/fantome preset: a replay runs on such a project, which asks nothing, pushes nothing, opens no PR and writes no comment.`);
  const sandboxes = await o.sandboxes();
  if (sandboxes === undefined) return refuse(o, 'Replay refused: no daemon has started on this instance yet, so whether its runs have sandboxes is unknown; a replay runs with sandboxes only. Start the daemon (`factory up`), then the replay.');
  if (!sandboxes) return refuse(o, `Replay refused: ${HOST_RUNS_REFUSED}`);
  // A ticket replays once per project (ORC-376): a second run would start on the state of the first, its session and its branch.
  const earlier = (await o.store.ghostReplays()).filter((r) => r.projectId === projectId && r.id !== values.id);
  const again = tickets.map((t) => ({ t, r: earlier.find((r) => r.tickets.includes(t.ticketId)) })).find((x) => x.r);
  if (again) return refuse(o, `${again.t.ticketId}: ${projectId} replayed it already (${again.r!.id}): a ticket replays once per project, its run would start on the state of the first. Replay it on another project on factory/fantome.`);
  // Every PR read before anything is written: a replay is never left half-made by a ticket that cannot be replayed.
  const prs = await Promise.all(tickets.map(async (t) => ({ ...t, read: await o.humanPr(project.repoPath, t.pr) })));
  const unmerged = prs.find((t) => !t.read.mergeSha);
  if (unmerged) return refuse(o, `${unmerged.ticketId}: PR #${unmerged.pr} is not merged, there is no human work to compare with.`);
  const replay: GhostReplay = {
    id: values.id ?? o.newId(),
    projectId,
    threshold,
    asIsThreshold,
    memory: values.memory !== 'off',
    seed: randomUUID(),
    tickets: tickets.map((t) => t.ticketId),
    startedAt: o.now(),
    startedBy: o.user,
  };
  if (!(await o.store.putGhostReplay(replay))) {
    o.print(`A replay ${replay.id} exists already: its thresholds were written when it started, and stay as they are.`);
    return 1;
  }
  o.print(`Replay ${replay.id} of ${projectId}: ${thresholds(replay)}, written now and never changed; memory ${replay.memory ? 'on' : 'off'}.`);
  for (const { ticketId, read: pr } of prs) {
    const mergeSha = pr.mergeSha!;
    const base: GhostTicket = {
      replayId: replay.id, ticketId, humanPr: { number: pr.number, url: pr.url, author: pr.author }, mergeSha,
      // The dry run on the start commit is ORC-208's (criterion 3): until it exists, the environment is not checked, and the report says so.
      env: 'unchecked', outcome: 'pending', costUsd: 0, assumptions: 0, at: o.now(),
    };
    try {
      const env = await o.environment({ ticketId, repoPath: project.repoPath, mergeSha, prCommits: pr.commits, dir: join(o.dir, replay.id, ticketId), memory: replay.memory });
      await o.store.putGhostTicket({ ...base, start: env.start, ...(env.knowledge ? { knowledge: env.knowledge } : {}) });
      o.print(`  ${ticketId}: at ${env.start.slice(0, 12)}, the parent of PR #${pr.number}'s merge commit${env.knowledge ? `; knowledge base at ${env.knowledge.slice(0, 12)}` : ''}.`);
    } catch (err) {
      await o.store.putGhostTicket({ ...base, env: 'failed', envReason: (err as Error).message });
      o.print(`  ${ticketId}: environment not rebuilt (${(err as Error).message}): counted apart, out of the comparison.`);
    }
  }
  o.print('Environments not checked by a dry run yet (ORC-208): the report counts them as unchecked.');
  o.print(`The daemon delegates each ticket rebuilt to ${projectId} at its next pass, on its clone, with its text and linked tickets as of its start; \`factory ghost collect ${replay.id}\` reads what they ran to.`);
  return 0;
}

async function replayOf(o: GhostOptions, id: string): Promise<GhostReplay | undefined> {
  const replay = await o.store.ghostReplay(id);
  if (!replay) o.print(`No replay ${id}.`);
  return replay;
}

/**
 * What each ticket ran to on the replay's project, within the replay's time (from its start to the next replay of the same ticket
 * on the project): its last kept PR, its runs' cost, the assumptions of its spec. A ticket whose run has not ended, or has not
 * started, stays `pending`. A PR already graded stays the one graded.
 */
async function collect(o: GhostOptions, id: string): Promise<number> {
  const replay = await replayOf(o, id);
  if (!replay) return 1;
  const later = (await o.store.ghostReplays()).filter((r) => r.projectId === replay.projectId && r.startedAt > replay.startedAt);
  const graded = new Set((await o.store.ghostJudgments(id)).filter((j) => j.side === 'factory').map((j) => j.ticketId));
  for (const t of await o.store.ghostTickets(id)) {
    if (t.env === 'failed') continue;
    const until = Math.min(...later.filter((r) => r.tickets.includes(t.ticketId)).map((r) => r.startedAt), Infinity);
    const within = (at: number) => at >= replay.startedAt && at < until;
    const [state, allRuns, artifacts] = await Promise.all([o.store.getTicket(replay.projectId, t.ticketId), o.store.ticketRuns(replay.projectId, t.ticketId), o.store.artifacts(t.ticketId)]);
    const runs = allRuns.filter((r) => within(r.startedAt));
    const kept = graded.has(t.ticketId) && t.factoryPr ? t.factoryPr : artifacts.filter((a) => a.kind === KEPT_PR && within(a.createdAt)).at(-1)?.id;
    const running = !runs.length || !!state?.activeRunId || !!state?.verifyingRunId;
    const outcome: GhostTicket['outcome'] = kept ? 'pr' : state?.blocked ? 'blocked' : running ? 'pending' : 'no_pr';
    const { factoryPr: _, ...rest } = t;
    const assumptions = state?.spec?.spec.assumed?.length ?? state?.assumed?.length ?? 0;
    const costUsd = runs.reduce((s, r) => s + r.costUsd, 0);
    await o.store.putGhostTicket({ ...rest, outcome, ...(kept ? { factoryPr: kept } : {}), costUsd, assumptions, at: o.now() });
    const said = { pr: 'a PR kept', blocked: 'blocked', pending: 'not ended yet', no_pr: 'no PR' }[outcome];
    o.print(`  ${t.ticketId}: ${said}, ${dollars(costUsd)}, ${assumptions} assumption(s).`);
  }
  return 0;
}

/** The diff of one side of a pair: the factory's from its kept PR, the human's from the forge. */
async function diffOf(o: GhostOptions, repoPath: string, t: GhostTicket, side: GhostSide): Promise<string> {
  if (side === 'human') return (await o.humanDiff(repoPath, t.humanPr.number)).trim() || '(no diff)';
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
  const project = o.projects.find((p) => p.id === replay.projectId);
  if (!project) return refuse(o, `No project ${replay.projectId}: the human PRs are read in its checkout.`);
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
    const diffs = await Promise.all(sides.map(([, side]) => diffOf(o, project.repoPath, t, side)));
    sides.forEach(([label], k) => o.print(`\n--- PR ${label} ---\n${diffs[k]}`));
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
  o.print(`Replay ${replay.id} of ${replay.projectId}, started ${new Date(replay.startedAt).toISOString()} by ${replay.startedBy}, ${thresholds(replay)}, memory ${replay.memory ? 'on' : 'off'}.`);
  for (const row of r.rows) o.print(`  ${row.ticketId}  factory: ${show(row.factory)}  human: ${show(row.human)}  ${row.assumptions} assumption(s)  ${dollars(row.costUsd)}  (${row.humanPr}${row.start ? `, from ${row.start.slice(0, 12)}` : ''})`);
  o.print(`Environment failures (out of the comparison): ${r.envFailures.length ? r.envFailures.map((f) => `${f.ticketId} (${f.envReason})`).join(', ') : 'none'}.`);
  if (r.pending) o.print(`Tickets not ended, or not collected, yet: ${r.pending}.`);
  if (r.envUnchecked) o.print(`Environments not checked by a dry run: ${r.envUnchecked} (ORC-208).`);
  o.print(`Mergeable factory PRs: ${r.mergeable} of ${r.compared} compared (${percent(r.share)}), threshold ${percent(r.threshold)}.${r.unjudged ? ` ${r.unjudged} pair(s) still to judge.` : ''}`);
  o.print(`Mergeable as is: ${r.asIs} of ${r.compared} compared (${percent(r.asIsShare)}), threshold ${asIsLabel(replay)}.`);
  o.print(`Assumptions written in the specs: ${r.assumptions}.`);
  o.print(`Total cost: ${dollars(r.totalCostUsd)}.`);
  o.print(`Verdict: ${r.verdict}${replay.asIsThreshold === undefined ? ', on the mergeable share only: no as-is threshold was set when this replay started' : ''}.`);
  return 0;
}

/** The forge's view of a merged PR, through `gh` in the project's checkout. */
async function ghHumanPr(repoPath: string, number: number): Promise<HumanPr> {
  const view = JSON.parse(await mustExec(execCmd, 'gh', ['pr', 'view', String(number), '--json', 'number,url,author,mergeCommit,commits'], { cwd: repoPath })) as {
    number: number; url: string; author?: { login?: string }; mergeCommit?: { oid?: string } | null; commits?: { messageHeadline?: string }[];
  };
  const commits = (view.commits ?? []).map((c) => c.messageHeadline ?? '');
  return { number: view.number, url: view.url, author: view.author?.login ?? '', ...(view.mergeCommit?.oid ? { mergeSha: view.mergeCommit.oid } : {}), commits };
}

/** The command line, on the instance's store and projects; the PRs read through `gh`, the clones from each project's origin. */
export async function runGhostCommand(home: string, args: readonly string[]): Promise<number> {
  const instance = loadInstance(home);
  // The daemon migrates the schema; this only reads and writes rows.
  const { store } = await openStore({ env: process.env, sqlitePath: homePaths(home).db, migrationsFolder: join(repoRoot(), 'drizzle'), migrate: false });
  // Opened for the judge's answers only: the long clones of `start` hold no terminal.
  let rl: ReturnType<typeof createInterface> | undefined;
  // Each project's default branch, read once for all its tickets.
  const branches: Record<string, Promise<string>> = {};
  try {
    let user = 'cli';
    try {
      user = userInfo().username || user;
    } catch {
      // No user name (a container without passwd entry): recorded as `cli`.
    }
    return await runGhost({
      args, store, user, print: (l) => console.log(l), now: () => Date.now(), newId: () => `ghost-${randomUUID().slice(0, 8)}`,
      dir: homePaths(home).ghost,
      projects: instance.projects.map((p) => ({ id: p.id, repoPath: p.repoPath, fantome: isFantome(p) })),
      sandboxes: async () => {
        const said = await store.getMeta(SANDBOXES_META);
        return said === undefined ? undefined : said === '1';
      },
      humanPr: ghHumanPr,
      humanDiff: (repoPath, number) => mustExec(execCmd, 'gh', ['pr', 'diff', String(number)], { cwd: repoPath }),
      environment: async ({ repoPath, mergeSha, prCommits, dir, memory }) => {
        const remote = (await mustExec(execCmd, 'git', ['-C', repoPath, 'remote', 'get-url', 'origin'])).trim();
        const repo = join(dir, 'repo');
        const start = await cloneAtStart({ remote, mergeSha, prCommits, dir: repo });
        // The run's repository (ORC-376): the start on the project's default branch, its own origin.
        branches[repoPath] ??= originHeadOf(execCmd, repoPath).then((h) => h.name.replace(/^origin\//, ''));
        await asRepository({ dir: repo, branch: await branches[repoPath] });
        if (!memory || !instance.knowledge) return { start };
        // Transaction time: the knowledge base as it stood when the start commit was made.
        const at = await startTime({ dir: repo, sha: start });
        const knowledge = await knowledgeAt({ repo: instance.knowledge.repoPath, before: at, dir: join(dir, 'knowledge') });
        return { start, ...(knowledge ? { knowledge } : {}) };
      },
      ask: (q) => (rl ??= createInterface({ input: process.stdin, output: process.stdout })).question(q),
    });
  } finally {
    rl?.close();
    await store.close();
  }
}
