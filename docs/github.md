# GitHub

Relais parle à GitHub à travers **git** et une **GitHub App d'usine**. Le démon utilise l'App quand elle est configurée ; sinon il retombe sur la CLI **`gh`** (repli de migration). Les agents continuent d'utiliser `gh` et `GH_TOKEN` tant que ORC-125 n'a pas retiré cette dépendance. Il n'y a pas de webhook GitHub : le démon **relève** les PR toutes les 30 s pour suivre la CI, les reviews et les merges.

## Authentification du démon

### GitHub App (recommandé)

La GitHub App est l'identité du **démon**, pas celle des agents. Elle sert à lire les PR, les checks et les fils de review sans dépendre de `GH_TOKEN` ni de la CLI `gh`.

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
2. Renseignez un nom et une URL. **Désactivez le webhook** : Relais n'en a pas besoin.
3. Dans **Repository permissions**, appliquez le manifeste [`github-app-manifest.json`](github-app-manifest.json) :
   - **Contents** : lecture/écriture ;
   - **Pull requests** : lecture/écriture ;
   - **Checks** : lecture ;
   - **Commit statuses** : lecture ;
   - **Metadata** : lecture (obligatoire pour toute App).
   Aucune permission d'**administration**, ni `Actions` en écriture, ni `Workflows`.
4. Créez l'App, notez son **App ID**, puis **Generate a private key**. Placez le `.pem` hors du dépôt, en mode `0600` (par exemple `~/.relais/github-app.pem`).
5. **Install** l'App sur les dépôts confiés à Relais. L'identifiant d'installation est visible dans l'URL `https://github.com/settings/installations/<id>` ; il est facultatif, le démon sait le retrouver dépôt par dépôt.
6. Renseignez `config.yaml` ou les variables `GH_APP_*`, puis redémarrez `relais up`. Le démarrage journalise le forge choisi, sans secret.

#### Jetons

- Le démon signe un **JWT RS256** avec la clé privée : `iss = appId`, `iat = maintenant - 60 s`, `exp = maintenant + 9 min`.
- Il échange ce JWT contre un **jeton d'installation** : `POST /app/installations/{id}/access_tokens` avec `{ "repositories": ["<dépôt du run>"] }`. Si `installationId` n'est pas configuré, il appelle d'abord `GET /repos/{owner}/{repo}/installation`.
- Le jeton dure **au plus 1 heure**. Il est mis en cache **par dépôt** jusqu'à son expiration, avec une marge de sécurité de 60 s.
- Il reste **en mémoire du démon** : jamais écrit sur disque, jamais journalisé, jamais transmis aux runs Claude Code (`RELAIS_*`, `GH_TOKEN`, etc. inchangés). Un run ne peut donc pas agir sur un autre dépôt avec ce jeton.
- La clé privée n'est jamais journalisée. Le message de démarrage ne contient que l'App ID et, le cas échéant, l'ID d'installation.

#### Rotation de clé

1. GitHub App → **Private keys → Generate a private key**.
2. Déposez le nouveau `.pem` (mode `0600`) et mettez à jour `github.privateKey` ou `GH_APP_KEY`.
3. Redémarrez le démon ; les jetons d'installation en cache sont oubliés et les nouveaux sont émis avec la nouvelle clé.
4. Révoquez l'ancienne clé dans GitHub. Les jetons d'installation déjà émis expirent d'eux-mêmes en moins d'une heure, mais une clé privée compromise peut en émettre de nouveaux : révoquez-la sans attendre.

### CLI `gh` (repli de migration)

Sans section `github`, le démon utilise `GhCliForge` et la CLI `gh`, comme avant :

- **Poste** : `gh auth login` avec le compte qui doit pousser et ouvrir les PR, et git configuré pour pousser vers `origin` (SSH ou HTTPS). Vérifiez `gh auth status` et `git push` depuis le dépôt.
- **Docker** : variable `GH_TOKEN` ; au démarrage, le conteneur lance `gh auth setup-git` pour que git pousse en HTTPS avec ce jeton. Les dépôts montés doivent donc avoir un remote **HTTPS**. Voir [`deploiement.md`](deploiement.md).

Le démarrage journalise explicitement `forge GitHub : CLI gh (repli de migration…)`. Ce repli disparaîtra après ORC-125.

### Agents (temporaire)

Les skills `dev`, `fix-ci` et `review` appellent encore `gh` et `GH_TOKEN` pour créer, lire et modifier les PR. **Ne les retirez pas avant ORC-125** : cette PR ne fait que brancher la GitHub App côté démon. Le jour venu, les agents passeront par l'API locale de Relais, qui portera elle-même le jeton d'installation limité au dépôt du run.

