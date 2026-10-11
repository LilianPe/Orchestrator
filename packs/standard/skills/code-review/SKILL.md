---
name: code-review
description: Relire un diff à un niveau proportionné à son risque (rapide, standard, approfondi), limité à ce que le diff change ou casse, avec des défauts classés et vérifiés. Utilisé par relais:review et en auto-review dans relais:dev.
---

# relais:code-review

Tu relis un diff comme un relecteur exigeant, pas comme son auteur. Le résultat est une **liste de défauts vérifiés**, classés, que l'appelant corrige. Une review coûte des tokens : son niveau se choisit sur le risque du diff, une fois, avant de commencer.

## 1. Délimiter le diff

La base est la branche cible de la PR (`gh pr view <branche> --json baseRefName --jq .baseRefName`) ; sans PR, le tronc (`git rev-parse --abbrev-ref origin/HEAD`, qui affiche `origin/<tronc>`). Une commande par appel, sans enchaînement shell :

```bash
git fetch origin
git log --oneline origin/<base>..HEAD
git diff --stat origin/<base>...HEAD
git diff origin/<base>...HEAD
```

Pour un round ciblé (relire seulement des commits de correction) : `git show <sha>` pour chaque commit, plus leurs consommateurs (voir 4).

Lis aussi les règles du dépôt qui s'appliquent aux fichiers touchés : `CLAUDE.md` (racine et dossiers concernés), `docs/agent/`, et le ticket (ce que le diff doit faire).

## 2. Choisir le niveau

Prends le plus haut niveau qui correspond à une partie du diff ; dans le doute entre deux, le plus haut.

| Le diff touche… | Niveau |
|---|---|
| Texte, libellés, faute de frappe, configuration triviale, documentation qui n'affirme rien sur le code | **rapide** |
| Logique applicative, état, routes, services, requêtes ; documentation qui décrit le comportement du code ; tests | **standard** |
| Authentification, permissions, isolation entre clients, secrets, migrations de schéma, suppression de données, concurrence, argent ; ou un gros diff (plus de ~800 lignes ou ~20 fichiers de code) | **approfondi** |

Une documentation qui décrit le code n'est pas un diff « rapide » : sa vérité est dans le code, hors du diff. Liste chaque affirmation qu'elle fait et vérifie-la dans le code.

- **Rapide** : une lecture attentive du diff, hunk par hunk. Pas d'exploration au-delà.
- **Standard** : la lecture, plus les passes de la section 3, plus les consommateurs des symboles modifiés (`grep -rn "<symbole>"`).
- **Approfondi** : tout le standard, en passes séparées par angle (section 3), avec la liste explicite des surfaces critiques à éprouver (contrôles d'accès, filtrage par client, réversibilité d'une migration, ce qui se passe en cas d'échec à mi-chemin). Si l'outil de sous-agents est disponible, lance une passe par angle en parallèle (consigne pour chacune : le diff exact, l'angle, « ne signale que des défauts dans ces lignes ou ce qu'elles cassent », lecture seule, pas de sous-agent) ; sinon fais les passes toi-même, l'une après l'autre. Réserve-le aux diffs qui le justifient : c'est le niveau le plus cher.

## 3. Les angles

1. **Justesse** : le code fait-il ce que le ticket demande ? Cas limites (vide, nul, zéro, un seul, très grand), erreurs (que se passe-t-il quand l'appel échoue ?), conditions inversées, état partagé.
2. **Ce que le diff casse ailleurs** : un symbole supprimé ou renommé → cherche l'ancien nom dans tout le dépôt, commentaires et docs compris ; un type ou une signature exportée élargie → ses implémentations et appelants ; un effet déplacé dans une fonction partagée → chacun de ses appelants respecte-t-il la nouvelle condition ? Une condition retirée alors que la donnée qu'elle gardait reste ; un nouveau compteur ajouté à un total dont un « reste » est déduit.
3. **Les tests** : couvrent-ils le comportement, ou le mock ? Une assertion qui ne peut pas échouer (mock posé trop tard, valeur que le banc produirait de toute façon, `not.toThrow` jamais vu rouge) ne garde rien. Un test supprimé dont le nom décrit un cas de repli : le cas est-il encore couvert ?
4. **Les règles du dépôt** : conventions écrites dans `CLAUDE.md` et voisins, motif établi ailleurs dans le code. Cite la règle.
5. **Sécurité et données** (approfondi, ou dès qu'une surface sensible est touchée) : entrées non validées, accès non filtré, secret dans le code ou les logs, migration irréversible ou destructrice, opération non atomique.
6. **Commentaires et messages** : un commentaire ou une doc qui contredit le code (ou une correction du même diff) est un défaut, pas un détail : le prochain lecteur « réparera » dans le mauvais sens. Une affirmation d'un message de commit (« déjà géré ailleurs », « même motif que X ») se vérifie en ouvrant X.

Lis **chaque hunk** d'un fichier touché, même quand le message de commit dit que le fichier « ne fait que déplacer du code ».

## 4. Classer chaque constat

D'abord la **portée**, par causalité, pas par fichier :

- **dans le périmètre** : une conséquence de ce diff, y compris dans un fichier que le diff ne modifie pas (un appelant cassé) ;
- **hors périmètre** : un défaut qui existait avant et que le diff ne change pas. Il n'est jamais corrigé ici : liste-le à part ;
- **conflit de règle** : causé par le diff, mais la correction proposée enfreint une règle écrite du dépôt. Ne pas l'appliquer ; le signaler avec la règle.

Puis la **gravité** :

- **bloquant** : bug, perte ou corruption de données, faille, régression, contrat cassé, chemin critique sans test, test qui ne peut pas échouer ;
- **important** : défaut réel mais rare ou rattrapé ailleurs, duplication qui divergera, commentaire ou doc qui dit le contraire du code ;
- **mineur** : lisibilité, nommage, style non couvert par le lint, sans effet sur le comportement.

Ignore ce que le lint, le compilateur ou la CI attrapent déjà, et les préférences sans règle écrite.

## 5. Vérifier avant de rapporter

Un constat est une affirmation : vérifie-le avant de le garder.

- Lis la fonction citée **en entier**, pas les lignes d'un `grep` : la garde est souvent entre deux résultats.
- « X peut arriver » : trace si un vrai appelant atteint cet état. Inatteignable : écarte-le, avec la trace.
- Un constat qui dépend d'une version de bibliothèque : cherche dans le dépôt un usage existant de la même forme avant de le déclarer faux.
- Garde seulement ce dont tu es sûr après vérification. Un doute réel et important : garde-le, en disant ce qui permettrait de trancher.

## 6. Rendre le résultat

Une ligne par constat, du plus grave au moins grave :

```
[bloquant|important|mineur] chemin/fichier.ts:42 — ce qui ne va pas, dans quel scénario, pourquoi ça compte → correction suggérée
```

Puis, s'il y en a : « Hors périmètre » (une ligne chacun), « Conflits de règle » (avec la règle). Aucun constat : écris « aucun défaut trouvé » et ce que tu as vérifié (niveau, angles, fichiers).

Le relecteur ne modifie rien pendant la review : les corrections viennent après, par l'appelant (`relais:receiving-review`).
