/**
 * What an exercise's weight figure MEANS — pure, DB-free, offline.
 *
 * Owner, on the device, 2026-09-23: *"indicate whether weight is per arm,
 * total, etc. for different exercises"*. A stored `weight_kg` of 30 is one
 * dumbbell on a dumbbell press, the bar and every plate on a barbell press, the
 * pin on a lat pulldown and the belt on a weighted pull-up. This module is the
 * one place that says which, so the logger's column heading, the detail
 * screen, the Train hub and the Coach's payloads cannot disagree.
 *
 * ## Six answers, one question
 *
 *   total            the whole load — a barbell counts the bar
 *   per_hand         one dumbbell, bell or handle; the other side carries the same
 *   per_side         one side of a two-sided load: the plates on one side of a
 *                    plate-loaded machine, or one of two cable stacks
 *   stack            the number on a selectorised machine or cable stack
 *   bodyweight_plus  load ADDED to bodyweight (a belt, a vest); blank is bodyweight
 *   assisted         the help a machine gives, taken off bodyweight — lower is harder
 *
 * ## Derived, and corrected by the owner only where the derivation is wrong
 *
 * {@link deriveLoadBasis} reads the catalog row — logging type first, then
 * equipment, then the name and aliases — and is the default for every movement,
 * seeded or custom. Migration 0062 adds `exercises.load_basis`, which holds
 * ONLY the owner's correction (NULL = ARC's reading). {@link effectiveLoadBasis}
 * is the one resolution of the two.
 *
 * **`per_side` is never derived from `machine`.** The catalog's `machine`
 * covers a selectorised stack and a plate-loaded sled alike, so a leg press
 * reads `stack` until the owner says his is plate-loaded. The derivation only
 * reaches `per_side` from words that settle it ("iso-lateral", "plate-loaded")
 * or from a two-stack cable movement ("fly", "crossover").
 *
 * ## Is a per-hand figure doubled? (the decision, pinned in db/training-engine.test.mjs)
 *
 * **Not for anything ARC computes today, and that is deliberate.** Every figure
 * that reads a weight compares a movement with ITSELF — personal records, the
 * live PR stamp, best at each rep count, the e1RM and volume trends, the
 * progression target, the stall check, the prefill — and one movement's basis is
 * the same on every set it has, so doubling would change no comparison and would
 * make every number disagree with the dumbbell the owner is holding. Those
 * figures stay in the logged basis and the screen SAYS which basis that is.
 *
 * Freshness, weekly volume and the strain pillar never read a weight at all
 * (0055's header lists why), so the question does not arise there. The Coach
 * gets the figure as logged with `loadBasis` beside it, and does its own
 * arithmetic knowing what the number is.
 *
 * Nothing in ARC sums load ACROSS movements. The day something does (a session
 * tonnage, say), {@link loadMovedKg} is the only admissible conversion:
 * `per_hand` and `per_side` double because both sides carried the load;
 * `total`, `stack` and `bodyweight_plus` count as logged (the last excludes the
 * body, because ARC does not know what the body weighed that day); `assisted`
 * refuses, because an assistance figure is not a load that was moved.
 *
 * ## Assisted movements set no load records
 *
 * On an assisted pull-up a HIGHER figure is an EASIER set, so the heaviest set,
 * the best e1RM and the best at each rep count would all crown the easiest work.
 * {@link loadRecordsApply} is the gate the record and PR code asks.
 */
import { hasMeasure, type Measures } from './measures';
import type { Equipment, LoggingType, MovementPattern } from './types';

/** The six values `exercises.load_basis` may hold (0062's CHECK, in its order). */
export type LoadBasis =
  'total' | 'per_hand' | 'per_side' | 'stack' | 'bodyweight_plus' | 'assisted';

export const LOAD_BASES: readonly LoadBasis[] = [
  'total',
  'per_hand',
  'per_side',
  'stack',
  'bodyweight_plus',
  'assisted',
];

const LOAD_BASIS_SET: ReadonlySet<string> = new Set(LOAD_BASES);

/**
 * Read a stored or drafted value back. TOTAL: anything that is not one of the
 * six reads as null ("no correction") rather than throwing — it runs inside
 * `toCatalogExercise`, which every picker and screen goes through.
 */
