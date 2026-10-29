import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FactoryYmlError, loadFactoryYml, parseFactoryYml } from './factory-yml.js';

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
    expect(violations(EXAMPLE, env)).toEqual(['linear.webhook_secret : la variable d’environnement LINEAR_WEBHOOK_SECRET n’est pas définie']);
  });

  it('refuses a secret written in the file instead of env:NAME', () => {
    expect(violations('github: { app_id: 42, private_key: "-----BEGIN RSA PRIVATE KEY-----" }\n')).toEqual([
      'github.private_key : un secret s’écrit `env:NOM`, jamais en clair dans factory.yml',
    ]);
  });

  it('refuses an unknown key with its path', () => {
    expect(violations('relay: { kind: smee }\nclaude: { runtime: claude-code, accounts: [{ name: x, token: env:CLAUDE_TOKEN_1 }], active: x, default_model: m, color: red }\n')).toEqual([
      'relay : clé inconnue',
      'claude.color : clé inconnue',
    ]);
  });

  it('refuses an active account that is not declared', () => {
    expect(violations('claude: { runtime: claude-code, accounts: [{ name: a, token: env:CLAUDE_TOKEN_1 }], active: b, default_model: m }\n')).toEqual([
      'claude.active : « b » n’est pas un des comptes déclarés (a)',
    ]);
  });

  it('refuses a repository that is not org/name', () => {
    expect(violations('repos: [{ linear_team: ORC, github: Orchestrator }]\n')).toEqual(['repos[0].github : `<org>/<dépôt>` attendu']);
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
