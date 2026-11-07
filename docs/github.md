# GitHub

Relais parle à GitHub à travers **git** et une **GitHub App d'usine**. Le démon utilise l'App quand elle est configurée ; sinon il retombe sur la CLI **`gh`** (repli de migration). **Seule l'usine écrit sur GitHub** (ORC-125, [Publication](#publication)) : les agents commitent, et n'ont ni jeton ni réseau pour pousser. Le démon suit les PR de deux façons, qui écrivent les mêmes événements dans l'inbox : les **webhooks GitHub** (`POST /webhooks/github`, dès que leur secret est configuré, voir [Webhooks GitHub](#webhooks-github)) et le **relevé** des PR toutes les 30 s, gardé jusqu'à la réconciliation GitHub (ORC-185) et son retrait (ORC-181).

## Authentification du démon

### GitHub App (recommandé)

La GitHub App est l'identité du **démon**, pas celle des agents. Elle sert à lire les PR, les checks et les fils de review sans dépendre de `GH_TOKEN` ni de la CLI `gh`, et à publier : pousser la branche du ticket, ouvrir sa PR draft, merger.

```yaml
# <RELAIS_HOME>/config.yaml
github:
  appId: "123456"
  privateKey: /home/relais/.relais/github-app.pem   # PEM inline ou chemin de fichier
  installationId: "987654"                          # facultatif
```

Les variables d'environnement servent de repli, pour les installations existantes et Docker :

| Variable | Rôle |
|---|---|
| `GH_APP_ID` | identifiant de l'App |
| `GH_APP_KEY` | clé privée PEM, ou chemin vers le fichier `.pem` |
| `GH_APP_INSTALLATION_ID` | installation à utiliser ; facultatif |

Une valeur de `config.yaml` l'emporte sur la variable d'environnement. Si une seule des deux valeurs `appId` / `privateKey` est fournie, le démarrage échoue avec un message explicite plutôt que de basculer silencieusement sur `gh`.

