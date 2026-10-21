/**
 * The live logger's per-set numbers — what each row suggests, what a tick on
 * an empty row logs, what a tap on Prev copies, and how a set is deleted with
 * an Undo (owner, round 3, 2026-10-21, items 65 · 67 · 69).
 *
 * Pure and DB-free, so db/exercise.test.mjs drives every rule headlessly; the
 * screen (app/workout-live.tsx) only renders what these return.
 *
 * ## The hint is the engine's, not a new rule (65)
 *
 * *"real intelligent autofilled weight and rep recommendations for each set."*
 * Every row's grey numbers come from ONE of two places, and nothing here
 * decides anything about training that src/lib/exercise/progression.ts does not
 * already decide:
 *
 *   - **the target** — `suggestProgression`'s answer for the movement, taken
 *     when the block is built (`setTargetOf`) and carried on the draft. Hold the
 *     load and chase a rep, add the smallest jump and reset, or drop ~10% after
 *     a stall. Last session, the rep range, RPE (as reps in reserve) and away
 *     sessions all reach it through the engine, which already reads them.
 *   - **last time** — the row's own numbers from the most recent home session
 *     (`lastSessionSets`), exactly what the placeholder showed before.
 *
 * The target applies only where the engine's answer is about LOAD and REPS
 * (`targetApplies`): a working row of a movement that measures both, whose
 * figure is load rather than assistance (0062), in a session that is not
 * away (0055). Everything else — a warm-up row, a plank, a run, an assisted
 * pull-up, a lift with no home history, and every row while Away is on — shows
 * last time, because the engine has no next step for it or the step would be
 * measured on the wrong machine.
 *
 * Two translations from "the session's target" to "this row", both stated:
 *
 *   - **Hold** is "add a rep toward the top". Applied per row, a row done at the
 *     held load last time is offered one rep more than it did, capped at the top
 *     of the range — so 8 · 8 · 7 last time reads 9 · 9 · 8, not 9 · 9 · 9. A row
 *     with no comparable history takes the engine's own rep target.
 *   - **Progress and deload** are new loads, so they are put on real plates:
 *     a progress rounds UP to the next step the user can load (2.5 kg, or a
 *     5 lb pair) and a deload rounds DOWN. Rounding to nearest could turn
 *     "add 1.1 kg" into the same weight at fewer reps — a regression labelled
 *     progress. A held load is never rounded: it is a weight he already lifted.
 *
 * ## What a tick logs (the found bug)
 *
 * Until now a ✓ on a row left empty saved a set with no numbers at all while
 * the grey ones sat beside it looking logged. `tickPatch` makes the tick mean
 * what the row shows: every EMPTY field takes the hint's figure, a typed one
 * keeps what was typed, and a row with nothing typed and nothing hinted is
 * refused rather than saved empty.
 *
 * ## Delete and its Undo (69)
 *
 * The review sheet's rule (src/lib/nutrition/review-undo.ts): one offer at a
 * time, no timer, and the Undo stands only while putting the set back is
 * exact — the block still holds exactly the sets the removal left. Editing a
 * figure on another row does not close it; adding or removing a set does.
 * Supersets are untouched by construction: a bind lives on the BLOCK and a
 * set removal never removes a block. PR stamps are asked again for the
 * movement whenever a DONE set leaves or comes back (`restampMovement`), since
 * a stamp is a claim about the session's other done sets.
 */
import type { PrevSet } from '@/lib/db/repositories/training-stats';
import type { DraftBlock, DraftSet, SetTarget } from '@/lib/exercise/draft';
import { secondsToClock } from '@/lib/exercise/clock-entry';
import { displayDistance, displayWeight, weightSpec } from '@/lib/exercise/format';
import { loadRecordsApply, type LoadBasis } from '@/lib/exercise/load-basis';
import { hasMeasure, type Measures } from '@/lib/exercise/measures';
import type { RecordKind, TypedBlock } from '@/lib/exercise/records';
import type { ProgressionSuggestion } from '@/lib/exercise/types';
import type { UndoWords } from '@/lib/nutrition/undo-store';
import type { UnitPreferences } from '@/lib/user/types';

/** One row's suggestion, canonical units. Null figures are "nothing to offer". */
export type SetHint = {
  weightKg: number | null;
  reps: number | null;
  durationSec: number | null;
  distanceM: number | null;
  /** `target` — the engine's next step; `last` — this row last time. */
  source: 'target' | 'last';
};

/** The four entry fields as the logger types them. */
export type HintFields = {
  weight: string | null;
  reps: string | null;
  time: string | null;
  distance: string | null;
};

/**
 * The engine's answer, kept for the rows — or undefined when it has no load
 * step to offer (`find_weight`, a movement it does not progress by load).
 * `repHigh` rides along so a held row's "+1 rep" respects the same cap the
 * engine used.
 */
