# Personnaliser `workflow.yml`

Ce guide explique comment adapter le comportement de Relais sur un dépôt sans lire le code : quels événements Linear ou GitHub déclenchent quoi, avec quel modèle, quelles limites et quelles vérifications.

## 1. Rôle du fichier et fusion avec le pack

Relais lit deux fichiers et les combine :

- **le workflow du pack** `packs/standard/workflow.yml` (livré avec Relais) : il définit le comportement par défaut ;
- **le workflow du projet** `.relais/workflow.yml`, à la racine du dépôt confié à Relais (chemin `repoPath` de `~/.relais/config.yaml`). Il est facultatif : sans lui, le pack s'applique tel quel. `relais init` en crée un minimal (voir plus bas).

Le fichier du projet ne contient **que ce que vous changez**. Règles de fusion exactes :

| Partie | Règle |
|---|---|
| `tracker`, `states`, `limits`, `workspace` | Fusion en profondeur, clé par clé : `limits: { per_run: { usd: 10 } }` ne change que le budget et garde `turns` et `duration` du pack. |
| Listes (`verify`, `setup`, `pickup.checks`…) | **Remplacées** en entier, jamais concaténées. |
| `on` | **Remplacé par type d'événement** : si le projet déclare `on.status.changed`, toute la liste `status.changed` du pack est ignorée ; les autres événements du pack restent actifs. |
| `jobs` | Fusion en profondeur, job par job : `jobs.review.model: sonnet` ne change que le modèle du job `review` du pack. Un nom de job absent du pack crée un nouveau job. |
| `extends` d'un job | Le job hérite de son parent champ par champ, **sauf** `on_start` et `on_success`, qui remplacent en entier la valeur du parent quand ils sont présents (`on_start: {}` annule donc le `move` hérité). |

L'ordre est : fusion pack + projet, puis résolution des `extends`. Conséquence pratique : `jobs.dev.verify` défini dans le projet est hérité par `dev-feedback` et `fix-ci`, qui étendent `dev`.

Limite de la fusion : on ne peut pas **supprimer** une clé héritée d'un job (`null` est refusé). On peut seulement la remplacer par une autre valeur. Pour neutraliser un comportement, on agit sur les règles `on` (section 6).

**Quand le fichier est-il lu ?** Une seule fois, au démarrage de `relais up` (et à chaque `relais plan`). Il est lu sur le disque, dans la copie de travail `repoPath`, pas sur `origin`. Après une modification : redémarrez `relais up`. Une erreur de validation empêche le démarrage.

