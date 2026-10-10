# Relais — spec du MVP

Date : 2026-10-10 · Statut : validé (design approuvé en session) · Cadrage produit : https://claude.ai/artifact/YM3ZxphNt9sKYT6QqtLxT7

## 1. Objectif

Relais est un orchestrateur d'agents de code. Il prend les tickets Linear délégués à son app user, lance une session Claude Code par ticket dans un worktree isolé, fait passer le ticket par une review humaine puis une review IA, et le rend prêt à merger. Le workflow est décrit en YAML ; la logique métier vit dans des skills (« packs »), jamais dans le cœur.

Le MVP est un **prototype personnel qui tourne en local**, conçu pour qu'une équipe le déploie ensuite sur AWS sans réécriture.

### Critères de réussite (recette manuelle sur un Linear de test)

1. `npx relais init` dans un dépôt : en moins de 15 minutes, l'app OAuth Linear est installée (`actor=app`), les statuts et labels manquants sont créés, le canal webhook est configuré, `.relais/workflow.yml` est écrit.
2. `relais up` démarre le démon et l'interface sur `http://localhost:4100` ; on y voit en direct la file, les places, le journal d'événements et la sortie des sessions.
3. Déléguer un ticket à `@relais` : la session Linear accuse réception en moins de 10 s, le ticket passe en « En cours », une PR est ouverte, les vérifications tournent, le ticket arrive en « Review humaine » avec un résumé.
4. Deux remarques écrites dans le fil de la session à moins de 3 minutes d'écart sont traitées en une seule reprise de **la même** session Claude ; l'agent répond dans le fil avec le commit.
5. Déplacer le ticket en « Review IA » lance la review-loop en session neuve ; succès → « Prêt à merger » + synthèse. Merger la PR → « Terminé » + nettoyage du worktree.
6. `@relais <question>` sur n'importe quel ticket → réponse en lecture seule dans le fil. `@relais retiens ça` → PR sur le dépôt de connaissance. Après merge, une nouvelle session voit cette connaissance au démarrage.
7. Un « Send stop request » dans Linear arrête la session en cours en moins de 10 s.
8. `docker compose up` démarre la même chose sur une machine Linux (preuve de déploiement AWS).

### Hors périmètre du MVP

Paliers de risque, étape « plan à valider », évals de packs, plusieurs dépôts par ticket, trackers autres que Linear, runners autres que Claude Code, GitHub App, Postgres, UI d'édition de config, multi-instance, SaaS. Les interfaces (Tracker, Forge, Runner, Store) existent pour les ajouter plus tard.

## 2. Principes non négociables

1. **Linear et git sont la vérité.** Le Store ne garde que les exécutions (runs, sessions, worktrees, ports, coûts, file, minuteries). Une réconciliation au démarrage et toutes les 30 s reconstruit l'état.
2. **Aucun LLM pour ordonnancer.** Le moteur est une fonction pure : `(événement, état) → commandes`.
3. **La logique métier vit dans les packs.** Le cœur ne contient aucun prompt métier ; il compose un prompt à partir d'un gabarit du pack.
4. **Vérifier hors de l'agent.** Lint, types et tests du job sont lancés par Relais ; le verdict vient de leurs codes de sortie.
5. **Jamais `--bare`.** Le runner passe toujours `--plugin-dir` et `--settings` du pack.
6. **Tout est plafonné** : sessions parallèles, tours, durée, budget par run, tokens par jour, tentatives de vérification, rounds de review. Un plafond atteint → ticket bloqué avec un commentaire, jamais d'échec silencieux.
7. **Idempotence.** Chaque événement a une clé ; le rejouer ne relance rien.
8. **Le jeton Linear ne sort jamais du démon.** L'agent passe par `relais-agent`, qui appelle l'API locale avec un jeton de run.

## 3. Concepts