export function setTargetOf(s: ProgressionSuggestion, repHigh: number): SetTarget | undefined {
  if (s.kind === 'find_weight' || s.targetWeightKg == null || s.targetReps == null) {
    return undefined;
  }
  if (!Number.isFinite(s.targetWeightKg) || s.targetWeightKg <= 0) return undefined;
  return { kind: s.kind, weightKg: s.targetWeightKg, reps: s.targetReps, repHigh, note: s.note };
}

/**
 * A generated load on real plates (`snapLoadKg`'s steps: 2.5 kg, or a 5 lb
 * pair), rounded the way that keeps its meaning: `up` for a progress (never
 * the same weight again), `down` for a deload (never not a drop). The epsilon
 * keeps a value already on a step — 140 lb read back as 140.0000001 — from
 * being pushed one step further.
 */
export function snapLoadDirected(kg: number, units: UnitPreferences, way: 'up' | 'down'): number {
  const spec = weightSpec(units);
  const step = spec.unit === 'kg' ? 2.5 : 5;
  const display = spec.fromCanonical(kg);
  const steps = way === 'up' ? Math.ceil(display / step - 1e-6) : Math.floor(display / step + 1e-6);
  const snapped = steps * step;
  // A deload of a very light load can round to nothing; the engine's own
  // figure is then the honest one.
  if (snapped <= 0) return kg;
  return spec.toCanonical(snapped);
}

/** Two loads are the same plate set to within rounding. */
const sameLoad = (a: number, b: number) => Math.abs(a - b) < 0.01;

function lastOf(prev: PrevSet | undefined): SetHint | null {
  if (!prev) return null;
  if (
    prev.weightKg == null &&
    prev.reps == null &&
    prev.durationSec == null &&
    prev.distanceM == null
  ) {
    return null;
  }
  return {
    weightKg: prev.weightKg,
    reps: prev.reps,
    durationSec: prev.durationSec,
    distanceM: prev.distanceM,
    source: 'last',
  };
}

/**
 * Does this block's target reach its working rows? The one predicate both the
 * per-row hint and the block's why-line read, so the line never explains
 * numbers the rows are not showing.
 */
export function targetApplies(input: {
  target: SetTarget | undefined;
  measures: Measures;
  basis: LoadBasis | null;
  away: boolean;
  editing: boolean;
}): boolean {
  return (
    input.target != null &&
    !input.editing &&
    !input.away &&
    loadRecordsApply(input.basis) &&
    hasMeasure(input.measures, 'load') &&
    hasMeasure(input.measures, 'reps')
  );
}

/**
 * The grey numbers for one row. Null while editing a stored session — every
 * row there already happened, and a "next session" target on a past one would
 * be a suggestion about the wrong day.
 */
export function setHint(input: {
  block: Pick<DraftBlock, 'prev' | 'target' | 'measures'>;
  index: number;
  set: Pick<DraftSet, 'setType'>;
  basis: LoadBasis | null;
  away: boolean;
  editing: boolean;
  units: UnitPreferences;
}): SetHint | null {
  if (input.editing) return null;
  const prev = input.block.prev[input.index];
  const last = lastOf(prev);
  // The ROW's type decides, not last time's: a new block marks last time's
  // warm-ups as warm-ups up front (app/workout-live.tsx `buildBlock`), so the
  // two agree until the owner changes one — and then the row he changed is
  // the one he means. A warm-up row turned into a working set takes the target.
  const warmup = input.set.setType === 'warmup';
  const target = input.block.target;
  if (
    warmup ||
    !target ||
    !targetApplies({
      target,
      measures: input.block.measures,
      basis: input.basis,
      away: input.away,
      editing: input.editing,
    })
  ) {
    return last;
  }

  let weightKg: number;
  let reps: number;
  if (target.kind === 'hold') {
    weightKg = target.weightKg;
    reps =
      prev?.reps != null && prev.weightKg != null && sameLoad(prev.weightKg, target.weightKg)
        ? Math.min(prev.reps + 1, target.repHigh)
        : target.reps;
  } else {
    weightKg = snapLoadDirected(
      target.weightKg,
      input.units,
      target.kind === 'progress' ? 'up' : 'down'
    );
    reps = target.reps;
  }
  return {
    weightKg,
    reps,
    durationSec: prev?.durationSec ?? null,
    distanceM: prev?.distanceM ?? null,
    source: 'target',
  };
}

/**
 * A hint as the four fields would hold it — the placeholder text AND what a
 * tick writes, from one function, so the number logged is the number shown.
 * Only the columns the movement measures; a figure it has none of is null.
 */
