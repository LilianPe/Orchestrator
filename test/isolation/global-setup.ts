import { execFileSync } from 'node:child_process';
import { cli, enabled, image } from './helpers.js';

/** One pull per isolation run, before any file creates a container. */
export default function setup(): void {
  if (enabled) execFileSync(cli, ['pull', '-q', image], { stdio: 'ignore', timeout: 300_000 });
}
