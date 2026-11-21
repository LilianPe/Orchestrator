import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ORC-200: the `factory` CLI has the commands of docs/cli.md, and no others; `plan`, `pause` and `resume` are gone.
const root = join(import.meta.dirname, '../..');

/** `factory <args>` as an operator runs it, on an empty FACTORY_HOME: no instance is read before the help. */
function factory(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'factory-cli-'));
  const res = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/cli/factory.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FACTORY_HOME: home },
    timeout: 30_000,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

/** The commands a usage lists: the first word of each line after its first. */
const usageCommands = (out: string) =>
  out.split('\n').slice(out.split('\n').findIndex((l) => l.startsWith('Usage: factory')) + 1).filter((l) => /^ {2}\w/.test(l)).map((l) => l.trim().split(' ')[0]);

/** The commands of the table of docs/cli.md: the word after `factory` in each row. */
const docCommands = () => [...readFileSync(join(root, 'docs/cli.md'), 'utf8').matchAll(/^\| `factory ([\w-]+)/gm)].map((m) => m[1]);

describe('factory (ORC-200)', () => {
  it('without an argument, lists exactly the commands of docs/cli.md, and exits 1', () => {
    const { code, out } = factory();
    expect(code).toBe(1);
    expect(out).not.toContain('Unknown command');
    expect(usageCommands(out)).toEqual(docCommands());
    // The MVP's commands, `simulate` withdrawn (ORC-157): its need is the replay of closed tickets, `factory ghost`.
    expect(usageCommands(out)).toEqual(expect.arrayContaining(['init', 'doctor', 'up', 'validate', 'status', 'stop', 'run']));
    expect(out).toContain('run repair <ID>');
    for (const gone of ['simulate', 'plan', 'pause', 'resume', '--fake-runner']) expect(out).not.toContain(gone);
  });

  it.each(['plan', 'pause', 'resume', 'simulate'])('answers `factory %s` with an unknown command, exit code 1', (cmd) => {
    const { code, out } = factory(cmd);
    expect(code).toBe(1);
    expect(out.split('\n')[0]).toBe(`Unknown command: ${cmd}`);
  });

  it('refuses `factory up --fake-runner`: the fake runner is the test harness alone', () => {
    const { code, out } = factory('up', '--fake-runner');
    expect(code).toBe(1);
    expect(out).toMatch(/Unknown option '--fake-runner'/);
  });
});
