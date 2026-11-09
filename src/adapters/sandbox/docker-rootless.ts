import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { basename, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EgressProxy } from '../../network/proxy.js';
import { execCmd, execFailure, mustExec, type Exec, type ExecResult } from '../exec.js';
import {
  SANDBOX_HOME,
  WORKSPACE_TARGET,
  type NetworkLevel,
  type Sandbox,
  type SandboxExecOptions,
  type SandboxMount,
  type SandboxProvider,
  type SandboxRequest,
  type SpawnCommand,
} from './types.js';

export interface ContainerSandboxOptions {
  /**
   * `docker` or `podman`, by name or path: Docker Desktop in WSL is not rootless, the CI and the server run rootless Podman.
   * Which one it is, the CLI says itself (`podmanCli`): a `docker` that is Podman's (podman-docker) takes Podman's flags.
   */
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
  /** The image of an attempt's Postgres (ORC-309); `POSTGRES_IMAGE` by default. */
  postgresImage?: string;
  /** How long a new service may take to accept connections; 60 s by default. */
  serviceReadyMs?: number;
}

/** Fully qualified: rootless Podman resolves no short name without a registries config. */
export const POSTGRES_IMAGE = 'docker.io/library/postgres:16-bookworm';
/** The services the container backend starts next to an attempt (ORC-309). */
export const CONTAINER_SERVICES: readonly string[] = ['postgres'];

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

/**
 * Whether `cli` is Podman's, by what it reports of itself, never its name (ORC-348): `version`'s client in JSON, whose
 * `OsArch` only Podman's has (Docker's has `Os` and `Arch`). Docker prints its client and exits 1 when its daemon does not
 * answer: the client is read all the same. An answer that is no client throws.
 */
export async function podmanCli(exec: Exec, cli: string): Promise<boolean> {
  const args = ['version', '--format', '{{json .Client}}'];
  const r = await exec(cli, args);
  let client: unknown;
  try {
    client = JSON.parse(r.stdout);
  } catch {
    // Said below.
  }
  if (typeof client !== 'object' || client === null) throw execFailure(cli, args, r);
  return 'OsArch' in client;
}

const ATTEMPT = 'factory.attempt';
const NETWORK = 'factory.network';
const INSTANCE = 'factory.instance';
/** On a service's container (ORC-309): the key of the sandboxes it serves, `servicesOf` of their requests. */
const SERVICES = 'factory.services';

/** The role and database of `DATABASE_URL`. */
const PG_USER = 'factory';

/**
 * In a tmpfs, gone with the container: a subdir, since initdb wants a data dir of its own. Mounted over the image's
 * volume, so the engine makes no anonymous volume there (`rm -v` would remove one all the same).
 */
const PG_DATA = '/var/lib/postgresql/data';
const PG_READY_POLL_MS = 250;
/** In the service's environment: the password of `DATABASE_URL`'s role, read back when another sandbox joins it. */
const PG_PASSWORD = 'FACTORY_DB_PASSWORD';
/** `DATABASE_URL`'s role, by the superuser on the service's socket: owner of the database and its schema, no superuser. */
const PG_ROLE = [
  'psql -v ON_ERROR_STOP=1 --quiet --username=postgres',
  `--dbname=${PG_USER}`,
  `-c "CREATE ROLE ${PG_USER} LOGIN PASSWORD '$${PG_PASSWORD}'"`,
  `-c "ALTER DATABASE ${PG_USER} OWNER TO ${PG_USER}"`,
  `-c "ALTER SCHEMA public OWNER TO ${PG_USER}"`,
].join(' ');
/** What reaches an attempt's Postgres from its sandboxes, which share its loopback (ORC-309). */
const databaseUrl = (password: string) => `postgres://${PG_USER}:${password}@127.0.0.1:5432/${PG_USER}`;

/**
 * Where the run's own dir of the proxy is mounted, read-only: a dir, not its socket, so that a daemon started
 * after a kill -9 binds the socket anew and the living container sees it (ORC-220). A socket opens on a read-only mount.
 */
