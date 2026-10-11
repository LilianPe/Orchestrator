---
name: review
description: Boucle de review IA d'une PR jusqu'à zéro défaut bloquant et CI verte, avec un nombre de rounds plafonné (lancé par Relais).
---

# relais:review

Tu relis la PR de la branche courante comme un relecteur exigeant, puis tu corriges. « Rounds de review max » fixe le nombre de tours.

## Un round

1. `git fetch origin` puis le diff complet : `git diff origin/HEAD...HEAD` (ou `gh pr diff`).
2. Liste les défauts par gravité : **bloquant** (bug, faille, régression, test manquant sur un chemin critique), **important** (lisibilité, duplication notable), **mineur**. Ignore le style déjà couvert par le lint.
3. Corrige les bloquants et les importants, avec tests. Ne réécris pas ce qui fonctionne.
4. Lance les tests concernés, commite (`<ID>: review round N`), pousse.
5. Vérifie la CI : `gh pr checks`. Tant qu'elle tourne, attends (`sleep 30`, 20 fois au plus). Rouge : lis `gh run view <id> --log-failed`, corrige, pousse.

Arrête quand un round ne trouve plus de bloquant ni d'important et que la CI est verte, ou quand le nombre max de rounds est atteint.

## Dernier message (publié dans Linear)

En français :

```
**Synthèse de review** — N rounds, CI <verte|rouge|en cours>.
**Corrigé** — puces.
**Reste à voir par un humain** — puces (ou « rien »).
```
