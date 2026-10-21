/**
 * The caffeine cut-off before training (device round 3, item 72, 2026-10-21,
 * no migration).
 *
 * Owner, from the device: *"Caffeine warning? i.e., i have a standing no
 * caffeine before workouts policy, if i log something with caffeine before a
 * planned workout, it could prompt with a warning: are you sure you want to
 * eat/drink this?"*. His decision on the shape: he states the rule once ("no
 * caffeine within 6 h before a planned workout"); logging something with
 * caffeine inside that window before a TIMED Training row today asks *Log
 * anyway?*. It **warns and never blocks**: one tap continues, Cancel returns
 * to the screen unchanged.
 *
 * ## Why a deterministic check is allowed here
 *
 * The standing rule is that clinical judgment lives in the model, never in a
 * hardcoded rule. This is not ARC's judgment: it is HIS rule, stated by him on
 * the targets screen, and the check only reminds him of it. It decides
 * nothing — the save goes through on one tap — and it carries no colour and
 * no verdict.
 *
 * ## The definitions
 *
 * - **Caffeine** is `caffeine_mg` in the items' per-portion micros snapshot
 *   (src/lib/nutrition/micros.ts) — the figure the Eat tab prints. A composite
 *   (0058) is its parts; its header carries no numbers. Nothing here guesses
 *   caffeine from a name: an item that records none has none.
 * - **The floor** is {@link CAFFEINE_FLOOR_MG}, 5 mg. Decaf is not caffeine-
 *   free — USDA SR Legacy (NDB 14202) puts brewed decaf at ~2 mg a 240 g cup —
 *   and a rule against caffeine that trips on decaf would be ignored by the
 *   second week. 5 mg sits above a cup of decaf and below the smallest real
 *   dose the catalog carries (a 10 g square of dark chocolate, 8 mg, 0063), so
 *   a square of chocolate still asks: his rule says none, and it is a warning.
 * - **A Training row** is training-tick.ts's own: a row Home labels TRAINING,
 *   planned, not removed, and still `pending` — done, skipped and partial rows
 *   have been acted on. Only a TIMED one: an untimed workout has no "6 h
 *   before".
 * - **The window**: the log time is at or before the row, by at most the rule's
 *   hours — inclusive at both ends. Exactly 6 h before a 6 h rule asks; 6 h
 *   1 min does not. A log at the row's own minute asks (caffeine at the start
 *   of a session is what the rule is about); a minute after it does not.
 *   Minutes are counted from his `dayStartsAt`, so with a 04:00 boundary an
 *   01:00 row is LATER than a 23:00 coffee on the same logical day.
 * - **Which row is named**: the next one — the smallest gap at or after the
 *   log time. If that one is outside the window, every later one is too.
 *
 * Pure and DB-free, so the headless suite drives every edge.
 */
import { parseMicros } from './micros';

/** The cut-off a fresh switch-on starts at — the owner's own example. */
export const CAFFEINE_CUTOFF_DEFAULT_HOURS = 6;
/** The setting's range, in whole hours. */
export const CAFFEINE_CUTOFF_MIN_HOURS = 1;
export const CAFFEINE_CUTOFF_MAX_HOURS = 12;

/** Below this much caffeine nothing asks — see the header for why 5 mg. */
export const CAFFEINE_FLOOR_MG = 5;

/** A stored hours value, or the default when absent, junk or out of range. */
export function normalizeCutoffHours(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CAFFEINE_CUTOFF_MIN_HOURS &&
    value <= CAFFEINE_CUTOFF_MAX_HOURS
    ? value
    : CAFFEINE_CUTOFF_DEFAULT_HOURS;
}

/** What the check reads off an item about to be logged — a `NewMealItem` fits. */
export type CaffeineItem = {
  micros?: string | null;
  components?: readonly { micros?: string | null }[] | null;
};

