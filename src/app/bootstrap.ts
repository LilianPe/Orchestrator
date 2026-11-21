import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { GitHubAppForge } from '../adapters/forge/github-app.js';
import { createGithubIngest, githubMapContext } from '../adapters/forge/github-ingest.js';
import { githubAuthorizeUrl, githubSignIn } from '../adapters/forge/github-login.js';
import { GithubReconciler } from '../adapters/forge/github-reconcile.js';
import { NoForge } from '../adapters/forge/no-forge.js';
import { PASS } from '../adapters/checks/fake.js';
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
import { OutputPolicy, sandboxSecretScan } from '../publish/output-policy.js';
import { browserImage, checkSandboxes, instanceId, makeSandboxes, visualProofLine } from './sandbox-wiring.js';
import { PlaywrightShooter } from '../adapters/browser/playwright.js';
import { configProblems } from './config-check.js';
import { LinearApi } from '../adapters/tracker/linear/api.js';
import { createLinearIngest } from '../adapters/tracker/linear/ingest.js';
import { buildAuthorizeUrl, exchangeCode, TokenManager } from '../adapters/tracker/linear/oauth.js';
import { Q } from '../adapters/tracker/linear/queries.js';
import { knownLabels, recordLabels, recordWrite, serial } from '../adapters/tracker/linear/labels.js';
import { Reconciler, reconcileOnce } from '../adapters/tracker/linear/reconcile.js';
import { LinearTracker } from '../adapters/tracker/linear/tracker.js';
import { isUsableWebhookSecret } from '../adapters/tracker/linear/webhook.js';
import { GitWorkspaces } from '../adapters/workspace/git-workspaces.js';
import { RepoMirrors } from '../adapters/workspace/repo-mirrors.js';
import { saveAgentOutput, type AgentOutput } from '../core/agent-output.js';
import { claudeAccountReader, disabledControls, readCapsOf, specPublicationOf, stepSettings, ticketCapOf } from '../config/factory-yml.js';
import { loadSealedFactoryYml } from '../config/server-secrets.js';
import { startRefusals, type StartChecks } from '../config/start-refusals.js';
import { ignoredWorkflowWarning } from '../config/repo-config.js';
import { cloneAuth, httpsGithub, projectGithub } from './project-github.js';
import { ignoredWorkflowFilesOn, makeDryRunFiles, makeOriginUrl, makeRepoConfig, makeRepoVariables, makeStartFingerprint } from './repo-variables.js';
import { daemonSecretValues, effectiveInstance, homePaths, linearSettings, saveLinearTokens, sealSecretsAtRest, validatorWarnings } from '../config/instance.js';
import { githubWebhookSecret, resolveGithubApp } from '../config/github-app.js';
import { fantome, isFantome, projectEffects } from '../presets/fantome.js';
import { defaultWorkflow, missingStatusWarning, presetWorkflow } from '../presets/workflow.js';
import type { Workflow } from '../core/workflow.js';
import { Replays, SANDBOXES_META } from '../ghost/delegate.js';
import { startTime } from '../ghost/history.js';
import { FACTORY_LABELS } from '../core/engine.js';
import { SystemClock } from '../core/clock.js';
import { logicalFromName, Daemon, type ProjectRuntime } from '../runtime/daemon.js';
import { queueCapacity, Scheduler } from '../runtime/capacity.js';
import { TimerService } from '../runtime/timers.js';
import { TRUSTED, type FactoryEvent } from '../core/types.js';
import { KnowledgeBase } from '../knowledge/kb.js';
import { PreviewRecipes } from '../knowledge/preview-recipe.js';
import { startSmeeRelay } from '../relay/smee.js';
import { agentOnly, createApp, GITHUB_CALLBACK_PATH, type ServerDeps } from '../server/app.js';
import { listenCliSocket } from '../server/cli-socket.js';
import { EventBus } from '../server/live-feed.js';
import { openStore } from '../store/open.js';
import type { Store } from '../store/types.js';
import { RUN_BEAT_MS } from '../store/types.js';
import { repoRoot } from './root.js';
import { TrackerSwitch } from './tracker-switch.js';
import { PRODUCT_NAME } from '../product.js';

