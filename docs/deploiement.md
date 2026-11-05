# Déploiement

Relais est un démon longue durée : il doit tourner en continu pour recevoir les webhooks, relever les PR et lancer les runs. Deux façons de le faire tourner : Docker (serveur) ou un service sur la machine.

## Docker

Le dépôt fournit un `Dockerfile` et un `compose.yaml`.

### L'image

- Base `node:24.22.1-bookworm-slim` (patch épinglé : la mise à jour de sécurité de Node se fait en changeant ce tag, pas par un simple rebuild), avec `git`, `gh` (dépôt officiel GitHub CLI) et Claude Code (`npm install -g @anthropic-ai/claude-code`, dernière version au moment du build).
- Relais construit dans `/app` (`npm ci`, `npm run build`, dépendances de dev retirées).
- Identité git par défaut au niveau système : `Relais <relais@localhost>`, et `safe.directory '*'` (les dépôts montés peuvent appartenir à un autre utilisateur). Les variables `GIT_AUTHOR_*` / `GIT_COMMITTER_*` la remplacent.
- `RELAIS_HOME=/data`, `NODE_ENV=production`.
- Tourne sous l'utilisateur **`node` (uid 1000)**, pas root.
- Point d'entrée `docker/entrypoint.sh` : si `GH_TOKEN` est défini, `gh auth setup-git` (git pousse en HTTPS avec ce jeton), puis la commande, par défaut `node dist/src/cli/relais.js up`.
- Port exposé : 4100.

### Volumes

| Volume (compose) | Dans le conteneur | Contenu |
|---|---|---|
| `./data` | `/data` | `RELAIS_HOME` : `config.yaml`, `secrets.json`, `relais.db`, transcripts, worktrees. |
| `./repos` | `/repos` | Les clones des dépôts confiés à Relais (et éventuellement le dépôt de connaissance). |

Les deux doivent être accessibles en écriture par l'uid 1000 :

```bash
mkdir -p data repos && sudo chown -R 1000:1000 data repos
```

Les dépôts sous `repos/` doivent avoir un remote **HTTPS** (`https://github.com/<org>/<dépôt>.git`) : il n'y a aucune clé SSH dans le conteneur. Vérifier : `docker compose exec relais git -C /repos/<dépôt> remote -v`.

### Variables

