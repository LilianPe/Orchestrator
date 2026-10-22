---
name: fix-ci
description: Diagnostiquer une CI en échec sur la PR du ticket, corriger une vraie régression ou signaler un échec instable ou d'infrastructure (lancé par l'usine).
---

# factory:fix-ci

Tu reprends la session de dev du ticket, sur sa branche déjà poussée. Le bloc « CI en échec » liste les checks rouges de la PR. Tu es seul : personne ne répond pendant ton tour, sauf si tu poses une question avec `factory-agent ask`. La méthode est `factory:debugging` : la cause d'abord, la correction ensuite.

## 1. Lire l'échec exact

1. `gh pr checks <branche>` : les checks rouges et leurs liens. Un check encore en cours n'est pas un échec : ne conclus que sur ce qui a fini.
2. `gh run view <run-id> --log-failed` : le job, l'étape, la commande en échec et le **premier** message d'erreur (pas seulement la dernière ligne). Log vide ou insuffisant : `gh run view <run-id> --json jobs` pour les étapes et leur conclusion, puis `gh run view --job <job-id> --log`.
3. Messages qui ne viennent jamais de ton code : runner perdu (« lost communication with the server »), quota, réseau, service externe indisponible, annulation. Un délai de job dépassé (timeout) est en revanche presque toujours ton code (boucle, attente, test bloqué).

## 2. Reproduire

Lance la commande en échec en local, dans le worktree, avant de toucher au code. Pour une suite de tests, cible le fichier ou le test en échec, pas la suite entière.

## 3. Classer

- **régression** : l'échec se reproduit en local et vient du code de la PR ou de son intégration avec la base (la CI construit souvent la PR fusionnée dans la base : une base qui a changé un type ou une constante que la PR utilise casse sans conflit texte ; `git fetch origin` puis `git log --oneline HEAD..origin/<base>` pour voir ce qui est arrivé) ;
- **instable (flaky)** : ne se reproduit pas, ou passe et échoue sans changement de code ;
- **environnement / infra CI** : secret ou variable manquants, runner, réseau, quota, service externe.

Un échec est-il déjà sur la base ? `gh run list --branch <base> --limit 5` (même workflow) : rouge là aussi, avec la même erreur → il préexiste à la PR. Ne corrige pas du code hors de la PR : signale-le.

## 4. Agir

- **Régression** : correction minimale à la cause, avec un test qui couvre le bug s'il n'en existe pas (`factory:tdd`). Rejoue la commande en échec et les tests concernés jusqu'au vert (`factory:verification`), commite (`<ID>: fix CI — <cause>`), un commit par cause. Conflit avec la base : même règle que `factory:feedback` (fusion de la base, jamais de rebase d'une branche poussée). Pousse : `git push origin HEAD:refs/heads/<branche>`, puis vérifie avec `git ls-remote origin refs/heads/<branche>`.
- **Instable ou infra** : ne « corrige » rien à l'aveugle. Relance une fois les jobs en échec : `gh run rerun <run-id> --failed`. Même échec à la relance : c'est réel, reprends l'étape 1 avec cette preuve ; sinon note-le comme instable. Ce qui demande un humain (secret, runner, service, test instable à réparer) : UNE question précise avec `factory-agent ask "<question>"` (ce que tu as observé, ce qu'il faut faire), puis fin du tour.
- **Troisième tentative** : si `git log --oneline` montre déjà deux commits `<ID>: fix CI` pour le même check sans qu'il passe, ne tente pas une troisième correction : décris ce qui a été essayé et pose la question.

## Interdits

Ne désactive, ne saute (`skip`, `only`), ne supprime et n'affaiblis jamais un test, une assertion ou une étape de CI. Ne modifie pas les workflows CI pour faire passer le build. N'augmente pas un timeout sans justifier, mesure à l'appui (durée réelle des derniers runs), que la lenteur est légitime. Ne merge jamais, ne force-push jamais, ne réécris pas l'historique, ne change pas de branche.

## Dernier message (publié dans Linear)

En français, au format :

```
**Cause** — check et commande en échec, erreur résumée.
**Classement** — régression / instable / environnement CI, et pourquoi.
**Fait** — correction et test ajouté (<sha court>), relance, ou question posée.
**Reste** — ce qui n'est pas résolu, s'il y en a.
```
