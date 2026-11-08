import { cappedCommand } from '../../core/verify.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { BROWSER_REQUIREMENTS, type Page, type ShootRequest, type Shots, type VisualShooter } from './types.js';

/** How long the application has to answer on its port, then how long the page has to load. */
const START_TIMEOUT_S = 120;
const PAGE_TIMEOUT_MS = 30_000;
/** The whole shot, application and three widths, under coreutils' cap: past it, the browser is stuck, an infrastructure failure. */
const SHOT_TIMEOUT_S = START_TIMEOUT_S + 3 * (PAGE_TIMEOUT_MS / 1000) + 60;
/** Where the application's output goes, in the sandbox; its tail is what a failed start says. */
const APP_LOG = '/tmp/factory-app.log';
const HEIGHT = 900;

/**
 * Run by `node` in the sandbox, with the image's Playwright: waits for the application on its port, then loads the page at each
 * width and writes one JSON line, the PNGs in base64 with what the console and the page's scripts threw. An application that never
 * answers, or a page that never loads, is `started: false`; anything else that fails, the browser's own failure, exits non-zero.
 */
const SHOOT = String.raw`
const [port, path, widths, log] = process.argv.slice(1);
const { chromium } = require('playwright');
const tail = () => { try { return require('fs').readFileSync(log, 'utf8').slice(-4000); } catch { return ''; } };
const out = (o) => process.stdout.write('\n' + JSON.stringify(o) + '\n');
(async () => {
  const origin = 'http://127.0.0.1:' + port;
  const url = origin + path;
  const deadline = Date.now() + ${START_TIMEOUT_S * 1000};
  for (;;) {
    try { await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(5000) }); break; } catch {}
    if (Date.now() > deadline) return out({ started: false, detail: 'nothing answers on port ' + port + ' after ${START_TIMEOUT_S} s\n' + tail() });
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch();
  const pages = [];
  try {
    for (const width of widths.split(',').map(Number)) {
      const page = await browser.newPage({ viewport: { width, height: ${HEIGHT} } });
      const consoleErrors = [];
      // At network none, a resource of another host fails, and Chromium logs it as an error: only what comes from the application counts.
      const own = (u) => !u || (u.startsWith(origin + '/') && !u.startsWith(origin + '/favicon.ico'));
      page.on('console', (m) => { if (m.type() === 'error' && own(m.location().url)) consoleErrors.push(m.text().slice(0, 500)); });
      page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 500)));
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: ${PAGE_TIMEOUT_MS} });
      } catch (e) {
        return out({ started: false, detail: 'the page ' + path + ' did not load: ' + e.message + '\n' + tail() });
      }
      const png = await page.screenshot({ fullPage: true });
      pages.push({ width, png: png.toString('base64'), consoleErrors });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  out({ started: true, pages });
})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(3); });
`;

/** The shell around it: the application in the background on `PORT`, its output to `APP_LOG`, Playwright from the image's global install. */
const SCRIPT = `PORT="$1" bash --norc -c "$2" >${APP_LOG} 2>&1 &
NODE_PATH="$(npm root -g)" exec node -e "$3" "$1" "$4" "$5" ${APP_LOG}`;

/**
 * The browser of the visual proof (ORC-176): Playwright's Chromium in the sandbox, beside the application it shoots, at network
 * `none`: the page reaches nothing but the application. The image must carry Playwright and its Chromium, and the backend must offer
 * a browser (`requirements.browser`): until one does (ORC-152), nothing wires this shooter and a required proof stays unavailable.
 */
export class PlaywrightShooter implements VisualShooter {
  readonly requirements = BROWSER_REQUIREMENTS;

  async shoot(sandboxes: Pick<SandboxProvider, 'exec'>, req: ShootRequest): Promise<Shots> {
    const argv = [...cappedCommand(SCRIPT, SHOT_TIMEOUT_S), 'shoot', String(req.port), req.start, SHOOT, req.path, req.widths.join(',')];
    const r = await sandboxes.exec(req.sandboxId, argv, { env: req.env });
    return parseShots(r.code, r.stdout, r.stderr);
  }
}

/** The script's last line; a run that wrote none, or exited non-zero, is the browser's failure, and rejects. */
export function parseShots(code: number, stdout: string, stderr: string): Shots {
  const out = stdout.trimEnd();
  // The last line alone: the PNGs make the output weigh megabytes, not worth splitting.
  const line = out.slice(out.lastIndexOf('\n') + 1);
  let o: { started: boolean; detail?: string; pages?: { width: number; png: string; consoleErrors: string[] }[] };
  try {
    if (code !== 0) throw new Error();
    o = JSON.parse(line) as typeof o;
  } catch {
    throw new Error(`the browser could not shoot (code ${code}): ${stderr.trim().slice(-2000)}`);
  }
  if (!o.started) return { started: false, detail: o.detail ?? '' };
  if (!o.pages?.length) throw new Error('the browser returned no page');
  const pages = o.pages.map((p): Page => {
    const png = Buffer.from(p.png, 'base64');
    // A view on the decoded bytes, not a copy of them.
    return { width: p.width, png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), consoleErrors: p.consoleErrors };
  });
  return { started: true, pages };
}
