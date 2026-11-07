import { spawn } from 'node:child_process';
import { devNull } from 'node:os';

/** No hook, no fsmonitor: on each host git command (`-c`), and in a clone's own config (`--config`). */
export const HARDENING = [`core.hooksPath=${devNull}`, 'core.fsmonitor=false'];

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Past it, the command and what it started (its process group: git's ssh) are killed, and the result's code is `TIMED_OUT`. */
  timeoutMs?: number;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

/** The code of a command killed at its deadline, as `timeout(1)` gives it. */
export const TIMED_OUT = 124;

export const execCmd: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    // Its own process group under a deadline, so the kill reaches the grandchildren too (POSIX; Windows kills the child alone).
    const group = opts.timeoutMs !== undefined && process.platform !== 'win32';
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
              else child.kill('SIGKILL');
            } catch {
              // Already gone.
            }
          }, opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: timedOut ? TIMED_OUT : (code ?? 1) });
    });
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