const EGRESS_DIR = '/run/factory/egress';
/** The factory CA's certificate, read-only: the only authority the sandbox's tools trust (the proxy decrypts every tunnel). */
const EGRESS_CA = '/run/factory/egress-ca.crt';
const PROXY = 'http://127.0.0.1:3128';
/** PID 1 of a sandbox with an egress: TCP on the loopback to the proxy's socket, so every tool can use HTTP(S)_PROXY. */
const relay = (socket: string) => `const net=require('net');net.createServer((c)=>{const u=net.connect('${socket}');c.pipe(u).pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(3128,'127.0.0.1')`;
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
  ...['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'PIP_CERT', 'GIT_SSL_CAINFO', 'npm_config_cafile', 'YARN_HTTPS_CA_FILE_PATH'].map(
    (k) => `${k}=${EGRESS_CA}`,
  ),
  // Its POST would be refused at every install.
  'npm_config_audit=false',
  // Corepack fetches Yarn ≥ 2 from repo.yarnpkg.com, off the lists: the npm registry serves the same package (ORC-219).
  'COREPACK_NPM_REGISTRY=https://registry.npmjs.org',
];

/** Where the engines listen. A mount of one of them, or of a directory above one, hands the agent the engine, so root on the host. */
const SOCKETS = ['/var/run/docker.sock', '/run/docker.sock', '/var/run/podman/podman.sock', '/run/podman/podman.sock'];

/**
 * Where a variable of the container travels in the engine CLI's environment. Under its own name it would
 * also be read by the CLI: rootless Podman takes its storage and its runtime dir from `HOME`, `XDG_*` and
 * `TMPDIR`, its target from `CONTAINER_HOST` (measured on 5.8), Docker its daemon from `DOCKER_HOST`, and the
 * list has no end. The value stays out of the command line, which the host's process list shows.
 */
const CARRIER = 'FACTORY_SANDBOX_ENV_';
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `argv` under `env` in the container, for an `exec`: the `-e` flags, the command, and what the CLI must have
 * in its environment. A small `sh` gives each value its name back, unsets the carriers and becomes the command.
 */
function carried(argv: readonly string[], env: Record<string, string> = {}): { flags: string[]; command: string[]; carriers: Record<string, string> } {
  const names = Object.keys(env);
  if (!names.length) return { flags: [], command: [...argv], carriers: {} };
  // Written in the shell of the container: only a variable's name may reach it.
  for (const name of names) if (!VARIABLE.test(name)) throw new Error(`container sandbox: "${name}" is not a variable name`);
  const carrier = (i: number) => `${CARRIER}${i}`;
  const script = `export ${names.map((name, i) => `${name}="$${carrier(i)}"`).join(' ')}; unset ${names.map((_, i) => carrier(i)).join(' ')}; exec "$@"`;
  return {
    flags: names.flatMap((_, i) => ['-e', carrier(i)]),
    command: ['sh', '-c', script, 'sh', ...argv],
    carriers: Object.fromEntries(names.map((name, i) => [carrier(i), env[name]!])),
  };
}

interface Info {
  id: string;
  running: boolean;
  runId: string;
  network: NetworkLevel;
  /** On the loopback of services (ORC-309): `--network container:<id>`. */
  joined: boolean;
}

/** An attempt's Postgres (ORC-309): its container, the password of `DATABASE_URL`, and whether this call started it. */
interface Service {
  id: string;
  password: string;
  started: boolean;
}

/** L3 of the MVP doc: one container per attempt, driven by the engine's CLI. */
export class ContainerSandboxProvider implements SandboxProvider {
  private readonly run: Exec;
  /** Asked of the CLI before its first command, then kept: `spawnCommand`, sync, only comes after one (`known`). */
  private podman = false;
  private engineKind: Promise<void> | undefined;
  /**
   * Ids seen through create, findByAttempt or list, with their run: `spawnCommand` is sync and checks
   * against them (after a restart, list() first), `destroy` closes the run's egress from it, and looks for
   * the services it owns only if it joined some.
   */
  private readonly known = new Map<string, { runId: string; joined: boolean }>();

  constructor(private readonly opts: ContainerSandboxOptions) {
    this.run = opts.exec ?? execCmd;
  }

  /** Once, or again after a failure: a CLI not yet installed or not answering is asked again at the next command. */
  private kind(): Promise<void> {
    return (this.engineKind ??= podmanCli(this.run, this.opts.cli).then(
      (podman) => {
        this.podman = podman;
      },
      (err: unknown) => {
        this.engineKind = undefined;
        throw err;
      },
    ));
  }

  unprovided(services: readonly string[]): string[] {
    return services.filter((s) => !CONTAINER_SERVICES.includes(s));
  }