#### Créer l'App

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Renseignez un nom et une URL. **Webhook** : actif, URL `<publicUrl>/webhooks/github`, secret = la valeur de `github.webhookSecret` (ou `GH_WEBHOOK_SECRET`) ; événements : *Pull request*, *Pull request review*, *Pull request review comment*, *Check run*, *Check suite*, *Push*, *Workflow run* (ces deux derniers servent aussi aux mesures de reverts et de coût de CI, voir [Webhooks GitHub](#webhooks-github) ; *Workflow run* demande la permission *Actions* en lecture, déjà dans le manifeste). Sans URL publique, laissez-le désactivé : le relevé toutes les 30 s suit les PR seul.
3. Dans **Repository permissions**, appliquez le manifeste [`github-app-manifest.json`](github-app-manifest.json) :
   - **Contents** : lecture/écriture ;
   - **Pull requests** : lecture/écriture ;
   - **Checks** : lecture ;
   - **Commit statuses** : lecture ;
   - **Actions** : lecture (lister les environnements et leurs règles de protection, pour `factory doctor`) ;
   - **Metadata** : lecture (obligatoire pour toute App).
   Aucune permission d'**administration**, ni `Actions` en écriture, ni `Workflows`.
4. Créez l'App, notez son **App ID**, puis **Generate a private key**. Placez le `.pem` hors du dépôt, en mode `0600` (par exemple `~/.relais/github-app.pem`).
5. **Install** l'App sur les dépôts confiés à Relais. L'identifiant d'installation est visible dans l'URL `https://github.com/settings/installations/<id>` ; il est facultatif, le démon sait le retrouver dépôt par dépôt.
6. Renseignez `config.yaml` ou les variables `GH_APP_*`, puis redémarrez `relais up`. Le démarrage journalise le forge choisi, sans secret.

#### Jetons

- Le démon signe un **JWT RS256** avec la clé privée : `iss = appId`, `iat = maintenant - 60 s`, `exp = maintenant + 9 min`.
- Il échange ce JWT contre un **jeton d'installation** : `POST /app/installations/{id}/access_tokens` avec `{ "repositories": ["<dépôt du run>"] }`. Si `installationId` n'est pas configuré, il appelle d'abord `GET /repos/{owner}/{repo}/installation`.
- Le jeton dure **au plus 1 heure**. Il est mis en cache **par dépôt** jusqu'à son expiration, avec une marge de sécurité de 60 s.
- Il reste **en mémoire du démon** : jamais écrit sur disque, jamais journalisé, jamais transmis aux runs Claude Code, pas plus que `GH_TOKEN`. Un run ne peut donc pas agir sur un autre dépôt avec ce jeton.
- La clé privée n'est jamais journalisée. Le message de démarrage ne contient que l'App ID et, le cas échéant, l'ID d'installation.

#### Rotation de clé

1. GitHub App → **Private keys → Generate a private key**.
2. Déposez le nouveau `.pem` (mode `0600`) et mettez à jour `github.privateKey` ou `GH_APP_KEY`.
3. Redémarrez le démon ; les jetons d'installation en cache sont oubliés et les nouveaux sont émis avec la nouvelle clé.
4. Révoquez l'ancienne clé dans GitHub. Les jetons d'installation déjà émis expirent d'eux-mêmes en moins d'une heure, mais une clé privée compromise peut en émettre de nouveaux : révoquez-la sans attendre.

### CLI `gh` (repli de migration)

Sans section `github`, le démon utilise `GhCliForge` et la CLI `gh`, comme avant :

- **Poste** : `gh auth login`, et git configuré pour lire `origin` (SSH ou HTTPS). Vérifiez `gh auth status` et `git fetch` depuis le dépôt.
- **Docker** : variable `GH_TOKEN` ; au démarrage, le conteneur lance `gh auth setup-git` pour que git lise en HTTPS avec ce jeton. Les dépôts montés doivent donc avoir un remote **HTTPS**. Voir [`deploiement.md`](deploiement.md).

Le démarrage journalise explicitement `forge GitHub : CLI gh (repli de migration…)`. Ce repli ne fait que lire : **sans GitHub App, l'usine ne publie ni ne merge**, et un ticket vérifié est bloqué avec cette raison. Il disparaîtra avec ORC-181.

### Publication

L'usine publie (ORC-125), par l'effet `publish` de l'outbox, que `decide` n'écrit que pour le commit que `verify` vient de trouver vert (invariant I1) et que `mayPublish` regarde encore au moment de l'exécuter. Il faut les sandboxes et la GitHub App (permissions *Contents* et *Pull requests* en écriture). `GitPublisher` (`src/publish/publish.ts`) :

1. lit sur la forge la branche par défaut et la tête de la branche du ticket ; une tête déjà sur le commit va droit à la PR, sans pousser : c'est le rejeu d'une publication coupée ;
2. fait le bundle de la branche, dans le dépôt propre de l'agent (ORC-317), dans un sandbox neuf à `none`, son `.git` en lecture seule ; aucun git de l'hôte n'y tourne, et le dossier git de `repoPath` n'est monté nulle part. Il le vérifie, le clone sans checkout, sans hook ni config du dépôt, et compare sa tête au commit vérifié ;
3. contrôle le diff depuis la base, de façon bloquante : `factory/chemins-interdits` (liens symboliques sortants et `package.json#scripts` compris), `factory/binaires`, `factory/secrets` ;
4. pousse **seulement vers l'avant**, en `--force-with-lease` sur la tête lue : si la branche porte un commit absent du travail (un push humain, ORC-159, ou un historique réécrit), rien n'est poussé ;
5. ouvre la PR **draft**, cherchée par branche avant création (une PR normale si l'offre du dépôt n'a pas de draft). Elle sort de draft au passage du ticket en *Human Review* : GitHub ne merge pas un draft.

Un refus est une réponse : le ticket est bloqué avec la raison (`publish.refused`), décidé une fois ; la relance qui publie le mène où il devait aller (`owedMove`). Une panne est rejouée par l'outbox, puis bloque le ticket. Un run sans commit au-delà de la base finit sans PR.

Le texte de la PR est provisoire : l'id et le titre du ticket, et une phrase de l'usine, sans rien de l'agent ni de mot-clé de fermeture. Sa composition est à ORC-195, par l'`OutputPolicy` d'ORC-214.

Côté agent : `git push` et les écritures `gh` sont refusés par le pack et son hook, le proxy refuse `git-receive-pack` à tout niveau de réseau de l'agent, et aucun jeton n'entre dans un sandbox. Sur l'hôte, sans sandbox, seul le hook tient : ORC-179.

### Permissions nécessaires pour le repli `gh`

Sur chaque dépôt confié à Relais, le compte `gh` doit pouvoir :

| Action | Utilisée par | Commande |
|---|---|---|
| Lire les branches | agents, worktrees | `git fetch`, `git ls-remote` |
| Lire les PR | agents | `gh pr view`, `gh pr diff` |
| Lire les checks et les logs de CI | démon, agents | `gh pr checks`, `gh run view --log-failed` |
| Lire les fils de review | démon | `gh api graphql` (`reviewThreads`) |

Avec un jeton à granularité fine : *Contents*, *Pull requests*, *Actions* et *Checks* en lecture, *Metadata* en lecture. Avec un jeton classique : scope `repo`. Pour `relais init` → « Créer un dépôt relais-knowledge », le compte doit aussi pouvoir créer un dépôt.

## Droits des humains

La [matrice d'autorisations](linear.md#autorisations--qui-peut-faire-quoi) (ORC-186) lit la permission d'un utilisateur sur le dépôt (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`), par la GitHub App (permission *Metadata* en lecture, déjà demandée) ou, en repli, par `gh api`. Le login GitHub de chaque utilisateur Linear se déclare dans `config.yaml` (`projects[].authz.githubLogins`, voir [configuration](configuration.md#autorisations)). Une permission lue est gardée 60 s.

## Ce que Relais relève

Toutes les 5 minutes avec la réconciliation (ORC-185), et toutes les 30 s quand les webhooks GitHub sont refusés faute de secret (sans eux, un merge attendrait 5 minutes), pour chaque ticket suivi qui a une branche et n'est pas `done` (un ticket passé en `done` avant que le relevé voie le merge de sa PR connue reste relevé, pour le seul merge ou la fermeture de cette PR, jusqu'à ce qu'il les voie : Linear peut le passer en *Done* avant, et seul `pr.merged` arrête le travail de code) :

- `GET /repos/{owner}/{repo}/pulls?head={owner}:{branche}&state=all` : la PR de la branche (ouverte, mergée, fermée) ;
- si elle est ouverte, `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` et `GET /repos/{owner}/{repo}/commits/{sha}/status` : état agrégé de la CI (`fail` si un check échoue ou est annulé, `pending` si un check tourne, `pass` sinon, `none` sans check).

Un **push humain** dont le webhook s'est perdu n'est pas rattrapé : le relevé lit la tête de la PR, mais l'usine ne retient pas la tête qu'elle a poussée elle-même (suite d'ORC-185, ORC-281). Publier par-dessus un tel push est refusé : voir [Publication](#publication).

Au moment d'un run `dev-feedback`, les fils de review **non résolus** sont lus en GraphQL (`reviewThreads`) et transformés en retours pour l'agent.

Événements produits (voir [`workflow.md`](workflow.md#3-les-règles-on)) :

| Constat | Événement | Pack standard |
|---|---|---|
| Nouvelle PR pour la branche | `pr.opened` | URL ajoutée à la session Linear |
| CI qui passe au rouge | `pr.checks_failed` (avec la liste des checks en échec) | `fix-ci` si le ticket est en *Human Review* ou *AI Review* et non bloqué, au plus `limits.ci_fix_attempts` fois de suite ; ensuite le ticket est bloqué ([`workflow.md`](workflow.md#limits)) |
| CI qui passe au vert | `pr.checks_passed` | remet à zéro le compte des relances sur CI rouge et lève le blocage dû à cette borne |
| PR mergée | `pr.merged` | *Done*, worktree supprimé, `learn` ; ensuite, plus aucun run de code sur le ticket |
| Merge de l'usine refusé (ORC-148) | `pr.merge_refused` | push depuis la review : retour en *AI Review*, review IA relancée sur les nouveaux commits ; autre refus (PR non mergeable…) : retour en *Human Review* avec la raison |
| PR fermée sans merge | `pr.closed` | le travail du ticket est annulé (voir [`workflow.md`](workflow.md#événements-configurables)) |

Un changement d'état de CI n'est signalé qu'une fois (pas à chaque relevé). Les commentaires de review **non résolus** de la PR sont relus au moment d'un run `dev-feedback` (entrée `feedback`) : résolvez un fil sur GitHub pour qu'il ne soit plus renvoyé à l'agent.

Sans webhook GitHub, il faut jusqu'à 30 s pour qu'un merge ou une CI soit pris en compte. Un verdict de CI est nommé par la tête de la PR (`pr:<ticket>:<n>:checks:<fail|pass>:<sha>`) : le relevé et le webhook qui voient le même verdict sur le même commit l'écrivent une seule fois dans l'inbox, et un verdict rouge revu sur le même commit après un vert (CI relancée) n'est pas signalé une seconde fois. Avec la CLI `gh`, la tête est lue dans `headRefOid`.

## Webhooks GitHub

`POST /webhooks/github` reçoit les webhooks de l'App (ORC-134) :

- **signature** : `X-Hub-Signature-256` doit valoir `sha256=` suivi du HMAC-SHA256 du corps brut avec le secret, comparé en temps constant ; sinon refus (401) et **rien n'est écrit**. Le secret vient de `github.webhookSecret` dans `config.yaml`, sinon de la variable `GH_WEBHOOK_SECRET`. Sans secret (ou un secret fait d'espaces), **tous** les webhooks GitHub sont refusés, et `relais up` le signale au démarrage ;
- **inbox écrite avant la réponse** (ORC-147) : un 200 veut dire « écrit » ; si le démon tombe juste après, même avec `kill -9`, l'événement est traité au démarrage suivant. Si l'écriture échoue, la réponse est 500 : GitHub ne renvoie pas seul une livraison en échec, renvoyez-la depuis l'onglet *Advanced* de l'App, ou laissez le relevé la rattraper ;
- **déduplication et rejeu** : l'id de chaque événement vient du corps signé (numéro de PR, SHA, id de la review ou du commentaire), jamais de `X-GitHub-Delivery`, que la signature ne couvre pas (il sert seulement au journal). Une livraison renvoyée, un corps rejoué, ou le même fait vu par le relevé, porte un id que l'inbox a déjà : il n'est pas retraité. GitHub ne signe pas d'horodatage : il n'y a pas de contrôle de fraîcheur, la déduplication en base en tient lieu ;
- **rattachement au ticket** : par la branche de la PR (ou du push), comme le relevé, et par le dépôt : `repository.full_name` doit être le dépôt `origin` du projet du ticket (lu une fois par `git remote get-url origin`). Seule une branche d'un ticket suivi, dans le dépôt de son projet, produit un événement ; tout le reste (autre dépôt où l'App est installée, autre branche, corps d'une autre forme) est accepté (200) et ignoré. Une PR plus ancienne de la branche, déjà fermée, est ignorée aussi.

| Webhook | Événement dans l'inbox | Réaction |
|---|---|---|
| `pull_request` fermée avec `merged: true` | `pr.merged` (précédé de `pr.opened` si le ticket ne connaît pas la PR), avec le commit de merge (`mergeSha`, `merge_commit_sha`), la tête mergée (`headSha`) et l'heure du merge sur GitHub (`mergedAt`, `merged_at`) ; le relevé les donne aussi quand la forge les lit | comme pour le relevé |
| `pull_request` fermée sans merge | `pr.closed`, un par fermeture | travail du ticket annulé |
| `pull_request` rouverte (la PR du ticket) | `pr.opened`, un par réouverture | la PR redevient ouverte ; le ticket reste bloqué jusqu'à une relance humaine |
| `pull_request` ouverte avec `mergeable_state: dirty` | `pr.conflicted` (tête et base) | aucune pour l'instant (ORC-146) |
| `check_run` / `check_suite` terminé en échec (`failure`, `timed_out`, `cancelled`, `action_required`, `stale`, `startup_failure`) sur la tête de la PR | `pr.checks_failed`, avec la liste des checks en échec que la forge lit sur cette tête ; rien si elle lit cette tête en cours ou au vert (run annulé puis relancé) ; si elle ne répond pas, le check du webhook seul | celle du pack, bornée par `limits.ci_fix_attempts` |
| `check_run` / `check_suite` terminé au vert | `pr.checks_passed`, seulement quand la forge lit alors **tous** les checks de cette tête au vert ; si elle ne répond pas, 500 | celle du pack |
| `push` sur la branche du ticket par un compte qui n'est pas un bot | `push.human` (non fiable) | aucune pour l'instant (ORC-159) |
| `pull_request_review` soumise, `pull_request_review_comment` créé, par un humain | `pr.reviewed` (non fiable) | aucune pour l'instant (ORC-190) |
| `push` sur la branche par défaut du dépôt (`repository.default_branch`) dont un commit merge une PR d'un ticket suivi, ou revert une PR mergée d'un ticket | `default_branch.pushed` (non fiable), un par ticket concerné, avec ses seuls commits concernés (SHA, message, auteur, `merges` ou `reverts` : numéro de la PR) et l'heure du push (`repository.pushed_at`) | aucune : lu par les mesures (revert à 14 jours, ORC-278) |
| `workflow_run` terminé (`completed`) sur la branche d'un ticket suivi, dans le dépôt du projet (pas une fork) | `ci.run_completed` (non fiable), un par run et par essai (`ci:<ticket>:<run id>:<run_attempt>`), avec la PR, la tête, la conclusion et la durée | aucune : lu par les mesures (coût de CI, ORC-278) |

Un check sur un commit que la PR a quitté est ignoré. Une lecture de la forge en retard sur le webhook (check encore lu « en cours ») ne laisse rien passer : le relevé rattrape le verdict. Les webhooks sont traités un par un, dans l'ordre d'arrivée : une lecture lente de la forge retarde les réponses suivantes. Les statuts de commit (`status`) ne passent que par le relevé. Un conflit n'apparaît que sur un webhook `pull_request` où GitHub a déjà calculé la fusionnabilité : un conflit créé par un push sur la branche par défaut, sans événement sur la PR, attend la réconciliation (ORC-185). Tant que les agents poussent avec `GH_TOKEN` (ORC-125), leurs pushes viennent d'un compte utilisateur et arrivent donc comme `push.human`, sans effet aujourd'hui. `pr.conflicted`, `pr.reviewed`, `default_branch.pushed` et `ci.run_completed` ne sont pas des clés acceptées sous `on` : le moteur les trace sans réagir.

**Push de la branche par défaut et runs de CI (ORC-278).** Un push sur la branche par défaut n'a pas de branche de ticket : chaque commit est rattaché par ce que GitHub en écrit, jamais par le texte d'un agent lu comme une affirmation :

- un commit **merge** une PR d'un ticket suivi quand GitHub l'a écrit (committer `web-flow`, celui du bouton de merge) avec le sujet de son merge (`Merge pull request #<n> from …`, ou `<titre> (#<n>)` pour un squash ; le dernier `(#<n>)` est celui que GitHub ajoute) et que `<n>` est la PR d'un ticket du projet, ou quand son SHA est le commit de merge ou la tête d'une PR dont le `pr.merged` est au journal (merge par rebase). Le même sujet tapé par quelqu'un d'autre (un cherry-pick, un commit d'agent) ne merge rien ;
- un commit **revert** une PR mergée quand son message contient `This reverts commit <sha complet>` (`git revert`, et le commit du bouton *Revert* de GitHub) et que ce SHA est le commit de merge ou la tête d'un `pr.merged` journalisé du projet (`Store.mergedPrOf`), ou `Reverts <owner>/<dépôt>#<n>` (corps de la PR du bouton *Revert*, gardé par un squash) pour une PR `<n>` d'un ticket du dépôt ;
- aucun revert n'est lu dans le commit qui merge une PR de l'usine (un squash garde les messages des commits de l'agent), ni dans tout un push qui la merge par un commit de merge ou par rebase : il apporte les commits de la PR, écrits par l'agent ; un revert poussé à côté du squash d'une PR de l'usine est lu ;
- un push sans commit concerné ne produit rien. L'id `default-branch:<ticket>:<after>` dédoublonne une livraison renvoyée.

Le push du merge peut arriver avant le `pr.merged` du même merge : il est alors rattaché par son sujet ; un merge par rebase arrivé avant n'est pas vu (la mesure de revert du ticket reste vide tant qu'aucun push ne le concerne), et les messages de ses commits sont lus comme ceux d'un push humain : un commit d'agent qui écrit `This reverts commit <sha d'un autre merge de l'usine>` compterait un revert sur l'autre ticket. Chaque numéro de PR et chaque SHA d'un push est cherché une fois ; la recherche d'un SHA lit `journal` (Postgres) ou `events` (SQLite) sans index dédié. La durée d'un run de CI est celle de son essai, de `run_started_at` (début de cet essai, pas du premier) à `updated_at` du webhook `completed` : le webhook porte les deux, sans appel à l'API. Les minutes facturées (`GET /actions/runs/{id}/timing`) ne sont pas lues : GitHub retire ces points d'accès d'usage, et ils demanderaient un appel par run ; la durée de l'essai est le temps d'horloge du workflow, pas la somme de ses jobs en parallèle ni l'arrondi à la minute de la facture. Un run sans PR listée par GitHub est compté sur la PR du ticket au moment du webhook si elle est ouverte, sinon sans PR. Un run dont le dépôt de tête n'est pas celui du projet (une fork, ou une fork supprimée : `head_repository` nul) est ignoré.

## Branches

Chaque ticket travaille sur `relais/<ticket>-<titre-en-slug>` (ex. `relais/rel-12-export-csv`), créée depuis `origin/<branche par défaut>` (lue dans `refs/remotes/origin/HEAD`, sinon `main`). Une branche locale ou distante du même nom est réutilisée. Le contrôle `not_started` refuse de prendre un ticket qui a déjà une branche `relais/<ticket>-…` sur `origin`.

## Protection de branche (fortement conseillée)

Le pack interdit aux agents `gh pr merge` et tout push ([`pack-et-skills.md`](pack-et-skills.md#permissions)), mais ces refus sont une **première barrière** : ils dépendent de Claude Code et un agent qui exécute du code peut les contourner. C'est GitHub qui garantit que seuls les humains mergent. Sur la branche par défaut de chaque dépôt :

- **Require a pull request before merging** (avec au moins une approbation si votre équipe relit) ;
- **Block force pushes** et interdire la suppression ;
- **Require status checks to pass** avec vos checks de CI ;
- ne pas mettre le compte de Relais dans les exceptions (*bypass*).

Le dépôt de connaissance (`relais-knowledge`) mérite la même protection : un humain y merge.

## `factory doctor` : secrets de CI et branches de l'usine

`factory doctor [repo] [--json]` (dépôt courant par défaut) vérifie, avant de confier un dépôt, qu'aucune CI ne peut exposer de secrets à une branche `factory/*`. Le contrôle vit dans `doctor`, pas seulement dans le skill `fix-ci` : une PR de l'usine ne doit jamais déclencher un job qui lit les secrets du dépôt sans qu'un humain ait approuvé.

La commande résout `owner/name` avec `git remote get-url origin`, puis lit avec la GitHub App :

- `.github/workflows/*.yml` et `*.yaml` (Contents API, branche par défaut) ;
- `GET /repos/{owner}/{repo}/environments` et leurs `protection_rules`.

Elle exige la GitHub App (`github.*` ou `GH_APP_*`) : aucun repli `gh` pour ce contrôle. Code retour `0` si le dépôt est accepté, `1` s'il est refusé ou si une lecture échoue.

### Règle

Un workflow **avec secrets** (`secrets.*`, `${{ secrets.X }}`, `secrets: inherit` ou une clé `secrets:`) est refusé s'il peut tourner sur une branche de l'usine :

- `pull_request` et `pull_request_target` : toujours considérés à risque, car une PR de `factory/*` peut les déclencher ; le filtre `branches` d'une pull request porte sur la branche de base, pas sur la branche de tête ;
- `push` sans filtre : toutes les branches ;
- `push` dont le filtre `branches` peut atteindre `factory/*` (`factory/**`, `*/*`, `**`…) ou dont `branches-ignore` ne l'exclut pas entièrement ;
- `workflow_run` sans filtre, ou avec un filtre qui atteint `factory/*` (protection supplémentaire de la même famille de risque).

À l'inverse, un `push` limité à des branches hors usine (`main`, `release/*`) ou à des tags seulement ne voit pas les secrets sur une branche `factory/*`.

Sont acceptés :

1. une CI dédiée **sans secrets** sur ces branches ;
2. un workflow avec secrets dont **tous les jobs qui voient un secret** sont rattachés à un environnement GitHub dont les `protection_rules` contiennent `required_reviewers` avec au moins un reviewer : l'approbation humaine bloque le job avant qu'il ne lise le secret ;
3. un workflow avec secrets qui ne tourne que sur des branches hors usine, ou seulement sur des tags.

En cas de doute, `doctor` refuse : YAML invalide ou ambigu (multi-document, `on` dynamique, filtres mal typés), environnement introuvable ou sans required reviewers, clé `secrets:` (workflow réutilisable) sans environnement protégé, erreur de l'API GitHub, réponse de l'API illisible (jamais lue comme « aucun workflow », « aucun environnement » ou « aucun reviewer »), plus de 1000 environnements. `GITHUB_TOKEN` compte comme un secret.

### Exemples

Refus :

```text
$ factory doctor
Workflows GitHub Actions : 1

.github/workflows/ci.yml
  déclencheurs : pull_request
  secrets : oui
  environnements : aucun
  environnement protégé : non
  verdict : refusé — secrets exposés sur les branches de l'usine (pull_request peut exécuter la CI sur une branche `factory/*`) sans approbation humaine
  ...
Résultat : refusé — 1 workflow(s) sur 1 peuvent exposer des secrets aux branches de l'usine.
```

Acceptation avec approbation humaine (`ci-protected` a une règle `required_reviewers`) :

```yaml
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    environment: ci-protected
    steps:
      - run: npm test
        env:
          TOKEN: ${{ secrets.NPM_TOKEN }}
```

`factory doctor` affiche alors `secrets : oui`, `environnement protégé : oui` et `verdict : accepté`.

`--json` produit le même verdict dans un objet `{ repoPath, accepted, workflows: [{ path, triggers, secrets, environments, protected, verdict, reasons }] }`, sans aucune valeur de secret.

### Limites

- La lecture porte sur la **branche par défaut** (Contents API sans `ref`) : les workflows de `pull_request` sont bien ceux que GitHub utilise pour une PR de `factory/*` ; un workflow qui n'existerait que sur une branche poussée n'est pas vu.
- L'App ne peut pas lister les secrets du dépôt : `doctor` détecte les **références** aux secrets, pas leur existence.
- Les workflows réutilisables appelés ne sont pas téléchargés : `secrets: inherit` est traité comme un secret, et un workflow réutilisable appelé sans `secrets:` ne reçoit aucun secret.
- Ce contrôle ne remplace pas la protection de branche : il garantit seulement que la CI ne lit pas de secret sur une branche d'usine sans approbation.
- Permission requise : **Actions : lecture** (présente dans [`github-app-manifest.json`](github-app-manifest.json)) ; c'est la permission que GitHub associe à `GET /repos/{owner}/{repo}/environments`. Une App créée avant ORC-135 doit l'ajouter, sinon cette lecture répond 403 et `doctor` refuse le dépôt.

## CI

Relais n'impose pas de CI mais en tire parti : `pr.checks_failed` déclenche `fix-ci` (diagnostic, reproduction locale, correction ou question), et le skill `review` attend une CI verte. Une CI qui lance au moins lint, types et tests est donc recommandée, en plus des commandes `verify` que Relais lance lui-même après chaque run ([`workflow.md`](workflow.md#jobs)).

Le dépôt Relais lui-même a une CI GitHub Actions (`.github/workflows/ci.yml`) : sur chaque PR et chaque push sur `main`, Node 24, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.
