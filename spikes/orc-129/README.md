# Spike ORC-129 : inbox + outbox maison ou DBOS Transact

**Code jetable.** Ces prototypes sont les preuves de la décision [`docs/decisions/ORC-129.md`](../../docs/decisions/ORC-129.md). Ils ne doivent pas être repris tels quels dans `src/` : pas de tests, pas de gestion d'erreur sérieuse, un seul ticket, une seule sorte d'effet. Ils sont hors du build, du lint (`spikes/**` ignoré par `eslint.config.js`), du typecheck et de `npm test`, et la CI ne les lance pas.

## Ce qu'il y a

| Chemin | Rôle |
|---|---|
| `shared/decide.ts` | copie minimale du contrat `decide(state, event) → (state, effects)`, pure, commune aux deux options |
| `shared/journal.ts` | le schéma `journal` + `tickets`, la forme d'une décision enregistrée et le rejeu, communs aux deux options |
| `shared/effects.ts` | l'appel de l'effet (un commentaire) avec `Idempotency-Key` = id de l'effet, et l'événement de délégation |
| `shared/fake-api.ts` | la fausse API externe : applique le commentaire à la réception, puis retient sa réponse 3 s (la fenêtre du `kill -9`) |
| `shared/run-scenario.sh` | le scénario, identique pour les deux options |
| `shared/run-all.sh` | les cinq variantes ; sorties complètes dans `results/<variante>/run.txt` |
| `maison/main.ts` | option A : tables `inbox`, `journal`, `tickets`, `outbox` ; `pg` seul |
| `dbos/main.ts` | option B : DBOS Transact 5.3.0, API fonctionnelle (sans décorateurs) |

## Le scénario

1. Le webhook de délégation arrive deux fois avec le même id de livraison.
2. Le worker décide (`decide` pur), écrit l'effet « poster un commentaire », l'exécute.
3. Dès que l'API externe a appliqué le commentaire, et avant qu'elle réponde : `kill -9` du worker.
4. Un nouveau worker démarre ; on attend que le ticket soit `done`.
5. On compte les appels reçus et les commentaires appliqués par l'API externe.
6. On rejoue le journal à travers `decide` et on compare chaque décision à celle enregistrée.
7. Contrôle négatif : on falsifie une décision enregistrée ; le rejeu doit signaler un écart.

Variantes : `IGNORE_IDEMPOTENCY=1` (l'API ignore la clé d'idempotence) et, pour DBOS, `WORKER2_ENV=DBOS__APPVERSION=v2` (un déploiement de code neuf entre le crash et la reprise).

## Relancer

```bash
free -m   # au moins 3 Go disponibles
docker run --rm -d --name orc129-pg -e POSTGRES_PASSWORD=spike -p 55432:5432 postgres:17-alpine
(cd maison && npm ci) && (cd dbos && npm ci)
bash shared/run-all.sh
docker stop orc129-pg
```

Node 24 exécute les `.ts` directement (suppression des types), sans étape de build.
