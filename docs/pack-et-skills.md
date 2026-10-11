# Pack et skills

Le cœur de Relais ne contient aucune consigne métier : il orchestre. Ce que fait l'agent vient d'un **pack**, un plugin Claude Code livré dans `packs/standard/` :

```text
packs/standard/
├── .claude-plugin/plugin.json   # plugin « relais » → skills relais:<nom>
├── workflow.yml                 # comportement par défaut (événements, jobs, limites)
├── settings.json                # permissions des runs
├── hooks/hooks.json             # hook SessionStart
├── hooks/session-start.mjs      # règles toujours actives + index de la base de connaissance
└── skills/<nom>/SKILL.md        # une consigne par type de run
```

Chaque run lance Claude Code avec `--plugin-dir packs/standard` (les skills deviennent `/relais:<nom>`), `--settings <RELAIS_HOME>/run-settings.json` et `--setting-sources project,local`. Conséquence de cette dernière option : les réglages **utilisateur** de Claude Code (`~/.claude/settings.json`) ne s'appliquent pas aux runs ; ceux du dépôt (`.claude/settings.json`, `.claude/settings.local.json`) s'appliquent.

Le comportement (quel skill, quand, avec quel modèle) se règle dans `.relais/workflow.yml` : voir [`workflow.md`](workflow.md).

## Les skills du pack

Tous écrivent leur dernier message en français : il est publié tel quel dans la session Linear.

| Skill | Job(s) | Espace | Rôle |
|---|---|---|---|
| `relais:dev` | `dev` | worktree du ticket | Lit le ticket, pose une question si une décision manque, écrit un test qui échoue puis le code, lance tests / lint / types, commite (`<ID>: …`), pousse, ouvre la PR (`Fixes <ID>`). Message : ce qui a changé, comment tester, points d'attention. |
| `relais:feedback` | `dev-feedback` | worktree, session reprise | Traite les retours (fil Linear, commentaires de review non résolus, vérifications en échec), un commit par lot, répond point par point. |
| `relais:fix-ci` | `fix-ci` | worktree, session reprise | Lit l'échec exact (`gh pr checks`, `gh run view --log-failed`), le reproduit en local, classe la cause (régression, instable, infra). Régression : correction minimale + test. Instable ou infra : pose une question au lieu de « corriger » à l'aveugle. Interdit de désactiver, sauter ou affaiblir un test ou une étape de CI. |
| `relais:review` | `review` | worktree, session neuve | Boucle de review IA : liste les défauts par gravité, corrige bloquants et importants, attend la CI, jusqu'à zéro défaut ou `review_rounds` rounds. Message : synthèse, corrigé, reste à voir. |
| `relais:ask` | `ask` | `_trunk`, lecture seule (mode plan) | Répond à une question à partir de la base de connaissance, de `docs/agent/`, de `CLAUDE.md`, du code et des tickets, avec ses sources. |
| `relais:learn` | `learn`, `remember` | worktree du dépôt de connaissance | Écrit 0 à 3 fiches (`notes/<slug>.md` + ligne dans `INDEX.md`) et ouvre une PR. Pour `remember`, enregistre ce qui est demandé. |

Texte complet : `packs/standard/skills/<nom>/SKILL.md`.

## Règles toujours actives (hook SessionStart)

`hooks/session-start.mjs` injecte au début de chaque run :

- le ticket courant (`RELAIS_TICKET`) ;
- les règles : messages Linear en français, ne jamais merger ni force-pusher, ne rien modifier hors du répertoire de travail, ne jamais déclarer fini sans tests lancés et lus, passer par `relais-agent` pour Linear, poser **une** question avec `relais-agent ask` plutôt qu'inventer, dernier message lisible seul ;
- si `RELAIS_KNOWLEDGE` est défini et contient `INDEX.md` : l'index de la base de connaissance (8 000 caractères au plus) et le chemin des fiches.

## Permissions

`packs/standard/settings.json` fixe `defaultMode: acceptEdits` et :