| Terme | Définition |
|---|---|
| Projet | Un dépôt git local + une équipe Linear. MVP : une équipe = un dépôt. |
| État logique | `todo`, `dev`, `human_review`, `ai_review`, `ready`, `done` (+ drapeau `blocked`). Mappé vers des statuts Linear par nom. |
| Événement | Fait normalisé venant de Linear, GitHub, d'une minuterie ou de l'UI (§6). |
| Règle | Entrée `on:` du workflow : événement + condition → action(s). |
| Job | Unité de travail d'un agent : runner, modèle, skill/prompt, workspace, vérifications, issues. |
| Run | Une exécution d'un job (une invocation `claude -p`). |
| Session | La session Claude d'un ticket (UUID), reprise de run en run. Distincte de la session d'agent Linear. |
| Place (slot) | Capacité d'exécution parallèle (défaut 3). Les jobs `queue: questions` ont leur propre file (défaut 2). |

## 4. Architecture et arborescence

```
relais/
├─ package.json            # type: module, bin: relais, relais-agent
├─ src/
│  ├─ cli/                 # relais (init, up, plan, status, pause, resume, stop) + relais-agent
│  ├─ config/              # instance config, workflow.yml (zod), fusion avec le pack
│  ├─ core/
│  │  ├─ events.ts         # types d'événements
│  │  ├─ commands.ts       # types de commandes
│  │  ├─ conditions.ts     # mini-langage when:
│  │  ├─ engine.ts         # fonction pure decide()
│  │  ├─ scheduler.ts      # places, file, debounce, budgets
│  │  └─ orchestrator.ts   # boucle : événement → decide → exécuter commandes
│  ├─ store/               # interface Store + implémentation node:sqlite
│  ├─ adapters/
│  │  ├─ tracker/          # interface Tracker, linear/, fake/
│  │  ├─ forge/            # interface Forge, gh-cli/, fake/
│  │  ├─ runner/           # interface Runner, claude-code/, fake/
│  │  └─ workspace/        # worktrees + ports
│  ├─ knowledge/           # dépôt de connaissance
│  ├─ server/              # Hono : webhooks, OAuth, API UI, API agent, SSE
│  └─ relay/               # client smee
├─ packs/standard/         # plugin Claude Code + workflow.yml par défaut
├─ web/                    # UI React + Vite
├─ test/                   # scénarios bout-en-bout avec faux adaptateurs
└─ Dockerfile, compose.yaml
```

Flux : sources (webhook Linear, webhook relayé par smee, poll GitHub, réconciliation, UI) → `EventBus` → `Orchestrator` lit l'état du ticket dans le Store → `decide()` → commandes → exécuteurs (Tracker, Forge, Runner, Workspace, Store, Scheduler) → nouveaux événements (`run.finished`, `verify.failed`…) et diffusion SSE.

## 5. Configuration

### 5.1 Configuration d'instance : `~/.relais/` (surchargeable par `RELAIS_HOME`)

- `config.yaml` : `port` (4100), `publicUrl` (optionnel), `relay: { kind: smee, url }` ou `{ kind: none }`, `projects: [{ id, repoPath, linearTeamKey }]`, `limits.perDay.usd`, `knowledge: { repoPath, remote }`.
- `secrets.json` (mode 600) : `linear: { clientId, clientSecret, webhookSecret, accessToken, refreshToken?, appUserId, organizationId }`.
- `relais.db` (SQLite), `transcripts/`, `workspaces/`, `logs/`.

### 5.2 Workflow de projet : `<repo>/.relais/workflow.yml`

Optionnel ; absent = pack standard pur. Schéma validé par zod, erreurs affichées avec chemin YAML.

```yaml
version: 1
extends: standard            # pack (dossier packs/<nom>) ; MVP : seulement "standard"
tracker:
  kind: linear
  team: REL
  pickup:
    checks: [has_description, not_started]   # §7.6
    order: [priority, created]
states:                      # état logique → nom du statut Linear
  todo: "Todo"
  dev: "In Progress"
  human_review: "Human Review"
  ai_review: "AI Review"
  ready: "Ready to Merge"
  done: "Done"
limits:
  parallel_sessions: 3
  question_sessions: 2
  per_run: { turns: 150, duration: 90m, usd: 5 }
  verify_attempts: 2
  review_rounds: 5
workspace:
  setup: ["npm ci"]          # lancées par Relais dans le worktree, avant le job
  ports: { base: 4200 }
on: { ... }                  # §8
jobs: { ... }                # §8
```

