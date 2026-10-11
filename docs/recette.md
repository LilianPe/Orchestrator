# Recette Relais (Linear de test)

Prérequis : Node 24, `gh` connecté, `claude` connecté, un espace Linear de test dont vous êtes admin, un petit dépôt GitHub avec des tests.

## 0. Installation
```bash
git clone git@github.com:lilianperthuis/relais.git && cd relais
npm ci && npm run build && npm link
```

## 1. init (critère 1, < 15 min)
Dans le dépôt de test : `relais init`. Suivre les instructions (app OAuth Linear, webhook = URL smee affichée, catégories Agent session events + Issues + Comments). Vérifier `~/.relais/config.yaml`, `~/.relais/secrets.json` (mode 600), `.relais/workflow.yml`.

## 2. up et connexion (critère 2)
`relais up`, ouvrir http://localhost:4100, cliquer « Connecter Linear ». Attendu : page « Linear est connecté », statuts Human Review / AI Review / Ready to Merge et labels agent:* créés dans l'équipe, bouton remplacé par l'état « en direct ».
Si Linear refuse l'URL de callback localhost : noter l'erreur, utiliser `cloudflared tunnel --url http://localhost:4100` le temps de l'installation et mettre l'URL publique dans `publicUrl`.

## 3. Délégation (critère 3)
Créer un ticket clair (≥ 30 caractères de description), le déléguer à @relais. Attendu en < 10 s : « Pris en compte. » dans la session. Puis : statut In Progress, sortie en direct dans l'interface, PR ouverte, statut Human Review, résumé en français dans la session.
Vérifier dans `~/.relais/relais.db` qu'aucun événement n'a été rejeté pour signature (sinon : le relais smee modifie le corps → passer en `publicUrl` via tunnel).

## 4. Retours groupés (critère 4)
Écrire deux remarques dans le fil à moins d'une minute d'écart. Attendu : une seule reprise 3 minutes après la dernière, même session Claude (même id dans l'interface), réponse avec le commit.

## 5. Review IA puis merge (critère 5)
Passer le ticket en AI Review. Attendu : session neuve, synthèse, statut Ready to Merge. Merger la PR sur GitHub. Attendu en < 1 min : statut Done, worktree supprimé de `~/.relais/workspaces`, run learn lancé.

## 6. Questions et mémoire (critère 6)
Sur un autre ticket : `@relais où est géré X ?` → réponse en lecture seule. `@relais retiens <fait>` → PR dans relais-knowledge. La merger, puis poser une question liée : la réponse cite la fiche.

## 7. Stop (critère 7)
Déléguer un ticket, pendant le run cliquer « Send stop request » dans Linear. Attendu en < 10 s : « Arrêté… », ticket bloqué, run `stopped`.

## 8. Docker (critère 8)
`docker compose up --build` sur une machine Linux avec `data/config.yaml` adapté (`host: 0.0.0.0`, `publicUrl: https://<domaine>`, `relay: { kind: none }`, `repoPath` sous `/repos`). Attendu : interface sur le port 4100, même comportement que 3.

## Vérifications live optionnelles
- `LINEAR_API_KEY=<clé perso> npx vitest run src/adapters/tracker/linear/queries.live.test.ts` : toutes les requêtes valident contre le schéma Linear.
- `RELAIS_E2E=1 npx vitest run test/e2e/pack.e2e.test.ts` : le pack charge le hook et refuse `gh pr merge`.

## Points à vérifier pendant la recette
1. Claude Code `stream-json` émet-il une ligne `assistant` par message (le plafond de tours de Relais compte ces lignes) ? Observer : le nombre de tours affiché pour un run correspond au nombre de messages assistant réels.
2. La signature des webhooks relayés par smee correspond-elle au corps brut (vérification HMAC) ? Observer : aucun événement rejeté pour signature dans `~/.relais/relais.db`.
3. Linear accepte-t-il une URL de callback OAuth en `http://localhost` (sinon procédure cloudflared déjà décrite) ? Observer : la connexion de l'étape 2 aboutit, ou l'erreur de Linear.
4. Le daemon annonce `http://localhost:4100` mais écoute sur `127.0.0.1` : si `localhost` résout d'abord en `::1`, le lien ne répond pas. Observer : si le lien ne répond pas, utiliser `http://127.0.0.1:4100`.
5. Le dépôt de base de connaissance (`knowledge.repoPath`) doit rester sur sa branche par défaut : Relais y fait un `fetch` + `merge --ff-only` avant chaque run. Observer : aucun échec de `merge --ff-only` dans les logs d'un run.
