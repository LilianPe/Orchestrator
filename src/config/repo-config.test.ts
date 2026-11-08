import { describe, expect, it } from 'vitest';
import { compilePreset } from '../presets/preset.js';
import { factoryDefault } from '../presets/factory-default.js';
import { parseRepoConfig, RepoConfigError, repoNetworkCeiling, SOCLE_FORBIDDEN_PATHS } from './repo-config.js';

function violations(yaml: string): string[] {
  try {
    parseRepoConfig(yaml);
    return [];
  } catch (err) {
    if (err instanceof RepoConfigError) return err.violations;
    throw err;
  }
}

const EXAMPLE = `
extends: factory/default@1.0
setup: pnpm install --frozen-lockfile && pnpm db:migrate
commands: { lint: pnpm lint, typecheck: pnpm typecheck, test: pnpm test }
services: [postgres]
sensitive_paths: ["src/auth/**", "src/billing/**", "db/migrations/**"]
budgets: { per_ticket_tokens: 2000000 }
max_diff: { files: 15, lines: 400 }
feature_flags: { provider: openfeature }
visual_paths: ["src/components/**", "app/**"]
network: { level: custom, allow: ["docs.exemple.com"] }
`;

describe('parseRepoConfig (.factory/config.yml, ORC-209)', () => {
  it('reads the example of the MVP doc', () => {
    const c = parseRepoConfig(EXAMPLE);
    expect(c).toMatchObject({
      extends: 'factory/default@1.0',
      setup: 'pnpm install --frozen-lockfile && pnpm db:migrate',
      commands: { lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' },
      services: ['postgres'],
      sensitivePaths: ['src/auth/**', 'src/billing/**', 'db/migrations/**'],
      maxDiff: { files: 15, lines: 400 },
      network: { level: 'custom', allow: ['docs.exemple.com'] },
      visualPaths: ['src/components/**', 'app/**'],
    });
  });

  it('gives the socle when there is no file or an empty one', () => {
    for (const text of [undefined, '', '# rien\n']) {
      expect(parseRepoConfig(text)).toEqual({
        extends: 'factory/default@1.0',
        commands: {},
        env: [],
        setupSecrets: [],
        services: [],
        sensitivePaths: [],
        forbiddenPaths: [...SOCLE_FORBIDDEN_PATHS],
        maxDiff: { files: 15, lines: 400 },
        network: { level: 'limited', allow: [] },
        visualPaths: [],
      });
    }
  });

  describe('the variables a repository declares (ORC-211)', () => {
    it('reads names, never values', () => {
      expect(parseRepoConfig('env: [NODE_ENV]\nsetup_secrets: [REGISTRY_TOKEN]\n')).toMatchObject({ env: ['NODE_ENV'], setupSecrets: ['REGISTRY_TOKEN'] });
      expect(violations('env: { NODE_ENV: test }\n')).toEqual(['env: an array of variable names is expected']);
    });

    it.each(['lower_case', 'WITH-DASH', '1DIGIT', 'A=B'])('refuses %s, which is no variable name', (name) => {
      expect(violations(`env: ["${name}"]\n`).join()).toContain(`env[0]: "${name}"`);
    });

    it.each([
      // What would take the sandbox's egress or trust away from the proxy.
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'NODE_TLS_REJECT_UNAUTHORIZED',
      // What would run code in every process of the sandbox.
      'PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'PYTHONPATH',
      // What would change the agent's identity or where its token goes.
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'FACTORY_API', 'HOME',
      // The factory's and the forge's own: never a repository's to ask for.
      'GH_TOKEN', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'RELAIS_TOKEN', // RELAIS_ : transition, à retirer (ORC-167)
      // The hardening of the setup.
      'NPM_CONFIG_IGNORE_SCRIPTS', 'UV_NO_BUILD', 'YARN_ENABLE_SCRIPTS', 'PIP_ONLY_BINARY',
    ])('refuses to hand the runner %s, in either list', (name) => {
      expect(violations(`env: [${name}]\n`).join()).toContain('reserved');
      expect(violations(`setup_secrets: [${name}]\n`).join()).toContain('reserved');
    });

    it.each(['API_TOKEN', 'STRIPE_SECRET', 'DB_PASSWORD', 'SIGNING_KEY', 'DATABASE_URL'])('refuses %s as a variable of the agent: a secret goes under setup_secrets', (name) => {
      expect(violations(`env: [${name}]\n`).join()).toContain('setup_secrets');
      expect(violations(`setup_secrets: [${name}]\n`)).toEqual([]);
    });

    it('takes the token of a private registry for the setup', () => {
      expect(parseRepoConfig('setup_secrets: [NPM_TOKEN]\n').setupSecrets).toEqual(['NPM_TOKEN']);
    });

    it('refuses a name in both lists: the agent would see what the setup seals', () => {
      expect(violations('env: [SAME]\nsetup_secrets: [SAME]\n').join()).toContain('SAME');
    });
  });

  it('always keeps the forbidden paths of the socle, whatever the file adds', () => {
    expect(parseRepoConfig(EXAMPLE).forbiddenPaths).toEqual(expect.arrayContaining(['.factory/**', '.github/**', 'claims/**']));
  });

  describe('a configuration can only add to the socle, never take from it', () => {
    it('refuses a key that would switch off a control of the socle', () => {
      expect(violations('checks: { disable: ["factory/taille-du-diff"] }\n')).toEqual([
        'checks: unknown key; the repository configuration adds checks or prohibitions, it never removes any from the baseline',
      ]);
    });

    it('refuses a negated path, which would carve a hole in a forbidden or sensitive path', () => {
      expect(violations('sensitive_paths: ["src/**", "!.factory/**"]\n')).toEqual([
        'sensitive_paths[1]: "!.factory/**" would remove a path; paths can only be added',
      ]);
    });

    it('refuses a max_diff wider than the socle', () => {
      expect(violations('max_diff: { files: 20 }\n')).toEqual([
        'max_diff.files = 20 exceeds the baseline 15: the repository configuration can only tighten `max_diff`.',
      ]);
    });

    it('takes a tighter max_diff', () => {
      expect(parseRepoConfig('max_diff: { lines: 200 }\n').maxDiff).toEqual({ files: 15, lines: 200 });
    });

    it('refuses the full network level', () => {
      expect(violations('network: { level: full }\n')).toEqual(['network.level: `full` is reserved for `setup`, never for the agent']);
    });

    it('refuses a host wildcard or a network range, which would be full in disguise', () => {
      expect(violations('network: { level: custom, allow: ["docs.exemple.com", "*", "*.com", "0.0.0.0/0"] }\n')).toEqual([
        'network.allow[1]: "*" is not a host name; wildcards and ranges are refused',
        'network.allow[2]: "*.com" is not a host name; wildcards and ranges are refused',
        'network.allow[3]: "0.0.0.0/0" is not a host name; wildcards and ranges are refused',
      ]);
    });

    it('refuses an allow list under a level other than custom: validated, then ignored, it would mislead', () => {
      expect(violations('network: { level: limited, allow: [docs.exemple.com] }\n')).toEqual(['network.allow: only the `custom` level takes a list of hosts; here `limited`']);
      expect(violations('network: { level: none, allow: [docs.exemple.com] }\n')).toEqual(['network.allow: only the `custom` level takes a list of hosts; here `none`']);
      expect(violations('network: { allow: [docs.exemple.com] }\n')).toEqual(['network.allow: only the `custom` level takes a list of hosts; here `limited`']);
      expect(parseRepoConfig('network: { level: limited, allow: [] }\n').network).toEqual({ level: 'limited', allow: [] });
    });

    it('refuses a negation anywhere in a path, extglob included', () => {
      expect(violations('sensitive_paths: ["src/!(auth)/**"]\n')).toEqual([
        'sensitive_paths[0]: "src/!(auth)/**" would remove a path; paths can only be added',
      ]);
    });

    it('refuses a sensitive path that names nothing in the repository (ORC-338), and keeps every glob that does', () => {
      expect(violations('sensitive_paths: ["/infra/**", "C:/infra", "../x", "a/../../b"]\n')).toEqual([
        'sensitive_paths[0]: "/infra/**": a path from the repository root is expected (no leading `/`, no drive, no `..`)',
        'sensitive_paths[1]: "C:/infra": a path from the repository root is expected (no leading `/`, no drive, no `..`)',
        'sensitive_paths[2]: "../x": a path from the repository root is expected (no leading `/`, no drive, no `..`)',
        'sensitive_paths[3]: "a/../../b": a path from the repository root is expected (no leading `/`, no drive, no `..`)',
      ]);
      expect(violations('sensitive_paths: [".", "./"]\n')).toEqual([
        'sensitive_paths[0]: ".": it names the whole repository, or nothing: name a directory or a file',
        'sensitive_paths[1]: "./": it names the whole repository, or nothing: name a directory or a file',
      ]);
      const globs = ['infra', 'infra/**', 'src/auth*', '**/migrations/**', 'src/**/*.sql', 'a/?.ts', '{db,sql}/**'];
      expect(parseRepoConfig(`sensitive_paths: ${JSON.stringify(globs)}\n`).sensitivePaths).toEqual(globs);
    });

    it('refuses a sensitive_paths that is not a list of paths', () => {
      expect(violations('sensitive_paths: "infra/**"\n')).toEqual(['sensitive_paths: an array of paths is expected']);
      expect(violations('sensitive_paths: [3]\n')).toEqual(['sensitive_paths[0]: a non-empty path is expected']);
    });

    it('refuses a preset other than factory/default', () => {
      expect(violations('extends: factory/fast@1.0\n')).toEqual(['extends: only `factory/default@1.0` exists in the MVP']);
    });
  });

  it('reads an empty value as absent, extends included', () => {
    expect(parseRepoConfig('extends:\nsetup:\n').extends).toBe('factory/default@1.0');
  });

  it('names the element that fails, not only its key', () => {
    expect(violations('sensitive_paths: ["src/**", ""]\ncommands: { test: "" }\n')).toEqual([
      'commands.test: a non-empty command is expected',
      'sensitive_paths[1]: a non-empty path is expected',
    ]);
  });

  it('maps its network level onto the levels of the preset, so the step check keeps working', () => {
    expect(repoNetworkCeiling(parseRepoConfig('network: { level: custom, allow: [docs.exemple.com] }\n'))).toBe('limited');
    expect(repoNetworkCeiling(parseRepoConfig(undefined))).toBe('limited');
    expect(repoNetworkCeiling(parseRepoConfig('network: { level: none }\n'))).toBe('none');
    // A ceiling the preset can be compiled against: build at limited is refused under none.
    expect(() => compilePreset(factoryDefault, { repoNetwork: repoNetworkCeiling(parseRepoConfig('network: { level: none }\n')) })).toThrow(/wider than the repository level none/);
  });

  it('lists every violation with the path of its key', () => {
    expect(violations('network: { level: full }\nmax_diff: { files: 99 }\nservices: postgres\n')).toEqual([
      'services: an array is expected',
      'network.level: `full` is reserved for `setup`, never for the agent',
      'max_diff.files = 99 exceeds the baseline 15: the repository configuration can only tighten `max_diff`.',
    ]);
  });

  it('refuses a file that is not YAML', () => {
    expect(violations('a: [\n')[0]).toMatch(/^unreadable YAML/);
  });
});
