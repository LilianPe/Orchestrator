# Projets, worktrees et base de connaissance

## Projets

Un **projet** Relais associe un dépôt git local à une équipe Linear. Ils sont listés dans `projects` de `<RELAIS_HOME>/config.yaml` :

```yaml
projects:
  - id: mon-app                       # identifiant interne (dossiers, API)
    repoPath: /home/moi/code/mon-app  # clone local, avec un remote origin
    linearTeamKey: APP                # clé de l'équipe Linear suivie
```

Règles :

- une équipe Linear = un dépôt (les webhooks sont routés par clé d'équipe ; une équipe sans projet est ignorée) ;
- le comportement de chaque projet vient de son `.relais/workflow.yml` ([`workflow.md`](workflow.md)), lu dans la copie de travail `repoPath` au démarrage ;
- `repoPath` doit être un clone avec `origin` : Relais y fait `git fetch origin` et y attache les worktrees. Vous pouvez continuer à y travailler, mais n'y supprimez pas les branches `relais/…` en cours.

### Ajouter un projet

```bash
cd <autre dépôt>
relais init        # même clé d'application Linear : répondez avec les mêmes identifiants
```

`init` ajoute le projet (ou remplace celui qui a le même `repoPath`) et crée son `.relais/workflow.yml`. Redémarrez ensuite `relais up` : les statuts et labels sont créés dans la nouvelle équipe à la prochaine connexion Linear (bouton « Connecter Linear » ou `/oauth/start`).

> Les capacités des files (`parallel_sessions`, `question_sessions`) sont globales et lues dans le workflow du **premier** projet de la liste. Les autres réglages sont propres à chaque projet.

### Retirer un projet

Supprimez son entrée de `config.yaml` et redémarrez. Les worktrees restants sous `workspaces/<id>/` se suppriment avec `git -C <repoPath> worktree remove <chemin>`.

## Worktrees par ticket

Chaque job déclare un type d'espace de travail (`workspace` dans [`workflow.md`](workflow.md#jobs)) :

| Type | Emplacement | Utilisé par (pack) |
|---|---|---|
| `worktree` | `<RELAIS_HOME>/workspaces/<projet>/<ticket>/`, branche `relais/<ticket>-<titre>` | `dev`, `dev-feedback`, `fix-ci`, `review` |
| `trunk-readonly` | `<RELAIS_HOME>/workspaces/<projet>/_trunk/`, détaché sur `origin/<branche par défaut>` | `ask` (mode plan, lecture seule) |
| `knowledge` | `<RELAIS_HOME>/workspaces/_kb/<runId>/`, branche `learn/<ticket>-<run>` | `learn`, `remember` |

Cycle de vie d'un worktree de ticket :

1. **Création** au premier run : `git fetch origin`, puis `git worktree add` sur la branche du ticket (réutilise une branche locale ou distante du même nom, sinon la crée depuis `origin/<branche par défaut>`).
2. **Setup** : les commandes `workspace.setup` (ex. `npm ci`) sont lancées une fois, dans l'ordre, via `bash -lc`. Si l'une échoue, le worktree est supprimé et le ticket bloqué (« Erreur au lancement : Le setup du worktree a échoué : <commande> ») ; le run suivant recommence de zéro.
3. **Réutilisation** : les runs suivants du ticket (retours, CI, review) reprennent le même worktree, sans setup.
4. **Nettoyage** : au merge de la PR (règle `pr.merged` → `do: cleanup`), `git worktree remove --force`. La branche locale reste dans `repoPath`.

Le worktree `_trunk` est partagé par toutes les questions d'un projet et remis sur `origin/<branche par défaut>` à chaque run.

Ce qui **n'est pas** nettoyé automatiquement (à faire à la main si l'espace disque compte) : les worktrees de tickets dont la PR a été fermée sans merge ou qui ont été abandonnés, les worktrees `_kb/<runId>` des runs `learn`/`remember`, et les branches locales `relais/…` et `learn/…`. Commandes utiles : `git -C <repoPath> worktree list`, `git -C <repoPath> worktree prune`.

### `workspace.setup` et vérifications

- `setup` : préparer un worktree neuf (dépendances, fichiers générés). Lancé à la création seulement.
- `jobs.<job>.verify` : contrôles lancés par **Relais** (pas par l'agent) après chaque run réussi, 15 minutes maximum par commande. En cas d'échec, Relais relance le job avec la sortie d'erreur, puis bloque le ticket après `limits.verify_attempts` passes.

Détails et exemples : [`workflow.md`](workflow.md#workspace).

### Ports

Chaque run de la file `dev` reçoit une variable `PORT` unique parmi les runs simultanés : `workspace.ports.base` (4200 par défaut) + numéro de place (0 à `parallel_sessions - 1`). Si vos tests ou votre serveur de dev lisent `PORT`, plusieurs tickets peuvent tourner en parallèle sans conflit. Les runs de la file `questions` n'en reçoivent pas.

## Base de connaissance partagée

Un dépôt git séparé, commun à tous les projets de l'instance, où les agents consignent ce qui mérite d'être retenu (conventions, pièges, décisions) :

```text
relais-knowledge/
├── INDEX.md        # une ligne par fiche
└── notes/*.md      # une fiche par sujet
```

Comment il sert :

- **lecture** : à chaque run, le hook de démarrage du pack injecte `INDEX.md` (8 000 premiers caractères) dans le contexte de l'agent ; l'agent cherche dans les fiches avec `relais-agent kb search "<mots>"` ;
- **mise à jour** : avant chaque run, Relais fait `git fetch origin` puis `git merge --ff-only` sur le clone ; le clone doit donc rester sur sa branche par défaut, sans commit local ;
- **écriture** : après un merge (`learn`) ou sur `@relais retiens …` (`remember`), un agent écrit 0 à 3 fiches dans un worktree `learn/…` et ouvre une **PR** dans le dépôt de connaissance. Un humain la relit et la merge.

### Mise en place

`relais init` propose « Créer un dépôt GitHub privé relais-knowledge » (`gh repo create relais-knowledge --private --add-readme --clone`), puis enregistre `knowledge.repoPath` dans `config.yaml`.

> **À vérifier après `init`.** `init` enregistre `knowledge.repoPath: <RELAIS_HOME>/knowledge`, alors que `gh repo create --clone` lancé depuis `<RELAIS_HOME>` clone dans `<RELAIS_HOME>/relais-knowledge`. Contrôlez que `knowledge.repoPath` désigne bien un clone git contenant `INDEX.md` et `notes/` (`git -C <chemin> status`) ; sinon corrigez le chemin, ou faites la mise en place manuelle ci-dessous.

Mise en place manuelle (ou dépôt existant) :

```bash
gh repo create relais-knowledge --private --add-readme --clone
cd relais-knowledge
mkdir -p notes && touch notes/.gitkeep && printf '# Base de connaissance Relais\n\n' > INDEX.md
git add . && git commit -m "init knowledge base" && git push
```

puis dans `config.yaml` :

```yaml
knowledge:
  repoPath: /chemin/absolu/vers/relais-knowledge
```

Sans `knowledge`, tout fonctionne sauf la mémoire : les jobs `learn` et `remember` sont ignorés (journal « skipped … no knowledge repo configured ») et `kb search` ne renvoie rien.

Il existe aussi une connaissance **par dépôt**, sans configuration : les skills lisent `CLAUDE.md` et `docs/agent/` du dépôt s'ils existent.
