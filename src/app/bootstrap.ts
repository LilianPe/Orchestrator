import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { GhCliForge } from '../adapters/forge/gh-cli.js';
import { GitHubAppForge } from '../adapters/forge/github-app.js';
import { createGithubIngest, githubMapContext, githubRepoOf } from '../adapters/forge/github-ingest.js';
import { PrPoller } from '../adapters/forge/pr-poller.js';
import { CachedRoleResolver } from '../adapters/roles/cached.js';
import { ClaudeCodeRunner } from '../adapters/runner/claude-code.js';
import { purgeTranscripts } from '../adapters/runner/transcript.js';
import { FakeRunner } from '../adapters/runner/fake.js';
import type { Runner } from '../adapters/runner/types.js';
import { LinearApi } from '../adapters/tracker/linear/api.js';
import { createLinearIngest } from '../adapters/tracker/linear/ingest.js';
import { buildAuthorizeUrl, exchangeCode, TokenManager } from '../adapters/tracker/linear/oauth.js';
import { Q } from '../adapters/tracker/linear/queries.js';
import { Reconciler } from '../adapters/tracker/linear/reconcile.js';
import { LinearTracker } from '../adapters/tracker/linear/tracker.js';
import { isUsableWebhookSecret } from '../adapters/tracker/linear/webhook.js';
import { GitWorkspaces } from '../adapters/workspace/git-workspaces.js';
import { daemonSecretValues, effectiveInstance, homePaths, linearSettings, saveLinearTokens } from '../config/instance.js';
import { githubWebhookSecret, resolveGithubApp } from '../config/github-app.js';
import { writeRunSettings } from '../config/run-settings.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { EventBus } from '../core/bus.js';
import { BLOCKED_LABEL } from '../core/engine.js';
import { SystemClock } from '../core/clock.js';
import { logicalFromName, Orchestrator, type ProjectRuntime } from '../core/orchestrator.js';
import { Scheduler } from '../core/scheduler.js';
import { TimerService } from '../runtime/timers.js';
import type { FactoryEvent } from '../core/types.js';
import { runVerify } from '../core/verify.js';
import { KnowledgeBase } from '../knowledge/kb.js';
import { startSmeeRelay } from '../relay/smee.js';
import { createApp } from '../server/app.js';
import { openStore } from '../store/open.js';
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

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

const FACTORY_LABELS = ['agent:reprendre', 'agent:stop', BLOCKED_LABEL];

