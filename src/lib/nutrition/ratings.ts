/**
 * Was this estimate right? — device round 3, item 86 (docs/nutrition-subapp.md
 * §23). The owner: *"good/bad rating for food logs & questions asked to collect
 * data and make them better"*; his decision: the rating is about HOW ACCURATE
 * THE LOG WAS, an "off" asks ONE question (portion, item or macros?), and the
 * correction becomes an example the estimator sees next time.
 *
 * Pure and DB-free. The repository (src/lib/db/repositories/food-log-ratings.ts)
 * takes the snapshots and reads the rows; this file says what a snapshot is,
 * what changed between two of them, and how the changes read to the model.
 *
 * ## What the estimator is shown
 *
 * One line per corrected meal, newest first, at most
 * {@link CORRECTION_EXAMPLES_LIMIT}, and never more than
 * {@link CORRECTIONS_CHAR_BUDGET} characters in all:
 *
 * ```
 * - portion off: "Chicken salad" 350 g · 520 kcal → 250 g · 371 kcal
 * - item off: "Butter" 10 g · 72 kcal → "Olive oil" 10 g · 88 kcal
 * ```
 *
 * **Food names and figures only** — no dates, times, meal names or notes. A
 * name is flattened to one line ({@link oneLine}) and capped, so it cannot add
 * a line of its own to the block. Like his usual foods (§21), the block rides
 * the USER turn; the system prompt is at its ceiling and is never touched.
 */
import type { MealItemNode } from './composite';
import { foodKey, isStandIn, oneLine } from './repeats';
import type { AmountUnit } from './types';

export type EstimateRating = 'good' | 'bad';
export type RatingIssue = 'portion' | 'item' | 'macros';

/** The one question's three answers, in the order they are offered. */
export const RATING_ISSUES: readonly { issue: RatingIssue; label: string }[] = [
  { issue: 'portion', label: 'Portion' },
  { issue: 'item', label: 'Item' },
  { issue: 'macros', label: 'Macros' },
];

/** At most this many corrections reach one estimate. */
export const CORRECTION_EXAMPLES_LIMIT = 8;
/** …and never more than this many characters (~444 tokens at chars/3.6). */
export const CORRECTIONS_CHAR_BUDGET = 1600;
/** One meal's line names at most this many changes, then counts the rest. */
export const CORRECTION_CHANGES_PER_LINE = 2;
/** A food's name in an example, at most this long. */
const NAME_CAP = 40;

/** One top-level item as a snapshot holds it: a dish reads as its parts' sum. */
export type RatedItem = {
  name: string;
  amount: number | null;
  unit: AmountUnit;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};

/** A rated-off meal whose items changed: what it was, and what it became. */
export type RatingCorrection = {
  issue: RatingIssue | null;
  before: RatedItem[];
  after: RatedItem[];
};

/**
 * The meal's top-level rows as a snapshot — a composite as its rolled sum.
 *
 * **Never a combine's stand-in** (`<name> (as logged)`, {@link isStandIn}): it
 * carries a free-form meal's typed totals under the MEAL's name, which is not
 * a food — and the block promises the estimator no meal names. The usual-foods
 * and repeat reads drop it for the same reason (src/lib/nutrition/repeats.ts).
 */
export function ratedItems(nodes: readonly MealItemNode[]): RatedItem[] {
  return nodes.filter((node) => !isStandIn(node.item.name)).map((node) => {
    const figures = node.kind === 'composite' ? node.rolled : node.item;
    return {
      name: node.item.name,
      amount: figures.amount,
      unit: figures.unit,
      kcal: figures.kcal,
      protein_g: figures.protein_g,
      carbs_g: figures.carbs_g,
      fat_g: figures.fat_g,
    };
  });
}

export function serializeRatedItems(items: readonly RatedItem[]): string {
  return JSON.stringify(items);
}

/**
 * Whether two stored snapshots hold the same items, in ANY order. A snapshot
 * is a set of what was on the plate, not a list: a combine appends the joined
 * meal's items to a rating's snapshots (`combineMeals`), while the meal itself
 * lists them by when they were logged, and that difference of order is not a
 * correction. Null equals only null.
 */
export function sameRatedItems(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const canon = (text: string) =>
    (parseRatedItems(text) ?? [])
      .map((item) => JSON.stringify(item))
      .sort()
      .join('\n');
  return canon(a) === canon(b);
}

/** A stored snapshot with `extra` items appended; null stays null. */
export function withRatedItems(text: string | null, extra: readonly RatedItem[]): string | null {
  if (text === null) return null;
  return serializeRatedItems([...(parseRatedItems(text) ?? []), ...extra]);
}

const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A stored snapshot, read defensively: null for no snapshot, rows that are not
 *  items dropped rather than trusted. */
