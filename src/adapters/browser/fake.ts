import { PNG_SIGNATURE } from '../../publish/output-policy.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { BROWSER_REQUIREMENTS, type ShootRequest, type Shots, type VisualShooter } from './types.js';

/** A PNG by its signature, whose bytes after it are `label`'s: two labels, two different images. */
export function fakePng(label: string): Uint8Array {
  return Uint8Array.from([...PNG_SIGNATURE, ...new TextEncoder().encode(label)]);
}

/**
 * The browser of tests: each page is `fakePng(<label>@<width>)`, the label the commit's sha unless a subclass reads it elsewhere
 * (`label`), so before and after differ. `answer` scripts a request's shots instead: an app that does not start, console errors.
 */
export class FakeShooter implements VisualShooter {
  readonly requirements = BROWSER_REQUIREMENTS;
  calls: ShootRequest[] = [];
  answer?: (req: ShootRequest) => Shots | undefined;

  async shoot(sandboxes: Pick<SandboxProvider, 'exec'>, req: ShootRequest): Promise<Shots> {
    this.calls.push(req);
    const label = await this.label(sandboxes, req);
    return this.answer?.(req) ?? { started: true, pages: req.widths.map((width) => ({ width, png: fakePng(`${label}@${width}`), consoleErrors: [] })) };
  }

  protected label(_sandboxes: Pick<SandboxProvider, 'exec'>, req: ShootRequest): Promise<string> {
    return Promise.resolve(req.sha);
  }
}
