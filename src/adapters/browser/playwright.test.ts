import { describe, expect, it } from 'vitest';
import { FakeSandboxProvider } from '../sandbox/fake.js';
import { DEFAULT_REQUIREMENTS } from '../sandbox/types.js';
import { fakePng } from './fake.js';
import { parseShots, PlaywrightShooter } from './playwright.js';

const REQ = { sha: 'abc', start: 'npm run preview', port: 4200, path: '/settings', widths: [1280, 768, 375] };

async function shoot(answer: { code: number; stdout: string; stderr?: string }) {
  const sandboxes = new FakeSandboxProvider();
  const { id } = await sandboxes.create({ runId: 'r1-visual-after', ticketId: 'T-1', workspacePath: '/w', network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
  sandboxes.execResult = () => ({ stderr: '', ...answer });
  const shots = new PlaywrightShooter().shoot(sandboxes, { ...REQ, sandboxId: id });
  return { sandboxes, shots };
}

describe('the Playwright shooter (ORC-176)', () => {
  it('needs a sandbox with a browser', () => {
    expect(new PlaywrightShooter().requirements).toMatchObject({ browser: true });
  });

  it('starts the application and shoots the page in one capped command of its sandbox, the PNGs read back from its last line', async () => {
    const png = fakePng('page');
    const line = JSON.stringify({ started: true, pages: [{ width: 1280, png: Buffer.from(png).toString('base64'), consoleErrors: ['boom'] }] });
    const { sandboxes, shots } = await shoot({ code: 0, stdout: `npm noise\n${line}\n` });
    expect(await shots).toEqual({ started: true, pages: [{ width: 1280, png, consoleErrors: ['boom'] }] });
    const argv = sandboxes.execs[0]!.argv;
    expect(argv[0]).toBe('timeout');
    expect(argv.slice(-5)).toEqual(['4200', 'npm run preview', expect.stringContaining("require('playwright')"), '/settings', '1280,768,375']);
  });

  it("an application that never answers is the app's failure, a result", async () => {
    const { shots } = await shoot({ code: 0, stdout: JSON.stringify({ started: false, detail: 'nothing answers on port 4200' }) });
    expect(await shots).toEqual({ started: false, detail: 'nothing answers on port 4200' });
  });

  it("the browser's own failure rejects: an infrastructure failure, never a verdict on the branch", () => {
    expect(() => parseShots(3, '', "Cannot find module 'playwright'")).toThrow(/could not shoot \(code 3\).*playwright/);
    expect(() => parseShots(0, 'not json', '')).toThrow(/could not shoot/);
  });
});
