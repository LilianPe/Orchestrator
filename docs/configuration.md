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
| `ANTHROPIC_API_KEY` | `claude` (hérité par les runs) | — | Authentification de Claude Code si vous n'utilisez pas `claude login`. Obligatoire en Docker. | **oui** |
| `GH_TOKEN` | `gh` et, en Docker, git via `gh auth setup-git` | — | Authentification GitHub si vous n'utilisez pas `gh auth login`. Obligatoire en Docker. | **oui** |
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
| `projects` | liste de `{ id, repoPath, linearTeamKey }` | `[]` | Un projet = un dépôt local + une équipe Linear. Voir [`projets-et-workspaces.md`](projets-et-workspaces.md). |
| `limits.perDayUsd` | nombre > 0 | — (pas de plafond) | Budget journalier de toute l'instance, en dollars. Voir [Budget journalier](#budget-journalier). |
| `knowledge.repoPath` | chemin | — | Clone local du dépôt de base de connaissance. Absent : les jobs `learn` et `remember` sont ignorés et `relais-agent kb search` ne renvoie rien. |

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
limits:
  perDayUsd: 40
knowledge:
  repoPath: /home/moi/.relais/knowledge
```

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

## Ce qui ne sort pas du démon

Le démon détient les secrets ; les runs Claude Code n'en ont pas besoin et ne doivent pas y accéder.

1. **Environnement des runs filtré.** Chaque run hérite de l'environnement du démon **sans** aucune variable `RELAIS_*` ni `LINEAR_*` (donc ni `RELAIS_UI_PASSWORD`, ni une éventuelle clé Linear). Relais pose ensuite seulement `RELAIS_API` (API locale `http://127.0.0.1:<port>/agent`), `RELAIS_RUN_TOKEN` (jeton aléatoire valable pendant le run), `RELAIS_TICKET`, `RELAIS_KNOWLEDGE`, `RELAIS_ROOT` et `PATH`. Les autres variables (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `GIT_*`…) sont transmises : l'agent en a besoin pour travailler.
2. **Linear passe par `relais-agent`.** L'agent ne voit jamais le jeton Linear : il appelle l'API locale avec son jeton de run, qui ne donne accès qu'au ticket du run, à la recherche, à la base de connaissance et à la question (`ask`). Voir [`cli.md`](cli.md#relais-agent-côté-agent).
3. **`run-settings.json`.** À chaque `relais up`, Relais écrit `<RELAIS_HOME>/run-settings.json` : les permissions du pack (`packs/standard/settings.json`) plus des refus sur le **vrai** chemin de `RELAIS_HOME` : `Read`/`Edit` de `secrets.json`, `Read` de `relais.db*`, `transcripts/**`, `logs/**`, et toute commande Bash qui mentionne `secrets.json` ou `relais.db`. Ce fichier est passé à chaque run par `--settings`. Les worktrees (`workspaces/`) restent lisibles.

Limite connue : ces refus sont des garde-fous de Claude Code, pas une frontière de sécurité. Un agent qui exécute du code (`node`, `npm`) avec le même utilisateur système que le démon peut lire `secrets.json`. Détails et conséquences : [`interface-et-securite.md`](interface-et-securite.md#limites-connues).
