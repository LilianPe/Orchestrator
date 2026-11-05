# Recette Relais (Linear de test)

Prérequis : Node 24, `gh` connecté, `claude` connecté, un espace Linear de test dont vous êtes admin, un petit dépôt GitHub avec des tests, avec une **protection de branche sur la branche par défaut** (PR obligatoire, force-push interdit) : les refus du pack ne sont qu'une première barrière, c'est GitHub qui garantit que seuls les humains mergent.

## 0. Installation
```bash
git clone git@github.com:lilianperthuis/relais.git && cd relais
npm ci && npm run build && npm link
```

## 1. init (critère 1, < 15 min)
Dans le dépôt de test : `relais init`. Suivre les instructions (app OAuth Linear, webhook = URL smee affichée, catégories Agent session events + Issues + Comments). Vérifier `~/.relais/config.yaml`, `~/.relais/secrets.json` (mode 600), `.relais/workflow.yml`.

## 2. up et connexion (critère 2)
`relais up`, ouvrir http://localhost:4100, cliquer « Connecter Linear ». Attendu : page « Linear est connecté », statuts Human Review / AI Review et labels agent:* et Bloqué créés dans l'équipe, bouton remplacé par l'état « en direct ».
Si Linear refuse l'URL de callback localhost : noter l'erreur, utiliser `cloudflared tunnel --url http://localhost:4100` le temps de l'installation et mettre l'URL publique dans `publicUrl`.

## 3. Délégation (critère 3)
Créer un ticket clair (≥ 30 caractères de description), le déléguer à @relais. Attendu en < 10 s : « Pris en compte. » dans la session. Puis : statut In Progress, sortie en direct dans l'interface, PR ouverte, statut Human Review, résumé en français dans la session.
Vérifier dans `~/.relais/relais.db` qu'aucun événement n'a été rejeté pour signature (sinon : le relais smee modifie le corps → passer en `publicUrl` via tunnel).

