import { execFileSync } from 'node:child_process';
import { POSTGRES_IMAGE } from '../../src/adapters/sandbox/docker-rootless.js';
import { cli, enabled, ensureImage, image } from './helpers.js';

/** One pull per isolation run, before any file creates a container; an image built here (the runner's, ORC-203) has nowhere to be pulled from. */
export default function setup(): void {
  if (!enabled) return;
  // The attempts' Postgres (ORC-309), for services.test.ts.
  ensureImage(POSTGRES_IMAGE);
  if (process.env['FACTORY_RUNNER_IMAGE']) return ensureImage(image);
  execFileSync(cli, ['pull', '-q', image], { stdio: 'ignore', timeout: 300_000 });
}
