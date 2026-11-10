import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IssueHistory, Tracker, TrackerIssue } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
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

/** The `meta` key of the replay a project's ticket runs for now: the last one delegated. */
const currentKey = (projectId: string, ticketId: string) => `ghost-current:${projectId}:${ticketId}`;

/** The ticket as of its start, beside its clone: read from the tracker once, at its delegation. */
const SNAPSHOT = 'ticket.json';

interface Snapshot {
  /** When the start commit was made (ms): the comments and linked tickets kept are those of before. */
  start: number;
  history: IssueHistory;
}

/** What the run of a replayed ticket reads instead of the live ticket and the project's repository. */
export interface ReplayedTicket {
  replayId: string;
  /** The clone at the start, standing for the project's repository (`asRepository`). */
  repoPath: string;
  /** The ticket's text as of its start, read through no tracker at the launch. */
  issue: TrackerIssue;
  /** Its comments and linked tickets as of its start (`formatHistory`), none when it had neither. */
  history?: string;
}

/** Where a replayed ticket of a project runs (`Orchestrator`'s `replays`): undefined for any other ticket. */
export interface ReplaySource {
  of(projectId: string, ticketId: string): Promise<ReplayedTicket | undefined>;
}

export interface ReplaysDeps {
  store: Store;
  tracker: Pick<Tracker, 'history'>;
  workspaces: Pick<WorkspaceManager, 'cleanup'>;
  /** The projects that replay closed tickets, on the `factory/fantome` preset: the only ones a replay delegates to. */
  projects: readonly string[];
  /** `<dir>/<replay>/<ticket>/`, as `factory ghost start` rebuilt it. */
  dir: string;
  /** Whether the daemon's runs have sandboxes: without, no replayed ticket is delegated (`HOST_RUNS_REFUSED`). */
  sandboxes: boolean;
  accept(event: FactoryEvent): Promise<boolean>;
  now(): number;
  log(level: 'info' | 'warn', message: string): void;
  /** When `sha` was made, in the clone `repo` (ms): `startTime`. */
  startTime(repo: string, sha: string): Promise<number>;
}

export class Replays implements ReplaySource {
  /** The replays already told to be held back for want of sandboxes: said once each, not at every pass. */
  private held = new Set<string>();

  constructor(private readonly d: ReplaysDeps) {}

  async of(projectId: string, ticketId: string): Promise<ReplayedTicket | undefined> {
    if (!this.d.projects.includes(projectId)) return undefined;
    const replayId = await this.d.store.getMeta(currentKey(projectId, ticketId));
    if (!replayId) return undefined;
    const dir = join(this.d.dir, replayId, ticketId);
    const { history } = JSON.parse(await readFile(join(dir, SNAPSHOT), 'utf8')) as Snapshot;
    const { issue } = history;
    const text = formatHistory(history);
    return {
      replayId,
      repoPath: join(dir, 'repo'),
      // No link to the live ticket, which holds the human's work: the agent reads the ticket as it was, here.
      issue: { identifier: issue.identifier, title: issue.title, description: issue.description, url: '(a replayed ticket: no link)', stateName: '', stateType: 'unstarted', labels: [], teamKey: issue.identifier.split('-')[0]!, priority: 0, createdAt: issue.createdAt },
      ...(text ? { history: text } : {}),
    };
  }

  /**
   * One pass: each ticket of a replay on such a project, its environment rebuilt and its run not started, delegated to the project,
   * once. A run of an earlier replay of the same ticket still going holds it back to a later pass. Without sandboxes, none.
   */
  async delegate(): Promise<void> {
    const replays = (await this.d.store.ghostReplays()).filter((r) => this.d.projects.includes(r.projectId)).sort((a, b) => a.startedAt - b.startedAt);
    for (const replay of replays) {
      for (const t of await this.d.store.ghostTickets(replay.id)) {
        if (t.env === 'failed' || !t.start || t.outcome !== 'pending') continue;
        const id = replayDelegationId(replay.id, t.ticketId);
        if (await this.d.store.inboxHas(id)) continue;
        if (!this.d.sandboxes) {
          if (!this.held.has(replay.id)) this.d.log('warn', `replay ${replay.id} not run: ${HOST_RUNS_REFUSED}`);
          this.held.add(replay.id);
          break;
        }
        try {
          await this.delegateOne(replay, t.ticketId, t.start, id);
        } catch (err) {
          this.d.log('warn', `${t.ticketId} of replay ${replay.id} not delegated, the next pass tries again: ${(err as Error).message}`);
        }
      }
    }
  }

  private async delegateOne(replay: GhostReplay, ticketId: string, startSha: string, id: string): Promise<void> {
    const known = await this.d.store.getTicket(replay.projectId, ticketId);
    if (known && (known.activeRunId || known.verifyingRunId || known.pendingJob)) return;
    const dir = join(this.d.dir, replay.id, ticketId);
    const file = join(dir, SNAPSHOT);
    let snapshot: Snapshot;
    if (existsSync(file)) snapshot = JSON.parse(await readFile(file, 'utf8')) as Snapshot;
    else {
      const start = await this.d.startTime(join(dir, 'repo'), startSha);
      snapshot = { start, history: historyAsOf(await this.d.tracker.history(ticketId), start) };
      await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    // The worktree an earlier replay of the ticket left: this one starts from its own clone.
    if (known) await this.d.workspaces.cleanup(replay.projectId, ticketId);
    await this.d.store.setMeta(currentKey(replay.projectId, ticketId), replay.id);
    await this.d.accept({
      id, type: 'ticket.delegated', at: this.d.now(), projectId: replay.projectId, ticketId, ...TRUSTED,
      // The ticket as it was when the human started: to do, whatever Linear says of it now.
      payload: { replay: replay.id, issue: { title: snapshot.history.issue.title, logical: 'todo', priority: 0 } },
    } as FactoryEvent);
    this.d.log('info', `${ticketId} of replay ${replay.id} delegated to ${replay.projectId}, on its clone at ${startSha.slice(0, 12)}`);
  }
}