export function asLoadBasis(raw: unknown): LoadBasis | null {
  return typeof raw === 'string' && LOAD_BASIS_SET.has(raw) ? (raw as LoadBasis) : null;
}

/**
 * The short name, in the label voice: the second line of the logger's weight
 * column heading ("KG" / "PER HAND"), and the chooser's chips.
 */
export const LOAD_BASIS_LABEL: Record<LoadBasis, string> = {
  total: 'Total',
  per_hand: 'Per hand',
  per_side: 'Per side',
  stack: 'Stack',
  bodyweight_plus: 'Added',
  assisted: 'Assist',
};

/**
 * The basis as it reads after a number in a line of prose or a set line:
 * "8 × 30 kg per hand", "8 × 100 kg total", "8 × 10 kg added".
 */
export const LOAD_BASIS_INLINE: Record<LoadBasis, string> = {
  total: 'total',
  per_hand: 'per hand',
  per_side: 'per side',
  stack: 'on the stack',
  bodyweight_plus: 'added',
  assisted: 'assisted',
};

/**
 * The consequence of changing the basis, said before it is changed: under the
 * detail screen's chooser, and on the Coach's card for the same act
 * (2026-09-25) — one constant, so the two cannot drift.
 */
export const LOAD_BASIS_CONSEQUENCE =
  'Changing it relabels every set already logged. No number changes.';

/** One plain sentence per basis — what the detail screen says under the choice. */
export const LOAD_BASIS_MEANING: Record<LoadBasis, string> = {
  total: 'The whole load. A barbell counts the bar.',
  per_hand: 'One dumbbell or handle. The other hand carries the same.',
  per_side: 'One side of the load: the plates on one side, or one of two cable stacks.',
  stack: 'The number on the machine or cable stack.',
  bodyweight_plus:
    'Weight added to your bodyweight, such as a belt or a vest. Blank is bodyweight alone.',
  assisted: 'The help the machine gives. A lower number is harder.',
};

/** What {@link deriveLoadBasis} reads — a subset of `CatalogExercise`. */
export type LoadBasisInput = {
  name: string;
  aliases?: readonly string[];
  equipment: Equipment;
  loggingType: LoggingType;
  measures: Measures;
  unilateral: boolean;
  movementPattern?: MovementPattern | null;
};

/** Lowercase, punctuation to spaces — so "Single-Arm" and "single arm" are one phrase. */
function wordsOf(ex: LoadBasisInput): string {
  return ` ${[ex.name, ...(ex.aliases ?? [])].join(' | ')} `
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, ' ');
}

/** One limb at a time, stated in the name: the figure is the one implement in that hand. */
const ONE_ARM = /\b(single arm|one arm|single hand|one hand|alternating)\b/;
/** One implement held in BOTH hands: the figure is the whole of it. */
const BOTH_HANDS_ONE_IMPLEMENT =
  /\b(goblet|swing|swings|pullover|two hand|two handed|french press|overhead triceps? extension)\b/;
/** Two cable stacks worked at once, one handle each: the figure is one stack. */
const TWO_STACKS = /\b(fly|flye|flyes|flies|crossover|crossovers)\b/;
/** A machine whose load is plates on each side, said in its name. */
const PLATES_EACH_SIDE = /\b(iso lateral|isolateral|plate loaded)\b/;
/** Upper-body patterns, where a unilateral cable movement is one arm on one handle. */
const UPPER_PATTERNS: ReadonlySet<MovementPattern> = new Set([
  'push_h',
  'push_v',
  'pull_h',
  'pull_v',
]);

/**
 * ARC's reading of what a movement's weight figure counts, from its catalog row
 * alone. Null when the movement records no load — a plank, a push-up, a run
 * have no weight figure to describe.
 *
 * Order matters and is the argument:
 *
 *   1. **The logging type says it outright** for two cases — a weighted
 *      bodyweight movement's figure is the added load, an assisted one's is the
 *      assistance — whatever the equipment column says.
 *   2. **Equipment** settles the rest, with the name refining it where the same
 *      equipment is used two ways: one dumbbell held in both hands (goblet,
 *      swing, pullover, French press) is `total`; a cable fly or crossover works
 *      two stacks, so its figure is `per_side`; a single-arm cable movement is
 *      `per_hand`.
 *   3. `machine` defaults to `stack`. A plate-loaded machine is the owner's
 *      correction to make, because nothing in the row says which his is.
 */
