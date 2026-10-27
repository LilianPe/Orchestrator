import type { Ecosystem, PackageRegistry, RegistryLookup } from './registry.js';

/** In-memory registry for tests: only the declared packages exist; `fail` makes a name unanswerable. */
export class FakePackageRegistry implements PackageRegistry {
  lookups: { ecosystem: Ecosystem; name: string }[] = [];
  private readonly packages: Record<Ecosystem, Set<string>>;
  private readonly failing = new Map<string, string>();

  constructor(packages: { npm?: string[]; pypi?: string[] } = {}) {
    this.packages = { npm: new Set(packages.npm), pypi: new Set(packages.pypi) };
  }

  fail(ecosystem: Ecosystem, name: string, reason = 'registry unreachable'): void {
    this.failing.set(`${ecosystem}:${name}`, reason);
  }

  async lookup(ecosystem: Ecosystem, name: string): Promise<RegistryLookup> {
    this.lookups.push({ ecosystem, name });
    const reason = this.failing.get(`${ecosystem}:${name}`);
    if (reason !== undefined) return { status: 'unknown', reason };
    return { status: this.packages[ecosystem].has(name) ? 'found' : 'missing' };
  }
}
