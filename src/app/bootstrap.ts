import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { GhCliForge } from '../adapters/forge/gh-cli.js';
import { GitHubAppForge } from '../adapters/forge/github-app.js';
import { PrPoller } from '../adapters/forge/pr-poller.js';
import { ClaudeCodeRunner } from '../adapters/runner/claude-code.js';
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
import { homePaths, loadInstance, loadSecrets, saveSecrets } from '../config/instance.js';
import { resolveGithubApp } from '../config/github-app.js';
import { writeRunSettings } from '../config/run-settings.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { EventBus } from '../core/bus.js';
import { SystemClock } from '../core/clock.js';
import { logicalFromName, Orchestrator, type ProjectRuntime } from '../core/orchestrator.js';
import { Scheduler } from '../core/scheduler.js';
import { TimerService } from '../core/timers.js';
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

const FACTORY_LABELS = ['agent:reprendre', 'agent:stop'];

export async function startFactory(o: BootOptions): Promise<{ url: string; stop(): Promise<void> }> {
  const log = o.log ?? ((m: string) => console.log(`[factoryd] ${m}`));
  const root = repoRoot();
  const packDir = join(root, 'packs/standard');
  const webDir = join(root, 'web/dist');
  const instance = loadInstance(o.home);
  const env = o.env ?? process.env;
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

  const { store, kind } = await openStore({ env, sqlitePath: paths.db, migrationsFolder: join(root, 'drizzle') });
  log(kind === 'postgres' ? 'store : Postgres (migrations Drizzle appliquées)' : `store : SQLite (${paths.db})`);
  const clock = new SystemClock();
  const bus = new EventBus();
  bus.subscribe((m) => {
    if (m.kind === 'log' && m.message !== 'ping') log(`${m.level}: ${m.message}`);
  });

  const trackerSwitch = new TrackerSwitch(port);
  let linearTracker: LinearTracker | undefined;
  const tokenManager = () => {
    const linear = loadSecrets(o.home).linear;
    if (!linear) return undefined;
    return new TokenManager({
      clientId: linear.clientId,
      clientSecret: linear.clientSecret,
      load: () => {
        const l = loadSecrets(o.home).linear;
        return l?.accessToken ? { accessToken: l.accessToken, refreshToken: l.refreshToken, expiresAt: l.expiresAt } : undefined;
      },
      save: (t) => {
        const s = loadSecrets(o.home);
        if (s.linear) saveSecrets(o.home, { ...s, linear: { ...s.linear, ...t } });
      },
    });
  };
  const connectLinear = async () => {
    const tm = tokenManager();
    const appUserId = loadSecrets(o.home).linear?.appUserId;
    if (!tm || !appUserId) return false;
    const api = new LinearApi(() => tm.get());
    linearTracker = new LinearTracker(api, appUserId);
    for (const p of projects) await linearTracker.warm(p.teamKey).catch((e: Error) => log(`warm ${p.teamKey}: ${e.message}`));
    trackerSwitch.set(linearTracker);
    return true;
  };

  const scheduler = new Scheduler(store, { dev: limits?.parallelSessions ?? 3, questions: limits?.questionSessions ?? 2 });
  const runner: Runner = o.fakeRunner ? new FakeRunner() : new ClaudeCodeRunner({ transcriptsDir: paths.transcripts });
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

  const orchestrator = new Orchestrator({
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
  const submit = (e: Parameters<Orchestrator['submit']>[0]) => void orchestrator.submit(e);

  const webhookSecret = () => loadSecrets(o.home).linear?.webhookSecret ?? '';
  const ingest = createLinearIngest({
    secret: webhookSecret,
    submit,
    ack: (sessionId) => trackerSwitch.activity(sessionId, { type: 'thought', body: 'Pris en compte.' }),
    log,
    ctx: {
      projectIdForTeam: (k) => projects.find((p) => p.teamKey === k)?.id,
      logicalFor: (pid, name) => {
        const p = projects.find((x) => x.id === pid);
        return p ? (logicalFromName(p.workflow.states, name) ?? null) : null;
      },
      stateNameById: (t, id) => linearTracker?.stateNameById(t, id),
      labelNameById: (t, id) => linearTracker?.labelNameById(t, id),
      isEcho: (k) => store.isEcho(k, clock.now()),
      commands: (pid) => projects.find((p) => p.id === pid)?.workflow.commands ?? [],
      now: () => clock.now(),
    },
  });

  const reconciler = new Reconciler({ tracker: trackerSwitch, store, projects, submit, clock, log });
  const timers = new TimerService(store, clock, submit, (e) => log(`timers: ${e.message}`));
  const poller = new PrPoller({ store, forge, projects, submit, clock, log });

  const oauthStates = new Set<string>();
  const app = createApp({
    knowledgeSearch: kb ? (q) => kb.search(q) : undefined,
    store,
    bus,
    clock,
    submit,
    isPaused: () => orchestrator.isPaused(),
    linearWebhook: ingest,
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
    oauth: loadSecrets(o.home).linear
      ? {
          authorizeUrl: () => {
            const state = randomBytes(16).toString('hex');
            oauthStates.add(state);
            return buildAuthorizeUrl({ clientId: loadSecrets(o.home).linear!.clientId, redirectUri: `${baseUrl}/oauth/callback`, state });
          },
          callback: async (code, state) => {
            if (!oauthStates.delete(state)) throw new Error('état OAuth inconnu, relancez la connexion');
            const s = loadSecrets(o.home);
            const tokens = await exchangeCode({ clientId: s.linear!.clientId, clientSecret: s.linear!.clientSecret, code, redirectUri: `${baseUrl}/oauth/callback` });
            saveSecrets(o.home, { ...s, linear: { ...s.linear!, ...tokens } });
            const api = new LinearApi(async () => tokens.accessToken);
            const who = await api.gql<{ viewer: { id: string }; organization: { id: string } }>(Q.viewer);
            const s2 = loadSecrets(o.home);
            saveSecrets(o.home, { ...s2, linear: { ...s2.linear!, appUserId: who.viewer.id, organizationId: who.organization.id } });
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
  timers.start();
  const tickInterval = setInterval(() => {
    orchestrator.tick().catch((e: unknown) => log(`tick: ${(e as Error).message}`));
  }, 60_000);
  tickInterval.unref();
  poller.start();
  if (await connectLinear()) {
    await orchestrator.announceRecovery();
    reconciler.start();
  }
  else log(`Linear non connecté : ouvrez ${baseUrl}/oauth/start`);
  if (!isUsableWebhookSecret(webhookSecret()))
    log('Attention : aucun secret de webhook Linear configuré, tout webhook sera refusé. Relancez factory init pour le renseigner.');
  log(`${PRODUCT_NAME} écoute sur ${baseUrl}`);

  return {
    url: baseUrl,
    async stop() {
      clearInterval(tickInterval);
      relay?.close();
      timers.stop();
      poller.stop();
      reconciler.stop();
      orchestrator.stopAll();
      await orchestrator.idle();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Long-lived SSE streams (/api/events) would otherwise keep close() pending forever.
        (server as unknown as { closeAllConnections(): void }).closeAllConnections();
      });
      await store.close();
    },
  };
}