/**
 * The spec's status a connected team lacks, created at start as « Connect Linear » creates it (ORC-457): a team connected before
 * Spec was a default gets it, or every delegation's move to it would fail. Only that one: another status the team lacks (a typo
 * in factory.yml, one deleted on purpose) is said, as `doctor` says it (ORC-382), never written to the team at each start.
 */
export async function createMissingStatuses(
  tracker: Pick<LinearTracker, 'teamStatuses' | 'ensureSetup'>,
  projects: readonly { id: string; teamKey: string; workflow: Pick<Workflow, 'states'> }[],
  log: (line: string) => void,
): Promise<void> {
  for (const p of projects) {
    // As `warm` just read them.
    let team = await tracker.teamStatuses(p.teamKey, false).catch(() => undefined);
    if (!team) continue;
    const spec = p.workflow.states.spec;
    if (spec && !team.includes(spec)) {
      try {
        const created = await tracker.ensureSetup(p.teamKey, { spec }, []);
        if (created.length) log(`Linear ${p.teamKey}: created ${created.join(', ')}`);
        team = [...team, ...created];
      } catch (error) {
        log(`Linear ${p.teamKey}: « ${spec} » not created: ${(error as Error).message}`);
      }
    }
    const warning = missingStatusWarning(p, p.workflow.states, team);
    if (warning) log(warning);
  }
}

export interface BootOptions {
  home: string;
  fakeRunner?: boolean;
  port?: number;
  log?: (m: string) => void;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * A store opened by the caller instead of the instance's Postgres (the tests' MemoryStore): the factory takes it where it
   * would open its own, and closes it when it stops or fails to start from there on.
   */
  store?: Store;
  /** Where the daemon's mirrors fetch each repository (`owner/name`, ORC-479): GitHub by default, a test's local bare repositories. */
  githubUrl?: (github: string) => string;
}

/** The dashboard's GitHub sign-in off the loopback (ORC-399), from what `startRefusals` checked; none on the loopback, where nobody signs in. */
function dashboardLogin(signIn: StartChecks['signIn']): ServerDeps['githubLogin'] {
  if (!signIn) return undefined;
  const { client, access } = signIn;
  // A publicUrl written with its trailing slash must still give the callback URL the App declares.
  const redirectUri = `${signIn.publicUrl.replace(/\/+$/, '')}${GITHUB_CALLBACK_PATH}`;
  const options = { ...client, redirectUri, access };
  return { authorizeUrl: (state) => githubAuthorizeUrl({ clientId: client.clientId, redirectUri, state }), signIn: (code) => githubSignIn(options, code) };
}

