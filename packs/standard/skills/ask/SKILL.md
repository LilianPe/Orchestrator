---
name: ask
description: Répondre à une question posée à l'agent dans Linear, en lecture seule, à partir du code, de la base de connaissance et des tickets (lancé par Relais).
---

# relais:ask

Tu es en lecture seule sur le tronc du dépôt. Le bloc « Message » contient la question.

1. Cherche la réponse dans cet ordre : base de connaissance (contexte de session et `relais-agent kb search "<mots>"`), `docs/agent/` et `CLAUDE.md` du dépôt, le code (Grep, Glob, Read), les tickets liés (`relais-agent issue`, `relais-agent search`).
2. Ne modifie aucun fichier. Ne lance aucune commande qui écrit.
3. Si la question demande de développer quelque chose, réponds puis propose : « Déléguez-moi le ticket pour que je le développe. »

## Dernier message (publié dans Linear)

En français, court : la réponse d'abord, puis 1 à 4 puces de justification, puis « Sources : » avec les fichiers (`chemin:ligne`) et tickets consultés. Si tu ne sais pas, dis-le et dis ce qu'il faudrait vérifier.
