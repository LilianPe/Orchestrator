# Interface web et sécurité

## L'interface

`relais up` sert une interface web sur `http://localhost:<port>` (4100 par défaut). Elle nécessite `npm run build` (dossier `web/dist`) ; sans lui, seules l'API et les webhooks répondent.

Ce qu'elle montre, en direct :

- **En-tête** : places occupées (`dev`, `questions`), longueur de la file, coût du jour et budget, indicateur « en direct » ; boutons **Connecter Linear** (tant que Linear n'est pas connecté) et **Pause / Reprendre**.
- **Tickets** : identifiant, titre, état logique, `bloqué` (la raison au survol), coût cumulé ; bouton **Stop** sur un ticket qui a un run en cours. Cliquer un identifiant ouvre son run.
- **Session en direct** : la sortie du run sélectionné (texte, appels d'outils), reçue en direct depuis l'ouverture de la page. Le transcript complet d'un run reste disponible par l'API (`/api/runs/<id>/transcript`) et dans `<RELAIS_HOME>/transcripts/`.
- **Journal** : les derniers messages du démon et les événements reçus.

Le direct passe par un flux **SSE** (`GET /api/events`) avec un `ping` toutes les 15 s.

Développement de l'interface : `npm run dev:web` lance Vite sur le port 5173 avec un proxy de `/api` et `/oauth` vers `http://127.0.0.1:4100` (un `relais up` doit tourner).

## Ce que le serveur expose

| Route | Rôle | Protection |
|---|---|---|
| `GET /` et fichiers statiques | Interface | mot de passe (hors bouclage) |
| `GET /api/state` | État : tickets, file, runs actifs (sans leurs jetons), coût, capacité | mot de passe |
| `GET /api/events`, `GET /api/events/recent` | Flux SSE, 100 derniers événements | mot de passe |
| `GET /api/runs/:id/transcript` | Transcript d'un run | mot de passe |
| `POST /api/control/pause`, `/api/control/resume` | Pause / reprise | mot de passe + contrôle d'origine |
| `POST /api/tickets/:projet/:ticket/stop` | Arrêt d'un run | mot de passe + contrôle d'origine |
| `GET /oauth/start` | Démarre la connexion Linear | mot de passe |
| `GET /oauth/callback` | Retour OAuth de Linear | paramètre `state` aléatoire, à usage unique |
| `POST /webhooks/linear` | Webhooks Linear | signature HMAC + fraîcheur 60 s |
| `POST /webhooks/github` | Webhooks GitHub | signature HMAC `X-Hub-Signature-256` + déduplication par id d'événement |
| `/agent/*` | API des agents (`relais-agent`) | jeton du run en cours (`Authorization: Bearer`) |

Avec les sandboxes (`FACTORY_CONTAINER_CLI`, voir [`configuration.md`](configuration.md#variables-denvironnement)), un **second serveur** ne sert que `/agent/*`, avec les mêmes routes et le même jeton de run, sur `FACTORY_AGENT_PORT` (port de l'interface + 1) et `FACTORY_AGENT_HOST` (`0.0.0.0`) : les conteneurs ne joignent pas la boucle locale du démon. Toute autre route y répond 404. L'interface reste à l'adresse de `host`.

## Exposition réseau et mot de passe

Par défaut Relais écoute sur `127.0.0.1` : seule la machine locale y accède, sans mot de passe.

Pour l'exposer (serveur, Docker), mettez `host: 0.0.0.0` (ou une adresse précise) dans `config.yaml`. Relais **refuse alors de démarrer** sans la variable `RELAIS_UI_PASSWORD` :

> host: 0.0.0.0 expose l'interface et l'API de Relais hors de cette machine. Définissez la variable d'environnement RELAIS_UI_PASSWORD (mot de passe de l'interface), ou remettez host: 127.0.0.1 dans config.yaml.

Avec le mot de passe, tout passe par une authentification **HTTP Basic** (nom d'utilisateur libre, mot de passe = `RELAIS_UI_PASSWORD`, comparé en temps constant), sauf quatre routes qui ont leur propre protection : `POST /webhooks/linear`, `POST /webhooks/github`, `GET /oauth/callback` et `/agent/*`. Vérification : `curl -i https://<domaine>/api/state` doit répondre 401.

Les commandes `relais status|pause|resume|stop` envoient `RELAIS_UI_PASSWORD` si la variable est définie dans le shell.

Le Basic auth transmet le mot de passe à chaque requête : derrière une exposition Internet, mettez Relais derrière un proxy **HTTPS** (Caddy, nginx, Traefik, tunnel Cloudflare) et réglez `publicUrl` sur l'URL HTTPS.

## Protection CSRF

Toute requête `POST` (et autre méthode non `GET`/`HEAD`) sur `/api/*` qui porte un en-tête `Origin` est refusée (403 `cross-origin request refused`) si cet `Origin` ne correspond pas à l'hôte du serveur. Une page tierce ouverte dans votre navigateur ne peut donc pas mettre la file en pause ni arrêter un run, même en local sans mot de passe. Les outils sans `Origin` (CLI, `curl`) ne sont pas concernés.

Derrière un proxy, l'en-tête `Host` transmis à Relais doit être celui de l'URL publique, sinon les boutons de l'interface sont refusés.

## Jetons des agents

Chaque run reçoit un `RELAIS_RUN_TOKEN` aléatoire. L'API `/agent/*` ne l'accepte que tant que ce run est `running`. Ce jeton :

- ne lit que **le ticket du run** (`/agent/issue/<autre ticket>` → 403) ;
- peut chercher des tickets, chercher dans la base de connaissance et poser une question dans la session du ticket ;
- n'apparaît pas dans `/api/state`.

Sur l'hôte, `RELAIS_API` pointe sur `http://127.0.0.1:<port>/agent` : les agents parlent au démon en local. Dans un sandbox, elle pointe sur `http://<FACTORY_SANDBOX_AGENT_HOST>:<FACTORY_AGENT_PORT>/agent` (par défaut `host.docker.internal`), le serveur dédié à l'API agent.

## Secrets

Où ils sont et comment ils restent dans le démon : [`configuration.md`](configuration.md#ce-qui-ne-sort-pas-du-démon). En résumé : `secrets.json` en `0600`, environnement des runs sans `RELAIS_*` ni `LINEAR_*`, jeton Linear jamais transmis aux agents, `run-settings.json` qui interdit aux runs de lire les fichiers sensibles de `RELAIS_HOME`.

## Limites connues

- **Sans sandbox, même utilisateur système.** Sans `FACTORY_CONTAINER_CLI`, les runs tournent sur l'hôte sous le même utilisateur que le démon (le démon l'écrit au démarrage : « les runs tournent sur l'hôte, sans isolation »). Les refus de Claude Code sont indicatifs : un agent qui exécute du code (`node -e …`, autorisé par le pack) peut lire `secrets.json` ou `relais.db`. Une injection dans un ticket ou un commentaire pourrait l'y pousser. **Ne confiez pas à Relais des tickets écrits par des personnes non fiables** tant que les runs ne tournent pas sous un utilisateur séparé.
- **Sandbox : réseau ouvert, provisoirement.** Chaque tentative tourne dans un conteneur créé pour elle et détruit après (ORC-204). Il demande le niveau `claude-api`, mais tant que le proxy de sortie n'existe pas (ORC-213), le conteneur a le réseau ouvert du moteur. Le `setup` du dépôt tourne dans le même conteneur, sur ce même réseau.
- **Sandbox : le `.git` commun du dépôt est monté.** Pour que git marche dans le worktree, le dossier git commun du dépôt est monté en lecture-écriture, au même chemin que sur l'hôte. Le conteneur voit donc les autres refs et branches du dépôt, et peut les modifier. Le miroir en lecture seule et la sortie par `git bundle` fermeront cet écart (ORC-205).
- **Sandbox : `trunk-readonly` monté en lecture-écriture.** Le port monte toujours le worktree en écriture ; un job `trunk-readonly` n'est retenu que par `--permission-mode plan`, comme sur l'hôte.
- **Sandbox : rootless vérifié seulement en CI et sur le serveur.** En développement (Docker Desktop sous WSL), le moteur n'est pas rootless. Le job CI `isolation` (Podman rootless) et le serveur le vérifient.
- **Secrets transmis aux runs.** `ANTHROPIC_API_KEY`, `GH_TOKEN` et les autres variables du démon hors `RELAIS_*`/`LINEAR_*` sont visibles des agents (ils en ont besoin). Donnez au compte GitHub les droits minimaux ([`github.md`](github.md#permissions-nécessaires)).
- **Canal smee public.** Le contenu des webhooks transite par smee.io et y est lisible par qui connaît l'URL ([`linear.md`](linear.md#3-webhooks--smee-ou-url-publique)).
- **Merge.** Seule la protection de branche GitHub garantit que l'agent ne merge pas ([`github.md`](github.md#protection-de-branche-fortement-conseillée)).
- **Transcripts.** `transcripts/` contient tout ce que les agents ont lu et écrit ; protégez `RELAIS_HOME` en conséquence.