### Permissions nécessaires pour le repli `gh`

Sur chaque dépôt confié à Relais, le compte `gh` doit pouvoir :

| Action | Utilisée par | Commande |
|---|---|---|
| Lire et pousser des branches | agents, worktrees | `git fetch`, `git push`, `git ls-remote` |
| Créer, lire et modifier des PR | agents | `gh pr create`, `gh pr view`, `gh pr edit`, `gh pr diff` |
| Lire les checks et les logs de CI | démon, agents | `gh pr checks`, `gh run view --log-failed` |
| Lire les fils de review | démon | `gh api graphql` (`reviewThreads`) |

Avec un jeton à granularité fine : *Contents* lecture/écriture, *Pull requests* lecture/écriture, *Actions* et *Checks* lecture, *Metadata* lecture. Avec un jeton classique : scope `repo` (et `workflow` seulement si les agents doivent modifier `.github/workflows`, ce que le skill `fix-ci` leur interdit). Pour `relais init` → « Créer un dépôt relais-knowledge », le compte doit aussi pouvoir créer un dépôt.

## Ce que Relais relève

Toutes les 30 s, pour chaque ticket suivi qui a une branche et n'est pas `done` :

- `GET /repos/{owner}/{repo}/pulls?head={owner}:{branche}&state=all` : la PR de la branche (ouverte, mergée, fermée) ;
- si elle est ouverte, `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` et `GET /repos/{owner}/{repo}/commits/{sha}/status` : état agrégé de la CI (`fail` si un check échoue ou est annulé, `pending` si un check tourne, `pass` sinon, `none` sans check).

Au moment d'un run `dev-feedback`, les fils de review **non résolus** sont lus en GraphQL (`reviewThreads`) et transformés en retours pour l'agent.

Événements produits (voir [`workflow.md`](workflow.md#3-les-règles-on)) :

| Constat | Événement | Pack standard |
|---|---|---|
| Nouvelle PR pour la branche | `pr.opened` | URL ajoutée à la session Linear |
| CI qui passe au rouge | `pr.checks_failed` (avec la liste des checks en échec) | `fix-ci` si le ticket est en *Human Review* ou *AI Review* et non bloqué |
| CI qui passe au vert | `pr.checks_passed` | rien |
| PR mergée | `pr.merged` | *Done*, worktree supprimé, `learn` |
| PR fermée sans merge | `pr.closed` | rien |

Un changement d'état de CI n'est signalé qu'une fois (pas à chaque relevé). Les commentaires de review **non résolus** de la PR sont relus au moment d'un run `dev-feedback` (entrée `feedback`) : résolvez un fil sur GitHub pour qu'il ne soit plus renvoyé à l'agent.

Pas de webhook GitHub : il faut jusqu'à 30 s pour qu'un merge ou une CI soit pris en compte.

## Branches

Chaque ticket travaille sur `relais/<ticket>-<titre-en-slug>` (ex. `relais/rel-12-export-csv`), créée depuis `origin/<branche par défaut>` (lue dans `refs/remotes/origin/HEAD`, sinon `main`). Une branche locale ou distante du même nom est réutilisée. Le contrôle `not_started` refuse de prendre un ticket qui a déjà une branche `relais/<ticket>-…` sur `origin`.

## Protection de branche (fortement conseillée)

Le pack interdit aux agents `gh pr merge`, le force-push et le push direct sur `main` / `master` ([`pack-et-skills.md`](pack-et-skills.md#permissions)), mais ces refus sont une **première barrière** : ils dépendent de Claude Code et un agent qui exécute du code peut les contourner. C'est GitHub qui garantit que seuls les humains mergent. Sur la branche par défaut de chaque dépôt :

- **Require a pull request before merging** (avec au moins une approbation si votre équipe relit) ;
- **Block force pushes** et interdire la suppression ;
- **Require status checks to pass** avec vos checks de CI ;
- ne pas mettre le compte de Relais dans les exceptions (*bypass*).

Le dépôt de connaissance (`relais-knowledge`) mérite la même protection : les runs `learn` y ouvrent des PR, un humain les merge.

## CI

Relais n'impose pas de CI mais en tire parti : `pr.checks_failed` déclenche `fix-ci` (diagnostic, reproduction locale, correction ou question), et le skill `review` attend une CI verte. Une CI qui lance au moins lint, types et tests est donc recommandée, en plus des commandes `verify` que Relais lance lui-même après chaque run ([`workflow.md`](workflow.md#jobs)).

Le dépôt Relais lui-même a une CI GitHub Actions (`.github/workflows/ci.yml`) : sur chaque PR et chaque push sur `main`, Node 24, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.
