import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { teamOf, type IssueHistory, type Tracker, type TrackerIssue } from '../adapters/tracker/types.js';
import { TRUSTED, type FactoryEvent } from '../core/types.js';
import type { Store } from '../store/types.js';
import { formatHistory, historyAsOf } from './history.js';
import type { GhostReplay } from './replay.js';

/**
 * The daemon's side of the replay of closed tickets (ORC-376): `factory ghost start` rebuilds each ticket's environment, then the
 * daemon delegates each ticket to the replay's project itself, on its clone, with its text and its linked tickets as they were.
 */

/** The `meta` key the daemon writes at each start: `1` when its runs have sandboxes, `0` when they run on the host. */
export const SANDBOXES_META = 'daemon-sandboxes';

/** Why a replay runs with sandboxes only: on the host, the agent holds the host's git login and could push by itself. */
export const HOST_RUNS_REFUSED =
  'the daemon runs its agents on the host (no sandboxes): an agent there holds the host\'s git login and could push by itself, which no effect mode can hold back. A replay runs with sandboxes only (FACTORY_CONTAINER_CLI).';

/** The id of the delegation of a replayed ticket: once per replay and ticket, whatever the passes. */
export const replayDelegationId = (replayId: string, ticketId: string) => `ghost:${replayId}:${ticketId}`;

/**
 * The `meta` key of the replay a project's ticket ran for: written once, at its delegation. A ticket replays once per project: a
 * second run on the state of the first (its session, its branch, its kept PR) would measure neither.
 */
const currentKey = (projectId: string, ticketId: string) => `ghost-current:${projectId}:${ticketId}`;


/** The ticket as of its start, beside its clone: read from the tracker once, at its delegation. */
const SNAPSHOT = 'ticket.json';

/** `<dir>/ticket.json`, written by the delegation; undefined before it. */
async function readSnapshot(dir: string): Promise<IssueHistory | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, SNAPSHOT), 'utf8')) as IssueHistory;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** What the run of a replayed ticket reads instead of the live ticket and the project's repository. */
export interface ReplayedTicket {
  /** The clone at the start, standing for the project's repository (`asRepository`). */
  repoPath: string;
  /** The ticket's text as of its start, read through no tracker at the launch. */
  issue: TrackerIssue;
  /** Its comments and linked tickets as of its start (`formatHistory`), none when it had neither. */
  history?: string;
  /** The knowledge base at transaction time (`knowledgeAt`), none with `--memory off` or none before the start. */
  knowledge?: string;
}

/** Where a replayed ticket of a project runs (`Orchestrator`'s `replays`): undefined for any other ticket. */
export interface ReplaySource {
  of(projectId: string, ticketId: string): Promise<ReplayedTicket | undefined>;
}

export interface ReplaysDeps {
  store: Store;
  tracker: Pick<Tracker, 'history'>;
  /** The projects that replay closed tickets, on the `factory/fantome` preset: the only ones a replay delegates to. */
  projects: readonly string[];
  /** `<dir>/<replay>/<ticket>/`, as `factory ghost start` rebuilt it. */
  dir: string;
  /** Whether the daemon's runs have sandboxes: without, no replayed ticket is delegated (`HOST_RUNS_REFUSED`). */
  sandboxes: boolean;
  accept(event: FactoryEvent): Promise<boolean>;
  now(): number;
  log(level: 'info' | 'warn', message: string): void;
  /** When `sha` was made, in the clone `dir` (ms): `startTime`. */
  startTime(o: { dir: string; sha: string }): Promise<number>;
}

export class Replays implements ReplaySource {
  /** What was said already of a replay held back (no sandboxes, a ticket replayed before): once each, not at every pass. */
  private said = new Set<string>();
  /** Each replayed ticket as its run reads it, by project and ticket: once delegated, it never changes. */
  private read = new Map<string, ReplayedTicket>();
  /** The delegations this process wrote or found in the inbox: not looked up again at each pass. */
  private delegated = new Set<string>();
  private handle: NodeJS.Timeout | undefined;
  private passing: Promise<void> | undefined;

  constructor(private readonly d: ReplaysDeps) {}

  async of(projectId: string, ticketId: string): Promise<ReplayedTicket | undefined> {
    if (!this.d.projects.includes(projectId)) return undefined;
    const key = `${projectId}:${ticketId}`;
    const known = this.read.get(key);
    if (known) return known;
    const replayId = await this.d.store.getMeta(currentKey(projectId, ticketId));
    if (!replayId) return undefined;
    const dir = join(this.d.dir, replayId, ticketId);
    // Written before the meta that names it: missing, the replay's files were removed, and its run must not go on elsewhere.
    const history = await readSnapshot(dir);
    if (!history) throw new Error(`${ticketId} of replay ${replayId}: ${join(dir, SNAPSHOT)} is gone, the ticket cannot run as it was`);
    return this.remember(key, dir, history);
  }

