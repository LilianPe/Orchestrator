import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeAgentRuntimeContract, drain, type AgentScript } from '../../../test/contracts/agent-runtime.contract.js';
import { buildClaudeArgs, childEnv, ClaudeCodeRunner } from './claude-code.js';
import type { RunRequest } from './types.js';

const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);

function req(patch: Partial<RunRequest> = {}, env: Record<string, string> = {}): RunRequest {
  return {
    runId: `r-${Math.random().toString(36).slice(2)}`, cwd: process.cwd(), prompt: '/factory:dev\n\n## Ticket', claudeSessionId: 'uuid-1', resume: false,
    model: 'sonnet', pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false,
    limits: { turns: 50, durationMs: 10_000, usd: 5 }, env, ...patch,
  };
}

function runner() {
  const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-tr-'));
  return { transcriptsDir, r: new ClaudeCodeRunner({ transcriptsDir, command: [process.execPath, fx('fake-claude.mjs')], killGraceMs: 500 }) };
}

const scripts: Record<AgentScript, Partial<RunRequest>> = {
  success: { env: { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') } },
  failure: { env: { FAKE_CLAUDE_SCRIPT: fx('stream-error.jsonl') } },
  hang: { env: { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_HANG: '1' } },
  chatty: { env: { FAKE_CLAUDE_SCRIPT: fx('stream-many-turns.jsonl'), FAKE_CLAUDE_HANG: '1' } },
  unlaunchable: { cwd: join(mkdtempSync(join(tmpdir(), 'factory-contract-')), 'missing') },
};

const shared = runner().r;
describeAgentRuntimeContract('ClaudeCodeRunner (fake claude CLI)', () => ({ runtime: shared, script: (name) => scripts[name] }));

describe('buildClaudeArgs', () => {
  it('starts a new session', () => {
    expect(buildClaudeArgs(req())).toEqual([
      '-p', '/factory:dev\n\n## Ticket', '--output-format', 'stream-json', '--verbose', '--session-id', 'uuid-1', '--model', 'sonnet',
      '--plugin-dir', '/pack', '--settings', '/pack/settings.json', '--setting-sources', 'project,local', '--max-budget-usd', '5',
    ]);
  });
  it('resumes read-only', () => {
    const args = buildClaudeArgs(req({ resume: true, readOnly: true }));
    expect(args.slice(5, 7)).toEqual(['--resume', 'uuid-1']);
    expect(args.slice(-2)).toEqual(['--permission-mode', 'plan']);
    expect(args).not.toContain('--bare');
  });
});

describe('ClaudeCodeRunner', () => {
  it('streams events, writes the transcript and succeeds', async () => {
    const { r, transcriptsDir } = runner();
    const argsFile = join(transcriptsDir, 'args.txt');
    const rq = req({}, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_ARGS: argsFile });
    const h = r.start(rq);
    const events = await drain(h.events);
    expect(events.map((e) => e.kind)).toEqual(['init', 'text', 'tool', 'tool_result', 'text', 'result']);
    expect(await h.done).toEqual({ outcome: 'success', costUsd: 0.42, turns: 3, lastText: 'PR ouverte.' });
    expect(readFileSync(join(transcriptsDir, `${rq.runId}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(5);
    expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toContain('--setting-sources');
  });

  it('reports failure on an error result', async () => {
    const { r } = runner();
    const h = r.start(req({}, { FAKE_CLAUDE_SCRIPT: fx('stream-error.jsonl') }));
    await drain(h.events);
    expect(await h.done).toMatchObject({ outcome: 'failure', lastText: 'Je tente.' });
  });
});

describe('childEnv', () => {
  it('drops daemon-only secrets (LINEAR_*, non-run FACTORY_*) and keeps the run variables', () => {
    const env = childEnv(
      { HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'k', GH_TOKEN: 'g', LINEAR_API_KEY: 'lin', LINEAR_TOKEN: 'x', FACTORY_HOME: '/data', FACTORY_UI_PASSWORD: 'pw', FACTORY_SECRET: 's' },
      { FACTORY_API: 'http://127.0.0.1:4100/agent', FACTORY_RUN_TOKEN: 't', FACTORY_TICKET: 'REL-1', FACTORY_KNOWLEDGE: '', FACTORY_ROOT: '/app', PATH: '/app/bin:/bin' },
    );
    expect(env).toEqual({
      HOME: '/h', PATH: '/app/bin:/bin', ANTHROPIC_API_KEY: 'k', GH_TOKEN: 'g',
      FACTORY_API: 'http://127.0.0.1:4100/agent', FACTORY_RUN_TOKEN: 't', FACTORY_TICKET: 'REL-1', FACTORY_KNOWLEDGE: '', FACTORY_ROOT: '/app',
    });
  });

  it('drops variables left over from the old prefix', () => {
    const env = childEnv({ HOME: '/h', RELAIS_UI_PASSWORD: 'pw', RELAIS_HOME: '/old' }, {}); // transition, à retirer (ORC-167)
    expect(env).toEqual({ HOME: '/h' });
  });
});
