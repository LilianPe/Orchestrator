import { describe, expect, it } from 'vitest';
import { parseRepoConfig, RepoConfigError, SOCLE_FORBIDDEN_PATHS } from './repo-config.js';

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
network: { level: limited, allow: ["docs.exemple.com"] }
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
      network: { level: 'limited', allow: ['docs.exemple.com'] },
      visualPaths: ['src/components/**', 'app/**'],
    });
  });

  it('gives the socle when there is no file or an empty one', () => {
    for (const text of [undefined, '', '# rien\n']) {
      expect(parseRepoConfig(text)).toEqual({
        extends: 'factory/default@1.0',
        commands: {},
        services: [],
        sensitivePaths: [],
        forbiddenPaths: [...SOCLE_FORBIDDEN_PATHS],
        maxDiff: { files: 15, lines: 400 },
        network: { level: 'limited', allow: [] },
        visualPaths: [],
      });
    }
  });

  it('always keeps the forbidden paths of the socle, whatever the file adds', () => {
    expect(parseRepoConfig(EXAMPLE).forbiddenPaths).toEqual(['.factory/**']);
  });

  describe('a configuration can only add to the socle, never take from it', () => {
    it('refuses a key that would switch off a control of the socle', () => {
      expect(violations('checks: { disable: ["factory/taille-du-diff"] }\n')).toEqual([
        'checks : clé inconnue ; la configuration du dépôt ajoute des contrôles ou des interdits, elle n’en retire jamais au socle',
      ]);
    });

    it('refuses a negated path, which would carve a hole in a forbidden or sensitive path', () => {
      expect(violations('sensitive_paths: ["src/**", "!.factory/**"]\n')).toEqual([
        'sensitive_paths[1] : « !.factory/** » retirerait un chemin ; on ne peut qu’en ajouter',
      ]);
    });

    it('refuses a max_diff wider than the socle', () => {
      expect(violations('max_diff: { files: 20 }\n')).toEqual([
        'max_diff : max_diff.files = 20 dépasse le socle 15 : la configuration du dépôt ne peut que resserrer `max_diff`.',
      ]);
    });

    it('takes a tighter max_diff', () => {
      expect(parseRepoConfig('max_diff: { lines: 200 }\n').maxDiff).toEqual({ files: 15, lines: 200 });
    });

    it('refuses the full network level', () => {
      expect(violations('network: { level: full }\n')).toEqual(['network.level : `full` est réservé à `setup`, jamais pour l’agent']);
    });

    it('refuses a preset other than factory/default', () => {
      expect(violations('extends: factory/fast@1.0\n')).toEqual(['extends : seul `factory/default@1.0` existe au MVP']);
    });
  });

  it('lists every violation with the path of its key', () => {
    expect(violations('network: { level: full }\nmax_diff: { files: 99 }\nservices: postgres\n')).toEqual([
      'services : un tableau est attendu',
      'network.level : `full` est réservé à `setup`, jamais pour l’agent',
      'max_diff : max_diff.files = 99 dépasse le socle 15 : la configuration du dépôt ne peut que resserrer `max_diff`.',
    ]);
  });

  it('refuses a file that is not YAML', () => {
    expect(violations('a: [\n')[0]).toMatch(/^YAML illisible/);
  });
});
