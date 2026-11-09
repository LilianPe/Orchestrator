import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SecurityLog } from '../store/types.js';
import { OTHER_HOSTS, readSecurityLog, refusalSummary, REFUSAL_RULES, runSecurityView, shownHosts } from './security-log.js';

const RUN = { runId: 'r1', projectId: 'p', ticketId: 'REL-1', at: 5 };
const HOOK = join(import.meta.dirname, '../../packs/standard/hooks/pre-tool-use.mjs');

function files(egress: string[] | undefined, refusals: string[] | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-seclog-'));
  const paths = { egress: join(dir, 'r1.jsonl'), refusals: join(dir, 'refusals.jsonl') };
  if (egress) writeFileSync(paths.egress, egress.join('\n') + '\n');
  if (refusals) writeFileSync(paths.refusals, refusals.join('\n') + '\n');
  return paths;
}

const egressLine = (patch: object = {}) =>
  JSON.stringify({ at: '2026-11-03T10:00:00.000Z', up: 10, down: 20, method: 'GET', host: 'registry.npmjs.org', path: '/x', ok: true, ...patch });
const refusalLine = (patch: object = {}) =>
  JSON.stringify({ at: '2026-11-03T10:00:01.000Z', tool: 'Bash', command: 'git push --force', rule: 'force-push', ticket: 'REL-1', ...patch });

