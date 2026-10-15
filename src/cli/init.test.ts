import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import { loadInstance, loadSecrets } from '../config/instance.js';
import { runInit, type InitIO } from './init.js';

function scriptedIO(answers: string[], confirms: boolean[]): InitIO & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    ask: async (_q, def) => answers.shift() || def || '',
    confirm: async (_q, def) => confirms.shift() ?? def ?? false,
    print: (s) => void printed.push(s),
  };
}

describe('relais init', () => {
  it('writes config, secrets and the project workflow', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'relais-init-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(repo, 'package-lock.json'), '{}');
    const realExec: Exec = async (cmd, args, opts) => {
      try {
        return { stdout: execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' }), stderr: '', code: 0 };
      } catch {
        return { stdout: '', stderr: 'x', code: 1 };
      }
    };
    const io = scriptedIO(['REL', 'cid', 'csecret', 'whsecret', ''], [false]);
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec: realExec });

    const cfg = loadInstance(home);
    expect(cfg.relay).toEqual({ kind: 'smee', url: 'https://smee.io/abc' });
    expect(cfg.projects).toEqual([{ id: expect.any(String), repoPath: repo, linearTeamKey: 'REL' }]);
    expect(loadSecrets(home).linear).toEqual({ clientId: 'cid', clientSecret: 'csecret', webhookSecret: 'whsecret' });
    const wf = readFileSync(join(repo, '.relais/workflow.yml'), 'utf8');
    expect(wf).toContain('team: REL');
    expect(wf).toContain('npm test');
    expect(wf).toContain('npm ci');
    const out = io.printed.join('\n');
    expect(out).toContain('http://localhost:4100/oauth/callback');
    expect(out).toContain('https://smee.io/abc');
    expect(out).toContain('Agent session events');
    expect(existsSync(join(home, 'config.yaml'))).toBe(true);
  });

  it('asks the webhook signing secret again until it is not empty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-init-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'relais-init-repo-'));
    const exec: Exec = async (cmd, args) =>
      cmd === 'git' && args[0] === 'rev-parse' ? { stdout: `${repo}\n`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 };
    const asked: string[] = [];
    const answers = ['REL', 'cid', 'csecret', '', '  ', 'whsecret', ''];
    const io: InitIO = {
      ask: async (q, def) => {
        asked.push(q);
        if (!answers.length) throw new Error(`no more answers (${q})`);
        return answers.shift() || def || '';
      },
      confirm: async () => false,
      print: () => {},
    };
    await runInit({ io, home, cwd: repo, createSmee: async () => 'https://smee.io/abc', exec });

    expect(asked.filter((q) => q === 'Webhook signing secret')).toHaveLength(3);
    expect(loadSecrets(home).linear?.webhookSecret).toBe('whsecret');
  });
});
