/**
 * What the dashboard and the server share of the guard of ORC-229, with no import of its own so the web can import it: why
 * nothing is counted while no definition of a serious defect is set (ORC-153), the levels and categories of a defect
 * (ORC-378), and the miss rate's shape.
 */
export const NO_DEFINITION =
  'No definition of a serious defect is set (audit.serious_defect in factory.yml, ORC-153): the defects of the audit sheets are kept, not counted.';

/** The level of a defect (ORC-153, ORC-378): serious first, the only level a threshold on defects is to read (ORC-143: no serious defect; none reads them yet). */
export const DEFECT_LEVELS = ['serious', 'important'] as const;
export type DefectLevel = (typeof DEFECT_LEVELS)[number];

/** The four categories of a defect (ORC-153, ORC-379), a closed list. */
export const DEFECT_CATEGORIES = ['security', 'data', 'wrong_behavior', 'bypassed_control'] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

/** Missed over counted: `rate` null, never a zero, with no defect to count. */
export interface MissCount {
  defects: number;
  missed: number;
  rate: number | null;
}

/** The count of a category within a level; `category` null for the defects entered before ORC-378. */
export type CategoryMiss = MissCount & { category: DefectCategory | null };
export type LevelMiss = MissCount & { level: DefectLevel; categories: CategoryMiss[] };

/**
 * The AI reviewers' miss rate (ORC-229): the human defects with no matching AI finding over the defects counted. Nothing is
 * counted while no definition is set. `leftOut`: defects of the period entered under no definition, or another one. `levels`:
 * the same count by level, every level, then by category within it, only the categories with a defect, those with none last
 * (`category: null`, ORC-378).
 */
export type MissRate =
  | { counted: false; why: string }
  | ({
      counted: true;
      definition: string;
      leftOut: number;
      levels: LevelMiss[];
    } & MissCount);
