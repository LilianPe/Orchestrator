import { basename } from 'node:path';
import { execCmd, mustExec, type Exec, type ExecResult } from '../exec.js';
import {
  SANDBOX_HOME,
  WORKSPACE_TARGET,
  type NetworkLevel,
  type Sandbox,
  type SandboxExecOptions,
  type SandboxMount,
  type SandboxProvider,
  type SandboxRequest,
} from './types.js';

export interface ContainerSandboxOptions {
  /** `docker` or `podman`, by name or path: Docker Desktop in WSL is not rootless, the CI and the server run rootless Podman. */
  cli: string;
  image: string;
  exec?: Exec;
  /** The daemon's: the agent's files stay the daemon's, which commits and pushes them after the run. */
  uid: number;
  gid: number;
  /** What `host.docker.internal` resolves to, for the agent API; `host-gateway` does not always reach the daemon under Docker Desktop in WSL. */
  agentHost?: string;
  /** The daemon's: its containers carry it, and its lookups see only those, so another daemon on the same engine is left alone. */
  instance?: string;
}

const ATTEMPT = 'factory.attempt';
const NETWORK = 'factory.network';
const INSTANCE = 'factory.instance';

/** Where the engines listen. A mount of one of them, or of a directory above one, hands the agent the engine, so root on the host. */
const SOCKETS = ['/var/run/docker.sock', '/run/docker.sock', '/var/run/podman/podman.sock', '/run/podman/podman.sock'];

interface Info {
  id: string;
  running: boolean;
  runId: string;
  network: NetworkLevel;
}

/** L3 of the MVP doc: one container per attempt, driven by the engine's CLI. */
export class ContainerSandboxProvider implements SandboxProvider {
  private readonly run: Exec;
  private readonly podman: boolean;
  /** Ids seen through create, findByAttempt or list: `spawnCommand` is sync and checks against them (after a restart, list() first). */
  private readonly known = new Set<string>();

  constructor(private readonly opts: ContainerSandboxOptions) {
    this.run = opts.exec ?? execCmd;
    this.podman = basename(opts.cli).startsWith('podman');
  }

  async create(req: SandboxRequest): Promise<Sandbox> {
    // The router refuses these too, but a backend that accepted them would claim an isolation it does not give.
    const { minLevel, browser, services } = req.requirements;
    if (minLevel !== 'L3') throw new Error(`container sandbox: isolation ${minLevel} not available (L3 only)`);
    if (browser) throw new Error('container sandbox: no browser');
    if (services.length) throw new Error(`container sandbox: no services (${services.join(', ')})`);
    const mounts = [{ host: req.workspacePath, target: WORKSPACE_TARGET, readOnly: false }, ...req.mounts].map(mountArg);

    for (const c of await this.byLabel(`${ATTEMPT}=${req.runId}`)) {
      if (!c.running) {
        await this.destroy(c.id);
        continue;
      }
      if (c.network !== req.network) throw new Error(`container sandbox: run ${req.runId} has network ${c.network}, asked ${req.network}`);
      return this.seen(c);
    }

    const args = [
      'run', '-d',
      '--label', `${ATTEMPT}=${req.runId}`, '--label', `factory.ticket=${req.ticketId}`, '--label', `${NETWORK}=${req.network}`,
      ...(this.opts.instance ? ['--label', `${INSTANCE}=${this.opts.instance}`] : []),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      // keep-id maps the daemon's uid into the user namespace, so files written in /work are the daemon's on the host.
      ...(this.podman ? ['--userns=keep-id'] : []), '--user', `${this.opts.uid}:${this.opts.gid}`,
      '-e', `HOME=${SANDBOX_HOME}`,
      ...mounts.flatMap((m) => ['--mount', m]),
      '--workdir', WORKSPACE_TARGET,
      ...this.networkArgs(req.network),
      this.opts.image, 'sleep', 'infinity',
    ];
    const id = (await this.must(args)).trim();
    this.known.add(id);
    return { id, network: req.network, level: 'L3' };
  }

  /**
   * PROVISIONAL until ORC-213 (egress proxy): every level but `none` gets the engine's default bridge,
   * open to the internet, because `claude -p` must reach the Anthropic API. The level is returned as
   * asked; docs/interface-et-securite.md lists the gap.
   */
  private networkArgs(network: NetworkLevel): string[] {
    if (network === 'none') return ['--network', 'none'];
    // Podman adds host.docker.internal itself, and its `host-gateway` only came in 5.3.
    if (this.podman && !this.opts.agentHost) return [];
    return [`--add-host=host.docker.internal:${this.opts.agentHost ?? 'host-gateway'}`];
  }

