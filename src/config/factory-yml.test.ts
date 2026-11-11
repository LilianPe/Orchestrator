import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeClaudeToken, claudeAccountReader, claudeToken, disabledControls, FactoryYmlError, loadFactoryLimits, loadFactoryYml, parseFactoryYml, stepSettings, ticketCapOf } from './factory-yml.js';

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

  it('reads the definition of a serious defect the audit sheets count by, none by default (ORC-229)', () => {
    expect(parseFactoryYml('audit: { serious_defect: "Breaks a user flow or loses data" }', ENV).audit).toEqual({ seriousDefect: 'Breaks a user flow or loses data' });
    expect(parseFactoryYml('concurrency: 1', ENV).audit).toBeUndefined();
    expect(parseFactoryYml('audit: {}', ENV).audit).toBeUndefined();
  });

  it('refuses an empty definition, and an unknown key of audit (ORC-229)', () => {
    for (const bad of ['""', '"   "', '12']) expect(violations(`audit: { serious_defect: ${bad} }`).join()).toContain('audit.serious_defect');
    expect(violations('audit: { definition: x }')).toContain('audit.definition: unknown key');
  });

  it('reads how a human message is acknowledged, a comment by default (ORC-380)', () => {
    expect(parseFactoryYml('acknowledge: reaction', ENV).acknowledge).toBe('reaction');
    expect(parseFactoryYml('acknowledge: comment', ENV).acknowledge).toBe('comment');
    expect(parseFactoryYml('concurrency: 1', ENV).acknowledge).toBeUndefined();
    expect(violations('acknowledge: emoji')).toEqual(['acknowledge: `comment` or `reaction` expected']);
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

  it('gives factory validate its budgets and max_diff alone, the secrets of the file left unresolved (ORC-216, ORC-381)', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    expect(loadFactoryLimits(home)).toEqual({});
    writeFileSync(join(home, 'factory.yml'), 'linear:\n  client_secret: env:NOT_IN_THIS_SHELL\nmax_diff: off\nbudgets:\n  per_ticket_tokens: 1000\n  per_step_tokens: { build: 10 }\n');
    expect(loadFactoryLimits(home)).toEqual({ maxDiff: 'off', budgets: { perTicketTokens: 1000, perStepTokens: { build: 10 } } });
    writeFileSync(join(home, 'factory.yml'), 'budgets:\n  per_ticket_tokens: -1\nmax_diff: { files: 30 }\n');
    // Both faults at once, as the daemon says them.
    expect(() => loadFactoryLimits(home)).toThrow(expect.objectContaining({ violations: [expect.stringContaining('budgets.per_ticket_tokens'), expect.stringContaining('max_diff')] }));
    writeFileSync(join(home, 'factory.yml'), 'linear: {}\n');
    expect(loadFactoryLimits(home)).toEqual({});
  });

  describe('the controls a server disables (ORC-381)', () => {
    const notOff = 'max_diff: only `off` exists here; without it, the baseline (15 files, 400 lines) applies, tightened by each repository';

    it('reads `max_diff: off`, and nothing else for max_diff', () => {
      expect(parseFactoryYml('max_diff: off\n').maxDiff).toBe('off');
      expect(violations('max_diff: { files: 30 }\n')).toEqual([notOff]);
      expect(violations('max_diff: false\n')).toEqual([notOff]);
    });

    it('reads `budgets: off` as every token cap off', () => {
      expect(parseFactoryYml('budgets: off\n').budgets).toEqual({ perStepTokens: 'off', perTicketTokens: 'off' });
      expect(violations('budgets: none\n')).toEqual(['budgets: an object is expected, or `off`']);
    });

    it('reads `off` per cap, the others kept', () => {
      expect(parseFactoryYml('budgets:\n  per_ticket_tokens: off\n  per_step_tokens: { build: 10 }\n  max_turns: { build: 5 }\n').budgets).toEqual({
        perTicketTokens: 'off',
        perStepTokens: { build: 10 },
        maxTurns: { build: 5 },
      });
      expect(parseFactoryYml('budgets:\n  per_step_tokens: off\n').budgets).toEqual({ perStepTokens: 'off' });
      expect(violations('budgets: { max_turns: off }\n')).toEqual(['budgets.max_turns: `step: positive integer` expected']);
    });

    it('names each disabled control, none by default', () => {
      expect(disabledControls(undefined)).toEqual([]);
      expect(disabledControls({ budgets: { perTicketTokens: 10 } })).toEqual([]);
      expect(disabledControls({ maxDiff: 'off', budgets: { perStepTokens: 'off', perTicketTokens: 'off' } })).toEqual(['max_diff', 'budgets.per_step_tokens', 'budgets.per_ticket_tokens']);
      expect(disabledControls({ budgets: { perTicketTokens: 'off' } })).toEqual(['budgets.per_ticket_tokens']);
    });

    it('hands no per-step cap to the agent steps when it is off', () => {
      expect(stepSettings({ budgets: { perStepTokens: 'off', maxTurns: { build: 10 } } })).toEqual({ budgets: { maxTurns: { build: 10 } } });
    });

    it('gives the orchestrator no ticket cap when it is off: no run is stopped for it', () => {
      expect(ticketCapOf({ budgets: { perTicketTokens: 'off' } })).toBeUndefined();
      expect(ticketCapOf({ budgets: { perTicketTokens: 1000 } })).toBe(1000);
      expect(ticketCapOf(undefined)).toBeUndefined();
    });
  });

  describe('the Claude account runs use (ORC-215)', () => {
    const home = () => {
      const h = mkdtempSync(join(tmpdir(), 'factory-home-'));
      writeFileSync(join(h, 'factory.yml'), EXAMPLE);
      return h;
    };

    it('takes a change of `active` at the next read, without a restart', () => {
      const h = home();
      const account = claudeAccountReader(h, ENV);
      expect(account()).toEqual({ name: 'compte-1', token: 'tok-1' });
      writeFileSync(join(h, 'factory.yml'), EXAMPLE.replace('active: compte-1', 'active: compte-2'));
      expect(account()).toEqual({ name: 'compte-2', token: 'tok-2' });
    });

    it("without an active account, the daemon's CLAUDE_CODE_OAUTH_TOKEN, under no name", () => {
      const h = mkdtempSync(join(tmpdir(), 'factory-home-'));
      expect(claudeAccountReader(h, { CLAUDE_CODE_OAUTH_TOKEN: ' tok-d\n' })()).toEqual({ token: 'tok-d' });
      expect(claudeAccountReader(h, {})()).toEqual({});
    });

    it('re-reads the claude section alone: a fault elsewhere in the file does not stop a switch', () => {
      const h = home();
      const account = claudeAccountReader(h, ENV);
      writeFileSync(join(h, 'factory.yml'), EXAMPLE.replace('active: compte-1', 'active: compte-2').replace('concurrency: 1', 'concurrency: -1'));
      expect(account()).toEqual({ name: 'compte-2', token: 'tok-2' });
    });

    it('refuses a faulty file at the first read, as the start does; later, keeps the last account and logs once', () => {
      const h = home();
      const logs: string[] = [];
      const account = claudeAccountReader(h, ENV, (m) => logs.push(m));
      writeFileSync(join(h, 'factory.yml'), EXAMPLE.replace('active: compte-1', 'active: compte-3'));
      expect(account()).toEqual({ name: 'compte-1', token: 'tok-1' });
      expect(account()).toEqual({ name: 'compte-1', token: 'tok-1' });
      expect(logs).toEqual(['Warning: factory.yml: the Claude account is not read again, compte-1 stays active: invalid factory.yml:\n- claude.active: "compte-3" is not one of the declared accounts (compte-1, compte-2)']);
      expect(() => claudeAccountReader(h, ENV)).toThrow(FactoryYmlError);
    });

    it('keeps the last account while the file is gone, as an editor saving it leaves it, and logs it once', () => {
      const h = home();
      const logs: string[] = [];
      const account = claudeAccountReader(h, { ...ENV, CLAUDE_CODE_OAUTH_TOKEN: 'tok-d' }, (m) => logs.push(m));
      rmSync(join(h, 'factory.yml'));
      expect(account()).toEqual({ name: 'compte-1', token: 'tok-1' });
      expect(account()).toEqual({ name: 'compte-1', token: 'tok-1' });
      expect(logs).toEqual(['Warning: factory.yml: the Claude account is not read again, compte-1 stays active: the file is gone']);
      writeFileSync(join(h, 'factory.yml'), EXAMPLE.replace('active: compte-1', 'active: compte-2'));
      expect(account()).toEqual({ name: 'compte-2', token: 'tok-2' });
    });
  });
});
