import { DEFAULT_REQUIREMENTS } from '../sandbox/types.js';
import type { Page, ShootRequest, Shots, VisualShooter } from './types.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG by its signature, whose bytes after it are `label`'s: two labels, two different images. */
export function fakePng(label: string): Uint8Array {
  return Uint8Array.from([...SIGNATURE, ...new TextEncoder().encode(label)]);
}

/**
 * The browser of tests: each commit shows its own page (`fakePng(sha@width)`), so before and after differ. A test scripts a
 * commit's shots (`bySha`): the same page as another, an app that does not start, console errors.
 */
export class FakeShooter implements VisualShooter {
  readonly requirements = { ...DEFAULT_REQUIREMENTS, browser: true };
  calls: ShootRequest[] = [];
  bySha = new Map<string, (req: ShootRequest) => Shots | Promise<Shots>>();

  async shoot(_sandboxes: unknown, req: ShootRequest): Promise<Shots> {
    this.calls.push(req);
    const scripted = this.bySha.get(req.sha);
    if (scripted) return scripted(req);
    return { started: true, pages: req.widths.map((width): Page => ({ width, png: fakePng(`${req.sha}@${width}`), consoleErrors: [] })) };
  }

  /** `sha` shows the very page of `like`. */
  same(sha: string, like: string): void {
    this.bySha.set(sha, (req) => ({ started: true, pages: req.widths.map((width) => ({ width, png: fakePng(`${like}@${width}`), consoleErrors: [] })) }));
  }
}
