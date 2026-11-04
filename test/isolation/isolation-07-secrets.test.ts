import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { execCmd } from '../../src/adapters/exec.js';
import { ClaudeCodeRunner } from '../../src/adapters/runner/claude-code.js';
import { SANDBOX_HOME, WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { parseRepoConfig } from '../../src/config/repo-config.js';
import { repoVariables } from '../../src/config/repo-variables.js';
import { CLAUDE_RUN_ENV } from '../../src/core/orchestrator.js';
import { runSealedSetup } from '../../src/core/sealed-setup.js';
import { cli, enabled, image, useSandboxes } from './helpers.js';

/**
 * Isolation n° 7 (ORC-218, extended by ORC-211): the only credential in a run is the token of the chosen
 * Claude account, and no secret of the repository outlives its `setup`. The run goes through the real
 * runner, its `claude` swapped for `sh -c env`, with a daemon environment full of secrets; the setup goes
 * through the real sealed setup, on a real engine; then the agent's sandbox, the disk and the image's
 * layers and config are searched. Run it on the runner image with FACTORY_RUNNER_IMAGE (built from
 * docker/runner.Dockerfile), the public node image otherwise.
 */
const TOKEN = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}/;
/** The shape of a credential's name: this test's own, an oracle independent of the mask's and the config's. */
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|_PASS|_PWD|APIKEY|_KEY|CREDENTIALS?|DATABASE_URL)$/i;