describe('the security log of a run (ORC-296)', () => {
  it('reads both journals, stamped with the run and its ticket', () => {
    const log = readSecurityLog(RUN, files([egressLine(), egressLine({ method: 'CONNECT', host: 'evil.example', path: undefined, port: 22, ok: false, reason: 'port 22 refused' })], [refusalLine()]));
    expect(log).toEqual({
      ...RUN,
      egress: [
        { at: Date.parse('2026-11-03T10:00:00.000Z'), method: 'GET', host: 'registry.npmjs.org', ok: true, up: 10, down: 20 },
        { at: Date.parse('2026-11-03T10:00:00.000Z'), method: 'CONNECT', host: 'evil.example', port: 22, ok: false, up: 10, down: 20 },
      ],
      refusals: [{ at: Date.parse('2026-11-03T10:00:01.000Z'), tool: 'Bash', rule: 'force-push' }],
      skipped: { egress: 0, refusals: 0 },
    });
  });

  it("keeps neither the command, the path of a refused read, nor a request's path or the proxy's reason, which names it: the rule and the host only", () => {
    const log = readSecurityLog(
      RUN,
      files(
        [egressLine({ path: '/bot123:s3cret/sendMessage' }), egressLine({ method: 'POST', path: '/bot123:s3cret/x', ok: false, reason: 'POST registry.npmjs.org/bot123:s3cret/x refused: GET, HEAD and OPTIONS only' })],
        [refusalLine({ command: 'git push https://x:ghp_s3cret@github.com/o/r', rule: 'push' }), refusalLine({ tool: 'Read', command: '/work/s3cret-name.ts', rule: 'full-read' })],
      ),
    );
    expect(log.refusals.map((r) => r.rule)).toEqual(['push', 'full-read']);
    expect(log.egress.map((e) => [e.host, e.ok])).toEqual([['registry.npmjs.org', true], ['registry.npmjs.org', false]]);
    expect(JSON.stringify(log)).not.toContain('s3cret');
  });

  it('takes a request whatever its path, now that the path is not kept: a long signed URL is no malformed line', () => {
    const log = readSecurityLog(RUN, files([egressLine({ path: `/${'a'.repeat(5000)}` })], []));
    expect(log.egress).toHaveLength(1);
    expect(log.skipped.egress).toBe(0);
  });

  it('is empty when a journal is missing', () => {
    expect(readSecurityLog(RUN, { ...files(undefined, undefined) })).toMatchObject({ egress: [], refusals: [], skipped: { egress: 0, refusals: 0 } });
    expect(readSecurityLog(RUN, { refusals: files(undefined, undefined).refusals })).toMatchObject({ egress: [], skipped: { egress: 0 } });
  });

  it('skips and counts the malformed or forged lines, and goes on', () => {
    const log = readSecurityLog(
      RUN,
      files(
        ['not json', egressLine({ ok: 'yes' }), egressLine({ host: 'a\u0000b' }), egressLine()],
        [
          '{',
          '[]',
          refusalLine({ rule: 'made-up' }),
          refusalLine({ ticket: 'REL-2' }),
          refusalLine({ tool: 'Write' }),
          refusalLine({ at: 'yesterday' }),
          refusalLine({ rule: 'push-trunk' }),
        ],
      ),
    );
    expect(log.egress).toHaveLength(1);
    expect(log.refusals.map((r) => r.rule)).toEqual(['push-trunk']);
    expect(log.skipped).toEqual({ egress: 3, refusals: 6 });
  });

  it('counts what is past the size cap as one skipped line', () => {
    const paths = files(undefined, Array.from({ length: 30_000 }, () => refusalLine()));
    const log = readSecurityLog(RUN, paths);
    expect(log.refusals.length).toBeLessThan(30_001);
    // The lines read, the cut one and the rest: one skipped line for all that was not read.
    expect(log.refusals.length + log.skipped.refusals).toBeLessThan(30_001);
    expect(log.skipped.refusals).toBeGreaterThanOrEqual(1);
  });

  it('reads no refusals log that is not a plain file (a dir, a link the agent made)', () => {
    const paths = files(undefined, undefined);
    mkdirSync(paths.refusals);
    expect(readSecurityLog(RUN, paths)).toMatchObject({ refusals: [], skipped: { refusals: 1 } });
  });

  it('takes a whole read the real hook refused, the path in its command (ORC-279)', () => {
    const paths = files(undefined, undefined);
    const big = `${paths.refusals}.big.ts`;
    writeFileSync(big, 'x\n'.repeat(1000));
    const call = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: big } });
    const env = { PATH: process.env['PATH'], FACTORY_REFUSALS_LOG: paths.refusals, FACTORY_TICKET: RUN.ticketId };
    const hook = spawnSync(process.execPath, [HOOK], { input: call, encoding: 'utf8', env });
    expect(hook.stdout).toContain('"permissionDecision":"deny"');
    const log = readSecurityLog(RUN, paths);
    expect(log.refusals).toEqual([{ at: expect.any(Number), tool: 'Read', rule: 'full-read' }]);
    expect(log.skipped.refusals).toBe(0);
    expect(refusalSummary(log)).toContain('`full-read`: 1');
    expect(refusalSummary(log)).not.toContain(big);
  });

  it('knows every rule of the pack hook', () => {
    const hook = readFileSync(HOOK, 'utf8');
    const returned = new Set([...hook.matchAll(/return '([a-z-]+)'/g)].map((m) => m[1]));
    expect([...returned].sort()).toEqual([...REFUSAL_RULES].sort());
  });
});

describe("the proxy's notes (ORC-337)", () => {
  it('keeps them out of the requests and the refusals: a dropped beta, a throttled call, a client gone are no refused host', () => {
    const note = (text: string) => JSON.stringify({ at: '2026-11-03T10:00:02.000Z', kind: 'note', method: 'POST', host: 'api.anthropic.com', path: '/v1/messages', note: text });
    const log = readSecurityLog(RUN, files([egressLine(), note('anthropic-beta x dropped'), note('model call throttled'), note('model call dropped: its client went away')], []));
    expect(log.egress).toHaveLength(1);
    expect(log.skipped.egress).toBe(0);
    expect(refusalSummary(log)).toBeUndefined();
  });
});

