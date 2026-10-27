import { describe, expect, it } from 'vitest';
import { addedDependencies, checkDependencies, manifestKind, normalizePypiName, type AllowList, type ManifestChange } from './deps.js';
import { FakePackageRegistry } from './fake-registry.js';

const pkg = (sections: Record<string, Record<string, string>>): string => JSON.stringify({ name: 'app', version: '1.0.0', ...sections }, null, 2);
const change = (path: string, before: string | null, after: string | null): ManifestChange => ({ path, before, after });

const registry = (): FakePackageRegistry =>
  new FakePackageRegistry({ npm: ['left-pad', 'zod', '@types/node', 'react'], pypi: ['requests', 'typing-extensions', 'django', 'pytest'] });
const allowAll: AllowList = { npm: ['left-pad', 'zod', '@types/node', 'react', 'lodahs'], pypi: ['requests', 'Typing_Extensions', 'django', 'pytest', 'reqeusts'] };

const names = (r: { added: { ecosystem: string; name: string }[] }): string[] => r.added.map((d) => `${d.ecosystem}:${d.name}`);

describe('checkDependencies (factory/dependances)', () => {
  it('blocks an added npm package that is not in the registry', async () => {
    const r = await checkDependencies({
      changes: [change('package.json', pkg({ dependencies: { zod: '^4.0.0' } }), pkg({ dependencies: { zod: '^4.0.0', lodahs: '^1.0.0' } }))],
      registry: registry(),
      allowList: allowAll,
    });
    expect(r.check).toBe('factory/dependances');
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([expect.objectContaining({ reason: 'not_found', ecosystem: 'npm', name: 'lodahs', manifest: 'package.json' })]);
    expect(r.findings[0]!.message).toContain('absent du registre npm');
  });

  it('blocks an added PyPI package that is not in the registry', async () => {
    const r = await checkDependencies({
      changes: [change('requirements.txt', 'django==5.0\n', 'django==5.0\nreqeusts>=2\n')],
      registry: registry(),
      allowList: allowAll,
    });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([expect.objectContaining({ reason: 'not_found', ecosystem: 'pypi', name: 'reqeusts' })]);
  });

  it('blocks an existing package outside the allow-list, npm and PyPI', async () => {
    const r = await checkDependencies({
      changes: [
        change('package.json', pkg({}), pkg({ devDependencies: { react: '^19.0.0' } })),
        change('pyproject.toml', '[project]\nname = "x"\ndependencies = []\n', '[project]\nname = "x"\ndependencies = ["pytest>=8"]\n'),
      ],
      registry: registry(),
      allowList: { npm: ['zod'], pypi: ['requests'] },
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.reason, f.ecosystem, f.name])).toEqual([
      ['not_allowed', 'npm', 'react'],
      ['not_allowed', 'pypi', 'pytest'],
    ]);
    expect(r.findings[0]!.message).toContain('hors de la liste autorisée');
  });

  it('passes an added package that exists and is allowed, npm and PyPI', async () => {
    const reg = registry();
    const r = await checkDependencies({
      changes: [
        change('package.json', pkg({ dependencies: { zod: '^4.0.0' } }), pkg({ dependencies: { zod: '^4.0.0', '@types/node': '^24.0.0' } })),
        change('requirements-dev.txt', null, '# tools\nTyping.Extensions>=4 ; python_version < "3.11"\n'),
      ],
      registry: reg,
      allowList: allowAll,
    });
    expect(r).toEqual({
      check: 'factory/dependances',
      ok: true,
      findings: [],
      added: [
        { ecosystem: 'npm', name: '@types/node', declared: '@types/node', spec: '^24.0.0', source: 'registry', manifest: 'package.json' },
        { ecosystem: 'pypi', name: 'typing-extensions', declared: 'Typing.Extensions', spec: '>=4 ; python_version < "3.11"', source: 'registry', manifest: 'requirements-dev.txt' },
      ],
    });
    expect(reg.lookups).toEqual([{ ecosystem: 'npm', name: '@types/node' }, { ecosystem: 'pypi', name: 'typing-extensions' }]);
  });

  it('blocks every added package when the repository declares no allow-list', async () => {
    const changes = [change('package.json', pkg({}), pkg({ dependencies: { zod: '^4.0.0' } }))];
    for (const allowList of [undefined, { pypi: ['requests'] }]) {
      const r = await checkDependencies({ changes, registry: registry(), allowList });
      expect(r.ok).toBe(false);
      expect(r.findings).toEqual([expect.objectContaining({ reason: 'not_allowed', name: 'zod', message: expect.stringContaining('aucune liste autorisée npm') })]);
    }
    // No addition: nothing to allow, the check passes without a list.
    const none = await checkDependencies({ changes: [change('package.json', pkg({}), pkg({}))], registry: registry() });
    expect(none).toMatchObject({ ok: true, findings: [], added: [] });
  });

  it('blocks with the reason when the registry does not answer, or throws', async () => {
    const reg = registry();
    reg.fail('npm', 'zod', 'connect ECONNREFUSED 127.0.0.1:3128');
    const throwing = { lookup: async (): Promise<never> => Promise.reject(new Error('proxy down')) };
    const changes = [change('package.json', pkg({}), pkg({ dependencies: { zod: '^4.0.0' } }))];
    const r = await checkDependencies({ changes, registry: reg, allowList: allowAll });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([expect.objectContaining({ reason: 'registry_unknown', name: 'zod', message: expect.stringContaining('ECONNREFUSED') })]);
    const t = await checkDependencies({ changes, registry: throwing, allowList: allowAll });
    expect(t.findings).toEqual([expect.objectContaining({ reason: 'registry_unknown', message: expect.stringContaining('proxy down') })]);
  });

  it('reports both reasons for a package missing from the registry and outside the list', async () => {
    const r = await checkDependencies({
      changes: [change('requirements.txt', '', 'flask-utilz\n')],
      registry: registry(),
      allowList: allowAll,
    });
    expect(r.findings.map((f) => f.reason)).toEqual(['not_found', 'not_allowed']);
  });

  it('blocks an unreadable manifest instead of skipping it', async () => {
    const r = await checkDependencies({
      changes: [
        change('package.json', pkg({}), '{ "dependencies": { "zod": '),
        change('pyproject.toml', null, '[project\ndependencies = ["requests"]\n'),
      ],
      registry: registry(),
      allowList: allowAll,
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.reason, f.manifest])).toEqual([
      ['unreadable_manifest', 'package.json'],
      ['unreadable_manifest', 'pyproject.toml'],
    ]);
  });

  it('blocks a git or URL source, lists a local one without blocking', async () => {
    const reg = registry();
    const r = await checkDependencies({
      changes: [
        change(
          'package.json',
          pkg({}),
          pkg({ dependencies: { zod: 'github:colinhacks/zod', 'left-pad': 'git+https://example.test/left-pad.git', shared: 'workspace:*', util: 'file:../util' } }),
        ),
        change('requirements.txt', '', 'requests @ https://example.test/requests-2.0.tar.gz\n-e .\n./libs/core\n'),
      ],
      registry: reg,
      allowList: allowAll,
    });
    expect(r.findings.map((f) => [f.reason, f.name])).toEqual([
      ['non_registry_source', 'zod'],
      ['non_registry_source', 'left-pad'],
      ['non_registry_source', 'requests'],
    ]);
    expect(r.added.filter((d) => d.source === 'local').map((d) => d.declared)).toEqual(['shared', 'util', '.', './libs/core']);
    expect(reg.lookups).toEqual([]);
  });

  it('checks the target of an npm alias', async () => {
    const r = await checkDependencies({
      changes: [change('package.json', pkg({}), pkg({ dependencies: { pad: 'npm:left-pad@^1.3.0', types: 'npm:@types/nodee@1' } }))],
      registry: registry(),
      allowList: allowAll,
    });
    expect(r.added.map((d) => [d.declared, d.name])).toEqual([['pad', 'left-pad'], ['types', '@types/nodee']]);
    expect(r.findings.map((f) => [f.reason, f.name])).toEqual([['not_found', '@types/nodee'], ['not_allowed', '@types/nodee']]);
  });

  it('blocks an invalid npm name without asking the registry', async () => {
    const reg = registry();
    const r = await checkDependencies({ changes: [change('package.json', pkg({}), pkg({ dependencies: { '../../x': '1.0.0' } }))], registry: reg, allowList: allowAll });
    expect(r.findings).toEqual([expect.objectContaining({ reason: 'invalid_name', name: '../../x' })]);
    expect(reg.lookups).toEqual([]);
  });
});

