# GitHub

Relais ne parle à GitHub qu'à travers la CLI **`gh`** et **git** : pas d'application GitHub, pas de webhook GitHub. Les agents poussent leurs branches et ouvrent les PR ; le démon **relève** les PR toutes les 30 s pour suivre la CI, les reviews et les merges.

## Compte et authentification

Le démon et les agents utilisent le même compte : celui de `gh` sur la machine.

- **Poste** : `gh auth login` avec le compte qui doit pousser et ouvrir les PR, et git configuré pour pousser vers `origin` (SSH ou HTTPS). Vérifiez `gh auth status` et `git push` depuis le dépôt.
- **Docker** : variable `GH_TOKEN` ; au démarrage, le conteneur lance `gh auth setup-git` pour que git pousse en HTTPS avec ce jeton. Les dépôts montés doivent donc avoir un remote **HTTPS**. Voir [`deploiement.md`](deploiement.md).

Les commits portent l'identité git de la machine (`user.name` / `user.email`) ou les variables `GIT_AUTHOR_*` / `GIT_COMMITTER_*`.

Un compte dédié (« bot ») est conseillé : ses PR sont clairement identifiées et vous pouvez limiter ses droits.

### Permissions nécessaires

Sur chaque dépôt confié à Relais, le compte doit pouvoir :

| Action | Utilisée par | Commande |
|---|---|---|
| Lire et pousser des branches | agents, worktrees | `git fetch`, `git push`, `git ls-remote` |
| Créer, lire et modifier des PR | agents | `gh pr create`, `gh pr view`, `gh pr edit`, `gh pr diff` |
| Lire les checks et les logs de CI | démon, agents | `gh pr checks`, `gh run view --log-failed` |
| Lire les fils de review | démon | `gh api graphql` (`reviewThreads`) |

Avec un jeton à granularité fine : *Contents* lecture/écriture, *Pull requests* lecture/écriture, *Actions* et *Checks* lecture, *Metadata* lecture. Avec un jeton classique : scope `repo` (et `workflow` seulement si les agents doivent modifier `.github/workflows`, ce que le skill `fix-ci` leur interdit). Pour `relais init` → « Créer un dépôt relais-knowledge », le compte doit aussi pouvoir créer un dépôt.

> Ces listes de droits sont déduites des commandes utilisées par Relais et le pack ; elles n'ont pas été validées une par une sur un jeton à granularité fine.

## Ce que Relais relève

Toutes les 30 s, pour chaque ticket suivi qui a une branche et n'est pas `done` :

- `gh pr list --head <branche> --state all` : la PR de la branche (ouverte, mergée, fermée) ;
- si elle est ouverte, `gh pr checks` : état agrégé de la CI (`fail` si un check échoue ou est annulé, `pending` si un check tourne, `pass` sinon).

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