export function parseRatedItems(text: string | null): RatedItem[] | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): RatedItem[] => {
    if (typeof row !== 'object' || row === null) return [];
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string') return [];
    return [
      {
        name: r.name,
        amount: numOrNull(r.amount),
        unit: r.unit === 'ml' ? 'ml' : 'g',
        kcal: numOrNull(r.kcal),
        protein_g: numOrNull(r.protein_g),
        carbs_g: numOrNull(r.carbs_g),
        fat_g: numOrNull(r.fat_g),
      },
    ];
  });
}

const fig = (n: number | null): string => (n === null ? '?' : String(Math.round(n)));
const portion = (i: RatedItem): string | null =>
  i.amount !== null && i.amount > 0 ? `${fig(i.amount)} ${i.unit}` : null;
const kcal = (i: RatedItem): string => `${fig(i.kcal)} kcal`;
const macros = (i: RatedItem): string => `${fig(i.protein_g)}/${fig(i.carbs_g)}/${fig(i.fat_g)}`;
const quoted = (i: RatedItem): string =>
  `"${oneLine(i.name).replace(/"/g, "'").slice(0, NAME_CAP)}"`;

/** A row as one phrase: `"Butter" 10 g · 72 kcal`. */
function phrase(i: RatedItem): string {
  const p = portion(i);
  return p ? `${quoted(i)} ${p} · ${kcal(i)}` : `${quoted(i)} ${kcal(i)}`;
}

/** The changes between two snapshots, before order first, as phrases. Rounded:
 *  a change below the last printed digit is not a change. */
function changesBetween(
  beforeRows: readonly RatedItem[],
  afterRows: readonly RatedItem[]
): string[] {
  // A stand-in stored by an older snapshot is still not a food (see ratedItems).
  const before = beforeRows.filter((i) => !isStandIn(i.name));
  const after = afterRows.filter((i) => !isStandIn(i.name));
  const key = (i: RatedItem) => foodKey({ food_id: null, name: i.name });
  const taken = new Set<number>();
  const removed: RatedItem[] = [];
  const changes: string[] = [];
  for (const b of before) {
    const index = after.findIndex((a, n) => !taken.has(n) && key(a) === key(b));
    if (index === -1) {
      removed.push(b);
      continue;
    }
    taken.add(index);
    const a = after[index]!;
    if (portion(a) !== portion(b)) {
      changes.push(`${phrase(b)} → ${[portion(a) ?? 'no amount', kcal(a)].join(' · ')}`);
    } else if (kcal(a) !== kcal(b) || macros(a) !== macros(b)) {
      changes.push(`${quoted(b)} ${kcal(b)} · ${macros(b)} → ${kcal(a)} · ${macros(a)}`);
    }
  }
  const added = after.filter((_, n) => !taken.has(n));
  // A food swapped for another: paired in order, the rest said on their own.
  const swaps = Math.min(removed.length, added.length);
  for (let n = 0; n < swaps; n += 1) changes.push(`${phrase(removed[n]!)} → ${phrase(added[n]!)}`);
  for (const b of removed.slice(swaps)) changes.push(`${phrase(b)} was not there`);
  for (const a of added.slice(swaps)) changes.push(`missed ${phrase(a)}`);
  return changes;
}

/** One meal's example line, or null when nothing printable changed. */
export function describeCorrection(correction: RatingCorrection): string | null {
  const changes = changesBetween(correction.before, correction.after);
  if (changes.length === 0) return null;
  const shown = changes.slice(0, CORRECTION_CHANGES_PER_LINE);
  const more = changes.length - shown.length;
  const label = correction.issue ? `${correction.issue} off` : 'off';
  return `- ${label}: ${shown.join('; ')}${more > 0 ? `; +${more} more` : ''}`;
}

export const CORRECTIONS_HEADING =
  'Estimates this person corrected before (estimated → actual; protein/carbs/fat g). Calibrate similar foods and portions by them; they are not part of this meal:';

/**
 * The per-call block, newest correction first, or null when there is none — a
 * cold start costs no tokens. Capped twice: {@link CORRECTION_EXAMPLES_LIMIT}
 * lines, then the oldest lines go until the block fits
 * {@link CORRECTIONS_CHAR_BUDGET}.
 */
export function correctionsContext(corrections: readonly RatingCorrection[]): string | null {
  const lines = corrections
    .map(describeCorrection)
    .filter((line): line is string => line !== null)
    .slice(0, CORRECTION_EXAMPLES_LIMIT);
  const size = () => [CORRECTIONS_HEADING, ...lines].join('\n').length;
  while (lines.length > 0 && size() > CORRECTIONS_CHAR_BUDGET) lines.pop();
  if (lines.length === 0) return null;
  return [CORRECTIONS_HEADING, ...lines].join('\n');
}
