/**
 * The shape of an unfinished workout — what gets written through to
 * `workout_drafts` (0045) on every keystroke so that closing, crashing or being
 * killed mid-session costs nothing.
 *
 * Owner report, 2026-09-14: *"losing workout information when closing app mid
 * workout, necessary for fixing when app bugs."* ARC data has exactly one copy,
 * so a session lost to a process kill is gone for good.
 *
 * ## Why the shape lives here and not in the screen
 *
 * `app/workout-live.tsx` holds this state and could perfectly well have
 * declared it inline, as it used to. It is here because the moment state is
 * PERSISTED it becomes a contract with a future build: a draft written by the
 * version installed this morning is read back by the version installed tonight.
 * A contract that lives inside a component drifts the first time someone
 * refactors the component. So the screen imports {@link DraftBlock} /
 * {@link DraftSet} as its own working types (`LiveBlock` / `LiveSet`), which
 * means the thing serialised and the thing rendered cannot get out of step.
 *
 * ## Versioning: a draft is allowed to be thrown away
 *
 * {@link DRAFT_VERSION} is stamped on write and checked on read, and a payload
 * that does not match is DISCARDED rather than migrated. That is the right
 * trade here and nowhere else in ARC: a draft is at most one unfinished session
 * old, the user is standing in the gym holding the phone, and the cost of a
 * wrong guess (silently resurrecting half a session in the wrong shape) is far
 * worse than "nothing to resume". B1 — reps / time / distance metric types on
 * the same logger — did exactly that on 2026-09-14: {@link DraftSet} grew a
 * time and a distance, {@link DRAFT_VERSION} went to 2, and the one abandoned
 * draft on the device evaporates on first launch. The mechanism worked as
 * designed the first time it was needed.
 *
 * Parsing is likewise total: anything malformed reads as `null`, never a throw.
 * This runs in a `useState` initialiser on the logger's mount path, and a
 * corrupt row must not be able to make the screen un-openable.
 */
import type { PrevSet } from '@/lib/db/repositories/training-stats';
import { asMeasures, type Measures } from '@/lib/exercise/measures';
import type { LoggingType, Mechanic, SetType, WorkoutKind } from '@/lib/exercise/types';

/**
 * Bumped whenever {@link LiveDraft} or {@link ManualDraft} changes shape.
 *
 * **1 → 2 on 2026-09-14 (B1, migration 0046).** Both drafts gained time and
 * distance: `DraftSet` carries `time`/`distance` strings, `DraftBlock` carries
 * the exercise's `measures`, and `ManualDraft` carries the typed time/distance
 * and the movement it resolved to. A v1 payload has none of those, so a v1
 * block would render as reps × load whatever the movement now measures — which
 * is the exact confusion this release removes. It is discarded instead: the
 * owner has at most one abandoned session on the device and it evaporates on
 * first launch, which is the trade {@link parseLiveDraft} was built for.
 */
export const DRAFT_VERSION = 2;

/** The two draft slots — one per logging screen (`workout_drafts.key`). */
export type DraftKey = 'live' | 'manual';

const SET_TYPES: SetType[] = ['normal', 'warmup', 'failure', 'drop'];
const LOGGING_TYPES: LoggingType[] = [
  'weight_reps',
  'bodyweight_reps',
  'weighted_bodyweight',
  'assisted_bodyweight',
  'duration',
  'weight_duration',
  'distance_duration',
];
const WORKOUT_KINDS: WorkoutKind[] = ['strength', 'cardio', 'mobility', 'other'];

/**
 * One set row in the live logger. Values are STRINGS because they are exactly
 * what is in the text fields — "12", "", "1 3" mid-typing — and a draft that
 * round-trips through numbers would quietly correct or drop what the user has
 * half-written, which is the one thing a draft must never do.
 */
