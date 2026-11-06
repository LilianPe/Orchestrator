# Déploiement

Le démon, `factoryd`, tourne en continu pour recevoir les webhooks, relever les PR et lancer les runs. Il y a une seule topologie : `docker compose up -d` sur un serveur Linux dédié à l'usine, avec un moteur rootless. Le serveur lui-même est le sujet d'ORC-126.

Pour travailler sur un poste, sans conteneur : `factory up` (voir [`installation.md`](installation.md)). Ce n'est pas un mode de production.

## Les services

| Service | Image | Rôle | Publié |
|---|---|---|---|
| `factoryd` | `Dockerfile` | Le démon. Seul à tenir le socket du moteur, avec lequel il crée les runners. | non |
| `proxy` | la même | Le proxy de sortie des runners (`src/network/proxy.ts`, [ORC-213](decisions/ORC-213.md)), dans un processus à lui. | non |
| `postgres` | `postgres:16` | L'état du démon. Sur le réseau interne seulement. | non |
| `caddy` | `caddy:2.11.8-alpine` | Le TLS de l'interface et des webhooks, devant `factoryd`. L'exposition en production est le sujet d'ORC-221. | 80, 443 |

Les runners ne sont pas des services : `factoryd` en crée un par tentative, puis le détruit. Ils tournent en `--network none` ; leur seule sortie est le socket de leur run, servi par `proxy`. Aucun ne reçoit le socket du moteur : le provider refuse ce montage. Le serveur doit être dédié à l'usine : qui tient ce socket tient tout ce que le moteur peut faire.

`proxy` n'a aucun secret du démon. La clé de l'autorité de sortie est chez lui seul, dans `$FACTORY_DIR/egress-ca`, que `factoryd` ne monte pas. `factoryd` le pilote par un socket de contrôle (`data/network/control.sock`), jamais monté dans un runner. Si `proxy` s'arrête, les sockets des runs meurent avec lui : `factoryd` le voit, et remplace ces conteneurs à leur prochaine demande. Si `factoryd` s'arrête, `proxy` ferme ses runs, comme s'il tournait dans son processus.

## Pourquoi les mêmes chemins des deux côtés

Le moteur lit les chemins d'un montage **sur l'hôte**, pas dans le conteneur de `factoryd`. Trois conséquences :

- `$FACTORY_DIR` est un chemin absolu, monté au même endroit dans le conteneur.
- Les chemins de `config.yaml` sont ces chemins-là (`repoPath: /srv/factory/repos/mon-app`, écrit en entier).
- L'installation de l'usine, que chaque runner monte en lecture seule, n'existe que dans l'image. Au démarrage, `docker/entrypoint.sh` la copie dans `$FACTORY_DIR/install/<empreinte>`, une fois par image, et lance le démon depuis cette copie.

| Dossier | Contenu | Monté par |
|---|---|---|
| `data` | `FACTORY_HOME` : `config.yaml`, `factory.yml`, `secrets.json`, transcripts, worktrees | `factoryd` |
| `data/network` | Sockets et journaux des runs, socket de contrôle | `factoryd`, `proxy` |
| `repos` | Les clones des dépôts, en HTTPS | `factoryd` |
| `install` | La copie de l'installation | `factoryd` |
| `egress-ca` | L'autorité de sortie, sa clé comprise | `proxy` |

## Les images

- **`Dockerfile`** (`factoryd` et `proxy`) : Node 24, `git`, le CLI `docker` et `gh`. `gh` reste jusqu'à ORC-181. Claude Code n'y est plus : l'agent tourne dans le runner. Utilisateur `node` (uid 1000).
- **`docker/runner.Dockerfile`** (les runners) : Node 24 avec pnpm, Python 3 avec uv et pip, `git`, Claude Code. Versions épinglées. Ni `gh`, ni CLI de moteur, ni code du démon.

Aucune image ne reçoit de secret à la construction. Le test d'isolation n° 7 cherche des jetons dans l'historique, la configuration et les fichiers de chaque couche de l'image des runners.

## Limites actuelles

