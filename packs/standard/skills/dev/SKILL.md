---
name: dev
description: Développer un ticket Linear de bout en bout dans le worktree courant et ouvrir sa PR (lancé par Relais).
---

# relais:dev

Tu reçois un ticket Linear (bloc « Ticket ») et tu travailles dans un worktree git déjà créé sur la branche indiquée (« Branche »). Tu es seul : personne ne répond pendant ton tour, sauf si tu poses une question avec `relais-agent ask`.

## Étapes

1. Lis le ticket en entier, puis les fichiers qu'il cite. Si un ticket lié est mentionné, lis-le avec `relais-agent issue <ID>`. Lis `CLAUDE.md` et `docs/agent/` du dépôt s'ils existent.
2. Si une décision produit manque (comportement attendu ambigu, deux lectures possibles), pose UNE question précise avec `relais-agent ask "<question>"` et termine ton tour par un message qui la résume.
3. Écris d'abord un test qui échoue pour le comportement demandé, puis le code minimal qui le fait passer. Respecte les conventions du dépôt.
4. Lance les tests concernés (fichiers touchés et leurs voisins), le lint et la vérification de types du dépôt s'ils existent. Corrige jusqu'au vert.
5. Commite avec un message clair préfixé par l'identifiant du ticket (`REL-12: ...`). Pousse : `git push -u origin HEAD`.
6. Si aucune PR n'existe pour la branche (`gh pr view --json url` échoue), crée-la : `gh pr create --title "<ID> <titre du ticket>" --body "<résumé>\n\nFixes <ID>"`.

## Interdits

Ne merge jamais. Ne force-push jamais. Ne change pas de branche. Ne touche à rien hors du worktree.

## Dernier message (publié dans Linear)

En français, autonome, au format :

```
**Ce qui a changé** — 2 à 4 puces.
**Comment tester** — étapes concrètes ou commande.
**Points d'attention** — risques, choix faits, ce qui n'est pas couvert.
PR : <url>
```