export type DraftSet = {
  key: number;
  weight: string;
  reps: string;
  rpe: string;
  /**
   * The timed and measured fields (0046), as typed: `time` is an `mm:ss` string
   * (`parseClock` reads it), `distance` is a number in the user's own distance
   * unit — metres are canonical only once the set is saved. Strings for the
   * same reason every other field here is one: a draft must round-trip what is
   * half-written, and "4:" is a legal thing to be in the middle of typing.
   */
  time: string;
  distance: string;
  setType: SetType;
  done: boolean;
  pr: boolean;
  /**
   * For a set loaded from a stored session: the exact canonical kg it was read
   * with, and the display string it rendered as. An untouched weight writes back
   * byte-for-byte on Save instead of round-tripping through the display unit and
   * drifting — that round-trip is only lossless when the stored kg already
   * matches a round display value. Absent on sets typed fresh.
   */
  storedWeightKg?: number | null;
  storedWeightText?: string;
};

/** One exercise block in the live logger: a movement and its set rows. */
export type DraftBlock = {
  key: number;
  /**
   * The catalog movement, or null for a free-text set — a genuinely custom
   * movement the logger never resolved, or one whose catalog entry has since
   * been deleted. Nullable so the editor can hold and re-save such a set rather
   * than dropping it.
   */
  exerciseId: string | null;
  name: string;
  loggingType: LoggingType;
  /**
   * What this movement measures (0046) — the block's column set. Carried on the
   * draft rather than re-read from the catalog on resume so that a session
   * resumed after the exercise was edited still shows the columns its numbers
   * were typed into.
   */
  measures: Measures;
  mechanic: Mechanic | null;
  restSec: number | null;
  prev: PrevSet[];
  /** Best e1RM before this session — the bar a set must beat to tag a PR. */
  bestE1rm: number | null;
  /** Grouped into a superset with the block below it (shared superset_group). */
  linkedToNext: boolean;
  sets: DraftSet[];
};

/**
 * The live logger's whole recoverable state.
 *
 * `startedAt` is an absolute epoch instant, not an elapsed count, so the clock
 * reads correctly after a kill instead of restarting at zero — the session
 * really did start when it started. `restEndsAt` is the same idea for the rest
 * timer: a target instant survives being away, and one already in the past is
 * simply over.
 *
 * `routineId` rides along because Finish stamps `touchRoutineStarted` with it;
 * resuming a saved workout and finishing it has to mark that workout used, the
 * same as if the app had never closed.
 *
 * `ingestId` (0054) rides along for exactly the same reason, one level up: a
 * session opened from the Train hub's "From your watch" blank takes its DAY, its
 * DURATION and its start instant from the HealthKit row it is filling in, and
 * links to it on Finish. A resumed fill that forgot which session it was filling
 * would save as an ordinary workout dated today, leaving the blank still asking
 * and a second session beside it. Null for every session that is not a fill —
 * which is why an older draft parsing to null needs no version bump.
 *
 * What is deliberately NOT here: the session being EDITED (`workoutId`). An
 * edit of a past session already has a saved copy in `workouts` — losing
 * unsaved edits loses nothing that was ever recorded — and a resumable edit
 * draft could only ever surprise the user by re-applying half a correction to a
 * session they have since looked at. Drafts are for work that exists nowhere
 * else.
 */
export type LiveDraft = {
  version: number;
  startedAt: number;
  routineId: string | null;
  /** `wearable_data.id` of the ingested session being filled in (0054), or null. */
  ingestId: string | null;
  restEndsAt: number | null;
  blocks: DraftBlock[];
};

/**
 * One drafted set in the free-form manual logger. Weight is DISPLAY lb (not
 * canonical kg) because that is what the field takes; time and distance are
 * already canonical (seconds, metres) because neither has a display form that
 * could round-trip wrong — `mm:ss` is seconds and the distance field's unit is
 * known at the moment it is typed.
 */
export type ManualDraftSet = {
  exercise: string;
  reps: number | null;
  weightLb: number | null;
  durationSec: number | null;
  distanceM: number | null;
};

/**
 * The manual logger's recoverable state. It keeps the ENTRY ROW as typed
 * (`exercise` / `repsText` / `weightText` / `entryDirty`) and not just the
 * added sets, because that screen deliberately saves a typed-but-never-Added
 * row on Finish — so the half-typed row is real data, and dropping it on resume
 * would lose a set the user would otherwise have kept.
 */
