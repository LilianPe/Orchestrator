import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;

export const execCmd: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
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

export async function mustExec(exec: Exec, cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) throw execFailure(cmd, args, r);
  return r.stdout;
}
