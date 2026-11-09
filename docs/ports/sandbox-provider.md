# SandboxProvider port

One isolated environment per attempt: a container created for it and destroyed afterwards, which sees neither the host, nor the daemon, nor the other runs (ORC-204). The pipeline expresses requirements; the provider picks a backend that satisfies them, or it refuses.

- Interface: `SandboxProvider` (`src/adapters/sandbox/types.ts`), port introduced by ORC-225, widened by ORC-204. Network levels: `none`, `claude-api`, `limited`, `full`. Isolation levels: `L3` (rootless container), `L4` (gVisor), `L5` (microVM); only `L3` exists in the MVP.
- Implementations:
  - `FakeSandboxProvider` (`src/adapters/sandbox/fake.ts`): the harness's fake, which isolates nothing and returns what is scripted for `exec`;
  - `SandboxRouter` (`src/adapters/sandbox/router.ts`): picks the backend of each sandbox (below);
  - the container backend (`src/adapters/sandbox/docker-rootless.ts`), driven by the `docker` or `podman` CLI, at level `L3`, without browser, with the `postgres` service (ORC-309).
- Suite: `test/contracts/sandbox.contract.ts`, run by `src/adapters/sandbox/fake.test.ts` and `src/adapters/sandbox/router.test.ts` (the router on a fake).

The ticket gave `WorkspaceManager` → SandboxProvider. ORC-225 introduced `SandboxProvider` alongside, and `WorkspaceManager` (`src/adapters/workspace/types.ts`) remains the worktree port: the worktree is mounted into the sandbox, it is not created there.

## Methods

| Method | What it guarantees | Replayed | Error |
|---|---|---|---|
| `create(req)` | a live sandbox for `req.runId`, carrying the requested network level (`req.network`, enforced by the egress proxy, below), on a backend that satisfies `req.requirements` | same `runId`: returns the existing sandbox, does not create a second one (the router rejects if it does not have that network level or does not satisfy the requirements) | rejects, naming the unmet requirement, when no backend satisfies them all; no sandbox is created |
| `exec(id, argv, opts?)` | runs `argv` in the sandbox to completion and returns its exit code, `stdout` and `stderr`; `cwd` defaults to `/work` | reruns the command | rejects on an unknown or destroyed id; a non-zero code is a result, not a rejection |
| `spawnCommand(id, argv, opts?)` | the host command (`command`) that runs `argv` in the sandbox, stdio attached, for a runner that reads its output as it goes, and what the host process must have in its environment (`env`); the values of `opts.env` never appear in the command | same command | throws on an unknown id |
| `findByAttempt(runId)` | the attempt's live sandbox, by its label | no effect | `undefined` when there is none, or no longer after `destroy` |
| `reattach(runId)` | the live sandbox of an attempt launched by a previous process, made usable by this one: its egress proxy listens again (ORC-220) | no effect | `undefined` when none is running |
| `list()` | every live sandbox the provider made, with its `runId`, so that `recover()` destroys those of dead attempts, without touching those it took back; the services (below) too, under the key they serve | no effect | none |
| `destroy(id)` | the sandbox no longer exists; the services it owns neither | no effect | an unknown or already destroyed id is ignored |

After `destroy`, a `create` for the same `runId` gives a new sandbox.

## The container's environment

`opts.env` is for the container's command, never for the engine process on the host. The container backend carries it under neutral names (`-e FACTORY_SANDBOX_ENV_<n>`, values in the CLI process's environment), and a small `sh` in the container gives each value back its name, removes the neutral names and becomes the command. Under its own name, a variable would also be read by the container engine: measured on rootless Podman 5.8, `HOME` and `XDG_DATA_HOME` move its storage ("no container with name or ID"), `XDG_RUNTIME_DIR` and `TMPDIR` its runtime directory, `CONTAINER_HOST` its target. Docker likewise reads `DOCKER_HOST`. The image must therefore have `sh`. A name that is not a variable name is refused.

## Requirements and refusals

`req.requirements`: a minimum isolation level (`minLevel`, ordered `L3` < `L4` < `L5`), `browser` and a list of `services`. A backend satisfies them all or is not picked: never a silent fallback to a less isolated backend, nor to the host. The refusal is a rejection of `create` whose message names what is missing (`level >= L5`, `browser`, `service postgres`). In the MVP, `L4`, `L5`, a browser and any service but `postgres` are therefore refused.

`unprovided(services)` (ORC-282) gives those of `services` the provider cannot start next to a sandbox, empty when it provides them all: `create` refuses a request naming one, and makes nothing. The container backend provides `postgres`. The router reads its backends' capabilities as `create` picks: one backend must provide them all, else it gives what the closest backend lacks. The orchestrator asks at the launch, before the `setup`: a repository that declares a service no backend provides, or any service on a daemon without sandboxes, starts no run, and its ticket is blocked with a message naming the service.

## Services (ORC-309)

A request whose `requirements.services` names some joins the services of `req.servicesOf` (`runId` by default), started at the first such request. The sandbox whose `runId` is that key **owns** them: they are destroyed with it, or when it fails to start. The others only join them: an attempt's `setup` (`<run>-setup`, `servicesOf: <run>`) leaves them to its agent (`<run>`); `verify`'s `setup` (`<run>-verify-setup`, `servicesOf: <run>-verify`) to its commands (`<run>-verify`), whose services are new, never the agent's. `create` gives their container as `Sandbox.services`: a target of `exec` (the factory's `pg_dumpall`, after a `setup` with secrets) and of `destroy` (a failed `setup`, which no agent follows). `list()` gives them under their key, so `recover()` destroys those of dead attempts as it does their sandboxes.

