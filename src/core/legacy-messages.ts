import { PRODUCT_NAME } from '../product.js';
import type { BlockKind } from './block-cause.js';

/**
 * The French forms of the messages the factory decided on, as it wrote them before ORC-331. A live database (a block
 * reason), a saved merge refusal (`effect:<id>:refused`) or a recorded journal may still hold them. Since ORC-345 the
 * engine decides on typed fields only: these are read once, by the upcasters (`upcast.ts`), to give an old ticket or an
 * old refusal its typed fields back. Nothing writes them any more.
 */
export const BEFORE_ORC_331 = {
  /** A merge refused because the branch moved since the review: the new commits go through the AI review. */
  pushed: 'la branche a reçu un push depuis la review',
  /** The heads of the block reasons, by kind; a dead letter names its event (`event`). */
  kinds: [
    ['asked', /^Question posée par l'agent/],
    ['question', /^En attente d'une réponse à la question de l'agent/],
    ['contested', /^L'agent conteste le ticket/],
    ['red', /^Rouge non vérifié après /],
    ['infra', /^Le run .+ s'est interrompu : panne d'infrastructure/],
    ['infra', /^Le contrôle du rouge de .+ n'a pas pu tourner : panne d'infrastructure/],
    ['infra', /^La vérification de .+ n'a pas pu tourner : panne d'infrastructure/],
    ['infra', /^Erreur au lancement : /],
    ['infra', /^Erreur : /],
    ['infra', new RegExp(`^${PRODUCT_NAME} a redémarré pendant `)],
    ['infra', /^Le bail du run .+ a expiré \d+ fois : /],
    ['limit', /^Le run .+ a atteint un plafond/],
    ['limit', /^Le run .+ n'a rien écrit depuis /],
    ['limit', /^Trop de relances après coupure : /],
    ['limit', /^Vérifications toujours en échec après /],
    ['ci_bound', /^CI toujours en échec après /],
    ['failed', /^Vérifications en échec après /],
    ['loop', /^Boucle : /],
    ['failed', /^Le run .+ a échoué\.$/],
    ['pickup', /^La description (fait moins de|ne contient pas de)/],
    ['pickup', /^Une branche .+ existe déjà sur origin\./],
    ['pickup', /^Aucun dépôt connu pour l'équipe Linear /],
    ['pickup', /^Dépôt à préciser : /],
    ['repo_config', /^Configuration du dépôt à corriger : /],
    ['dead_letter', /^Événement (?<event>.+) mis de côté \(/],
    ['pr_closed', /^PR #\d+ fermée sans merge$/],
    ['stopped', /^Arrêté à la demande$/],
  ] as readonly (readonly [Exclude<BlockKind, 'other'>, RegExp])[],
};