**Autorisé** sans confirmation : lecture, édition et recherche de fichiers ; `git status|diff|log|show|add|commit|push|fetch|rebase|checkout|switch|branch|rev-parse|merge-base` ; `gh pr create|view|list|checks|diff|edit` ; `npm`, `npx`, `node`, `pnpm`, `yarn` ; `ls`, `cat`, `grep`, `rg`, `find`, `head`, `tail`, `wc`, `sleep` ; `relais-agent`.

**Refusé** :

- `gh pr merge` : seuls les humains mergent ;
- tout force-push : `git push --force`, `-f`, `--force-with-lease`, une option de force en milieu de commande, un refspec `+…` ;
- tout push direct sur `main` ou `master` (`git push origin main`, `HEAD:main`…) ;
- `git reset --hard origin…`, `rm -rf /` ;
- la lecture de `~/.relais/**`.

Au démarrage, Relais complète ces refus pour le **vrai** `RELAIS_HOME` (même hors de `~/.relais`, par exemple `/data` en Docker) et écrit le résultat dans `<RELAIS_HOME>/run-settings.json` : lecture/édition de `secrets.json`, lecture de `relais.db*`, `transcripts/**`, `logs/**`, et toute commande qui mentionne `secrets.json` ou `relais.db`. Voir [`configuration.md`](configuration.md#ce-qui-ne-sort-pas-du-démon).

Ces règles sont une première barrière, pas une garantie : protégez la branche par défaut côté GitHub ([`github.md`](github.md#protection-de-branche-fortement-conseillée)). La recette vérifie que la version de Claude Code installée applique bien les jokers en milieu de motif ([`recette.md`](recette.md)).

Les runs `trunk-readonly` (questions) tournent en plus avec `--permission-mode plan`.

## Personnaliser

Du plus simple au plus profond :

1. **Régler le comportement** sans toucher au pack : `.relais/workflow.yml` du dépôt (modèles, limites, vérifications, règles, jobs). Voir [`workflow.md`](workflow.md#6-recettes).
2. **Donner du contexte au dépôt** : `CLAUDE.md` et `docs/agent/*.md` sont lus par les skills `dev` et `ask`. Les réglages Claude Code du dépôt (`.claude/settings.json`) s'appliquent aux runs.
3. **Ajouter un skill** pour un nouveau job : un skill de projet `.claude/skills/<nom>/SKILL.md` versionné dans le dépôt, référencé par `skill: "<nom>"` dans un job de `.relais/workflow.yml`. Exemple complet : [`workflow.md`](workflow.md#ajouter-un-job-personnalisé-avec-son-propre-skill).
4. **Modifier le pack** lui-même : éditer `packs/standard/` (skills, hook, permissions) dans votre copie de Relais. Cela s'applique à tous les projets de l'instance ; redémarrez `relais up` pour régénérer `run-settings.json`.

Relais charge toujours `packs/standard` : `extends` dans `workflow.yml` n'a pas d'effet et il n'existe pas encore de mécanisme pour choisir un autre pack. Pour un « pack » d'équipe, maintenez une copie de Relais avec votre `packs/standard/`.

### Écrire un skill

- Frontmatter `name` (nom du dossier) et `description` ; `src/pack.test.ts` vérifie que chaque skill référencé par le `workflow.yml` du pack existe avec ce frontmatter.
- Le prompt du run commence par `/<skill>` suivi du bloc « Ticket » (identifiant, titre, URL, branche, PR, description), du « Contexte Linear » quand le webhook en fournit un et, selon `input`, « Retours à traiter », « CI en échec », « Message » ou « Vérifications en échec ».
- Dites explicitement ce qu'il faut faire **à la fin** : commit/push, et le format du dernier message (publié dans Linear).
- Utilisez `relais-agent ask` pour toute décision manquante, puis fin de tour.
- Testez-le à la main dans un dépôt : `claude -p "/<skill> …" --plugin-dir packs/standard --settings ~/.relais/run-settings.json`.
