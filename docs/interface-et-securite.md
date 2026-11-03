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

Avec les sandboxes (`FACTORY_CONTAINER_CLI`, voir [`configuration.md`](configuration.md#variables-denvironnement)), un **second serveur** ne sert que `/agent/*`, avec les mêmes routes et le même jeton de run, sur `FACTORY_AGENT_PORT` (port de l'interface + 1) et `FACTORY_AGENT_HOST` (`127.0.0.1`) : les conteneurs, sans réseau, le joignent par le proxy de sortie du démon (voir [plus bas](#réseau-des-sandboxes)). Toute autre route y répond 404. L'interface reste à l'adresse de `host`.

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

Sur l'hôte, `RELAIS_API` pointe sur `http://127.0.0.1:<port>/agent` : les agents parlent au démon en local. Dans un sandbox, elle pointe sur `http://<FACTORY_SANDBOX_AGENT_HOST>:<FACTORY_AGENT_PORT>/agent` (par défaut `host.docker.internal`) : un nom que le conteneur ne résout pas, que le proxy de sortie reconnaît et relaie vers le serveur dédié à l'API agent.

## MCP de l'usine

`POST /agent/mcp` est un serveur MCP (HTTP « Streamable », réponses JSON seulement, un message par requête ; toute autre méthode reçoit `405` avec `Allow: POST`, pas de flux SSE), derrière le même jeton de run que le reste de `/agent/*`, servi aussi par le serveur dédié aux sandboxes. Deux outils (ORC-288) :

- **`submit_result`** : l'agent y rend son résultat, au format d'`agentOutputSchema` (`src/core/agent-output.ts`), dont le schéma JSON est l'`inputSchema` de l'outil. Un résultat valide est rangé pour **le run du jeton** (méta `agent-output:<run>`), le dernier envoi l'emporte ; un résultat invalide est refusé (`isError`) avec les champs fautifs, pour que l'agent le corrige pendant son run.
- **`ask`** : comme `POST /agent/ask` (question dans Linear, ticket bloqué), qui reste jusqu'à ORC-192.

`claude -p` le reçoit par `--mcp-config '{"mcpServers":{"factory":{"type":"http","url":"${FACTORY_API}/mcp","headers":{"Authorization":"Bearer ${FACTORY_RUN_TOKEN}"}}}}'` : Claude Code remplace les `${…}` par les variables de son environnement (vérifié sur 2.1.316). Le jeton n'est donc jamais sur la ligne de commande, que la liste des processus de l'hôte montre ; il arrive par l'environnement du run, comme avant.

## Ce que l'agent charge, et ce qu'il ne charge pas

Le dépôt d'un projet est écrit par qui peut y pousser : ses réglages Claude Code ne pilotent pas les runs. Les options de `claude -p` sont celles mesurées dans [ORC-128](decisions/ORC-128.md) (ORC-284).

L'agent charge seulement ce que l'usine impose :

- **les réglages du run** (`--settings`, le `run-settings.json` de l'usine) ;
- **le pack** (`--plugin-dir`) : ses skills, son hook de démarrage (règles de l'usine, index de la base de connaissance) ;
- **le MCP de l'usine**, seul déclaré par `--mcp-config` (voir [MCP de l'usine](#mcp-de-lusine)) ;
- **les conventions du dépôt** : l'usine lit elle-même `CLAUDE.md`, `AGENTS.md` et `.claude/CLAUDE.md` du worktree (le seul fichier de `.claude/` que le retrait ci-dessous garde, Claude Code ne le chargeant pas) et les met dans le prompt du run, comme **données** : dans une section « Conventions du dépôt (données) », entre balises, présentées comme les conventions du dépôt, qui ne lèvent aucune règle de l'usine. Ensemble, ils sont coupés à 8 000 octets (proposition, à fixer avec le budget du prompt d'ORC-254), la coupe marquée ; un fichier plus gros n'est jamais lu en entier. Un fichier qui est un lien vers l'extérieur du worktree, ou illisible, n'est pas lu. Leurs imports `@chemin` ne sont pas suivis : seul le texte des fichiers est injecté. Ils sont relus à chaque tentative : ils sont dans le message du run, pas dans le prompt système figé à la reprise.

Et rien du dépôt :

- **`--setting-sources ""`** : ni `.claude/settings.json`, ni `.claude/settings.local.json` (leurs hooks, leurs permissions, leur `env`), ni les skills de `.claude/`, ni `CLAUDE.md` chargé par Claude Code ; ni les réglages utilisateur de la machine.
- **`--strict-mcp-config`** : ni le `.mcp.json` du dépôt, ni les connecteurs claude.ai du compte (Drive, Docs…), qui sinon se chargeraient avec un compte par abonnement.
- **`.claude/` retiré du worktree avant chaque session**, après le `setup` (défense en profondeur, pour ce qu'ORC-128 n'a pas piégé : agents, commandes, output styles). Le worktree est en *sparse checkout* (mode non-cone, `/*` sauf `/.claude/*`, `/.claude/CLAUDE.md` gardé pour les conventions), propre à ce worktree (`extensions.worktreeConfig`) : la copie principale du dépôt garde son `.claude/`. `git status` reste propre, un `git add -A` ou `commit -a` de l'agent ne supprime pas `.claude/` de la PR, et un `git merge` ou un rebase qui le modifie ne le réécrit pas sur le disque. Limite : l'agent ne peut pas modifier les fichiers suivis de `.claude/` ; un ticket qui demande de les changer ne peut pas être fait par un run.
- **`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`** : pas de mémoire automatique (effet non vérifié par ORC-128).
- **Télémétrie coupée** par `DISABLE_TELEMETRY=1` et `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (laquelle suffit reste à mesurer) ; dans un sandbox, le proxy de sortie la bloque de toute façon : seul `api.anthropic.com` est permis pour Claude.

Dans un sandbox, `CLAUDE_CONFIG_DIR` est le dossier de session du ticket (`/home/factory/.claude`, monté depuis `<home>/sessions/<projet>/<ticket>`) : tout le dossier de config de Claude est par ticket, l'identifiant arrive par l'environnement (`CLAUDE_CODE_OAUTH_TOKEN` ou `ANTHROPIC_API_KEY`, comme avant). Sur l'hôte, sans sandbox, c'est celui du démon, comme avant.

Le test d'isolation n° 11 (`test/isolation/claude-settings.test.ts`) rejoue à chaque version de Claude Code le dépôt piégé d'ORC-128 avec ces options : hooks, MCP, skill, agent, commande et `CLAUDE.md` piégés, aucun ne doit se charger. Il demande un vrai `claude` et un identifiant ([`tests.md`](tests.md#les-projets-vitest)).

## Réseau des sandboxes

Décision et options : [ORC-213](decisions/ORC-213.md). Chaque conteneur tourne en **`--network none`**, quel que soit le niveau : ni route, ni DNS, ni UDP. Sa seule sortie est le **socket Unix de son run**, ouvert par le proxy de sortie du démon (`src/network/proxy.ts`) et monté en `/run/factory/egress.sock`. Un relais (PID 1 du conteneur) l'expose en `127.0.0.1:3128`, et `HTTP_PROXY`/`HTTPS_PROXY` y pointent ; un outil qui ignore ces variables n'a aucun réseau.

Le proxy applique le niveau du run :

| Niveau | Ce qui passe |
|---|---|
| `none` | Rien, pas même l'API agent (`verify`). |
| `claude-api` | `api.anthropic.com` et l'API agent. |
| `limited` (défaut des runs) | Le précédent ; npm et PyPI ; GitHub en lecture ; une liste de domaines de doc (`src/network/levels.ts`). Méthodes GET, HEAD et OPTIONS seulement, sauf vers l'API Claude. |
| `custom` (dépôt) | `limited` plus les hôtes de `network.allow`. |
| `full` | Tout : réservé à `setup`, refusé pour l'agent. |

- **Hôtes à API d'écriture inspectés** (`github.com`, `api.github.com`, `registry.npmjs.org`, `pypi.org`) : jamais tunnelés. Le conteneur les joint en `http://` (git par `url.<http>.insteadOf`, npm par `npm_config_registry`, pip par `PIP_INDEX_URL`), le proxy voit la méthode et le chemin, refuse toute écriture (`git push`, gist, publication), puis continue en HTTPS. Seul `git fetch` (POST vers `git-upload-pack`) est permis en plus.
- **Autres hôtes permis, tunnelés** (`CONNECT`, port 443 seulement) : API Claude, téléchargements (`files.pythonhosted.org`, `codeload.github.com`…), docs, `network.allow`. TLS de bout en bout : seul l'hôte est vérifié.
- **Jamais d'adresse privée** (boucle locale, réseaux privés, `169.254.0.0/16` des métadonnées cloud), même en `full`, même par un nom qui y mène.
- **Journal** : chaque connexion et chaque refus, avec l'hôte, la méthode, les octets envoyés et reçus et la raison d'un refus, dans `<home>/network/<run>.jsonl`.

## Secrets

Où ils sont et comment ils restent dans le démon : [`configuration.md`](configuration.md#ce-qui-ne-sort-pas-du-démon). En résumé : `secrets.json` en `0600`, environnement des runs sans `RELAIS_*` ni `LINEAR_*`, jeton Linear jamais transmis aux agents, `run-settings.json` qui interdit aux runs de lire les fichiers sensibles de `RELAIS_HOME`.

## Limites connues

- **Sans sandbox, même utilisateur système.** Sans `FACTORY_CONTAINER_CLI`, les runs tournent sur l'hôte sous le même utilisateur que le démon (le démon l'écrit au démarrage : « les runs tournent sur l'hôte, sans isolation »). Les refus de Claude Code sont indicatifs : un agent qui exécute du code (`node -e …`, autorisé par le pack) peut lire `secrets.json` ou `relais.db`. Une injection dans un ticket ou un commentaire pourrait l'y pousser. **Ne confiez pas à Relais des tickets écrits par des personnes non fiables** tant que les runs ne tournent pas sous un utilisateur séparé.
- **Sandbox : méthodes non vues dans un tunnel TLS.** Vers un hôte tunnelé (docs, téléchargements, `network.allow`), le proxy ne voit que l'hôte : un POST y passe. Ces hôtes sont choisis sans API d'écriture, mais un domaine de `network.allow` peut en avoir une. Seule une interception TLS par une autorité de l'usine fermerait l'écart ; c'est le point ouvert d'[ORC-213](decisions/ORC-213.md).
- **Sandbox : un outil qui force `https://` vers GitHub ou les registres est refusé.** Le `WebFetch` de Claude Code passe en HTTPS : il ne lit pas `github.com`. Une dépendance npm en `git+https://` vers un autre hôte que `github.com` échoue aussi.
- **Sandbox : un niveau par run, `network` du dépôt pas encore lu.** Tous les runs prennent `limited`. Le `network` de `.factory/config.yml` (niveau, `allow`) et le niveau de chaque étape du préréglage s'appliqueront quand la config du dépôt sera lue au lancement (ORC-209 C). Le `setup` tourne dans le conteneur du run, à son niveau (`limited`), pas en `full`.
- **Sandbox : journal réseau en fichier.** Le journal des connexions est un JSONL par run dans `<home>/network/`, pas encore en base ni au tableau de bord.
- **Sandbox : le `.git` commun du dépôt est monté.** Pour que git marche dans le worktree, le dossier git commun du dépôt est monté en lecture-écriture, au même chemin que sur l'hôte. Le conteneur voit donc les autres refs et branches du dépôt, et peut les modifier. Le miroir en lecture seule et la sortie par `git bundle` fermeront cet écart (ORC-205).
- **Sandbox : `trunk-readonly` monté en lecture-écriture.** Le port monte toujours le worktree en écriture ; un job `trunk-readonly` n'est retenu que par `--permission-mode plan`, comme sur l'hôte.
- **Sandbox : rootless vérifié seulement en CI et sur le serveur.** En développement (Docker Desktop sous WSL), le moteur n'est pas rootless. Le job CI `isolation` (Podman rootless) et le serveur le vérifient.
- **Sandbox : `verify` tourne encore sur l'hôte.** Les commandes `verify` d'un job (`job.verify`, effet `run_verify`) s'exécutent sur l'hôte, sous l'utilisateur du démon, sur le code que l'agent vient d'écrire. Elles passeront dans un sandbox avec ORC-151.
- **Sandbox : une session commencée sur l'hôte ne reprend pas dans le conteneur.** Un ticket dont la session Claude a été ouverte sur l'hôte (avant l'activation des sandboxes) n'a pas cette session dans le dossier monté en `~/.claude` : son prochain run de reprise échoue une fois. Bloquez-le, ou relancez-le à neuf.
- **Secrets transmis aux runs.** `ANTHROPIC_API_KEY`, `GH_TOKEN` et les autres variables du démon hors `RELAIS_*`/`LINEAR_*` sont visibles des agents (ils en ont besoin). Donnez au compte GitHub les droits minimaux ([`github.md`](github.md#permissions-nécessaires)).
- **Canal smee public.** Le contenu des webhooks transite par smee.io et y est lisible par qui connaît l'URL ([`linear.md`](linear.md#3-webhooks--smee-ou-url-publique)).
- **Merge.** Seule la protection de branche GitHub garantit que l'agent ne merge pas ([`github.md`](github.md#protection-de-branche-fortement-conseillée)).
- **Transcripts.** `transcripts/` contient tout ce que les agents ont lu et écrit ; protégez `RELAIS_HOME` en conséquence.
