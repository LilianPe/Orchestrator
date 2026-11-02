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

export async function mustExec(exec: Exec, cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