  async create(req: SandboxRequest): Promise<Sandbox> {
    // The router refuses these too, but a backend that accepted them would claim an isolation it does not give.
    const { minLevel, browser, services } = req.requirements;
    if (minLevel !== 'L3') throw new Error(`container sandbox: isolation ${minLevel} not available (L3 only)`);
    if (browser) throw new Error('container sandbox: no browser');
    const unknown = this.unprovided(services);
    if (unknown.length) throw new Error(`container sandbox: no services (${unknown.join(', ')})`);
    const mounts = [{ host: req.workspacePath, target: WORKSPACE_TARGET, readOnly: false }, ...req.mounts].map(mountArg);
    const key = req.servicesOf ?? req.runId;

    for (const c of await this.byLabel(`${ATTEMPT}=${req.runId}`)) {
      // Stopped, or from before a restart: its egress socket is gone (the mount holds an unlinked inode).
      if (!this.usable(c)) {
        await this.destroy(c.id);
        continue;
      }
      if (c.network !== req.network) throw new Error(`container sandbox: run ${req.runId} has network ${c.network}, asked ${req.network}`);
      return withServices(this.seen(c), services.length ? await this.service(req, key) : undefined);
    }
    let service: Service | undefined;
    let egress: string | undefined;
    try {
      if (services.length) service = await this.service(req, key);
      egress = this.opts.egress && (await this.opts.egress.open(req.runId, { level: req.network, allow: req.allow ?? [] }));
      const id = await this.start(this.runArgs(req, mounts, egress, service?.id), service ? { DATABASE_URL: databaseUrl(service.password) } : {});
      this.known.set(id, { runId: req.runId, joined: !!service });
      return withServices({ id, network: req.network, level: 'L3' }, service);
    } catch (err) {
      // No socket left listening for nothing.
      if (egress !== undefined) await this.opts.egress?.close(req.runId);
      // Their owner never started, or a `setup` that would have filled them did not: nobody follows, nothing else would destroy them before a restart.
      if (services.length && (key === req.runId || service?.started)) await this.destroyServices(key);
      throw err;
    }
  }

  /**
   * The services of `req.servicesOf` (ORC-309): the running one, or a new one. Postgres, as its image's user, without
   * capabilities, under the attempt's limits, in a network of its own without route (`none`), its data in a tmpfs: the
   * sandboxes join its loopback, so only they reach it. Its passwords, new for it, and `DATABASE_URL` go through the
   * engine CLI's environment (`start`), never its command line. Password auth on TCP (initdb would trust the loopback), trust on its own socket,
   * which no sandbox mounts: the factory's `pg_dumpall` goes through it. `DATABASE_URL`'s role owns the database but is no
   * superuser: a superuser runs programs in the service's container (`COPY … TO PROGRAM`), where a process started by
   * the `setup` would outlive its container, its secrets with it, on the agent's loopback.
   */
  private async service(req: SandboxRequest, key: string): Promise<Service> {
    const [found] = await this.ids(`${SERVICES}=${key}`);
    if (found) {
      const [running, ...env] = (await this.engine(['inspect', '--format', '{{.State.Running}}{{range .Config.Env}}\t{{.}}{{end}}', found])).stdout.trim().split('\t');
      const password = env.find((e) => e.startsWith(`${PG_PASSWORD}=`))?.slice(PG_PASSWORD.length + 1);
      // Never a new one in its place: its sandboxes would find an empty database where the setup filled one.
      if (running !== 'true' || !password) throw new Error(`container sandbox: the services of ${key} are no longer running`);
      return { id: found, password, started: false };
    }
    const password = randomBytes(24).toString('hex');
    // The superuser's, which nobody is given: its own socket is how the factory gets in.
    const secrets = { POSTGRES_PASSWORD: randomBytes(24).toString('hex'), [PG_PASSWORD]: password };
    const id = await this.start(
      [
        'run', '-d',
        '--label', `${SERVICES}=${key}`, '--label', `factory.ticket=${req.ticketId}`,
        ...(this.opts.instance ? ['--label', `${INSTANCE}=${this.opts.instance}`] : []),
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        ...limitArgs(this.opts.limits ?? defaultLimits()),
        '--user', 'postgres',
        '--mount', `type=tmpfs,target=${PG_DATA},tmpfs-mode=1777`,
        '-e', `POSTGRES_DB=${PG_USER}`, '-e', `PGDATA=${PG_DATA}/pgdata`, '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust',
        ...Object.keys(secrets).flatMap((k) => ['-e', k]),
        '--network', 'none',
        this.opts.postgresImage ?? POSTGRES_IMAGE,
      ],
      secrets,
    );
    try {
      await this.ready(id);
      // The password from the container's own environment, by its own shell: never on a command line of the host.
      const role = await this.engine(['exec', id, 'sh', '-c', PG_ROLE]);
      if (role.code !== 0) throw new Error(`container sandbox: postgres role not made in ${id}: ${role.stderr.trim()}`);
    } catch (err) {
      await this.remove(id);
      throw err;
    }
    return { id, password, started: true };
  }

