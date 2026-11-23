import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { BRANCH_NAME, branchName, legacyBranchName } from '../../core/naming.js';
import { capDiff, DIFF_MAX } from '../../core/review.js';
import { forkPoint, gitAt, gitReader, isYes, parseRawDiff, within, zFields, type BranchReader, type CloneGit } from '../../core/clean-verify.js';
import { STALLED } from '../../publish/publish.js';
import { execCmd, execFailure, HARDENING, mustExec, TIMED_OUT, type Exec } from '../exec.js';
import { readCapped } from '../read-capped.js';
import type { CloneAuth } from '../forge/types.js';
import { FACTORY_GIT_IDENTITY } from '../../product.js';
import type { StepDiff, Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

function assertSafe(id: string): void {
  if (/[\\/]/.test(id) || id.includes('..')) throw new Error(`Invalid identifier: ${id}`);
}

/** A Git LFS filter the host's config installs, off for the checkout that makes an agent's repository: the files stay its pointers. */
const NO_LFS = ['filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false'].flatMap((c) => ['-c', c]);
/** What a daemon's mirror and an agent's repository fetch from their `origin`, as a clone's: every branch of the forge, as remote-tracking refs. */
export const ORIGIN_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
/** A commit's full id, SHA-1 or SHA-256. */
export const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_REFS_BYTES = 16 * 1024 * 1024;

/**
 * A file of the agent's git dir, as data. It can be anything by the time it is opened: not out of that dir by a link on
 * the way, never a link itself, never a FIFO that would hold the daemon, never more than the cap. Whatever else it is, it reads as absent.
 */
function agentFile(gitDir: string, name: string): string | undefined {
  try {
    const path = join(gitDir, name);
    if (!realpathSync(path).startsWith(realpathSync(gitDir) + sep)) return undefined;
    const read = readCapped(path, MAX_REFS_BYTES);
    return read && read !== 'not a file' && !read.cut ? read.text : undefined;
  } catch {
    return undefined;
  }
}

const isDir = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Where a workspace's HEAD is, read as data: no git runs in a directory the agent writes, whose `.git` it can point at
 * a config of its own (ORC-317). As `rev-parse --abbrev-ref HEAD`, `branch` is `HEAD` when detached. It says what the
 * agent left, as git would: only a verdict on a commit out of its reach (`verify`) is proof. In the files ref storage
 * `agentRepository` makes it with (ORC-348): an agent that moves it to reftable leaves no head to read.
 */
function agentHead(work: string): { branch: string; sha?: string } | undefined {
  const gitDir = join(work, '.git');
  if (!isDir(gitDir)) return undefined;
  const head = agentFile(gitDir, 'HEAD')?.trim();
  if (!head) return undefined;
  if (SHA.test(head)) return { branch: 'HEAD', sha: head };
  const ref = /^ref: (\S+)$/.exec(head)?.[1];
  if (!ref?.startsWith('refs/heads/')) return undefined;
  // Git's own rules on a branch's name, as a name out of them cannot be its branch (shared with the naming, ORC-283).
  const branch = ref.slice('refs/heads/'.length);
  if (!BRANCH_NAME.test(branch)) return undefined;
  const loose = agentFile(gitDir, ref)?.trim();
  if (loose && SHA.test(loose)) return { branch, sha: loose };
  const packed = agentFile(gitDir, 'packed-refs')?.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0];
  return packed && SHA.test(packed) ? { branch, sha: packed } : { branch };
}

/**
 * A remote's URL without what authenticates it: `https://x-access-token:…@`, or a token as the user, a transport's
 * (`<helper>::<url>`) included. Over ssh the user stays, as the server's login, never its password. An scp-like
 * `git@host:path` or a path has none.
 */
