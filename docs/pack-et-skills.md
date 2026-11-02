# Pack et skills

Le cœur de Relais ne contient aucune consigne métier : il orchestre. Ce que fait l'agent vient d'un **pack**, un plugin Claude Code livré dans `packs/standard/` :

```text
packs/standard/
├── .claude-plugin/plugin.json   # plugin « relais » → skills relais:<nom>
├── workflow.yml                 # comportement par défaut (événements, jobs, limites)
├── settings.json                # permissions des runs
├── hooks/hooks.json             # hooks SessionStart et PreToolUse
├── hooks/session-start.mjs      # règles toujours actives, méthode, index de la base de connaissance
├── hooks/pre-tool-use.mjs       # refus des commandes interdites, journal des refus
├── NOTICE.md                    # origine de la méthode (superpowers, MIT)
└── skills/<nom>/SKILL.md        # skills de job (un par type de run) et skills de méthode
```

Chaque run lance Claude Code avec `--plugin-dir packs/standard` (les skills deviennent `/relais:<nom>`), `--settings <RELAIS_HOME>/run-settings.json` et `--setting-sources project,local`. Conséquence de cette dernière option : les réglages **utilisateur** de Claude Code (`~/.claude/settings.json`) ne s'appliquent pas aux runs ; ceux du dépôt (`.claude/settings.json`, `.claude/settings.local.json`) s'appliquent.

Le comportement (quel skill, quand, avec quel modèle) se règle dans `.relais/workflow.yml` : voir [`workflow.md`](workflow.md).

## Les skills du pack

Deux familles :

- les **skills de job** sont ceux que `workflow.yml` lance (`skill: "relais:<nom>"`) : ils disent quoi faire du début à la fin d'un run et le format du dernier message ;
- les **skills de méthode** disent *comment* faire une étape (tester, déboguer, vérifier, relire, traiter des retours). Les skills de job les chargent au bon moment, et le hook de démarrage rappelle à chaque run de les utiliser.

### Les skills de job

Tous écrivent leur dernier message en français : il est publié tel quel dans la session Linear. Quand l'agent pose une question (`relais-agent ask`), le ticket est bloqué et ce dernier message n'est **pas** publié : la question doit se suffire.

