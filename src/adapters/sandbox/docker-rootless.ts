import { availableParallelism } from 'node:os';
import { basename } from 'node:path';
import type { EgressProxy } from '../../network/proxy.js';
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
  /**
   * The factory's egress proxy (ORC-213): each sandbox gets its run's socket and nothing else. Without
   * it a sandbox reaches nothing, whatever its level.
   */
  egress?: Pick<EgressProxy, 'open' | 'close' | 'isOpen' | 'caCertPath'>;
  /** The daemon's: its containers carry it, and its lookups see only those, so another daemon on the same engine is left alone. */
  instance?: string;
  /** Per container (ORC-218): a fork bomb or a memory hog in one attempt must not starve the others. No swap: a hog is killed, not thrashing the host. */
  limits?: SandboxLimits;
}

/** An undefined limit is left out of `run`: the engine's own (none), for a host whose cgroups lack that controller. */
export interface SandboxLimits {
  pids?: number | undefined;
  /** In the engine's syntax: `4g`, `512m`. */
  memory?: string | undefined;
  cpus?: number | undefined;
}

/** 2 cpus, or fewer on a smaller host: the engine refuses more than it has. */
export function defaultLimits(cpus = availableParallelism()): SandboxLimits {
  return { pids: 512, memory: '4g', cpus: Math.min(2, cpus) };
}

/** By name or path, as the daemon and the isolation tests both tell the engines apart. */
export function isPodman(cli: string): boolean {
  return basename(cli).startsWith('podman');
}

const ATTEMPT = 'factory.attempt';
const NETWORK = 'factory.network';
const INSTANCE = 'factory.instance';

/** Where the run's proxy socket is mounted, and where the relay in front of it listens. */
const EGRESS_SOCKET = '/run/factory/egress.sock';
/** The factory CA's certificate, read-only: the only authority the sandbox's tools trust (the proxy decrypts every tunnel). */
const EGRESS_CA = '/run/factory/egress-ca.crt';
const PROXY = 'http://127.0.0.1:3128';
/** PID 1 of a sandbox with an egress: TCP on the loopback to the proxy's socket, so every tool can use HTTP(S)_PROXY. */
const RELAY = `const net=require('net');net.createServer((c)=>{const u=net.connect('${EGRESS_SOCKET}');c.pipe(u).pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(3128,'127.0.0.1')`;
/**
 * The proxy's address for every tool, and the factory CA as its trust: Node (claude, npm, yarn,
 * factory-agent), OpenSSL (curl, Python), pip, git.
 */