export function withoutUserinfo(url: string): string {
  return url.replace(/(^|::)([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/i, (_, at: string, scheme: string, userinfo: string) => {
    const user = /^(git\+)?ssh(\+git)?:/i.test(scheme) ? userinfo.split(':')[0] : '';
    return `${at}${scheme}${user ? `${user}@` : ''}`;
  });
}

/** The paths of `git status --porcelain -z`, a rename's or copy's both sides included (ORC-123). */
export function parseStatus(out: string): string[] {
  const fields = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    paths.push(fields[i]!.slice(3));
    if (/^[RC]/.test(fields[i]!)) paths.push(fields[++i]!);
  }
  return paths;
}

/**
 * The default branch as a full ref, `refs/remotes/origin/<name>`; `refs/remotes/origin/main` when the clone does not
 * know it. In full: a short `origin/main` is resolved by git as `refs/tags/origin/main` first, a tag anyone who pushes
 * to the forge can make.
 */
export async function originHead(exec: Exec, repo: string): Promise<string> {
  return (await originHeadOf(exec, repo)).ref;
}

/** `originHead` (`ref`), its short name for a message (`origin/main`), and whether `origin/HEAD` gave it (`set`) or `origin/main` is assumed. */
export async function originHeadOf(exec: Exec, repo: string): Promise<{ ref: string; name: string; set: boolean }> {
  const r = await exec('git', ['-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
  const ref = r.code === 0 ? r.stdout.trim() : 'refs/remotes/origin/main';
  return { ref, name: ref.replace(/^refs\/remotes\//, ''), set: r.code === 0 };
}

/** A `fetchOrigin` of the repository at `repo`, its token and its turn the caller's (`RepoMirrors.fetch`). */
export type FetchOrigin = (repo: string, o?: { deadlineMs?: number; log?: (message: string) => void; refspecs?: readonly string[] }) => Promise<void>;

/** A launch waits this long for the forge, at most: past it, it is refused (ORC-209 C). */
export const FETCH_DEADLINE_MS = 2 * 60_000;
/** What the launch still gives git, killed at its deadline, to end: past it, it stops waiting for a process that left git's group. */
const FETCH_GRACE_MS = 5_000;

/**
 * `git fetch origin` in `repo`, never longer than `deadlineMs` and never a prompt for a credential: past the deadline,
 * git and what stayed in its process group (its ssh) are killed, and the launch stops waiting a few seconds later
 * whatever still holds git's output. A failure's message reaches the ticket (Linear): it names neither the server's
 * path nor the command, which go to `log`. `refspecs`: what to fetch, instead of what the remote's config says. `auth`: the
 * App's token for a private repository (ORC-442), in git's environment. `prune`: the refs of what the forge no longer has go,
 * within what is fetched (ORC-486).
 */
export async function fetchOrigin(exec: Exec, repo: string, o: { deadlineMs?: number; log?: (message: string) => void; refspecs?: readonly string[]; auth?: CloneAuth; prune?: boolean } = {}): Promise<void> {
  const deadlineMs = o.deadlineMs ?? FETCH_DEADLINE_MS;
  const silent = `the forge no longer responds after ${deadlineMs / 1000} s`;
  const args = ['-C', repo, 'fetch', '--quiet', ...(o.prune ? ['--prune'] : []), 'origin', ...(o.refspecs ?? [])];
  const expired = () => o.log?.(`git ${args.join(' ')}: killed at ${deadlineMs / 1000} s, its output still held ${FETCH_GRACE_MS / 1000} s later by a process out of its group`);
  // A forge silent past the deadline, whichever of git or `within` gives up first: a timeout (`isTransient`, ORC-343).
  const timedOut = () => Object.assign(new Error(silent), { code: 'ETIMEDOUT' });
  const env = await remoteGitEnv(o.auth, repo, deadlineMs);
  const r = await within(exec('git', args, { env, timeoutMs: deadlineMs }), deadlineMs + FETCH_GRACE_MS, silent, expired).catch((err: Error) => {
    throw err.message === silent ? timedOut() : err;
  });
  if (r.code === 0) return;
  const failure = execFailure('git', args, r);
  o.log?.(failure.message);
  if (r.code === TIMED_OUT) throw timedOut();
  // git's own words stay out of the message, which reaches the ticket, but in its cause: `isTransient` reads them (ORC-343).
  throw new Error(`the forge could not be read (git fetch, code ${r.code})`, { cause: failure });
}

/**
 * The env of a git that reaches `repo`'s remote: never a prompt, a stalled transfer aborted, and `auth`'s token (ORC-442),
 * asked of GitHub's API within `deadlineMs`, which can stall as the forge can: past it, a timeout (`isTransient`); any other
 * failure as `auth` rejected, its cause kept for `isTransient`.
 */
export async function remoteGitEnv(auth: CloneAuth | undefined, repo: string, deadlineMs: number): Promise<Record<string, string>> {
  const silent = `GitHub gave no installation token after ${deadlineMs / 1000} s`;
  const token = auth
    ? await within(auth(repo), deadlineMs, silent).catch((err: Error) => {
        throw err.message === silent ? Object.assign(new Error(silent), { code: 'ETIMEDOUT' }) : new Error('the forge could not be read (no installation token)', { cause: err });
      })
    : {};
  return { GIT_TERMINAL_PROMPT: '0', ...STALLED, ...token };
}

/**
 * A commit's diff against the trunk, capped (`capDiff`), its external diff drivers and text conversions off. Read up to past
 * the cap only: a diff that big is given as its changed files, by name.
 */
async function trunkDiff(git: CloneGit, trunk: string, head: string, past?: string): Promise<string> {
  const range = `${trunk}...${head}`;
  const diff = await git.capped(DIFF_MAX + 1, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', range);
  return capDiff(diff, () => git.raw('diff', '--name-only', range), { past });
}

export class GitWorkspaces implements WorkspaceManager {
  private exec: Exec;

  /**
   * `log`: the detail of a failed fetch (the server's path, git's own words), which the ticket never gets. `auth`: what reads a
   * private forge (ORC-442), by the repository's path. `fetch`: what fetches a mirror (`RepoMirrors.fetch`, ORC-479), one fetch at
   * a time there; `fetchOrigin` with `auth` by default.
   */
  constructor(private o: { root: string; exec?: Exec; fetchDeadlineMs?: number; log?: (message: string) => void; auth?: CloneAuth; fetch?: FetchOrigin }) {
    this.exec = o.exec ?? execCmd;
  }

  private git(repo: string, ...args: string[]): Promise<string> {
    return mustExec(this.exec, 'git', ['-C', repo, ...args]);
  }

  /** Bounded: a forge that does not answer refuses the launch, which never waits for it forever (ORC-209). */
  private fetch(repo: string, refspecs?: readonly string[]): Promise<void> {
    const o = { deadlineMs: this.o.fetchDeadlineMs, log: this.o.log, ...(refspecs ? { refspecs } : {}) };
    return this.o.fetch ? this.o.fetch(repo, o) : fetchOrigin(this.exec, repo, { ...o, auth: this.o.auth });
  }

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    assertSafe(req.projectId);
    assertSafe(req.ticketId);
    if (req.kind === 'trunk-readonly') return this.trunkWorkspace(req);
    if (req.kind === 'published') return this.publishedWorkspace(req);
    const path = join(this.o.root, req.projectId, req.ticketId);
    if (existsSync(path)) {
      const branch = agentHead(path)?.branch;
      if (!branch) {
        // The message reaches the ticket (Linear): the worktree by its project and ticket, its path on the server in the log.
        this.o.log?.(`${path}: not the git repository the factory created, or no longer readable`);
        throw new Error(`The git repository of the worktree ${req.projectId}/${req.ticketId} is not the one the factory created, or is no longer readable: this worktree must be deleted.`);
      }
      return { path, branch };
    }
    if (!req.fetched) await this.fetch(req.mirror);
    const has = async (ref: string) =>
      (await this.exec('git', ['-C', req.mirror, 'rev-parse', '--verify', '--quiet', ref])).code === 0;
    const trunk = await originHead(this.exec, req.mirror);
    // The name asked, else the legacy one a ticket already has (ORC-283): its open PR stays the one, never a second beside it.
    const names = [...new Set([req.branch ?? branchName(req.ticketId, req.title), legacyBranchName(req.ticketId, req.title)])];
    // The forge alone: an agent's commits reach it, and the mirror has no branch of its own (ORC-479).
    const onForge = await findAsync(names, (n) => has(`refs/remotes/origin/${n}`));
    const branch = onForge ?? names[0]!;
    // In full, as the trunk: a short `origin/<branch>` resolves a tag of that name first.
    const existing = onForge === undefined ? undefined : `refs/remotes/origin/${branch}`;
    const checkout = existing ? ['-b', branch, existing] : ['--no-track', '-b', branch, trunk];
    // On a branch that already existed: only its commits beyond the default branch count.
    const ahead = !!existing && (await this.git(req.mirror, 'rev-list', '--count', `${trunk}..${existing}`)).trim() !== '0';
    await this.agentRepository(req.mirror, path, trunk, checkout);
    return { path, branch, fresh: true, ...(ahead ? { ahead } : {}) };
  }

  /**
   * The agent's own repository at `path`, its `.git` inside its worktree (ORC-317). Everything in it, config, hooks,
   * refs, the `.git` itself, is the agent's: the repository of `repo` (the daemon's mirror, ORC-479), its config, its hooks
   * and its refs, is never mounted in a sandbox, so that git can go on running on it on the host. No git of the host runs in `path` afterwards:
   * `agentHead` and `stepDiff` read it as data, and what git must do in it is done here, before any agent.
   *
   * Left out of its sparse checkout but for `.claude/CLAUDE.md`, which the factory reads as the
   * repo's conventions (`readConventions`) and the session does not load (`--setting-sources ""`, ORC-128).
   * The rest: the agent's session cannot load it, `git status`, `add -A`
   * or `commit -a` neither see nor commit it as deleted, so a PR never drops the repo's `.claude/`, and a
   * merge or rebase that changes it does not write it back (skip-worktree alone did). The index keeps it.
   * `!/.claude/*`, not `!/.claude/`: git re-includes a file only if its parent directory is not excluded.
   *
   * Its objects are copied, not shared: a hard link would let the agent rewrite the factory's, and an alternate needs a
   * mount at the same path. What is fetched is what the forge has, nothing of the mirror's own.
   * Made aside, then renamed: a daemon killed halfway leaves no directory the next launch would take for a worktree.
   *
   * Its config is written here, key by key, never taken from `repo`'s (ORC-479, after ORC-341's allow list): the factory's
   * identity for a commit (`FACTORY_GIT_IDENTITY`), and `origin` as `repo` names it, without the credentials of a URL
   * (`withoutUserinfo`), fetching every branch. No Git LFS filter: the runner's image has no `git-lfs`, and a filter naming a
   * missing command fails each checkout (`filter-process`) or each file. The checkout on the host runs no LFS filter either
   * (`NO_LFS`), whatever the host's own config installs: the worktree holds the pointers its index has, which the agent's git,
   * with no clean filter, reads as unchanged; a file it downloaded would be committed whole in place of its pointer. The agent
   * has no token (ORC-125): the factory alone pushes, with its own, and the checkout needs none.
   */
  private async agentRepository(repo: string, path: string, trunk: string, checkout: readonly string[]): Promise<void> {
    const making = `${path}.new`;
    await rm(making, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    // Nothing of an agent has run in it: the checkout runs no hook, as `--template=` left none, and reads the daemon's own config.
    const here = (args: string[], env?: Record<string, string>) => mustExec(this.exec, 'git', [...HARDENING.flatMap((c) => ['-c', c]), ...args], { env });
    try {
      // Its refs as files, which `agentHead` reads as data, whatever the host's git makes by default (reftable from git 3,
      // ORC-348): the variable wins over any config, and a git older than 2.45 ignores it.
      await here(['init', '--quiet', '--template=', making], { GIT_DEFAULT_REF_FORMAT: 'files' });
      const origin = (await this.exec('git', ['-C', repo, 'config', '--get', 'remote.origin.url'])).stdout.trim();
      const config: [string, string][] = [
        ...Object.entries(FACTORY_GIT_IDENTITY),
        ...(origin ? ([['remote.origin.url', withoutUserinfo(origin)], ['remote.origin.fetch', ORIGIN_REFSPEC]] as [string, string][]) : []),
      ];
      for (const [key, value] of config) await here(['-C', making, 'config', key, value]);
      // Resolved: it is read from `making`, and the mirror's root can be relative.
      await here(['-C', making, 'fetch', '--quiet', '--no-tags', '--', resolve(repo), '+refs/remotes/origin/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']);
      await here(['-C', making, 'symbolic-ref', 'refs/remotes/origin/HEAD', trunk]);
      await here([...NO_LFS, '-C', making, 'checkout', '--quiet', ...checkout]);
      await here([...NO_LFS, '-C', making, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.claude/*', '/.claude/CLAUDE.md']);
      renameSync(making, path);
    } catch (err) {
      await rm(making, { recursive: true, force: true });
      throw err;
    }
  }

  /** One per question, gone with it (`release`): what a question's agent left is for nobody else, and nothing has to be put back. */
  private async trunkWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    const { path, trunk } = await this.runClone(req);
    await this.agentRepository(req.mirror, path, trunk, ['--detach', trunk]);
    return { path };
  }

  /** Where a run's own repository goes (`_trunk/<runId>`, gone with it), and the trunk, read once the forge is fetched. */
  private async runClone(req: WorkspaceRequest): Promise<{ path: string; trunk: string }> {
    assertSafe(req.runId);
    await this.fetch(req.mirror);
    return { path: join(this.o.root, req.projectId, '_trunk', req.runId), trunk: await originHead(this.exec, req.mirror) };
  }

  /**
   * What an AI review reads (ORC-183): a repository of its own, like a question's trunk, on the commit the factory published,
   * detached: never the ticket's worktree, which an agent wrote. Its diff against the trunk is read on the factory's repository
   * before any agent runs, its external diff drivers and text conversions off. Gone with its run (`release`).
   */
  private async publishedWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    if (!req.sha) throw new Error('An AI review needs the published commit, and there is no published commit to review.');
    if (!SHA.test(req.sha)) throw new Error(`Not a commit id: ${req.sha}`);
    const { path, trunk } = await this.runClone(req);
    const diff = await trunkDiff(gitAt(this.exec, req.mirror, {}), trunk, req.sha);
    await this.agentRepository(req.mirror, path, trunk, ['--detach', req.sha]);
    return { path, diff };
  }

  async ticketDiff(mirror: string, path: string): Promise<string | undefined> {
    const [at, trunk] = await Promise.all([this.worktreeGit(mirror, path), originHead(this.exec, mirror)]);
    return at && trunkDiff(at.git, trunk, at.head, 'only the changed files are named here, and the clone is the trunk, which holds none of these changes');
  }

  /** No git here: its `.git` goes with it, the commits it did not push too. */
  async cleanup(projectId: string, ticketId: string): Promise<void> {
    assertSafe(projectId);
    assertSafe(ticketId);
    await rm(join(this.o.root, projectId, ticketId), { recursive: true, force: true });
  }

  /** By its project and its run, whatever the workflow says now of the job: it cannot name a ticket's worktree, which holds unpushed commits. */
  async release(projectId: string, runId: string): Promise<void> {
    assertSafe(projectId);
    assertSafe(runId);
    await rm(join(this.o.root, projectId, '_trunk', runId), { recursive: true, force: true });
  }

  async head(path: string): Promise<string | undefined> {
    return agentHead(path)?.sha;
  }

  /**
   * A worktree's head, and git on the factory's mirror, its config and its hooks, to read it: the agent's objects are
   * only one more place to read objects from, whatever their `info/alternates` says. A link for `objects` could reach
   * another repository's: not followed. None for a path that is no worktree.
   */
  private async worktreeGit(mirror: string, path: string): Promise<{ head: string; git: CloneGit } | undefined> {
    const head = await this.head(path);
    // Absolute: read from `mirror`, and the workspaces' root can be relative.
    const objects = resolve(path, '.git', 'objects');
    if (!head || !isDir(objects)) return undefined;
    return { head, git: gitAt(this.exec, mirror, { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }) };
  }

  async stepDiff(mirror: string, path: string, base: string): Promise<StepDiff | undefined> {
    const at = await this.worktreeGit(mirror, path);
    if (!at) return undefined;
    const { head, git } = at;
    // Without renames, a source file moved into a test is its deletion: a change outside the tests.
    const changed = parseRawDiff(await git.raw('diff', '--raw', '--no-renames', '-z', base, head)).map(({ path: p, deleted }) => ({ path: p, deleted }));
    const show = async (rev: string, p: string) => {
      const r = await git.status('show', `${rev}:${p}`);
      return r.code === 0 ? r.stdout : undefined;
    };
    return {
      head,
      changed,
      existsAtBase: async (paths) => {
        if (paths.length === 0) return new Set();
        // One process for every candidate: the files at the base under these paths.
        const listed = zFields(await git.raw('--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', base, '--', ...paths));
        return new Set(paths.filter((p) => listed.some((f) => f === p || f.startsWith(`${p}/`))));
      },
      showAtBase: (p) => show(base, p),
      showAtHead: (p) => show(head, p),
      filesAtHead: async () => zFields(await git.raw('ls-tree', '-r', '--name-only', '-z', head)),
    };
  }

  /**
   * The same reading as the clone's (`gitReader`), on the factory's repository. With `fetch`, against the forge's default
   * branch, its `HEAD` fetched as the clone fetches it, so that the fork point and the config are the forge's even when
   * `origin/HEAD`, which a fetch sets again only once the old one is deleted on the forge (ORC-486), still names an old one (ORC-358); a forge that does not answer rejects.
   * Without, against the repository's default branch as it is, no forge read.
   */
  async branchReader(mirror: string, path: string, o: { fetch: boolean }): Promise<BranchReader | undefined> {
    const at = await this.worktreeGit(mirror, path);
    if (!at) return undefined;
    const base = o.fetch ? await this.forgeHead(mirror) : await originHead(this.exec, mirror);
    return gitReader(at.git, base, await forkPoint(at.git, at.head, base), at.head);
  }

  async baseReader(mirror: string, path: string): Promise<BranchReader['showAtFork'] | undefined> {
    const [at, trunk] = await Promise.all([this.worktreeGit(mirror, path), originHead(this.exec, mirror)]);
    if (!at) return undefined;
    // A head with no commit in common with the default branch, an orphan the agent wrote, would declare nothing: the branch
    // instead. A failure of git (the branch missing) throws: no base is not an empty one.
    const fork = await at.git.status('merge-base', trunk, at.head);
    return gitReader(at.git, trunk, isYes(fork) ? fork.stdout.trim() : trunk, at.head).showAtFork;
  }

  /** The commit of the forge's `HEAD`, fetched to a ref of its own, read, then removed: two reads at once never share one. */
  private async forgeHead(repo: string): Promise<string> {
    const ref = `refs/factory/forge-head/${randomUUID()}`;
    await this.fetch(repo, [`+HEAD:${ref}`]);
    try {
      return (await this.git(repo, 'rev-parse', '--verify', `${ref}^{commit}`)).trim();
    } finally {
      await this.git(repo, 'update-ref', '-d', ref).catch(() => {});
    }
  }

  /** Git in the worktree, on the host: only without sandboxes, the fake runner's or a test's daemon, where no agent wrote it (ORC-179). */
  async uncommitted(path: string): Promise<string[]> {
    return parseStatus(await this.git(path, 'status', '--porcelain', '-z', '--untracked-files=all'));
  }

  /**
   * What the sparse checkout (`agentRepository`) does not own: an untracked settings.local.json, what a setup or an
   * agent wrote, what an agent brought back. No git here. A `.claude` that is a link goes, not what it names.
   */
  async resetClaudeDir(path: string): Promise<void> {
    const dir = join(path, '.claude');
    const entries = isDir(dir) ? readdirSync(dir) : [];
    if (!entries.includes('CLAUDE.md')) rmSync(dir, { recursive: true, force: true });
    else for (const e of entries) if (e !== 'CLAUDE.md') rmSync(join(dir, e), { recursive: true, force: true });
  }

  /** Asked of the forge, with its token as a fetch has it: never a prompt, never a wait past the fetch's deadline. */
  async remoteBranchExists(mirror: string, matches: (name: string) => boolean): Promise<boolean> {
    const deadlineMs = this.o.fetchDeadlineMs ?? FETCH_DEADLINE_MS;
    const env = await remoteGitEnv(this.o.auth, mirror, deadlineMs);
    const out = await mustExec(this.exec, 'git', ['-C', mirror, 'ls-remote', '--heads', 'origin'], { env, timeoutMs: deadlineMs });
    return out
      .split('\n')
      .map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, ''))
      .some((name) => !!name && matches(name));
  }
}

/** The first of `items` that `test` takes, tried one after the other. */
async function findAsync<T>(items: readonly T[], test: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) if (await test(item)) return item;
  return undefined;
}