  /** Until it accepts connections on the loopback its sandboxes reach it by: the entrypoint's first server listens on its socket only. */
  private async ready(id: string): Promise<void> {
    const until = Date.now() + (this.opts.serviceReadyMs ?? 60_000);
    for (;;) {
      const r = await this.engine(['exec', id, 'pg_isready', '--quiet', '--host=127.0.0.1', `--dbname=${PG_USER}`]);
      if (r.code === 0) return;
      if (Date.now() >= until) throw new Error(`container sandbox: postgres not ready in ${id}: ${r.stderr.trim() || `exit ${r.code}`}`);
      await sleep(PG_READY_POLL_MS);
    }
  }

  private async destroyServices(key: string): Promise<void> {
    for (const id of await this.ids(`${SERVICES}=${key}`)) await this.remove(id);
  }

  /**
   * `-v`: an anonymous volume of the image goes with its container. `--depend`: Podman refuses to remove a service a
   * container still joins (a `setup` left by a crash, which `recover()` destroys at the same time); Docker removes it.
   */
  private async remove(id: string): Promise<void> {
    // Its flags depend on the engine: asked first, perhaps the provider's first command.
    await this.kind();
    const r = await this.engine(['rm', '-f', '-v', ...(this.podman ? ['--depend'] : []), id]);
    if (r.code !== 0 && !/no such container|already in progress/i.test(r.stderr)) throw new Error(`container sandbox: rm ${id}: ${r.stderr.trim()}`);
  }

  /**
   * `docker run` with `env` read by the engine CLI from its own environment (`-e NAME`, no value): never on the command
   * line, which the host's process list shows. Its names are no variable of the engines' (`CARRIER`).
   */
  private async start(args: string[], env: Record<string, string>): Promise<string> {
    const r = await this.engine(args, Object.keys(env).length ? { env } : undefined);
    if (r.code !== 0) throw new Error(`container sandbox: run: ${r.stderr.trim()}`);
    return r.stdout.trim();
  }