export function hintFields(
  hint: Pick<SetHint, 'weightKg' | 'reps' | 'durationSec' | 'distanceM'> | null | undefined,
  measures: Measures,
  units: UnitPreferences
): HintFields {
  if (!hint) return { weight: null, reps: null, time: null, distance: null };
  return {
    weight:
      hasMeasure(measures, 'load') && hint.weightKg != null
        ? String(displayWeight(hint.weightKg, units))
        : null,
    reps: hasMeasure(measures, 'reps') && hint.reps != null ? String(hint.reps) : null,
    time:
      hasMeasure(measures, 'time') && hint.durationSec != null
        ? secondsToClock(hint.durationSec)
        : null,
    distance:
      hasMeasure(measures, 'distance') && hint.distanceM != null
        ? String(displayDistance(hint.distanceM, units))
        : null,
  };
}

/** Does the row carry anything in the columns its movement draws? */
export function rowHasValue(
  set: Pick<DraftSet, 'weight' | 'reps' | 'time' | 'distance'>,
  measures: Measures
): boolean {
  return (
    (hasMeasure(measures, 'load') && set.weight.trim() !== '') ||
    (hasMeasure(measures, 'reps') && set.reps.trim() !== '') ||
    (hasMeasure(measures, 'time') && set.time.trim() !== '') ||
    (hasMeasure(measures, 'distance') && set.distance.trim() !== '')
  );
}

/**
 * What a ✓ writes on top of the row as typed. Every EMPTY field the hint has a
 * figure for takes it; a typed field is never overwritten. A load taken from
 * the hint also records the exact kilograms it was drawn from
 * (`storedWeightKg`, the mechanism the editor already uses), so a held
 * 61.235 kg is logged as 61.235 kg rather than as its rounded display.
 *
 * `null` is the refusal: after filling, the row would still be empty — there
 * was nothing typed and nothing to offer. The screen says so instead of
 * saving a set with no numbers in it.
 */
export function tickPatch(
  set: DraftSet,
  hint: SetHint | null,
  measures: Measures,
  units: UnitPreferences
): Partial<DraftSet> | null {
  const fields = hintFields(hint, measures, units);
  const patch: Partial<DraftSet> = {};
  if (set.weight.trim() === '' && fields.weight != null && hint?.weightKg != null) {
    patch.weight = fields.weight;
    patch.storedWeightKg = hint.weightKg;
    patch.storedWeightText = fields.weight;
  }
  if (set.reps.trim() === '' && fields.reps != null) patch.reps = fields.reps;
  if (set.time.trim() === '' && fields.time != null) patch.time = fields.time;
  if (set.distance.trim() === '' && fields.distance != null) patch.distance = fields.distance;
  return rowHasValue({ ...set, ...patch }, measures) ? patch : null;
}

/**
 * Tap Prev (67): last time's numbers for this row, copied in whole — every
 * column the movement draws, overwriting what was typed, because that is what
 * "fill in what I did last time" means. A column last time left empty (a
 * bodyweight dip's load) is emptied too, so the row reads exactly as it did.
 * RPE and the set type are left alone. Null when there is no last time.
 */
export function prevPatch(
  prev: PrevSet | undefined,
  measures: Measures,
  units: UnitPreferences
): Partial<DraftSet> | null {
  if (!prev || !lastOf(prev)) return null;
  const fields = hintFields(prev, measures, units);
  const patch: Partial<DraftSet> = {};
  if (hasMeasure(measures, 'load')) {
    patch.weight = fields.weight ?? '';
    patch.storedWeightKg = prev.weightKg;
    patch.storedWeightText = fields.weight ?? '';
  }
  if (hasMeasure(measures, 'reps')) patch.reps = fields.reps ?? '';
  if (hasMeasure(measures, 'time')) patch.time = fields.time ?? '';
  if (hasMeasure(measures, 'distance')) patch.distance = fields.distance ?? '';
  return patch;
}

