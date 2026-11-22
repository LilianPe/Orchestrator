import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { CloneAuth, GitAuth } from '../forge/types.js';
import { fetchOrigin, originHeadOf, remoteGitEnv, type FetchOrigin } from './git-workspaces.js';

/** What a mirror fetches: every branch of the forge, as the remote-tracking refs the daemon reads (`origin/HEAD`, `origin/<branch>`). No local branch. */
export const MIRROR_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
/**
 * The first fetch of a mirror brings the whole history: longer than a launch's (`FETCH_DEADLINE_MS`). A transfer that stalls is
 * still aborted at once (`STALLED`): only one that moves goes on this long.
 */
export const MIRROR_CLONE_DEADLINE_MS = 30 * 60_000;
/** An owner or a name as GitHub admits them: nothing that climbs out of the mirrors' root. */
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/**
 * The daemon's own bare mirror of each GitHub repository (ORC-479), `<root>/<owner>/<name>` in lower case (GitHub's names ignore
 * it): the git source of the workspaces, the repository's config, the fingerprints and the ghost, in place of a clone the operator
 * keeps (`repo_path`). Its `origin` is the forge's URL, never with a credential: the App's token reaches git in its environment
 * alone (`auth`), never the mirror's config nor the disk. It holds only `refs/remotes/origin/*` and `origin/HEAD`, no local
 * branch. Never mounted in a sandbox: an agent's repository copies its objects (`agentRepository`).
 *
 * Its fetches are one at a time, its creation included: two git processes never take one mirror's locks at once in this process.
 * Another process on the same home (`factory ghost`) is not held back: git's own locks then refuse one fetch, retried as any.
 */
export class RepoMirrors {
  private readonly exec: Exec;
  /** The repository of each mirror, by its path: what `auth` gives the token of. */
  private readonly repos = new Map<string, string>();
  /** The last fetch of each mirror, which the next one waits for. */
  private readonly turns = new Map<string, Promise<unknown>>();

  /**
   * `url`: where a repository is fetched from, GitHub by default (a test's local bare repositories). `auth`: the App's git token
   * of a repository (`fetchEnv`); none without the App, and the machine's own git credentials serve.
   */
  constructor(private readonly o: { root: string; exec?: Exec; auth?: GitAuth; url?: (github: string) => string; log?: (message: string) => void }) {
    this.exec = o.exec ?? execCmd;
  }

  /** The forge's URL of `github`, as the mirror's `origin` names it: GitHub's, without credentials. */
  url(github: string): string {
    return this.o.url ? this.o.url(github) : `https://github.com/${github}.git`;
  }

  /** Where the mirror of `github` (`owner/name`) is, whether it exists yet or not. Anything else throws. */
  path(github: string): string {
    const [owner, name, ...rest] = github.split('/');
    if (!owner || !name || rest.length || !SEGMENT.test(owner) || !SEGMENT.test(name)) throw new Error(`not a GitHub repository, \`owner/name\` expected: ${github}`);
    const path = resolve(this.o.root, owner.toLowerCase(), name.toLowerCase());
    this.repos.set(path, github);
    return path;
  }

  /** The App's token of the repository a mirror stands for; `{}` for any other path (a replayed ticket's clone, whose origin is local). */
  readonly auth: CloneAuth = async (repo) => {
    const github = this.repos.get(resolve(repo));
    return github && this.o.auth ? this.o.auth(github) : {};
  };

  /**
   * `git fetch origin` in `repo` as `fetchOrigin` does it, after the fetch under way there: a mirror missing yet is made first.
   * A path that is not a mirror (a replayed ticket's clone) is fetched as it is, without a token.
   */
  readonly fetch: FetchOrigin = (repo, o = {}) =>
    this.turn(repo, async () => {
      const github = this.repos.get(resolve(repo));
      if (github && !existsSync(repo)) return this.make(github, repo, o.log);
      await fetchOrigin(this.exec, repo, { ...o, auth: this.auth });
      if (github) await this.setHead(repo, o.deadlineMs);
    });

  /** The mirror of `github`, made if missing, fetched otherwise: at the start, so that its first read finds it. */
  async ready(github: string): Promise<string> {
    const path = this.path(github);
    await this.fetch(path, { log: this.o.log });
    return path;
  }

  private turn<T>(repo: string, work: () => Promise<T>): Promise<T> {
    const key = resolve(repo);
    const next = (this.turns.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.turns.set(key, next);
    return next;
  }

  /**
   * A bare repository, its `origin` the forge and what it fetches every branch, fetched whole, `origin/HEAD` set from the forge.
   * Made aside, then renamed: a daemon killed halfway leaves no mirror half fetched.
   */
  private async make(github: string, path: string, log?: (message: string) => void): Promise<void> {
    const making = `${path}.new-${randomUUID()}`;
    mkdirSync(dirname(path), { recursive: true });
    const git = (...args: string[]) => mustExec(this.exec, 'git', ['-C', making, ...args]);
    try {
      await mustExec(this.exec, 'git', ['init', '--quiet', '--bare', '--template=', making]);
      await git('config', 'remote.origin.url', this.url(github));
      await git('config', 'remote.origin.fetch', MIRROR_REFSPEC);
      // Its whole history: the agents' repositories, the diffs and the fingerprints are read from it.
      this.repos.set(resolve(making), github);
      await fetchOrigin(this.exec, making, { deadlineMs: MIRROR_CLONE_DEADLINE_MS, auth: this.auth, ...(log ? { log } : {}) });
      await this.setHead(making);
      renameSync(making, path);
    } catch (err) {
      await rm(making, { recursive: true, force: true });
      throw err;
    } finally {
      this.repos.delete(resolve(making));
    }
  }

  /**
   * `origin/HEAD` from the forge's default branch while the mirror has none (a repository empty when it was made): never changed
   * once set, as a clone's. `branchReader` reads the forge's own `HEAD` where it matters (ORC-358).
   */
  private async setHead(repo: string, deadlineMs = MIRROR_CLONE_DEADLINE_MS): Promise<void> {
    if ((await originHeadOf(this.exec, repo)).set) return;
    const env = await remoteGitEnv(this.auth, repo, deadlineMs);
    const r = await this.exec('git', ['-C', repo, 'remote', 'set-head', 'origin', '--auto'], { env, timeoutMs: deadlineMs });
    // An empty repository has no default branch yet: `origin/main` is assumed until it has one.
    if (r.code !== 0) this.o.log?.(`mirror of ${this.repos.get(resolve(repo)) ?? repo}: origin/HEAD not set: ${r.stderr.trim().split('\n')[0] ?? ''}`);
  }
}
