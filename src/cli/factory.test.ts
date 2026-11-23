import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, USAGE, usageCommands } from './usage.js';

// ORC-200: the `factory` CLI has the commands of docs/cli.md, and no others; `plan`, `pause` and `resume` are gone.
const root = join(import.meta.dirname, '../..');

/** `factory <args>` as an operator runs it, on an empty FACTORY_HOME: no instance is read before the help. */
function factory(...args: string[]): Promise<{ code: number | null; out: string }> {
  const home = mkdtempSync(join(tmpdir(), 'factory-cli-'));
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/cli/factory.ts'), ...args], { cwd: root, env: { ...process.env, FACTORY_HOME: home } });
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr.on('data', (c: Buffer) => (out += c.toString()));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** The commands of the table of docs/cli.md: the word after `factory` in each row. */
const docCommands = () => [...readFileSync(join(root, 'docs/cli.md'), 'utf8').matchAll(/^\| `factory ([\w-]+)/gm)].map((m) => m[1]);

describe('factory (ORC-200)', () => {
  it('has exactly the commands of docs/cli.md in its usage', () => {
    expect(usageCommands(USAGE)).toEqual(docCommands());
    // The MVP's commands, `simulate` withdrawn (ORC-157): its need is the replay of closed tickets, `factory ghost`.
    for (const cmd of ['init', 'doctor', 'up', 'validate', 'status', 'stop', 'run']) expect(COMMANDS.has(cmd), cmd).toBe(true);
    expect(USAGE).toContain('run repair <ID>');
    for (const gone of ['simulate', 'plan', 'pause', 'resume']) expect(COMMANDS.has(gone), gone).toBe(false);
    expect(USAGE).not.toContain('--fake-runner');
  });

  it('reads both names of an `a | b` line, as a usage once wrote `pause | resume`', () => {
    expect(usageCommands('Usage: factory <command>\n  pause | resume     suspend or resume\n  stop <ID>  stop')).toEqual(['pause', 'resume', 'stop']);
  });

  // Run for real, at once: the help before any configuration, and parseArgs' refusal of the flag that is gone.
  it('answers `factory plan` with an unknown command then the help, and refuses `up --fake-runner`, both with exit code 1', async () => {
    const [plan, fake] = await Promise.all([factory('plan'), factory('up', '--fake-runner')]);
    expect(plan.code).toBe(1);
    expect(plan.out).toBe(`Unknown command: plan\n${USAGE}\n`);
    expect(fake.code).toBe(1);
    expect(fake.out).toMatch(/Unknown option '--fake-runner'/);
  });

  it("takes `doctor --secrets` (ORC-456), refused by the missing factory.yml, and refuses it for another command", async () => {
    const [doctor, up] = await Promise.all([factory('doctor', '--secrets'), factory('up', '--secrets')]);
    expect(doctor.code).toBe(1);
    expect(doctor.out).not.toMatch(/Unknown option/);
    expect(doctor.out).toMatch(/^no factory\.yml in FACTORY_HOME/m);
    expect(up.code).toBe(1);
    expect(up.out).toMatch(/Unknown option '--secrets'/);
  });
});
