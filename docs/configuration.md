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
| `ANTHROPIC_API_KEY` | `claude` (hérité par les runs) | — | Authentification de Claude Code si vous n'utilisez pas `claude login`. Obligatoire en Docker. | **oui** |
| `GH_TOKEN` | `gh`, les agents et, en Docker, git via `gh auth setup-git` | — | Authentification GitHub des agents et du repli `gh` du démon. Obligatoire en Docker tant que ORC-125 n'a pas retiré `gh`. | **oui** |
| `GH_APP_ID` | démon (repli de `github.appId`) | — | Identifiant de la GitHub App d'usine. | non |
| `GH_APP_KEY` | démon (repli de `github.privateKey`) | — | Clé privée PEM de la GitHub App, ou chemin vers le fichier `.pem`. | **oui** |
| `GH_APP_INSTALLATION_ID` | démon (repli de `github.installationId`) | — | Installation de l'App à utiliser ; facultatif, le démon sait la retrouver par dépôt. | non |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | git (hérité par les runs) | identité git de la machine ; en Docker `Relais <relais@localhost>` | Identité des commits des agents. | non |
| `PATH` | le démon | — | Doit contenir `claude`, `gh`, `git`. Relais y ajoute `bin/` de Relais pour les runs. | non |

Variables réservées aux tests (sans effet sur le démon) : `LINEAR_API_KEY` (test live des requêtes Linear), `FACTORY_E2E=1` (test du pack avec le vrai `claude`). Voir [`recette.md`](recette.md#vérifications-live-optionnelles).

Variables **posées par Relais** dans l'environnement de chaque run (à ne pas définir vous-même) : `RELAIS_API`, `RELAIS_RUN_TOKEN`, `RELAIS_TICKET`, `RELAIS_KNOWLEDGE`, `RELAIS_ROOT`, `PATH` et, pour la file `dev`, `PORT`. Voir [« Ce qui ne sort pas du démon »](#ce-qui-ne-sort-pas-du-démon).

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

`<FACTORY_HOME>/factory.yml` est la configuration serveur de l'usine. Il est **facultatif** et coexiste avec `config.yaml` et `secrets.json` jusqu'à leur retrait (ORC-199). Tout secret s'y écrit `env:NOM` et se lit dans l'environnement du démon : un secret en clair est refusé. Un fichier invalide empêche `factory up` de démarrer, avec le chemin de la clé fautive.

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
  - { linear_team: ORC, github: LilianPe/Orchestrator }
```

| Section | Effet aujourd'hui |
| -- | -- |
| `github` | **Appliquée** : remplace `github` de `config.yaml` (App, clé, secret des webhooks). |
| `linear` | **Appliquée** : `app_client_id`, `client_secret` et `webhook_secret` remplacent ceux de `secrets.json`. Les jetons OAuth restent dans `secrets.json`, écrits par « Connecter Linear ». |
| `claude` | Validée, pas encore lue : comptes et choix du compte avec ORC-215, effort par étape avec ORC-136. |
| `concurrency` | Validée, pas encore lue : la file prend encore `parallel_sessions`. |
| `budgets` | Validée, pas encore lue : appliquée par ORC-216. |
| `repos` | Validée, pas encore lue : `projects[].repoPath` de `config.yaml` reste la copie de travail tant que le runner ne clone pas lui-même (ORC-204). |

`factory.yml` n'est lu qu'à la lecture : `init` et l'écriture des jetons ne recopient jamais une de ses valeurs dans `config.yaml` ou `secrets.json`. Ses secrets sont masqués dans les transcripts des runs, comme ceux de `secrets.json`.

## Ce qui ne sort pas du démon

Le démon détient les secrets ; les runs Claude Code n'en ont pas besoin et ne doivent pas y accéder.

1. **Environnement des runs filtré.** Chaque run hérite de l'environnement du démon **sans** aucune variable `RELAIS_*` ni `LINEAR_*` (donc ni `RELAIS_UI_PASSWORD`, ni une éventuelle clé Linear). Relais pose ensuite seulement `RELAIS_API` (API locale `http://127.0.0.1:<port>/agent`), `RELAIS_RUN_TOKEN` (jeton aléatoire valable pendant le run), `RELAIS_TICKET`, `RELAIS_KNOWLEDGE`, `RELAIS_ROOT` et `PATH`. Les autres variables (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `GIT_*`…) sont transmises : l'agent en a besoin pour travailler.
2. **Linear passe par `relais-agent`.** L'agent ne voit jamais le jeton Linear : il appelle l'API locale avec son jeton de run, qui ne donne accès qu'au ticket du run, à la recherche, à la base de connaissance et à la question (`ask`). Voir [`cli.md`](cli.md#relais-agent-côté-agent).
3. **`run-settings.json`.** À chaque `relais up`, Relais écrit `<RELAIS_HOME>/run-settings.json` : les permissions du pack (`packs/standard/settings.json`) plus des refus sur le **vrai** chemin de `RELAIS_HOME` : `Read`/`Edit` de `secrets.json`, `Read` de `relais.db*`, `transcripts/**`, `logs/**`, et toute commande Bash qui mentionne `secrets.json` ou `relais.db`. Ce fichier est passé à chaque run par `--settings`. Les worktrees (`workspaces/`) restent lisibles.
4. **Jeton GitHub App hors des runs.** Le jeton d'installation est demandé pour le seul dépôt du run, conservé en mémoire du démon et jamais monté dans l'environnement du runner ni écrit dans un transcript. `GH_TOKEN` reste transmis aux agents **temporairement**, car `gh` leur sert encore à ouvrir et lire les PR ; ORC-125 retirera cette variable. Voir [`github.md`](github.md#jetons).

Limite connue : ces refus sont des garde-fous de Claude Code, pas une frontière de sécurité. Un agent qui exécute du code (`node`, `npm`) avec le même utilisateur système que le démon peut lire `secrets.json`. Détails et conséquences : [`interface-et-securite.md`](interface-et-securite.md#limites-connues).
