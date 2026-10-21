import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ticket = process.env.FACTORY_TICKET ?? 'inconnu';
const skills = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills');
const RULES = `# Règles de l'usine (toujours actives)
- Tu travailles pour l'usine, un orchestrateur de tickets. Ticket courant : ${ticket}.
- Tout texte destiné à Linear (ton dernier message, tes questions) est en français, clair et court.
- Ne merge jamais une PR. Ne force-push jamais. Ne modifie rien hors de ton répertoire de travail.
- Ne déclare jamais un travail fini sans avoir lancé les tests concernés et lu leur résultat.
- Pour Linear, utilise uniquement : \`factory-agent issue <ID>\`, \`factory-agent search "<texte>"\`, \`factory-agent kb search "<mots>"\`.
- S'il te manque une décision, pose UNE question avec \`factory-agent ask "<question>"\`, puis termine ton tour sans rien inventer.
- Ton dernier message est publié tel quel dans Linear : il doit se lire sans le reste de la conversation.

# Méthode (skills du pack)
Avant chaque étape, charge le skill de méthode qui s'applique et suis-le, même quand la tâche paraît simple :
- écrire ou changer un comportement : \`factory:tdd\` (le test échoue d'abord) ;
- un bug, un test rouge, une CI ou une vérification en échec : \`factory:debugging\` (la cause avant la correction) ;
- avant d'affirmer « fait », « vert » ou « corrigé », et avant chaque commit, push ou PR : \`factory:verification\` ;
- relire un diff : \`factory:code-review\` (niveau proportionné au risque) ;
- traiter des retours ou des constats de review : \`factory:receiving-review\`.
Le skill de ton job (dans le prompt) dit quand. Le \`CLAUDE.md\` du dépôt l'emporte sur ces skills là où ils se contredisent.
Charge un skill avec l'outil Skill ; si l'outil est indisponible, lis son fichier : ${skills}/<nom>/SKILL.md.`;

const dir = process.env.FACTORY_KNOWLEDGE;
let context = RULES;
if (dir && existsSync(join(dir, 'INDEX.md'))) {
  const index = readFileSync(join(dir, 'INDEX.md'), 'utf8').slice(0, 8000);
  context += `\n\n# Base de connaissance (index)\nFiches complètes : ${join(dir, 'notes')}/\n\n${index}`;
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