describe('addedDependencies', () => {
  it('ignores removed and unchanged dependencies and version-only bumps', () => {
    const r = addedDependencies([
      change(
        'package.json',
        pkg({ dependencies: { zod: '^3.0.0', react: '^18.0.0' }, devDependencies: { vitest: '^4.0.0' } }),
        pkg({ dependencies: { zod: '^4.0.0' }, peerDependencies: { react: '^19.0.0' } }),
      ),
      change('requirements.txt', 'Django==4.2\nrequests\n', 'django==5.0\n'),
      change('pyproject.toml', '[project]\ndependencies = ["pytest"]\n', null),
    ]);
    expect(r).toEqual({ added: [], unreadable: [] });
  });

  it('reads every dependency section of package.json', () => {
    const r = addedDependencies([
      change('web/package.json', null, pkg({ dependencies: { a: '1' }, devDependencies: { b: '1' }, optionalDependencies: { c: '1' }, peerDependencies: { '@s/d': '1' }, scripts: { e: 'x' } })),
    ]);
    expect(names(r)).toEqual(['npm:a', 'npm:b', 'npm:c', 'npm:@s/d']);
  });

  it('compares across manifests of one ecosystem: a dependency moved between files adds nothing', () => {
    const r = addedDependencies([
      change('requirements.txt', 'requests==2.31\n', ''),
      change('requirements/dev.txt', null, 'Requests==2.32\npytest\n'),
    ]);
    expect(names(r)).toEqual(['pypi:pytest']);
  });

  it('reads PEP 621, PEP 735, uv and Poetry sections of pyproject.toml', () => {
    const toml = `
[project]
name = "svc"
dependencies = [
  "requests[socks]>=2.31",  # http
  'Typing_Extensions; python_version < "3.11"',
]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff"]

[dependency-groups]
lint = ["mypy", { include-group = "dev" }]

[tool.uv]
dev-dependencies = ["coverage"]

[tool.uv.sources]
ruff = { git = "https://github.com/astral-sh/ruff" }

[tool.poetry.dependencies]
python = "^3.11"
Flask = "^3.0"
black = { version = "^24", optional = true }
mylib = { path = "../mylib" }

[tool.poetry.group.test.dependencies]
hypothesis = "*"
`;
    const r = addedDependencies([change('svc/pyproject.toml', null, toml)]);
    expect(r.unreadable).toEqual([]);
    expect(r.added.map((d) => `${d.name}:${d.source}`)).toEqual([
      'requests:registry',
      'typing-extensions:registry',
      'pytest:registry',
      'ruff:remote',
      'mypy:registry',
      'coverage:registry',
      'flask:registry',
      'black:registry',
      'mylib:local',
      'hypothesis:registry',
    ]);
  });

  it('reads requirements options, continuations and comments', () => {
    const text = [
      '--index-url https://pypi.org/simple',
      '-r base.txt',
      '-c constraints.txt',
      'numpy==2.0 \\',
      '    --hash=sha256:abc',
      'pandas>=2  # data',
      '-e git+https://example.test/x.git#egg=X_Lib',
      'git+https://example.test/y.git#egg=y',
      '',
    ].join('\r\n');
    const r = addedDependencies([change('requirements-prod.txt', null, text)]);
    expect(r.added.map((d) => `${d.name}:${d.source}`)).toEqual(['numpy:registry', 'pandas:registry', 'x-lib:remote', 'y:remote']);
  });

  it('reports a manifest unreadable after the change, and treats one unreadable before as empty', () => {
    const r = addedDependencies([
      change('package.json', '{not json', pkg({ dependencies: { zod: '1' } })),
      change('requirements.txt', null, 'this is not a requirement\n'),
      change('src/index.ts', null, 'import x from "y";'),
    ]);
    expect(names(r)).toEqual(['npm:zod']);
    expect(r.unreadable).toEqual([{ manifest: 'requirements.txt', error: expect.stringContaining('ligne 1') }]);
  });
});

describe('manifestKind and names', () => {
  it('recognises the manifests by file name', () => {
    expect(manifestKind('package.json')).toBe('package.json');
    expect(manifestKind('apps\\web\\package.json')).toBe('package.json');
    expect(manifestKind('pyproject.toml')).toBe('pyproject.toml');
    expect(manifestKind('requirements.txt')).toBe('requirements');
    expect(manifestKind('requirements-dev.txt')).toBe('requirements');
    expect(manifestKind('requirements/test.txt')).toBe('requirements');
    expect(manifestKind('package-lock.json')).toBeUndefined();
    expect(manifestKind('uv.lock')).toBeUndefined();
    expect(manifestKind('docs/notes.txt')).toBeUndefined();
  });

  it('normalises PyPI names (PEP 503)', () => {
    expect(normalizePypiName('Typing_Extensions')).toBe('typing-extensions');
    expect(normalizePypiName('zope.interface')).toBe('zope-interface');
    expect(normalizePypiName('A--B__C..d')).toBe('a-b-c-d');
  });
});
