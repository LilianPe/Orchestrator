# Linear

Relais agit dans Linear comme un **agent** : une application OAuth installée avec `actor=app`, à qui l'on délègue des tickets et que l'on mentionne avec `@relais`. Cette page décrit la création de l'application, la connexion, les webhooks et l'usage au quotidien.

## 1. Créer l'application OAuth

`relais init` affiche ces instructions avec les URL exactes de votre instance. Dans Linear (compte admin de l'espace) : **Settings → API → OAuth applications → New application**.

| Champ | Valeur |
|---|---|
| Name | `relais` : c'est le nom que l'on mentionnera avec `@`. |
| Callback URL | `http://localhost:4100/oauth/callback`, ou `<publicUrl>/oauth/callback` si `publicUrl` est défini. Le port suit `port` de `config.yaml`. |
| Webhooks | Cochés. URL : le canal smee créé par `relais init` (`https://smee.io/…`), ou `<publicUrl>/webhooks/linear`. |
| Catégories de webhook | **Agent session events**, **Issues**, **Comments**. |

Créez l'application, puis copiez dans `relais init` :

- le **Client ID** ;
- le **Client secret** ;
- le **Webhook signing secret**.

Ils sont enregistrés dans `<RELAIS_HOME>/secrets.json` (mode `0600`, voir [`configuration.md`](configuration.md#secretsjson)).

Linear peut refuser une URL de callback en `http://localhost` : dans ce cas, exposez temporairement Relais par un tunnel (`cloudflared tunnel --url http://localhost:4100`), mettez l'URL du tunnel dans `publicUrl` de `config.yaml`, mettez à jour la Callback URL de l'application et redémarrez `relais up` le temps de la connexion. Ce point est à vérifier à la recette ([`recette.md`](recette.md)).

## 2. Connecter Linear (installer l'agent)

1. `relais up`.
2. Ouvrez l'interface (`http://localhost:4100`) et cliquez **Connecter Linear** (ou ouvrez `/oauth/start`).
3. Linear demande d'autoriser l'application pour l'espace, avec les scopes `read`, `write`, `app:assignable`, `app:mentionable` et `actor=app` (l'application agit en son nom propre, pas au vôtre).
4. Retour sur `/oauth/callback` : « Linear est connecté. Vous pouvez fermer cet onglet. »

À la connexion, Relais :

- enregistre les jetons, l'identifiant de l'agent (`appUserId`) et de l'organisation ;
- **crée dans chaque équipe configurée les statuts manquants** (voir § 5) et les labels `agent:reprendre`, `agent:stop` et `Bloqué` ;
- poste les messages de reprise en attente (runs interrompus par un redémarrage) ;
- lance une réconciliation tout de suite ; ensuite, elle passe toutes les 5 minutes (ORC-185).

Le jeton est rafraîchi automatiquement. Aux démarrages suivants, Relais se reconnecte seul avec les jetons de `secrets.json`. `relais status` et l'interface indiquent si Linear est connecté.

## 3. Webhooks : smee ou URL publique

Linear doit pouvoir joindre Relais. Deux modes, réglés dans `config.yaml` :

- **Relais smee (par défaut sur un poste)** : `relay: { kind: smee, url: https://smee.io/… }`. Linear envoie les webhooks au canal public smee.io ; `relais up` s'y abonne (flux SSE) et les rejoue localement. Rien à ouvrir sur la machine. Le canal est créé par `relais init`.
- **URL publique (serveur, tunnel)** : `publicUrl: https://relais.exemple.fr` et `relay: { kind: none }`. Linear appelle directement `POST <publicUrl>/webhooks/linear`.

Chaque webhook est vérifié, quel que soit le mode :

- **signature HMAC-SHA256** du corps brut avec le *webhook signing secret*, comparée à l'en-tête `linear-signature` (comparaison en temps constant) ; sinon refus (401) ;
- **secret obligatoire** : si le *webhook signing secret* est vide (ou fait seulement d'espaces) ou absent de `secrets.json`, **tous** les webhooks sont refusés (401), même ceux dont la signature est calculée sur ce secret vide (n'importe qui pourrait la calculer). `relais init` redemande le secret tant que la réponse est vide, et `relais up` affiche un avertissement au démarrage s'il manque ;
- **fraîcheur** : `webhookTimestamp` à moins de 60 s de l'horloge locale ; sinon refus (401). Gardez l'horloge de la machine synchronisée (NTP).
- **inbox écrite avant la réponse** (ORC-147) : les événements tirés du webhook sont écrits dans l'inbox du store (Postgres, ou SQLite sans `FACTORY_DATABASE_URL`) avant que Relais réponde, puis l'accusé « Pris en compte. » part dans la session. Un 200 veut dire « écrit » : si le démon tombe juste après, même brutalement, rien n'est perdu, l'événement est traité au démarrage suivant. Si l'écriture échoue (base injoignable), la réponse est 500 et Linear renvoie le webhook.
- **déduplication** : un webhook déjà reçu ne crée ni nouvel événement ni nouveau run. La clé vient du corps signé, jamais de l'en-tête `linear-delivery` (non signé) : id de l'activité pour une réponse ou un stop, id de la session pour une délégation ou une mention, id du ticket et `updatedAt` pour un changement de ticket, sinon empreinte SHA-256 du corps sans son `webhookTimestamp`. Un rejeu du même corps, ou un renvoi par Linear avec un nouveau `webhookTimestamp`, est donc ignoré : l'id de l'événement est déjà dans l'inbox, le rejeu ne reposte pas « Pris en compte. » et n'est pas retraité. La déduplication est en base : elle survit à un redémarrage.
- **événements typés, acteur signé et taint** (ORC-160) : un webhook devient des événements typés (`ticket.delegated`, `session.mentioned`, `command`, `session.prompted`, `session.stopped`, `status.changed`, `label.changed`), jamais du texte libre ; un label ajouté **ou retiré** à la main entre comme `label.changed` (`change: added` / `removed` ; les règles du workflow ne voient que l'ajout). Chaque événement porte `schemaVersion`, l'id Linear de son **acteur** tel que le corps signé le donne (`actor` : l'auteur de la réponse, du commentaire ou de la délégation, ou l'`actor` d'un changement de ticket), et une étiquette de **taint**. L'événement est `trusted`, avec l'id de l'utilisateur, quand Linear nomme un utilisateur de l'espace comme auteur ; `untrusted`, sans `actor`, sinon : pas d'id d'utilisateur, changement fait par une intégration ou une app OAuth (`actor.type` autre que `user`), commentaire passé par un bot ou venu d'hors de l'espace (`botActor`, `externalUser` : Slack, e-mail, demandes clients). La délégation et le changement de statut que la réconciliation retrouve sans webhook n'ont pas d'acteur signé : ils sont `untrusted` aussi. Le nom de l'auteur (`author`) vient du même objet que son id. Un événement `untrusted` ne lance pas de job `knowledge` et ses runs portent les chemins sensibles ([workflow](workflow.md)). Les autorisations (qui peut faire quoi) se vérifient sur cet `actor`, jamais sur un nom cité dans le texte : voir [Autorisations](#autorisations--qui-peut-faire-quoi) (ORC-186). Les labels et statuts posés par Relais lui-même sont des échos ignorés, ajouts comme retraits ; seul le retrait d'un label qu'enlève un ajout de Relais dans le même groupe exclusif revient comme `label.changed` retiré, qui ne déclenche rien. Dans un groupe de labels Linear, ajouter un label retire les autres du groupe ; une règle qui en demande deux du même groupe échoue.
- **accusé « Pris en compte. »** : il part encore du chemin du webhook, une fois l'inbox écrite, et non comme effet de l'outbox ; il le deviendra avec ORC-171.

Un canal smee est public : n'importe qui connaissant l'URL peut y lire les événements (contenu des tickets) et y écrire. La signature empêche d'injecter de faux événements, pas la lecture. Pour un usage durable ou sur des données sensibles, préférez une URL publique.

**Limite du relais smee : il ne transmet pas les octets d'origine.** smee.io décode le JSON reçu de Linear et ne relaie que l'objet décodé ; Relais le ré-encode (`JSON.stringify`) avant de vérifier la signature. Le résultat est identique aux octets signés tant que Linear envoie un JSON compact produit par `JSON.stringify`, ce qui est le cas aujourd'hui (validé à la recette du 11/10) : accents, emojis, `\n`, guillemets et nombres ordinaires passent. Il diffère, et le webhook est refusé en 401, si le corps contient des espaces ou une indentation, des échappements facultatifs (`\/`, `\u00e9`), des nombres écrits autrement que ne les écrirait `JSON.stringify` (par exemple `1.0`, `1e3`, `-0`, `0.30000000000000001` au lieu de `0.3`, `9007199254740993`, `1000000000000000000000` au lieu de `1e+21`), des clés en double ou des clés numériques hors de l'ordre de `JSON.stringify`. Dans ce cas, le journal affiche `relay: webhook rejected with 401 (…)` avec les trois causes possibles (secret faux, horloge décalée, corps non reproductible) ; si le secret et l'horloge sont bons, passez en `publicUrl`.

La **réconciliation** relit toutes les 5 minutes les tickets délégués de chaque équipe (au plus 100 par équipe, hors statuts terminés ou annulés) et rattrape trois choses manquées : une délégation ; un retrait (ticket qui n'est plus délégué ou qui est passé dans un statut terminé ou annulé : son run en cours est arrêté par la règle `session.stopped` du workflow, présente dans le pack standard) ; un changement entre statuts déclarés dans `workflow.states` et non terminaux. Tout le reste n'arrive que par webhook et se perd si le webhook est manqué ou refusé : réponses dans la session, mentions et commandes `@relais`, arrêt demandé dans la session, labels ajoutés, et le passage en terminé ou annulé en tant que changement de statut (seul le retrait est rattrapé).

Sa cadence est une **minuterie en base** (ORC-185) : le pseudo-ticket `_reconcile.<projet>` de chaque projet porte sa minuterie `reconcile`, posée au démarrage du démon si elle manque, dans 5 minutes (la connexion à Linear lance déjà un passage ; un redémarrage n'en arme pas une seconde), et réarmée à chaque passage. Un passage en échec est journalisé sans casser la chaîne ; la minuterie d'un projet retiré de la configuration est supprimée au démarrage. Chaque passage relit aussi les PR (voir [GitHub](github.md)) ; ce qu'il rattrape entre dans l'inbox comme tout événement, avec un id déterministe, donc un événement déjà reçu par webhook n'est pas traité deux fois.

## 4. Utiliser l'agent au quotidien

| Dans Linear | Effet (pack standard) |
|---|---|
| **Déléguer** un ticket à `relais` (champ « délégué » du ticket) | Session d'agent ouverte, « Pris en compte. » en quelques secondes, contrôles de prise en charge, puis run `dev` : statut *In Progress*, PR ouverte, statut *Human Review*, résumé dans la session. |
| Répondre dans la session de l'agent | Retours regroupés : un run `dev-feedback` 3 minutes après le dernier message (immédiat si le ticket est bloqué). |
| Déplacer de *Human Review* vers *In Progress* | Run `dev-feedback` (retours de la PR et du fil). |
| Déplacer vers *AI Review* | Run `review` (boucle de review IA), puis retour en *Human Review* pour la relecture humaine. |
| `@relais <question>` dans un commentaire | Réponse en lecture seule (`ask`), y compris sur un ticket non délégué. |
| `@relais retiens <fait>` | PR dans le dépôt de connaissance (`remember`). |
| `@relais fais-le` | Rappelle qu'il faut déléguer le ticket. |
| Label `agent:stop`, bouton stop de la session, ou retrait de la délégation | Arrêt du run, ticket bloqué. |
| Label `agent:reprendre` | Relance `dev-feedback` (débloque). |

**Done vaut décision de merge (ORC-148).** Un ticket délégué en *Human Review*, dont la PR est ouverte, passé en *Done* par un humain qui a le droit de merge GitHub (vérifié sur l'acteur du webhook signé), est mergé par l'usine avec sa GitHub App, sur le **commit montré en *Human Review*** : quand l'usine passe le ticket en *Human Review* à la fin de son propre travail, elle retient la tête de la PR, et ne merge que ce commit, si c'est encore la tête de la PR du ticket et que ses checks sont verts. La méthode de merge est la première que le dépôt autorise (merge, sinon squash, sinon rebase).

**Push depuis la review** : rien n'est mergé, et les nouveaux commits **repassent par la review IA**. L'usine passe le ticket en *AI Review* et lance elle-même le job de la règle `status.changed` `to: ai_review` (`review` dans le pack standard) : un déplacement fait par l'usine n'émet pas de `status.changed`, la règle ne se déclencherait pas seule. La review réussie ramène le ticket en *Human Review* sur la nouvelle tête, qui devient le commit relu : le *Done* suivant la merge. La règle est choisie comme pour un humain qui passerait le ticket de *Done* à *AI Review* (`from`, `when` compris) ; seul son `run` est appliqué. Un ticket bloqué (il attend un humain), ou un workflow sans état `ai_review` ou sans cette règle, repart en *Human Review* comme pour les autres refus. Un refus qui arrive après qu'un humain a sorti le ticket de *Done* (effet rejoué en retard) est seulement répondu : le ticket reste où l'humain l'a mis.

Les autres refus ne mergent rien et renvoient le ticket en *Human Review* avec la raison en commentaire : acteur sans droit, checks du commit relu pas tous verts (rouges, encore en cours, ou aucun check : un dépôt sans CI ne se merge pas par *Done*), PR de la branche qui n'est pas celle du ticket, PR que GitHub refuse de merger, merge qui échoue jusqu'au bout de ses relances (GitHub indisponible), aucun commit relu enregistré (l'usine n'en retient un que quand elle passe elle-même le ticket en *Human Review* : pas pour un ticket mis là à la main, ni si la tête de la PR n'a pas pu être lue ; passez le ticket en *AI Review*, la review IA l'enregistre en le ramenant en *Human Review*). Une PR déjà mergée sur GitHub entre-temps n'est pas un refus : le ticket reste en *Done*. Ce retour **garde** le commit relu : une tête poussée depuis n'est jamais prise pour relue. Pour abandonner une PR, passez le ticket en *Canceled*, pas en *Done*. **Annuler un ticket n'écrit jamais rien sur la forge** : ni merge, ni fermeture de la PR, qui reste ouverte (deux tickets peuvent partager une PR). Avec la CLI `gh` au lieu de la GitHub App, l'usine ne merge pas.

Ce qui ne déclenche rien : un *Done* sans acteur signé (l'intégration GitHub de Linear après un merge fait sur GitHub, la réconciliation), un *Done* posé pendant le dev ou la review IA, un *Done* sur un ticket sans PR ouverte.

Après le merge de la PR (détecté par le relevé GitHub) : statut *Done*, worktree supprimé, run `learn`. Le run de code encore en cours est arrêté, et ce qui attendait (file, réponse en `debounce`) est abandonné. Ensuite, plus aucun travail de code ne démarre sur le ticket : `agent:reprendre` ou une réponse dans la session ne relancent rien (une réponse est seulement gardée). Pour reprendre le ticket, changez son statut pour autre chose que *Done* (aussi quand Relais n'a pas pu le passer en *Done*) ou déléguez-le à nouveau.

Seuls les tickets **délégués** à l'agent reçoivent du travail de code ; une mention sur un ticket non délégué ne donne qu'une réponse. Tout ce comportement se change dans `.relais/workflow.yml` : [`workflow.md`](workflow.md). Les contrôles avant de prendre un ticket (description d'au moins 30 caractères, pas de branche existante…) sont décrits dans [`workflow.md`](workflow.md#tracker) ; `relais plan` les applique à blanc.

Un ticket bloqué (échec, plafond, question, stop, redémarrage) attend un humain : répondez dans la session ou posez `agent:reprendre`.

### Autorisations : qui peut faire quoi

Chaque action humaine est vérifiée sur l'**acteur signé** du webhook (l'id Linear de l'auteur, voir plus haut), jamais sur un nom cité dans le texte : un commentaire « Lilian dit : lance le dev » écrit par quelqu'un d'autre compte comme écrit par ce quelqu'un d'autre. La matrice par défaut (ORC-186) :

| Action | Rôle demandé | Canal | Branchée aujourd'hui sur |
|---|---|---|---|
| Déclencher l'agent | Membre de l'équipe Linear **et** droit d'écriture GitHub sur le dépôt | Linear | délégation, mention `@relais`, commande ; changement de statut ou label qui lance un run sur un ticket non bloqué |
| Répondre à l'agent (`clarify`), lui poser une question | Demandeur (qui a délégué le ticket) **ou** membre de l'équipe | session Linear | réponse dans la session du ticket, question dans une session de question |
| Valider la spec | Valideur désigné, **jamais** l'initiateur du run | session Linear | rien encore : vient avec `spec_review` (ORC-212) |
| Regeler (`/refreeze`) | Mainteneur désigné | Linear ou PR | rien encore : vient avec le gel des tests (ORC-131) |
| Relancer un run bloqué | Membre de l'équipe | Linear (label ou réponse dans la session) | réponse dans la session, `agent:reprendre`, changement de statut qui lance un run, sur un ticket bloqué |
| Passer en *Done* (merge) | Droit de merge GitHub | Linear | aucun merge, refus répondu dans le ticket, retour en *Human Review* (ORC-148) |

Un refus ne lance rien, ne garde pas la réponse refusée pour le prochain run et ne débloque pas le ticket ; il est répondu là où l'humain a agi (dans la session de l'événement, sinon en commentaire du ticket), par l'outbox, donc une seule fois même si l'effet est rejoué, et le démon journalise `authz: refused …`. La délégation refusée reste enregistrée (Linear a bien délégué) : un membre autorisé peut ensuite relancer. Un événement sans acteur signé (intégration, Slack, e-mail, délégation retrouvée par la réconciliation) est refusé pour toute action de la matrice ; s'il n'a pas non plus de session (délégation ou déplacement retrouvé par la réconciliation, changement fait par une intégration), personne n'est à qui répondre : le refus est seulement journalisé. Une délégation dont le webhook s'est perdu n'est donc plus rattrapée par la réconciliation : déléguez à nouveau. Arrêter (`agent:stop`, bouton stop, retrait de la délégation) n'est pas dans la matrice. Les événements GitHub (`push.human`, `pr.reviewed`, `pr.conflicted`, `pr.closed`) n'y passent pas non plus aujourd'hui : aucun ne fait agir l'usine pour un humain (revue et conflit sans réaction, ORC-190 et ORC-146 ; une PR fermée ne fait qu'arrêter ; un push humain est non fiable et ne lance rien). Leurs réactions apporteront leur vérification, sur le login GitHub signé.

**D'où viennent les rôles.** Avant de décider un événement humain que la matrice peut vérifier, le démon résout les rôles de son acteur et les **journalise avec l'événement** : un rejeu du journal décide sur les mêmes rôles, et `decide` reste pure : le rejeu du journal (`npm run test:replay`, ORC-174) refait la même décision, refus compris, et la trace du refus est gardée dans `decision_trace`. Un événement que la matrice ne vérifie pas (label retiré, changement de statut qu'aucune règle à `run` ne prend, ticket non suivi) n'attend ni Linear ni GitHub.

- *Membre de l'équipe* : membres actifs de l'équipe Linear du projet (`teams { members }`).
- *Droit d'écriture* et *droit de merge* : permission de l'utilisateur sur le dépôt (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`), lue par la GitHub App ou, en repli, par `gh api` (un login que GitHub ne connaît pas n'a aucun droit avec l'App ; avec `gh`, qui donne le même 404 pour un dépôt qu'il ne voit pas, toute erreur fait attendre l'événement) ; `write`, `maintain` et `admin` donnent les deux (GitHub laisse merger avec le droit d'écriture, protections de branche à part). Linear ne donne pas de login GitHub que Relais sache lire : chaque utilisateur Linear dont les droits GitHub comptent est relié à son login dans `config.yaml` (`projects[].authz.githubLogins`). Sans login, aucun droit GitHub : cet utilisateur ne peut pas déclencher.
- *Mainteneur* et *valideur* : listes d'ids Linear dans `config.yaml` (`projects[].authz.maintainers`, `validators`), jusqu'à `.factory/config.yml` (ORC-209). Voir [configuration](configuration.md#autorisations).
- *Demandeur*, *initiateur* : l'auteur signé de la dernière délégation autorisée du ticket.

Les membres Linear et les permissions GitHub sont gardés **60 s** puis relus : quelqu'un qui quitte l'équipe ou perd ses droits ne peut plus agir au-delà. Si Linear ou GitHub ne répond pas, l'événement attend dans l'inbox et il est retenté ; il n'est jamais décidé sans ses rôles. La matrice est une constante du code (`src/core/authz.ts`) jusqu'à ce que le préréglage `factory/default` la déclare (ORC-187).

## 5. États, colonnes et labels

Relais raisonne en cinq **états logiques** associés par nom aux statuts de l'équipe (« Ready to Merge » n'existe plus depuis ORC-170) :

| État logique | Statut Linear (pack) | Type Linear donné s'il est créé |
|---|---|---|
| `todo` | Todo | `unstarted` |
| `dev` | In Progress | `started` |
| `human_review` | Human Review | `started` |
| `ai_review` | AI Review | `started` |
| `done` | Done | `completed` |

Les statuts absents sont créés à la connexion. Si vos colonnes portent d'autres noms, déclarez-les dans `states` de `.relais/workflow.yml` **avant** de connecter Linear ([`workflow.md`](workflow.md#states)), sinon Relais crée les noms du pack à côté des vôtres.

Les déplacements faits par Relais lui-même sont reconnus (pendant 60 s) et ne redéclenchent pas de règle.

Un ticket délégué passé par un humain dans un statut de type *Canceled* annule son run (arrêt, file et réponses en attente abandonnées) ; il n'est pas bloqué, et un blocage en cours est levé avec son label (ORC-170).

Tant qu'un ticket est **bloqué** (l'usine attend une réponse), le label `Bloqué` est posé à côté de son statut ; il est retiré quand le ticket repart. Relais le crée à la connexion, avec `agent:reprendre` et `agent:stop`.

## 6. Équipes et projets

Un projet Relais = un dépôt + **une** équipe Linear (`linearTeamKey` dans `config.yaml`). Une même instance peut suivre plusieurs équipes (un projet chacune) ; voir [`projets-et-workspaces.md`](projets-et-workspaces.md). Les webhooks d'une équipe non configurée sont ignorés.

## Dépannage

Voir [`exploitation.md`](exploitation.md#dépannage) : webhooks rejetés, callback refusée, statuts dupliqués, reconnexion.
