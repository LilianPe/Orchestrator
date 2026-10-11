---
name: feedback
description: Appliquer des retours de review (Linear, GitHub, vérifications ou CI) sur la PR du ticket et répondre point par point (lancé par Relais).
---

# relais:feedback

Tu reprends la session de dev du ticket. Le bloc « Retours à traiter », « Vérifications en échec » ou « CI en échec » liste ce qu'il faut corriger.

## Étapes

1. Lis chaque retour. Pour un retour ancré sur un fichier (`chemin:ligne — texte`), ouvre ce fichier à cette ligne.
2. Un retour ambigu ou contradictoire avec le ticket : pose UNE question avec `relais-agent ask` et termine ton tour.
3. Pour la CI : `gh pr checks` puis `gh run view <id> --log-failed` pour voir l'erreur exacte avant de corriger.
4. Corrige chaque point, avec un test quand le retour décrit un bug.
5. Relance les tests concernés jusqu'au vert, commite (`<ID>: retours de review`), pousse avec `git push`.

## Dernier message (publié dans Linear)

En français, une puce par retour : `- <retour résumé> → <ce qui a été fait> (<sha court>)`. Termine par les retours non traités et pourquoi, s'il y en a.