The container backend's `postgres`: the image `FACTORY_POSTGRES_IMAGE` (default `docker.io/library/postgres:16-bookworm`), labelled `factory.services=<key>`, as the image's `postgres` user, `--cap-drop ALL`, `no-new-privileges`, the sandbox's limits, its data in a tmpfs, `--network none`. Each sandbox that joins runs with `--network container:<its id>`: one loopback, no route. Its passwords, random, and `DATABASE_URL` reach the engine as `-e NAME` without a value, the values in the CLI process's environment, as `exec`'s variables do: never on the command line. initdb is told `--auth-host=scram-sha-256` (its default trusts the loopback) and `--auth-local=trust`, for its own socket, which no sandbox mounts. `DATABASE_URL`'s role, `factory`, is made by the superuser on that socket once Postgres answers: it owns the database and its `public` schema, and is no superuser, so `COPY … TO PROGRAM` is refused and no process the `setup` starts in the service's container outlives the `setup`'s own. The superuser's password, random too, is given to nobody. A sandbox starts only once Postgres accepts connections on the loopback (`pg_isready`, 60 s at most). A service found stopped is never replaced: its database would be empty where the `setup` filled one; the `create` rejects.

## The router

`SandboxRouter` receives a list of backends, each with a name, a `SandboxProvider` and what it can do (`level`, `browser`, `services`). It is itself a `SandboxProvider`:

- `create` first asks each backend for `findByAttempt(runId)`: a replayed `create` returns the existing sandbox, whichever backend holds it, if it has the requested network level and satisfies the requirements (isolation level, capabilities of its backend); otherwise it rejects, never returning it. Otherwise it picks the first backend that satisfies all requirements, or rejects saying, backend by backend, what it lacks.
- `exec`, `spawnCommand` and `destroy` go to the backend that made the id. The router remembers it in memory; after a daemon restart, `reattach`, `list()` and `findByAttempt` relearn it from the backends. For an id it does not know, `destroy` does nothing, `exec` rejects, `spawnCommand` throws.
- `list()` concatenates the backends' lists.
- A sandbox's services (`Sandbox.services`) are remembered as the backend's too.

## Idempotence

The key is the attempt id, `runId`, carried by the `factory.attempt=<runId>` label and looked up before creating ("Container" row of ORC-162). A replayed `create` returns the sandbox as it was created. A request replayed with another network level or requirements it does not satisfy is rejected by the router (and by the container backend for the network); the contract suite does not check it.

With several daemons on the same container engine, each also sets `factory.instance=<id>` (12 hex digits of the sha256 of its `FACTORY_HOME`) and only looks for its own containers: `recover()` does not destroy another's.

## Fencing

The sandbox belongs to an attempt: the engine is what decides which attempt is active (ORC-133) and destroys the others, at startup through `list()` in `recover()`, once it has taken back those of attempts still alive (`reattach`).

## What the suite asks of the implementation

`SandboxSubject`:

- `request`: a request for a run without a sandbox;
- `active()`: the ids of the live sandboxes (the fake reads them through `active()`; a real one, through its labels);
- `unsatisfiable` (optional): requirements the subject cannot satisfy and a pattern of the refusal message that must name them; without it, the refusal case is skipped (the fake, which looks only at services, declares none).

Whatever the subject, a case names a service the provider does not have (`contract-no-such-service`): `unprovided` must name it, and `create` refuse it naming it, with no sandbox made (ORC-282).

The `exec` case runs `EXEC_PROBE` (`sh -c`, which writes to both outputs and exits with 3): a real sandbox executes it, a fake scripts its answer.

## Known gaps

- **Network enforced by the egress proxy (ORC-213).** The container backend always runs with `--network none`. With the factory's proxy, it mounts the run's socket and the egress authority's certificate, and the proxy is what enforces the level; without a proxy, nothing gets out, whatever the level. The returned `Sandbox` carries the requested level (a replayed `create` compares it). A live container whose socket is not held by this process (restarted daemon) is only returned by `reattach`, which reopens the socket at the same path: `create` and `findByAttempt` do not return it, and `create` destroys and remakes it. See [interface-and-security.md](../interface-and-security.md#sandbox-network).
- `FakeSandboxProvider` looks only at services, refusing one outside its `services` field (`postgres`, which a test can change): it creates an `L3` sandbox whatever the level or browser asked. That refusal is checked on the router. It keeps services by their key (`activeServices()`), as the container backend does.
- **Services under rootless Podman (ORC-309)**: `--network container:` between a service without `--userns=keep-id` and a sandbox with it is checked by `test/isolation/services.test.ts`, in CI only.
- **No database for the red check (ORC-309)**: the `<run>-red` sandbox gets no services; a red check whose tests need the database sees them fail for that reason. The captures of the visual proof get none either, so a repository with `services` gets no capture: its required proof is unavailable, naming them (ORC-282).
- **A replayed `create` through the router** returns the sandbox without `services`: a `setup` replayed so fails rather than leave its database unchecked.
- `FakeSandboxProvider.create` created a sandbox on each call: it returns the run's one since ORC-189.