  async exec(id: string, argv: readonly string[], opts: SandboxExecOptions = {}): Promise<ExecResult> {
    const [c] = await this.inspect([id]);
    if (!c?.running) throw new Error(`container sandbox: no live container ${id}`);
    // Values go through the environment, not the command line: secrets stay out of the host's process list.
    const r = await this.engine(['exec', ...this.execFlags(opts), id, ...argv], opts.env ? { env: opts.env } : undefined);
    // 125 is the engine failing, not the command (126/127 are the command's own, kept as results).
    if (r.code === 125) throw new Error(`container sandbox: exec in ${id}: ${r.stderr.trim()}`);
    return r;
  }

  /** Sync, so it checks the ids this provider has seen, not the engine: the spawned exec fails on a container that died since. */
  spawnCommand(id: string, argv: readonly string[], opts: SandboxExecOptions = {}): string[] {
    if (!this.known.has(id)) throw new Error(`container sandbox: unknown sandbox ${id}`);
    return [this.opts.cli, ...this.global(), 'exec', '-i', ...this.execFlags(opts), id, ...argv];
  }

  async findByAttempt(runId: string): Promise<Sandbox | undefined> {
    const c = (await this.byLabel(`${ATTEMPT}=${runId}`)).find((x) => x.running);
    return c && this.seen(c);
  }

  /** Stopped containers too: they are still attempts' leftovers for recover() to destroy. */
  async list(): Promise<{ runId: string; sandbox: Sandbox }[]> {
    return (await this.byLabel(ATTEMPT)).map((c) => ({ runId: c.runId, sandbox: this.seen(c) }));
  }

  async destroy(id: string): Promise<void> {
    const r = await this.engine(['rm', '-f', id]);
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) throw new Error(`container sandbox: rm ${id}: ${r.stderr.trim()}`);
    this.known.delete(id);
  }

  private seen(c: Info): Sandbox {
    this.known.add(c.id);
    return sandbox(c);
  }

  private execFlags(opts: SandboxExecOptions): string[] {
    return ['-w', opts.cwd ?? WORKSPACE_TARGET, ...Object.keys(opts.env ?? {}).flatMap((k) => ['-e', k])];
  }

  /** Podman prints its own warnings (cgroup manager fallback...) on stderr, mixed with the command's: errors only. */
  private global(): string[] {
    return this.podman ? ['--log-level=error'] : [];
  }

  private engine(args: string[], opts?: { env?: Record<string, string> }): Promise<ExecResult> {
    return this.run(this.opts.cli, [...this.global(), ...args], opts);
  }

  private must(args: string[]): Promise<string> {
    return mustExec(this.run, this.opts.cli, [...this.global(), ...args]);
  }

  private async byLabel(label: string): Promise<Info[]> {
    const mine = this.opts.instance ? ['--filter', `label=${INSTANCE}=${this.opts.instance}`] : [];
    const ids = (await this.must(['ps', '-a', '-q', '--no-trunc', '--filter', `label=${label}`, ...mine])).split('\n').filter(Boolean);
    return ids.length ? this.inspect(ids) : [];
  }

  /** `inspect` rather than `ps --format`: its labels are a map under both engines. A missing id prints nothing and is skipped. */
  private async inspect(ids: string[]): Promise<Info[]> {
    const format = `{{.Id}}\t{{.State.Running}}\t{{index .Config.Labels "${ATTEMPT}"}}\t{{index .Config.Labels "${NETWORK}"}}`;
    const r = await this.engine(['inspect', '--format', format, ...ids]);
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id = '', running, runId = '', network] = line.split('\t');
        return { id, running: running === 'true', runId, network: network as NetworkLevel };
      });
  }
}

function sandbox(c: Info): Sandbox {
  return { id: c.id, network: c.network, level: 'L3' };
}

function mountArg(m: SandboxMount): string {
  for (const p of [m.host, m.target]) {
    if (/(docker|podman)\.sock/.test(p) || SOCKETS.some((s) => s.startsWith(p.endsWith('/') ? p : `${p}/`))) {
      throw new Error(`container sandbox: refusing to mount ${p}, an engine socket or a directory holding one`);
    }
    // ponytail: refuse what would inject --mount options rather than quote it; no real path has these.
    if (/[,=\n"]/.test(p)) throw new Error(`container sandbox: unsupported character in mount path ${p}`);
  }
  return `type=bind,source=${m.host},target=${m.target}${m.readOnly ? ',readonly' : ''}`;
}
