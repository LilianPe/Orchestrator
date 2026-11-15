import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFlow, fetchSnapshot, post } from './api.js';

describe('the API client and the GitHub sign-in (ORC-399)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answering = (status: number, body: unknown = {}) => {
    const reload = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
    vi.stubGlobal('location', { reload });
    return reload;
  };

  it('reloads the page when the session is gone (a restart, 12 hours past): the page then goes through GitHub again', async () => {
    const reload = answering(401, { error: 'sign in with GitHub first' });
    await post('/api/runs/r1/stop');
    await fetchSnapshot().catch(() => undefined);
    await expect(fetchFlow()).rejects.toThrow('401');
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('reloads nothing on any other answer', async () => {
    const reload = answering(409, { error: 'run r1 is not the ticket\'s run at work' });
    expect((await post('/api/runs/r1/stop')).status).toBe(409);
    expect(reload).not.toHaveBeenCalled();
  });
});
