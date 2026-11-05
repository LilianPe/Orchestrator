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

- les tickets sont routés par clé d'équipe ; une équipe sans projet est ignorée. Une équipe peut avoir plusieurs projets : voir [Une équipe, plusieurs dépôts](#une-équipe-plusieurs-dépôts) ;
- le comportement de chaque projet vient de son `.relais/workflow.yml` ([`workflow.md`](workflow.md)), lu dans la copie de travail `repoPath` au démarrage ;
- `repoPath` doit être un clone avec `origin` : Relais y fait `git fetch origin` et y attache les worktrees. Vous pouvez continuer à y travailler, mais n'y supprimez pas les branches `relais/…` en cours.

### Ajouter un projet

```bash
cd <autre dépôt>
relais init        # même clé d'application Linear : répondez avec les mêmes identifiants
```

`init` ajoute le projet (ou remplace celui qui a le même `repoPath`) et crée son `.relais/workflow.yml`. Redémarrez ensuite `relais up` : les statuts et labels sont créés dans la nouvelle équipe à la prochaine connexion Linear (bouton « Connecter Linear » ou `/oauth/start`).

> Les capacités des files (`parallel_sessions`, `question_sessions`) sont globales et lues dans le workflow du **premier** projet de la liste. Les autres réglages sont propres à chaque projet.

### Une équipe, plusieurs dépôts

Plusieurs projets peuvent déclarer le même `linearTeamKey`. Le ticket désigne alors son dépôt par un label **`repo:<id>`**, où `<id>` est l'`id` du projet dans `config.yaml` (casse indifférente) : `repo:api` envoie le ticket au projet `api`. Créez ces labels dans l'équipe Linear.

- Équipe à un seul projet : rien ne change, le label est inutile et ignoré.
- Le label n'est lu que pour un ticket qu'aucun projet ne tient encore, à sa délégation (ou à une mention, une commande). **Le routage est collant** : un ticket délégué, ou qui a déjà une branche ou une PR, reste sous son projet, quoi que disent ses labels ensuite, et un projet ajouté à l'équipe ne prend aucun ticket existant. Ajouter à un ticket en cours le label d'un autre dépôt de l'équipe n'y change rien : Relais répond en commentaire que le dépôt ne change pas en cours de route. Sans branche ni PR, on en change en arrêtant le travail et en retirant la délégation, puis, une fois le retrait vu par la réconciliation (jusqu'à 5 minutes : aucun webhook ne le signale), en déléguant de nouveau ; sinon, il faut un nouveau ticket. Un label `repo:` qui ne nomme aucun dépôt de l'équipe est ignoré. Une réponse ou un arrêt sur un ticket qu'aucun projet ne tient suit aussi son label, y compris quand sa délégation n'est pas encore traitée : sans label, il reçoit la question ; avec un label, une réponse va à la copie du ticket qui a ouvert sa session.
- Ticket sans label `repo:` qui nomme un des projets : la délégation est bloquée (label « Bloqué ») et la session Linear demande le label, avec la liste des choix. Le ticket attend sous le **premier** projet de l'équipe (ordre de `config.yaml`), même s'il était bloqué pour une autre raison, qu'il remplace. Une annulation ou un passage en terminé met fin à l'attente. Tant qu'il attend, une réponse, une mention, une commande ou un arrêt reçoit la même question, et rien d'autre (statut, label) ne lance de travail : aucun travail ne part dans un dépôt choisi par défaut.
- Pour débloquer : ajoutez le label `repo:<id>`, puis déléguez de nouveau le ticket (retirez l'agent puis remettez-le) : le travail part dans ce dépôt, y compris si c'est celui où le ticket attendait, et le label « Bloqué » est retiré. Sur Postgres, qui garde une seule ligne par ticket, le ticket passe alors d'un projet à l'autre ; sur SQLite, il garde une copie par projet. La nouvelle délégation est nécessaire : la réconciliation range bien le ticket sous son dépôt et retire le ticket en attente du premier projet (son blocage levé), mais une délégation qu'elle trouve n'a pas d'auteur signé, et les droits (ORC-186) ne lancent rien sans auteur.
- Plusieurs labels `repo:` valides : le premier projet de la liste parmi eux gagne. Un ticket qui touche plusieurs dépôts se découpe en un sous-ticket par dépôt.

Postgres garde une seule ligne par ticket, quel que soit son projet. Une écriture ne remplace jamais le ticket qu'un autre projet tient : un événement routé sur une lecture périmée (un passage de la réconciliation qui a lu Linear avant une délégation signée, par exemple) est refusé. Le ticket reste intact, le refus est journalisé en erreur, et l'événement est mis de côté comme lettre morte, sans nouvel essai et sans bloquer le ticket : `factory run repair <ticket>` le montre. L'ignorer le clôt ; le rejouer le refuse de nouveau tant que l'autre projet tient le ticket. Une clé `(projet, ticket)` retirerait ce cas ; ce n'est pas fait.

`relais plan` liste chaque ticket une fois, sous son projet, et marque « dépôt à préciser » ceux qui n'en nomment aucun.

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
2. **Setup** : les commandes `workspace.setup` (ex. `npm ci`) sont lancées une fois, dans l'ordre, via `bash -lc`, dans le conteneur de la tentative quand `FACTORY_CONTAINER_CLI` est défini, sur l'hôte sinon. Si l'une échoue, le worktree est supprimé et le ticket bloqué (« Erreur au lancement : Le setup du worktree a échoué : <commande> ») ; le run suivant recommence de zéro.
3. **Réutilisation** : les runs suivants du ticket (retours, CI, review) reprennent le même worktree, sans setup.
4. **Nettoyage** : au merge de la PR (règle `pr.merged` → `do: cleanup`), `git worktree remove --force`. La branche locale reste dans `repoPath`.

Le worktree `_trunk` est partagé par toutes les questions d'un projet et remis sur `origin/<branche par défaut>` à chaque run.

Ce qui **n'est pas** nettoyé automatiquement (à faire à la main si l'espace disque compte) : les worktrees de tickets dont la PR a été fermée sans merge ou qui ont été abandonnés, les worktrees `_kb/<runId>` des runs `learn`/`remember`, et les branches locales `relais/…` et `learn/…`. Commandes utiles : `git -C <repoPath> worktree list`, `git -C <repoPath> worktree prune`.

### `workspace.setup` et vérifications

- `setup` : préparer un worktree neuf (dépendances, fichiers générés). Lancé à la création seulement.
- `jobs.<job>.verify` : contrôles lancés par **Relais** (pas par l'agent) après chaque run réussi, 15 minutes maximum par commande. En cas d'échec, Relais relance le job avec la sortie d'erreur, puis bloque le ticket après `limits.verify_attempts` passes (4 par défaut, borne du préréglage), ou dès le troisième échec identique sur un worktree inchangé (cause « Boucle »).

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