- **Publier** : l'usine pousse et ouvre la PR, avec la GitHub App (ORC-125, [`github.md`](github.md#publication)). Sans elle, un ticket vérifié est bloqué : configurez `github.*` ou `GH_APP_*`. Un agent en runner n'a ni `gh`, ni jeton, et le proxy refuse `git push`. `GH_TOKEN` ne sert qu'à `factoryd`, jusqu'à ORC-181.
- **`verify` ne tourne plus dans `factoryd`** (ORC-151) : ses commandes vont dans un runner neuf, sur un clone, au niveau réseau `none`. Sous compose, `FACTORY_CONTAINER_CLI` est fixé : un moteur en panne donne un ticket bloqué pour cause d'infrastructure (`verify.errored`), jamais un repli sur `factoryd`. `FACTORY_ALLOW_HOST_VERIFY` n'est pas transmis, et serait sans effet. **Le `git` de `factoryd`, à côté du socket, ne lit rien de ce qu'a écrit un agent** (ORC-317) : chaque agent a son propre dépôt, et le dossier git de `repoPath` n'est jamais monté.

## Variables

Dans un fichier `.env` à côté de `compose.yaml` (non versionné). `docker compose` refuse de démarrer si une variable obligatoire manque.

| Variable | Obligatoire | Rôle |
|---|---|---|
| `CLAUDE_TOKEN_1`, `CLAUDE_TOKEN_2` | l'un de ces moyens | Jetons des comptes Claude Code, lus par `factory.yml` (`token: env:CLAUDE_TOKEN_1`) ; le compte `claude.active` est le seul identifiant des runs. |
| `ANTHROPIC_API_KEY` | l'un de ces moyens | Authentification de Claude Code sans compte actif, pour les runs de ce conteneur, qui tournent encore à côté du démon (jusqu'à ORC-179). Compose ne la réclame plus : sans aucun des deux, les runs échouent à l'authentification. |
| `GH_TOKEN` | oui | `gh` et lecture HTTPS, jusqu'à ORC-181 ; la publication passe par la GitHub App. Droits : [`github.md`](github.md#permissions-nécessaires). |
| `FACTORY_UI_PASSWORD` | oui | Mot de passe de l'interface (le conteneur écoute hors bouclage). |
| `FACTORY_DIR` | oui | Chemin absolu sur le serveur (voir ci-dessus). |
| `FACTORY_ENGINE_SOCKET` | oui | Socket du moteur rootless, par exemple `/run/user/1000/docker.sock`. |
| `FACTORY_RUNNER_IMAGE` | oui | L'image des runners, construite à part. |
| `FACTORY_PUBLIC_HOST` | oui | Domaine de `publicUrl`, pour le certificat de `caddy`. |
| `POSTGRES_PASSWORD` | oui | Mot de passe de la base, repris dans une URL : lettres et chiffres seulement. |
| `FACTORY_COMMIT` | non | À la construction : le commit, relevé sur chaque tentative. |
| `FACTORY_HTTP_PORT`, `FACTORY_HTTPS_PORT` | non | Ports publiés par `caddy` (80 et 443 par défaut). |
| `FACTORY_ALLOW_ROOTFUL_ENGINE` | non | `1` : laisse démarrer sur un moteur qui n'est pas rootless. Pour un poste de développement, jamais pour le serveur. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | non | Identité des commits (le nom du produit et `factory@localhost` par défaut) ; compose les recopie dans `GIT_COMMITTER_*`. |

