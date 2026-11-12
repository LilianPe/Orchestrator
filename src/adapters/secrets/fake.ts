import type { SecretSource, SecretSourceKind } from './types.js';

/** The harness's secret manager (ORC-308): a table of values, out of service on demand. */
export class FakeSecretSource implements SecretSource {
  readonly reads: string[] = [];

  constructor(
    private readonly values: Record<string, string>,
    private readonly o: { down?: boolean } = {},
  ) {}

  async read(path: string): Promise<string> {
    this.reads.push(path);
    if (this.o.down) throw new Error('the secret manager does not answer');
    const value = this.values[path];
    if (value === undefined) throw new Error(`no secret at ${path}`);
    return value;
  }
}

/** A kind whose declarations name one of `sources` (`{ kind: fake, name }`); its paths are `<path>#<key>`. */
export function fakeSecretKind(sources: Record<string, SecretSource>): SecretSourceKind {
  return {
    checkPath: (path) => (/^[^#]+#[^#]+$/.test(path) ? undefined : `"${path}" is not \`<path>#<key>\``),
    checkOptions: (options) => [...(typeof options['name'] === 'string' ? [] : ['name: required']), ...Object.keys(options).filter((k) => k !== 'name').map((k) => `${k}: unknown key`)],
    create: (options) => {
      const source = sources[options['name'] as string];
      if (!source) throw new Error(`no fake secret source named ${String(options['name'])}`);
      return source;
    },
  };
}
