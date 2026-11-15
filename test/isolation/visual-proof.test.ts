import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightShooter } from '../../src/adapters/browser/playwright.js';
import { BROWSER_REQUIREMENTS, WIDTHS } from '../../src/adapters/browser/types.js';
import { WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { browserImage } from '../../src/app/sandbox-wiring.js';
import { runCleanVerify } from '../../src/core/clean-verify.js';
import { OutputPolicy } from '../../src/publish/output-policy.js';
import { cli, enabled, image, useSandboxes } from './helpers.js';

const capture = process.env['FACTORY_BROWSER_IMAGE'] ?? '';

/** A page that asks another host for an image: at network `none`, it never gets it, and the page loads all the same. */
const server = (title: string) => String.raw`require('http').createServer((q, r) => {
  r.setHeader('content-type', 'text/html');
  r.end('<!doctype html><h1>${title}</h1><img src="https://example.com/x.png">');
}).listen(process.env.PORT, '127.0.0.1');
`;

/**
 * The visual proof in production (ORC-404, docs/workflow.md): the capture image of docker/browser.Dockerfile, served to a
 * sandbox that asks for a browser, at network `none`, with nothing mounted but the checkout. Skipped without the image,
 * which only the CI's isolation job builds, on top of the runner's.
 */
describe.skipIf(!enabled || !capture)(`the capture image (${cli})`, () => {
  const { provider, create, sh, workspace } = useSandboxes('visual', { browserImage: capture });
  const inspect = (id: string, format: string) => execFileSync(cli, ['inspect', '--format', format, id], { encoding: 'utf8' }).trim();

  it('is the browser the daemon wires, and the runner\'s image is not', async () => {
    // On the runner image the job built: its layers under the capture image's.
    const env = { FACTORY_CONTAINER_CLI: cli, FACTORY_BROWSER_IMAGE: capture, FACTORY_RUNNER_IMAGE: image };
    expect(await browserImage(env)).toEqual({ image: capture, detail: expect.stringMatching(/playwright-\d/) });
    expect((await browserImage({ ...env, FACTORY_BROWSER_IMAGE: image })).image).toBeUndefined();
  });

  it('shoots the application at three widths, at network none, with the checkout alone mounted', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'server.js'), server('Settings'));
    const sbx = await create({ workspacePath: ws, requirements: BROWSER_REQUIREMENTS });
    expect(inspect(sbx.id, '{{.Config.Image}}')).toContain(capture.replace(/^localhost\//, ''));
    expect(inspect(sbx.id, '{{.HostConfig.NetworkMode}}')).toBe('none');
    const mounts = JSON.parse(inspect(sbx.id, '{{json .Mounts}}')) as { Destination: string }[];
    expect(mounts.map((m) => m.Destination)).toEqual([WORKSPACE_TARGET]);
    // Nothing out, the browser's own fetch as any other.
    expect((await sh(sbx.id, "node -e \"fetch('https://example.com').then(() => process.exit(0), () => process.exit(7))\"")).code).toBe(7);

    const started = Date.now();
    const shots = await new PlaywrightShooter().shoot(provider, {
      sandboxId: sbx.id, sha: 'iso', start: 'node server.js', port: 3000, path: '/', widths: WIDTHS, env: {},
    });
    // The measure ORC-404 asks for: one side's three widths, the application's start included.
    console.log(`visual proof: one capture at ${WIDTHS.join(', ')} px in ${Date.now() - started} ms`);
    expect(shots.started).toBe(true);
    if (!shots.started) return;
    expect(shots.pages.map((p) => p.width)).toEqual([...WIDTHS]);
    for (const p of shots.pages) {
      expect(Buffer.from(p.png.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a');
      // The other host's image failed, and is not the application's error.
      expect(p.consoleErrors).toEqual([]);
    }
  }, 300_000);
});

/** ORC-404, criterion 1 up to the PR: `verify` takes the six captures, before on the base and after on the commit, in the capture image. */
describe.skipIf(!enabled || !capture)(`the visual proof in verify, on the capture image (${cli})`, () => {
  const { provider } = useSandboxes('visual-verify', { browserImage: capture });
  // In a hook: a skipped suite's body still runs at collection, its afterAll never.
  let base = '';
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'factory-visual-'));
  });
  const BRANCH = 'feat/iso-404';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  const commit = (cwd: string, files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', message);
  };
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('shoots the page before and after at three widths, with the start the base declares', async () => {
    const origin = join(base, 'origin');
    git(base, 'init', '-q', '-b', 'main', origin);
    commit(origin, { '.factory/config.yml': 'visual_paths: ["server.js"]\npreview: node server.js\n', 'server.js': server('Old settings') }, 'base');
    const repo = join(base, 'repo');
    git(base, 'clone', '-q', origin, repo);
    git(repo, 'checkout', '-q', '-b', BRANCH);
    commit(repo, { 'server.js': server('New settings, with a much longer title') }, 'the page');
    const workDir = join(base, 'work');
    mkdirSync(workDir);
    const res = await runCleanVerify({
      sandboxes: provider, runId: `isolation-visual-verify-${Date.now()}`, ticketId: 'ISO-404', branch: BRANCH, worktree: repo, originUrl: origin, workDir,
      gitleaks: false, semgrep: false, setup: [], commands: [], env: async () => ({}), log: () => {},
      visual: { intake: false, shooter: new PlaywrightShooter(), port: 3000, path: '/', gate: (c) => new OutputPolicy().capture(c) },
    });
    expect(res.ok).toBe(true);
    expect(res.visual?.proof).toMatchObject({ decision: 'required', start: 'declared' });
    expect(res.visual!.proof.captures!.map((c) => [c.side, c.width])).toEqual([
      ['before', 1280], ['before', 768], ['before', 375], ['after', 1280], ['after', 768], ['after', 375],
    ]);
    expect(new Set(res.visual!.files.map((f) => f.capture.sha256)).size).toBe(6);
  }, 300_000);
});
