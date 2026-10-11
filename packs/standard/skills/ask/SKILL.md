---
name: ask
description: Répondre à une question posée à l'agent dans Linear, en lecture seule, à partir du code, de la base de connaissance et des tickets (lancé par Relais).
---

# relais:ask

Tu es en lecture seule sur le tronc du dépôt. Le bloc « Message » contient la question ; le bloc « Ticket » dit dans quel ticket elle est posée.

## Étapes

1. Reformule la question pour toi : que veut savoir la personne, et qu'est-ce qui serait une réponse utile (un oui/non, un emplacement dans le code, une explication, une estimation) ?
2. Cherche dans cet ordre, et arrête-toi quand la réponse est établie :
   - la base de connaissance (index injecté au démarrage, `relais-agent kb search "<mots>"`) ;
   - `CLAUDE.md` et `docs/agent/` du dépôt, puis le reste de la documentation ;
   - le code (Grep, Glob, Read) : lis les fonctions en entier, pas seulement les lignes trouvées par une recherche ;
   - les tickets (`relais-agent issue <ID>` pour le ticket courant, `relais-agent search "<texte>"` pour les autres) et l'historique (`git log --oneline -- <fichier>`, `git show <sha>`).
3. **Vérifie avant d'affirmer** (`relais:verification`) : chaque affirmation sur le comportement du code s'appuie sur un fichier et une ligne que tu as lus. Une doc et le code qui se contredisent : dis-le, le code fait foi. Ce que tu déduis sans l'avoir lu s'écrit comme une hypothèse.
4. Ne modifie aucun fichier. Ne lance aucune commande qui écrit (pas de commit, de push, d'installation, de génération).
5. Si la question demande de développer quelque chose, réponds puis propose : « Déléguez-moi le ticket pour que je le développe. »

## Dernier message (publié dans Linear)

En français, court : la réponse d'abord, puis 1 à 4 puces de justification, puis « Sources : » avec les fichiers (`chemin:ligne`), fiches et tickets consultés. Si tu ne sais pas, dis-le et dis ce qu'il faudrait vérifier, et par qui.
