import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { GhCliForge } from '../adapters/forge/gh-cli.js';
import { GitHubAppForge } from '../adapters/forge/github-app.js';
import { createGithubIngest, githubMapContext, githubRepoOf } from '../adapters/forge/github-ingest.js';
import { PrPoller } from '../adapters/forge/pr-poller.js';
import { FakePublisher } from '../adapters/publisher/fake.js';
import { CachedRoleResolver } from '../adapters/roles/cached.js';
import { ClaudeCodeRunner, liveDir } from '../adapters/runner/claude-code.js';
import { messageClassifier } from '../adapters/runner/message-classifier.js';
import { purgeRunDirs, purgeSessionDirs, purgeTranscripts, transcriptSecrets } from '../adapters/runner/transcript.js';
import { FakeRunner } from '../adapters/runner/fake.js';
import type { Runner } from '../adapters/runner/types.js';
import { registriesViaEgress } from '../network/egress-fetch.js';
import { EgressProxy } from '../network/proxy.js';
import { EgressClient, sandboxAgentHost, type Egress } from '../network/proxy-service.js';
import { GitPublisher } from '../publish/publish.js';
import { hostSecretScan, OutputPolicy, sandboxSecretScan } from '../publish/output-policy.js';
import { checkHostRuns, instanceId, makeSandboxes } from './sandbox-wiring.js';
import { configProblems } from './config-check.js';
import { LinearApi } from '../adapters/tracker/linear/api.js';
import { createLinearIngest } from '../adapters/tracker/linear/ingest.js';
import { buildAuthorizeUrl, exchangeCode, TokenManager } from '../adapters/tracker/linear/oauth.js';
import { Q } from '../adapters/tracker/linear/queries.js';
import { knownLabels, recordLabels, serial } from '../adapters/tracker/linear/labels.js';
import { Reconciler, reconcileOnce } from '../adapters/tracker/linear/reconcile.js';
import { LinearTracker } from '../adapters/tracker/linear/tracker.js';
import { isUsableWebhookSecret } from '../adapters/tracker/linear/webhook.js';
import { GitWorkspaces } from '../adapters/workspace/git-workspaces.js';
import { saveAgentOutput, type AgentOutput } from '../core/agent-output.js';
import { claudeAccountReader, loadFactoryYml, stepSettings } from '../config/factory-yml.js';
import { makeOriginUrl, makeRepoConfig, makeRepoVariables } from './repo-variables.js';
import { daemonSecretValues, effectiveInstance, homePaths, linearSettings, saveLinearTokens } from '../config/instance.js';
import { githubWebhookSecret, resolveGithubApp } from '../config/github-app.js';
import { writeRunSettings } from '../config/run-settings.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { EventBus } from '../core/bus.js';
import { BLOCKED_LABEL } from '../core/engine.js';
import { SystemClock } from '../core/clock.js';
import { logicalFromName, Orchestrator, type ProjectRuntime } from '../core/orchestrator.js';
import { devCapacity, Scheduler } from '../core/scheduler.js';
import { TimerService } from '../runtime/timers.js';
import type { FactoryEvent } from '../core/types.js';
import { runVerify } from '../core/verify.js';
import { KnowledgeBase } from '../knowledge/kb.js';
import { startSmeeRelay } from '../relay/smee.js';
import { agentOnly, createApp, isLoopbackHost } from '../server/app.js';
import { openStore } from '../store/open.js';
import { RUN_BEAT_MS } from '../store/types.js';
import { repoRoot } from './root.js';
import { TrackerSwitch } from './tracker-switch.js';
import { PRODUCT_NAME } from '../product.js';

export interface BootOptions {
  home: string;
  fakeRunner?: boolean;
  port?: number;
  log?: (m: string) => void;
  /** Defaults to process.env; read for FACTORY_UI_PASSWORD. */
  env?: NodeJS.ProcessEnv;
}

const FACTORY_LABELS = ['agent:stop', BLOCKED_LABEL];

/** Where a sandbox sees the factory's install (ORC-204); its image puts `/factory/app/bin` on its PATH. No knowledge base: the server reads it (ORC-232). */
const SANDBOX_ROOT = '/factory/app';

