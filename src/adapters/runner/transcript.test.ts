import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drain } from '../../../test/contracts/agent-runtime.contract.js';
import { ClaudeCodeRunner } from './claude-code.js';
import type { TicketState } from '../../core/types.js';
import { MASK, maskTranscriptLine, purgeRunDirs, purgeSessionDirs, purgeTranscripts, transcriptSecrets } from './transcript.js';

const DAY = 24 * 60 * 60 * 1000;
const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);

describe('transcript masking', () => {
  it('collects the values of secret variables, and the password of a URL', () => {
    const secrets = transcriptSecrets({
      GH_TOKEN: 'ghs_aaaaaaaaaaaaaaaa',
      FACTORY_UI_PASSWORD: 'correct-horse',
      FACTORY_DATABASE_URL: 'postgres://factory:s3cr3t-pass@db:5432/factory',
      ANTHROPIC_API_KEY: 'sk-ant-xyz-123456',
      SHORT_TOKEN: 'abc',
      HOME: '/home/node',
      PATH: '/usr/bin',
    });
    expect(secrets).toEqual(
      expect.arrayContaining(['ghs_aaaaaaaaaaaaaaaa', 'correct-horse', 'postgres://factory:s3cr3t-pass@db:5432/factory', 's3cr3t-pass', 'sk-ant-xyz-123456']),
    );
    expect(secrets).not.toContain('abc');
    expect(secrets).not.toContain('/home/node');
  });

  it('reads *_PASS, *_PWD and *APIKEY variables as secrets, and the credentials of any URL value', () => {
    const secrets = transcriptSecrets({
      SMTP_PASS: 'smtp-pass-123',
      DB_PWD: 'db-pwd-12345',
      OPENAI_APIKEY: 'apikey-123456',
      REDIS_URL: 'redis://default:pw@cache:6379',
      UPSTREAM: 'https://ci-bot:long-password-1@git.example.com/repo.git',
      HOMEPAGE: 'https://example.com/a@b',
    });
    expect(secrets).toEqual(
      expect.arrayContaining(['smtp-pass-123', 'db-pwd-12345', 'apikey-123456', 'default:pw', 'ci-bot:long-password-1', 'long-password-1']),
    );
    expect(secrets).not.toContain('pw');
    expect(secrets).not.toContain('https://example.com/a@b');
    expect(maskTranscriptLine('connected to redis://default:pw@cache:6379', secrets)).toBe(`connected to redis://${MASK}@cache:6379`);
  });

  it('masks known values, their JSON-escaped form and secret shapes, and keeps the line valid JSON', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    const line = JSON.stringify({
      type: 'user',
      content: `token=run-token-123456 key=${pem} gh=ghp_${'a'.repeat(36)} auth: Bearer ${'b'.repeat(30)} lin=lin_api_${'c'.repeat(30)} ok`,
    });
    const masked = maskTranscriptLine(line, transcriptSecrets({ FACTORY_RUN_TOKEN: 'run-token-123456', GH_APP_KEY: pem }));
    const content = (JSON.parse(masked) as { content: string }).content;
    expect(content).toBe(`token=${MASK} key=${MASK} gh=${MASK} auth: ${MASK} lin=${MASK} ok`);
  });

  it('leaves *_ASKPASS helper paths readable, and adds the secrets given outside the environment', () => {
    const secrets = transcriptSecrets({ GIT_ASKPASS: '/usr/lib/git-core/git-gui--askpass', SSH_ASKPASS: '/usr/bin/ssh-askpass' }, ['linear-client-secret', 'short']);
    expect(secrets).toEqual(['linear-client-secret']);
  });

  it('leaves a line without secrets unchanged', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"Je regarde le code."}]}}';
    expect(maskTranscriptLine(line, transcriptSecrets({ GH_TOKEN: 'ghs_not-in-the-line' }))).toBe(line);
  });
});

