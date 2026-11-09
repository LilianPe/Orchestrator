/**
 * Package registries the dependency check asks whether a package exists. It is the check's own
 * dependency, reached from the verification side, not one of the engine's ports.
 */
export type Ecosystem = 'npm' | 'pypi';

/** `unknown`: the registry did not give an answer (network, timeout, unexpected status). */
export type RegistryLookup = { status: 'found' } | { status: 'missing' } | { status: 'unknown'; reason: string };

export interface PackageRegistry {
  /** `name` is the registry name: npm as written (scope included), PyPI normalised (PEP 503). */
  lookup(ecosystem: Ecosystem, name: string): Promise<RegistryLookup>;
}

/** The registries opened for the check `id` and closed after it, by the daemon through the egress proxy (ORC-371). */
export type RegistryOpener = (id: string) => Promise<{ registry: PackageRegistry; close: () => Promise<void> }>;

export interface HttpPackageRegistryOptions {
  /** Injected so the egress proxy (ORC-213) can carry the requests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Default `https://registry.npmjs.org`. */
  npmBaseUrl?: string;
  /** Default `https://pypi.org`; the JSON API is read at `<base>/pypi/<name>/json`. */
  pypiBaseUrl?: string;
  /** Per request, default 10 s. */
  timeoutMs?: number;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** `@scope/name` is one path segment for the npm registry: the slash is encoded. */
const npmPath = (name: string): string =>
  name.startsWith('@') ? `@${encodeURIComponent(name.slice(1)).replace(/%2F/, '%2f')}` : encodeURIComponent(name);

/** Public npm registry and PyPI JSON API. 404 is `missing`; any other non-200 or a network error is `unknown`. */
export class HttpPackageRegistry implements PackageRegistry {
  private readonly fetch: typeof fetch;
  private readonly npmBaseUrl: string;
  private readonly pypiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpPackageRegistryOptions = {}) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.npmBaseUrl = trimSlash(opts.npmBaseUrl ?? 'https://registry.npmjs.org');
    this.pypiBaseUrl = trimSlash(opts.pypiBaseUrl ?? 'https://pypi.org');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  url(ecosystem: Ecosystem, name: string): string {
    return ecosystem === 'npm'
      ? `${this.npmBaseUrl}/${npmPath(name)}`
      : `${this.pypiBaseUrl}/pypi/${encodeURIComponent(name)}/json`;
  }

  async lookup(ecosystem: Ecosystem, name: string): Promise<RegistryLookup> {
    const url = this.url(ecosystem, name);
    let res: Response;
    try {
      res = await this.fetch(url, {
        // npm: the abbreviated document is enough to see the published versions.
        headers: { accept: ecosystem === 'npm' ? 'application/vnd.npm.install-v1+json' : 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { status: 'unknown', reason: `${url}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.status !== 200) {
      // Free the connection: the body of an error is not read.
      await res.body?.cancel().catch(() => undefined);
      return res.status === 404 ? { status: 'missing' } : { status: 'unknown', reason: `${url}: HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { status: 'unknown', reason: `${url}: response is not JSON` };
    }
    // An npm package whose versions were all unpublished keeps a document with no version.
    if (ecosystem === 'npm') {
      const versions = (body as { versions?: unknown } | null)?.versions;
      if (typeof versions !== 'object' || versions === null || Object.keys(versions).length === 0) return { status: 'missing' };
    }
    return { status: 'found' };
  }
}