export async function startFactory(o: BootOptions): Promise<{ url: string; stop(): Promise<void> }> {
  const log = o.log ?? ((m: string) => console.log(`[factoryd] ${m}`));
  const root = repoRoot();
  const packDir = join(root, 'packs/standard');
  const webDir = join(root, 'web/dist');
  const env = o.env ?? process.env;
  // factory.yml read once (ORC-209): an invalid file stops the start here, and an edit made while the daemon
  // runs is never half-read by a request; config.yaml with what it declares over it.
  const yml = loadFactoryYml(o.home, env);
  const instance = effectiveInstance(o.home, yml);
  const uiPassword = isLoopbackHost(instance.host) ? undefined : env['FACTORY_UI_PASSWORD'] || undefined;
  if (!isLoopbackHost(instance.host) && !uiPassword) {
    throw new Error(
      `host: ${instance.host} exposes the interface and the API of ${PRODUCT_NAME} outside this machine. ` +
        'Set the FACTORY_UI_PASSWORD environment variable (the interface password), or set host: 127.0.0.1 back in config.yaml.',
    );
  }
  // Before anything opens: no agent on the host but by choice (ORC-349). --fake-runner launches none.
  if (!o.fakeRunner) checkHostRuns(env);
  const paths = homePaths(o.home);
  const port = o.port ?? instance.port;
  const baseUrl = instance.publicUrl ?? `http://localhost:${port}`;
  // The agent API's own listener, for the sandboxes (ORC-204): the UI stays where `host` puts it.
  const agentPort = Number(env['FACTORY_AGENT_PORT'] || port + 1);
  // On the loopback: the sandboxes reach it through the egress proxy, in this process (ORC-213).
  const agentListenHost = env['FACTORY_AGENT_HOST'] || '127.0.0.1';
  // The name the sandboxes use for it, resolved by the proxy alone: a sandbox resolves nothing.
  const agentHostInSandbox = sandboxAgentHost(env);
  const githubApp = resolveGithubApp(instance, env);
  const githubSecret = githubWebhookSecret(instance, env);

  const projects: ProjectRuntime[] = instance.projects.map((p) => {
    const projectFile = join(p.repoPath, '.factory/workflow.yml');
    return {
      id: p.id,
      repoPath: p.repoPath,
      teamKey: p.linearTeamKey,
      workflow: loadWorkflow({ packDir, projectFile: existsSync(projectFile) ? projectFile : undefined, settings: stepSettings(yml) }),
    };
  });
  const limits = projects[0]?.workflow.limits;

  const { store, kind } = await openStore({ env, sqlitePath: paths.db, migrationsFolder: join(root, 'drizzle'), log });
  log(kind === 'postgres' ? 'store: Postgres (Drizzle migrations applied)' : `store: SQLite (${paths.db})`);
  // From here on, a failed start closes the store it opened (the Postgres pool would keep the process alive).
  try {
    const clock = new SystemClock();
    const bus = new EventBus();
    bus.subscribe((m) => {
      if (m.kind === 'log' && m.message !== 'ping') log(`${m.level}: ${m.message}`);
    });

    const trackerSwitch = new TrackerSwitch(port);
    let linearTracker: LinearTracker | undefined;
    const tokenManager = () => {
      const linear = linearSettings(o.home, yml);
      if (!linear) return undefined;
      return new TokenManager({
        clientId: linear.clientId,
        clientSecret: linear.clientSecret,
        load: () => {
          const l = linearSettings(o.home, yml);
          return l?.accessToken ? { accessToken: l.accessToken, refreshToken: l.refreshToken, expiresAt: l.expiresAt } : undefined;
        },
        save: (t) => saveLinearTokens(o.home, t),
      });
    };
    const connectLinear = async () => {
      const tm = tokenManager();
      const appUserId = linearSettings(o.home, yml)?.appUserId;
      if (!tm || !appUserId) return false;
      const api = new LinearApi(() => tm.get());
      linearTracker = new LinearTracker(api, appUserId);
      for (const p of projects) await linearTracker.warm(p.teamKey).catch((e: Error) => log(`warm ${p.teamKey}: ${e.message}`));
      trackerSwitch.set(linearTracker);
      return true;
    };

    const devSessions = devCapacity(yml?.concurrency, limits?.parallelSessions);
    const scheduler = new Scheduler(store, { dev: devSessions, questions: limits?.questionSessions ?? 2 });
    // The chosen account replaces a host run's login (ORC-211). The sandboxes' token goes to the proxy alone (ORC-337):
    // it sets it on their model calls, which hold a placeholder; the runner only asks whether there is one. factory.yml's `claude`
    // section is read again at each launch: a change of `active` counts from the next run, without a restart (ORC-215).
    const claudeAccount = claudeAccountReader(o.home, env, log);
    const claudeTokenOf = () => claudeAccount().token;
    const chosenClaudeToken = () => {
      const a = claudeAccount();
      return a.name ? a.token : undefined;
    };
    // The daemon's own secrets never enter a run's environment; masked all the same, should one surface.
    const daemonSecrets = () => [...daemonSecretValues(o.home, yml), ...(githubSecret ? [githubSecret] : [])];
    // A container per attempt (ORC-204) when FACTORY_CONTAINER_CLI is set; --fake-runner stays on the host.
    // The sandboxes' only way out (ORC-213): it applies each run's network level and journals its connections.
    // In a service of its own under compose (ORC-203), in this process otherwise.
    const egressControl = env['FACTORY_EGRESS_CONTROL'];
    const egress: Egress = egressControl ? new EgressClient(egressControl, { log, claudeToken: claudeTokenOf }) : new EgressProxy({
      dir: paths.network,
      caDir: paths.egressCa,
      log,
      claudeToken: claudeTokenOf,
      agentApi: { host: agentHostInSandbox, port: agentPort, to: { host: agentListenHost === '0.0.0.0' ? '127.0.0.1' : agentListenHost, port: agentPort } },
    });
    const sandboxes = o.fakeRunner ? undefined : makeSandboxes(env, instanceId(o.home), egress);
    if (!o.fakeRunner && !sandboxes) {
      log('Warning: FACTORY_ALLOW_HOST_RUNS=1 and no FACTORY_CONTAINER_CLI, runs execute on the host, without isolation.');
      // Without it, verify refuses to run: one of the `configProblems` below.
      if (env['FACTORY_ALLOW_HOST_VERIFY'] === '1') log("Warning: FACTORY_ALLOW_HOST_VERIFY=1, verify runs the agent's code on the host, next to the daemon's secrets.");
    }
    // No default cap (ORC-216): the values are to calibrate, any default would be a guess that stops work silently.
    if (yml?.budgets?.perTicketTokens === undefined) log('Warning: no ticket budget (budgets.per_ticket_tokens in factory.yml): a ticket runs whatever it spends; `factory validate` refuses until it is set.');
    if (sandboxes && !claudeTokenOf()) log('Warning: no Claude token (claude.active in factory.yml, or CLAUDE_CODE_OAUTH_TOKEN): sandboxed runs will not be able to authenticate.');
    const runner: Runner = o.fakeRunner
      ? Object.assign(new FakeRunner(), { submit: (runId: string, output: AgentOutput) => saveAgentOutput(store, runId, output) })
      : new ClaudeCodeRunner({ transcriptsDir: paths.transcripts, secrets: daemonSecrets, claudeToken: chosenClaudeToken, proxyHasToken: () => !!claudeTokenOf(), log, ...(sandboxes ? { sandboxes } : {}) });
    const workspaces = new GitWorkspaces({ root: paths.workspaces, log });
    const forge = githubApp
      ? new GitHubAppForge({ ...githubApp, log })
      : new GhCliForge();
    if (githubApp) {
      log(
        `GitHub forge: GitHub App ${githubApp.appId} (installation tokens limited to the run's repository` +
          `${githubApp.installationId ? `, installation ${githubApp.installationId}` : ", installation resolved per repository"})`,
      );
    } else {
      log('GitHub forge: gh CLI (migration fallback, read-only: without a GitHub App, the factory neither publishes nor merges)');
    }
    const publisher = o.fakeRunner ? new FakePublisher() : sandboxes && forge instanceof GitHubAppForge ? new GitPublisher({ sandboxes, forge, runsDir: paths.runs, log }) : undefined;
    // gitleaks on every text it publishes (ORC-214), as on the diff: in its sandboxes, or the host's own for host runs. The fake runner's daemon reaches no model.
    const outputPolicy = o.fakeRunner ? new OutputPolicy() : new OutputPolicy(sandboxes ? sandboxSecretScan({ sandboxes, runsDir: paths.runs, log }) : hostSecretScan());
    if (!o.fakeRunner && !sandboxes) log("Warning: runs on the host, the texts the factory publishes are scanned by the host's gitleaks: without it, nothing is posted.");
    // A configuration under which every ticket would be blocked launches no run (ORC-350): /health and the diagnosis tell why.
    const hostChecks = !!o.fakeRunner || env['FACTORY_ALLOW_HOST_VERIFY'] === '1';
    const problems = configProblems({
      fakeRunner: !!o.fakeRunner,
      sandboxes: !!sandboxes,
      hostVerify: hostChecks,
      publisher: !!publisher,
      budgets: yml?.budgets,
    });
    for (const p of problems) log(`Invalid configuration, no run is launched until it is fixed and the factory restarted: ${p}`);
    const kb = instance.knowledge ? new KnowledgeBase(instance.knowledge.repoPath) : undefined;
    // The roles of a human event's signed actor (ORC-186): Linear team members and GitHub rights, read
    // again past their TTL, and the designations of config.yaml.
    const roles = new CachedRoleResolver({
      projects: (id) => {
        const p = instance.projects.find((x) => x.id === id);
        return p && { teamKey: p.linearTeamKey, repoPath: p.repoPath, maintainers: [], validators: [], githubLogins: {}, ...p.authz };
      },
      team: {
        teamMembers: (teamKey) => (linearTracker ? linearTracker.teamMembers(teamKey) : Promise.reject(new Error('Linear not connected'))),
      },
      repo: forge,
    });

    // Filled once the reconciler and the poll exist, below: the reconciliation's timer (ORC-185) runs both.
    let reconcileProject: (p: ProjectRuntime) => Promise<void> = async () => {};
    // Before any run of this process: `verify` reads the base branch at this URL, whatever an agent writes in the repository's config (ORC-151).
    const originUrl = makeOriginUrl();
    if (sandboxes) await Promise.all(projects.map((p) => originUrl(p).catch((err: Error) => log(`Warning: ${p.id}: unreadable origin, verify will read it again: ${err.message}`))));
    const orchestrator = new Orchestrator({
      reconcile: (p) => reconcileProject(p),
      // The sources start before Linear is connected: their events wait in the inbox until replayInbox().
      holdInboxUntilReplay: true,
      // Pulled and read on the server at each launch (ORC-232): the session gets the index in its system prompt, never the repository.
      ...(kb ? { knowledgeIndex: () => kb.refresh(log) } : {}),
      store,
      clock,
      bus,
      scheduler,
      tracker: trackerSwitch,
      outputPolicy,
      forge,
      // Only the GitHub App merges (ORC-148): with the gh CLI, a Done goes back to Human Review with the reason.
      // A fake run writes nothing real: its fake PR's number would be another one's on the forge.
      ...(forge instanceof GitHubAppForge && !o.fakeRunner ? { forgeWriter: forge } : {}),
      // Only the factory publishes (ORC-125), from its sandboxes and by the App: without them, a verified ticket is blocked and told why.
      ...(publisher ? { publisher } : {}),
      runner,
      workspaces,
      verify: runVerify,
      hostChecks,
      configProblems: problems,
      projects,
      packDir,
      // The answer agent reads the session at work there (ORC-182).
      transcriptsDir: paths.transcripts,
      settingsPath: writeRunSettings(packDir, o.home),
      ...(yml?.budgets?.perTicketTokens ? { perTicketTokens: yml.budgets.perTicketTokens } : {}),
      ...(yml?.budgets?.onUsageLimit ? { onUsageLimit: yml.budgets.onUsageLimit } : {}),
      // The account whose token the runner and the proxy use (`claudeAccount` above): `claude.active` when its token is the one resolved,
      // else the daemon's CLAUDE_CODE_OAUTH_TOKEN, held as `default`. A usage limit holds the launches of that account only (ORC-340).
      claudeAccount: () => claudeAccount().name,
      roles,
      repoVariables: makeRepoVariables({ yml, log }),
      repoConfig: makeRepoConfig({ log }),
      originUrl,
      fullReadPaths: (t) => Object.keys(t.frozenTests?.files ?? {}),
      ...(sandboxes
        ? {
            sandboxes,
            sessionsDir: paths.sessions,
            runsDir: paths.runs,
            egressJournal: (runId: string) => egress.journalPath(runId),
            registries: registriesViaEgress(egress),
            // factory-agent runs from the factory's install, read-only: only what it needs, never the whole root,
            // which can hold a `.env` or a dev FACTORY_HOME.
            sandboxMounts: [
              ...['bin', 'package.json', 'node_modules', existsSync(join(root, 'dist')) ? 'dist' : 'src'].map((p) => ({
                host: join(root, p),
                target: `${SANDBOX_ROOT}/${p}`,
                readOnly: true,
              })),
            ],
          }
        : {}),
      // In a sandbox, paths of the sandbox and the PATH of its image: no host path reaches it.
      agentEnv: (run) => ({
        FACTORY_RUN_TOKEN: run.token,
        FACTORY_TICKET: run.ticketId,
        // Read by the pack's PreToolUse hook (ORC-285); the runner keeps every other FACTORY_* in the daemon.
        ...(env['FACTORY_REFUSALS_LOG'] ? { FACTORY_REFUSALS_LOG: env['FACTORY_REFUSALS_LOG'] } : {}),
        ...(yml?.readGuard ? { FACTORY_READ_MAX_LINES: String(yml.readGuard.maxLines) } : {}),
        ...(sandboxes
          ? {
              FACTORY_API: `http://${agentHostInSandbox}:${agentPort}/agent`,
              FACTORY_ROOT: SANDBOX_ROOT,
            }
          : {
              FACTORY_API: `http://127.0.0.1:${port}/agent`,
              FACTORY_ROOT: root,
              PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
            }),
      }),
    });
    await orchestrator.recover();
    // Planned in the store, every 5 minutes (ORC-185): a restart finds the timer and arms no second one.
    await orchestrator.armReconciliation();
    // Every source writes its events to the inbox and gets the promise of the committed row
    // (ORC-147); the orchestrator's worker then decides them from the inbox (ORC-149).
    const accept = (e: FactoryEvent) => orchestrator.accept(e);

    const webhookSecret = () => linearSettings(o.home, yml)?.webhookSecret ?? '';
    // One turn for the webhook and the reconciliation around the known labels (ORC-185).
    const labelsTurn = serial();
    // The fake runner's daemon reaches no model: its messages are classified by the fallback rule (ORC-336).
    const classify = o.fakeRunner ? undefined : messageClassifier(env, claudeTokenOf(), !sandboxes, log);
    const ingest = createLinearIngest({
      serial: labelsTurn,
      // A message for the model is kept in the store and answered before it is classified (ORC-336); what an earlier
      // start kept is written by `resume`, model or not.
      ...(classify ? { classify } : {}),
      deliveries: store,
      secret: webhookSecret,
      accept,
      log,
      ctx: {
        projectsOfTeam: (k) => projects.filter((p) => p.teamKey === k).map((p) => p.id),
        firstProject: () => projects[0]?.id,
        labelsOf: async (id) => (await trackerSwitch.getIssue(id)).labels,
        ticket: (pid, id) => store.getTicket(pid, id),
        logicalFor: (pid, name) => {
          const p = projects.find((x) => x.id === pid);
          return p ? (logicalFromName(p.workflow.states, name) ?? null) : null;
        },
        stateNameById: (t, id) => linearTracker?.stateNameById(t, id),
        stateTypeById: (t, id) => linearTracker?.stateTypeById(t, id),
        labelNameById: (t, id) => linearTracker?.labelNameById(t, id),
        isEcho: (k) => store.isEcho(k, clock.now()),
        commands: (pid) => projects.find((p) => p.id === pid)?.workflow.commands ?? [],
        now: () => clock.now(),
        knownLabels: (pid, id) => knownLabels(store, pid, id),
        // Tickets the factory tracks only: the reconciliation compares no other.
        recordLabels: async (pid, id, labels, at) => {
          if (await store.getTicket(pid, id)) await recordLabels(store, pid, id, labels, at);
        },
      },
    });

    const reconciler = new Reconciler({ tracker: trackerSwitch, store, projects, submit: accept, clock, log, serial: labelsTurn });
    const timers = new TimerService(store, clock, () => orchestrator.wake(), (e) => log(`timers: ${e.message}`));
    const poller = new PrPoller({ store, forge, projects, submit: accept, clock, log });
    reconcileProject = async (p) => {
      await reconcileOnce({ tracker: trackerSwitch, store, projects, only: p.id, submit: accept, clock, log, serial: labelsTurn });
      await poller.pollOnce(p.id);
    };
    // GitHub webhooks (ORC-134) write to the inbox beside the poll (each reconciliation, ORC-185; every 30 s without
    // webhooks, until ORC-181): both name a fact the same way, so the inbox keeps it once.
    const githubIngest = createGithubIngest({
      secret: () => githubSecret,
      accept,
      log,
      ctx: githubMapContext({ store, forge, projects, repoOf: githubRepoOf(), now: () => clock.now(), factoryAppId: githubApp?.appId }),
    });

    const oauthStates = new Set<string>();
    // A human's take-over (ORC-234): only with the sandboxes, never a shell on the host.
    const takeOver = orchestrator.takeOverDesk();
    const app = createApp({
      ...(takeOver ? { takeOver } : {}),
      knowledgeSearch: kb ? (q) => kb.search(q) : undefined,
      store,
      bus,
      clock,
      submit: accept,
      isPaused: () => orchestrator.isPaused(),
      usageLimitedUntil: () => orchestrator.usageLimitedUntil(),
      ...(yml?.budgets?.perTicketTokens ? { perTicketTokens: yml.budgets.perTicketTokens } : {}),
      linearWebhook: ingest,
      githubWebhook: githubIngest,
      linearConnected: () => !!trackerSwitch.current,
      tracker: trackerSwitch,
      capacity: () => ({
        dev: { used: scheduler.inUse('dev'), total: devSessions },
        questions: { used: scheduler.inUse('questions'), total: limits?.questionSessions ?? 2 },
      }),
      transcriptsDir: paths.transcripts,
      webDir: existsSync(webDir) ? webDir : undefined,
      uiPassword,
      configProblems: problems,
      heldRows: (ticketId) => orchestrator.heldRows(ticketId),
      secrets: () => transcriptSecrets(env, daemonSecrets()),
      oauth: linearSettings(o.home, yml)
        ? {
            authorizeUrl: () => {
              const state = randomBytes(16).toString('hex');
              oauthStates.add(state);
              return buildAuthorizeUrl({ clientId: linearSettings(o.home, yml)!.clientId, redirectUri: `${baseUrl}/oauth/callback`, state });
            },
            callback: async (code, state) => {
              if (!oauthStates.delete(state)) throw new Error('unknown OAuth state, start the connection again');
              const s = linearSettings(o.home, yml)!;
              const tokens = await exchangeCode({ clientId: s.clientId, clientSecret: s.clientSecret, code, redirectUri: `${baseUrl}/oauth/callback` });
              saveLinearTokens(o.home, tokens);
              const api = new LinearApi(async () => tokens.accessToken);
              const who = await api.gql<{ viewer: { id: string }; organization: { id: string } }>(Q.viewer);
              saveLinearTokens(o.home, { appUserId: who.viewer.id, organizationId: who.organization.id });
              await connectLinear();
              for (const p of projects) {
                const created = await linearTracker!.ensureSetup(p.teamKey, p.workflow.states, FACTORY_LABELS);
                if (created.length) log(`Linear ${p.teamKey}: created ${created.join(', ')}`);
              }
              // At the connection, without waiting for the timer: what Linear holds is read at once, in the background.
              void reconciler.once();
            },
          }
        : undefined,
    });

    // Webhooks answered before a stop and not written to the inbox yet (ORC-336), set on their way before any new one
    // is taken: a new webhook of their issue goes behind them. A failure leaves them kept, for the next start.
    await ingest.resume().then(
      (n) => n && log(`webhooks: ${n} answered before the stop, written now`),
      (e: unknown) => log(`webhooks kept before the stop not read: ${(e as Error).message}`),
    );
    const server = serve({ fetch: app.fetch, port, hostname: instance.host });
    // Only with sandboxes: the agent API on a listener of its own, for them alone (ORC-204), reached through the egress proxy.
    const agentServer = sandboxes ? serve({ fetch: agentOnly(app), port: agentPort, hostname: agentListenHost }) : undefined;
    if (agentServer) log(`Sandbox agent API: ${agentListenHost}:${agentPort}, reached at http://${agentHostInSandbox}:${agentPort}/agent`);
    const relay = instance.relay.kind === 'smee' ? startSmeeRelay({ url: instance.relay.url, onWebhook: ingest, log }) : undefined;
    let purgeInterval: NodeJS.Timeout | undefined;
    let tickInterval: NodeJS.Timeout | undefined;
    let beatInterval: NodeJS.Timeout | undefined;
    // Everything but the store, which the caller closes after: by stop(), or by a start that fails from here on.
    const shutdown = async () => {
      clearInterval(tickInterval);
      clearInterval(beatInterval);
      clearInterval(purgeInterval);
      // No webhook taken from here on (503, Linear sends it again), then those answered are written or left kept for
      // the next start, before anything closes the store (ORC-336).
      relay?.close();
      ingest.close();
      await ingest.settled();
      // A pass under way finishes first, so it never reads or writes a closed store.
      await Promise.all([timers.stop(), poller.stop(), reconciler.stop()]);
      orchestrator.stopAll();
      await orchestrator.drained();
      // The sandboxes it let run on keep their socket folders: the next start listens in them again (ORC-344).
      await egress.closeAll({ keep: true });
      const close = (s: typeof server) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          // Long-lived SSE streams (/api/events) would otherwise keep close() pending forever.
          (s as unknown as { closeAllConnections(): void }).closeAllConnections();
        });
      await Promise.all([close(server), ...(agentServer ? [close(agentServer)] : [])]);
    };
    try {
      timers.start();
      // Transcripts are kept 30 days (ORC-132), the per-run dirs and the closed tickets' sessions too (ORC-217):
      // purged at start, then daily.
      const purge = () => {
        const now = Date.now();
        const removed = purgeTranscripts(paths.transcripts, now);
        if (removed.length) log(`transcripts: ${removed.length} deleted after 30 days`);
        const runs = purgeRunDirs(paths.runs, now);
        if (runs.length) log(`runs: ${runs.length} folder(s) deleted after 30 days`);
        // Raw streams a crash left and nothing took up (ORC-220).
        purgeRunDirs(liveDir(paths.transcripts), now);
        purgeSessionDirs(paths.sessions, now, store).then(
          (sessions) => sessions.length && log(`sessions: ${sessions.length} deleted, tickets closed for 30 days`),
          (e: unknown) => log(`sessions purge: ${(e as Error).message}`),
        );
        // The egress journals (ORC-213), `*.jsonl` too: the same 30 days.
        purgeTranscripts(paths.network, now);
      };
      purge();
      purgeInterval = setInterval(purge, 24 * 60 * 60 * 1000);
      purgeInterval.unref();
      tickInterval = setInterval(() => {
        orchestrator.tick().catch((e: unknown) => log(`tick: ${(e as Error).message}`));
      }, 60_000);
      tickInterval.unref();
      // The heartbeat of the attempts (ORC-220): their leases, in the store.
      beatInterval = setInterval(() => {
        orchestrator.supervise().catch((e: unknown) => log(`heartbeat: ${(e as Error).message}`));
      }, RUN_BEAT_MS);
      beatInterval.unref();
      // The GitHub webhooks carry the PRs (ORC-134), the 5-minute reconciliation catches what they lose (ORC-185);
      // without webhooks a merge would wait 5 minutes, so the 30-second poll stays (ORC-181 removes it).
      if (!isUsableWebhookSecret(githubSecret)) poller.start();
      if (await connectLinear()) void reconciler.once();
      else log(`Linear not connected: open ${baseUrl}/oauth/start`);
      // The worker (ORC-149) executes the effects decided before a crash, then the events written
      // before it (or whose processing failed), oldest first; it then polls the inbox and the outbox
      // every second, for what another process wrote and for leases that expired.
      orchestrator.startWorker().catch((e: unknown) => log(`inbox: ${(e as Error).message}`));
      if (!isUsableWebhookSecret(webhookSecret()))
        log('Warning: no Linear webhook secret configured, every webhook will be refused. Run factory init again to set it.');
      if (!isUsableWebhookSecret(githubSecret))
        log('GitHub webhooks refused: neither github.webhookSecret nor GH_WEBHOOK_SECRET; only the PR poll every 30 s follows GitHub.');
    } catch (err) {
      await shutdown().catch((e: Error) => log(`shutdown after a failed start: ${e.message}`));
      throw err;
    }
    log(`${PRODUCT_NAME} listening on ${baseUrl}`);

    return {
      url: baseUrl,
      async stop() {
        await shutdown();
        await store.close();
      },
    };
  } catch (err) {
    await store.close().catch((e: Error) => log(`store: could not close (${e.message})`));
    throw err;
  }
}