**Fusion avec le pack** : objets fusionnés récursivement ; tableaux remplacés ; dans `on:`, une clé d'événement du projet remplace celle du pack ; dans `jobs:`, un job du projet est fusionné champ par champ avec celui du pack ; `extends:` dans un job copie un autre job avant fusion.

## 6. Événements normalisés

Chaque événement porte `id` (clé d'idempotence), `type`, `at`, `projectId`, `ticketId?` (identifiant Linear, ex. `REL-12`) et un `payload` typé.

| Type | Source | Payload |
|---|---|---|
| `ticket.delegated` | AgentSessionEvent `created` sans commentaire déclencheur, ou délégué découvert par réconciliation | `linearSessionId?` |
| `session.mentioned` | AgentSessionEvent `created` avec `agentSession.comment` | `linearSessionId`, `body`, `commentId` |
| `session.prompted` | AgentSessionEvent `prompted` (sans signal) | `linearSessionId`, `body`, `activityId` |
| `session.stopped` | `prompted` avec `signal: "stop"`, ou retrait de la délégation | `linearSessionId?` |
| `ticket.moved` | Webhook `Issue` update avec `updatedFrom.stateId` | `from`, `to` (états logiques ou `null` si non mappé) |
| `label.added` | Webhook `Issue` update, diff de `labelIds` | `label` (nom) |
| `command` | Mention dont le corps commence par un mot de `commands` (§8) | `name`, `body`, `linearSessionId` |
| `pr.opened` / `pr.checks_passed` / `pr.checks_failed` / `pr.merged` / `pr.closed` | Poll `gh` (§10) | `number`, `url`, `branch` |
| `run.finished` | Runner | `runId`, `job`, `outcome: success|failure|stopped|limit`, `summary`, `costUsd`, `turns` |
| `verify.passed` / `verify.failed` | Vérificateur | `runId`, `job`, `failures[]` |
| `debounce.fired` | Scheduler | `ruleKey` |
| `slot.freed` | Scheduler | — |
| `control.pause` / `control.resume` / `control.stop` | UI ou CLI | `ticketId?` |

Les échos de nos propres écritures sont ignorés : chaque écriture Linear de Relais enregistre `(ticketId, champ, valeur)` dans le Store pendant 60 s ; un webhook qui ne fait que la refléter ne produit pas d'événement.

## 7. Moteur

### 7.1 État d'un ticket (Store)

`TicketState = { ticketId, projectId, logical, blocked, claudeSessionId?, linearSessionId?, branch?, prNumber?, prUrl?, worktreePath?, port?, activeRunId?, queued?: JobName, verifyAttempts, reviewRounds, pendingFeedback: FeedbackItem[], costUsd, updatedAt }`.

### 7.2 `decide(event, ticket, workflow, ctx) → Command[]`

Fonction pure. Pour l'événement, prend la liste des règles de `on[event.type]` et garde la **première** dont les filtres (`from`, `to`, `label`, `say`, `job`) et la condition `when` passent. Traduit son action en commandes. Aucune règle → `[]` (l'événement est seulement journalisé).

### 7.3 Mini-langage `when`

Expressions : `state == <logical>`, `state != <logical>`, `state in [a, b]`, `job == <name>` (job du run actif ou du run terminé), `blocked`, `!blocked`, combinées par `&&`. Rien d'autre. Parse au chargement ; erreur de syntaxe = workflow refusé.

### 7.4 Actions de règle

`run: <job>` ou `run: [a, b]` (enchaînés : `b` démarre au `run.finished` succès de `a`), `move: <logical>`, `label: { add: [], remove: [] }`, `comment: <template>`, `do: stop | cleanup | propose_delegate`, `debounce: <durée>` (combiné à `run`). Commandes produites :

`StartRun{job, resume}`, `EnqueueRun{job}`, `ResumeWithFeedback{job}`, `StopRun`, `MoveTicket{to}`, `Labels{add, remove}`, `Comment{body}`, `Activity{kind, body, ephemeral}`, `SetDebounce{key, ms, then}`, `AppendFeedback{item}`, `Cleanup`, `MarkBlocked{reason, question?}`, `Unblock`, `UpdateTicket{patch}`.