export async function startFactory(o: BootOptions): Promise<{ url: string; stop(): Promise<void> }> {
  const log = o.log ?? ((m: string) => console.log(`[factoryd] ${m}`));
  const root = repoRoot();
  const packDir = join(root, 'packs/standard');
  const webDir = join(root, 'web/dist');
  const env = o.env ?? process.env;
  // factory.yml read once (ORC-209): an invalid file stops the start here, and an edit made while the daemon
  // runs is never half-read by a request; without one, `startRefusals` stops it, config.yaml never read (ORC-199). Its server secrets are read now from
  // their sources (ORC-398): one that fails stops the start. The sources stay open for the repositories' secrets, read at
  // each setup (ORC-308), whose references' syntax alone is checked here.
  const { yml, sealed, reader: repoSecrets } = await loadSealedFactoryYml(o.home, env);
  const instance = effectiveInstance(yml);
  // Before secrets.json is touched; `factory doctor` says them alike (ORC-448).
  const { warnings, oauthClient, signIn } = startRefusals(o.home, instance, yml, env);
  for (const line of warnings) log(line);
  const githubLogin = dashboardLogin(signIn);
  // The tokens the daemon writes itself, encrypted at rest from now on when factory.yml names a key (ORC-398).
  const secretsKey = yml?.secretsKey;
  if (secretsKey && sealSecretsAtRest(o.home, secretsKey)) log('secrets.json: encrypted at rest with secrets_key');
  // Before anything opens: no agent on the host (ORC-179), sandboxes only with docker or podman and their runner image,
  // valid limits and the daemon's uid/gid (`sandboxRefusals`, said by `factory doctor` too, ORC-449, ORC-450). The test harness's fake runner launches none.
  if (!o.fakeRunner) checkSandboxes(env);
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

  // The workflow of factory/default for every project: a repository's `.factory/workflow.yml` is ignored (ORC-388).
  const settings = stepSettings(yml);
  const workflow = defaultWorkflow(settings);
  // The replay of closed tickets (ORC-231): driven by the fantome's own steps, with the instance's step settings.
  const ghost = presetWorkflow(fantome, settings);
  // Each project's repository on GitHub, resolved once (ORC-478): a project whose origin is not on GitHub stops the start here.
  const [origins, knowledgeGithub] = await Promise.all([
    Promise.all(instance.projects.map((p) => projectGithub({ repoPath: p.repoPath, teamKey: p.linearTeamKey, repos: yml?.repos }).catch((err: Error) => {
      throw new Error(`${p.id}: ${err.message}`);
    }))),
    instance.knowledge ? httpsGithub(instance.knowledge.repoPath) : undefined,
  ]);
  // Without the App, no forge at all (ORC-181): every read says the App is missing, and nothing is published.
  const appForge = githubApp ? new GitHubAppForge({ ...githubApp, log }) : undefined;
  // The daemon's own git reads a private repository with the App's token (ORC-442); without the App, with the machine's credentials.
  const gitAuth = appForge?.fetchEnv.bind(appForge);
  // The daemon's own mirror of each repository (ORC-479), its git source in place of the operator's clone.
  const mirrors = new RepoMirrors({ root: paths.repos, log, ...(gitAuth ? { auth: gitAuth } : {}), ...(o.githubUrl ? { url: o.githubUrl } : {}) });
  const projects: ProjectRuntime[] = instance.projects.map((p, i) => ({
    id: p.id,
    mirror: mirrors.path(origins[i]!.github),
    github: origins[i]!.github,
    teamKey: p.linearTeamKey,
    // The replay of closed tickets (ORC-231): nothing of the project leaves the factory.
    workflow: isFantome(p) ? ghost : workflow,
    ...(projectEffects(p) ? { effects: 'none' as const } : {}),
  }));
  // The knowledge base's clone fetches by its path until ORC-471 part 4, over HTTPS from GitHub with the App's token.
  const clones = new Map(knowledgeGithub ? [[instance.knowledge!.repoPath, knowledgeGithub] as const] : []);
  for (const line of validatorWarnings(instance.projects)) log(line);
  // The projects that replay closed tickets (ORC-376): only the daemon's own delegations reach them, nothing of Linear, whose tickets
  // of the same team stay the other projects'.
  const replaying = instance.projects.filter(isFantome).map((p) => p.id);
  const fromLinear = projects.filter((p) => !replaying.includes(p.id));

  let store = o.store;
  if (!store) {
    store = await openStore({ env, migrationsFolder: join(root, 'drizzle'), log });
    log('store: Postgres (Drizzle migrations applied)');
  }
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
        save: (t) => saveLinearTokens(o.home, t, yml),
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

    const capacity = queueCapacity(yml?.concurrency);
    const scheduler = new Scheduler(store, capacity);
    // The sandboxes' token goes to the proxy alone (ORC-337):
    // it sets it on their model calls, which hold a placeholder; the runner only asks whether there is one. factory.yml's `claude`
    // section is read again at each launch: a change of `active` counts from the next run, without a restart (ORC-215).
    const claudeAccount = claudeAccountReader(o.home, env, log, sealed);
    const claudeTokenOf = () => claudeAccount().token;
    // The daemon's own secrets never enter a run's environment; masked all the same, should one surface.
    // A repository's secrets: its env ones from the start, the others by the values its setups read (ORC-308), a rotated one included.
    const daemonSecrets = (): string[] => [...daemonSecretValues(o.home, yml, env), ...repoSecrets.values(), ...(githubSecret ? [githubSecret] : []), ...(oauthClient ? [oauthClient.clientSecret] : [])];
    // Masked where the daemon shows a text it did not write: the diagnosis, the CI logs a fix reads (ORC-459).
    const allSecrets = () => transcriptSecrets(env, daemonSecrets());
    // A container per attempt (ORC-204), from FACTORY_CONTAINER_CLI; the test harness's fake runner launches no agent, and has none.
    // The sandboxes' only way out (ORC-213): it applies each run's network level and journals its connections.
    // In a service of its own under compose (ORC-203), in this process otherwise.
    const egressControl = env['FACTORY_EGRESS_CONTROL'];
    // The caps of the reads that move a public counter (ORC-370), factory.yml's: handed to the proxy with each run.
    const reads = readCapsOf(yml);
    const egress: Egress = egressControl ? new EgressClient(egressControl, { log, claudeToken: claudeTokenOf, reads }) : new EgressProxy({
      dir: paths.network,
      caDir: paths.egressCa,
      log,
      claudeToken: claudeTokenOf,
      reads,
      agentApi: { host: agentHostInSandbox, port: agentPort, to: { host: agentListenHost === '0.0.0.0' ? '127.0.0.1' : agentListenHost, port: agentPort } },
    });
    // The visual proof's browser (ORC-404): the capture image, when this engine has it; without, a required proof is unavailable.
    const browser = o.fakeRunner ? undefined : await browserImage(env);
    const capture = browser?.image;
    const sandboxes = o.fakeRunner ? undefined : makeSandboxes(env, instanceId(o.home), egress, capture ? { browserImage: capture } : {});
    if (browser && sandboxes) log(visualProofLine(browser));
    // No default cap (ORC-216): the values are to calibrate, any default would be a guess that stops work silently.
    if (yml?.budgets?.perTicketTokens === undefined) log('Warning: no ticket budget (budgets.per_ticket_tokens in factory.yml): a ticket runs whatever it spends; `factory validate` refuses until it is set.');
    // Said at each start (ORC-381): a control off is a choice of this server's, never a repository's. The Claude usage limit is not one.
    const disabled = disabledControls(yml);
    const ticketCap = ticketCapOf(yml);
    if (disabled.length) log(`Disabled in factory.yml: ${disabled.join(', ')}.`);
    if (sandboxes && !claudeTokenOf()) log('Warning: no Claude token (claude.active in factory.yml, or CLAUDE_CODE_OAUTH_TOKEN): sandboxed runs will not be able to authenticate.');
    // No sandboxes only under the test harness's fake runner: `claude` runs in a sandbox or not at all (ORC-179).
    const runner: Runner = sandboxes
      ? new ClaudeCodeRunner({ transcriptsDir: paths.transcripts, secrets: daemonSecrets, proxyHasToken: () => !!claudeTokenOf(), log, sandboxes })
      : Object.assign(new FakeRunner(), { submit: (runId: string, output: AgentOutput) => saveAgentOutput(store, runId, output) });
    const clonesAuth = cloneAuth(gitAuth, clones);
    // Each mirror made or fetched in the background: a first clone can take minutes, and the server, its webhooks and /health do not
    // wait for it. A launch that comes meanwhile waits for it (`RepoMirrors.fetch`, one git at a time); a failure is logged and left to
    // the launches, which fetch it again.
    // Once per repository: two projects of one repository share its mirror.
    const readies = new Map<string, Promise<unknown>>();
    void Promise.all(projects.map(async (p) => {
      const ready = readies.get(p.mirror) ?? readies.set(p.mirror, mirrors.ready(p.github)).get(p.mirror)!;
      try {
        await ready;
      } catch (err) {
        log(`Warning: ${p.id}: the mirror of ${p.github} could not be fetched, its launches fetch it again: ${(err as Error).message}`);
      }
      // Said at each start, not only by `factory doctor`: on the default branch the runs start from, not in a working tree.
      for (const file of await ignoredWorkflowFilesOn(p.mirror)) log(`${p.id}: ${ignoredWorkflowWarning(file)}`);
    })).catch((err: Error) => log(`Warning: the mirrors' start: ${err.message}`));
    const workspaces = new GitWorkspaces({ root: paths.workspaces, log, auth: mirrors.auth, fetch: mirrors.fetch });
    const forge = appForge ?? new NoForge();
    if (githubApp) {
      log(
        `GitHub forge: GitHub App ${githubApp.appId} (installation tokens limited to the run's repository` +
          `${githubApp.installationId ? `, installation ${githubApp.installationId}` : ", installation resolved per repository"})`,
      );
    } else {
      log('Warning: no GitHub App (github.app_id and github.private_key in factory.yml, or GH_APP_ID and GH_APP_KEY): the factory reads no PR, publishes nothing and merges nothing.');
    }
    const publisher = o.fakeRunner ? new FakePublisher() : sandboxes && appForge ? new GitPublisher({ sandboxes, forge: appForge, runsDir: paths.runs, log }) : undefined;
    // gitleaks on every text it publishes (ORC-214), as on the diff, in its sandboxes. The fake runner's daemon reaches no model.
    const outputPolicy = sandboxes ? new OutputPolicy(sandboxSecretScan({ sandboxes, runsDir: paths.runs, log })) : new OutputPolicy();
    // A configuration under which every ticket would be blocked launches no run (ORC-350): /health says so, the log and the diagnosis why.
    const problems = configProblems({
      fakeRunner: !!o.fakeRunner,
      publisher: !!publisher,
      budgets: yml?.budgets,
    });
    for (const p of problems) log(`Invalid configuration, no run is launched until it is fixed and the factory restarted: ${p}`);
    const kb = instance.knowledge ? new KnowledgeBase(instance.knowledge.repoPath, { auth: clonesAuth }) : undefined;
    // The roles of a human event's signed actor (ORC-186): Linear team members and GitHub rights, read
    // again past their TTL, and the designations of factory.yml.
    const roles = new CachedRoleResolver({
      projects: (id) => {
        const i = instance.projects.findIndex((x) => x.id === id);
        const p = instance.projects[i];
        return p && { teamKey: p.linearTeamKey, github: projects[i]!.github, maintainers: [], validators: [], githubLogins: {}, ...p.authz };
      },
      team: {
        teamMembers: (teamKey) => (linearTracker ? linearTracker.teamMembers(teamKey) : Promise.reject(new Error('Linear not connected'))),
      },
      repo: forge,
    });

    // Filled once both reconcilers exist, below: the reconciliation's timer (ORC-185) runs Linear's, then GitHub's.
    let reconcileProject: (p: ProjectRuntime) => Promise<void> = async () => {};
    // Before any run of this process: `verify` reads the base branch at this URL, whatever an agent writes in the repository's config (ORC-151).
    const originUrl = makeOriginUrl();
    // What `factory ghost start` reads before a replay (ORC-376): a replay runs with sandboxes only.
    await store.setMeta(SANDBOXES_META, sandboxes ? '1' : '0');
    const replays = new Replays({
      store, tracker: trackerSwitch, projects: replaying, dir: paths.ghost, sandboxes: !!sandboxes,
      accept: (e): Promise<boolean> => daemon.accept(e), now: () => clock.now(), log: (level, m) => log(`${level === 'warn' ? 'Warning: ' : ''}replay: ${m}`),
      startTime,
    });
    // One turn for the webhook, the reconciliation and the factory's own label writes around the known labels (ORC-185, ORC-346).
    const labelsTurn = serial();
    const daemon = new Daemon({
      replays,
      labelsWritten: (projectId, ticketId, written) => labelsTurn(() => recordWrite(store, projectId, ticketId, written)),
      reconcile: (p) => reconcileProject(p),
      // The sources start before Linear is connected: their events wait in the inbox until replayInbox().
      holdInboxUntilReplay: true,
      keptEffectsDir: paths.kept,
      // Pulled and read on the server at each launch (ORC-232): the session gets the index in its system prompt, never the repository.
      // A replayed ticket's (ORC-376): its checkout at transaction time, read as it is, never pulled.
      // The factory's one write to it (ORC-386): the start recipes it validated, in the same clone, one git at a time with the pull.
      ...(kb ? { knowledgeIndex: async (repo?: string) => (repo ? new KnowledgeBase(repo).readIndex() : kb.refresh()), previewRecipes: new PreviewRecipes(kb), startFingerprint: makeStartFingerprint({ log }) } : {}),
      store,
      clock,
      bus,
      scheduler,
      tracker: trackerSwitch,
      outputPolicy,
      forge,
      secretValues: allSecrets,
      // Only the GitHub App merges (ORC-148): without it, a Done goes back to Human Review with the reason.
      // A fake run writes nothing real: its fake PR's number would be another one's on the forge.
      // The visual proof's captures shown in the PR from the repository's `factory/artifacts` branch, by the same App (ORC-407).
      ...(appForge && !o.fakeRunner ? { forgeWriter: appForge, captureHost: appForge } : {}),
      // Only the factory publishes (ORC-125), from its sandboxes and by the App: without them, a verified ticket is blocked and told why.
      ...(publisher ? { publisher } : {}),
      runner,
      workspaces,
      // The fake runner's checks pass and run nothing: no command of a repository runs on the host (ORC-179). With sandboxes, none is needed.
      ...(o.fakeRunner ? { verify: async () => PASS } : {}),
      configProblems: problems,
      ...(yml?.maxDiff ? { maxDiff: yml.maxDiff } : {}),
      projects,
      packDir,
      // The answer agent reads the session at work there (ORC-182).
      transcriptsDir: paths.transcripts,
      ...(ticketCap ? { perTicketTokens: ticketCap } : {}),
      ...(yml?.budgets?.onUsageLimit ? { onUsageLimit: yml.budgets.onUsageLimit } : {}),
      ...(yml?.acknowledge ? { acknowledge: yml.acknowledge } : {}),
      specPublication: specPublicationOf(yml),
      // The account whose token the runner and the proxy use (`claudeAccount` above): `claude.active` when its token is the one resolved,
      // else the daemon's CLAUDE_CODE_OAUTH_TOKEN, held as `default`. A usage limit holds the launches of that account only (ORC-340).
      claudeAccount: () => claudeAccount().name,
      roles,
      repoVariables: makeRepoVariables({ yml, log }),
      readSecrets: (refs) => repoSecrets.read(refs),
      repoConfig: makeRepoConfig({ log, fetch: mirrors.fetch }),
      originUrl,
      gitAuth,
      fullReadPaths: (t) => Object.keys(t.frozenTests?.files ?? {}),
      ...(sandboxes && capture ? { visualProof: { shooter: new PlaywrightShooter(), artifactsDir: paths.artifacts } } : {}),
      ...(sandboxes
        ? {
            sandboxes,
            sessionsDir: paths.sessions,
            runsDir: paths.runs,
            egressJournal: (runId: string) => egress.journalPath(runId),
            registries: registriesViaEgress(egress),
            // Required with sandboxes (`makeSandboxes`): the dry run's fingerprint (ORC-408).
            runnerImage: env['FACTORY_RUNNER_IMAGE']!,
            // A delegated ticket waits for the repository's dry run, run again when its fingerprint changes (ORC-409).
            dryRunFiles: makeDryRunFiles({ log }),
          }
        : {}),
      // In a sandbox, no host path: the agent reaches the factory through its MCP alone (ORC-192).
      agentEnv: (run) => ({
        FACTORY_RUN_TOKEN: run.token,
        FACTORY_TICKET: run.ticketId,
        // Read by the pack's PreToolUse hook (ORC-285); the runner keeps every other FACTORY_* in the daemon.
        ...(env['FACTORY_REFUSALS_LOG'] ? { FACTORY_REFUSALS_LOG: env['FACTORY_REFUSALS_LOG'] } : {}),
        ...(yml?.readGuard ? { FACTORY_READ_MAX_LINES: String(yml.readGuard.maxLines) } : {}),
        // The factory MCP's address (ORC-288), the only thing of the factory a run reaches (ORC-192).
        FACTORY_API: sandboxes ? `http://${agentHostInSandbox}:${agentPort}/agent` : `http://127.0.0.1:${port}/agent`,
      }),
    });
    await daemon.recover();
    // Planned in the store, every 5 minutes (ORC-185): a restart finds the timer and arms no second one.
    await daemon.armReconciliation();
    // Every source writes its events to the inbox and gets the promise of the committed row
    // (ORC-147); the daemon's worker then decides them from the inbox (ORC-149).
    const accept = (e: FactoryEvent) => daemon.accept(e);
    // Nothing pauses or resumes the queue any more (ORC-200): a pause left from before would hold every launch for good.
    if (await daemon.isPaused()) {
      log('The queue was paused, and nothing pauses it any more (ORC-200): it is resumed.');
      const at = clock.now();
      await accept({ ...TRUSTED, actor: 'factory:start', id: `start:resume:${at}`, type: 'control.resume', at, projectId: '*', payload: {} });
    }

    const webhookSecret = () => linearSettings(o.home, yml)?.webhookSecret ?? '';
    // The fake runner's daemon reaches no model: its messages are classified by the fallback rule (ORC-336).
    const classify = o.fakeRunner ? undefined : messageClassifier(env, yml?.messageModel?.apiKey, log);
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
        projectsOfTeam: (k) => fromLinear.filter((p) => p.teamKey === k).map((p) => p.id),
        firstProject: () => fromLinear[0]?.id,
        labelsOf: async (id) => (await trackerSwitch.getIssue(id)).labels,
        ticket: (pid, id) => store.getTicket(pid, id),
        logicalFor: (pid, name) => {
          const p = projects.find((x) => x.id === pid);
          return p ? (logicalFromName(p.workflow.states, name) ?? null) : null;
        },
        stateNameById: (t, id) => linearTracker?.stateNameById(t, id),
        stateTypeById: (t, id) => linearTracker?.stateTypeById(t, id),
        labelNameById: (t, id) => linearTracker?.labelNameById(t, id),
        // Read from the settings until Linear is connected: a webhook of the factory's write before a restart may come first.
        factoryActor: () => linearTracker?.appUserId ?? linearSettings(o.home, yml)?.appUserId,
        now: () => clock.now(),
        knownLabels: (pid, id) => knownLabels(store, pid, id),
        // Tickets the factory tracks only: the reconciliation compares no other.
        recordLabels: async (pid, id, labels, at) => {
          if (await store.getTicket(pid, id)) await recordLabels(store, pid, id, labels, at);
        },
      },
    });

    const reconciler = new Reconciler({ tracker: trackerSwitch, store, projects: fromLinear, submit: accept, clock, log, serial: labelsTurn });
    const timers = new TimerService(store, clock, () => daemon.wake(), (e) => log(`timers: ${e.message}`));
    // Without the App, no GitHub pass: every read would fail, ticket by ticket, at each pass; the start said why once.
    const githubReconciler = appForge && new GithubReconciler({ store, forge: appForge, projects, submit: accept, clock, log });
    reconcileProject = async (p) => {
      await reconcileOnce({ tracker: trackerSwitch, store, projects: fromLinear, only: p.id, submit: accept, clock, log, serial: labelsTurn });
      await githubReconciler?.once(p.id);
    };
    // GitHub webhooks (ORC-134) write to the inbox beside the reconciliation (every 5 min, ORC-185): both name a fact the
    // same way, so the inbox keeps it once.
    const githubIngest = createGithubIngest({
      secret: () => githubSecret,
      accept,
      log,
      ctx: githubMapContext({ store, forge, projects, now: () => clock.now(), factoryAppId: githubApp?.appId }),
    });

    const oauthStates = new Set<string>();
    // A human's take-over (ORC-234): only with the sandboxes, never a shell on the host.
    const takeOver = daemon.takeOverDesk();
    const app = createApp({
      ...(takeOver ? { takeOver } : {}),
      // A replayed ticket's run searches its knowledge base at transaction time (ORC-376), `repo`.
      ...(kb ? { knowledgeSearch: (q: string, repo?: string) => (repo ? new KnowledgeBase(repo) : kb).search(q) } : {}),
      replays,
      store,
      bus,
      clock,
      submit: accept,
      isPaused: () => daemon.isPaused(),
      usageLimitedUntil: () => daemon.usageLimitedUntil(),
      ...(ticketCap ? { perTicketTokens: ticketCap } : {}),
      ...(yml?.audit ? { seriousDefect: yml.audit.seriousDefect } : {}),
      disabledControls: disabled,
      linearWebhook: ingest,
      githubWebhook: githubIngest,
      linearConnected: () => !!trackerSwitch.current,
      capacity: () => ({
        dev: { used: scheduler.inUse('dev'), total: capacity.dev },
        questions: { used: scheduler.inUse('questions'), total: capacity.questions },
      }),
      transcriptsDir: paths.transcripts,
      webDir: existsSync(webDir) ? webDir : undefined,
      githubLogin,
      configProblems: problems,
      heldRows: (ticketId) => daemon.heldRows(ticketId),
      // `factory dry-run`: a new one, after any under way, which reads what changed meanwhile (a known flaky test, a variable).
      dryRun: (projectId) => daemon.dryRun(projectId, { fresh: true }),
      projects: projects.map((p) => p.id),
      secrets: allSecrets,
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
              saveLinearTokens(o.home, tokens, yml);
              const api = new LinearApi(async () => tokens.accessToken);
              const who = await api.gql<{ viewer: { id: string }; organization: { id: string } }>(Q.viewer);
              saveLinearTokens(o.home, { appUserId: who.viewer.id, organizationId: who.organization.id }, yml);
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
    // The CLI on this server (ORC-405): its socket in FACTORY_HOME, the factory user's alone, without the GitHub sign-in.
    // Never throws: without it, the CLI keeps HTTP on the loopback.
    const cliServer = await listenCliSocket(app, paths.socket, { log });
    // Only with sandboxes: the agent API on a listener of its own, for them alone (ORC-204), reached through the egress proxy.
    const agentServer = sandboxes ? serve({ fetch: agentOnly(app), port: agentPort, hostname: agentListenHost }) : undefined;
    if (agentServer) log(`Sandbox agent API: ${agentListenHost}:${agentPort}, reached at http://${agentHostInSandbox}:${agentPort}/agent`);
    const relay = instance.relay.kind === 'smee' ? startSmeeRelay({ url: instance.relay.url, onWebhook: ingest, log }) : undefined;
    let purgeInterval: NodeJS.Timeout | undefined;
    /** The captures' prune under way (ORC-407): it reads the store, so a stop waits for it. */
    let pruning: Promise<unknown> = Promise.resolve();
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
      await Promise.all([timers.stop(), reconciler.stop(), replays.stop(), pruning]);
      daemon.stopAll();
      await daemon.drained();
      // The sandboxes it let run on keep their socket folders: the next start listens in them again (ORC-344).
      await egress.closeAll({ keep: true });
      const close = (s: typeof server) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          // Long-lived SSE streams (/api/events) would otherwise keep close() pending forever.
          (s as unknown as { closeAllConnections(): void }).closeAllConnections();
        });
      await Promise.all([server, agentServer, cliServer].filter((s) => s !== undefined).map(close));
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
        // The captures of PRs merged or closed 30 days ago, off each repository's `factory/artifacts` (ORC-407).
        pruning = daemon.pruneCaptures(now).then(
          (folders) => folders.length && log(`captures: ${folders.length} folder(s) removed from factory/artifacts, PRs closed for 30 days (${folders.join(', ')})`),
          (e: unknown) => log(`captures purge: ${(e as Error).message}`),
        );
      };
      purge();
      purgeInterval = setInterval(purge, 24 * 60 * 60 * 1000);
      purgeInterval.unref();
      tickInterval = setInterval(() => {
        daemon.tick().catch((e: unknown) => log(`tick: ${(e as Error).message}`));
      }, 60_000);
      tickInterval.unref();
      // The heartbeat of the attempts (ORC-220): their leases, in the store.
      beatInterval = setInterval(() => {
        daemon.supervise().catch((e: unknown) => log(`heartbeat: ${(e as Error).message}`));
      }, RUN_BEAT_MS);
      beatInterval.unref();
      if (await connectLinear()) {
        // « Connect Linear » creates them at its callback; a team connected before Spec was a default gets it here.
        await createMissingStatuses(linearTracker!, fromLinear, log);
        void reconciler.once();
      }
      else log(`Linear not connected: open ${baseUrl}/oauth/start`);
      // The worker (ORC-149) executes the effects decided before a crash, then the events written
      // before it (or whose processing failed), oldest first; it then polls the inbox and the outbox
      // every second, for what another process wrote and for leases that expired.
      daemon.startWorker().catch((e: unknown) => log(`inbox: ${(e as Error).message}`));
      // The replays `factory ghost start` wrote (ORC-376): each ticket rebuilt delegated to its project, at start and then each minute.
      if (replaying.length) replays.start();
      if (!isUsableWebhookSecret(webhookSecret()))
        log('Warning: no Linear webhook secret configured, every webhook will be refused. Run factory init again to set it.');
      if (!isUsableWebhookSecret(githubSecret))
        log('GitHub webhooks refused: neither github.webhookSecret nor GH_WEBHOOK_SECRET; only the reconciliation every 5 min follows GitHub.');
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