/** The caffeine, in mg, of everything about to be logged. */
export function caffeineMgOf(items: readonly CaffeineItem[]): number {
  let mg = 0;
  for (const item of items) {
    // A composite is its parts (its header is written with no numbers, 0058).
    const parts = item.components && item.components.length > 0 ? item.components : [item];
    for (const part of parts) mg += parseMicros(part.micros).caffeine_mg ?? 0;
  }
  return mg;
}

/** One of today's still-open, timed Training rows. */
export type OpenTrainingRow = { title: string; time: string };

/** What the prompt says. */
export type CaffeineWarning = {
  /** The caffeine being logged, mg (unrounded). */
  mg: number;
  /** The row it is before, as Home prints it. */
  title: string;
  /** The row's `HH:MM`. */
  time: string;
  /** Minutes from the log time to the row, 0 … hours × 60. */
  minutesBefore: number;
  /** His rule, in hours. */
  ruleHours: number;
};

/** `HH:MM` → minutes past midnight, or null for anything that is not a clock. */
function clockMinutes(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h <= 23 && m <= 59 ? h * 60 + m : null;
}

/**
 * Whether logging `mg` of caffeine at `logTime` breaks his rule, and against
 * which row — or null.
 *
 * `priorMg` is what the same record already held before this write (a
 * revision of a meal he already answered for): only caffeine this write ADDS,
 * by at least the floor, asks again. Every new log passes 0.
 */
export function caffeineWarning(input: {
  mg: number;
  priorMg?: number;
  logTime: string;
  rows: readonly OpenTrainingRow[];
  /** His cut-off in hours, or null when the setting is off. */
  ruleHours: number | null;
  /** `dayStartMinutes()` — minutes past midnight the logical day begins. */
  dayStartMinutes?: number;
}): CaffeineWarning | null {
  const { mg, logTime, rows, ruleHours } = input;
  if (ruleHours === null) return null;
  if (!(mg >= CAFFEINE_FLOOR_MG)) return null;
  if (!(mg - (input.priorMg ?? 0) >= CAFFEINE_FLOOR_MG)) return null;
  const start = input.dayStartMinutes ?? 0;
  const logical = (minutes: number) => (minutes - start + 1440) % 1440;
  const at = clockMinutes(logTime);
  if (at === null) return null;
  const from = logical(at);

  let next: { row: OpenTrainingRow; gap: number } | null = null;
  for (const row of rows) {
    const minutes = clockMinutes(row.time);
    if (minutes === null) continue;
    const gap = logical(minutes) - from;
    if (gap < 0) continue; // the row is already behind him
    if (next === null || gap < next.gap) next = { row, gap };
  }
  if (next === null || next.gap > ruleHours * 60) return null;
  return {
    mg,
    title: next.row.title,
    time: next.row.time,
    minutesBefore: next.gap,
    ruleHours,
  };
}

/** `3 h` · `2 h 40 min` · `45 min` — exact, never rounded up into the rule. */
function spanWords(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Where the log sits relative to the row, in words. */
function whenWords(w: CaffeineWarning): string {
  return w.minutesBefore === 0
    ? `at the start of ${w.title} (${w.time})`
    : `${spanWords(w.minutesBefore)} before ${w.title} (${w.time})`;
}

/** The prompt's title — a fact, no verdict. */
export const CAFFEINE_WARNING_TITLE = 'Caffeine before training';

/**
 * The prompt's body: *This has about 80 mg caffeine, 3 h before Push Day
 * (18:00). Your rule: none within 6 h. Log anyway?*
 */
export function caffeineWarningMessage(w: CaffeineWarning): string {
  return (
    `This has about ${Math.round(w.mg)} mg caffeine, ${whenWords(w)}. ` +
    `Your rule: none within ${w.ruleHours} h. Log anyway?`
  );
}

/**
 * The same fact as one clause on the Coach's confirmation card, which is
 * already the place he decides: *about 80 mg caffeine, 3 h before Push Day
 * (18:00) — your rule: none within 6 h*.
 */
export function caffeineCardNote(w: CaffeineWarning): string {
  return `about ${Math.round(w.mg)} mg caffeine, ${whenWords(w)} — your rule: none within ${w.ruleHours} h`;
}
