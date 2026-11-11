/**
 * What the dashboard and the server share of the guard of ORC-229, with no import of its own so the web can import it: why
 * nothing is counted while no definition of a serious defect is set (ORC-153), and the miss rate's shape.
 */
export const NO_DEFINITION =
  'No definition of a serious defect is set (audit.serious_defect in factory.yml, ORC-153): the defects of the audit sheets are kept, not counted.';

/**
 * The AI reviewers' miss rate (ORC-229): the human defects with no matching AI finding over the defects counted. Nothing is
 * counted while no definition is set. `leftOut`: defects of the period entered under no definition, or another one.
 */
export type MissRate =
  | { counted: false; why: string }
  | { counted: true; definition: string; defects: number; missed: number; rate: number | null; leftOut: number };
