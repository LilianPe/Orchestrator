import { PRODUCT_NAME } from '../product.js';
import type { BlockCause } from './block-cause.js';

/**
 * The French forms of the messages the factory decides on, as it wrote them before ORC-331. A live database (a block
 * reason), a saved merge refusal (`effect:<id>:refused`) or a recorded journal may still hold them: each check that
 * reads a message reads its English form and the one here, so a ticket started before the upgrade decides as before.
 * Nothing writes them any more.
 */
export const BEFORE_ORC_331 = {
  /** The reason of a stop (`settledTicket`). */
  stopped: 'Arrêté à la demande',
  /** The head of the reason of the red-CI bound, which a green CI lifts. */
  redCiBlocked: 'CI toujours en échec après ',
  /** The head of the reason of a dead-lettered event, which its repair lifts. */
  deadLetter: (eventId: string) => `Événement ${eventId} mis de côté`,
  /** A merge refused because the branch moved since the review: the new commits go through the AI review. */
  pushed: 'la branche a reçu un push depuis la review',
  /** The heads of the block reasons, by cause (`blockCause`). */
  causes: [
    ['question', /^(Question posée par l'agent|En attente d'une réponse à la question de l'agent)/],
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
    ['limit', /^(Vérifications|CI) toujours en échec après /],
    ['failed', /^Vérifications en échec après /],
    ['loop', /^Boucle : /],
    ['failed', /^Le run .+ a échoué\.$/],
    ['pickup', /^La description (fait moins de|ne contient pas de)/],
    ['pickup', /^Une branche .+ existe déjà sur origin\./],
    ['pickup', /^Aucun dépôt connu pour l'équipe Linear /],
    ['pickup', /^Dépôt à préciser : /],
    ['repo_config', /^Configuration du dépôt à corriger : /],
    ['dead_letter', /^Événement .+ mis de côté /],
    ['pr_closed', /^PR #\d+ fermée sans merge$/],
    ['stopped', /^Arrêté à la demande$/],
  ] as readonly (readonly [Exclude<BlockCause, 'other'>, RegExp])[],
};