export type ManualDraft = {
  version: number;
  startedAt: number;
  mode: 'live' | 'past';
  kind: WorkoutKind;
  durationText: string;
  sets: ManualDraftSet[];
  exercise: string;
  repsText: string;
  weightText: string;
  /** The entry row's time/distance fields as typed (0046), mm:ss and display unit. */
  timeText: string;
  distanceText: string;
  /**
   * What the typed exercise name resolved to in the catalog, so the fields on
   * screen are the ones that movement measures. Re-derived on every keystroke,
   * persisted so a resume draws the same row it was left on.
   */
  measures: Measures;
  entryDirty: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asBool = (v: unknown): boolean => v === true;
const asFiniteNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asOneOf = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
  typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : fallback;

function parsePrevSets(raw: unknown): PrevSet[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((p) => ({
    reps: asFiniteNumber(p.reps),
    weightKg: asFiniteNumber(p.weightKg),
    rpe: asFiniteNumber(p.rpe),
    durationSec: asFiniteNumber(p.durationSec),
    distanceM: asFiniteNumber(p.distanceM),
  }));
}

function parseSet(raw: unknown, index: number): DraftSet | null {
  if (!isRecord(raw)) return null;
  const set: DraftSet = {
    // A key is only ever a render identity, so a missing one is recoverable:
    // fall back to the position rather than dropping a set the user typed.
    key: asFiniteNumber(raw.key) ?? index + 1,
    weight: asString(raw.weight),
    reps: asString(raw.reps),
    rpe: asString(raw.rpe),
    time: asString(raw.time),
    distance: asString(raw.distance),
    setType: asOneOf(raw.setType, SET_TYPES, 'normal'),
    done: asBool(raw.done),
    pr: asBool(raw.pr),
  };
  if (raw.storedWeightKg !== undefined) set.storedWeightKg = asFiniteNumber(raw.storedWeightKg);
  if (typeof raw.storedWeightText === 'string') set.storedWeightText = raw.storedWeightText;
  return set;
}

function parseBlock(raw: unknown, index: number): DraftBlock | null {
  if (!isRecord(raw)) return null;
  const name = asString(raw.name);
  if (name === '') return null; // a block with no movement is not renderable
  const sets = Array.isArray(raw.sets)
    ? raw.sets.map(parseSet).filter((s): s is DraftSet => s !== null)
    : [];
  return {
    key: asFiniteNumber(raw.key) ?? index + 1,
    exerciseId: typeof raw.exerciseId === 'string' ? raw.exerciseId : null,
    name,
    loggingType: asOneOf(raw.loggingType, LOGGING_TYPES, 'weight_reps'),
    measures: asMeasures(raw.measures),
    // `null` is meaningful here (a free-text block has no mechanic), so an
    // unrecognised value falls back to null rather than to a guessed 'compound'
    // — the mechanic only picks a default rest interval, and a wrong default is
    // worse than none.
    mechanic: raw.mechanic === 'compound' || raw.mechanic === 'isolation' ? raw.mechanic : null,
    restSec: asFiniteNumber(raw.restSec),
    prev: parsePrevSets(raw.prev),
    bestE1rm: asFiniteNumber(raw.bestE1rm),
    linkedToNext: asBool(raw.linkedToNext),
    sets,
  };
}

/**
 * Read a stored live draft. `null` for anything that is not a current-version,
 * non-empty live draft — a wrong version, junk, or a draft whose blocks all
 * failed to parse. Never throws.
 */
export function parseLiveDraft(raw: unknown): LiveDraft | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== DRAFT_VERSION) return null;
  const startedAt = asFiniteNumber(raw.startedAt);
  if (startedAt === null) return null;
  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks.map(parseBlock).filter((b): b is DraftBlock => b !== null)
    : [];
  if (blocks.length === 0) return null;
  return {
    version: DRAFT_VERSION,
    startedAt,
    routineId: typeof raw.routineId === 'string' ? raw.routineId : null,
    ingestId: typeof raw.ingestId === 'string' ? raw.ingestId : null,
    restEndsAt: asFiniteNumber(raw.restEndsAt),
    blocks,
  };
}