/** Spoken form of a row's last-time numbers, for the Prev button's label. */
export function prevSpoken(
  prev: PrevSet | undefined,
  measures: Measures,
  units: UnitPreferences
): string | null {
  if (!lastOf(prev)) return null;
  const f = hintFields(prev, measures, units);
  const unit = weightSpec(units).unit;
  const parts: string[] = [];
  if (f.reps != null) parts.push(`${f.reps} ${f.reps === '1' ? 'rep' : 'reps'}`);
  if (f.weight != null) parts.push(`${f.weight} ${unit}`);
  if (f.time != null) parts.push(f.time);
  if (f.distance != null) parts.push(`${f.distance} ${units.distance}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

// ---------------------------------------------------------------------------
// Delete a set, and put it back
// ---------------------------------------------------------------------------

/** One set taken out of a block, and what putting it back exactly needs. */
export type SetRemoval = {
  blockKey: number;
  /** Where it stood among the block's sets. */
  index: number;
  set: DraftSet;
  /** The block's set keys the removal left, in order. */
  left: number[];
  /** The movement's name and the set's number as it read, for the row. */
  name: string;
  number: number;
  /** "8 × 135 lb" — the figures as typed, or null for an empty row. */
  figure: string | null;
};

/** "8 × 135 lb", "1:30", "5 km" — a typed row's figures, for the Undo row. */
export function setFigure(
  set: Pick<DraftSet, 'weight' | 'reps' | 'time' | 'distance'>,
  measures: Measures,
  units: UnitPreferences
): string | null {
  const unit = weightSpec(units).unit;
  const reps = hasMeasure(measures, 'reps') ? set.reps.trim() : '';
  const weight = hasMeasure(measures, 'load') ? set.weight.trim() : '';
  const parts: string[] = [];
  if (reps !== '' && weight !== '') parts.push(`${reps} × ${weight} ${unit}`);
  else if (reps !== '') parts.push(`${reps} ${reps === '1' ? 'rep' : 'reps'}`);
  else if (weight !== '') parts.push(`${weight} ${unit}`);
  if (hasMeasure(measures, 'time') && set.time.trim() !== '') parts.push(set.time.trim());
  if (hasMeasure(measures, 'distance') && set.distance.trim() !== '') {
    parts.push(`${set.distance.trim()} ${units.distance}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Take one set out. A key that names nothing removes nothing and returns
 * `removed: null`, so the screen keeps whatever offer it had.
 */
export function removeSetWithUndo(
  blocks: DraftBlock[],
  blockKey: number,
  setKey: number,
  units: UnitPreferences
): { blocks: DraftBlock[]; removed: SetRemoval | null } {
  const block = blocks.find((b) => b.key === blockKey);
  const index = block ? block.sets.findIndex((s) => s.key === setKey) : -1;
  const set = block?.sets[index];
  if (!block || !set) return { blocks, removed: null };
  const sets = block.sets.filter((s) => s.key !== setKey);
  return {
    blocks: blocks.map((b) => (b.key === blockKey ? { ...b, sets } : b)),
    removed: {
      blockKey,
      index,
      set,
      left: sets.map((s) => s.key),
      name: block.name,
      number: index + 1,
      figure: setFigure(set, block.measures, units),
    },
  };
}

/** Whether putting the set back would still be exact (see the header). */
export function setUndoStands(blocks: DraftBlock[], removed: SetRemoval | null): boolean {
  if (!removed) return false;
  const block = blocks.find((b) => b.key === removed.blockKey);
  return (
    block !== undefined &&
    block.sets.length === removed.left.length &&
    block.sets.every((s, i) => s.key === removed.left[i])
  );
}

/** Undo: the set back where it stood. A removal that no longer stands changes nothing. */
export function undoSetRemoval(blocks: DraftBlock[], removed: SetRemoval | null): DraftBlock[] {
  if (!removed || !setUndoStands(blocks, removed)) return blocks;
  return blocks.map((b) => {
    if (b.key !== removed.blockKey) return b;
    const sets = [...b.sets];
    sets.splice(removed.index, 0, removed.set);
    return { ...b, sets };
  });
}

/** What the Undo row says: "Removed set 3 of Bench Press · 8 × 135 lb". */
export function setRemovalWords(removed: SetRemoval): UndoWords {
  return {
    icon: 'barbell-outline',
    said: `Removed set ${removed.number} of ${removed.name}`,
    figure: removed.figure,
    spoken: `Undo removing set ${removed.number} of ${removed.name}`,
  };
}

/**
 * Ask every done set of one movement again, in session order, against the
 * done sets BEFORE it — the order the stamps were first earned in, since a set
 * is ticked after the ones above it. Run when a done set leaves or comes back:
 * a stamp is a claim about the session's other sets, so the set that held the
 * session's best going away can hand a stamp to the one after it, and coming
 * back takes it again. Sets not done carry no stamp. `ask` is the screen's
 * `stampFor` call, given only the earlier sets as the session.
 */
export function restampMovement(
  blocks: DraftBlock[],
  exerciseId: string | null,
  ask: (session: readonly TypedBlock[], block: DraftBlock, set: DraftSet) => RecordKind[]
): DraftBlock[] {
  if (exerciseId == null) return blocks;
  const seen: DraftSet[] = [];
  return blocks.map((b) => {
    if (b.exerciseId !== exerciseId) return b;
    const sets = b.sets.map((s) => {
      if (!s.done) return s.pr || s.prKinds ? { ...s, pr: false, prKinds: undefined } : s;
      const kinds = ask([{ exerciseId, sets: [...seen] }], b, s);
      seen.push(s);
      return { ...s, pr: kinds.length > 0, prKinds: kinds.length > 0 ? kinds : undefined };
    });
    return { ...b, sets };
  });
}
