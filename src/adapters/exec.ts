import { spawn } from 'node:child_process';
import { devNull } from 'node:os';

/** No hook, no fsmonitor: on each host git command (`-c`), and in a clone's own config (`--config`). */
export const HARDENING = [`core.hooksPath=${devNull}`, 'core.fsmonitor=false'];

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Its stdout went past `maxStdout`: the process was killed, and `stdout` is empty. */
  overflow?: true;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Past it, the command and what stayed in its process group (git's ssh) are killed (POSIX; on Windows, the command
   * alone). The code is `TIMED_OUT` only if the command itself was still running then. A process that left the group
   * and holds the output open can still hold the promise: a caller that must not wait bounds it too (`within`).
   * `DEFAULT_EXEC_TIMEOUT_MS` when absent: no command holds its ticket forever (ORC-344).
   */
  timeoutMs?: number;
  /** Past this many bytes of stdout, the command is killed, its output dropped, and the result says `overflow`. */
  maxStdout?: number;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

/** The code of a command killed at its deadline, as `timeout(1)` gives it. */
export const TIMED_OUT = 124;

/**
 * The deadline of a command that names none (ORC-344): twice a check's (`VERIFY_TIMEOUT_MS`, 15 min), which a command
 * capped in a sandbox runs under, so that only a command that never returns reaches it. Its effect then fails and is
 * tried again, its ticket freed.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60_000;

export const execCmd: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    // Its own process group, so the kill at its deadline reaches the grandchildren too (POSIX; Windows kills the child alone).
    const group = process.platform !== 'win32';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    const out: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stderr = '';
    let timedOut = false;
    const kill = () => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const done = (code: number | null | undefined) => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr, code: timedOut ? TIMED_OUT : (exited ?? code ?? 1), ...(overflow ? { overflow: true as const } : {}) });
    };
    // Set when the command itself ends, its pipes perhaps still held by what it left behind.
    let exited: number | undefined;
    child.on('exit', (code) => (exited = code ?? 1));
    const timer = setTimeout(() => {
      timedOut = exited === undefined;
      kill();
      // Ended already: what holds its output past the deadline, perhaps out of the group, does not hold its answer.
      if (!timedOut) done(exited);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (overflow) return;
      size += d.length;
      if (opts.maxStdout !== undefined && size > opts.maxStdout) {
        overflow = true;
        out.length = 0;
        kill();
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => done(code));
  });

/**
 * What a process on the host needs of the daemon's env to work, and no credential: the system, the commit
 * identity, the proxy and the trust of the machine. For what runs code the daemon did not write (ORC-211).
 */
const SYSTEM_ENV = new RegExp(
  `^(${[
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE', 'LC_\\w+', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'XDG_\\w+',
    'GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)',
    'HTTPS?_PROXY', 'NO_PROXY', 'https?_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    // Windows, for the tests of a developer's machine.
    'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'ComSpec', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'PROGRAMFILES',
  ].join('|')})$`,
);

export function systemEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && SYSTEM_ENV.test(k)) env[k] = v;
  return env;
}

export function execFailure(cmd: string, args: string[], r: ExecResult): Error {
  return new Error(`${cmd} ${args.join(' ')}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
}

export async function mustExec(exec: Exec, cmd: string, args: string[], opts?: ExecOpts): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) throw execFailure(cmd, args, r);
  return r.stdout;
}
