import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, '../../docker/entrypoint.sh');

/** A POSIX shell test: the CI runs it, a Windows machine skips it. */
describe.skipIf(process.platform === 'win32')('docker/entrypoint.sh (ORC-203)', () => {
  let dir = '';
  let app = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'entrypoint-'));
    app = join(dir, 'app');
    mkdirSync(join(app, 'dist'), { recursive: true });
    writeFileSync(join(app, 'dist/factory.js'), 'code');
    writeFileSync(join(app, '.install-id'), 'abc123\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake engine CLI on the PATH: prints `options`, or fails when there are none. */
  const run = (env: Record<string, string>, options?: string, argv = ['pwd']) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'fakedocker'), options === undefined ? '#!/bin/sh\necho unreachable >&2\nexit 1\n' : `#!/bin/sh\necho '${options}'\n`);
    chmodSync(join(bin, 'fakedocker'), 0o755);
    return spawnSync('sh', [script, ...argv], {
      cwd: app,
      encoding: 'utf8',
      env: { PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`, ...env },
    });
  };

  describe('the engine', () => {
    const cli = { FACTORY_CONTAINER_CLI: 'fakedocker' };

    it('starts on a rootless engine', () => {
      expect(run(cli, '[name=seccomp,profile=builtin name=rootless name=cgroupns]').status).toBe(0);
    });

    it('refuses an engine that is not rootless: its socket is root on the host', () => {
      const r = run(cli, '[name=seccomp,profile=builtin name=cgroupns]');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('rootless');
    });

    it('reads the option, not any text that holds the word', () => {
      expect(run(cli, '[name=seccomp,profile=/etc/docker/rootless-seccomp.json name=cgroupns]').status).toBe(1);
      expect(run(cli, '[name=rootless]').status).toBe(0);
    });

    it('refuses an engine it cannot reach, saying so', () => {
      const r = run(cli);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('fakedocker');
    });

    it('lets a developer machine through only when told', () => {
      expect(run({ ...cli, FACTORY_ALLOW_ROOTFUL_ENGINE: '1' }, '[name=seccomp]').status).toBe(0);
    });

    it('asks nothing of a process without sandboxes (the proxy service)', () => {
      expect(run({}).status).toBe(0);
    });
  });

  describe('the install the runners mount', () => {
    const install = () => join(dir, 'install');

    it('stays where it is without FACTORY_INSTALL_DIR', () => {
      expect(run({}).stdout.trim()).toBe(app);
    });

    it('is copied where the engine sees it, and the command runs from there', () => {
      const r = run({ FACTORY_INSTALL_DIR: install() });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(join(install(), 'abc123'));
      expect(readFileSync(join(install(), 'abc123/dist/factory.js'), 'utf8')).toBe('code');
    });

    it('is not copied twice', () => {
      run({ FACTORY_INSTALL_DIR: install() });
      writeFileSync(join(install(), 'abc123/marker'), 'kept');
      run({ FACTORY_INSTALL_DIR: install() });
      expect(existsSync(join(install(), 'abc123/marker'))).toBe(true);
    });

    it('replaces a copy a crash left unfinished, and leaves other builds: a daemon may be running from one', () => {
      mkdirSync(join(install(), 'abc123.tmp'), { recursive: true });
      writeFileSync(join(install(), 'abc123.tmp/partial'), 'x');
      mkdirSync(join(install(), 'older'), { recursive: true });
      expect(run({ FACTORY_INSTALL_DIR: install() }).status).toBe(0);
      expect(existsSync(join(install(), 'abc123/partial'))).toBe(false);
      expect(existsSync(join(install(), 'abc123.tmp'))).toBe(false);
      expect(existsSync(join(install(), 'older'))).toBe(true);
    });
  });

  it('runs the command it is given', () => {
    const r = run({}, undefined, ['sh', '-c', 'echo ran']);
    expect(r.stdout.trim()).toBe('ran');
  });
});