### 7.5 Places, file et budgets

- `StartRun` sur un job de file `dev` alors que les places sont pleines → `EnqueueRun` ; l'ordre de sortie suit `pickup.order`. `slot.freed` dépile.
- Budget du jour (`limits.perDay.usd` de l'instance) dépassé → la file est suspendue, les tickets restent en `todo` avec un commentaire unique.
- Pause globale : aucun nouveau run ; les runs en cours continuent.

### 7.6 Contrôles de prise en charge (`pickup.checks`)

`has_description` (description ≥ 30 caractères), `not_started` (aucune branche `relais/<id>-*` ni PR ouverte pour l'ID), `has_acceptance_criteria` (la description contient « critères d'acceptation » ou « acceptance criteria », insensible à la casse). Un contrôle en échec → `MarkBlocked` avec la raison, le ticket reste en `todo`, une activité `elicitation` l'explique.

### 7.7 Debounce

`SetDebounce{key, ms}` (clé `ticketId:ruleKey`) arme ou réarme une minuterie persistée dans le Store (survit au redémarrage). À échéance → `debounce.fired`. Pendant l'attente, chaque `session.prompted` ajoute un `FeedbackItem` à `pendingFeedback` et réarme.

### 7.8 Paquet de retours

À la reprise, le prompt contient : les `pendingFeedback` (texte, auteur, date), les commentaires de review GitHub non résolus de la PR (`gh api`), et le diff de description si elle a changé depuis le dernier run. Le paquet est vidé quand le run démarre.

### 7.9 Vérifications et issues de job

Après un run `success`, Relais lance `verify` du job dans le worktree (chaque commande, séquentiellement, sortie capturée, timeout 15 min). Échec → `verify.failed` → reprise de la même session avec les sorties tronquées (8 000 caractères par commande), jusqu'à `verify_attempts` ; au-delà → `MarkBlocked`. Succès → `verify.passed` → `on_success` du job. Run `failure` / `limit` → `on_failure` (défaut : `MarkBlocked` + elicitation).

### 7.10 Arrêt

`session.stopped`, `control.stop` ou `label agent:stop` → `StopRun` (SIGINT, puis SIGKILL après 10 s), activité `response` « Arrêté. État : … », ticket `blocked`. Pas d'autre action tant qu'un humain ne relance pas (réponse dans le fil ou label `agent:reprendre`).

## 8. Workflow par défaut (`packs/standard/workflow.yml`)

```yaml
version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: dev }
  ticket.moved:
    - { from: human_review, to: dev, run: dev-feedback }
    - { to: ai_review, run: review }
  session.prompted:
    - { when: "blocked", run: dev-feedback, debounce: 0s }
    - { when: "state in [dev, human_review]", run: dev-feedback, debounce: 3m }
  session.mentioned:
    - { run: ask }
  command:
    - { say: retiens, run: remember }
    - { say: "fais-le", do: propose_delegate }
  label.added:
    - { label: "agent:reprendre", run: dev-feedback }
    - { label: "agent:stop", do: stop }
  session.stopped:
    - { do: stop }
  pr.checks_failed:
    - { when: "state in [human_review, ai_review] && !blocked", run: fix-ci }
  pr.merged:
    - { move: done, do: cleanup, run: learn }
jobs:
  dev:
    queue: dev
    model: sonnet
    workspace: worktree
    session: new
    skill: relais:dev
    verify: []                 # le projet fournit ses commandes
    on_start: { move: dev }
    on_success: { move: human_review, post: summary }
  dev-feedback:
    extends: dev
    session: resume
    skill: relais:feedback
    input: feedback
    on_start: {}
    on_success: { post: reply }
  fix-ci:
    extends: dev-feedback
    input: ci_failures
  review:
    queue: dev
    model: opus
    workspace: worktree
    session: new
    skill: relais:review
    on_success: { move: ready, post: synthesis }
  ask:
    queue: questions
    model: sonnet
    workspace: trunk-readonly
    session: new
    skill: relais:ask
    limits: { turns: 30, duration: 5m, usd: 0.5 }
    on_success: { post: reply }
  learn:
    queue: questions
    model: haiku
    workspace: knowledge
    session: new
    skill: relais:learn
    on_success: {}
  remember:
    extends: learn
    input: thread
    on_success: { post: reply }
```

`post: summary | reply | synthesis` : le dernier message texte de l'agent est publié comme activité `response` dans la session Linear (donc comme commentaire). `on_start.move` déplace le ticket au démarrage du run.

## 9. Adaptateur Linear

- **OAuth** : `https://linear.app/oauth/authorize?client_id=…&redirect_uri=http://localhost:4100/oauth/callback&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app&state=<csrf>`. Échange du code sur `https://api.linear.app/oauth/token`. Après installation : `viewer { id }` → `appUserId`, `organization { id }`.
- **Webhooks** : l'app OAuth est configurée avec les catégories « Agent session events », « Issues », « Comments ». Vérification : HMAC-SHA256 du corps brut avec `webhookSecret`, comparé à l'en-tête `linear-signature` (comparaison en temps constant) ; `webhookTimestamp` à moins de 60 s. Réponse HTTP en moins de 5 s : le récepteur journalise et pousse dans le bus, rien de plus.
- **Session d'agent** : sur `created`, activité `thought` « Pris en compte » immédiatement (avant tout autre traitement), puis l'événement normalisé. Les activités du run sont relayées avec un débit maximal d'une activité toutes les 2 s : `action` éphémère pour les appels d'outils (nom + paramètre court), `thought` éphémère pour le texte intermédiaire, `response` / `elicitation` / `error` pour les messages finaux. L'URL de la PR est ajoutée via `agentSessionUpdate.addedExternalUrls`.
- **Statuts** : `workflowStates(filter: { team: { key: { eq } } })` mis en cache ; `move` résout le nom configuré, à défaut le premier statut `started` (position minimale) pour `dev`. `init` crée les statuts manquants (`workflowStateCreate`, type `started` pour human_review/ai_review/ready).
- **Réconciliation** (démarrage + toutes les 30 s) : issues de l'équipe dont `delegate.id == appUserId` et statut non terminé → crée/complète `TicketState`, émet `ticket.delegated` si aucun run ni état connu ; ticket délégué retiré → `session.stopped`.
- **Contexte du prompt** : `promptContext` du webhook quand il existe, sinon titre + description + 20 derniers commentaires.

## 10. Adaptateur GitHub (`gh` CLI)

- Branche : `relais/<id-en-minuscules>-<slug-du-titre, 40 car. max>`.
- Le skill `relais:dev` pousse et ouvre la PR (`gh pr create --fill --head <branche>`), corps contenant `Fixes <ID>` ; Relais la retrouve par `gh pr list --head <branche> --state all --json number,url,state,mergedAt`.
- Poll toutes les 30 s des tickets ayant une branche : `gh pr checks <n> --json name,state,bucket` → `pr.checks_passed` / `pr.checks_failed` sur transition ; `state == MERGED` → `pr.merged` ; `CLOSED` → `pr.closed`.
- Commentaires de review non résolus : `gh api graphql` sur `reviewThreads(isResolved: false)`.

## 11. Workspaces

- `worktree` : `git -C <repo> fetch origin` puis `git worktree add <RELAIS_HOME>/workspaces/<project>/<id> -b <branche> origin/<tronc>` (tronc = branche par défaut de `origin`). Réutilisé s'il existe déjà pour le ticket. Port = `ports.base + index de place`. `setup` lancé une fois à la création.
- `trunk-readonly` : worktree détaché partagé `<RELAIS_HOME>/workspaces/<project>/_trunk` mis à jour (`git checkout --detach origin/<tronc>`) avant chaque run ; l'agent y est lancé en `--permission-mode plan` (lecture seule).
- `knowledge` : clone du dépôt de connaissance, une branche par run `learn/<id>-<horodatage>`.
- `Cleanup` : `git worktree remove --force` du worktree du ticket, libération du port. Jamais sur un worktree d'un autre ticket.

## 12. Runner Claude Code

Commande (cwd = workspace) :

```
claude -p <prompt> --output-format stream-json --verbose
  (--session-id <uuid> | --resume <uuid>)
  --model <model> --plugin-dir <pack> --settings <pack>/settings.json
  --setting-sources project,local
  --max-budget-usd <per_run.usd> [--permission-mode plan]
```

`--setting-sources project,local` est obligatoire : sans lui, la session hérite du `CLAUDE.md`, des hooks et des plugins de l'utilisateur de la machine (vérifié). Les skills du pack s'invoquent sous le nom du plugin : `/relais:dev`, `/relais:feedback`, etc.

Environnement ajouté : `RELAIS_API=http://127.0.0.1:<port>/agent`, `RELAIS_RUN_TOKEN=<aléatoire>`, `RELAIS_TICKET=<id>`, `RELAIS_KNOWLEDGE=<chemin>`, `PORT=<port>`.

- Parse ligne à ligne du flux JSON : `system/init` (session_id), `assistant` (blocs `text` et `tool_use`), `user` (`tool_result`), `result` (`total_cost_usd`, `num_turns`, `is_error`, `result`). Chaque ligne est écrite dans `transcripts/<runId>.jsonl` et diffusée en SSE.
- Plafonds : nombre de messages `assistant` > `turns` ou durée > `duration` → SIGINT, issue `limit`.
- Issue : `result.is_error == false` → `success` ; sinon `failure` ; arrêt demandé → `stopped`.
- Le prompt est construit par `buildPrompt(job, ticket, input)` : `/<skill>` + bloc « Ticket » + bloc d'entrée (`feedback`, `ci_failures`, `thread`, `verify_failures`).

## 13. Pack standard (`packs/standard/`)

Plugin Claude Code (`.claude-plugin/plugin.json`) contenant :

- Plugin nommé `relais` ; `skills/dev`, `feedback`, `review`, `ask`, `learn` (invoqués `/relais:dev`…) : instructions écrites de zéro (aucun contenu repris d'un dépôt tiers).
- `hooks/hooks.json` + `hooks/session-start.sh` : injecte les règles toujours actives (français dans les messages Linear, ne jamais merger, ne jamais déclarer « fini » sans vérifications vertes, utiliser `relais-agent` pour Linear) et l'index de la base de connaissance (§14). Sortie testée : code 0 et JSON `hookSpecificOutput.additionalContext`.
- `settings.json` : `permissions.allow` (lecture/édition de fichiers, `git` sauf push forcé, `gh pr create|view|list`, `npm`/`npx`/`node`, `relais-agent`), `permissions.deny` (`git push --force*`, `git push -f*`, `gh pr merge*`, `rm -rf /*`, lecture de `~/.relais/**`), `defaultMode: acceptEdits`.
- `workflow.yml` (§8).

## 14. Base de connaissance

- Niveau 1 : `docs/agent/*.md` dans chaque dépôt projet (lu par l'agent comme tout fichier).
- Niveau 2 : dépôt git `knowledge.repoPath` (créé par `init` : dépôt GitHub privé `relais-knowledge`), avec `INDEX.md` (une ligne par fiche) et `notes/*.md` (frontmatter `title`, `tags`, `source`).
- Niveau 3 : transcripts locaux + Linear, interrogés via `relais-agent search`.
- Écriture : uniquement par les jobs `learn`/`remember`, sur une branche, puis `gh pr create` dans le dépôt de connaissance. Jamais d'écriture directe sur la branche principale.
- Lecture : le hook SessionStart injecte `INDEX.md` (tronqué à 8 000 caractères) ; `relais-agent kb search <mots>` fait un grep sur `notes/`.
- Le pull du dépôt de connaissance est fait par Relais avant chaque run.

## 15. API locale et `relais-agent`

Serveur Hono sur `127.0.0.1:<port>` (et `0.0.0.0` seulement si `publicUrl` est défini, pour `/webhooks/*` et `/oauth/*`).

- `/webhooks/linear` (POST), `/oauth/start`, `/oauth/callback`.
- `/api/state` (GET : tickets, runs actifs, places, coût du jour, pause), `/api/events` (SSE : événements, commandes, lignes de transcript), `/api/runs/:id/transcript` (GET), `/api/control/pause|resume` (POST), `/api/tickets/:id/stop` (POST). Pas d'authentification en local ; liaison 127.0.0.1 uniquement.
- `/agent/*` exige `Authorization: Bearer <RELAIS_RUN_TOKEN>` d'un run actif : `GET /agent/issue/:id`, `GET /agent/search?q=`, `GET /agent/kb/search?q=`, `POST /agent/ask` (pose une elicitation et met le ticket en blocked).
- `relais-agent` : CLI minimal (`issue <ID>`, `search <q>`, `kb search <q>`, `ask <texte>`) qui lit `RELAIS_API` et `RELAIS_RUN_TOKEN`.

## 16. Interface (`web/`)

Une page, rafraîchie par SSE :
- Bandeau : places `n/m`, file, coût du jour / plafond, bouton Pause/Reprendre.
- Tableau des tickets : ID, titre, état logique, bloqué, job en cours, tours, coût, attend qui (agent / humain), actions (Stop, ouvrir dans Linear, ouvrir la PR).
- Journal des événements (100 derniers, filtrable par ticket).
- Panneau de run : sortie en direct (texte, appels d'outils repliables, résultat).

## 17. CLI `relais`

- `init` : assistant interactif (§1.1) — demande client id/secret de l'app OAuth en affichant les valeurs exactes à saisir dans Linear (callback URL, webhook URL, catégories), crée un canal smee (`https://smee.io/new`), lance l'OAuth, crée statuts/labels manquants, propose de créer `relais-knowledge` via `gh repo create --private`, écrit `config.yaml`, `secrets.json`, `.relais/workflow.yml`.
- `up` : démon + serveur + relais smee + UI ; `--fake-runner` pour tester sans tokens.
- `plan` : à blanc — liste les tickets délégués, ceux qui seraient pris, dans quel ordre, et pourquoi les autres non.
- `status`, `pause`, `resume`, `stop <ID>` : appels à l'API locale.

## 18. Sécurité

- `secrets.json` en 600 ; jamais journalisé ; jamais passé à l'agent.
- Signatures webhook vérifiées ; corps refusé sinon (401).
- Permissions de l'agent par `settings.json` du pack ; une suite de tests du pack vérifie que chaque interdit est refusé (§20).
- `relais-agent` limité au ticket du run (sauf `search` / `kb`).

## 19. Déploiement

`Dockerfile` (node:24-slim + git + gh + claude CLI), `compose.yaml` montant `RELAIS_HOME` en volume, `publicUrl` + `relay: none` en production. Identique au mode local sinon.

## 20. Tests

- Unitaires (Vitest) : config/fusion, conditions, `decide()` (table de cas par règle du pack), scheduler (places, file, debounce avec horloge simulée), Store, parse du flux stream-json (fixtures), vérification de signature, mapping des webhooks (fixtures JSON).
- Scénarios (`test/scenarios/`) : orchestrateur complet avec `FakeTracker`, `FakeForge`, `FakeRunner`, horloge simulée — un scénario par critère de réussite 3 à 7.
- Pack : test du hook SessionStart (sortie JSON, code 0) ; test des permissions via un run Claude réel optionnel (`RELAIS_E2E=1`), exclu de la CI.
- Recette manuelle documentée dans `docs/recette.md` sur un Linear de test.

## 21. Risques

Vérifiés le 2026-10-10 (Claude Code 2.1.296) :
1. En `-p`, une commande interdite (`permissions.deny`) est refusée ; une commande hors liste qui sort du répertoire de travail est refusée sans bloquer la session.
2. `--plugin-dir` charge les skills (namespacés `<plugin>:<skill>`) et le hook `SessionStart` (`additionalContext` visible par l'agent).
3. `--setting-sources project,local` isole la session des réglages et du `CLAUDE.md` de l'utilisateur, l'authentification restant celle de la machine.

Restant à vérifier pendant l'implémentation : acceptation par Linear de l'URL de callback `http://localhost:4100/oauth/callback` (repli : URL smee ne convient pas pour l'OAuth ; documenter alors un tunnel `cloudflared` pour l'installation seulement).