| Skill | Job(s) | Espace | Rôle | Méthode chargée |
|---|---|---|---|---|
| `relais:dev` | `dev` | worktree du ticket | Lit le ticket, le confronte au code, pose une question si une décision manque, fait un mini-plan si le ticket a plusieurs étapes, développe test d'abord, vérifie (tests ciblés, types, lint), fait une auto-review légère, contrôle les conflits avec le tronc (rebase avant le premier push), pousse vers `refs/heads/<branche>` et vérifie le distant, ouvre la PR (`Fixes <ID>` seulement si tout le ticket est réglé, sinon `Part of <ID>`). N'attend pas la CI. Message : ce qui a changé, comment tester, vérifié, points d'attention. | `tdd`, `debugging`, `verification`, `code-review` (rapide ou standard), `receiving-review` |
| `relais:feedback` | `dev-feedback` | worktree, session reprise | Traite les retours (fil Linear, commentaires de review GitHub non résolus, vérifications en échec) : vérifie chacun dans le code, corrige avec un test, refuse avec une raison, un commit par cause ; fusionne la base en cas de conflit (pas de rebase d'une branche poussée). Message : une ligne par retour. | `receiving-review`, `tdd`, `debugging`, `verification` |
| `relais:fix-ci` | `fix-ci` | worktree, session reprise | Lit l'échec exact (`gh pr checks`, `gh run view --log-failed`), le reproduit en local, regarde si la base échoue aussi, classe la cause (régression, instable, infra). Régression : correction minimale + test. Instable ou infra : une relance (`gh run rerun --failed`), puis une question au lieu de « corriger » à l'aveugle. Deux corrections ratées sur un même check : question. Interdit de désactiver, sauter ou affaiblir un test ou une étape de CI. | `debugging`, `tdd`, `verification` |
| `relais:review` | `review` | worktree, session neuve | Boucle de review IA : round 1 sur tout le diff au niveau que mérite son risque, corrections vérifiées, puis rounds ciblés sur les seuls commits de correction et leurs consommateurs, avec un registre des décisions. S'arrête quand un round ne trouve que des constats mineurs, au plafond `review_rounds`, ou sur un point à trancher (question). Puis vérification de types, fusion de la base si elle a bougé, push, CI jusqu'au vert (3 tentatives par check). Message : synthèse (rounds, niveau, CI), corrigé, reste à voir, hors périmètre. | `code-review`, `receiving-review`, `tdd`, `debugging`, `verification` |
| `relais:ask` | `ask` | `_trunk`, lecture seule (mode plan) | Répond à une question à partir de la base de connaissance, de `docs/agent/`, de `CLAUDE.md`, du code et des tickets, en n'affirmant que ce qu'il a lu, avec ses sources. | `verification` |
| `relais:learn` | `learn`, `remember` | worktree du dépôt de connaissance | Écrit 0 à 3 fiches vérifiées (`notes/<slug>.md` + ligne dans `INDEX.md`), complète une fiche existante plutôt que d'en créer une, et ouvre une PR. Pour `remember`, enregistre fidèlement ce qui est demandé. | — |

### Les skills de méthode

| Skill | Quand | Ce qu'il impose |
|---|---|---|
| `relais:tdd` | tout changement de comportement | Un test qui échoue pour la bonne raison avant le code ; code minimal ; tests voisins verts ; des tests qui peuvent vraiment échouer (pas d'assertion sur un mock). |
| `relais:debugging` | bug, test rouge, CI ou vérification en échec | La cause avant la correction : lire l'erreur entière, reproduire, comparer à ce qui marche, une hypothèse à la fois ; après trois corrections ratées, question de conception plutôt qu'une quatrième. |
| `relais:verification` | avant d'affirmer « fait », « vert », « corrigé », et avant commit, push, PR | Une commande lancée et lue pour chaque affirmation. Tests ciblés, types et lint ; pas la suite complète (c'est le rôle de `verify` et de la CI). Push vérifié par `git ls-remote`. |
| `relais:code-review` | relire un diff (`review`, auto-review de `dev`) | Diff délimité à la base de la PR. Trois niveaux choisis sur le risque : **rapide** (texte, config), **standard** (logique, docs qui décrivent le code), **approfondi** (accès, données, migrations, secrets, gros diff ; passes par angle, en sous-agents parallèles si l'outil est disponible). Constats classés par portée (dans le périmètre, hors périmètre, conflit de règle) et gravité (bloquant, important, mineur), chacun vérifié avant d'être rapporté. |
| `relais:receiving-review` | traiter des retours ou des constats | Tout lire, vérifier la prémisse et la correction proposée dans le code, ne pas trancher un compromis seul, un commit par cause avec sa preuve, répondre sans complaisance (corrigé, refusé avec raison, ou question). |

La méthode est réécrite à partir des skills superpowers (MIT) : voir `packs/standard/NOTICE.md`.

Texte complet : `packs/standard/skills/<nom>/SKILL.md`.

## Règles toujours actives (hook SessionStart)

`hooks/session-start.mjs` injecte au début de chaque run :

- le ticket courant (`RELAIS_TICKET`) ;
- les règles : messages Linear en français, ne jamais merger ni force-pusher, ne rien modifier hors du répertoire de travail, ne jamais déclarer fini sans tests lancés et lus, passer par `relais-agent` pour Linear, poser **une** question avec `relais-agent ask` plutôt qu'inventer, dernier message lisible seul ;
- la méthode : avant chaque étape, charger le skill de méthode qui s'applique (`relais:tdd`, `relais:debugging`, `relais:verification`, `relais:code-review`, `relais:receiving-review`), le `CLAUDE.md` du dépôt l'emportant en cas de contradiction ; si l'outil Skill est indisponible, lire le fichier du skill (le hook donne le chemin absolu du dossier `skills/`) ;
- si `RELAIS_KNOWLEDGE` est défini et contient `INDEX.md` : l'index de la base de connaissance (8 000 caractères au plus) et le chemin des fiches.

## Permissions

`packs/standard/settings.json` fixe `defaultMode: acceptEdits` et :

**Autorisé** sans confirmation : lecture, édition et recherche de fichiers ; `git status|diff|log|show|add|commit|push|fetch|rebase|checkout|switch|branch|rev-parse|merge-base|merge-tree|merge|revert|rev-list|ls-remote` ; `gh pr create|view|list|checks|diff|edit` ; `gh run view|list|rerun` ; `npm`, `npx`, `node`, `pnpm`, `yarn` ; `ls`, `cat`, `grep`, `rg`, `find`, `head`, `tail`, `wc`, `sleep` ; `relais-agent`.

**Refusé** :

- `gh pr merge` : seuls les humains mergent ;
- tout force-push : `git push --force`, `-f`, `--force-with-lease`, une option de force en milieu de commande, un refspec `+…` ;
- tout push direct sur `main` ou `master` (`git push origin main`, `HEAD:main`…) ;
- tout contournement des hooks git par `--no-verify` (`git commit --no-verify`, `git push --no-verify`, l'option en milieu de commande, ou toute commande qui la contient) ou par `-n` (`git commit -n`, `-nm`, `-m … -n` ; pas `-an`, que la syntaxe des motifs ne sait pas isoler) ; les règles explicites doublent le joker `*--no-verify*` au cas où la version de Claude Code n'appliquerait pas les jokers en début ou milieu de motif. Le scan du diff (`factory/anti-triche`, ORC-158) refuse aussi un `--no-verify` ajouté dans un fichier du dépôt, hors documentation, fichiers de test et règles de permission des réglages Claude ;
- `git reset --hard origin…`, `rm -rf /` ;
- un téléchargement envoyé à un shell : `curl … | sh`, `wget … | bash` ;
- toute commande qui mentionne la socket Docker ou Podman (`docker.sock`, `podman.sock`) ou les variables qui y mènent (`DOCKER_HOST`, `CONTAINER_HOST`) : elle donnerait la main sur l'hôte depuis le conteneur du run ;
- l'outil `WebSearch` : la recherche tourne chez Anthropic, hors de la vue du proxy de sortie ([ORC-128](decisions/ORC-128.md), point 1). `WebFetch` reste permis : il passe par le proxy ;
- la lecture de `~/.relais/**`.

Au démarrage, Relais complète ces refus pour le **vrai** `RELAIS_HOME` (même hors de `~/.relais`, par exemple `/data` en Docker) et écrit le résultat dans `<RELAIS_HOME>/run-settings.json` : lecture/édition de `secrets.json`, lecture de `relais.db*`, `transcripts/**`, `logs/**`, et toute commande qui mentionne `secrets.json` ou `relais.db`. Voir [`configuration.md`](configuration.md#ce-qui-ne-sort-pas-du-démon).

Ces règles sont une première barrière, pas une garantie : protégez la branche par défaut côté GitHub ([`github.md`](github.md#protection-de-branche-fortement-conseillée)). La recette vérifie que la version de Claude Code installée applique bien les jokers en milieu de motif ([`recette.md`](recette.md)).

Les runs `trunk-readonly` (questions) tournent en plus avec `--permission-mode plan`.

### Hook PreToolUse et journal des refus

Les motifs du `deny` sont des jokers sur le texte de la commande : un espace en trop, des guillemets (`git commit "--no-verify"`), un `sudo`, un `git -C dépôt` ou un `bash -c "…"` les déjouent. Et Claude Code découpe une commande composée avant d'appliquer ses règles : `curl … | sh` n'y est vu que morceau par morceau. `hooks/pre-tool-use.mjs` (hook `PreToolUse` sur `Bash` et `WebSearch`) refait donc les mêmes refus sur la commande analysée : mots et guillemets comme un shell, opérateurs (`|`, `&&`, `;`…), commandes entre guillemets relues, préfixes (`VAR=…`, `sudo`, `env`) et options de `git` ignorés. Il refuse aussi `rm -fr /`, `rm -r -f /*`, `git commit -anm …`, `bash <(curl …)` et `sh -c "$(curl …)"`.

Chaque refus est une règle nommée (`no-verify`, `commit-no-verify`, `force-push`, `push-trunk`, `merge`, `reset-origin`, `rm-root`, `pipe-to-shell`, `container-socket`, `web-search`, et avec le drapeau : `push`, `gh-write`). L'agent reçoit le nom de la règle dans le motif du refus, et le hook écrit une ligne JSON `{"at", "tool", "command", "rule"}` dans le **journal des refus** :

1. `$FACTORY_REFUSALS_LOG` s'il est défini ;
2. sinon `$CLAUDE_CONFIG_DIR/factory-refusals.jsonl` (le répertoire de configuration Claude du ticket) ;
3. sinon `~/.claude/factory-refusals.jsonl`.

Les dossiers sont créés ; un journal impossible à écrire n'empêche ni le refus ni la session.

**Drapeau `FACTORY_DENY_PUSH=1`** (environnement du démon, transmis aux runs) : le hook refuse en plus tout `git push` et les écritures `gh` (`gh pr create`, `gh pr edit`, `gh run rerun` ; `gh pr merge` l'est toujours), journalisés de la même façon. Désactivé par défaut : les skills du pack poussent et ouvrent leurs PR eux-mêmes jusqu'à ORC-125. Voir [`configuration.md`](configuration.md#variables-denvironnement).

`src/pack-guard.test.ts` donne au hook, sur son entrée standard, un vrai appel `PreToolUse` pour chaque `Bash(…)` du `deny` de `settings.json` et vérifie le refus et la ligne de journal : un motif ajouté au `deny` sans règle dans le hook fait échouer le test.

Pourquoi `git merge` est autorisé : une branche déjà poussée ne peut pas être rebasée, puisque le force-push est refusé. Les skills `feedback`, `fix-ci` et `review` intègrent donc la base par une fusion (`git merge --no-edit origin/<base>`) quand elle est en conflit ou qu'elle a bougé ; seul `dev`, avant son premier push, rebase. `git merge-tree` sert au contrôle de conflit sans toucher à l'arbre, `git ls-remote` à vérifier qu'un push a bien atteint le distant.

## Personnaliser

Du plus simple au plus profond :

1. **Régler le comportement** sans toucher au pack : `.relais/workflow.yml` du dépôt (modèles, limites, vérifications, règles, jobs). Voir [`workflow.md`](workflow.md#6-recettes).
2. **Donner du contexte au dépôt** : `CLAUDE.md` et `docs/agent/*.md` sont lus par les skills `dev`, `review` et `ask`. Le `CLAUDE.md` l'emporte sur les skills du pack là où ils parlent du même sujet : c'est l'endroit pour vos conventions de commit, de test, de nommage, ou pour durcir la méthode (« lancer toujours la suite X avant de pousser »). Les réglages Claude Code du dépôt (`.claude/settings.json`) s'appliquent aux runs.
3. **Ajouter un skill** pour un nouveau job : un skill de projet `.claude/skills/<nom>/SKILL.md` versionné dans le dépôt, référencé par `skill: "<nom>"` dans un job de `.relais/workflow.yml`. Exemple complet : [`workflow.md`](workflow.md#ajouter-un-job-personnalisé-avec-son-propre-skill).
4. **Modifier le pack** lui-même : éditer `packs/standard/` (skills, hook, permissions) dans votre copie de Relais. Cela s'applique à tous les projets de l'instance ; redémarrez `relais up` pour régénérer `run-settings.json`. Pour changer la méthode de toute l'équipe (seuils des niveaux de review, commandes de vérification, règles de TDD), éditez le skill de méthode concerné : tous les skills de job qui le chargent suivent. Ajouter un skill de méthode : un dossier `skills/<nom>/SKILL.md`, cité comme `relais:<nom>` depuis un skill de job ou le hook.

Relais charge toujours `packs/standard` : `extends` dans `workflow.yml` n'a pas d'effet et il n'existe pas encore de mécanisme pour choisir un autre pack. Pour un « pack » d'équipe, maintenez une copie de Relais avec votre `packs/standard/`.

### Écrire un skill

- Frontmatter `name` (nom du dossier) et `description` ; `src/pack.test.ts` vérifie que chaque skill du pack a ce frontmatter, que chaque skill référencé par le `workflow.yml` du pack existe, et que chaque `relais:<nom>` cité dans un skill ou dans le hook existe.
- Appuyez-vous sur les skills de méthode plutôt que de répéter leurs règles : « applique `relais:receiving-review` » reste juste quand la méthode évolue.
- Le prompt du run commence par `/<skill>` suivi du bloc « Ticket » (identifiant, titre, URL, branche, PR, description), du « Contexte Linear » quand le webhook en fournit un et, selon `input`, « Retours à traiter », « CI en échec », « Message » ou « Vérifications en échec ».
- Dites explicitement ce qu'il faut faire **à la fin** : commit/push, et le format du dernier message (publié dans Linear).
- Utilisez `relais-agent ask` pour toute décision manquante, puis fin de tour.
- Testez-le à la main dans un dépôt : `claude -p "/<skill> …" --plugin-dir packs/standard --settings ~/.relais/run-settings.json`.
