import { execFileSync } from 'node:child_process';
import { cli, enabled, image } from './helpers.js';

const present = (): boolean => {
  try {
    execFileSync(cli, ['image', 'inspect', image], { stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
};

/** One pull per isolation run, before any file creates a container; an image built here (the runner's, ORC-203) has nowhere to be pulled from. */
export default function setup(): void {
  if (!enabled || (process.env['FACTORY_RUNNER_IMAGE'] && present())) return;
  execFileSync(cli, ['pull', '-q', image], { stdio: 'ignore', timeout: 300_000 });
}
