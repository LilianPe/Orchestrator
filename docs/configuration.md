# Configuration du démon

Relais se configure à trois niveaux :

| Niveau | Fichier | Portée | Doc |
|---|---|---|---|
| Instance | `<RELAIS_HOME>/config.yaml` | Le démon : port, hôte, projets, relais webhook, budget journalier, base de connaissance. | cette page |
| Secrets | `<RELAIS_HOME>/secrets.json` | Identifiants Linear. | cette page |
| Projet | `.relais/workflow.yml` dans chaque dépôt | Comportement : événements, jobs, modèles, limites par run, vérifications. | [`workflow.md`](workflow.md) |

Les deux fichiers d'instance sont lus **au démarrage** de `relais up` : redémarrez après une modification.

## Variables d'environnement

| Variable | Lue par | Défaut | Effet | Secret |
|---|---|---|---|---|
| `RELAIS_HOME` | toutes les commandes `relais` | `$HOME/.relais` | Répertoire de l'instance (voir [`installation.md`](installation.md#le-répertoire-home-du-démon)). | non |
| `RELAIS_UI_PASSWORD` | `relais up`, `relais status/pause/resume/stop` | — | Mot de passe HTTP Basic de l'interface et de l'API. **Obligatoire** dès que `host` n'est pas une adresse de bouclage : sans lui, `relais up` refuse de démarrer. Ignoré quand `host` est en bouclage. Voir [`interface-et-securite.md`](interface-et-securite.md). | **oui** |
| `FACTORY_DATABASE_URL` | `relais up`, `relais plan` | — | Chaîne de connexion Postgres (`postgres://utilisateur:mot-de-passe@hôte:5432/base`). Définie, le démon garde son état dans Postgres (`PgStore`) et applique les migrations Drizzle de `drizzle/` au démarrage (`relais plan` la lit sans la migrer) ; une base injoignable empêche le démarrage, sans repli sur SQLite. Absente : base SQLite `relais.db`, jusqu'à son retrait (ORC-178). Jamais transmise aux runs (préfixe `FACTORY_`), jamais écrite dans le journal du démon. | **oui** |
| `FACTORY_CONTAINER_CLI` | `relais up` | — | `docker` ou `podman`. Définie, chaque tentative tourne dans un conteneur jetable (ORC-204) : créé à son lancement, détruit à sa fin, et ceux qu'un crash a laissés le sont au démarrage suivant. Le `setup` du dépôt y tourne aussi. Absente : les runs tournent sur l'hôte, sans isolation, et le démon l'écrit au démarrage. Sans effet avec `--fake-runner`. Voir [`interface-et-securite.md`](interface-et-securite.md#limites-connues). | non |
| `FACTORY_RUNNER_IMAGE` | `relais up` | — | Image des conteneurs de run (`docker/runner.Dockerfile` : node et pnpm, python et uv, git, claude). Requise avec `FACTORY_CONTAINER_CLI`. | non |
| `FACTORY_EGRESS_CONTROL` | `relais up` | — | Socket de contrôle du service `proxy` (ORC-203). Définie, le démon pilote ce service au lieu de faire tourner le proxy de sortie dans son processus. | non |
| `FACTORY_INSTALL_DIR` | `docker/entrypoint.sh` | — | Où copier l'installation, à un chemin que le moteur voit sur l'hôte ; le démon tourne depuis cette copie, une par image ([`deploiement.md`](deploiement.md#pourquoi-les-mêmes-chemins-des-deux-côtés)). | non |
| `FACTORY_ALLOW_ROOTFUL_ENGINE` | `docker/entrypoint.sh` | — | `1` : laisse démarrer le conteneur du démon sur un moteur qui n'est pas rootless. Poste de développement seulement. | non |
| `FACTORY_COMMIT` | `relais up` | fixée à la construction de l'image | Commit de l'usine, relevé sur chaque tentative. | non |
| `FACTORY_AGENT_PORT` | `relais up` | port de l'interface + 1 | Port du serveur qui ne sert que `/agent/*`, pour les conteneurs. Démarré seulement avec `FACTORY_CONTAINER_CLI`. | non |
| `FACTORY_AGENT_HOST` | `relais up` | `127.0.0.1` | Adresse d'écoute de ce serveur. Les conteneurs le joignent par le proxy de sortie du démon (ORC-213), pas par le réseau : la boucle locale suffit. Sous compose, `0.0.0.0` : le service `proxy` le joint par le réseau interne. | non |
| `FACTORY_SANDBOX_AGENT_HOST` | `relais up` | `host.docker.internal` | Nom du démon dans le `RELAIS_API` des runs (`http://<nom>:<FACTORY_AGENT_PORT>/agent`). Le conteneur ne le résout pas : le proxy de sortie reconnaît ce nom et relaie vers le serveur de l'API agent. | non |
| `FACTORY_SANDBOX_PIDS` | `relais up` | `512` | Nombre maximal de processus d'un conteneur de run (`--pids-limit`) : une fork bomb bute dessus sans affamer les autres tentatives (ORC-218). `0` ou `none` : pas de limite. Une valeur qui n'est pas un entier positif empêche le démarrage. | non |
| `FACTORY_SANDBOX_MEMORY` | `relais up` | `4g` | Mémoire d'un conteneur de run, sans swap au-delà (`--memory` et `--memory-swap`) : un gouffre mémoire est tué par l'OOM. Taille au format du moteur (`512m`, `4g`). `0` ou `none` : pas de limite. | non |
| `FACTORY_SANDBOX_CPUS` | `relais up` | `2`, ou le nombre de CPU de l'hôte s'il en a moins | CPU d'un conteneur de run (`--cpus`, décimal accepté : `0.5`). `0` ou `none` : pas de limite. | non |
| `FACTORY_DENY_PUSH` | `relais up` | — | `1` : le démon la transmet aux runs, et le hook `PreToolUse` du pack y refuse aussi `git push` et les écritures `gh` (`gh pr create`, `gh pr edit`, `gh pr merge`, `gh run rerun`), avec une ligne au journal des refus. Toute autre valeur : rien n'est transmis, les skills du pack poussent et ouvrent leurs PR (jusqu'à ORC-125). Voir [`pack-et-skills.md`](pack-et-skills.md#hook-pretooluse-et-journal-des-refus). | non |
| `FACTORY_REFUSALS_LOG` | `relais up` | `$CLAUDE_CONFIG_DIR/factory-refusals.jsonl` | Fichier du journal des refus du hook `PreToolUse` ; transmis aux runs sur l'hôte seulement s'il est défini. En sandbox, ignoré : chaque run écrit dans `<RELAIS_HOME>/runs/<runId>/refusals/refusals.jsonl` (ORC-217). Voir [`pack-et-skills.md`](pack-et-skills.md#hook-pretooluse-et-journal-des-refus). | non |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude`, en sandbox et sur l'hôte | — | Jeton du compte Claude Code quand `factory.yml` n'en choisit pas (`claude.active`). | **oui** |
| `ANTHROPIC_API_KEY` | `claude`, sur l'hôte seulement | — | Authentification de Claude Code sur l'hôte, sans `claude login` ni compte actif. Jamais transmise à un sandbox (ORC-211) ; retirée avec les runs sur l'hôte (ORC-179). | **oui** |
| `GH_TOKEN` | `gh`, les agents sur l'hôte et, en Docker, git via `gh auth setup-git` | — | Authentification GitHub des agents sur l'hôte et du repli `gh` du démon. Jamais transmis à un sandbox. Obligatoire en Docker tant que ORC-125 n'a pas retiré `gh`. | **oui** |
| `GH_APP_ID` | démon (repli de `github.appId`) | — | Identifiant de la GitHub App d'usine. | non |
| `GH_APP_KEY` | démon (repli de `github.privateKey`) | — | Clé privée PEM de la GitHub App, ou chemin vers le fichier `.pem`. | **oui** |
| `GH_APP_INSTALLATION_ID` | démon (repli de `github.installationId`) | — | Installation de l'App à utiliser ; facultatif, le démon sait la retrouver par dépôt. | non |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | git (hérité par les runs) | identité git de la machine ; en Docker `Relais <relais@localhost>` | Identité des commits des agents. | non |
| `PATH` | le démon | — | Doit contenir `claude`, `gh`, `git`. Relais y ajoute `bin/` de Relais pour les runs. | non |

Variables réservées aux tests (sans effet sur le démon) : `LINEAR_API_KEY` (test live des requêtes Linear), `FACTORY_E2E=1` (test du pack avec le vrai `claude`). Voir [`recette.md`](recette.md#vérifications-live-optionnelles).

Variables **posées par Relais** dans l'environnement de chaque run (à ne pas définir vous-même) : `RELAIS_API`, `RELAIS_RUN_TOKEN`, `RELAIS_TICKET`, `RELAIS_KNOWLEDGE`, `RELAIS_ROOT`, `PATH`, `FACTORY_DENY_PUSH` quand le démon l'a à `1`, `FACTORY_REFUSALS_LOG` quand le démon l'a (en sandbox, toujours, vers le dossier du run), `FACTORY_READ_MAX_LINES` quand `factory.yml` déclare `read_guard.max_lines`, `FACTORY_FULL_READ_PATHS` quand un fichier doit être lu en entier et, pour la file `dev`, `PORT`. Voir [« Ce qui ne sort pas du démon »](#ce-qui-ne-sort-pas-du-démon). Dans un conteneur, ces chemins sont ceux du conteneur : `RELAIS_ROOT=/factory/app` (le `bin/` de Relais et ce qu'il lui faut, montés en lecture seule), `RELAIS_KNOWLEDGE=/factory/knowledge` (en lecture seule), et un `PATH` propre au conteneur, jamais celui de l'hôte.

## `config.yaml`

Écrit par `relais init`, modifiable à la main. Fichier absent = toutes les valeurs par défaut. Un champ invalide empêche le démarrage avec `config.yaml invalide : <champ>: <message>`.

| Clé | Type | Défaut | Effet |
|---|---|---|---|
| `port` | entier > 0 | `4100` | Port du serveur HTTP (interface, API, webhooks, OAuth). Aussi le port que la CLI interroge (`http://127.0.0.1:<port>`). |
| `host` | texte | `127.0.0.1` | Adresse d'écoute. Toute valeur hors bouclage (`localhost`, `127.x.x.x`, `::1`) exige `RELAIS_UI_PASSWORD`. En Docker : `0.0.0.0`. |
| `publicUrl` | URL | — | URL publique de Relais (tunnel ou domaine). Si elle est définie, elle sert de base aux URL de callback OAuth (`<publicUrl>/oauth/callback`) et de webhook (`<publicUrl>/webhooks/linear`), et `relais init` ne crée pas de canal smee. Sans elle : `http://localhost:<port>`. |
| `relay` | `{ kind: smee, url: <URL> }` ou `{ kind: none }` | `{ kind: none }` | Relais des webhooks Linear. `relais init` crée un canal smee.io quand il n'y a ni `publicUrl` ni relais. Voir [`linear.md`](linear.md#3-webhooks--smee-ou-url-publique). |
| `projects` | liste de `{ id, repoPath, linearTeamKey, authz? }` | `[]` | Un projet = un dépôt local + une équipe Linear. Voir [`projets-et-workspaces.md`](projets-et-workspaces.md). `authz` : voir [Autorisations](#autorisations). |
| `limits.perDayUsd` | nombre > 0 | — (pas de plafond) | Budget journalier de toute l'instance, en dollars. Voir [Budget journalier](#budget-journalier). |
| `knowledge.repoPath` | chemin | — | Clone local du dépôt de base de connaissance. Absent : les jobs `learn` et `remember` sont ignorés et `relais-agent kb search` ne renvoie rien. |
| `github` | `{ appId, privateKey, installationId?, webhookSecret? }` | — | GitHub App du démon. Absent : repli sur la CLI `gh`. Voir [GitHub App](#github-app). |

Exemple :

```yaml
port: 4100
host: 127.0.0.1
relay:
  kind: smee
  url: https://smee.io/AbCdEf123
projects:
  - id: mon-app
    repoPath: /home/moi/code/mon-app
    linearTeamKey: APP
    authz: # facultatif, voir « Autorisations »
      maintainers: [6f1c2e0a-0000-4000-8000-000000000001]
      validators: [6f1c2e0a-0000-4000-8000-000000000002]
      githubLogins:
        6f1c2e0a-0000-4000-8000-000000000001: lilian-gh
        6f1c2e0a-0000-4000-8000-000000000002: armand-gh
limits:
  perDayUsd: 40
knowledge:
  repoPath: /home/moi/.relais/knowledge
github:
  appId: "123456"
  privateKey: /home/moi/.relais/github-app.pem
  installationId: "987654" # facultatif
```

### GitHub App

La section `github` configure l'identité du **démon** sur GitHub. Elle est facultative : sans elle, Relais utilise la CLI `gh` et `GH_TOKEN` comme avant (repli de migration, retiré après ORC-125).

| Clé | Type | Défaut | Effet |
|---|---|---|---|
| `github.appId` | texte ou entier | — | App ID de la GitHub App. |
| `github.privateKey` | texte | — | Clé privée PEM **inline**, ou chemin vers un fichier `.pem` (recommandé, mode `0600`). |
| `github.installationId` | texte ou entier | découverte par dépôt | Installation à utiliser. Absent : le démon appelle `GET /repos/{owner}/{repo}/installation`. |
| `github.webhookSecret` | texte | `GH_WEBHOOK_SECRET` | Secret des webhooks GitHub (`POST /webhooks/github`, signature `X-Hub-Signature-256`). Absent : la variable `GH_WEBHOOK_SECRET` ; sans l'un ni l'autre, tout webhook GitHub est refusé (401). Voir [`github.md`](github.md#webhooks-github). |

Les variables `GH_APP_ID`, `GH_APP_KEY` et `GH_APP_INSTALLATION_ID` servent de repli, champ par champ. Une configuration partielle (`appId` sans clé, ou l'inverse) empêche le démarrage : Relais ne bascule pas silencieusement sur `gh`.

Le démon échange un JWT RS256 contre un **jeton d'installation limité au dépôt** demandé, le garde en mémoire au plus une heure (marge de sécurité de 60 s) et ne le transmet jamais aux runs. Permissions, création de l'App et rotation de clé : [`github.md`](github.md#github-app-recommandé).

> **Cible.** La section vit encore dans `config.yaml` : le passage à `factory.yml` est suivi par ORC-209. Les variables d'environnement resteront le repli pour Docker et les installations existantes.

### Autorisations

`projects[].authz` donne les rôles de la [matrice d'autorisations](linear.md#autorisations--qui-peut-faire-quoi) qu'aucune source ne fournit (ORC-186). Tout s'écrit en **ids d'utilisateur Linear** (UUID, par exemple `query { users { nodes { id name } } }` dans l'explorateur GraphQL de Linear) : ce sont les ids que portent les webhooks signés.

| Clé | Type | Défaut | Effet |
|---|---|---|---|
| `authz.maintainers` | liste d'ids Linear | `[]` | Mainteneurs désignés : eux seuls pourront `/refreeze` (branché par ORC-131). |
| `authz.validators` | liste d'ids Linear | `[]` | Valideurs désignés : eux seuls pourront valider une spec, jamais celle d'un run qu'ils ont lancé (branché par ORC-212). |
| `authz.githubLogins` | table id Linear → login GitHub | `{}` | Le login GitHub de chaque utilisateur Linear dont les droits sur le dépôt comptent. Sans entrée, un utilisateur n'a aucun droit GitHub, donc ne peut pas déclencher l'agent ni (avec ORC-148) merger par *Done*. |

Les membres de l'équipe Linear et les droits GitHub ne se configurent pas : ils sont lus (Linear, puis la GitHub App ou `gh`) et relus toutes les 60 s. L'App n'a besoin que de *Metadata* en lecture pour lire la permission d'un utilisateur.

> **Cible.** Ces désignations passeront dans `.factory/config.yml` (ORC-209), et la matrice elle-même dans le préréglage `factory/default` (ORC-187).

### Budget journalier

`limits.perDayUsd` plafonne la somme des coûts des runs depuis minuit **UTC**. Le coût d'un run est celui rapporté par Claude Code à la fin du run.

Quand le plafond est atteint : aucun nouveau run ne démarre, les demandes restent en file et Relais commente une fois par ticket et par jour « Budget journalier de Relais atteint : ce ticket reste en file jusqu'à demain (ou jusqu'à une hausse du plafond). ». Les runs déjà lancés vont au bout. La file repart d'elle-même au changement de jour (le démon réévalue la file toutes les minutes) ou après un redémarrage avec un plafond relevé.

Le coût du jour et le plafond sont affichés dans l'interface et par `relais status`. Les plafonds **par run** (tours, durée, dollars) se règlent dans `workflow.yml` ([`workflow.md`](workflow.md#limits)).

### Ports

- `port` (4100) : le serveur Relais.
- `workspace.ports.base` (4200, dans `workflow.yml`) : chaque run de la file `dev` reçoit `PORT = base + n° de place`, de `base` à `base + parallel_sessions - 1`. Utile si l'agent lance un serveur de dev. Ces ports doivent être libres sur la machine.

## `secrets.json`

Écrit par `relais init` (identifiants de l'application) puis par la connexion OAuth (jetons), toujours en mode `0600`.

```json
{
  "linear": {
    "clientId": "…",
    "clientSecret": "…",
    "webhookSecret": "…",
    "accessToken": "…",
    "refreshToken": "…",
    "expiresAt": 1760000000000,
    "appUserId": "…",
    "organizationId": "…"
  }
}
```

| Champ | Source | Rôle |
|---|---|---|
| `clientId`, `clientSecret` | saisis pendant `relais init` | OAuth et rafraîchissement du jeton. |
| `webhookSecret` | saisi pendant `relais init` (obligatoire) | Vérifie la signature HMAC des webhooks Linear. Vide ou absent : tous les webhooks sont refusés (401). |
| `accessToken`, `refreshToken`, `expiresAt` | « Connecter Linear » | Jeton de l'application, rafraîchi automatiquement. |
| `appUserId`, `organizationId` | « Connecter Linear » | Identité de l'agent dans Linear (sert à lister les tickets qui lui sont délégués). |

Relancer `relais init` avec le **même** client ID conserve les jetons ; avec un autre, il faut reconnecter Linear.

## `factory.yml` (ORC-209)

`<FACTORY_HOME>/factory.yml` est la configuration serveur de l'usine. Il est **facultatif** et coexiste avec `config.yaml` et `secrets.json` jusqu'à leur retrait (ORC-199). Tout secret s'y écrit `env:NOM` et se lit dans l'environnement du démon : un secret en clair est refusé. Il est lu **une fois, au démarrage** : un fichier invalide empêche `factory up` de démarrer, avec le chemin de la clé fautive, et une modification faite pendant que le démon tourne ne compte qu'au prochain démarrage. Seuls `factory up`, `factory doctor` (GitHub App) et `factory plan` (identifiants Linear) le lisent, avec l'environnement du démon ; les autres commandes (`status`, `stop`, `init`…) s'en passent, et marchent donc dans un shell qui n'a pas ses variables.

```yaml
linear:   { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }
github:   { app_id: env:GH_APP_ID, private_key: env:GH_APP_KEY, webhook_secret: env:GH_WEBHOOK_SECRET }
claude:
  runtime: claude-code
  accounts:
    - { name: compte-1, token: env:CLAUDE_TOKEN_1 }
  active: compte-1
  default_model: claude-sonnet-5-5
  per_step: { review: claude-opus-5-5 }
  effort: { default: medium, per_step: { spec_draft: high, review: high } }
concurrency: 1
budgets: { max_turns: { build: 150, fix: 60, review: 25 }, on_usage_limit: wait }
repos:
  - linear_team: ORC
    github: LilianPe/Orchestrator
    env: { NODE_ENV: test }                 # les valeurs de ce que .factory/config.yml déclare sous env
    secrets: { NPM_TOKEN: env:ORC_NPM_TOKEN } # et sous setup_secrets : env:NOM seulement, 8 caractères au moins
read_guard: { max_lines: 350 }
```

| Section | Effet aujourd'hui |
| -- | -- |
| `github` | **Appliquée** : ses clés remplacent celles de `github` dans `config.yaml` ; une clé qu'il ne déclare pas (`installation_id`, `webhook_secret`) reste celle de `config.yaml`. |
| `linear` | **Appliquée** : `app_client_id`, `client_secret` et `webhook_secret` remplacent ceux de `secrets.json`. Les jetons OAuth restent dans `secrets.json`, écrits par « Connecter Linear ». |
| `claude` | **`accounts` et `active` appliqués** (ORC-211) : le jeton du compte actif est le seul identifiant du runner. Le reste du choix de compte avec ORC-215, l'effort par étape avec ORC-136. |
| `concurrency` | **Appliquée** (ORC-203) : capacité de la file `dev`, à la place de `limits.parallel_sessions` du workflow. La file `questions` garde `question_sessions`. |
| `budgets` | Validée, pas encore lue : appliquée par ORC-216. |
| `repos` | **`env` et `secrets` appliqués** (ORC-211), l'entrée étant trouvée par le remote `origin` du projet : voir [`configuration-depot.md`](configuration-depot.md#variables-et-secrets). Pour le reste, `projects[].repoPath` de `config.yaml` reste la copie de travail tant que le runner ne clone pas lui-même (ORC-204). |
| `read_guard` | **Appliquée** : `max_lines` (entier positif, 350 sans cette clé) est le nombre de lignes au-delà duquel le hook du pack refuse une lecture complète ([ORC-279](pack-et-skills.md#lecture-complète-dun-gros-fichier)). Il compte à partir du prochain démarrage. |

`factory.yml` n'est lu qu'à la lecture : `init` et l'écriture des jetons ne recopient jamais une de ses valeurs dans `config.yaml` ou `secrets.json`. Ses secrets sont masqués dans les transcripts des runs, comme ceux de `secrets.json`.

## Ce qui ne sort pas du démon

Le démon détient les secrets ; les runs Claude Code n'en ont pas besoin et ne doivent pas y accéder.

1. **Environnement des runs par liste blanche (ORC-211).** En sandbox, un run reçoit ses variables de run (`FACTORY_API`, `FACTORY_RUN_TOKEN`, jeton aléatoire valable pendant le run, `FACTORY_TICKET`…), les réglages du hook du pack, sans secret (`FACTORY_READ_MAX_LINES`, `FACTORY_FULL_READ_PATHS`), les variables que le dépôt déclare ([`configuration-depot.md`](configuration-depot.md#variables-et-secrets)) et le jeton du compte `claude.active` sous `CLAUDE_CODE_OAUTH_TOKEN` (sans `factory.yml`, celui du démon de ce nom) : rien d'autre, ni `ANTHROPIC_API_KEY`, ni `ANTHROPIC_BASE_URL`, ni `GH_TOKEN`. Sur l'hôte, un run reçoit en plus le système (`PATH`, `HOME`, `LANG`, `TMPDIR`…), l'identité des commits (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) et, en transition, `GH_TOKEN` (jusqu'à ORC-125) et `ANTHROPIC_API_KEY` (jusqu'à ORC-179, retirée dès qu'un compte actif existe). Toute autre variable reste dans le démon.
2. **Linear passe par `relais-agent`.** L'agent ne voit jamais le jeton Linear : il appelle l'API locale avec son jeton de run, qui ne donne accès qu'au ticket du run, à la recherche, à la base de connaissance et à la question (`ask`). Voir [`cli.md`](cli.md#relais-agent-côté-agent).
3. **`run-settings.json`.** À chaque `relais up`, Relais écrit `<RELAIS_HOME>/run-settings.json` : les permissions du pack (`packs/standard/settings.json`) plus des refus sur le **vrai** chemin de `RELAIS_HOME` : `Read`/`Edit` de `secrets.json`, `Read` de `relais.db*`, `transcripts/**`, `logs/**`, et toute commande Bash qui mentionne `secrets.json` ou `relais.db`. Ce fichier est passé à chaque run par `--settings`. Les worktrees (`workspaces/`) restent lisibles.
4. **Jeton GitHub App hors des runs.** Le jeton d'installation est demandé pour le seul dépôt du run, conservé en mémoire du démon et jamais monté dans l'environnement du runner ni écrit dans un transcript. `GH_TOKEN` reste transmis aux agents **sur l'hôte, temporairement**, car `gh` leur sert encore à ouvrir et lire les PR ; ORC-125 retirera cette variable. Voir [`github.md`](github.md#jetons).

Limite connue : ces refus sont des garde-fous de Claude Code, pas une frontière de sécurité. Un agent qui exécute du code (`node`, `npm`) avec le même utilisateur système que le démon peut lire `secrets.json`. Détails et conséquences : [`interface-et-securite.md`](interface-et-securite.md#limites-connues).