Les webhooks GitHub lisent `github.webhookSecret` dans `config.yaml` ou `factory.yml` ([`github.md`](github.md#webhooks-github)) : `compose.yaml` ne transmet pas `GH_WEBHOOK_SECRET`.

## Premier démarrage

Sur le serveur, avec le moteur rootless de l'utilisateur en marche :

1. Écrire `.env`, créer `$FACTORY_DIR` et ses dossiers :

   ```bash
   . ./.env
   mkdir -p "$FACTORY_DIR"/data/network "$FACTORY_DIR"/repos "$FACTORY_DIR"/install "$FACTORY_DIR"/egress-ca
   ```

2. Cloner les dépôts dans `repos/` (en HTTPS), créer l'application Linear avec les URL basées sur `publicUrl` ([`linear.md`](linear.md)), et écrire `data/secrets.json` (`clientId`, `clientSecret`, `webhookSecret`, format : [`configuration.md`](configuration.md#secretsjson)), `data/config.yaml` et `data/factory.yml` :

   ```yaml
   # data/config.yaml, avec FACTORY_DIR=/srv/factory
   host: 0.0.0.0
   publicUrl: https://usine.exemple.fr
   relay: { kind: none }
   projects:
     - { id: mon-app, repoPath: /srv/factory/repos/mon-app, linearTeamKey: APP }
   limits: { perDayUsd: 40 }
   ```

   ```yaml
   # data/factory.yml : un ticket à la fois au départ
   concurrency: 1
   ```

   Puis donner le tout à l'uid 1000 des conteneurs. Dans un moteur rootless, c'est un sous-uid de l'utilisateur, pas l'utilisateur : seul un conteneur peut le faire. Ensuite, on ne modifie plus ces dossiers que depuis un conteneur (`docker compose exec factoryd ...`).

   ```bash
   docker run --rm -v "$FACTORY_DIR:/base" node:24.22.1-bookworm-slim chown -R 1000:1000 /base
   docker run --rm -v "$FACTORY_DIR:/base" node:24.22.1-bookworm-slim chmod 600 /base/data/secrets.json
   ```

3. Construire les images, l'une après l'autre :

   ```bash
   docker build -f docker/runner.Dockerfile -t "$FACTORY_RUNNER_IMAGE" docker
   FACTORY_COMMIT="$(git rev-parse HEAD)" docker compose build
   ```

4. `docker compose up -d`.
5. Ouvrir `https://usine.exemple.fr` (mot de passe `FACTORY_UI_PASSWORD`), cliquer **Connecter Linear**.

`factoryd` refuse de démarrer sur un moteur qui n'est pas rootless : tenir son socket donnerait root sur l'hôte.

Les commandes d'exploitation se lancent dans le conteneur :

```bash
docker compose exec factoryd node dist/src/cli/factory.js status
docker compose exec factoryd node dist/src/cli/factory.js pause
docker compose logs -f factoryd
```

Recette : [`recette.md`](recette.md#8-docker-critère-8).

## Ce qui n'est prouvé que sur le serveur

La pile a tourné une fois sous Docker Desktop, qui n'est pas rootless. Ces points restent à vérifier par la recette, sur le serveur (ORC-126) :

- le démarrage sur un moteur rootless (la détection cherche `rootless` dans `docker info`) ;
- l'accès de l'uid 1000 au socket rootless par son groupe 0 (`group_add`) ;
- les propriétaires sous les sous-uid : `factoryd`, `proxy` et les runners sous le même uid, un socket de run en `0600` ouvert par le runner ;
- la préparation des dossiers ci-dessus ;
- `caddy` sur les ports 80 et 443 : un moteur rootless ne publie sous 1024 qu'avec `net.ipv4.ip_unprivileged_port_start=80` ;
- un vrai certificat, et les limites de processus, de mémoire et de CPU (cgroup v2, `loginctl enable-linger`) ;
- Podman derrière le CLI `docker` : rien n'a été mesuré, le déploiement vise Docker rootless.

## Arrêt propre et redémarrage

`SIGTERM` (`docker compose stop`) déclenche un arrêt propre : minuteries, relevé des PR et réconciliation coupés ; chaque run en cours reçoit SIGINT (SIGKILL après 10 s) et est enregistré comme **interrompu** ; le démon attend la fin de ces runs, ferme les connexions SSE et la base. `compose.yaml` lui laisse 30 s (`stop_grace_period`).

Au démarrage suivant, Relais reprend seul ce qui a été coupé (par un arrêt ou un crash) : aucun ticket n'est bloqué pour autant ; détails dans [`exploitation.md`](exploitation.md#arrêt-redémarrage-et-runs-interrompus). Les demandes en file, les minuteries (retours regroupés) et l'état de pause sont conservés dans `relais.db`.

Sous compose, cet état est dans Postgres, pas dans un fichier.

## Mise à jour

```bash
git pull
docker build -f docker/runner.Dockerfile -t "$FACTORY_RUNNER_IMAGE" docker
FACTORY_COMMIT="$(git rev-parse HEAD)" docker compose build
docker compose up -d
```

Chaque image a sa copie de l'installation dans `$FACTORY_DIR/install`. Les anciennes restent, un conteneur pouvant encore tourner depuis l'une d'elles : à retirer à la main une fois la mise à jour faite. `run-settings.json` est régénéré au démarrage.

**En passant à ORC-317 :** les espaces de travail deviennent des dépôts à part. Un ticket dont le dossier est encore un `git worktree` est refusé au lancement (« n'est pas celui que l'usine a créé ») : supprimez `workspaces/<projet>/<ticket>/` et `workspaces/<projet>/_trunk/`, puis `git -C <repoPath> worktree prune`. Un commit non poussé y serait perdu : poussez-le d'abord, à la main. Et un agent a pu écrire dans le dossier git d'un dépôt déjà confié à l'usine : vérifiez son `config`, ses `hooks/` et `info/attributes`, ou mieux, reclonez-le. Le correctif protège de ce qu'un agent écrira, pas de ce qu'il a déjà laissé.