describe('the refusals summary posted in the ticket session (ORC-296)', () => {
  const log = (patch: object = {}) => ({ ...RUN, egress: [], refusals: [], skipped: { egress: 0, refusals: 0 }, ...patch });
  const refusal = (rule: string) => ({ at: 1, tool: 'Bash', rule });
  const refused = (host: string) => ({ at: 1, method: 'GET', host, ok: false, up: 0, down: 0 });

  it('says nothing for a run without a refusal', () => {
    expect(refusalSummary(log({ egress: [{ ...refused('a.example'), ok: true }] }))).toBeUndefined();
  });

  it('counts the refusals per rule and names the refused hosts, never a command, a path nor the reason that names it, even handed them', () => {
    const body = refusalSummary(
      log({
        refusals: [refusal('push-trunk'), refusal('pipe-to-shell'), { ...refusal('push-trunk'), command: 'git push origin main --token=SECRET' }],
        egress: [refused('evil.example'), { ...refused('evil.example'), path: '/SECRET', reason: 'POST evil.example/SECRET refused' }, refused('x.org'), refused('<b>@everyone</b>')],
        skipped: { egress: 0, refusals: 2 },
      }),
    )!;
    expect(body).toContain('`push-trunk`: 2');
    expect(body).toContain('`pipe-to-shell`: 1');
    expect(body).toContain('`evil.example` (2)');
    expect(body).toContain('`x.org` (1)');
    expect(body).toContain('1 other');
    expect(body).toContain('2 log lines');
    expect(body).not.toContain('everyone');
    expect(body).not.toContain('SECRET');
  });
});

describe('the security log of a run as the dashboard shows it (ORC-300)', () => {
  const log: SecurityLog = {
    ...RUN,
    egress: [
      { at: 10, method: 'GET', host: 'registry.npmjs.org', ok: true, up: 1, down: 2 },
      { at: 11, method: 'CONNECT', host: 'evil.example', port: 22, ok: false, up: 0, down: 0 },
      { at: 12, method: 'POST', host: 'evil.example', ok: false, up: 0, down: 0 },
      { at: 13, method: 'GET', host: 'pypi.org', ok: false, up: 0, down: 0 },
      { at: 14, method: 'GET', host: 'registry.npmjs.org', ok: true, up: 1, down: 2 },
      { at: 15, method: 'CONNECT', host: 'ghp_s3cret:x@evil', ok: false, up: 0, down: 0 },
      { at: 16, method: 'GET', host: 'user=s3cret value', ok: false, up: 0, down: 0 },
    ],
    refusals: [
      { at: 20, tool: 'Bash', rule: 'push' },
      { at: 21, tool: 'Bash', rule: 'force-push' },
      { at: 22, tool: 'Bash', rule: 'push' },
    ],
    skipped: { egress: 1, refusals: 2 },
  };

  it('lists its refusals and counts them per rule, and counts the hosts contacted and refused, those not a plain name together', () => {
    expect(runSecurityView(log)).toEqual({
      ...RUN,
      rules: [{ rule: 'push', refusals: 2 }, { rule: 'force-push', refusals: 1 }],
      refusals: [{ at: 20, tool: 'Bash', rule: 'push' }, { at: 21, tool: 'Bash', rule: 'force-push' }, { at: 22, tool: 'Bash', rule: 'push' }],
      hosts: [
        { host: 'evil.example', requests: 2, refused: 2 },
        { host: 'registry.npmjs.org', requests: 2, refused: 0 },
        { host: 'pypi.org', requests: 1, refused: 1 },
        { host: OTHER_HOSTS, requests: 2, refused: 2 },
      ],
      skipped: { egress: 1, refusals: 2 },
    });
  });

  it('shownHosts: the counts of the hosts not a plain name merged into one row, last', () => {
    expect(shownHosts([
      { host: 'a.example', requests: 5, refused: 0 },
      { host: 'x y', requests: 2, refused: 2 },
      { host: 'b.example', requests: 3, refused: 1 },
      { host: 'k:v@z', requests: 2, refused: 1 },
    ])).toEqual([
      { host: 'a.example', requests: 5, refused: 0 },
      { host: 'b.example', requests: 3, refused: 1 },
      { host: OTHER_HOSTS, requests: 4, refused: 3 },
    ]);
  });

  it('shows no command, no path and no reason: only the rule and the host', () => {
    const shown = JSON.stringify(runSecurityView(log));
    for (const hidden of ['s3cret', 'git push', '/upload', '/simple', 'not allowed', 'port 22']) expect(shown).not.toContain(hidden);
  });
});