export function deriveLoadBasis(ex: LoadBasisInput): LoadBasis | null {
  if (!hasMeasure(ex.measures, 'load')) return null;
  if (ex.loggingType === 'assisted_bodyweight') return 'assisted';
  if (ex.loggingType === 'weighted_bodyweight') return 'bodyweight_plus';

  const words = wordsOf(ex);
  switch (ex.equipment) {
    case 'dumbbell':
    case 'kettlebell':
      if (ONE_ARM.test(words)) return 'per_hand';
      return BOTH_HANDS_ONE_IMPLEMENT.test(words) ? 'total' : 'per_hand';
    case 'cable':
      if (ONE_ARM.test(words)) return 'per_hand';
      if (TWO_STACKS.test(words)) return 'per_side';
      if (ex.unilateral && ex.movementPattern != null && UPPER_PATTERNS.has(ex.movementPattern)) {
        return 'per_hand';
      }
      return 'stack';
    case 'machine':
      if (PLATES_EACH_SIDE.test(words)) return 'per_side';
      if (ONE_ARM.test(words)) return 'per_hand';
      return 'stack';
    case 'bodyweight':
    case 'pullup_bar':
    case 'suspension':
    case 'bench':
      // A movement on the body that still records a load is carrying one ON the
      // body — the logging type said so for the seeded rows, the equipment says
      // it for a custom one authored as plain weight × reps.
      return 'bodyweight_plus';
    case 'barbell':
    case 'ez_bar':
    case 'trap_bar':
    case 'smith':
    case 'plate':
    case 'medicine_ball':
    case 'band':
    case 'other':
      return 'total';
  }
}

/**
 * The basis a movement's figures are shown and read in: the owner's correction
 * when there is one, ARC's reading otherwise — and null, whatever is stored,
 * for a movement that records no load (there is no figure to describe).
 */
export function effectiveLoadBasis(ex: LoadBasisInput, stored: LoadBasis | null): LoadBasis | null {
  if (!hasMeasure(ex.measures, 'load')) return null;
  return stored ?? deriveLoadBasis(ex);
}

/**
 * The weight column heading, as LINES: `["kg", "Per hand"]`, or just the unit
 * when there is no basis to state (a free-text block).
 *
 * Two lines, not "KG · PER HAND" on one: at 375 pt the logger's load column is
 * about 63 pt wide, and ten-point tracked capitals need ~90 pt for thirteen
 * characters. A one-line heading would wrap wherever the text ran out, often
 * between "PER" and "HAND"; two lines put the break where the meaning is.
 */
export function weightColumnHeading(unit: string, basis: LoadBasis | null): string[] {
  return basis == null ? [unit] : [unit, LOAD_BASIS_LABEL[basis]];
}

/** "30 kg" → "30 kg per hand". Unchanged when there is no basis to state. */
export function withLoadBasis(weightText: string, basis: LoadBasis | null | undefined): string {
  return basis == null ? weightText : `${weightText} ${LOAD_BASIS_INLINE[basis]}`;
}

/**
 * Whether load-based records (heaviest, best e1RM, best at each rep count, set
 * and session volume) mean anything for this basis. False only for `assisted`,
 * where a higher figure is an easier set.
 */
export function loadRecordsApply(basis: LoadBasis | null): boolean {
  return basis !== 'assisted';
}

/**
 * How many of the logged figure were actually moved — the ONLY conversion for a
 * computation that sums load across different movements. See the module note:
 * nothing does today, and this is where the answer lives when something does.
 */
export function loadMovedFactor(basis: LoadBasis | null): number | null {
  switch (basis) {
    case 'per_hand':
    case 'per_side':
      return 2;
    case 'total':
    case 'stack':
    case 'bodyweight_plus':
      return 1;
    case 'assisted':
      return null;
    default:
      // No basis means no load column — nothing was loaded to count.
      return null;
  }
}

/** Load moved by one set, kg — null when the basis refuses or the set carries no load. */
export function loadMovedKg(
  weightKg: number | null,
  reps: number | null,
  basis: LoadBasis | null
): number | null {
  const factor = loadMovedFactor(basis);
  if (factor == null || weightKg == null || reps == null || weightKg <= 0 || reps <= 0) return null;
  return weightKg * reps * factor;
}