  private remember(key: string, dir: string, history: IssueHistory): ReplayedTicket {
    const { issue } = history;
    const text = formatHistory(history);
    const knowledge = join(dir, 'knowledge');
    const replayed: ReplayedTicket = {
      repoPath: join(dir, 'repo'),
      // No link to the live ticket, which holds the human's work: the agent reads the ticket as it was, here.
      issue: { identifier: issue.identifier, title: issue.title, description: issue.description, url: '(a replayed ticket: no link)', stateName: '', stateType: 'unstarted', labels: [], teamKey: teamOf(issue.identifier), priority: 0, createdAt: issue.createdAt },
      ...(text ? { history: text } : {}),
      ...(existsSync(knowledge) ? { knowledge } : {}),
    };
    this.read.set(key, replayed);
    return replayed;
  }

  /** Says `message` of `what` once, whatever the passes. */
  private once(what: string, message: string): void {
    if (this.said.has(what)) return;
    this.said.add(what);
    this.d.log('warn', message);
  }

  /** A pass each `intervalMs`, the first now; a tick that finds the last pass still going is skipped. */
  start(intervalMs = 60_000): void {
    const pass = () => {
      this.passing ??= this.delegate()
        .catch((e: Error) => this.d.log('warn', `replay pass: ${e.message}`))
        .finally(() => (this.passing = undefined));
    };
    if (this.handle) clearInterval(this.handle);
    pass();
    this.handle = setInterval(pass, intervalMs);
    this.handle.unref();
  }

  /** No pass starts after it; resolves once the pass under way, if any, has finished. */
  async stop(): Promise<void> {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
    await this.passing;
  }

  /**
   * One pass: each ticket of a replay on such a project, its environment rebuilt and its run not started, delegated to the project,
   * once. A ticket the project replayed already, for another replay, is not: it stays pending in this one. Without sandboxes, none.
   */
  async delegate(): Promise<void> {
    const replays = (await this.d.store.ghostReplays()).filter((r) => this.d.projects.includes(r.projectId)).sort((a, b) => a.startedAt - b.startedAt);
    if (!this.d.sandboxes) {
      for (const r of replays) this.once(r.id, `replay ${r.id} not run: ${HOST_RUNS_REFUSED}`);
      return;
    }
    for (const replay of replays) {
      for (const t of await this.d.store.ghostTickets(replay.id)) {
        if (t.env === 'failed' || !t.start || t.outcome !== 'pending') continue;
        const id = replayDelegationId(replay.id, t.ticketId);
        if (this.delegated.has(id)) continue;
        if (await this.d.store.inboxHas(id)) {
          this.delegated.add(id);
          continue;
        }
        const earlier = await this.d.store.getMeta(currentKey(replay.projectId, t.ticketId));
        if (earlier && earlier !== replay.id) {
          this.once(id, `${t.ticketId} of replay ${replay.id} not run: ${replay.projectId} replayed it already for ${earlier}, a ticket replays once per project`);
          continue;
        }
        try {
          await this.delegateOne(replay, t.ticketId, t.start, id);
          this.delegated.add(id);
        } catch (err) {
          this.d.log('warn', `${t.ticketId} of replay ${replay.id} not delegated, the next pass tries again: ${(err as Error).message}`);
        }
      }
    }
  }

  private async delegateOne(replay: GhostReplay, ticketId: string, sha: string, id: string): Promise<void> {
    const dir = join(this.d.dir, replay.id, ticketId);
    let history = await readSnapshot(dir);
    if (!history) {
      const start = await this.d.startTime({ dir: join(dir, 'repo'), sha });
      history = historyAsOf(await this.d.tracker.history(ticketId), start);
      await writeFile(join(dir, SNAPSHOT), `${JSON.stringify(history, null, 2)}\n`);
    }
    await this.d.store.setMeta(currentKey(replay.projectId, ticketId), replay.id);
    this.remember(`${replay.projectId}:${ticketId}`, dir, history);
    await this.d.accept({
      id, type: 'ticket.delegated', at: this.d.now(), projectId: replay.projectId, ticketId, ...TRUSTED,
      // The ticket as it was when the human started: to do, whatever Linear says of it now.
      payload: { replay: replay.id, issue: { title: history.issue.title, logical: 'todo', priority: 0 } },
    } as FactoryEvent);
    this.d.log('info', `${ticketId} of replay ${replay.id} delegated to ${replay.projectId}, on its clone at ${sha.slice(0, 12)}`);
  }
}
