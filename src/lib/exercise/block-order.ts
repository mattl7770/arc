/**
 * The order of a session's exercise blocks, and the superset binds that ride on
 * that order — pure, so db/exercise.test.mjs can pin it without a component.
 *
 * Owner, on the device, 2026-09-23: *"be able to reorder exercises in a
 * workout."* The live logger and the logged-session editor are one screen
 * (app/workout-live.tsx), and both hold a session as an ordered list of blocks.
 * There is no separate order column to maintain: the list IS the order. The
 * draft (0045) serialises the array as it stands, and Finish / Save writes the
 * sets in block order, so `workout_sets.set_index` 1..n follows whatever order
 * the blocks were left in (`replaceWorkout` re-inserts in the order it is
 * given). A reorder therefore needs no migration and no new field.
 *
 * ## A superset moves as one
 *
 * A superset is not a tag on two blocks — it is `linkedToNext` on the upper one,
 * meaning "bound to whatever sits below me". Moving a single member of a
 * superset past its partner would therefore either silently re-bind it to a
 * stranger or silently split the pair, and neither is a thing the owner asked
 * for by pressing an arrow. So the unit of movement is the SEGMENT: a maximal
 * run of bound blocks, or one unbound block. A segment steps past the whole
 * neighbouring segment, never into the middle of it. To move one exercise out
 * of a superset, the owner splits it at the seam first — the control that
 * already exists for exactly that.
 *
 * The watch pairing (0054) is untouched by any of this: it links the SESSION to
 * a HealthKit record, not a block, and the session's id does not change when its
 * sets are rewritten.
 */

/** Anything with a render identity and the bind to the block below it. */
export type Bindable = { key: number; linkedToNext: boolean };

/**
 * Superset group numbers derived from the linked-to-next flags: a maximal run of
 * blocks chained by `linkedToNext` shares one 1-based group id; ungrouped blocks
 * map to null. Pure function of block order + flags (recomputed on save/render),
 * so unlinking is just toggling one boolean.
 *
 * Moved here from app/workout-live.tsx on 2026-09-23 so the order helpers below
 * and the group numbers Finish writes are tested as one contract.
 */
export function supersetGroups(blocks: readonly { linkedToNext: boolean }[]): (number | null)[] {
  const groups: (number | null)[] = blocks.map(() => null);
  let next = 1;
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i]!.linkedToNext && i + 1 < blocks.length) {
      const start = i;
      while (i + 1 < blocks.length && blocks[i]!.linkedToNext) i++;
      for (let j = start; j <= i; j++) groups[j] = next;
      next++;
    }
    i++;
  }
  return groups;
}

/** One movable unit: the inclusive index range of a superset, or of one block. */
export type BlockSegment = { start: number; end: number };

/**
 * The session cut into its movable units, top to bottom.
 *
 * The LAST block's `linkedToNext` binds to nothing, so it never extends a
 * segment — a flag left dangling by an earlier edit must not be read as a bind
 * to whatever happens to be moved in beneath it.
 */
export function blockSegments(blocks: readonly { linkedToNext: boolean }[]): BlockSegment[] {
  const segments: BlockSegment[] = [];
  let i = 0;
  while (i < blocks.length) {
    const start = i;
    while (i + 1 < blocks.length && blocks[i]!.linkedToNext) i++;
    segments.push({ start, end: i });
    i++;
  }
  return segments;
}

/**
 * Re-flatten segments, clearing the bind on the last block of each.
 *
 * Inside a segment the binds are left exactly as they were — that is what makes
 * the pair survive the move. The last block of a segment was not bound onward
 * before the move (or its bind dangled off the end of the session), and after
 * the move it has a new neighbour; leaving a stale `true` there would bind the
 * two without anyone asking. An object is only copied when its flag changes.
 */
function settle<T extends Bindable>(pieces: T[][]): T[] {
  const out: T[] = [];
  for (const piece of pieces) {
    piece.forEach((block, i) => {
      const last = i === piece.length - 1;
      out.push(last && block.linkedToNext ? { ...block, linkedToNext: false } : block);
    });
  }
  return out;
}

/**
 * Move the segment holding block `key` one segment up (`-1`) or down (`1`).
 *
 * Returns the new order, or `null` when the segment is already at that end (or
 * the key names nothing) — the caller draws that arrow disabled rather than
 * letting a press do nothing.
 */
