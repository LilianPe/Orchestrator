import { describe, expect, it } from 'vitest';
import { isTransient } from '../../../runtime/transient.js';
import { LinearApi, LinearApiError, type FetchLike } from './api.js';

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

/** A Linear that answers `answers` in turn (the last one again once they run out), and the waits the client made. */
function linear(answers: Answer[], opts: { now?: () => number } = {}) {
  const calls: { signal?: AbortSignal }[] = [];
  const waits: number[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push({ signal: init.signal });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    const headers = new Headers(a.headers ?? {});
    return { ok: a.status < 400, status: a.status, headers, json: async () => a.body };
  };
  const api = new LinearApi(async () => 'tok', fetchImpl, undefined, {
    sleep: async (ms) => void waits.push(ms),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { api, calls, waits };
}

const ok = (data: unknown = { viewer: { id: 'u' } }, headers?: Record<string, string>): Answer => ({ status: 200, body: { data }, ...(headers ? { headers } : {}) });
const http429 = (headers?: Record<string, string>): Answer => ({ status: 429, body: {}, ...(headers ? { headers } : {}) });
const ratelimited: Answer = { status: 400, body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] } };

describe('LinearApi under its rate limit (ORC-350)', () => {
  it('waits and tries again on a 429, with a growing delay, then answers', async () => {
    const { api, calls, waits } = linear([http429(), ratelimited, ok()]);
    expect(await api.gql('query { viewer { id } }')).toEqual({ viewer: { id: 'u' } });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("waits until Linear's reset, or its Retry-After, when it gives one, never past the longest wait", async () => {
    const now = () => 1_000_000;
    const reset = linear([http429({ 'x-ratelimit-requests-reset': String(1_000_000 + 7_000) }), ok()], { now });
    await reset.api.gql('query { viewer { id } }');
    expect(reset.waits).toEqual([7_000]);
    const after = linear([http429({ 'retry-after': '3' }), ok()], { now });
    await after.api.gql('query { viewer { id } }');
    expect(after.waits).toEqual([3_000]);
    const far = linear([http429({ 'retry-after': '3600' }), ok()], { now });
    await far.api.gql('query { viewer { id } }');
    expect(far.waits).toEqual([60_000]);
  });

  it('backs off all the same on a reset already past by its clock, or a Retry-After of 0', async () => {
    const now = () => 1_000_000;
    const past = linear([http429({ 'x-ratelimit-requests-reset': String(1_000_000 - 2_000) }), http429({ 'retry-after': '0' }), ok()], { now });
    await past.api.gql('query { viewer { id } }');
    expect(past.waits).toEqual([1_000, 2_000]);
  });

  it('keeps a critical call made while a rate limit is waited out until its end, rather than sending it to be refused', async () => {
    const now = () => 1_000_000;
    const answers: Answer[] = [http429({ 'retry-after': '20' })];
    const { api, calls, waits } = linear(answers, { now });
    // Refused past its retries: Linear's limit holds for 20 s more.
    await api.gql('query A { x }').catch(() => undefined);
    answers.splice(0, answers.length, ok());
    waits.length = 0;
    const sent = calls.length;
    await api.gql('query B { y }');
    expect(waits).toEqual([20_000]);
    expect(calls).toHaveLength(sent + 1);
  });

  it('gives up after its retries, with an error the outbox still retries as transient (ORC-343)', async () => {
    const { api, calls, waits } = linear([http429()]);
    const err = await api.gql('query { viewer { id } }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearApiError);
    expect(err).toMatchObject({ status: 429 });
    expect(isTransient(err)).toBe(true);
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it('bounds each call in time: its fetch gets a signal that aborts', async () => {
    const { api, calls } = linear([ok()]);
    await api.gql('query { viewer { id } }');
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.signal!.aborted).toBe(false);
  });

  it('keeps the quota for the critical calls: a background call is skipped while a 429 is waited out, or when little of the quota is left', async () => {
    let t = 1_000_000;
    const answers: Answer[] = [http429({ 'retry-after': '5' })];
    const { api, calls } = linear(answers, { now: () => t });
    // A critical call meets 429s past its retries: until Linear's reset, no background call goes out.
    await api.gql('mutation A { x }').catch(() => undefined);
    const sent = calls.length;
    await expect(api.gql('mutation B { y }', {}, { background: true })).rejects.toThrow('Linear quota kept for the critical calls');
    expect(calls).toHaveLength(sent);
    // The quota read from the last answer: under a tenth left, the background calls wait for the next window.
    answers.splice(0, answers.length, ok({}, { 'x-ratelimit-requests-limit': '1000', 'x-ratelimit-requests-remaining': '50' }));
    t += 3_600_000;
    await api.gql('query C { z }');
    await expect(api.gql('mutation B { y }', {}, { background: true })).rejects.toThrow('Linear quota kept for the critical calls');
    expect(calls).toHaveLength(sent + 1);
    // A critical call still goes.
    await api.gql('query C { z }');
    expect(calls).toHaveLength(sent + 2);
    // Plenty left: the background call goes.
    answers.splice(0, answers.length, ok({}, { 'x-ratelimit-requests-limit': '1000', 'x-ratelimit-requests-remaining': '900' }));
    await api.gql('query C { z }');
    await api.gql('mutation B { y }', {}, { background: true });
    expect(calls).toHaveLength(sent + 4);
    // A quota read low, its reset past: no longer known, the background call goes.
    answers.splice(0, answers.length, ok({}, { 'x-ratelimit-requests-limit': '1000', 'x-ratelimit-requests-remaining': '10', 'x-ratelimit-requests-reset': String(t + 60_000) }));
    await api.gql('query C { z }');
    await expect(api.gql('mutation B { y }', {}, { background: true })).rejects.toThrow('Linear quota kept for the critical calls');
    t += 60_000;
    await api.gql('mutation B { y }', {}, { background: true });
  });

  it('never retries a background call: the live feed sends the next one anyway', async () => {
    const { api, calls } = linear([http429(), ok()]);
    await expect(api.gql('mutation B { y }', {}, { background: true })).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });
});
