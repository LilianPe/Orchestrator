import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { CloneAuth, GitAuth } from '../forge/types.js';
import { repoRef } from '../forge/github-app.js';
import { fetchOrigin, ORIGIN_REFSPEC, remoteGitEnv, type FetchOrigin } from './git-workspaces.js';

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
  /** The repositories whose mirror has no `origin/HEAD` yet, said once. */
  private readonly headless = new Set<string>();
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
    const { owner, name } = repoRef(github);
    if (!SEGMENT.test(owner) || !SEGMENT.test(name)) throw new Error(`not a GitHub repository, \`owner/name\` expected: ${github}`);
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
   * `git fetch origin` in `repo` as `fetchOrigin` does it, after the fetch under way there: a mirror missing yet is made first,
   * whole, within `MIRROR_CLONE_DEADLINE_MS` rather than the caller's deadline, then fetched as asked when `refspecs` name more
   * than its branches. Its branches are fetched with `--prune` (ORC-486): a branch deleted on the forge is no longer seen; a
   * workspace on it loses nothing, its objects being its own (`agentRepository`). A launch that reads the mirror outside this turn
   * (`prepare`) while another's fetch prunes the branch it is on fails, its workspace not made. A path that is not a mirror (a replayed
   * ticket's clone) is fetched as it is, without a token.
   */
  readonly fetch: FetchOrigin = (repo, o = {}) =>
    this.turn(repo, async () => {
      const github = this.repos.get(resolve(repo));
      const branches = !o.refspecs?.length;
      if (github && !existsSync(repo)) {
        await this.make(github, repo, o.log);
        if (branches) return;
      }
      await fetchOrigin(this.exec, repo, { ...o, auth: this.auth, prune: !!github && branches });
      if (github) await this.setHead(github, repo, o.deadlineMs);
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
   * Made aside, at a path of this process's own (`<path>.new-<pid>`), then renamed: a daemon killed halfway leaves no mirror half
   * fetched, and the copy of a process no longer alive is removed by the next making. Another process (`factory ghost`) making it
   * at the same time keeps its own copy; the first renamed wins, the other's copy goes.
   */
  private async make(github: string, path: string, log?: (message: string) => void): Promise<void> {
    const making = `${path}.new-${process.pid}`;
    mkdirSync(dirname(path), { recursive: true });
    await removeDeadCopies(path);
    const git = (...args: string[]) => mustExec(this.exec, 'git', ['-C', making, ...args]);
    try {
      await mustExec(this.exec, 'git', ['init', '--quiet', '--bare', '--template=', making]);
      await git('config', 'remote.origin.url', this.url(github));
      await git('config', 'remote.origin.fetch', ORIGIN_REFSPEC);
      // Its whole history: the agents' repositories, the diffs and the fingerprints are read from it.
      await fetchOrigin(this.exec, making, { deadlineMs: MIRROR_CLONE_DEADLINE_MS, auth: this.tokenOf(github), ...(log ? { log } : {}) });
      await this.setHead(github, making);
      if (!renamed(making, path)) {
        await rm(making, { recursive: true, force: true });
      }
    } catch (err) {
      await rm(making, { recursive: true, force: true });
      throw err;
    }
  }

  /** The `CloneAuth` of `github`'s mirror at whatever path it is (`make`'s, aside). */
  private tokenOf(github: string): CloneAuth {
    return async () => (this.o.auth ? this.o.auth(github) : {});
  }

  /**
   * `origin/HEAD` from the forge's default branch while the mirror has none (a repository empty when it was made), or while
   * the branch it names is gone: a fetch prunes it once the forge renamed its default branch (ORC-486). Else never changed, as
   * a clone's. `branchReader` reads the forge's own `HEAD` where it matters (ORC-358).
   */
  private async setHead(github: string, repo: string, deadlineMs = MIRROR_CLONE_DEADLINE_MS): Promise<void> {
    if ((await this.exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD'])).code === 0) return;
    const env = await remoteGitEnv(this.tokenOf(github), repo, deadlineMs);
    const r = await this.exec('git', ['-C', repo, 'remote', 'set-head', 'origin', '--auto'], { env, timeoutMs: deadlineMs });
    if (r.code === 0) return;
    // Pruned after a rename: a reader of the default branch fails until a next fetch sets it, said at each failure.
    const gone = await this.exec('git', ['-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (gone.code === 0) this.o.log?.(`mirror of ${github}: origin/HEAD names ${gone.stdout.trim()}, which the forge no longer has, set again at a next fetch: ${r.stderr.trim().split('\n')[0] ?? ''}`);
    else this.sayHeadless(github, r.stderr);
  }

  /** An empty repository has no default branch yet: `origin/main` is assumed until it has one, said once. */
  private sayHeadless(github: string, stderr: string): void {
    if (this.headless.has(github)) return;
    this.headless.add(github);
    this.o.log?.(`mirror of ${github}: origin/HEAD not set, set at a next fetch once the repository has a default branch: ${stderr.trim().split('\n')[0] ?? ''}`);
  }
}

/** `from` renamed to `to`; false when `to` exists already (another process made it first). */
function renamed(from: string, to: string): boolean {
  if (existsSync(to)) return false;
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if (['ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

/** The copies `<path>.new-<pid>` of processes no longer alive, killed while they made the mirror, and this process's own left before. */
async function removeDeadCopies(path: string): Promise<void> {
  const prefix = `${basename(path)}.new-`;
  for (const name of readdirSync(dirname(path))) {
    const pid = name.startsWith(prefix) ? Number(name.slice(prefix.length)) : NaN;
    if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || !alive(pid))) await rm(join(dirname(path), name), { recursive: true, force: true });
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
