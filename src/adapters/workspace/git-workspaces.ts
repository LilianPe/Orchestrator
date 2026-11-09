import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { branchName } from '../../core/naming.js';
import { capDiff, DIFF_MAX } from '../../core/review.js';
import { forkPoint, gitAt, gitReader, parseRawDiff, within, zFields, type BranchReader, type CloneGit } from '../../core/clean-verify.js';
import { STALLED } from '../../publish/publish.js';
import { execCmd, execFailure, HARDENING, mustExec, TIMED_OUT, type Exec } from '../exec.js';
import { readCapped } from '../read-capped.js';
import type { StepDiff, Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

function assertSafe(id: string): void {
  if (/[\\/]/.test(id) || id.includes('..')) throw new Error(`Invalid identifier: ${id}`);
}

/**
 * What the agent's repository takes of the repository's own config, and nothing else (ORC-341): its identity and line
 * endings for a commit, Git LFS's filter, its remotes' URLs and what they fetch, each value without the credentials of a
 * URL (`withoutUserinfo`).
 * Left out, whatever its key: what reaches the forge with a credential (an extraheader, `credential.*`, a push URL, an
 * `insteadOf` that names a token), runs a command of the host's (`core.sshCommand`, a hooks path), or describes the
 * repository's layout. The agent has no token (ORC-125): the factory alone pushes, with its own.
 */
const INHERITED = /^(user\.(name|email)|core\.(autocrlf|eol)|filter\.lfs\.(clean|smudge|process|required)|remote\..+\.(url|fetch))$/i;
/** What the checkout that makes it (`agentRepository`) never takes of that config either: the layout of that repository, or a host's path for its hooks. */
const LAYOUT = /^(core\.(bare|repositoryformatversion|worktree|hookspath|fsmonitor|sparsecheckout|sparsecheckoutcone)$|extensions\.)/i;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Git's own rules on a ref's name (`git check-ref-format`), as a name out of them cannot be its branch. Never `..`: it becomes a path. */
const BRANCH_REF = /^refs\/heads\/(?!-|\.)(?!.*(\.\.|@\{|\/\.|\/\/|\.lock(\/|$)))[^\s\p{Cc}~^:?*[\\]+$/u;
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
 * agent left, as git would: only a verdict on a commit out of its reach (`verify`) is proof.
 */
function agentHead(work: string): { branch: string; sha?: string } | undefined {
  const gitDir = join(work, '.git');
  if (!isDir(gitDir)) return undefined;
  const head = agentFile(gitDir, 'HEAD')?.trim();
  if (!head) return undefined;
  if (SHA.test(head)) return { branch: 'HEAD', sha: head };
  const ref = /^ref: (\S+)$/.exec(head)?.[1];
  if (!ref || !BRANCH_REF.test(ref)) return undefined;
  const branch = ref.slice('refs/heads/'.length);
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

/** A launch waits this long for the forge, at most: past it, it is refused (ORC-209 C). */
export const FETCH_DEADLINE_MS = 2 * 60_000;
/** What the launch still gives git, killed at its deadline, to end: past it, it stops waiting for a process that left git's group. */
const FETCH_GRACE_MS = 5_000;

/**
 * `git fetch origin` in `repo`, never longer than `deadlineMs` and never a prompt for a credential: past the deadline,
 * git and what stayed in its process group (its ssh) are killed, and the launch stops waiting a few seconds later
 * whatever still holds git's output. A failure's message reaches the ticket (Linear): it names neither the server's
 * path nor the command, which go to `log`. `refspecs`: what to fetch, instead of what the remote's config says.
 */
export async function fetchOrigin(exec: Exec, repo: string, o: { deadlineMs?: number; log?: (message: string) => void; refspecs?: readonly string[] } = {}): Promise<void> {
  const deadlineMs = o.deadlineMs ?? FETCH_DEADLINE_MS;
  const silent = `the forge no longer responds after ${deadlineMs / 1000} s`;
  const args = ['-C', repo, 'fetch', '--quiet', 'origin', ...(o.refspecs ?? [])];
  const expired = () => o.log?.(`git ${args.join(' ')}: killed at ${deadlineMs / 1000} s, its output still held ${FETCH_GRACE_MS / 1000} s later by a process out of its group`);
  // A forge silent past the deadline, whichever of git or `within` gives up first: a timeout (`isTransient`, ORC-343).
  const timedOut = () => Object.assign(new Error(silent), { code: 'ETIMEDOUT' });
  const r = await within(exec('git', args, { env: { GIT_TERMINAL_PROMPT: '0', ...STALLED }, timeoutMs: deadlineMs }), deadlineMs + FETCH_GRACE_MS, silent, expired).catch((err: Error) => {
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

  /** `log`: the detail of a failed fetch (the server's path, git's own words), which the ticket never gets. */
  constructor(private o: { root: string; exec?: Exec; fetchDeadlineMs?: number; log?: (message: string) => void }) {
    this.exec = o.exec ?? execCmd;
  }

  private git(repo: string, ...args: string[]): Promise<string> {
    return mustExec(this.exec, 'git', ['-C', repo, ...args]);
  }

  /** Bounded: a forge that does not answer refuses the launch, which never waits for it forever (ORC-209). */
  private fetch(repo: string, refspecs?: readonly string[]): Promise<void> {
    return fetchOrigin(this.exec, repo, { deadlineMs: this.o.fetchDeadlineMs, log: this.o.log, ...(refspecs ? { refspecs } : {}) });
  }

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    assertSafe(req.projectId);
    assertSafe(req.ticketId);
    if (req.kind === 'trunk-readonly') return this.trunkWorkspace(req);
    if (req.kind === 'published') return this.publishedWorkspace(req);
    const path = join(this.o.root, req.projectId, req.ticketId);
    const port = req.portBase + req.slot;
    if (existsSync(path)) {
      const branch = agentHead(path)?.branch;
      if (!branch) throw new Error(`The git repository of ${path} is not the one the factory created, or is no longer readable: this worktree must be deleted.`);
      return { path, port, branch };
    }
    await this.fetch(req.repoPath);
    const branch = branchName(req.ticketId, req.title);
    const has = async (ref: string) =>
      (await this.exec('git', ['-C', req.repoPath, 'rev-parse', '--verify', '--quiet', ref])).code === 0;
    const trunk = await originHead(this.exec, req.repoPath);
    let existing: string | undefined;
    let checkout = ['--no-track', '-b', branch, trunk];
    let local: string | undefined;
    // The forge first: an agent's commits reach it, never the repository's own branch, which can only lag behind.
    if (await has(`refs/remotes/origin/${branch}`)) {
      existing = `refs/remotes/origin/${branch}`;
      // In full, as the trunk: a short `origin/<branch>` resolves a tag of that name first.
      checkout = ['-b', branch, existing];
    } else if (await has(`refs/heads/${branch}`)) {
      existing = local = `refs/heads/${branch}`;
      checkout = [branch];
    }
    // On a branch that already existed: only its commits beyond the default branch count.
    const ahead = !!existing && (await this.git(req.repoPath, 'rev-list', '--count', `${trunk}..${existing}`)).trim() !== '0';
    await this.agentRepository(req.repoPath, path, trunk, checkout, local);
    return { path, port, branch, fresh: true, ...(ahead ? { ahead } : {}) };
  }

  /**
   * The agent's own repository at `path`, its `.git` inside its worktree (ORC-317). Everything in it, config, hooks,
   * refs, the `.git` itself, is the agent's: the repository of `repo`, its config, its hooks and its refs, is never
   * mounted in a sandbox, so that git can go on running on it on the host. No git of the host runs in `path` afterwards:
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
   * mount at the same path. What is fetched is what the forge has and the ticket's own branch, not another ticket's.
   * Made aside, then renamed: a daemon killed halfway leaves no directory the next launch would take for a worktree.
   */
  private async agentRepository(repo: string, path: string, trunk: string, checkout: readonly string[], localRef?: string): Promise<void> {
    const making = `${path}.new`;
    await rm(making, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    // Nothing of an agent has run in it: the checkout runs no hook, as `--template=` left none, and reads the daemon's own config.
    const here = (args: string[], env?: Record<string, string>) => mustExec(this.exec, 'git', [...HARDENING.flatMap((c) => ['-c', c]), ...args], { env });
    try {
      await here(['init', '--quiet', '--template=', making]);
      // A key without a value is a boolean's true: `-z --list` gives it without the newline.
      const config = zFields(await this.git(repo, 'config', '--local', '-z', '--list')).map((entry): [string, string] => {
        const at = entry.indexOf('\n');
        return at < 0 ? [entry, 'true'] : [entry.slice(0, at), entry.slice(at + 1)];
      });
      // Every value: a URL is never inherited with its credentials, whatever key the list admits next.
      for (const [key, value] of config) if (INHERITED.test(key)) await here(['-C', making, 'config', '--add', key, withoutUserinfo(value)]);
      // The checkout's LFS filter reaches the forge as the repository does, its credentials included: in the env of that
      // checkout alone, never on a command line nor in the agent's config.
      const forHost = config.filter(([key]) => !LAYOUT.test(key));
      const asRepo = Object.fromEntries([
        ['GIT_CONFIG_COUNT', String(forHost.length)],
        ...forHost.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]]),
      ]);
      // Resolved: it is read from `making`, and `repoPath` can be relative.
      await here(['-C', making, 'fetch', '--quiet', '--no-tags', '--', resolve(repo), '+refs/remotes/origin/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*', ...(localRef ? [`+${localRef}:${localRef}`] : [])]);
      await here(['-C', making, 'symbolic-ref', 'refs/remotes/origin/HEAD', trunk]);
      await here(['-C', making, 'checkout', '--quiet', ...checkout], asRepo);
      await here(['-C', making, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.claude/*', '/.claude/CLAUDE.md'], asRepo);
      renameSync(making, path);
    } catch (err) {
      await rm(making, { recursive: true, force: true });
      throw err;
    }
  }

  /** One per question, gone with it (`release`): what a question's agent left is for nobody else, and nothing has to be put back. */
  private async trunkWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    const { path, trunk } = await this.runClone(req);
    await this.agentRepository(req.repoPath, path, trunk, ['--detach', trunk]);
    return { path };
  }

  /** Where a run's own repository goes (`_trunk/<runId>`, gone with it), and the trunk, read once the forge is fetched. */
  private async runClone(req: WorkspaceRequest): Promise<{ path: string; trunk: string }> {
    assertSafe(req.runId);
    await this.fetch(req.repoPath);
    return { path: join(this.o.root, req.projectId, '_trunk', req.runId), trunk: await originHead(this.exec, req.repoPath) };
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
    const diff = await trunkDiff(gitAt(this.exec, req.repoPath, {}), trunk, req.sha);
    await this.agentRepository(req.repoPath, path, trunk, ['--detach', req.sha]);
    return { path, diff };
  }

  async ticketDiff(repoPath: string, path: string): Promise<string | undefined> {
    const [at, trunk] = await Promise.all([this.worktreeGit(repoPath, path), originHead(this.exec, repoPath)]);
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
   * A worktree's head, and git on the factory's repository, its config and its hooks, to read it: the agent's objects are
   * only one more place to read objects from, whatever their `info/alternates` says. A link for `objects` could reach
   * another repository's: not followed. None for a path that is no worktree.
   */
  private async worktreeGit(repoPath: string, path: string): Promise<{ head: string; git: CloneGit } | undefined> {
    const head = await this.head(path);
    // Absolute: read from `repoPath`, and the workspaces' root can be relative.
    const objects = resolve(path, '.git', 'objects');
    if (!head || !isDir(objects)) return undefined;
    return { head, git: gitAt(this.exec, repoPath, { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }) };
  }

  async stepDiff(repoPath: string, path: string, base: string): Promise<StepDiff | undefined> {
    const at = await this.worktreeGit(repoPath, path);
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
   * `origin/HEAD`, which no fetch refreshes, still names an old one (ORC-358); a forge that does not answer rejects.
   * Without, against the repository's default branch as it is, no forge read.
   */
  async branchReader(repoPath: string, path: string, o: { fetch: boolean }): Promise<BranchReader | undefined> {
    const at = await this.worktreeGit(repoPath, path);
    if (!at) return undefined;
    const base = o.fetch ? await this.forgeHead(repoPath) : await originHead(this.exec, repoPath);
    return gitReader(at.git, base, await forkPoint(at.git, at.head, base), at.head);
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

  /** Git in the agent's directory, on the host: only without sandboxes (`FACTORY_ALLOW_HOST_VERIFY`), where the agent runs on the host anyway. */
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

  async remoteBranchExists(repoPath: string, prefix: string): Promise<boolean> {
    const out = await this.git(repoPath, 'ls-remote', '--heads', 'origin');
    return out
      .split('\n')
      .map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, ''))
      .some((name) => !!name && name.startsWith(prefix));
  }
}
