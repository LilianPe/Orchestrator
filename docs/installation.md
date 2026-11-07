# Installation

Cette page couvre l'installation de Relais sur une machine (poste de dev ou serveur sans Docker). Pour Docker, voir [`deploiement.md`](deploiement.md).

## Prérequis

| Outil | Version | Pourquoi |
|---|---|---|
| Node.js | **24.22.1 ou plus** (`engines.node: ">=24.22.1"`) | Le démon utilise `node:sqlite`, intégré à Node 24 ; 24.22.1 est le minimum corrigé de la release de sécurité d'octobre 2026. |
| npm | celui de Node 24 | Installation et build. |
| git | récent (worktrees) | Un worktree git par ticket. |
| GitHub CLI `gh` | **2.50 ou plus**, connecté (`gh auth login`) | Sans GitHub App, Relais lit par `gh pr …`, `gh api graphql` ; pousser et ouvrir les PR demande la GitHub App. Relais lit les checks d'une PR par `gh pr checks --json`, apparu en 2.50 : avant, il ne peut lire aucune PR ouverte (le `gh` des dépôts Ubuntu 24.04 est un 2.45, prenez celui de [cli.github.com](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)). Voir [`github.md`](github.md). |
| Claude Code CLI `claude` | connecté (abonnement ou `ANTHROPIC_API_KEY`) | Chaque run est un `claude -p … --output-format stream-json`. Il doit être dans le `PATH` du démon. |
| bash | — | Les commandes `workspace.setup` et `verify` sont lancées via `bash -lc`. |

Côté services : un espace Linear dont vous êtes admin (pour créer l'application OAuth, voir [`linear.md`](linear.md)) et un dépôt GitHub cloné localement.

La version exacte de Claude Code n'est pas figée par Relais. Elle doit accepter les options utilisées par le runner : `--output-format stream-json`, `--verbose`, `--session-id`, `--resume`, `--model`, `--plugin-dir`, `--settings`, `--setting-sources`, `--max-budget-usd` et `--permission-mode plan`. La recette ([`recette.md`](recette.md), « Points à vérifier ») liste ce qu'il faut contrôler sur la version installée.

## Installer Relais

```bash
git clone <url du dépôt relais> && cd relais
npm ci
npm run build      # compile dist/ et l'interface web/dist
npm link           # rend `relais` et `relais-agent` disponibles dans le PATH
```

`npm link` expose les deux exécutables déclarés dans `package.json` (`bin/relais`, `bin/relais-agent`). Ces scripts lancent `dist/src/cli/*.js` s'il existe, sinon les sources TypeScript via `tsx` : sans `npm run build`, la CLI fonctionne mais l'interface web n'est pas servie (le dossier `web/dist` manque).

Vérifier :

```bash
relais            # affiche l'aide (code de sortie 1, c'est normal)
```

## Configurer un premier dépôt

```bash
cd <votre dépôt>
relais init
```

L'assistant est décrit dans [`cli.md`](cli.md#relais-init) et la création de l'application Linear dans [`linear.md`](linear.md). Ensuite :

```bash
relais up                 # http://localhost:4100, puis « Connecter Linear »
```

Pour découvrir l'interface sans Linear ni Claude : `relais up --fake-runner` (les runs sont simulés et ne coûtent rien).

## Le répertoire home du démon

Tout l'état de l'instance vit dans **`RELAIS_HOME`**, par défaut `~/.relais` (`$HOME/.relais`). Changez-le avec la variable d'environnement `RELAIS_HOME` (le conteneur Docker utilise `/data`).

| Chemin | Contenu | Sensible |
|---|---|---|
| `config.yaml` | Configuration de l'instance : port, hôte, projets, relais webhook, budget, base de connaissance. Voir [`configuration.md`](configuration.md). | non |
| `secrets.json` | Identifiants et jetons Linear. Écrit en mode `0600`. Sous Windows, qui n'a pas de mode POSIX, le fichier hérite des droits (ACL) de son dossier : placez `FACTORY_HOME` dans un dossier que seul l'utilisateur de l'usine peut lire (le profil utilisateur l'est par défaut). | **oui** |
| `run-settings.json` | Permissions Claude Code passées à chaque run (`--settings`), régénéré à chaque `relais up`. | non |
| `relais.db` | Base SQLite : tickets suivis, événements, runs, coûts, file, minuteries. Absente quand `FACTORY_DATABASE_URL` désigne une base Postgres ([`configuration.md`](configuration.md#variables-denvironnement)). | oui (contient l'historique) |
| `transcripts/<runId>.jsonl` | Sortie `stream-json` de chaque run, secrets masqués, supprimée 30 jours après sa dernière écriture ([`exploitation.md`](exploitation.md#journaux-transcripts-et-données)). | oui (code, contenu des tickets) |
| `workspaces/<projet>/<ticket>/` | Worktree git de chaque ticket en cours. | — |
| `workspaces/<projet>/_trunk/<runId>/` | Copie détachée de la branche principale, une par question en lecture seule, supprimée à sa fin. | — |
| `workspaces/_kb/<runId>/` | Worktrees du dépôt de connaissance pour les runs `learn` / `remember`. | — |
| `logs/` | Créé au démarrage mais pas encore utilisé : les journaux du démon sortent sur la sortie standard. | — |
| `knowledge/` | Emplacement visé par `relais init` pour le dépôt de connaissance (voir [`projets-et-workspaces.md`](projets-et-workspaces.md#base-de-connaissance-partagée)). | — |

Sauvegarder une instance = sauvegarder `config.yaml`, `secrets.json` et `relais.db` (ou la base Postgres, avec `pg_dump`, quand `FACTORY_DATABASE_URL` est défini). Les worktrees se recréent à partir des branches poussées.

## Désinstaller

`npm unlink -g relais` retire les commandes. Supprimer `RELAIS_HOME` efface l'état local (les branches, PR et tickets restent dans GitHub et Linear). Pensez à supprimer l'application OAuth dans Linear.
