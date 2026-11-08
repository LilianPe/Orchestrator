import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeClaudeToken, claudeToken, FactoryYmlError, loadFactoryYml, parseFactoryYml, stepSettings } from './factory-yml.js';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----';
const ENV = {
  LINEAR_CLIENT_ID: 'lin-client',
  LINEAR_CLIENT_SECRET: 'lin-secret',
  LINEAR_WEBHOOK_SECRET: 'lin-webhook-secret-123',
  GH_APP_ID: '42',
  GH_APP_KEY: PEM,
  GH_WEBHOOK_SECRET: 'gh-webhook-secret-123',
  CLAUDE_TOKEN_1: 'tok-1',
  CLAUDE_TOKEN_2: 'tok-2',
};

const EXAMPLE = `
linear:   { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }
github:   { app_id: env:GH_APP_ID, private_key: env:GH_APP_KEY, webhook_secret: env:GH_WEBHOOK_SECRET }
claude:
  runtime: claude-code
  accounts:
    - { name: compte-1, token: env:CLAUDE_TOKEN_1 }
    - { name: compte-2, token: env:CLAUDE_TOKEN_2 }
  active: compte-1
  default_model: claude-sonnet-5-5
  per_step: { review: claude-opus-5-5 }
  effort:
    default: medium
    per_step: { intake: low, clarify: low, spec_draft: high, tests: medium, build: medium, fix: medium, review: high }
concurrency: 1
budgets:
  max_turns: { build: 150, fix: 60, review: 25 }
  on_usage_limit: wait
repos:
  - { linear_team: ORC, github: LilianPe/Orchestrator }
`;

function violations(yaml: string, env: NodeJS.ProcessEnv = ENV): string[] {
  try {
    parseFactoryYml(yaml, env);
    return [];
  } catch (err) {
    if (err instanceof FactoryYmlError) return err.violations;
    throw err;
  }
}

