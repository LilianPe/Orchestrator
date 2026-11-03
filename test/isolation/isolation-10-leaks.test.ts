import { describe, expect, it } from 'vitest';
import { SANDBOX_HOME } from '../../src/adapters/sandbox/types.js';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * Isolation n° 10 (ORC-218): nothing crosses from one run to another but what is mounted, as the
 * orchestrator mounts it (openSandbox): the worktree at /work and, for the implementer, the ticket's
 * session dir at ~/.claude (any other run gets an empty per-run dir there, ORC-217).
 * $HOME itself is not writable in the public node image: a write that fails leaks nothing either.
 */
const WRITE = `touch /work/leak /tmp/leak ${SANDBOX_HOME}/.claude/leak; touch ${SANDBOX_HOME}/leak 2>/dev/null; true`;

describe.skipIf(!enabled)(`no leak between runs (${cli}, isolation n° 10)`, () => {
  const { provider, create, sh, workspace } = useSandboxes('10');
  const seen = async (id: string) =>
    (await sh(id, `for f in /work/leak /tmp/leak ${SANDBOX_HOME}/leak ${SANDBOX_HOME}/.claude/leak; do [ -e $f ] && echo $f; done; true`)).stdout.split('\n').filter(Boolean);
  const ticket = (ticketId: string) => {
    const t = { ticketId, workspacePath: workspace(), session: workspace() };
    return () => create({ ticketId, workspacePath: t.workspacePath, mounts: [{ host: t.session, target: `${SANDBOX_HOME}/.claude`, readOnly: false }] });
  };

  it("shows a sandbox nothing of its neighbour's, and a new run only its ticket's mounts", async () => {
    const one = ticket('ISO-10A');
    const two = ticket('ISO-10B');
    const [a, b] = await Promise.all([one(), two()]);
    expect((await sh(a.id, WRITE)).code).toBe(0);
    expect(await seen(b.id)).toEqual([]);

    await provider.destroy(a.id);
    const again = await one();
    // The worktree and the session dir are the ticket's, by design (--resume across attempts); /tmp and $HOME are gone.
    expect(await seen(again.id)).toEqual(['/work/leak', `${SANDBOX_HOME}/.claude/leak`]);
    expect(await seen(b.id)).toEqual([]);
  });
});
