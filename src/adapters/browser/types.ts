import type { SandboxProvider, SandboxRequirements } from '../sandbox/types.js';

/** The three widths of the visual proof (ORC-176): a desktop, a tablet, a phone. */
export const VIEWPORTS = [
  { name: 'desktop', width: 1280 },
  { name: 'tablet', width: 768 },
  { name: 'mobile', width: 375 },
] as const;

export interface ShootRequest {
  /** The sandbox holding the checkout at `/work`, at network `none`: the app and the browser in it, nothing out. */
  sandboxId: string;
  /** The commit checked out, for the log and a fake. */
  sha: string;
  /** The command that starts the app, run in the background; it listens on `port`. */
  start: string;
  port: number;
  /** A path of the app (`/settings`), never another host. */
  path: string;
  widths: readonly number[];
}

/** One page at one width: its PNG, and the errors its console or its scripts threw while it loaded. */
export interface Page {
  width: number;
  png: Uint8Array;
  consoleErrors: string[];
}

/** `started: false`: the app never listened, or the page never loaded; `detail` says what it printed, the tail of it. */
export type Shots = { started: true; pages: Page[] } | { started: false; detail: string };

/**
 * The browser of the visual proof (ORC-176): it starts the app in a sandbox and shoots a page of it at each width. A
 * failure of the browser itself rejects, an infrastructure failure; the app's own failure is a result.
 */
export interface VisualShooter {
  /** What the sandbox it shoots in must offer: a browser. */
  readonly requirements: SandboxRequirements;
  shoot(sandboxes: Pick<SandboxProvider, 'exec'>, req: ShootRequest): Promise<Shots>;
}