const CHOSEN_ACCOUNT = 'sk-ant-oat01-chosen-account-token';
/** What the daemon sets for a sandboxed run (src/app/bootstrap.ts agentEnv, src/core/orchestrator.ts). */
const RUN_ENV = {
  FACTORY_RUN_TOKEN: 'run-token-of-this-run',
  FACTORY_TICKET: 'ISO-7',
  FACTORY_API: 'http://host.docker.internal:7778/agent',
  FACTORY_KNOWLEDGE: '',
  FACTORY_ROOT: '/factory/app',
  ...CLAUDE_RUN_ENV,
  CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude`,
};
/** The daemon's own, what a developer's shell holds, and the other logins: none may cross. */
const DAEMON_SECRETS = {
  LINEAR_API_KEY: 'lin_api_daemonsecret',
  LINEAR_WEBHOOK_SECRET: 'whsec-daemon',
  FACTORY_SECRETS_KEY: 'daemon-secrets-key',
  FACTORY_DATABASE_URL: 'postgres://factory:pw@db/factory',
  RELAIS_TOKEN: 'old-prefix-secret', // transition, à retirer (ORC-167)
  GH_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  GITHUB_TOKEN: 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  ANTHROPIC_API_KEY: 'sk-ant-api03-an-api-key-of-the-daemon',
  ANTHROPIC_BASE_URL: 'https://gateway.exemple.com',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-login-of-the-daemon-shell',
  CLAUDE_TOKEN_2: 'sk-ant-oat01-the-account-not-chosen',
  NPM_TOKEN: 'npm_daemonsecret',
};

const REPO_SECRET = 'repo-secret-for-the-setup-Zx81';
const encoded = Buffer.from(REPO_SECRET).toString('base64');

/** What a repository's setup can do with its secret: write it wherever it can, and leave a process holding it. */
const GIT_TARGET = '/git-dir';
const LEAKY_SETUP = `
  printf '%s' "$REPO_TOKEN" | sha256sum | cut -d' ' -f1 > ${WORKSPACE_TARGET}/secret-seen.txt
  echo "TOKEN=$REPO_TOKEN" > ${WORKSPACE_TARGET}/.env
  mkdir -p ${WORKSPACE_TARGET}/deep/er && echo "//registry/:_authToken=$REPO_TOKEN" > ${WORKSPACE_TARGET}/deep/er/.npmrc
  printf '%s' "$REPO_TOKEN" | base64 > ${WORKSPACE_TARGET}/deep/encoded.txt
  echo "$REPO_TOKEN" > /tmp/left-in-tmp.txt
  echo "$REPO_TOKEN" > "$HOME/.npmrc"
  (echo "$REPO_TOKEN" > ${GIT_TARGET}/config.leak) 2>/dev/null; echo $? > ${WORKSPACE_TARGET}/git-write-exit.txt
  nohup sh -c 'sleep 900' > /dev/null 2>&1 &
  echo 'export const kept = 1;' > ${WORKSPACE_TARGET}/kept.ts
`;

describe.skipIf(!enabled)(`no secret in the sandbox (${cli}, isolation n° 7)`, () => {
  const { provider, create, sh, workspace } = useSandboxes('07');
  const prefix = `iso-07-${Date.now()}`;
  /** The engine's calls, recorded on the way through. */
  const engineArgs: string[][] = [];
  const engineEnvs: Record<string, string>[] = [];
  const { provider: recorded } = useSandboxes('07-argv', {
    exec: (cmd, args, opts) => {
      engineArgs.push(args);
      if (opts?.env) engineEnvs.push(opts.env);
      return execCmd(cmd, args, opts);
    },
  });

  /** The environment of the real runner's run, in a daemon whose environment is full of secrets. */
  async function runEnvOf(runEnv: Record<string, string>): Promise<Record<string, string>> {
    const ws = workspace();
    const sbx = await create({ workspacePath: ws });
    const saved = Object.fromEntries(Object.keys(DAEMON_SECRETS).map((k) => [k, process.env[k]]));
    Object.assign(process.env, DAEMON_SECRETS);
    try {
      const runner = new ClaudeCodeRunner({ transcriptsDir: workspace(), sandboxes: provider, claudeToken: () => CHOSEN_ACCOUNT, command: ['sh', '-c', `env > ${WORKSPACE_TARGET}/env.txt`, 'sh'] });
      await runner.start({
        runId: 'iso-07',
        cwd: WORKSPACE_TARGET,
        prompt: 'p',
        claudeSessionId: 's',
        resume: false,
        model: 'haiku',
        pluginDir: '/factory/pack',
        settingsPath: '/factory/pack/settings.json',
        readOnly: false,
        limits: { turns: 1, durationMs: 60_000, usd: 0 },
        env: runEnv,
        sandboxId: sbx.id,
      }).done;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    return Object.fromEntries(
      readFileSync(join(ws, 'env.txt'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  }

  it('hands a run its own variables and the chosen account token alone, none of the daemon', async () => {
    const env = await runEnvOf(RUN_ENV);
    for (const [k, v] of Object.entries(RUN_ENV)) expect(env[k]).toBe(v);
    const daemonOnly = /^(LINEAR_|FACTORY_|RELAIS_)/; // RELAIS_ : transition, à retirer (ORC-167)
    expect(Object.keys(env).filter((k) => daemonOnly.test(k)).sort()).toEqual(Object.keys(RUN_ENV).filter((k) => k.startsWith('FACTORY_')).sort());
    for (const k of Object.keys(DAEMON_SECRETS).filter((k) => k !== 'CLAUDE_CODE_OAUTH_TOKEN')) expect(env).not.toHaveProperty(k);
    for (const v of Object.values(DAEMON_SECRETS)) expect(Object.values(env)).not.toContain(v);
    // Acceptance 2: listed by name and by shape, the account's token is the only credential; the run token is the factory's own, valid for this run.
    expect(Object.keys(env).filter((k) => CREDENTIAL_NAME.test(k)).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'FACTORY_RUN_TOKEN']);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(CHOSEN_ACCOUNT);
    expect(Object.entries(env).filter(([, v]) => TOKEN.test(v)).map(([k]) => k)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  }, 240_000);

  it('passes a repository variable only if .factory/config.yml declares it', async () => {
    const config = parseRepoConfig('env: [DECLARED_VAR]\nsetup_secrets: [REPO_TOKEN]\n');
    const vars = repoVariables(config, { env: { DECLARED_VAR: 'declared-value', UNDECLARED_VAR: 'undeclared-value' }, secrets: { REPO_TOKEN: REPO_SECRET, UNDECLARED_TOKEN: 'undeclared-secret' } });
    const env = await runEnvOf({ ...vars.env, ...RUN_ENV });
    expect(env['DECLARED_VAR']).toBe('declared-value');
    expect(env).not.toHaveProperty('UNDECLARED_VAR');
    expect(env).not.toHaveProperty('REPO_TOKEN');
    expect(env).not.toHaveProperty('UNDECLARED_TOKEN');
    expect(Object.values(env).join('\n')).not.toContain(REPO_SECRET);
  }, 240_000);

  it('finds no credential file in the sandbox of a run', async () => {
    const sbx = await create();
    const r = await sh(sbx.id, `for f in "$HOME/.claude/.credentials.json" "$HOME/.git-credentials" "$HOME/.npmrc" "$HOME/.netrc" "$HOME/.aws/credentials" "$HOME/.config/gh/hosts.yml" "$HOME/.ssh" /run/secrets; do [ -e "$f" ] && echo "$f"; done; true`);
    expect(r.stdout).toBe('');
  }, 240_000);

  describe('the sealed setup (ORC-211)', () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'factory-iso-git-'));
    afterAll(() => rmSync(gitDir, { recursive: true, force: true }));
    const ws = workspace();
    const runId = `${prefix}-sealed`;
    const mounts = [{ host: gitDir, target: GIT_TARGET, readOnly: true }];

    it('gives the setup its secret, then none of it is left on the disk', async () => {
      const setup = await runSealedSetup(provider, {
        runId,
        ticketId: 'ISO-7',
        workspacePath: ws,
        mounts,
        commands: [LEAKY_SETUP],
        env: {},
        secrets: { REPO_TOKEN: REPO_SECRET },
        now: new Date(),
      });
      // It really had it: the witness a discriminating test needs.
      expect(readFileSync(join(ws, 'secret-seen.txt'), 'utf8').trim()).toBe(createHash('sha256').update(REPO_SECRET).digest('hex'));
      expect(setup.purged.map((p) => p.slice(ws.length + 1).replaceAll('\\', '/')).sort()).toEqual(['.env', 'deep/encoded.txt', 'deep/er/.npmrc']);
      for (const f of ['.env', 'deep/er/.npmrc', 'deep/encoded.txt']) expect(existsSync(join(ws, f))).toBe(false);
      // What it made without the secret stays: the setup's work is not lost.
      expect(readFileSync(join(ws, 'kept.ts'), 'utf8')).toContain('kept');
    }, 240_000);

    it('its container is gone, with what it left out of the worktree', async () => {
      expect(await provider.findByAttempt(`${runId}-setup`)).toBeUndefined();
      const all = execFileSync(cli, ['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Labels}}'], { encoding: 'utf8' });
      expect(all).not.toContain(`${runId}-setup`);
    });

    it('gives the command its env under its own names, with no trace of the transport', async () => {
      const r = await provider.exec((await create()).id, ['sh', '-c', 'printf "%s|%s|" "$HOME" "$MULTI"; env | grep -c FACTORY_SANDBOX_ENV; true'], { env: { HOME: '/tmp/moved', MULTI: 'a "b"\n$c' } });
      expect(r.stdout.trim()).toBe('/tmp/moved|a "b"\n$c|0');
    }, 240_000);

    it('could not write in the git dir: read-only for it', () => {
      expect(readFileSync(join(ws, 'git-write-exit.txt'), 'utf8').trim()).not.toBe('0');
      expect(existsSync(join(gitDir, 'config.leak'))).toBe(false);
    });

    it('an agent on the same worktree finds it nowhere: files, environments, processes', async () => {
      const sbx = await create({ workspacePath: ws, ticketId: 'ISO-7' });
      // The pattern comes through a pipe, encoded: on the search's own command line, it would find itself.
      const search = async (what: string) => {
        const pattern = `<(echo ${Buffer.from(what).toString('base64')} | base64 -d)`;
        const r = await provider.exec(sbx.id, ['bash', '-c', `grep -rlFf ${pattern} /work /tmp /home /run /factory 2>/dev/null; for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qFf ${pattern} && echo "$p"; tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -qFf ${pattern} && echo "$p"; done; true`]);
        return r.stdout.trim();
      };
      expect(await search(REPO_SECRET)).toBe('');
      expect(await search(encoded)).toBe('');
      const processes = await sh(sbx.id, `for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null; echo; done`);
      expect(processes.stdout).not.toContain('sleep 900');
      // The search above finds what is there: a negative control on the same container.
      await sh(sbx.id, `echo '${REPO_SECRET}' > ${WORKSPACE_TARGET}/control.txt`);
      expect(await search(REPO_SECRET)).toContain('control.txt');
      await sh(sbx.id, `rm ${WORKSPACE_TARGET}/control.txt`);
    }, 240_000);

    it('the engine holds it neither in the agent container nor in any image layer', async () => {
      const sbx = await create({ workspacePath: ws, ticketId: 'ISO-7' });
      expect(execFileSync(cli, ['inspect', sbx.id], { encoding: 'utf8' })).not.toContain(REPO_SECRET);
      const history = execFileSync(cli, ['history', '--no-trunc', '--format', '{{.CreatedBy}}', image], { encoding: 'utf8' });
      const inspect = execFileSync(cli, ['image', 'inspect', image], { encoding: 'utf8' });
      expect(history).not.toContain(REPO_SECRET);
      expect(inspect).not.toContain(REPO_SECRET);
      // A setup commits no image: nothing the secret could have reached was kept by the engine.
      const images = execFileSync(cli, ['images', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `label=factory.attempt=${runId}-setup`], { encoding: 'utf8' });
      expect(images.trim()).toBe('');
    }, 240_000);

    it('does not give the secret to the engine on its command line, nor the container\'s env to its process', async () => {
      await runSealedSetup(recorded, { runId: `${runId}-argv`, ticketId: 'ISO-7', workspacePath: workspace(), mounts, commands: ['true'], env: {}, secrets: { REPO_TOKEN: REPO_SECRET }, now: new Date() });
      expect(engineArgs.flat().join(' ')).not.toContain(REPO_SECRET);
      expect(engineArgs.flat().join(' ')).toContain('REPO_TOKEN');
      // The HOME of the setup moves the rootless engine's storage: the CLI never sees it.
      expect(engineEnvs.length).toBeGreaterThan(0);
      for (const env of engineEnvs) expect(Object.keys(env).filter((k) => !k.startsWith('FACTORY_SANDBOX_ENV_'))).toEqual([]);
    }, 240_000);
  });

  it('runs no install script of a package under the setup hardening, as it does without', async () => {
    const ws = workspace();
    mkdirSync(join(ws, 'dep'));
    writeFileSync(join(ws, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', scripts: { postinstall: `touch ${WORKSPACE_TARGET}/POSTINSTALL_RAN` } }));
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    // No registry here: a local tarball with no dependency, which is all it takes to run a postinstall.
    const install = `export npm_config_cache=/tmp/npm-cache npm_config_audit=false npm_config_fund=false; (cd ${WORKSPACE_TARGET}/dep && npm pack --silent > /dev/null) && cd ${WORKSPACE_TARGET} && npm install ./dep/dep-1.0.0.tgz --no-save`;
    await runSealedSetup(provider, { runId: `${prefix}-scripts`, ticketId: 'ISO-7', workspacePath: ws, mounts: [], commands: [install], env: {}, secrets: {}, now: new Date() });
    expect(existsSync(join(ws, 'node_modules', 'dep', 'package.json'))).toBe(true);
    expect(existsSync(join(ws, 'POSTINSTALL_RAN'))).toBe(false);
    // The control: the same install, without the hardening, runs it. The test would pass for nothing otherwise.
    const control = await create({ workspacePath: ws });
    rmSync(join(ws, 'node_modules'), { recursive: true, force: true });
    const r = await provider.exec(control.id, ['bash', '-c', install]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(ws, 'POSTINSTALL_RAN'))).toBe(true);
  }, 240_000);

  it('runs no install script under Yarn 1, which the node images ship, as it does without', async () => {
    const ws = workspace();
    mkdirSync(join(ws, 'dep'));
    writeFileSync(join(ws, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', scripts: { postinstall: `touch ${WORKSPACE_TARGET}/YARN_POSTINSTALL_RAN` } }));
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    const install = `export YARN_CACHE_FOLDER=/tmp/yarn-cache; cd ${WORKSPACE_TARGET} && yarn add file:./dep --no-lockfile --silent`;
    await runSealedSetup(provider, { runId: `${prefix}-yarn`, ticketId: 'ISO-7', workspacePath: ws, mounts: [], commands: [install], env: {}, secrets: {}, now: new Date() });
    expect(existsSync(join(ws, 'node_modules', 'dep', 'package.json'))).toBe(true);
    expect(existsSync(join(ws, 'YARN_POSTINSTALL_RAN'))).toBe(false);
    const control = await create({ workspacePath: ws });
    rmSync(join(ws, 'node_modules'), { recursive: true, force: true });
    const r = await provider.exec(control.id, ['bash', '-c', `export HOME=/tmp/h; mkdir -p $HOME; ${install}`]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(ws, 'YARN_POSTINSTALL_RAN'))).toBe(true);
  }, 240_000);

  it('has no token in its image layers nor its config', () => {
    const history = execFileSync(cli, ['history', '--no-trunc', '--format', '{{.CreatedBy}}', image], { encoding: 'utf8' });
    const inspect = execFileSync(cli, ['image', 'inspect', image], { encoding: 'utf8' });
    expect(history).not.toMatch(TOKEN);
    expect(inspect).not.toMatch(TOKEN);
  });
});
