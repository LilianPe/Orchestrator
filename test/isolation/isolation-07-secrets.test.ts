import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../../src/adapters/runner/claude-code.js';
import { SANDBOX_HOME, WORKSPACE_TARGET } from '../../src/adapters/sandbox/types.js';
import { CLAUDE_RUN_ENV } from '../../src/core/orchestrator.js';
import { cli, enabled, image, useSandboxes } from './helpers.js';

/**
 * Isolation n° 7 (ORC-218): no daemon secret reaches a run. The run goes through the real runner, its
 * `claude` swapped for `sh -c env`, with a daemon environment full of secrets; then the image's layers
 * and config are searched for tokens. Run it on the runner image with FACTORY_RUNNER_IMAGE (built from
 * docker/runner.Dockerfile), the public node image otherwise.
 */
const TOKEN = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}/;

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
/** The daemon's own, and what a developer's shell holds: none may cross. */
const DAEMON_SECRETS = {
  LINEAR_API_KEY: 'lin_api_daemonsecret',
  LINEAR_WEBHOOK_SECRET: 'whsec-daemon',
  FACTORY_SECRETS_KEY: 'daemon-secrets-key',
  FACTORY_DATABASE_URL: 'postgres://factory:pw@db/factory',
  RELAIS_TOKEN: 'old-prefix-secret', // transition, à retirer (ORC-167)
  GH_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  GITHUB_TOKEN: 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
};

describe.skipIf(!enabled)(`no secret in the sandbox (${cli}, isolation n° 7)`, () => {
  const { provider, create, workspace } = useSandboxes('07');

  it('hands a run its own variables, none of the daemon', async () => {
    const ws = workspace();
    const sbx = await create({ workspacePath: ws });
    const saved = Object.fromEntries(Object.keys(DAEMON_SECRETS).map((k) => [k, process.env[k]]));
    Object.assign(process.env, DAEMON_SECRETS);
    try {
      const runner = new ClaudeCodeRunner({ transcriptsDir: workspace(), sandboxes: provider, command: ['sh', '-c', `env > ${WORKSPACE_TARGET}/env.txt`, 'sh'] });
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
        env: RUN_ENV,
        sandboxId: sbx.id,
      }).done;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const env = Object.fromEntries(
      readFileSync(join(ws, 'env.txt'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    for (const [k, v] of Object.entries(RUN_ENV)) expect(env[k]).toBe(v);
    expect(Object.keys(env).filter((k) => /^(LINEAR_|FACTORY_|RELAIS_)/.test(k)).sort()) // RELAIS_ : transition, à retirer (ORC-167).toEqual(Object.keys(RUN_ENV).filter((k) => k.startsWith('FACTORY_')).sort());
    for (const k of Object.keys(DAEMON_SECRETS)) expect(env).not.toHaveProperty(k);
    for (const v of Object.values(DAEMON_SECRETS)) expect(Object.values(env)).not.toContain(v);
    // The login is handed over on purpose (the runner's SANDBOX_AUTH), when the shell has one.
    expect(Object.entries(env).filter(([k, v]) => !/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k) && TOKEN.test(v))).toEqual([]);
  });

  it('has no token in its image layers nor its config', () => {
    const history = execFileSync(cli, ['history', '--no-trunc', '--format', '{{.CreatedBy}}', image], { encoding: 'utf8' });
    const inspect = execFileSync(cli, ['image', 'inspect', image], { encoding: 'utf8' });
    expect(history).not.toMatch(TOKEN);
    expect(inspect).not.toMatch(TOKEN);
  });
});
