---
name: review
description: Boucle de review IA d'une PR jusqu'à zéro défaut bloquant, avec un nombre de rounds plafonné (lancé par l'usine, qui publie les corrections).
---

# factory:review

Tu mènes la PR de la branche courante à un état propre : review, corrections, review ciblée des corrections, jusqu'à ce qu'il ne reste plus de défaut, puis intégration de la base si besoin. **L'usine publie** : elle vérifie ton dernier commit et le pousse à la fin de ton tour, puis surveille la CI. « Rounds de review max » (dans le prompt) plafonne le nombre de rounds. Tu es seul : ton seul canal vers un humain est `factory-agent ask "<question>"`, puis fin du tour.

## 0. Préparer

1. État de la PR : `gh pr view <branche> --json number,state,baseRefName,mergeable,mergeStateStatus,url`. PR fermée ou mergée : arrête-toi et dis-le dans ton dernier message.
2. `git status` : rien d'inattendu en cours (des modifications non commitées qui ne sont pas les tiennes : arrête-toi et dis-le, ne les écrase pas).
3. Ramène les commits poussés sur la branche depuis ton worktree (un humain a pu pousser pendant la review) : `git fetch origin`, puis `git merge --ff-only origin/<branche>`. Tu relis ainsi la tête de la PR, celle que l'usine retiendra comme relue : si ton dernier commit n'est pas la tête de la PR à la fin du run, rien n'est retenu et le *Done* qui suit ne merge pas. Avance rapide impossible (la branche distante a divergé de la tienne) : arrête-toi et dis-le, ne force rien.
4. Lis le ticket (ce que la PR doit faire), le `CLAUDE.md` du dépôt et `docs/agent/` : les règles qui serviront à juger les corrections.
5. Ouvre ton **registre des décisions** (dans tes notes de session, pas dans le dépôt) : une ligne par décision, `<clé> — <décision> — <raison> — round <n>`, où la clé est l'endroit (fichier + fonction, phrase de doc) ou le mécanisme touché. Chaque correction, constat refusé ou point à trancher y entre.

## 1. Round 1 : tout le diff, au niveau qu'il mérite

1. Choisis le niveau de `factory:code-review` sur le diff de la PR (`git diff --stat origin/<base>...HEAD`, puis les hunks si les chemins ne suffisent pas) : **rapide**, **standard** ou **approfondi**, selon sa table. C'est la seule passe large de la boucle : un chemin critique (accès, données, migrations, secrets) prend « approfondi » dès maintenant plutôt que de remonter le niveau round après round.
2. Lance `factory:code-review` à ce niveau, sur le diff complet de la PR (base de la PR, pas un sous-ensemble), avec la consigne : ne signaler que des défauts dans ces lignes ou dans ce qu'elles cassent.
3. Garde les constats dans le périmètre ; mets les « hors périmètre » et « conflits de règle » de côté pour le message final (jamais corrigés ici).
4. Aucun constat bloquant ni important : va à l'étape 3. Sinon : étape 2.

## 2. Corriger, puis relire les corrections

**Corriger** (chaque round) avec `factory:receiving-review` : vérifier chaque constat et sa correction proposée avant d'écrire, un commit par cause (`<ID>: review round <n> — <cause>`), chaque correction de comportement prouvée par un test rouge puis vert, tests ciblés seulement. Les constats **mineurs** du round 1 peuvent être corrigés avec le reste ; ensuite, plus jamais.

Ne corrige pas, et note comme **à trancher** :

- un compromis (échouer ouvert ou fermé, une limite, un délai, un seuil) : décris les deux scénarios d'échec ;
- une correction disproportionnée au constat (gros rayon d'impact, chemin sensible déjà restructuré par la boucle) ;
- un constat qui inverserait une décision du registre, ou qui porte sur une clé déjà modifiée par **deux** rounds : c'est une question de conception, pas une file de corrections ;
- un texte sans oracle exécutable (commentaire, doc, prompt, constante de réglage) déjà modifié une fois pour une question de formulation : une autre lecture du même texte ne justifie pas un deuxième changement. Un texte qui contredit le code reste un défaut à corriger.

**Relire** (round 2 et suivants) : `factory:code-review` au niveau **standard**, limité aux commits de correction du round précédent (`git show <sha>` pour chacun) **et à ce qui les consomme** (un type rétréci, une fonction dont le contrat change, un état partagé). Jamais une nouvelle relecture de toute la PR. Donne-lui le registre avec la consigne : « ces choix sont décidés ; un constat qui en inverserait un s'écrit `inversion : <clé>`, pas comme un défaut ; un bug introduit par une correction est un défaut ».

**Convergence** :

- un round dont les constats sont tous mineurs **a convergé** : les mineurs restants vont dans le message final, pas dans un nouveau round ;
- deux rounds de suite avec un défaut grave (perte de données, faille, écrasement silencieux) sur la même clé : arrête la boucle, annule (`git revert --no-edit <sha>`) une correction qui s'est montrée nuisible, et signale le mécanisme comme point de conception ;
- plafond « Rounds de review max » atteint avec un défaut bloquant ou important encore ouvert : arrête-toi, ne commite pas de correction non relue, et signale-le.

Après chaque round, note une ligne : `Round <n>/<max> — <x> constats (<k> corrigés, <h> hors périmètre, <m> mineurs, <t> à trancher)`.

Avant de déclarer la boucle convergée, lance **une fois** la vérification de types du dépôt (et le lint) : une correction qui casse un type survit à toutes les relectures ciblées. Une erreur trouvée là rouvre la boucle (correction, un round ciblé, compté dans le plafond).

## 3. La base a-t-elle bougé ?

1. `git fetch origin`, puis `git merge-tree --write-tree --name-only origin/<base> HEAD` (code 1 = conflits) et `git log --oneline HEAD..origin/<base>` (ce qui est arrivé sur la base depuis le départ de la branche).
2. Fusionne la base seulement si c'est nécessaire : conflits, `mergeStateStatus` à `BEHIND`, ou un commit arrivé sur la base qui touche un fichier de la PR ou ce qu'elle importe, ou qui invalide une prémisse d'une correction (un délai, un quota, un contrat cités dans un message de commit).
3. Pas de rebase : la branche est publiée, et l'usine refuse un historique réécrit. `git merge --no-edit origin/<base>`, résous chaque hunk lu avec Edit en gardant l'intention des deux côtés, `git add`, `git commit --no-edit`, puis relance tests touchés et vérification de types. Les deux côtés se contredisent, deux migrations changent les mêmes tables, ou la résolution sort du périmètre : `git merge --abort` et question.

## 4. Rendre la main

Commite tout, puis termine ton tour. Tu ne pousses pas et tu n'attends pas la CI : l'usine vérifie ton dernier commit, le publie, et lance `factory:fix-ci` si la CI échoue.

## 5. Quand demander à un humain

Un point **à trancher** qui est peut-être un défaut, un défaut bloquant encore ouvert au plafond, un conflit dans un des trois cas d'arrêt : pose UNE question avec `factory-agent ask`. Elle bloque le ticket : il ne passe pas en « prêt à merger » et ton dernier message **n'est pas publié**. La question porte donc la synthèse : rounds faits, ce qui est corrigé, et le point à décider avec ses options et l'historique de la clé.

Points à trancher qui ne sont que des compromis ou des préférences, mineurs, hors périmètre : pas de question, ils vont dans le dernier message.

## Interdits

Ne merge jamais. Ne pousse jamais, sur aucune branche : l'usine publie. Ne rebase pas, ne réécris pas l'historique (`--amend` compris). Ne change pas de branche. Ne corrige jamais un constat hors périmètre. Ne désactive ni n'affaiblis aucun test ou étape de CI.

## Dernier message (publié dans Linear)

En français :

```
**Synthèse de review** — N rounds sur <max>, niveau du round 1 : <rapide|standard|approfondi> (<raison>).
**Corrigé** — puces (<sha court> par cause).
**Reste à voir par un humain** — points à trancher (avec les deux options), mineurs restants (`fichier:ligne — constat`), conflits de règle (avec la règle) ; ou « rien ».
**Hors périmètre** — défauts qui préexistent à la PR, une ligne chacun avec importance (haute/moyenne/faible) et s'ils méritent un ticket ; ou « rien ».
```
