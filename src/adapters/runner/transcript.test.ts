import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drain } from '../../../test/contracts/agent-runtime.contract.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { MASK, maskTranscriptLine, purgeTranscripts, TRANSCRIPT_RETENTION_MS, transcriptExpiresAt, transcriptSecrets } from './transcript.js';

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

  it('leaves a line without secrets unchanged', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"Je regarde le code."}]}}';
    expect(maskTranscriptLine(line, transcriptSecrets({ GH_TOKEN: 'ghs_not-in-the-line' }))).toBe(line);
  });
});

describe('transcript retention', () => {
  it('expires a transcript 30 days after its last write', () => {
    expect(TRANSCRIPT_RETENTION_MS).toBe(30 * DAY);
    expect(transcriptExpiresAt(1_000)).toBe(1_000 + 30 * DAY);
  });

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
});

describe('ClaudeCodeRunner transcript', () => {
  it('writes the transcript masked, outside the journal, with an expiry 30 days after its last write', async () => {
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-tr-'));
    const script = join(mkdtempSync(join(tmpdir(), 'factory-script-')), 'stream.jsonl');
    const leaked = `ghp_${'z'.repeat(36)}`;
    writeFileSync(
      script,
      [
        readFileSync(fx('stream-success.jsonl'), 'utf8').split('\n')[0],
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `FACTORY_RUN_TOKEN=tok-abcdef-123456 ${leaked}` }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fini.', total_cost_usd: 0.1, num_turns: 1 }),
      ].join('\n'),
    );
    const runner = new ClaudeCodeRunner({ transcriptsDir, command: [process.execPath, fx('fake-claude.mjs')], killGraceMs: 500 });
    const h = runner.start({
      runId: 'r-masked', cwd: process.cwd(), prompt: '/factory:dev', claudeSessionId: 'uuid-1', resume: false, model: 'sonnet',
      pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false, limits: { turns: 50, durationMs: 10_000, usd: 5 },
      env: { FAKE_CLAUDE_SCRIPT: script, FACTORY_RUN_TOKEN: 'tok-abcdef-123456' },
    });
    await drain(h.events);
    await h.done;
    const file = join(transcriptsDir, 'r-masked.jsonl');
    const written = readFileSync(file, 'utf8');
    expect(written).not.toContain('tok-abcdef-123456');
    expect(written).not.toContain(leaked);
    expect(written).toContain(`FACTORY_RUN_TOKEN=${MASK} ${MASK}`);
    expect(written.trim().split('\n').map((l) => JSON.parse(l))).toHaveLength(3);
    const writtenAt = statSync(file).mtimeMs;
    expect(transcriptExpiresAt(writtenAt) - writtenAt).toBe(30 * DAY);
    expect(purgeTranscripts(transcriptsDir, writtenAt + 30 * DAY - 1)).toEqual([]);
    expect(purgeTranscripts(transcriptsDir, writtenAt + 30 * DAY)).toEqual(['r-masked.jsonl']);
  });
});
