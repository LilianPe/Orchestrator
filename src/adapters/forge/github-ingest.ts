import type { FactoryEvent } from '../../core/types.js';
import type { Store } from '../../store/types.js';
import { execCmd, mustExec, type Exec } from '../exec.js';
import { parseGitHubRemote } from './github-app.js';
import { mapGithubWebhook, verifyGithubSignature, type GithubMapContext } from './github-webhook.js';
import type { Forge } from './types.js';

/** `owner/name` of a checkout's `origin` on GitHub, read once per checkout; undefined when it is not on GitHub. */
export function githubRepoOf(exec: Exec = execCmd): (repoPath: string) => Promise<string | undefined> {
  const known = new Map<string, Promise<string | undefined>>();
  return (repoPath) => {
    let repo = known.get(repoPath);
    if (!repo) {
      repo = mustExec(exec, 'git', ['remote', 'get-url', 'origin'], { cwd: repoPath }).then((remote) => {
        const r = parseGitHubRemote(remote);
        return r && `${r.owner}/${r.name}`;
      });
      // A failed read is tried again at the next webhook.
      repo.catch(() => known.delete(repoPath));
      known.set(repoPath, repo);
    }
    return repo;
  };
}

/**
 * The daemon's mapping context: a ticket is the one whose branch (or PR, or journaled merge commit, for
 * a push on the default branch) the webhook names, in the project whose repository (`repoOf`,
 * `owner/name`) sent it; a project whose repository is unknown matches nothing.
 */
export function githubMapContext(d: {
  store: Pick<Store, 'listTickets' | 'getTicket' | 'mergedPrOf'>;
  forge: Pick<Forge, 'findPr'>;
  projects: readonly { id: string; repoPath: string }[];
  repoOf: (repoPath: string) => Promise<string | undefined>;
  now: () => number;
  /** The factory's GitHub App id (ORC-353), when it has one. */
  factoryAppId?: string;
}): GithubMapContext {
  const projectOf = (id: string) => d.projects.find((p) => p.id === id);
  const sameRepo = async (projectId: string, repo: string) => {
    const project = projectOf(projectId);
    return !!project && (await d.repoOf(project.repoPath))?.toLowerCase() === repo.toLowerCase();
  };
  return {
    ticketForBranch: async (repo, branch) => {
      for (const t of await d.store.listTickets()) if (t.branch === branch && (await sameRepo(t.projectId, repo))) return t;
      return undefined;
    },
    ticketForPr: async (repo, number) => {
      for (const t of await d.store.listTickets()) if (t.prNumber === number && (await sameRepo(t.projectId, repo))) return t;
      return undefined;
    },
    mergedPrOf: async (repo, sha) => {
      for (const project of d.projects) {
        if (!(await sameRepo(project.id, repo))) continue;
        const found = await d.store.mergedPrOf(project.id, sha);
        const ticket = found && (await d.store.getTicket(project.id, found.ticketId));
        if (found && ticket) return { ticket, number: found.number };
      }
      return undefined;
    },
    findPr: async (t) => {
      const project = projectOf(t.projectId);
      return project && t.branch ? d.forge.findPr(project.repoPath, t.branch) : undefined;
    },
    now: d.now,
    ...(d.factoryAppId ? { factoryAppId: d.factoryAppId } : {}),
  };
}

export interface GithubIngestDeps {
  /** `github.webhookSecret` of config.yaml, or `GH_WEBHOOK_SECRET`; empty refuses every webhook. */
  secret: () => string;
  ctx: GithubMapContext;
  /** Writes an event to the inbox (ORC-147); resolves once committed, `false` for an id already there. */
  accept: (e: FactoryEvent) => Promise<boolean>;
  log: (m: string) => void;
}

/**
 * The GitHub webhook (ORC-134), as the Linear one (ORC-147): the answer comes only once its events are
 * in the inbox. 401 for a body not signed with the secret, and nothing is written; 200 means written
 * (or already there: a redelivery is a duplicate by event id); 500 means nothing may have been written.
 */
export function createGithubIngest(d: GithubIngestDeps) {
  // One webhook at a time, in arrival order: the mapping reads the store, and a later webhook of the
  // same ticket must not reach the inbox first.
  let tail: Promise<unknown> = Promise.resolve();
  return async (raw: string, headers: Record<string, string | undefined>): Promise<{ status: number }> => {
    if (!verifyGithubSignature(raw, headers['x-hub-signature-256'], d.secret())) return { status: 401 };
    const name = headers['x-github-event'];
    if (!name) return { status: 400 };
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400 };
    }
    const turn = tail.then(async () => {
      for (const e of await mapGithubWebhook(name, body, d.ctx)) await d.accept(e);
    });
    tail = turn.catch(() => undefined);
    try {
      await turn;
    } catch (err) {
      d.log(`github webhook ${headers['x-github-delivery'] ?? '?'} (${name}) not written to the inbox: ${(err as Error).message}`);
      return { status: 500 };
    }
    return { status: 200 };
  };
}
