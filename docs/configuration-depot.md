# Configuration du dépôt : `.factory/config.yml`

Un dépôt peut déclarer à l'usine ses commandes, ses chemins sensibles et ses limites dans `.factory/config.yml`, à la racine. Le fichier est facultatif : sans lui, le socle de `factory/default` s'applique tel quel.

**Statut (ORC-209, partie A).** Le schéma et `factory validate` existent ; le démon ne lit pas encore ce fichier. La lecture sur la branche par défaut et l'interdiction de `.factory/**` à l'agent viennent avec la partie C d'ORC-209 ; `factory.yml` côté serveur avec la partie B.

## Exemple

```yaml
extends: factory/default@1.0
setup: pnpm install --frozen-lockfile && pnpm db:migrate
commands: { lint: pnpm lint, typecheck: pnpm typecheck, test: pnpm test }
services: [postgres]
sensitive_paths: ["src/auth/**", "src/billing/**", "db/migrations/**"]
budgets: { per_ticket_tokens: 2000000 }      # à calibrer (ORC-216)
max_diff: { files: 15, lines: 400 }          # hors tests ; seulement resserrer
feature_flags: { provider: openfeature }    # facultatif
visual_paths: ["src/components/**", "app/**"]
network: { level: limited, allow: ["docs.exemple.com"] }   # none | limited (défaut) | custom
```

## Clés

| Clé | Type | Défaut | Rôle |
| -- | -- | -- | -- |
| `extends` | texte | `factory/default@1.0` | Le préréglage ; seul `factory/default@1.0` existe au MVP. |
| `setup` | commande | aucune | Préparation du dépôt (installation, migrations). |
| `commands` | `nom: commande` | `{}` | Les contrôles du dépôt (`lint`, `typecheck`, `test`…). |
| `services` | liste | `[]` | Services à démarrer à côté du runner (`postgres`…). |
| `sensitive_paths` | liste de motifs | `[]` | Chemins dont la modification marque le run (relecture renforcée). |
| `budgets.per_ticket_tokens` | entier > 0 | aucun | Plafond de tokens du ticket (ORC-216). |
| `max_diff` | `{ files, lines }` | `{ 15, 400 }` | Taille maximale du diff hors tests ; on ne peut que resserrer. |
| `feature_flags.provider` | texte | aucun | Fournisseur de feature flags. |
| `visual_paths` | liste de motifs | `[]` | Chemins qui demandent une preuve visuelle (ORC-176). |
| `network` | `{ level, allow }` | `limited`, `[]` | Niveau réseau de l'agent : `none`, `limited` ou `custom`. |

## Ce qu'une configuration ne peut pas faire

Une configuration **ajoute** des contrôles ou des interdits, elle n'en **retire** jamais au socle. `factory validate` refuse, avec le chemin de la clé fautive :

- une clé inconnue, comme `checks: { disable: [...] }` : rien ne peut éteindre un contrôle du socle, et une clé ignorée en silence laisserait croire le contraire ;
- un motif négatif (`!…`) dans `sensitive_paths` ou `visual_paths` : il retirerait un chemin ;
- un `max_diff` plus large que le socle (15 fichiers, 400 lignes) ;
- `network.level: full`, réservé à `setup`, jamais pour l'agent ; et dans `network.allow`, tout ce qui n'est pas un nom d'hôte (`*`, `*.com`, `0.0.0.0/0`) : un joker ou une plage reviendrait à `full` ;
- un autre préréglage que `factory/default@1.0`.

Les chemins interdits du socle (`.factory/**`) restent toujours interdits à l'agent, quoi que le fichier déclare.

`custom` est `limited` avec les hôtes du dépôt : c'est le plafond `limited` contre lequel les étapes du préréglage sont vérifiées ; `none` est le plafond `none`.

## Vérifier

```bash
factory validate            # le dépôt courant
factory validate ../mon-depot
```

Code de sortie 0 si le fichier est valide (ou absent), 1 sinon, avec une ligne par violation et le chemin de l'élément fautif (`sensitive_paths[1]`, `commands.test`). Un `.factory/config.yaml` est refusé : l'usine ne lit que `config.yml`.