describe('transcript retention', () => {
  it('purges the transcripts older than 30 days and keeps the others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-tr-'));
    const now = Date.UTC(2026, 9, 26);
    const write = (name: string, ageMs: number) => {
      const file = join(dir, name);
      writeFileSync(file, '{}\n');
      const t = (now - ageMs) / 1000;
      utimesSync(file, t, t);
      return file;
    };
    const old = write('old.jsonl', 30 * DAY);
    const young = write('young.jsonl', 30 * DAY - 60_000);
    const other = write('notes.txt', 90 * DAY);
    expect(purgeTranscripts(dir, now)).toEqual(['old.jsonl']);
    expect([existsSync(old), existsSync(young), existsSync(other)]).toEqual([false, true, true]);
  });

  it('purges nothing from a missing folder', () => {
    expect(purgeTranscripts(join(tmpdir(), 'factory-no-such-dir-'), Date.now())).toEqual([]);
  });

  const now = Date.UTC(2026, 9, 26);
  /** A dir under `root`, last changed `ageMs` before `now`. */
  const aged = (root: string, path: string, ageMs: number) => {
    const dir = join(root, path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f.jsonl'), '{}\n');
    const t = (now - ageMs) / 1000;
    utimesSync(dir, t, t);
    return dir;
  };

  it('purges the per-run dirs (refusals log) older than 30 days (ORC-217)', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-runs-'));
    const old = aged(root, 'r-old', 30 * DAY);
    const young = aged(root, 'r-young', 30 * DAY - 60_000);
    expect(purgeRunDirs(root, now)).toEqual(['r-old']);
    expect([existsSync(old), existsSync(young)]).toEqual([false, true]);
    expect(purgeRunDirs(join(tmpdir(), 'factory-no-such-dir-'), now)).toEqual([]);
  });

  it('purges the session dirs of closed tickets older than 30 days, and leaves open or unknown tickets (ORC-217)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-sessions-'));
    const tickets: Record<string, Partial<TicketState>> = {
      'p/DONE': { logical: 'done' },
      'p/YOUNG': { logical: 'done' },
      'p/CLOSED': { logical: 'human_review', prState: 'CLOSED' },
      'p/OPEN': { logical: 'human_review', prState: 'OPEN' },
    };
    const store = { getTicket: async (p: string, t: string) => tickets[`${p}/${t}`] as TicketState | undefined };
    const dirs = {
      done: aged(root, 'p/DONE', 30 * DAY),
      young: aged(root, 'p/YOUNG', 30 * DAY - 60_000),
      closed: aged(root, 'p/CLOSED', 40 * DAY),
      open: aged(root, 'p/OPEN', 90 * DAY),
      unknown: aged(root, 'p/GONE', 90 * DAY),
    };
    expect((await purgeSessionDirs(root, now, store)).sort()).toEqual(['p/CLOSED', 'p/DONE']);
    expect(Object.fromEntries(Object.entries(dirs).map(([k, d]) => [k, existsSync(d)]))).toEqual({ done: false, young: true, closed: false, open: true, unknown: true });
  });
});

describe('ClaudeCodeRunner transcript', () => {
  it('writes the transcript and streams its events masked, outside the journal, kept 30 days after its last write', async () => {
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-tr-'));
    const script = join(mkdtempSync(join(tmpdir(), 'factory-script-')), 'stream.jsonl');
    const leaked = `ghp_${'z'.repeat(36)}`;
    writeFileSync(
      script,
      [
        readFileSync(fx('stream-success.jsonl'), 'utf8').split('\n')[0],
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `FACTORY_RUN_TOKEN=tok-abcdef-123456 ${leaked}` }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Le secret est linear-client-secret.' }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo tok-abcdef-123456' } }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fini avec tok-abcdef-123456.', total_cost_usd: 0.1, num_turns: 1 }),
      ].join('\n'),
    );
    const runner = new ClaudeCodeRunner({ transcriptsDir, command: [process.execPath, fx('fake-claude.mjs')], killGraceMs: 500, secrets: () => ['linear-client-secret'] });
    const h = runner.start({
      runId: 'r-masked', cwd: process.cwd(), prompt: '/factory:dev', claudeSessionId: 'uuid-1', resume: false, model: 'sonnet',
      pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false, limits: { turns: 50, durationMs: 10_000, usd: 5 },
      env: { FAKE_CLAUDE_SCRIPT: script, FACTORY_RUN_TOKEN: 'tok-abcdef-123456' },
    });
    const events = await drain(h.events);
    const result = await h.done;
    const streamed = JSON.stringify(events);
    expect(streamed).not.toContain('tok-abcdef-123456');
    expect(streamed).not.toContain('linear-client-secret');
    expect(events).toEqual(expect.arrayContaining([{ kind: 'text', text: `Le secret est ${MASK}.` }]));
    const file = join(transcriptsDir, 'r-masked.jsonl');
    const written = readFileSync(file, 'utf8');
    expect(written).not.toContain('tok-abcdef-123456');
    expect(written).not.toContain(leaked);
    expect(written).toContain(`FACTORY_RUN_TOKEN=${MASK} ${MASK}`);
    expect(written.trim().split('\n').map((l) => JSON.parse(l))).toHaveLength(4);
    expect(written).not.toContain('linear-client-secret');
    expect(result.lastText).toBe(`Fini avec ${MASK}.`);
    const writtenAt = statSync(file).mtimeMs;
    expect(purgeTranscripts(transcriptsDir, writtenAt + 30 * DAY - 1)).toEqual([]);
    expect(purgeTranscripts(transcriptsDir, writtenAt + 30 * DAY)).toEqual(['r-masked.jsonl']);
  });
});
