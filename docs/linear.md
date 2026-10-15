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
- **crée dans chaque équipe configurée les statuts manquants** (voir § 5) et les labels `agent:reprendre` et `agent:stop` ;
- poste les messages de reprise en attente (runs interrompus par un redémarrage) ;
- démarre la réconciliation (toutes les 30 s).

Le jeton est rafraîchi automatiquement. Aux démarrages suivants, Relais se reconnecte seul avec les jetons de `secrets.json`. `relais status` et l'interface indiquent si Linear est connecté.

## 3. Webhooks : smee ou URL publique

Linear doit pouvoir joindre Relais. Deux modes, réglés dans `config.yaml` :

- **Relais smee (par défaut sur un poste)** : `relay: { kind: smee, url: https://smee.io/… }`. Linear envoie les webhooks au canal public smee.io ; `relais up` s'y abonne (flux SSE) et les rejoue localement. Rien à ouvrir sur la machine. Le canal est créé par `relais init`.
- **URL publique (serveur, tunnel)** : `publicUrl: https://relais.exemple.fr` et `relay: { kind: none }`. Linear appelle directement `POST <publicUrl>/webhooks/linear`.

Chaque webhook est vérifié, quel que soit le mode :

- **signature HMAC-SHA256** du corps brut avec le *webhook signing secret*, comparée à l'en-tête `linear-signature` (comparaison en temps constant) ; sinon refus (401) ;
- **secret obligatoire** : si le *webhook signing secret* est vide (ou fait seulement d'espaces) ou absent de `secrets.json`, **tous** les webhooks sont refusés (401), même ceux dont la signature est calculée sur ce secret vide (n'importe qui pourrait la calculer). `relais init` redemande le secret tant que la réponse est vide, et `relais up` affiche un avertissement au démarrage s'il manque ;
- **fraîcheur** : `webhookTimestamp` à moins de 60 s de l'horloge locale ; sinon refus (401). Gardez l'horloge de la machine synchronisée (NTP).

Un canal smee est public : n'importe qui connaissant l'URL peut y lire les événements (contenu des tickets) et y écrire. La signature empêche d'injecter de faux événements, pas la lecture. Pour un usage durable ou sur des données sensibles, préférez une URL publique.

**Limite du relais smee : il ne transmet pas les octets d'origine.** smee.io décode le JSON reçu de Linear et ne relaie que l'objet décodé ; Relais le ré-encode (`JSON.stringify`) avant de vérifier la signature. Le résultat est identique aux octets signés tant que Linear envoie un JSON compact produit par `JSON.stringify`, ce qui est le cas aujourd'hui (validé à la recette du 11/10) : accents, emojis, `\n`, guillemets et nombres ordinaires passent. Il diffère, et le webhook est refusé en 401, si le corps contient des espaces ou une indentation, des échappements facultatifs (`\/`, `\u00e9`), des nombres non canoniques (`1.0`, `1e3`, `-0`, entiers au-delà de 2⁵³), des clés en double ou des clés numériques hors de l'ordre de `JSON.stringify`. Dans ce cas, le journal affiche `relay: webhook rejected with 401 (…)` avec les trois causes possibles (secret faux, horloge décalée, corps non reproductible) ; si le secret et l'horloge sont bons, passez en `publicUrl`. La réconciliation rattrape entre-temps les délégations manquées.

Un webhook manqué n'est pas perdu : la **réconciliation** relit toutes les 30 s les tickets délégués de chaque équipe (au plus 100 par équipe, hors statuts terminés ou annulés) et rattrape les délégations, retraits et changements de statut manqués.

## 4. Utiliser l'agent au quotidien

| Dans Linear | Effet (pack standard) |
|---|---|
| **Déléguer** un ticket à `relais` (champ « délégué » du ticket) | Session d'agent ouverte, « Pris en compte. » en quelques secondes, contrôles de prise en charge, puis run `dev` : statut *In Progress*, PR ouverte, statut *Human Review*, résumé dans la session. |
| Répondre dans la session de l'agent | Retours regroupés : un run `dev-feedback` 3 minutes après le dernier message (immédiat si le ticket est bloqué). |
| Déplacer de *Human Review* vers *In Progress* | Run `dev-feedback` (retours de la PR et du fil). |
| Déplacer vers *AI Review* | Run `review` (boucle de review IA), puis *Ready to Merge*. |
| `@relais <question>` dans un commentaire | Réponse en lecture seule (`ask`), y compris sur un ticket non délégué. |
| `@relais retiens <fait>` | PR dans le dépôt de connaissance (`remember`). |
| `@relais fais-le` | Rappelle qu'il faut déléguer le ticket. |
| Label `agent:stop`, bouton stop de la session, ou retrait de la délégation | Arrêt du run, ticket bloqué. |
| Label `agent:reprendre` | Relance `dev-feedback` (débloque). |

Après le merge de la PR (détecté par le relevé GitHub) : statut *Done*, worktree supprimé, run `learn`.

Seuls les tickets **délégués** à l'agent reçoivent du travail de code ; une mention sur un ticket non délégué ne donne qu'une réponse. Tout ce comportement se change dans `.relais/workflow.yml` : [`workflow.md`](workflow.md). Les contrôles avant de prendre un ticket (description d'au moins 30 caractères, pas de branche existante…) sont décrits dans [`workflow.md`](workflow.md#tracker) ; `relais plan` les applique à blanc.

Un ticket bloqué (échec, plafond, question, stop, redémarrage) attend un humain : répondez dans la session ou posez `agent:reprendre`.

## 5. États, colonnes et labels

Relais raisonne en six **états logiques** associés par nom aux statuts de l'équipe :

| État logique | Statut Linear (pack) | Type Linear donné s'il est créé |
|---|---|---|
| `todo` | Todo | `unstarted` |
| `dev` | In Progress | `started` |
| `human_review` | Human Review | `started` |
| `ai_review` | AI Review | `started` |
| `ready` | Ready to Merge | `started` |
| `done` | Done | `completed` |

Les statuts absents sont créés à la connexion. Si vos colonnes portent d'autres noms, déclarez-les dans `states` de `.relais/workflow.yml` **avant** de connecter Linear ([`workflow.md`](workflow.md#states)), sinon Relais crée les noms du pack à côté des vôtres.

Les déplacements faits par Relais lui-même sont reconnus (pendant 60 s) et ne redéclenchent pas de règle.

## 6. Équipes et projets

Un projet Relais = un dépôt + **une** équipe Linear (`linearTeamKey` dans `config.yaml`). Une même instance peut suivre plusieurs équipes (un projet chacune) ; voir [`projets-et-workspaces.md`](projets-et-workspaces.md). Les webhooks d'une équipe non configurée sont ignorés.

## Dépannage

Voir [`exploitation.md`](exploitation.md#dépannage) : webhooks rejetés, callback refusée, statuts dupliqués, reconnexion.