describe('factory.yml (ORC-209, part B)', () => {
  it('reads the example of the MVP doc, each env: resolved', () => {
    const c = parseFactoryYml(EXAMPLE, ENV);
    expect(c.linear).toEqual({ clientId: 'lin-client', clientSecret: 'lin-secret', webhookSecret: 'lin-webhook-secret-123' });
    expect(c.github).toEqual({ appId: '42', privateKey: PEM, webhookSecret: 'gh-webhook-secret-123' });
    expect(c.claude).toMatchObject({ runtime: 'claude-code', active: 'compte-1', defaultModel: 'claude-sonnet-5-5', perStep: { review: 'claude-opus-5-5' } });
    expect(c.claude?.accounts).toEqual([{ name: 'compte-1', token: 'tok-1' }, { name: 'compte-2', token: 'tok-2' }]);
    expect(c.concurrency).toBe(1);
    expect(c.budgets).toEqual({ maxTurns: { build: 150, fix: 60, review: 25 }, onUsageLimit: 'wait' });
    expect(c.repos).toEqual([{ linearTeam: 'ORC', github: 'LilianPe/Orchestrator' }]);
  });

  it('names the key whose variable is missing', () => {
    const { LINEAR_WEBHOOK_SECRET: _, ...env } = ENV;
    expect(violations(EXAMPLE, env)).toEqual(['linear.webhook_secret: the environment variable LINEAR_WEBHOOK_SECRET is not set']);
  });

  it('refuses a secret written in the file instead of env:NAME', () => {
    expect(violations('github: { app_id: 42, private_key: "-----BEGIN RSA PRIVATE KEY-----" }\n')).toEqual([
      'github.private_key: a secret is written `env:NAME`, never in clear in factory.yml',
    ]);
  });

  it('refuses an unknown key with its path', () => {
    expect(violations('relay: { kind: smee }\nclaude: { runtime: claude-code, accounts: [{ name: x, token: env:CLAUDE_TOKEN_1 }], active: x, default_model: m, color: red }\n')).toEqual([
      'relay: unknown key',
      'claude.color: unknown key',
    ]);
  });

  it('names the required keys of a section that are missing or empty', () => {
    expect(violations('claude: { runtime: claude-code, accounts: [{ name: a, token: env:CLAUDE_TOKEN_1 }] }\ngithub: { app_id: 42, private_key: }\n')).toEqual([
      'github.private_key: required',
      'claude.active: required',
      'claude.default_model: required',
    ]);
  });

  it('does not blame the active account when the accounts themselves are malformed', () => {
    expect(violations('claude: { runtime: claude-code, accounts: [{ name: a, token: env:CLAUDE_TOKEN_1, extra: 1 }], active: a, default_model: m }\n')).toEqual([
      'claude.accounts: `[{ name, token }]` expected',
    ]);
  });

  it('refuses an env: reference whose name is not a variable name', () => {
    expect(violations('linear: { webhook_secret: "env:" }\ngithub: { app_id: 1, private_key: "env: GH_APP_KEY" }\n')).toEqual([
      'linear.webhook_secret: "env:" does not name a variable (`env:NAME`)',
      'github.private_key: "env: GH_APP_KEY" does not name a variable (`env:NAME`)',
    ]);
  });

  it('refuses an active account that is not declared', () => {
    expect(violations('claude: { runtime: claude-code, accounts: [{ name: a, token: env:CLAUDE_TOKEN_1 }], active: b, default_model: m }\n')).toEqual([
      'claude.active: "b" is not one of the declared accounts (a)',
    ]);
  });

  it('refuses a repository that is not org/name', () => {
    expect(violations('repos: [{ linear_team: ORC, github: Orchestrator }]\n')).toEqual(['repos[0].github: `<org>/<repo>` expected']);
  });

  it('reads the threshold of the full-read refusal (ORC-279)', () => {
    expect(parseFactoryYml('read_guard: { max_lines: 500 }', ENV).readGuard).toEqual({ maxLines: 500 });
    expect(parseFactoryYml('concurrency: 1', ENV).readGuard).toBeUndefined();
    expect(parseFactoryYml('read_guard: {}', ENV).readGuard).toBeUndefined();
  });

  it('refuses a threshold that is not a positive integer, and an unknown key of read_guard', () => {
    for (const bad of ['0', '-1', '1.5', 'beaucoup']) expect(violations(`read_guard: { max_lines: ${bad} }`).join()).toContain('read_guard.max_lines');
    expect(violations('read_guard: { lines: 500 }')).toContain('read_guard.lines: unknown key');
    expect(violations('read_guard: 500')).toContain('read_guard: an object is expected');
  });

  it('hands the effort and the budgets to the agent steps, nothing without them (ORC-136)', () => {
    expect(stepSettings(undefined)).toEqual({});
    expect(stepSettings({ budgets: { maxTurns: { build: 10 } } })).toEqual({ budgets: { maxTurns: { build: 10 } } });
    const claude = { runtime: 'claude-code' as const, accounts: [], active: 'a', defaultModel: 'm', effort: { default: 'low' as const, perStep: { build: 'high' as const } } };
    expect(stepSettings({ claude })).toEqual({ effort: { default: 'low', perStep: { build: 'high' } } });
  });

  describe('the values of a repository (ORC-211)', () => {
    const env = { ...ENV, ORG_REGISTRY_TOKEN: 'registry-secret-1', API: 'https://api.exemple.com' };

    it('reads its variables, in clear or env:NAME, and its secrets, env:NAME only', () => {
      const c = parseFactoryYml('repos:\n  - linear_team: ORC\n    github: org/app\n    env: { NODE_ENV: test, API_URL: env:API }\n    secrets: { REGISTRY_TOKEN: env:ORG_REGISTRY_TOKEN }\n', env);
      expect(c.repos).toEqual([{ linearTeam: 'ORC', github: 'org/app', env: { NODE_ENV: 'test', API_URL: 'https://api.exemple.com' }, secrets: { REGISTRY_TOKEN: 'registry-secret-1' } }]);
    });

    it('refuses a secret written in the file', () => {
      expect(violations('repos: [{ linear_team: ORC, github: org/app, secrets: { REGISTRY_TOKEN: en-clair-123 } }]\n', env).join()).toContain('repos[0].secrets.REGISTRY_TOKEN');
    });

    it('names the variable that is missing', () => {
      expect(violations('repos: [{ linear_team: ORC, github: org/app, secrets: { REGISTRY_TOKEN: env:NOPE } }]\n', env).join()).toContain('NOPE');
    });

    it('refuses a secret of fewer than 8 characters: sealing it would purge any file that holds those letters', () => {
      expect(violations('repos: [{ linear_team: ORC, github: org/app, secrets: { REGISTRY_TOKEN: env:SHORT } }]\n', { ...env, SHORT: 'abc' }).join()).toContain('repos[0].secrets.REGISTRY_TOKEN');
    });

    it('trims the Claude token, and refuses one a header cannot carry, naming where it came from (ORC-337)', () => {
      expect(claudeToken('  sk-ant-oat01-abc\n', 'X')).toBe('sk-ant-oat01-abc');
      expect(claudeToken('   ', 'X')).toBeUndefined();
      expect(claudeToken(undefined, 'X')).toBeUndefined();
      for (const bad of ['sk-ant\r\nX-Injected: 1', 'a\nb', 'a\u0000b', 'a\u007fb']) expect(() => claudeToken(bad, 'CLAUDE_CODE_OAUTH_TOKEN'), JSON.stringify(bad)).toThrow(/^CLAUDE_CODE_OAUTH_TOKEN: the Claude token holds a character/);
      expect(activeClaudeToken(parseFactoryYml(EXAMPLE, { ...ENV, CLAUDE_TOKEN_1: 'tok-1\n' }))).toBe('tok-1');
    });

    it('gives the token of the active account, none without a claude section', () => {
      expect(activeClaudeToken(parseFactoryYml(EXAMPLE, ENV))).toBe('tok-1');
      expect(activeClaudeToken(parseFactoryYml(EXAMPLE.replace('active: compte-1', 'active: compte-2'), ENV))).toBe('tok-2');
      expect(activeClaudeToken(parseFactoryYml('concurrency: 1\n', ENV))).toBeUndefined();
      expect(activeClaudeToken(undefined)).toBeUndefined();
    });
  });

  it('is optional: no file in the home, no configuration', () => {
    expect(loadFactoryYml(mkdtempSync(join(tmpdir(), 'factory-home-')), ENV)).toBeUndefined();
  });

  it('is read from the home', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    writeFileSync(join(home, 'factory.yml'), 'concurrency: 2\n');
    expect(loadFactoryYml(home, ENV)).toEqual({ concurrency: 2 });
  });
});
