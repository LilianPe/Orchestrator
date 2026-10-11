---
name: fix-ci
description: Diagnostiquer une CI en échec sur la PR du ticket, corriger une vraie régression ou signaler un échec instable ou d'infrastructure (lancé par Relais).
---

# relais:fix-ci

Tu reprends la session de dev du ticket. Le bloc « CI en échec » liste les checks rouges de la PR. Tu es seul : personne ne répond pendant ton tour, sauf si tu poses une question avec `relais-agent ask`.

## Étapes

1. Lis l'échec exact : `gh pr checks` pour les checks rouges, puis `gh run view <id> --log-failed`. Identifie le job, l'étape et la commande en échec, et le premier message d'erreur (pas seulement la dernière ligne).
2. Reproduis cette commande en local, dans le worktree, avant de toucher au code.
3. Classe la cause :
   - **régression** : l'échec se reproduit en local et vient du code de la PR (ou de son intégration avec la branche cible) ;
   - **instable (flaky)** : l'échec ne se reproduit pas, ou passe et échoue sans changement de code ;
   - **environnement / infra CI** : secret ou variable manquants, runner, réseau, quota, service externe indisponible.
4. Régression : correction minimale à la source. Ajoute un test qui couvre le bug s'il n'en existe pas. Relance la commande en échec et les tests concernés jusqu'au vert, commite (`<ID>: fix CI`), pousse avec `git push`.
5. Instable ou infra : ne « corrige » rien à l'aveugle. Pose UNE question précise avec `relais-agent ask "<question>"` (ce que tu as observé, ce qu'il faudrait de la part d'un humain : relancer, ajouter un secret, réparer le runner…) et termine ton tour par un message qui la résume.

## Interdits

Ne désactive, ne saute (`skip`, `only`), ne supprime et n'affaiblis jamais un test, une assertion ou une étape de CI. Ne modifie pas les workflows CI pour faire passer le build. N'augmente pas un timeout sans justifier, mesure à l'appui, que la lenteur est légitime. Ne merge jamais, ne force-push jamais, ne change pas de branche.

## Dernier message (publié dans Linear)

En français, au format :

```
**Cause** — check et commande en échec, erreur résumée.
**Classement** — régression / instable / environnement CI, et pourquoi.
**Fait** — correction et test ajouté (<sha court>), ou question posée.
**Reste** — ce qui n'est pas résolu, s'il y en a.
```
