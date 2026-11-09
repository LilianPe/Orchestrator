import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppJwt } from '../../src/adapters/forge/github-app.js';
import type { GitAccess } from '../../src/adapters/forge/types.js';
import { appForge, appOptions, gh, GITHUB_ENV, missing, titled, tokenOf } from './github-live.js';

/**
 * Isolation n° 13: a run's token opens its run's repository alone (ORC-219, against ORC-124). The real App gives the
 * factory a token for the test repository, as for a run; that token reads it and may push to it (a dry run), and opens
 * nothing else of the same installation, by the API or by git. `FACTORY_ISO_GH_OTHER_REPO` must be a private repository
 * the App is installed on with the same installation: checked first, so that a refusal proves something.
 */
const NAMES = [...GITHUB_ENV, 'FACTORY_ISO_GH_OTHER_REPO'];
const REPO = process.env['FACTORY_ISO_GH_REPO']?.trim() ?? '';
const OTHER = process.env['FACTORY_ISO_GH_OTHER_REPO']?.trim() ?? '';

describe.skipIf(missing(...NAMES).length > 0)(titled("isolation 13: a run's token opens its repository alone", NAMES), () => {
  let access: GitAccess;
  let token = '';
  let local = '';
  /** git with the factory's access to the run's repository, as it pushes: its exit code. */
  const git = (...args: string[]) => {
    try {
      execFileSync('git', args, { cwd: local, env: { ...process.env, ...access.env, GIT_TERMINAL_PROMPT: '0' }, stdio: 'ignore', timeout: 60_000 });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? 1;
    }
  };
  const dryPush = (repo: string) => git('push', '--dry-run', `https://github.com/${repo}.git`, `HEAD:refs/heads/factory/iso-13-dry-run-${Date.now()}`);

  beforeAll(async () => {
    // The other repository proves something only if the installation holds it, and if a token is needed to read it.
    const jwt = createAppJwt(appOptions().appId, appOptions().privateKey);
    const [mine, other] = await Promise.all([gh(`/repos/${REPO}/installation`, jwt), gh(`/repos/${OTHER}/installation`, jwt)]);
    expect(mine.status, `the App is not installed on ${REPO}`).toBe(200);
    expect(other.status, `the App is not installed on ${OTHER}`).toBe(200);
    expect(other.body.id, `${OTHER} must be in the same installation as ${REPO}`).toBe(mine.body.id);
    expect((await gh(`/repos/${OTHER}`, undefined)).status, `${OTHER} must be private: a public repository reads with any token`).toBe(404);
    access = await appForge().gitAccess(REPO);
    token = tokenOf(access);
    local = mkdtempSync(join(tmpdir(), 'factory-iso13-'));
    execFileSync('git', ['init', '-q'], { cwd: local });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'iso-13'], { cwd: local });
  }, 120_000);

  afterAll(() => {
    if (local) rmSync(local, { recursive: true, force: true });
  });

  it("the control: it reads the run's repository and may push to it", async () => {
    expect((await gh(`/repos/${REPO}`, token)).status).toBe(200);
    expect(git('ls-remote', `https://github.com/${REPO}.git`)).toBe(0);
    expect(dryPush(REPO)).toBe(0);
  }, 120_000);

  it('it opens no other repository of the installation: not by the API, nor by git, and lists its own alone', async () => {
    expect([403, 404]).toContain((await gh(`/repos/${OTHER}`, token)).status);
    expect([403, 404]).toContain((await gh(`/repos/${OTHER}/contents/`, token)).status);
    expect(git('ls-remote', `https://github.com/${OTHER}.git`)).not.toBe(0);
    expect(dryPush(OTHER)).not.toBe(0);
    const listed = await gh('/installation/repositories', token);
    expect(listed.status).toBe(200);
    expect((listed.body.repositories as { full_name: string }[]).map((r) => r.full_name.toLowerCase())).toEqual([REPO.toLowerCase()]);
  }, 120_000);
});
