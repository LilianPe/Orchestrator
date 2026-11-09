import { execFileSync } from 'node:child_process';
import { POSTGRES_IMAGE } from '../../src/adapters/sandbox/docker-rootless.js';
import { cli, enabled, image } from './helpers.js';

const present = (name = image): boolean => {
  try {
    execFileSync(cli, ['image', 'inspect', name], { stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
};

/** One pull per isolation run, before any file creates a container; an image built here (the runner's, ORC-203) has nowhere to be pulled from. */
export default function setup(): void {
  if (!enabled) return;
  // The attempts' Postgres (ORC-309), for services.test.ts.
  if (!present(POSTGRES_IMAGE)) execFileSync(cli, ['pull', '-q', POSTGRES_IMAGE], { stdio: 'ignore', timeout: 300_000 });
  if (process.env['FACTORY_RUNNER_IMAGE'] && present()) return;
  execFileSync(cli, ['pull', '-q', image], { stdio: 'ignore', timeout: 300_000 });
}