export async function startFactory(o: BootOptions): Promise<{ url: string; stop(): Promise<void> }> {
  const log = o.log ?? ((m: string) => console.log(`[factoryd] ${m}`));
  const root = repoRoot();
  const packDir = join(root, 'packs/standard');
  const webDir = join(root, 'web/dist');
  const env = o.env ?? process.env;
  // config.yaml with what factory.yml declares over it (ORC-209); an invalid factory.yml stops the start here.
  const instance = effectiveInstance(o.home, env);
  const uiPassword = isLoopbackHost(instance.host) ? undefined : env['FACTORY_UI_PASSWORD'] || undefined;
  if (!isLoopbackHost(instance.host) && !uiPassword) {
    throw new Error(
      `host: ${instance.host} expose l'interface et l'API de ${PRODUCT_NAME} hors de cette machine. ` +
        "Définissez la variable d'environnement FACTORY_UI_PASSWORD (mot de passe de l'interface), ou remettez host: 127.0.0.1 dans config.yaml.",
    );
  }
  const paths = homePaths(o.home);
  const port = o.port ?? instance.port;
  const baseUrl = instance.publicUrl ?? `http://localhost:${port}`;
  const githubApp = resolveGithubApp(instance, env);
  const githubSecret = githubWebhookSecret(instance, env);

  const projects: ProjectRuntime[] = instance.projects.map((p) => {
    const projectFile = join(p.repoPath, '.factory/workflow.yml');
    return {
      id: p.id,
      repoPath: p.repoPath,
      teamKey: p.linearTeamKey,
      workflow: loadWorkflow({ packDir, projectFile: existsSync(projectFile) ? projectFile : undefined }),
    };
  });
  const limits = projects[0]?.workflow.limits;

  const { store, kind } = await openStore({ env, sqlitePath: paths.db, migrationsFolder: join(root, 'drizzle'), log });
  log(kind === 'postgres' ? 'store : Postgres (migrations Drizzle appliquées)' : `store : SQLite (${paths.db})`);
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
      const linear = linearSettings(o.home, env);
      if (!linear) return undefined;
      return new TokenManager({
        clientId: linear.clientId,
        clientSecret: linear.clientSecret,
        load: () => {
          const l = linearSettings(o.home, env);
          return l?.accessToken ? { accessToken: l.accessToken, refreshToken: l.refreshToken, expiresAt: l.expiresAt } : undefined;
        },
        save: (t) => saveLinearTokens(o.home, t),
      });
    };
    const connectLinear = async () => {
      const tm = tokenManager();
      const appUserId = linearSettings(o.home, env)?.appUserId;
      if (!tm || !appUserId) return false;
      const api = new LinearApi(() => tm.get());
      linearTracker = new LinearTracker(api, appUserId);
      for (const p of projects) await linearTracker.warm(p.teamKey).catch((e: Error) => log(`warm ${p.teamKey}: ${e.message}`));
      trackerSwitch.set(linearTracker);
      return true;
    };

    const scheduler = new Scheduler(store, { dev: limits?.parallelSessions ?? 3, questions: limits?.questionSessions ?? 2 });
    // The daemon's own secrets never enter a run's environment; masked all the same, should one surface.
    const daemonSecrets = () => [...daemonSecretValues(o.home, env), ...(githubSecret ? [githubSecret] : [])];
    const runner: Runner = o.fakeRunner ? new FakeRunner() : new ClaudeCodeRunner({ transcriptsDir: paths.transcripts, secrets: daemonSecrets });
    const workspaces = new GitWorkspaces({ root: paths.workspaces, knowledgeRepo: instance.knowledge?.repoPath });
    const forge = githubApp
      ? new GitHubAppForge({ ...githubApp, log })
      : new GhCliForge();
    if (githubApp) {
      log(
        `forge GitHub : GitHub App ${githubApp.appId} (jetons d'installation limités au dépôt du run` +
          `${githubApp.installationId ? `, installation ${githubApp.installationId}` : ", installation résolue par dépôt"})`,
      );
    } else {
      log('forge GitHub : CLI gh (repli de migration ; GH_TOKEN reste requis par les agents jusqu’à ORC-125)');
    }
    const kb = instance.knowledge ? new KnowledgeBase(instance.knowledge.repoPath) : undefined;
    // The roles of a human event's signed actor (ORC-186): Linear team members and GitHub rights, read
    // again past their TTL, and the designations of config.yaml.
    const roles = new CachedRoleResolver({
      projects: (id) => {
        const p = instance.projects.find((x) => x.id === id);
        return p && { teamKey: p.linearTeamKey, repoPath: p.repoPath, maintainers: [], validators: [], githubLogins: {}, ...p.authz };
      },
      team: {
        teamMembers: (teamKey) => (linearTracker ? linearTracker.teamMembers(teamKey) : Promise.reject(new Error('Linear non connecté'))),
      },
      repo: forge,
    });

    const orchestrator = new Orchestrator({
      // The sources start before Linear is connected: their events wait in the inbox until replayInbox().
      holdInboxUntilReplay: true,
      beforeRun: async () => {
        if (kb) await kb.pull();
      },
      store,
      clock,
      bus,
      scheduler,
      tracker: trackerSwitch,
      forge,
      runner,
      workspaces,
      verify: runVerify,
      projects,
      packDir,
      settingsPath: writeRunSettings(packDir, o.home),
      dailyBudgetUsd: instance.limits.perDayUsd,
      knowledgeConfigured: !!instance.knowledge,
      roles,
      agentEnv: (run) => ({
        FACTORY_API: `http://127.0.0.1:${port}/agent`,
        FACTORY_RUN_TOKEN: run.token,
        FACTORY_TICKET: run.ticketId,
        FACTORY_KNOWLEDGE: instance.knowledge?.repoPath ?? '',
        FACTORY_ROOT: root,
        PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
      }),
    });
    await orchestrator.recover();
    // Every source writes its events to the inbox and gets the promise of the committed row
    // (ORC-147); the orchestrator's worker then decides them from the inbox (ORC-149).
    const accept = (e: FactoryEvent) => orchestrator.accept(e);

    const webhookSecret = () => linearSettings(o.home, env)?.webhookSecret ?? '';
    const ingest = createLinearIngest({
      secret: webhookSecret,
      accept,
      // The time the ack was posted is the first sign of life a measure reads (ORC-235).
      ack: async (sessionId, eventId) => {
        await trackerSwitch.activity(sessionId, { type: 'thought', body: 'Pris en compte.' });
        await store.markAcked(eventId, clock.now()).catch((err: Error) => log(`ack of ${eventId} posted, its time not recorded: ${err.message}`));
      },
      log,
      ctx: {
        projectIdForTeam: (k) => projects.find((p) => p.teamKey === k)?.id,
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
      },
    });

    const reconciler = new Reconciler({ tracker: trackerSwitch, store, projects, submit: accept, clock, log });
    const timers = new TimerService(store, clock, () => orchestrator.wake(), (e) => log(`timers: ${e.message}`));
    const poller = new PrPoller({ store, forge, projects, submit: accept, clock, log });
    // GitHub webhooks (ORC-134) write to the inbox beside the poll, which stays until ORC-185 and ORC-181:
    // both name a fact the same way, so the inbox keeps it once.
    const githubIngest = createGithubIngest({
      secret: () => githubSecret,
      accept,
      log,
      ctx: githubMapContext({ store, forge, projects, repoOf: githubRepoOf(), now: () => clock.now() }),
    });

    const oauthStates = new Set<string>();
    const app = createApp({
      knowledgeSearch: kb ? (q) => kb.search(q) : undefined,
      store,
      bus,
      clock,
      submit: accept,
      isPaused: () => orchestrator.isPaused(),
      blockTicket: (projectId, ticketId, reason) => orchestrator.blockTicket(projectId, ticketId, reason),
      linearWebhook: ingest,
      githubWebhook: githubIngest,
      linearConnected: () => !!trackerSwitch.current,
      tracker: trackerSwitch,
      capacity: () => ({
        dev: { used: scheduler.inUse('dev'), total: limits?.parallelSessions ?? 3 },
        questions: { used: scheduler.inUse('questions'), total: limits?.questionSessions ?? 2 },
      }),
      dailyBudgetUsd: instance.limits.perDayUsd,
      transcriptsDir: paths.transcripts,
      webDir: existsSync(webDir) ? webDir : undefined,
      uiPassword,
      oauth: linearSettings(o.home, env)
        ? {
            authorizeUrl: () => {
              const state = randomBytes(16).toString('hex');
              oauthStates.add(state);
              return buildAuthorizeUrl({ clientId: linearSettings(o.home, env)!.clientId, redirectUri: `${baseUrl}/oauth/callback`, state });
            },
            callback: async (code, state) => {
              if (!oauthStates.delete(state)) throw new Error('état OAuth inconnu, relancez la connexion');
              const s = linearSettings(o.home, env)!;
              const tokens = await exchangeCode({ clientId: s.clientId, clientSecret: s.clientSecret, code, redirectUri: `${baseUrl}/oauth/callback` });
              saveLinearTokens(o.home, tokens);
              const api = new LinearApi(async () => tokens.accessToken);
              const who = await api.gql<{ viewer: { id: string }; organization: { id: string } }>(Q.viewer);
              saveLinearTokens(o.home, { appUserId: who.viewer.id, organizationId: who.organization.id });
              await connectLinear();
              await orchestrator.announceRecovery();
              for (const p of projects) {
                const created = await linearTracker!.ensureSetup(p.teamKey, p.workflow.states, FACTORY_LABELS);
                if (created.length) log(`Linear ${p.teamKey} : créé ${created.join(', ')}`);
              }
              reconciler.start();
            },
          }
        : undefined,
    });

    const server = serve({ fetch: app.fetch, port, hostname: instance.host });
    const relay = instance.relay.kind === 'smee' ? startSmeeRelay({ url: instance.relay.url, onWebhook: ingest, log }) : undefined;
    let purgeInterval: NodeJS.Timeout | undefined;
    let tickInterval: NodeJS.Timeout | undefined;
    // Everything but the store, which the caller closes after: by stop(), or by a start that fails from here on.
    const shutdown = async () => {
      clearInterval(tickInterval);
      clearInterval(purgeInterval);
      relay?.close();
      // A pass under way finishes first, so it never reads or writes a closed store.
      await Promise.all([timers.stop(), poller.stop(), reconciler.stop()]);
      orchestrator.stopAll();
      await orchestrator.drained();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Long-lived SSE streams (/api/events) would otherwise keep close() pending forever.
        (server as unknown as { closeAllConnections(): void }).closeAllConnections();
      });
    };
    try {
      timers.start();
      // Transcripts are kept 30 days (ORC-132): purged at start, then daily.
      const purge = () => {
        const removed = purgeTranscripts(paths.transcripts, Date.now());
        if (removed.length) log(`transcripts : ${removed.length} supprimé(s) après 30 jours`);
      };
      purge();
      purgeInterval = setInterval(purge, 24 * 60 * 60 * 1000);
      purgeInterval.unref();
      tickInterval = setInterval(() => {
        orchestrator.tick().catch((e: unknown) => log(`tick: ${(e as Error).message}`));
      }, 60_000);
      tickInterval.unref();
      poller.start();
      if (await connectLinear()) {
        await orchestrator.announceRecovery();
        reconciler.start();
      }
      else log(`Linear non connecté : ouvrez ${baseUrl}/oauth/start`);
      // The worker (ORC-149) executes the effects decided before a crash, then the events written
      // before it (or whose processing failed), oldest first; it then polls the inbox and the outbox
      // every second, for what another process wrote and for leases that expired.
      orchestrator.startWorker().catch((e: unknown) => log(`inbox : ${(e as Error).message}`));
      if (!isUsableWebhookSecret(webhookSecret()))
        log('Attention : aucun secret de webhook Linear configuré, tout webhook sera refusé. Relancez factory init pour le renseigner.');
      if (!isUsableWebhookSecret(githubSecret))
        log('Webhooks GitHub refusés : ni github.webhookSecret ni GH_WEBHOOK_SECRET ; seul le relevé des PR toutes les 30 s suit GitHub.');
    } catch (err) {
      await shutdown().catch((e: Error) => log(`arrêt après un démarrage manqué : ${e.message}`));
      throw err;
    }
    log(`${PRODUCT_NAME} écoute sur ${baseUrl}`);

    return {
      url: baseUrl,
      async stop() {
        await shutdown();
        await store.close();
      },
    };
  } catch (err) {
    await store.close().catch((e: Error) => log(`store : fermeture impossible (${e.message})`));
    throw err;
  }
}