  private runArgs(req: SandboxRequest, mounts: string[], egress: string | undefined, service?: string): string[] {
    return [
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
            '--mount', mountArg({ host: dirname(egress), target: EGRESS_DIR, readOnly: true }),
            '--mount', mountArg({ host: this.opts.egress!.caCertPath, target: EGRESS_CA, readOnly: true }),
            ...EGRESS_ENV.flatMap((v) => ['-e', v]),
          ]
        : []),
      ...(service ? ['-e', 'DATABASE_URL'] : []),
      '--workdir', WORKSPACE_TARGET,
      // Always: no route, no DNS, no UDP. The level is the proxy's to apply (ORC-213). With services, their loopback (ORC-309), which has none either.
      '--network', service ? `container:${service}` : 'none',
      this.opts.image, ...(egress ? ['node', '-e', relay(`${EGRESS_DIR}/${basename(egress)}`)] : ['sleep', 'infinity']),
    ];
  }

  async exec(id: string, argv: readonly string[], opts: SandboxExecOptions = {}): Promise<ExecResult> {
    const [c] = await this.inspect([id]);
    if (!c?.running) throw new Error(`container sandbox: no live container ${id}`);
    const { flags, command, carriers } = carried(argv, opts.env);
    const r = await this.engine(['exec', '-w', opts.cwd ?? WORKSPACE_TARGET, ...flags, id, ...command], flags.length ? { env: carriers } : undefined);
    // 125 is the engine failing, not the command (126/127 are the command's own, kept as results).
    if (r.code === 125) throw new Error(`container sandbox: exec in ${id}: ${r.stderr.trim()}`);
    return r;
  }

  /** Sync, so it checks the ids this provider has seen, not the engine: the spawned exec fails on a container that died since. */
  spawnCommand(id: string, argv: readonly string[], opts: SandboxExecOptions = {}): SpawnCommand {
    if (!this.known.has(id)) throw new Error(`container sandbox: unknown sandbox ${id}`);
    const { flags, command, carriers } = carried(argv, opts.env);
    return { command: [this.opts.cli, ...this.global(), 'exec', '-i', '-w', opts.cwd ?? WORKSPACE_TARGET, ...flags, id, ...command], env: carriers };
  }

  async findByAttempt(runId: string): Promise<Sandbox | undefined> {
    // A container this provider cannot use is not handed back: the router then asks create(), which replaces it.
    const c = (await this.byLabel(`${ATTEMPT}=${runId}`)).find((x) => this.usable(x));
    return c && this.seen(c);
  }

  /**
   * Its egress listens again at the same path, at the level on the container's label. `allow` is not kept:
   * a `custom` repository's run taken back loses its hosts, which only narrows.
   */
  async reattach(runId: string): Promise<Sandbox | undefined> {
    const c = (await this.byLabel(`${ATTEMPT}=${runId}`)).find((x) => x.running);
    if (!c) return undefined;
    if (this.opts.egress && !this.opts.egress.isOpen(runId)) await this.opts.egress.open(runId, { level: c.network, allow: [] });
    return this.seen(c);
  }

  /** Stopped containers too: they are still attempts' leftovers for recover() to destroy. Services (ORC-309) under the key they serve. */
  async list(): Promise<{ runId: string; sandbox: Sandbox }[]> {
    const sandboxes = (await this.byLabel(ATTEMPT)).map((c) => ({ runId: c.runId, sandbox: this.seen(c) }));
    const ids = await this.ids(SERVICES);
    if (!ids.length) return sandboxes;
    // As `inspect` below: one removed since the `ps` prints nothing, the others still do.
    const services = (await this.engine(['inspect', '--format', `{{.Id}}\t{{index .Config.Labels "${SERVICES}"}}`, ...ids])).stdout.split('\n').filter(Boolean).map((line) => {
      const [id = '', runId = ''] = line.split('\t');
      return { runId, sandbox: { id, network: 'none', level: 'L3' } satisfies Sandbox };
    });
    return [...sandboxes, ...services];
  }

  /** The sandbox that owns services, whose `runId` is their key, takes them with it (ORC-309). */
  async destroy(id: string): Promise<void> {
    const known = this.known.get(id);
    await this.remove(id);
    this.known.delete(id);
    if (!known) return;
    try {
      if (known.joined) await this.destroyServices(known.runId);
    } finally {
      await this.opts.egress?.close(known.runId);
    }
  }

  private seen(c: Info): Sandbox {
    this.known.set(c.id, { runId: c.runId, joined: c.joined });
    return sandbox(c);
  }

  /** Running, and with its egress listening in this process if it has one. */
  private usable(c: Info): boolean {
    return c.running && (!this.opts.egress || this.opts.egress.isOpen(c.runId));
  }

  /** Podman prints its own warnings (cgroup manager fallback...) on stderr, mixed with the command's: errors only. */
  private global(): string[] {
    return this.podman ? ['--log-level=error'] : [];
  }

  private async engine(args: string[], opts?: { env?: Record<string, string> }): Promise<ExecResult> {
    await this.kind();
    return this.run(this.opts.cli, [...this.global(), ...args], opts);
  }

  private async must(args: string[]): Promise<string> {
    await this.kind();
    return mustExec(this.run, this.opts.cli, [...this.global(), ...args]);
  }

  private async byLabel(label: string): Promise<Info[]> {
    const ids = await this.ids(label);
    return ids.length ? this.inspect(ids) : [];
  }

  /** This daemon's containers that carry `label`, stopped ones included. */
  private async ids(label: string): Promise<string[]> {
    const mine = this.opts.instance ? ['--filter', `label=${INSTANCE}=${this.opts.instance}`] : [];
    return (await this.must(['ps', '-a', '-q', '--no-trunc', '--filter', `label=${label}`, ...mine])).split('\n').filter(Boolean);
  }

  /** `inspect` rather than `ps --format`: its labels are a map under both engines. A missing id prints nothing and is skipped. */
  private async inspect(ids: string[]): Promise<Info[]> {
    const format = `{{.Id}}\t{{.State.Running}}\t{{index .Config.Labels "${ATTEMPT}"}}\t{{index .Config.Labels "${NETWORK}"}}\t{{.HostConfig.NetworkMode}}`;
    const r = await this.engine(['inspect', '--format', format, ...ids]);
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id = '', running, runId = '', network, mode = ''] = line.split('\t');
        return { id, running: running === 'true', runId, network: network as NetworkLevel, joined: mode.startsWith('container:') };
      });
  }
}

function sandbox(c: Info): Sandbox {
  return { id: c.id, network: c.network, level: 'L3' };
}

/** `sandbox`, with the container of its services when it has some. */
function withServices(sandbox: Sandbox, service: Service | undefined): Sandbox {
  return service ? { ...sandbox, services: service.id } : sandbox;
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