const EGRESS_ENV = [
  ...['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'YARN_HTTP_PROXY', 'YARN_HTTPS_PROXY'].map((k) => `${k}=${PROXY}`),
  'NO_PROXY=localhost,127.0.0.1',
  'no_proxy=localhost,127.0.0.1',
  // Node's own fetch (factory-agent) reads the variables above only with it.
  'NODE_USE_ENV_PROXY=1',
  ...['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'PIP_CERT', 'GIT_SSL_CAINFO', 'npm_config_cafile', 'YARN_CAFILE', 'YARN_HTTPS_CA_FILE_PATH'].map(
    (k) => `${k}=${EGRESS_CA}`,
  ),
  // Its POST would be refused at every install.
  'npm_config_audit=false',
];

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
  /**
   * Ids seen through create, findByAttempt or list, with their run: `spawnCommand` is sync and checks
   * against them (after a restart, list() first), `destroy` closes the run's egress from it.
   */
  private readonly known = new Map<string, string>();

  constructor(private readonly opts: ContainerSandboxOptions) {
    this.run = opts.exec ?? execCmd;
    this.podman = isPodman(opts.cli);
  }

  async create(req: SandboxRequest): Promise<Sandbox> {
    // The router refuses these too, but a backend that accepted them would claim an isolation it does not give.
    const { minLevel, browser, services } = req.requirements;
    if (minLevel !== 'L3') throw new Error(`container sandbox: isolation ${minLevel} not available (L3 only)`);
    if (browser) throw new Error('container sandbox: no browser');
    if (services.length) throw new Error(`container sandbox: no services (${services.join(', ')})`);
    const mounts = [{ host: req.workspacePath, target: WORKSPACE_TARGET, readOnly: false }, ...req.mounts].map(mountArg);

    for (const c of await this.byLabel(`${ATTEMPT}=${req.runId}`)) {
      // Stopped, or from before a restart: its egress socket is gone (the mount holds an unlinked inode).
      if (!this.usable(c)) {
        await this.destroy(c.id);
        continue;
      }
      if (c.network !== req.network) throw new Error(`container sandbox: run ${req.runId} has network ${c.network}, asked ${req.network}`);
      return this.seen(c);
    }
    const egress = this.opts.egress && (await this.opts.egress.open(req.runId, { level: req.network, allow: req.allow ?? [] }));

    const args = [
      'run', '-d',
      '--label', `${ATTEMPT}=${req.runId}`, '--label', `factory.ticket=${req.ticketId}`, '--label', `${NETWORK}=${req.network}`,
      ...(this.opts.instance ? ['--label', `${INSTANCE}=${this.opts.instance}`] : []),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      ...limitArgs(this.opts.limits ?? defaultLimits()),
      // keep-id maps the daemon's uid into the user namespace, so files written in /work are the daemon's on the host.
      ...(this.podman ? ['--userns=keep-id'] : []), '--user', `${this.opts.uid}:${this.opts.gid}`,
      '-e', `HOME=${SANDBOX_HOME}`,
      ...mounts.flatMap((m) => ['--mount', m]),
      ...(egress
        ? [
            '--mount', mountArg({ host: egress, target: EGRESS_SOCKET, readOnly: false }),
            '--mount', mountArg({ host: this.opts.egress!.caCertPath, target: EGRESS_CA, readOnly: true }),
            ...EGRESS_ENV.flatMap((v) => ['-e', v]),
          ]
        : []),
      '--workdir', WORKSPACE_TARGET,
      // Always: no route, no DNS, no UDP. The level is the proxy's to apply (ORC-213).
      '--network', 'none',
      this.opts.image, ...(egress ? ['node', '-e', RELAY] : ['sleep', 'infinity']),
    ];
    let id: string;
    try {
      id = (await this.must(args)).trim();
    } catch (err) {
      await this.opts.egress?.close(req.runId);
      throw err;
    }
    this.known.set(id, req.runId);
    return { id, network: req.network, level: 'L3' };
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
    // A container this provider cannot use is not handed back: the router then asks create(), which replaces it.
    const c = (await this.byLabel(`${ATTEMPT}=${runId}`)).find((x) => this.usable(x));
    return c && this.seen(c);
  }

  /** Stopped containers too: they are still attempts' leftovers for recover() to destroy. */
  async list(): Promise<{ runId: string; sandbox: Sandbox }[]> {
    return (await this.byLabel(ATTEMPT)).map((c) => ({ runId: c.runId, sandbox: this.seen(c) }));
  }

  async destroy(id: string): Promise<void> {
    const runId = this.known.get(id);
    const r = await this.engine(['rm', '-f', id]);
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) throw new Error(`container sandbox: rm ${id}: ${r.stderr.trim()}`);
    this.known.delete(id);
    if (runId) await this.opts.egress?.close(runId);
  }

  private seen(c: Info): Sandbox {
    this.known.set(c.id, c.runId);
    return sandbox(c);
  }

  /** Running, and with its egress listening in this process if it has one. */
  private usable(c: Info): boolean {
    return c.running && (!this.opts.egress || this.opts.egress.isOpen(c.runId));
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

function limitArgs(l: SandboxLimits): string[] {
  return [
    ...(l.pids === undefined ? [] : ['--pids-limit', String(l.pids)]),
    ...(l.memory === undefined ? [] : ['--memory', l.memory, '--memory-swap', l.memory]),
    ...(l.cpus === undefined ? [] : ['--cpus', String(l.cpus)]),
  ];
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