## 4. Retours groupés (critère 4)
Écrire deux remarques dans le fil à moins d'une minute d'écart. Attendu : une seule reprise 3 minutes après la dernière, même session Claude (même id dans l'interface), réponse avec le commit.

## 5. Review IA puis merge (critère 5)
Passer le ticket en AI Review. Attendu : session neuve, synthèse, statut Human Review. Merger la PR sur GitHub. Attendu en < 1 min : statut Done, worktree supprimé de `~/.relais/workspaces`, run learn lancé.

## 6. Questions et mémoire (critère 6)
Sur un autre ticket : `@relais où est géré X ?` → réponse en lecture seule. `@relais retiens <fait>` → PR dans relais-knowledge. La merger, puis poser une question liée : la réponse cite la fiche.

## 7. Stop (critère 7)
Déléguer un ticket, pendant le run cliquer « Send stop request » dans Linear. Attendu en < 10 s : « Arrêté… », ticket bloqué, run `stopped`.

## 8. Docker (critère 8)
Sur le serveur, images construites ([`deploiement.md`](deploiement.md#premier-démarrage)), en test automatique, sous un nom de projet et des ports à lui :

```bash
FACTORY_ISOLATION=1 FACTORY_COMPOSE=1 FACTORY_CONTAINER_CLI=docker FACTORY_RUNNER_IMAGE=<image> \
  FACTORY_ENGINE_SOCKET=/run/user/1000/docker.sock \
  npx vitest run --project isolation test/isolation/compose-stack.test.ts
```

Attendu : les 4 services démarrés sur un moteur rootless ; TLS par `caddy`, 401 sans le mot de passe ; un runner créé depuis `factoryd`, sans socket du moteur, en `--network none`, avec pnpm et uv qui installent par le proxy, et les refus au journal. Sans `claude` réel ni ticket.

`FACTORY_ALLOW_ROOTFUL_ENGINE=1` laisse tourner ce test sur un poste (Docker Desktop) : il saute alors la vérification « rootless » et vérifie le refus. Ce résultat ne prouve rien pour le serveur.

Une authentification de Claude Code est obligatoire : `ANTHROPIC_API_KEY`, ou `CLAUDE_TOKEN_1` avec un compte actif dans `factory.yml`.

Puis, à la main : `docker compose up -d`, interface sur `https://<domaine>`, même comportement que 3. Avec `concurrency: 1`, déléguer deux tickets : un seul runner tourne (`docker ps --filter label=factory.attempt`).

Avec `host` différent de `127.0.0.1`, le démon refuse de démarrer sans `FACTORY_UI_PASSWORD` : l'interface, `/api/*` et `/oauth/start` demandent alors une authentification HTTP Basic (nom d'utilisateur libre, mot de passe = `FACTORY_UI_PASSWORD`). Restent ouverts : `POST /webhooks/linear` (signé), `GET /oauth/callback` et `/agent/*` (jeton de run). Vérifier : `curl -i https://<domaine>/api/state` répond 401.

## Vérifications live optionnelles
- `LINEAR_API_KEY=<clé perso> npx vitest run src/adapters/tracker/linear/queries.live.test.ts` : toutes les requêtes valident contre le schéma Linear.
- `FACTORY_E2E=1 npx vitest run test/e2e/pack.e2e.test.ts` : le pack charge le hook et refuse `gh pr merge`.

## Points à vérifier pendant la recette
1. Claude Code `stream-json` émet-il une ligne `assistant` par message (le plafond de tours de Relais compte ces lignes) ? Observer : le nombre de tours affiché pour un run correspond au nombre de messages assistant réels.
2. La signature des webhooks relayés par smee correspond-elle au corps brut (vérification HMAC) ? Observer : aucun événement rejeté pour signature dans `~/.relais/relais.db`.
3. Linear accepte-t-il une URL de callback OAuth en `http://localhost` (sinon procédure cloudflared déjà décrite) ? Observer : la connexion de l'étape 2 aboutit, ou l'erreur de Linear.
4. Le daemon annonce `http://localhost:4100` mais écoute sur `127.0.0.1` : si `localhost` résout d'abord en `::1`, le lien ne répond pas. Observer : si le lien ne répond pas, utiliser `http://127.0.0.1:4100`.
5. Le dépôt de base de connaissance (`knowledge.repoPath`) doit rester sur sa branche par défaut : Relais y fait un `fetch` + `merge --ff-only` avant chaque run. Observer : aucun échec de `merge --ff-only` dans les logs d'un run.
6. La version de Claude Code installée applique-t-elle les jokers en milieu de motif (`Bash(git push * --force*)`, `Bash(git push *+*)`, `Bash(git push * *:main*)`) ? Observer : dans un worktree de test, demander à une session lancée avec `--settings ~/.relais/run-settings.json` d'exécuter `git push origin HEAD --force`, `git push origin +HEAD` et `git push origin HEAD:main` ; chacune doit être refusée par les permissions (pas par GitHub). Même contrôle pour le joker en tête de `Bash(*secrets.json*)` : `cat ~/.relais/secrets.json` doit être refusé.
7. En `--permission-mode plan` (runs `trunk-readonly`), Claude Code laisse-t-il appeler `mcp__factory__submit_result` et `mcp__factory__ask`, permis par l'`allow` du pack ? Observer : une question (`@Relais …`) qui appelle `submit_result` n'a pas de refus de permission dans son transcript. Sinon, ces runs répondent par leur dernier message seulement.

## Sécurité : limites connues
- Au démarrage, Relais écrit `<RELAIS_HOME>/run-settings.json` (les réglages du pack + des refus de lecture sur `secrets.json`, `relais.db`, `transcripts/` et `logs/` du vrai `RELAIS_HOME`) et le passe à chaque run via `--settings`. Vérifier : le fichier existe et contient le chemin réel (`/data/...` en Docker).
- L'environnement d'un run ne contient ni `LINEAR_*` ni les `RELAIS_*` du daemon (seuls `RELAIS_API`, `RELAIS_RUN_TOKEN`, `RELAIS_TICKET`, `RELAIS_KNOWLEDGE`, `RELAIS_ROOT` sont posés).
- Risque résiduel : le pack autorise `Bash(node:*)`, `Bash(npx:*)`, `Bash(npm:*)`. Un agent (ou une injection dans un ticket) peut donc lire `secrets.json` via un script (`node -e "…readFileSync(…)"`) : les listes de refus de Claude Code sont indicatives, pas une frontière de sécurité. L'agent tourne avec le même utilisateur que le daemon. Ne pas déployer Relais sur des tickets venant de personnes non fiables tant que les runs ne tournent pas sous un utilisateur séparé.