Fichier généré par `relais init` (si `.relais/workflow.yml` n'existe pas encore) :

```yaml
version: 1
extends: standard
tracker:
  kind: linear
  team: REL
workspace:
  setup: ["npm ci"]
jobs:
  dev:
    verify: ["npm run lint", "npm run typecheck", "npm test"]
```

`setup` vaut `["npm ci"]` si le dépôt a un `package-lock.json`, sinon `[]`. `verify` propose les scripts `lint`, `typecheck` et `test` trouvés dans `package.json` ; vous pouvez modifier la liste pendant `init`.

## 2. Référence clé par clé

### `version` (obligatoire)
Toujours `1`. Toute autre valeur, ou son absence, est refusée.

### `extends`
Accepté pour lisibilité (`extends: standard`) mais **sans effet** : le pack utilisé est toujours `packs/standard`.

### `tracker`
| Clé | Type | Défaut | Effet |
|---|---|---|---|
| `kind` | `linear` | `linear` | Seul tracker supporté. |
| `team` | texte | — | Informatif. L'équipe réellement suivie est `linearTeamKey` dans `~/.relais/config.yaml`. |
| `pickup.checks` | liste parmi `has_description`, `not_started`, `has_acceptance_criteria` | pack : `[has_description, not_started]` (`[]` si aucun fichier n'en définit) | Contrôles faits avant le **premier** run d'un job `pickup: true` (voir `jobs.*.pickup`). |

Les contrôles :
- `has_description` : la description du ticket fait au moins 30 caractères.
- `not_started` : aucune branche `relais/<id-du-ticket>-…` n'existe déjà sur `origin`.
- `has_acceptance_criteria` : la description contient « critères d'acceptation » (ou « critère d'acceptation », « criteres… ») ou « acceptance criteria », sans tenir compte de la casse.

Si un contrôle échoue, le ticket est bloqué et Relais répond dans la session Linear avec la liste des problèmes (« Je ne peux pas commencer ce ticket… Corrigez puis répondez dans ce fil »). `relais plan` affiche, pour chaque ticket délégué, s'il serait pris ou non, et pourquoi.

### `states`
Associe les six **états logiques** de Relais aux noms exacts des colonnes (statuts) Linear de l'équipe :

| État logique | Pack |
|---|---|
| `todo` | `Todo` |
| `dev` | `In Progress` |
| `human_review` | `Human Review` |
| `ai_review` | `AI Review` |
| `ready` | `Ready to Merge` |
| `done` | `Done` |

Vous pouvez n'en redéfinir qu'une partie ; après fusion, les six doivent avoir un nom. Aucun autre nom d'état n'est accepté. Lors de « Connecter Linear », Relais crée dans l'équipe les statuts manquants. Un statut Linear qui n'est associé à aucun état logique est vu comme « inconnu » : un déplacement vers lui produit un `status.changed` avec `to` vide, que les règles `from`/`to` ne reconnaissent pas.

### `limits`
| Clé | Type | Défaut | Effet quand la limite est atteinte |
|---|---|---|---|
| `parallel_sessions` | entier > 0 | 3 | Nombre de runs simultanés dans la file `dev`. Au-delà, les runs attendent dans une file persistante. Chaque run de la file `dev` reçoit aussi `PORT = workspace.ports.base + n° de place` (0 à `parallel_sessions - 1`). |
| `question_sessions` | entier > 0 | 2 | Même chose pour la file `questions`. |
| `per_run.turns` | entier > 0 | 150 | Nombre de messages de l'assistant dans un run. Au-delà, le run est interrompu ; son résultat est `limit`. |
| `per_run.duration` | durée | `90m` | Durée maximale d'un run, même résultat `limit`. |
| `per_run.usd` | nombre > 0 | 5 | Passé à Claude Code (`--max-budget-usd`) ; quand Claude Code s'arrête sur ce plafond, le résultat est `limit`. |
| `verify_attempts` | entier ≥ 0 | 2 | Nombre de passes de vérification avant de bloquer le ticket (voir `jobs.*.verify`). `0` et `1` bloquent dès le premier échec. |
| `ci_fix_attempts` | entier ≥ 0 | 2 | Nombre de runs qu'une CI rouge (`pr.checks_failed`) peut lancer avant que la CI rouge suivante bloque le ticket (voir ci-dessous). `0` bloque dès la première CI rouge. |
| `review_rounds` | entier > 0 | 5 | Indiqué au skill de review dans son prompt (« Rounds de review max : 5 ») ; seulement pour les jobs dont le skill se termine par `:review`. C'est le skill qui respecte ce nombre, Relais ne le compte pas. |

`per_run` est la limite par défaut de **tous** les jobs ; chaque job peut la remplacer champ par champ avec son propre `limits`.

Que se passe-t-il quand un run atteint une limite (`limit`) ou échoue ?
- Job de la file `dev` : le ticket est **bloqué** et Relais écrit dans la session Linear « Le run <job> a atteint un plafond (tours, durée ou budget). Répondez dans ce fil pour que je reprenne. » (ou « … a échoué. »). Une réponse dans le fil relance `dev-feedback` (règle `session.prompted` du pack).
- Job de la file `questions` : Relais répond « Je n'ai pas pu terminer (échec ou plafond atteint). ».

Que se passe-t-il quand la CI reste rouge (`ci_fix_attempts`) ?
- Chaque règle `pr.checks_failed` qui lance un run (`fix-ci` dans le pack) compte ce run sur le ticket. Une fois `ci_fix_attempts` runs lancés, la CI rouge suivante n'applique pas la règle : le ticket est **bloqué** et Relais écrit dans la session Linear « CI toujours en échec après 2 tentatives de fix-ci. », la liste des checks en échec, puis « Répondez dans ce fil pour relancer. ». Les CI rouges suivantes ne relancent rien et ne répètent pas le message.
- Le compte repart de zéro quand la CI passe au vert (`pr.checks_passed`, qui lève aussi le blocage dû à cette borne), quand une autre PR est relevée pour le ticket (`pr.opened` d'un autre numéro), ou quand un humain relance le ticket bloqué (réponse dans le fil, label `agent:reprendre`, changement de statut ou délégation qui lance un run). Ni un nouveau push de l'agent (c'est la boucle elle-même) ni une minuterie `debounce` armée avant le blocage ne le remettent à zéro.
- Contrairement à `verify_attempts`, qui compte les passes (le premier run compris), `ci_fix_attempts` compte les relances : avec `2`, deux `fix-ci`, puis blocage à la troisième CI rouge. C'est l'unité de l'invariant I5 ([`decisions/ORC-138.md`](decisions/ORC-138.md), point 8).
- Borne provisoire : la boucle review IA → correction n'est pas encore comptée par le moteur, et n'a donc pas ce compteur en commun avec la CI rouge. Le compteur unique des deux boucles arrive avec ORC-184 et le préréglage d'ORC-187.

Durées : un nombre (millisecondes) ou un texte `<entier><unité>` avec l'unité `ms`, `s`, `m` ou `h` (`90m`, `30s`, `2h`). Les combinaisons comme `1h30m` sont refusées : écrivez `90m`.

Il n'existe pas de valeur « illimitée » : voir la section 8.

Le **budget journalier** de toute l'instance ne se règle pas ici, mais dans `~/.relais/config.yaml` (`limits.perDayUsd`). Quand il est atteint, les nouveaux runs restent en file jusqu'au lendemain (jour UTC) et Relais le signale une fois par ticket et par jour en commentaire.

> Les capacités des files (`parallel_sessions`, `question_sessions`) sont globales à l'instance : elles sont lues dans le workflow du **premier** projet de `config.yaml`. Les autres limites sont propres à chaque projet.

### `workspace`
| Clé | Type | Défaut | Effet |
|---|---|---|---|
| `setup` | liste de commandes | `[]` | Exécutées (via `bash -lc`, dans l'ordre) à la **création** d'un worktree, pas aux runs suivants qui le réutilisent. Si l'une échoue, le worktree est supprimé et le ticket bloqué (« Erreur au lancement : Le setup du worktree a échoué : <commande> »). |
| `ports.base` | entier > 0 | 4200 | Premier port attribué aux runs de la file `dev` (`PORT` dans l'environnement du run). |

### `on`
Les règles d'événements, détaillées en section 3.

### `jobs`
Un job décrit **comment** lancer un run de Claude Code. Champs :

| Champ | Valeurs | Défaut | Effet |
|---|---|---|---|
| `extends` | nom d'un autre job | — | Hérite de ses champs (voir section 1). |
| `queue` | `dev`, `questions` | **obligatoire** | File d'exécution (section 5). Un job `dev` n'est lancé que sur un ticket délégué à Relais. |
| `model` | texte | **obligatoire** | Passé tel quel à `claude --model` (alias comme `sonnet`, `opus`, `haiku`, ou identifiant complet). |
| `workspace` | `worktree`, `trunk-readonly`, `knowledge` | **obligatoire** | `worktree` : worktree git propre au ticket, sur une branche `relais/<ticket>-<titre>`, réutilisé d'un run à l'autre. `trunk-readonly` : copie de la branche principale à jour, run lancé en mode plan (lecture seule). `knowledge` : worktree du dépôt de connaissance ; le job est ignoré si aucun dépôt de connaissance n'est configuré. |
| `session` | `new`, `resume` | `new` | `resume` reprend la session Claude du ticket si elle existe (le contexte du développement), sinon en ouvre une nouvelle. |
| `skill` | texte | **obligatoire** | Le prompt du run commence par `/<skill>` suivi du ticket (identifiant, titre, URL, branche, PR, description). Les skills de job du pack s'appellent `relais:dev`, `relais:feedback`, `relais:fix-ci`, `relais:review`, `relais:ask`, `relais:learn` ; ils chargent eux-mêmes les skills de méthode ([`pack-et-skills.md`](pack-et-skills.md#les-skills-de-méthode)). |
| `input` | `feedback`, `ci_failures`, `thread`, `verify_failures` | — | Section ajoutée au prompt (voir ci-dessous). |
| `verify` | liste de commandes | `[]` | Lancées après un run réussi (voir ci-dessous). |
| `pickup` | booléen | `false` | Si `true`, applique `tracker.pickup.checks` avant le premier run du ticket (quand aucune session Claude n'existe encore). |
| `limits` | `{ turns, duration, usd }`, chacun facultatif | `limits.per_run` | Remplace les limites par run pour ce job. |
| `on_start` | `{ move: <état logique> }` | `{}` | Déplace le ticket au lancement du run (s'il n'y est pas déjà). |
| `on_success` | `{ move: <état logique>, post: summary \| reply \| synthesis }` | `{}` | Après un run réussi (et des vérifications réussies) : déplace le ticket et/ou publie le dernier message du run dans la session Linear. Aujourd'hui les trois valeurs de `post` produisent le même effet ; le nom documente l'intention. |

Les valeurs de `input` :
- `feedback` : les messages du fil Linear accumulés depuis le dernier run, plus les commentaires de review non résolus de la PR (titre « Retours à traiter »).
- `ci_failures` : « La CI de la PR est en échec. Lancez `gh pr checks` pour le détail. » (titre « CI en échec »).
- `thread` : le texte du message qui a déclenché le run (mention ou commande) (titre « Message »). Vide si l'événement n'est pas un message.
- `verify_failures` : utilisé par Relais lui-même quand il relance un job après des vérifications en échec ; inutile à configurer.

Les vérifications (`verify`) : chaque commande est lancée dans le worktree (`bash -lc`, 15 minutes maximum par commande), **toutes** les commandes sont lancées même si l'une échoue.
- Toutes passent : `on_success` s'applique.
- Une échoue et il reste des tentatives : Relais relance **le même job** en reprenant la session, avec la sortie des commandes en échec (fin de sortie, 8 000 caractères au plus).
- Après `limits.verify_attempts` passes en échec : le ticket est bloqué et Relais poste la liste des commandes en échec dans la session.

Jobs du pack :

| Job | File | Modèle | Rôle |
|---|---|---|---|
| `dev` | dev | sonnet | Premier développement ; passe le ticket en `dev` au départ, en `human_review` à la fin, et publie un résumé. |
| `dev-feedback` | dev | sonnet | Étend `dev` : reprend la session pour traiter les retours. |
| `fix-ci` | dev | sonnet | Étend `dev-feedback` : corrige la CI. |
| `review` | dev | opus | Review IA en session neuve, puis passe en `ready`. |
| `ask` | questions | sonnet | Répond aux questions en lecture seule (30 tours, 5 min, 0,5 $). |
| `learn` | questions | haiku | Après un merge, alimente la base de connaissance. |
| `remember` | questions | haiku | Étend `learn` : retient ce qu'on lui demande (`@relais retiens …`). |

## 3. Les règles `on`

`on` associe un type d'événement à une **liste ordonnée** de règles. Pour un événement donné, Relais parcourt la liste et applique **la première règle qui correspond, et elle seule**. Si aucune ne correspond, il ne se passe rien, sauf pour une réponse dans la session dev du ticket, qui est toujours gardée (voir `session.prompted`).

### Événements configurables

| Événement | Quand | Particularités |
|---|---|---|
| `ticket.delegated` | Le ticket est délégué à Relais dans Linear. | — |
| `status.changed` | Le ticket change de statut dans Linear (par un humain). | Filtrable avec `from` / `to`. Les déplacements faits par Relais lui-même ne génèrent pas cet événement. |
| `session.mentioned` | `@relais …` dans un commentaire, quand le premier mot n'est pas une commande. | — |
| `session.prompted` | Réponse dans une session Linear de Relais. | Dans la session dev d'un ticket délégué, le message est toujours ajouté aux retours en attente (`input: feedback`), qu'une règle corresponde ou non : sans règle pour l'état du ticket (`todo`, `ai_review`, `ready`, `done` dans le pack), il attend le prochain run qui lit les retours (`input: feedback` : `dev-feedback` dans le pack). Dans une session de question, Relais lance directement `ask`, sans lire les règles. |
| `session.stopped` | Bouton « stop » dans Linear, ou ticket retiré à l'agent. | Dans une session de question, Relais arrête la réponse en cours, sans lire les règles. |
| `label.changed` | Un label est ajouté au ticket ou en est retiré (par un humain). | Filtrable avec `label`. Seul l'ajout correspond à une règle : un retrait entre dans l'inbox et le journal (`change: removed`) mais ne déclenche rien. |
| `push.human` | Un humain pousse un commit sur la branche du ticket. | Aucune règle dans le pack. Relais ne reçoit pas encore cet événement (webhooks GitHub : ORC-134). |
| `command` | `@relais <mot> …` quand `<mot>` est une valeur `say` de la liste `command`. | Filtrable avec `say`. |
| `pr.checks_passed` | La CI de la PR passe. | Avant les règles, Relais remet à zéro le compte des relances sur CI rouge (`limits.ci_fix_attempts`) et lève le blocage dû à cette borne. |
| `pr.checks_failed` | La CI de la PR échoue. | Une règle qui lance un run est bornée par `limits.ci_fix_attempts` : une fois la borne atteinte, Relais bloque le ticket au lieu d'appliquer la règle. |
| `pr.merged` | La PR est mergée. | Avant les règles, Relais note la PR comme mergée et arrête le travail du ticket comme un `stop`, sans le bloquer : run `dev` en cours arrêté, runs en attente ou en file et minuteries `debounce` supprimés. Ensuite, plus aucun job de la file `dev` ne démarre sur le ticket, quelle que soit la règle, la minuterie ou l'attente qui le demande (`agent:reprendre`, réponse, CI rouge, job en attente ou en file) : le refus est seulement tracé, sans message dans Linear. La fin du run `dev` arrêté et ses vérifications sont ignorées. Les règles s'appliquent après l'arrêt : `done`, nettoyage et `learn` ne changent pas, et les jobs de la file `questions` (`learn`, `ask`) tournent toujours. Le ticket redevient actif quand un humain change son statut pour autre chose que *Done* (aussi quand Relais n'a pas pu le passer en *Done*), le délègue à nouveau, ou qu'une nouvelle PR (autre numéro) est relevée pour lui. Le relevé GitHub ne regarde plus un ticket en *Done* dont la PR est mergée : une nouvelle PR n'est vue qu'une fois le ticket sorti de *Done*. |
| `pr.closed` | La PR est fermée sans merge. | — |

Le pack n'utilise pas `pr.checks_passed` ni `pr.closed` : vous pouvez y ajouter vos propres règles.

### Événements du cycle de vie (non configurables)

Ces types sont acceptés par le chargeur, mais Relais les traite en dur : une règle placée dessous **ne se déclenche jamais**.

| Événement | Comportement fixe |
|---|---|
| `run.finished` | Succès : vérifications si le job en a, sinon `on_success`. Échec ou limite : ticket bloqué (file `dev`) ou message d'erreur (file `questions`). Run arrêté : rien. Fin d'un run de la file `dev` après le merge de la PR : rien. |
| `verify.passed` / `verify.failed` | `on_success`, ou nouvelle tentative, ou blocage (voir `verify`). Après le merge de la PR : rien. |
| `debounce.fired` | Lance le job dont le délai `debounce` vient d'expirer (et débloque le ticket). |
| `pr.opened` | Mémorise la PR et l'attache à la session Linear. |
| `control.pause` / `control.resume` / `control.stop` | Pause / reprise de la file, arrêt d'un ticket (interface, `relais pause`, `relais resume`, `relais stop`). |

Tout autre nom sous `on` est refusé (`on.<nom>: unknown event type`), sauf les deux anciens noms, encore acceptés comme alias : `ticket.moved` (lu comme `status.changed`) et `label.added` (lu comme `label.changed`). Un même fichier ne peut pas déclarer un événement sous ses deux noms : le chargement est refusé (`on.ticket.moved: same event as on.status.changed`).

Les événements qui concernent un ticket que Relais ne suit pas encore sont ignorés, sauf `ticket.delegated`, `session.mentioned`, `session.prompted` et `command`, qui l'ajoutent au suivi.

**Événements non fiables.** Chaque événement porte une étiquette de confiance (`taint`). Un événement marqué `untrusted` (contenu venu d'une source que l'orchestrateur ne tient pas pour fiable) ne lance jamais un job `workspace: knowledge` (`learn`, `remember`) : la règle s'applique sans ce run, et une activité Linear explique le refus. Les autres runs que l'événement demande portent la liste des chemins sensibles qu'ils ne doivent pas écrire (`.github/**`, `.factory/**`, `.claude/**`, `CODEOWNERS`, `.env*`). La liste va jusqu'au runner : le run enregistré (`sensitivePaths`) et la requête du runner la portent. L'ingestion Linear marque `untrusted` ce que Linear n'attribue pas à un utilisateur de l'espace : réponse ou commentaire sans id d'utilisateur, passé par un bot ou venu d'hors de l'espace, changement de ticket fait par une intégration ou une app OAuth ([Linear](linear.md), ORC-160). Rien n'applique encore cette liste : le runner Claude Code l'ignore, jusqu'à la sandbox du runner (ORC-151, ORC-204). Chaque retour en attente garde l'étiquette de l'événement qui l'a apporté : un run qui lit les retours (`input: feedback`) est non fiable dès qu'un de ces retours l'est, même lancé plus tard par un événement fiable (fin de `debounce`, label `agent:reprendre`, passage en `dev`). L'étiquette d'un run est fixée à son **lancement**, sur ce qu'il lit alors, et non quand la décision le demande : un job mis en attente derrière un run (lancé par `settle` à la fin de ce run) ou resté dans la file lit les retours arrivés entre-temps, et devient non fiable si l'un d'eux l'est. Le run garde aussi les chemins sensibles avec lesquels il a été demandé. Les commentaires de review non résolus que la forge renvoie à un run `input: feedback` sont toujours non fiables : quiconque peut commenter la PR les écrit, et rien ne les authentifie comme venant de l'équipe (ORC-160). Un job `knowledge` qui lirait au lancement un retour non fiable (commentaire de review compris) est refusé, et le refus est expliqué dans sa session Linear. Un retour enregistré avant cette règle, sans étiquette, compte comme fiable, comme un événement de la première version du journal : aucune source ne marquait alors d'événement `untrusted`. Les autres runs, relance de `verify` comprise, ne prennent que l'étiquette de leur événement, même quand ils reprennent une session Claude qui a lu un contenu non fiable (à reprendre avec ORC-160).

### Champs d'une règle

**Conditions** (toutes doivent être vraies) :

| Champ | Effet |
|---|---|
| `when` | Condition sur l'état du ticket (section 4). |
| `from`, `to` | État logique de départ / d'arrivée. Ne filtrent que `status.changed` (ignorés sur les autres événements). |
| `label` | Nom exact du label. La règle ne correspond **qu'à** l'ajout de ce label (`label.changed`). |
| `say` | Mot de commande, **en minuscules** (Relais met en minuscules le mot tapé). La règle ne correspond qu'à `command`. Chaque `say` déclaré sous `command` devient un mot de commande reconnu. |

Une règle sans condition correspond toujours.

**Actions** (appliquées dans cet ordre) :

| Champ | Effet |
|---|---|
| `move` | Déplace le ticket vers cet état logique. |
| `labels` | `{ add: [...], remove: [...] }` : ajoute / retire des labels Linear. |
| `comment` | Publie ce texte en commentaire du ticket. |
| `do` | `stop` : arrête le run en cours, vide les runs en attente et bloque le ticket (« Arrêté. Répondez dans ce fil ou posez le label agent:reprendre pour relancer. »). `cleanup` : supprime le worktree du ticket. `propose_delegate` : répond qu'il faut déléguer le ticket à Relais pour qu'il le développe. |
| `run` | Lance le job de ce nom (doit exister dans `jobs`). Si le ticket était bloqué, il est débloqué d'abord. |
| `debounce` | Avec `run` : au lieu de lancer tout de suite, programme le job après ce délai. Un nouvel événement correspondant avant l'expiration repousse le délai : des messages rapprochés donnent un seul run. `0s` = immédiat. |

Une règle sans action est valide : elle « consomme » l'événement sans rien faire (et empêche les règles suivantes de s'appliquer).

Il n'existe pas de champ `post` dans une règle : la publication du résultat se règle dans `jobs.*.on_success`.

**Ticket non délégué.** Si le ticket n'est pas délégué à Relais, une règle dont le `run` vise un job de la file `dev` est sautée (sauf sur `ticket.delegated`) et Relais passe à la règle suivante. Seuls les jobs de la file `questions` tournent sur un ticket non délégué.

### Règles du pack

| Événement | Règles (dans l'ordre) |
|---|---|
| `ticket.delegated` | si `state in [todo, dev] && !blocked` → `dev` |
| `status.changed` | de `human_review` vers `dev` → `dev-feedback` ; vers `ai_review` → `review` |
| `session.prompted` | si `blocked` → `dev-feedback` immédiatement ; si `state in [dev, human_review]` → `dev-feedback` après 3 min sans nouveau message ; sinon, le message reste dans les retours en attente |
| `session.mentioned` | → `ask` |
| `command` | `retiens` → `remember` ; `fais-le` → `propose_delegate` |
| `label.changed` | `agent:reprendre` → `dev-feedback` ; `agent:stop` → `stop` |
| `session.stopped` | → `stop` |
| `pr.checks_failed` | si `state in [human_review, ai_review] && !blocked` → `fix-ci`, au plus `limits.ci_fix_attempts` fois de suite, puis blocage |
| `pr.merged` | → passe en `done`, supprime le worktree, lance `learn` |

## 4. Grammaire de `when`

Une condition est une suite d'**atomes** reliés par `&&` (tous doivent être vrais).

| Atome | Vrai quand |
|---|---|
| `state == <état>` | L'état logique du ticket est `<état>`. |
| `state != <état>` | Il ne l'est pas. |
| `state in [<état>, <état>, …]` | Il est l'un de ceux-là. |
| `blocked` | Le ticket est bloqué (échec, limite, stop, contrôle de prise en charge…). |
| `!blocked` | Il ne l'est pas. |
| `job == <nom>` | Le job du run `dev` en cours sur le ticket est `<nom>`. |

`<état>` est l'un des six états logiques (`todo`, `dev`, `human_review`, `ai_review`, `ready`, `done`), jamais un nom de colonne Linear. Pour un événement sans ticket connu, l'état vaut `todo` et `blocked` est faux.

Valides :

```text
state == dev
state != done && !blocked
state in [human_review, ai_review] && !blocked
blocked
job == review
```

Refusés (`on.<événement>[<n>].when: invalid condition: …`) :

```text
state == todo || blocked        # || interdit : écrivez deux règles
!(state == done)                # pas de parenthèses ni de ! devant un atome autre que blocked
!state in [todo]                # pas de négation de « in » : listez les autres états
state == "In Progress"          # un état logique, pas un nom de colonne
state == backlog                # état logique inconnu
```

Pour exprimer un « ou », écrivez plusieurs règles à la suite : la première qui correspond gagne.

## 5. Du YAML à l'action

1. Linear ou GitHub envoie un événement (webhook, ou relevé périodique des PR).
2. Si c'est un événement du cycle de vie, Relais applique son comportement fixe. Sinon, il prend la première règle de `on.<événement>` qui correspond.
3. La règle produit des commandes. Pour `run: <job>`, c'est une commande « lancer un run » qui porte le nom du job (ou un délai, avec `debounce`).
4. L'orchestrateur lit alors `jobs.<job>` :
   - file `dev` sur un ticket non délégué : refusé ;
   - job `knowledge` sans dépôt de connaissance : ignoré ;
   - file `dev` alors qu'un run ou des vérifications sont en cours sur ce ticket : le job est mis **en attente sur le ticket** et lancé dès que le run en cours est terminé. Il n'y a qu'une place d'attente par ticket : une nouvelle demande remplace la précédente ;
   - file en pause ou budget journalier atteint : mis en file ;
   - pas de place libre dans la file (`parallel_sessions` / `question_sessions`) : mis en file ;
   - sinon : lancement.
5. Lancement : contrôles `pickup` si besoin, préparation de l'espace de travail (`workspace`), `on_start.move`, choix de la session (`session`), construction du prompt (`/<skill>`, ticket, `input`), puis Claude Code avec `model` et les `limits` du job.
6. Fin du run : comportement fixe de `run.finished` (vérifications, `on_success`, ou blocage).

Les deux files :
- `dev` : le travail sur le code d'un ticket délégué (dev, retours, CI, review). **Un seul run `dev` à la fois par ticket.**
- `questions` : les réponses et la mémoire (`ask`, `learn`, `remember`). Elles ne bloquent pas le développement du ticket ; une seule à la fois par ticket, les autres attendent leur tour.

## 6. Recettes

Chaque exemple ci-dessous est un `.relais/workflow.yml` complet et valide (un test du dépôt les charge tous avec le pack).

### Augmenter le parallélisme

```yaml
version: 1
limits:
  parallel_sessions: 5
  question_sessions: 3
workspace:
  ports: { base: 4200 }
```

Cinq runs `dev` simultanés, sur les ports 4200 à 4204. Rappel : ces deux capacités sont lues dans le workflow du premier projet de `config.yaml`.

### Ajouter des commandes de vérification

```yaml
version: 1
jobs:
  dev:
    verify: ["npm run lint", "npm run typecheck", "npm test"]
limits:
  verify_attempts: 3
```

`dev-feedback` et `fix-ci` héritent de cette liste. Les vérifications ne s'appliquent pas à `review`, qui n'étend pas `dev` : ajoutez-lui un `verify` si besoin.

### Changer de modèle pour la review

```yaml
version: 1
jobs:
  review:
    model: sonnet
    limits: { usd: 2, duration: 30m }
```

### Ajouter un job personnalisé avec son propre skill

Un audit de sécurité en lecture seule, déclenché par `@relais audite <précisions>` :

```yaml
version: 1
jobs:
  audit:
    queue: questions
    model: opus
    workspace: trunk-readonly
    session: new
    skill: "audit-securite"
    input: thread
    limits: { turns: 60, duration: 15m, usd: 2 }
    on_success: { post: reply }
on:
  command:
    - { say: retiens, run: remember }
    - { say: "fais-le", do: propose_delegate }
    - { say: audite, run: audit }
```

- Les règles `command` du pack sont répétées, car déclarer `on.command` remplace toute la liste du pack.
- Le skill doit être disponible pour Claude Code dans l'espace de travail du run : par exemple un skill de projet `.claude/skills/audit-securite/SKILL.md` versionné dans le dépôt (il est alors présent dans la copie de la branche principale et dans les worktrees). Vérifiez qu'il se lance avec `claude -p "/audit-securite"` dans le dépôt.
- Un nouveau job doit définir `queue`, `model`, `workspace` et `skill`, ou les hériter avec `extends`.

### Déclencher un job sur un label

Lancer la review IA en posant le label `agent:review`, puis retirer ce label :

```yaml
version: 1
on:
  label.changed:
    - { label: "agent:reprendre", run: dev-feedback }
    - { label: "agent:stop", do: stop }
    - { label: "agent:review", run: review, labels: { remove: ["agent:review"] } }
```

Relais ne crée que les labels `agent:reprendre` et `agent:stop` : créez `agent:review` dans Linear. `review` est un job de la file `dev` : il ne tourne que sur un ticket délégué.

### Désactiver un comportement du pack

On ne peut pas supprimer un job du pack, mais un job qu'aucune règle ne lance ne tourne jamais. Pour retirer un comportement, redéclarez la liste de l'événement concerné sans la règle à retirer.

Pas de review IA (passer en AI Review ne lance plus rien) :

```yaml
version: 1
on:
  status.changed:
    - { from: human_review, to: dev, run: dev-feedback }
```

Pas de correction automatique de la CI, ni d'apprentissage après le merge :

```yaml
version: 1
on:
  pr.checks_failed: []
  pr.merged:
    - { move: done, do: cleanup }
```

### Adapter les noms de colonnes Linear

```yaml
version: 1
states:
  dev: "En cours"
  human_review: "Relecture"
```

Les autres états gardent les noms du pack. Les statuts manquants sont créés dans Linear à « Connecter Linear ».

### Exiger des critères d'acceptation

```yaml
version: 1
tracker:
  pickup:
    checks: [has_description, not_started, has_acceptance_criteria]
```

La liste remplace celle du pack : répétez les contrôles que vous voulez garder.

## 7. Erreurs fréquentes et validation

Relais valide le fichier au démarrage de `relais up` et refuse de démarrer s'il est invalide ; le message nomme la clé fautive. Il n'y a pas de commande dédiée de validation : redémarrez `relais up`, ou lancez `relais plan` (qui charge aussi les workflows, une fois Linear connecté). Seule la **première** erreur est affichée : corrigez et relancez.

| Erreur | Message |
|---|---|
| Clé inconnue à la racine, dans `states`, un job, `on_start`, `on_success` ou une règle (ex. faute de frappe) | `<fichier>: jobs.dev: Unrecognized key: "verfy"` |
| Valeur hors liste | `<fichier>: jobs.dev.queue: Invalid option: expected one of "dev"\|"questions"` |
| Limite à 0 ou négative | `<fichier>: limits.parallel_sessions: Too small: expected number to be >0` |
| `version` absente ou différente de 1 | `<fichier>: version: Invalid input: expected 1` |
| Événement inconnu (ou `ticket.undelegated`, interne) | `on.ticket.created: unknown event type` |
| `run` vers un job inexistant | `on.label.changed[0].run: unknown job "audit"` |
| Condition invalide | `on.ticket.delegated[0].when: invalid condition: state == todo \|\| blocked` |
| Champ obligatoire manquant dans un nouveau job | `jobs.audit.queue: required` |
| `extends` vers un job inexistant | `jobs.<parent>: unknown job` (le message nomme le parent introuvable) |
| `extends` circulaire | `jobs.a.extends: cycle` |
| Durée mal écrite | `invalid duration: 1h30m` (sans chemin : cherchez dans `duration` et `debounce`) |
| État logique manquant après fusion | `states.<état>: required` |

Pièges silencieux (aucune erreur) :
- **Sous `limits`, `limits.per_run`, un `limits` de job, `workspace` et `tracker`, une clé inconnue est ignorée sans message.** `limits: { parallel: 5 }` est accepté et ne fait rien : relisez l'orthographe.
- Une règle sur un événement du cycle de vie (`run.finished`, `verify.*`, `debounce.fired`, `pr.opened`, `control.*`) ne se déclenche jamais.
- `from` / `to` sur un autre événement que `status.changed` sont ignorés ; `label` ou `say` sur le mauvais événement rendent la règle inapplicable.
- Un `say` avec une majuscule ne correspond jamais.
- Déclarer `on.<événement>` dans le projet efface les règles du pack pour cet événement : recopiez celles que vous gardez.
- Un `move` fait par Relais (règle ou `on_success`) ne déclenche pas les règles `status.changed` : par exemple, `on_success: { move: ai_review }` ne lance pas la review.
- Modifier le fichier sans redémarrer `relais up` n'a aucun effet.

## 8. Pas de limite « illimitée »

Toutes les limites doivent être strictement positives (sauf `verify_attempts` et `ci_fix_attempts`, qui acceptent 0 : bloquer dès le premier échec, pas lever la limite) : il n'existe pas de valeur `0`, `-1` ou `unlimited` qui désactive un plafond. Pour lever une limite en pratique, mettez une grande valeur :

```yaml
version: 1
limits:
  per_run: { turns: 1000, duration: 8h, usd: 50 }
```

Gardez pourtant des plafonds raisonnables : ils arrêtent un agent qui tourne en boucle, bornent la dépense d'un ticket mal spécifié, et libèrent la place d'un run bloqué pour les autres tickets (un run occupe sa place dans la file jusqu'à la fin). Un run arrêté par une limite n'est pas perdu : le ticket est bloqué avec un message, et une réponse dans le fil reprend la même session.