/** Read a stored manual-logger draft. Same discipline as {@link parseLiveDraft}. */
export function parseManualDraft(raw: unknown): ManualDraft | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== DRAFT_VERSION) return null;
  const startedAt = asFiniteNumber(raw.startedAt);
  if (startedAt === null) return null;
  const sets: ManualDraftSet[] = Array.isArray(raw.sets)
    ? raw.sets.filter(isRecord).map((s) => ({
        exercise: asString(s.exercise),
        reps: asFiniteNumber(s.reps),
        weightLb: asFiniteNumber(s.weightLb),
        durationSec: asFiniteNumber(s.durationSec),
        distanceM: asFiniteNumber(s.distanceM),
      }))
    : [];
  const draft: ManualDraft = {
    version: DRAFT_VERSION,
    startedAt,
    mode: raw.mode === 'live' ? 'live' : 'past',
    kind: asOneOf(raw.kind, WORKOUT_KINDS, 'strength'),
    durationText: asString(raw.durationText),
    sets: sets.filter((s) => s.exercise.trim() !== ''),
    exercise: asString(raw.exercise),
    repsText: asString(raw.repsText),
    weightText: asString(raw.weightText),
    timeText: asString(raw.timeText),
    distanceText: asString(raw.distanceText),
    measures: asMeasures(raw.measures),
    entryDirty: asBool(raw.entryDirty),
  };
  return manualDraftHasData(draft) ? draft : null;
}

/**
 * Does this session hold anything the user would mind losing? A set marked
 * done, or a rep/weight typed. Structure alone does not count: blocks loaded
 * from a saved workout and then abandoned untouched are reproducible by
 * starting that saved workout again, and a Resume card offering them would be
 * noise on the hub for something nobody entered.
 *
 * The logger calls this on its live blocks and the hub calls it on the stored
 * draft, through {@link liveDraftHasData}. One function, because "is there
 * anything here" decides three different things — whether a draft is written,
 * whether backing out prompts, and whether Resume is offered — and those three
 * must never disagree.
 */
export function draftBlocksHaveData(blocks: DraftBlock[]): boolean {
  return blocks.some((b) =>
    b.sets.some(
      (s) =>
        s.done ||
        s.reps.trim() !== '' ||
        s.weight.trim() !== '' ||
        // 0046: a plank's whole session is one time field, and a run's is a time
        // and a distance. Leaving them out of this test would mean a finished
        // run was not "data" — no Resume card, no write-through, and Finish
        // disabled on a session that plainly happened.
        s.time.trim() !== '' ||
        s.distance.trim() !== ''
    )
  );
}

/** {@link draftBlocksHaveData} for a stored draft. */
export function liveDraftHasData(draft: LiveDraft): boolean {
  return draftBlocksHaveData(draft.blocks);
}

/** The same question for the manual logger: any set, or anything typed at all. */
export function manualDraftHasData(draft: ManualDraft): boolean {
  return (
    draft.sets.length > 0 ||
    draft.exercise.trim() !== '' ||
    draft.repsText.trim() !== '' ||
    draft.weightText.trim() !== '' ||
    draft.timeText.trim() !== '' ||
    draft.distanceText.trim() !== '' ||
    draft.durationText.trim() !== ''
  );
}

/** Movement names in performed order, de-duplicated — what the Resume card says. */
export function liveDraftMovements(draft: LiveDraft): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const block of draft.blocks) {
    const name = block.name.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Sets actually completed in this draft — the other half of the Resume card. */
export function liveDraftSetsDone(draft: LiveDraft): number {
  return draft.blocks.reduce((n, b) => n + b.sets.filter((s) => s.done).length, 0);
}

/**
 * How long ago a draft was last written, in words — "12 min ago", "yesterday".
 *
 * The age is the whole reason the Resume card is safe to offer indefinitely: a
 * session abandoned three days ago is resumable, but the user has to be told
 * that is what they are picking up. Hand-rolled because Hermes ships no `Intl`
 * (so no `RelativeTimeFormat`), and the difference is CLAMPED AT ZERO because
 * `updated_at` comes from SQLite's `strftime('now')` while the comparison is a
 * JS `Date` — the two clocks disagree by a hair, and an unclamped subtraction
 * prints "in 0 minutes". An unparseable stamp returns '' and the caller simply
 * says less.
 */
export function draftAgeLabel(updatedAtIso: string, now: Date = new Date()): string {
  const then = Date.parse(updatedAtIso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