| Variable | Obligatoire | Rôle |
|---|---|---|
| `CLAUDE_TOKEN_1`, `CLAUDE_TOKEN_2` | l'un de ces moyens | Jetons des comptes Claude Code, lus par `factory.yml` (`token: env:CLAUDE_TOKEN_1`) ; le compte `claude.active` est le seul identifiant des runs. |
| `ANTHROPIC_API_KEY` | l'un de ces moyens | Authentification de Claude Code sans compte actif, pour les runs de ce conteneur, qui tournent encore à côté du démon (jusqu'à ORC-179). Compose ne la réclame plus : sans aucun des deux, les runs échouent à l'authentification. |
| `GH_TOKEN` | oui | `gh` et push HTTPS. Droits : [`github.md`](github.md#permissions-nécessaires). |
| `RELAIS_UI_PASSWORD` | oui | Mot de passe de l'interface (le conteneur écoute hors bouclage). |
| `GH_WEBHOOK_SECRET` | non | Secret des webhooks GitHub (`<publicUrl>/webhooks/github`) quand `github.webhookSecret` n'est pas dans `config.yaml`. Absent : webhooks GitHub refusés, le relevé des PR suit seul ([`github.md`](github.md#webhooks-github)). |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | non | Identité des commits (`Relais`, `relais@localhost` par défaut) ; compose les recopie dans `GIT_COMMITTER_*`. |

`docker compose` refuse de démarrer si une variable obligatoire manque. Mettez-les dans un fichier `.env` à côté de `compose.yaml` (non versionné) ou dans l'environnement du shell.

### `data/config.yaml`

```yaml
host: 0.0.0.0
publicUrl: https://relais.exemple.fr
relay:
  kind: none
projects:
  - id: mon-app
    repoPath: /repos/mon-app
    linearTeamKey: APP
limits:
  perDayUsd: 40
knowledge:
  repoPath: /repos/relais-knowledge
```

- `host: 0.0.0.0` : sinon le serveur n'est pas joignable depuis l'extérieur du conteneur ;
- `publicUrl` : URL HTTPS par laquelle Linear joint Relais (webhook `<publicUrl>/webhooks/linear`, callback `<publicUrl>/oauth/callback`) ; placez un proxy HTTPS devant le port 4100 ;
- chemins **du conteneur** (`/repos/…`).

### Premier démarrage

1. Cloner les dépôts dans `repos/` (HTTPS), préparer `data/config.yaml`.
2. Créer l'application Linear avec les URL basées sur `publicUrl` ([`linear.md`](linear.md)).
3. Écrire `data/secrets.json` avec `clientId`, `clientSecret`, `webhookSecret` (format : [`configuration.md`](configuration.md#secretsjson)), propriétaire uid 1000, mode `0600`. On peut aussi lancer l'assistant dans le conteneur : `docker compose run --rm -it -w /repos/mon-app relais node /app/dist/src/cli/relais.js init`.
4. `docker compose up -d --build`.
5. Ouvrir `https://relais.exemple.fr` (mot de passe `RELAIS_UI_PASSWORD`), cliquer **Connecter Linear**.

Les commandes d'exploitation se lancent dans le conteneur (le mot de passe y est déjà dans l'environnement) :

```bash
docker compose exec relais node dist/src/cli/relais.js status
docker compose exec relais node dist/src/cli/relais.js pause
docker compose logs -f relais
```

Recette Docker : [`recette.md`](recette.md#8-docker-critère-8).

## Service sur une machine (sans Docker)

`relais up` reste au premier plan. Pour qu'il tourne en continu, lancez-le sous un gestionnaire de services, avec le même utilisateur que celui connecté à `gh` et `claude`. Exemple d'unité **systemd utilisateur** (`~/.config/systemd/user/relais.service`) :

```ini
[Unit]
Description=Relais
After=network-online.target

[Service]
ExecStart=/usr/bin/env relais up
Restart=on-failure
# Si host n'est pas en bouclage :
# Environment=RELAIS_UI_PASSWORD=...
# PATH doit contenir node, claude, gh et git :
Environment=PATH=/home/moi/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now relais
journalctl --user -u relais -f
loginctl enable-linger $USER      # pour qu'il tourne sans session ouverte
```

Adaptez `PATH` à l'emplacement réel de `node` (nvm, fnm…), `claude` et `gh` : un service ne charge pas votre `.bashrc`. Cette unité est un exemple, non livré avec Relais.

## Arrêt propre et redémarrage

`SIGTERM` (`docker compose stop`, `systemctl stop`) ou `SIGINT` (`Ctrl+C`) déclenchent un arrêt propre : relais smee, minuteries, relevé des PR et réconciliation coupés ; chaque run en cours reçoit SIGINT (SIGKILL après 10 s) et est enregistré comme **interrompu** ; le démon attend la fin de ces runs, ferme les connexions SSE et la base.

Laissez au moins 15 s au démon pour s'arrêter (Docker en laisse 10 par défaut : `docker compose stop -t 30` ou `stop_grace_period: 30s` dans `compose.yaml`).

Au démarrage suivant, Relais reprend seul ce qui a été coupé (par un arrêt ou un crash) : aucun ticket n'est bloqué pour autant ; détails dans [`exploitation.md`](exploitation.md#arrêt-redémarrage-et-runs-interrompus). Les demandes en file, les minuteries (retours regroupés) et l'état de pause sont conservés dans `relais.db`.

## Mise à jour

```bash
git pull && npm ci && npm run build      # poste
docker compose up -d --build             # Docker
```

puis redémarrer. `run-settings.json` est régénéré au démarrage.