export function moveBlockSegment<T extends Bindable>(
  blocks: readonly T[],
  key: number,
  direction: -1 | 1
): T[] | null {
  const index = blocks.findIndex((b) => b.key === key);
  if (index === -1) return null;
  const segments = blockSegments(blocks);
  const from = segments.findIndex((s) => index >= s.start && index <= s.end);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= segments.length) return null;
  const pieces = segments.map((s) => blocks.slice(s.start, s.end + 1));
  const moving = pieces[from]!;
  pieces[from] = pieces[to]!;
  pieces[to] = moving;
  return settle(pieces);
}

/**
 * Remove one block without inventing a superset.
 *
 * `linkedToNext` on the block above means "bound to the block below". Remove
 * the block below and the flag, left alone, now binds the block above to
 * whatever comes next — two exercises the owner never supersetted, fused on
 * screen and written with one `superset_group`. So the bind above survives only
 * when the removed block was itself bound onward (A+B+C minus B is still one
 * superset, A+C); otherwise it is cleared.
 */
export function removeBlockKeepingBinds<T extends Bindable>(
  blocks: readonly T[],
  key: number
): T[] {
  const i = blocks.findIndex((b) => b.key === key);
  if (i === -1) return blocks.slice();
  const removed = blocks[i]!;
  const boundOnward = removed.linkedToNext && i + 1 < blocks.length;
  const next = blocks.filter((_, j) => j !== i);
  const above = next[i - 1];
  if (above && above.linkedToNext && !boundOnward) {
    next[i - 1] = { ...above, linkedToNext: false };
  }
  return next;
}

/** What {@link storedBlockRuns} needs from a stored set. */
export type StoredSetRef = {
  exerciseId: string | null;
  /** The display name — what a free-text set (null id) is grouped on. */
  exercise: string;
  supersetGroup: number | null;
};

/** One block as read back from stored sets: a run, and its bind to the next. */
export type StoredRun<T extends StoredSetRef> = {
  exerciseId: string | null;
  name: string;
  supersetGroup: number | null;
  linkedToNext: boolean;
  sets: T[];
};

/**
 * A stored session's flat set list, cut back into the editor's blocks — the
 * inverse of what Finish / Save write (sets in block order, each carrying its
 * block's `supersetGroup`).
 *
 * **A run continues only on the same movement AND the same group.** Grouping on
 * the movement alone (as the editor did until 2026-09-23) merged a lone block
 * into a superset that began with the same movement: Bench, then Bench + Row,
 * stored as `bench(–) bench(1) row(1)`, reopened as one Bench block — and the
 * bind, read from the FIRST group seen for Bench (none), vanished with it. The
 * next Save then wrote every group as NULL. A reorder makes that order easy to
 * reach, which is how it was found.
 *
 * **The bind comes from each run's own group**, not from a per-movement map:
 * two neighbouring runs are one superset exactly when they carry the same
 * non-null group. That also restores a bind on a free-text block, which Save
 * has always written a group for and the old map never read back.
 *
 * Two runs of the same movement with the same group (or both ungrouped) still
 * merge into one block when they are neighbours; nothing is lost, since the
 * block writes every set back with the same group.
 */
export function storedBlockRuns<T extends StoredSetRef>(sets: readonly T[]): StoredRun<T>[] {
  const runs: StoredRun<T>[] = [];
  for (const s of sets) {
    const group = s.supersetGroup ?? null;
    const last = runs[runs.length - 1];
    const sameMovement =
      last != null &&
      (s.exerciseId == null
        ? last.exerciseId == null && last.name === s.exercise
        : last.exerciseId === s.exerciseId);
    if (last != null && sameMovement && last.supersetGroup === group) {
      last.sets.push(s);
      continue;
    }
    runs.push({
      exerciseId: s.exerciseId,
      name: s.exercise,
      supersetGroup: group,
      linkedToNext: false,
      sets: [s],
    });
  }
  for (let i = 0; i < runs.length - 1; i++) {
    const group = runs[i]!.supersetGroup;
    if (group != null && group === runs[i + 1]!.supersetGroup) runs[i]!.linkedToNext = true;
  }
  return runs;
}
