import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ZoomIn } from 'react-native-reanimated';

import { DurationField } from '@/components/exercise/duration-field';
import { ExercisePicker } from '@/components/exercise/exercise-picker';
import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { getExercise } from '@/lib/db/repositories/exercise-catalog';
import {
  deleteWorkout,
  getWorkoutDetail,
  logWorkout,
  replaceWorkout,
} from '@/lib/db/repositories/exercise';
import { getRoutine, touchRoutineStarted } from '@/lib/db/repositories/routines';
import {
  clearWorkoutDraft,
  readWorkoutDraft,
  saveWorkoutDraft,
} from '@/lib/db/repositories/workout-drafts';
import {
  lastSessionSets,
  personalRecords,
  type PrevSet,
} from '@/lib/db/repositories/training-stats';
import { deviceLabel } from '@/lib/db/repositories/wearables';
import {
  getIngestedWorkout,
  linkIngestedWorkout,
  pairIngestedWorkouts,
  unlinkIngestedWorkout,
} from '@/lib/db/repositories/workout-ingest';
import { secondsToClock } from '@/lib/exercise/clock-entry';
import { restSecFor } from '@/lib/exercise/constants';
import {
  DRAFT_VERSION,
  draftBlocksHaveData,
  liveDraftHasData,
  parseLiveDraft,
  type DraftBlock as LiveBlock,
  type DraftSet as LiveSet,
  type LiveDraft,
} from '@/lib/exercise/draft';
import { e1rmForSet } from '@/lib/exercise/e1rm';
import {
  dayLabel,
  displayDistance,
  displayWeight,
  formatClock,
  ingestDetail,
  parseClock,
  setTypeTag,
  toCanonicalKg,
  toCanonicalMetres,
  weightSpec,
} from '@/lib/exercise/format';
import {
  DEFAULT_MEASURES,
  hasMeasure,
  isLoadedRepsMeasures,
  type Measures,
} from '@/lib/exercise/measures';
import type { PairedIngest, SetType, WorkoutDetail } from '@/lib/exercise/types';
import { cancelRestAlert, scheduleRestAlert } from '@/lib/notifications/rest-timer';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * The structured live workout logger (docs/exercise-subapp.md §2), pushed from
 * the Exercise hub — the FitBod/Hevy-style set grid. Exercise blocks; each set
 * row shows the previous session's numbers as placeholders, a mono
 * weight/reps/RPE entry, and a completion stamp that starts the rest timer and
 * marks a PR when the set beats the best e1RM to date. Weight is entered in the
 * user's unit and stored canonical kg. The free-form quick logger
 * (app/workout-log.tsx) stays for cardio / mobility / past sessions.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Session name    —      recessed stock, styled inline (an input is not a block)
 *   Deload notice   margin advisory prose, annotated in the margin
 *   Each exercise   plate  **the set table** — the most literal "a record is a
 *                          table" surface in the app, so it is ruled: a title
 *                          line, a header rule, then one ruled line per set.
 *
 * Every set/rep/weight/RPE value is mono without exception — "serif speaks,
 * mono measures". Column headers and tags are the label voice; the exercise
 * name is the serif voice.
 *
 * **Accent budget: one primary action (Finish workout) plus the completion
 * stamps.** A completed set is chrome, not biology, so the stamp is the accent
 * and never a signal green — signal colours mark biological state only, and
 * that firewall was a finding in all six hostile reviews.
 *
 * ## The away-gym flag (C13, migration 0055)
 *
 * One quiet chip beside the clock, off on every new session and never
 * remembered. On, the session is real training and unreal measurement: it tags
 * no PR here, sets none in `personalRecords`, steers no progression and seeds
 * no prefill, while freshness and weekly volume count it exactly as before —
 * they never read a weight. It stays on the e1RM chart, marked. The flag rides
 * the draft (`DRAFT_VERSION` 3) and is editable afterwards on a stored session,
 * which costs nothing because none of those reads is cached.
 *
 * ## Nothing typed here can be lost (owner, 2026-09-14)
 *
 * *"losing workout information when closing app mid workout, necessary for
 * fixing when app bugs."* Every change to the session — a rep typed, a set
 * stamped, an exercise added, a superset bound — is written through to
 * `workout_drafts` (0045) as it happens, so an iOS memory kill, a crash or a
 * bad build costs nothing. The hub offers **Resume session**, which reopens
 * this screen with `resume=1` and restores the blocks, every field as typed,
 * the elapsed clock (from the original start instant, not from zero) and a rest
 * timer that is still running.
 *
 * The draft is NOT a workout row: it lives in its own table precisely so that
 * an unfinished session cannot reach freshness, weekly volume, PRs, the Coach's
 * training reads or the export — there is no flag for a future query to forget.
 * It becomes a workout at one moment, `finish()`, and is deleted in the same
 * breath. Discarding deletes it and leaves nothing behind. See 0045's header.
 *
 * Two things deliberately do not survive: an EDIT of a stored session (it
 * already has a saved copy, so nothing unrecorded is at risk — `editing` writes
 * no draft at all), and the OS rest ALERT, which was scheduled with
 * expo-notifications before the kill and is still queued in iOS; re-arming it
 * on resume would fire it twice. The countdown itself is restored, because it
 * counts from a target instant.
 *
 * FLAG (native): the rest timer is foreground-only. Background delivery (a
 * notification at zero) needs expo-notifications, which is in the binary as
 * of the owner's 2026-08-25 EAS build — whether it actually alerts while the
 * app is closed is still the owner's to confirm. It counts from a target
 * instant, so it stays correct across backgrounding either way.
 */

const SET_TYPES: SetType[] = ['normal', 'warmup', 'failure', 'drop'];

/** Recessed stock for an inline entry field: an input well, without the device. */
const INPUT_WELL = 'justify-center border border-paper-deep bg-paper-dim px-1';

/**
 * The bind's spring — one settle, no wobble past the joint. Shared by every
 * block wrapper so linking, unlinking, and remove/reorder all move on the same
 * physics.
 */
const BIND_SPRING = LinearTransition.springify().damping(19).stiffness(210).mass(0.6);

/**
 * The seam chip — the stamp that lands where two plates fuse into one. It sits
 * astride the shared rule (absolutely positioned, centred), interrupting it the
 * way a section mark interrupts a ledger seam; the ZoomIn spring gives it the
 * one small overshoot of a press stamp. Tapping it splits the superset.
 */
function SupersetSeam({ onPress }: { onPress: () => void }) {
  return (
    <Animated.View
      entering={ZoomIn.springify().damping(14).stiffness(260).mass(0.5)}
      exiting={FadeOut.duration(110)}
      style={{ position: 'absolute', top: -11, alignSelf: 'center', zIndex: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Supersetted with the exercise above. Tap to split."
        onPress={onPress}
        hitSlop={10}
        className="flex-row items-center gap-1 border border-hairline bg-paper-hi px-2.5 py-0.5 active:opacity-60">
        <Ionicons name="link" size={11} color={palette.inkSecondary} />
        <Text className="font-label text-[9px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
          Superset
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/*
 * `LiveSet` / `LiveBlock` are src/lib/exercise/draft.ts's `DraftSet` /
 * `DraftBlock`, imported under this screen's own names. They moved there when
 * the session became PERSISTED (2026-09-14): the state this component holds is
 * now also the payload written to `workout_drafts`, so a contract with a future
 * build. One declaration means the thing rendered and the thing serialised
 * cannot drift apart. The field-level docs live with the types.
 */

/**
 * Superset group numbers derived from the linked-to-next flags: a maximal run of
 * blocks chained by `linkedToNext` shares one 1-based group id; ungrouped blocks
 * map to null. Pure function of block order + flags (recomputed on save/render),
 * so unlinking is just toggling one boolean.
 */
function supersetGroups(blocks: LiveBlock[]): (number | null)[] {
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

/**
 * The longest elapsed time still recorded as a session duration. Past it,
 * Finish stores no duration at all — see the clamp in `finish()`.
 */
const MAX_SESSION_MIN = 6 * 60;

/**
 * The columns one exercise block draws, from what its movement MEASURES (0046).
 *
 * This replaced a `WEIGHT_LOGGING` set of logging types, and the difference is
 * the whole of B1 on this screen: the old set answered "does this show a weight
 * field", the reps column was unconditional, and there was nowhere at all to
 * put a time or a distance — so a plank asked for reps and a run could not
 * record five kilometres.
 *
 * `prev` is the one column that yields. Set · Prev · RPE · stamp cost about
 * 210pt of a 375pt screen before any value column, which leaves a third
 * value column around 30pt wide — unusable. Nothing in the shipped catalog
 * measures three things (a carry is load + distance), so this is insurance
 * rather than a daily case; when it does happen, last session's numbers are the
 * least load-bearing thing on the row.
 */
function blockColumns(measures: Measures): {
  reps: boolean;
  load: boolean;
  time: boolean;
  distance: boolean;
  prev: boolean;
} {
  const cols = {
    reps: hasMeasure(measures, 'reps'),
    load: hasMeasure(measures, 'load'),
    time: hasMeasure(measures, 'time'),
    distance: hasMeasure(measures, 'distance'),
  };
  const count = Number(cols.reps) + Number(cols.load) + Number(cols.time) + Number(cols.distance);
  return { ...cols, prev: count <= 2 };
}

/**
 * Last session's numbers for this set, in sixteen points of width.
 *
 * It shows only what this block's own columns show, which is the point: a run's
 * Prev is "26:40" and not "—×—", and a plank's is "1:30". `12×135` keeps its
 * compact compound form because reps × load is one reading; the others are
 * single values and need no separator. Distance goes bare, without its unit —
 * the column header above already carries it, and the unit would not fit.
 */
function prevColumnText(
  prev: PrevSet | undefined,
  cols: ReturnType<typeof blockColumns>,
  units: UnitPreferences
): string {
  if (!prev) return '—';
  const parts: string[] = [];
  if (cols.reps || cols.load) {
    const reps = prev.reps ?? '—';
    const load = prev.weightKg != null ? `×${displayWeight(prev.weightKg, units)}` : '';
    if (cols.reps) parts.push(`${reps}${load}`);
    else if (prev.weightKg != null) parts.push(String(displayWeight(prev.weightKg, units)));
  }
  if (cols.time && prev.durationSec != null) parts.push(formatClock(prev.durationSec));
  if (cols.distance && prev.distanceM != null) {
    parts.push(String(displayDistance(prev.distanceM, units)));
  }
  return parts.length > 0 ? parts.join(' ') : '—';
}

let keySeq = 1;
const nextKey = () => keySeq++;

/**
 * Lift the key sequence past everything a restored draft carries.
 *
 * `keySeq` is module state and a resumed draft arrives with keys minted by a
 * process that no longer exists — possibly higher than this one has reached, if
 * the app restarted. Without this, the next set added would reuse a key a
 * restored row already has, and React would reconcile two different rows as
 * one: type into set 3, watch set 1 change.
 */
function adoptKeys(blocks: LiveBlock[]): void {
  for (const block of blocks) {
    keySeq = Math.max(keySeq, block.key + 1);
    for (const set of block.sets) keySeq = Math.max(keySeq, set.key + 1);
  }
}

function blankSet(from?: LiveSet): LiveSet {
  return {
    key: nextKey(),
    weight: from?.weight ?? '',
    reps: from?.reps ?? '',
    rpe: '',
    // Time and distance do NOT carry forward from the set above, where weight
    // and reps do. Straight sets repeat a load; nobody runs the same 5 km twice
    // in a session, and a copied "26:40" would be a number the user has to
    // notice and clear rather than one they were saved typing.
    time: '',
    distance: '',
    setType: 'normal',
    done: false,
    pr: false,
  };
}

/** Build a block for one exercise, reading its prev-session sets + PRs once. */
function buildBlock(
  exerciseId: string,
  targetSets: number,
  restSec: number | null
): LiveBlock | null {
  const db = getDb();
  const ex = getExercise(db, exerciseId);
  if (!ex) return null;
  const prev = lastSessionSets(db, exerciseId);
  const bestE1rm = personalRecords(db, exerciseId).bestE1rmKg;
  const count = Math.max(1, targetSets);
  return {
    key: nextKey(),
    exerciseId,
    name: ex.name,
    loggingType: ex.loggingType,
    measures: ex.measures,
    mechanic: ex.mechanic,
    restSec: restSec ?? restSecFor(ex.mechanic, null),
    prev,
    bestE1rm,
    linkedToNext: false,
    sets: Array.from({ length: count }, () => blankSet()),
  };
}

/**
 * A synthetic block for a set with no catalog movement — a free-text custom
 * movement (null exercise_id) or one whose catalog entry has since been deleted.
 * It carries the stored display name and keeps exerciseId null so Save re-stores
 * it as free text (insertSet's name backstop still runs). `weight_reps` /
 * `reps,load` is the safe default: it shows the weight and reps columns, and the
 * set's own numbers fill them. A free-text set has no catalog row to ask what it
 * measures, and reps × load is what one meant before 0046 — nothing that was
 * stored can be lost by showing both. No prev/PR — those are the live logger's,
 * unused when editing.
 */
function freeTextBlock(name: string): LiveBlock {
  return {
    key: nextKey(),
    exerciseId: null,
    name,
    loggingType: 'weight_reps',
    measures: DEFAULT_MEASURES,
    mechanic: null,
    restSec: null,
    prev: [],
    bestE1rm: null,
    linkedToNext: false,
    sets: [],
  };
}

/**
 * Rebuild the editor's blocks from a session already in the database — the
 * whole of "view and edit a past workout" (owner, 2026-08-14).
 *
 * Stored sets are a flat, ordered list; the editor's shape is one block per
 * exercise. They regroup on a RUN of consecutive sets, not on the exercise id,
 * so a session that went bench → row → bench comes back as three blocks in that
 * order rather than two with the order destroyed. That matters because the
 * order is the only record of how the session was actually performed, and a
 * superset is exactly an interleave.
 *
 * Every set comes back `done` — it happened — and carries no PR flag: PRs are
 * awarded live, against the best e1RM *before* the session, and re-awarding
 * them while editing a two-week-old workout would be a stamp about the wrong
 * moment. A set that was always free text (a custom movement the logger never
 * resolved) — or whose catalog movement has since been deleted (buildBlock
 * null) — comes back as a {@link freeTextBlock} carrying its stored name, so it
 * survives a Save instead of being silently erased by replaceWorkout's
 * DELETE-then-reinsert; the `prev`/`bestE1rm` lookups are the live logger's and
 * are simply unused here.
 */
function blocksFromWorkout(detail: WorkoutDetail, units: UnitPreferences): LiveBlock[] {
  const blocks: LiveBlock[] = [];
  for (const s of detail.sets) {
    const last = blocks[blocks.length - 1];
    // A set continues the last block when it is the same catalog movement, or —
    // for a free-text set (null exercise_id) — the same free-text name. Grouping
    // on a RUN, not on identity, keeps the performed order (bench → sled push →
    // bench comes back as three blocks, not the free-text set dropped and the
    // two benches merged).
    const continues =
      last != null &&
      (s.exerciseId == null
        ? last.exerciseId == null && last.name === s.exercise
        : last.exerciseId === s.exerciseId);
    if (!continues) {
      // A matched movement builds a real block; a free-text set — or one whose
      // catalog movement has been deleted (buildBlock null) — becomes a
      // synthetic free-text block, so the editor can show it and Save preserves
      // it rather than dropping it on the next write.
      const built = s.exerciseId == null ? null : buildBlock(s.exerciseId, 0, null);
      const block = built ?? freeTextBlock(s.exercise);
      block.sets = [];
      block.linkedToNext = false;
      blocks.push(block);
    }
    const block = blocks[blocks.length - 1]!;
    const weightText = s.weightKg == null ? '' : String(displayWeight(s.weightKg, units));
    block.sets.push({
      key: nextKey(),
      weight: weightText,
      reps: s.reps == null ? '' : String(s.reps),
      rpe: s.rpe == null ? '' : String(s.rpe),
      // The clock field's own normal form (h:mm:ss from the hour), so a stored
      // set opens as its digits and a focus-and-blur leaves it untouched.
      time: s.durationSec == null ? '' : secondsToClock(s.durationSec),
      distance: s.distanceM == null ? '' : String(displayDistance(s.distanceM, units)),
      setType: s.setType,
      done: true,
      pr: false,
      storedWeightKg: s.weightKg,
      storedWeightText: weightText,
    });
  }
  // Restore the superset bind: two adjacent blocks whose sets shared a group id
  // were one object, and the editor draws them fused again. Free-text blocks
  // have no exercise_id and never carried a group, so they simply never link.
  const groupOf = new Map<string, number | null>();
  for (const s of detail.sets) {
    if (s.exerciseId != null && !groupOf.has(s.exerciseId)) {
      groupOf.set(s.exerciseId, s.supersetGroup);
    }
  }
  for (let i = 0; i < blocks.length - 1; i++) {
    const eidA = blocks[i]!.exerciseId;
    const eidB = blocks[i + 1]!.exerciseId;
    if (eidA == null || eidB == null) continue;
    const a = groupOf.get(eidA);
    const b = groupOf.get(eidB);
    if (a != null && a === b) blocks[i]!.linkedToNext = true;
  }
  return blocks.filter((b) => b.sets.length > 0);
}

/**
 * The draft this screen would resume, or null — read once, on the way in.
 *
 * A draft with no data is not offered and not kept: blocks loaded from a saved
 * workout and then walked away from are reproducible by starting that workout
 * again, and a Resume that restores nothing typed is a Resume that wasted a
 * tap. `liveDraftHasData` is the same test the hub's card uses, so the two can
 * never disagree about whether there is a session to come back to.
 */
function readResumableDraft(): LiveDraft | null {
  const stored = readWorkoutDraft(getDb(), 'live');
  if (!stored) return null;
  const draft = parseLiveDraft(stored.value);
  return draft && liveDraftHasData(draft) ? draft : null;
}

/**
 * Initial blocks: from a RESUMED draft (everything as it was typed), else from
 * a session already logged (view/edit), else from a saved workout (targets +
 * rest per line), else from an explicit exercise-id list (the hub's
 * freshest-muscle recommendation), else empty (a blank sheet — add exercises as
 * you go).
 */
function initialBlocks(
  draft: LiveDraft | null,
  workout: WorkoutDetail | undefined,
  routineId: string | undefined,
  exerciseIds: string[],
  units: UnitPreferences
): LiveBlock[] {
  if (draft) {
    adoptKeys(draft.blocks);
    return draft.blocks;
  }
  if (workout) return blocksFromWorkout(workout, units);
  if (routineId) {
    const routine = getRoutine(getDb(), routineId);
    if (routine) {
      return routine.exercises
        .map((line) => buildBlock(line.exerciseId, line.targetSets, line.restSec))
        .filter((b): b is LiveBlock => b !== null);
    }
  }
  return exerciseIds.map((id) => buildBlock(id, 3, null)).filter((b): b is LiveBlock => b !== null);
}

export default function WorkoutLiveScreen() {
  const params = useLocalSearchParams<{
    routineId?: string | string[];
    workoutId?: string | string[];
    exerciseIds?: string | string[];
    resume?: string | string[];
    ingestId?: string | string[];
  }>();
  const routineId = Array.isArray(params.routineId) ? params.routineId[0] : params.routineId;
  const workoutId = Array.isArray(params.workoutId) ? params.workoutId[0] : params.workoutId;
  const idsParam = Array.isArray(params.exerciseIds) ? params.exerciseIds[0] : params.exerciseIds;
  const exerciseIds = idsParam ? idsParam.split(',').filter(Boolean) : [];
  const resumeParam = Array.isArray(params.resume) ? params.resume[0] : params.resume;
  const ingestId = Array.isArray(params.ingestId) ? params.ingestId[0] : params.ingestId;
  return (
    <WorkoutLive
      routineId={routineId}
      workoutId={workoutId}
      exerciseIds={exerciseIds}
      resume={resumeParam === '1'}
      ingestId={ingestId}
    />
  );
}

function WorkoutLive({
  routineId,
  workoutId,
  exerciseIds,
  resume,
  ingestId,
}: {
  routineId?: string;
  workoutId?: string;
  exerciseIds: string[];
  /** Reopen the stored draft instead of starting a session (the hub's Resume). */
  resume: boolean;
  /**
   * `wearable_data.id` of a strength-coded session the watch recorded and ARC
   * refused to guess at (0054) — the hub's "From your watch" blank. The span is
   * already known, so this session is NOT timed: the owner is filling in the
   * sets for an hour that has already happened.
   */
  ingestId?: string;
}) {
  const router = useRouter();
  const navigation = useNavigation();
  const { units } = useUnitPreferences();
  const spec = useMemo(() => weightSpec(units), [units]);

  // The session being corrected, read once. `editing` is the whole mode switch:
  // no elapsed clock, no rest timer, "Save changes" instead of "Finish", and a
  // Delete. Read in the initializer because op-sqlite is synchronous, so there
  // is no loading state to render (the pattern of every hook in src/hooks).
  const [stored] = useState<WorkoutDetail | undefined>(() =>
    workoutId ? getWorkoutDetail(getDb(), workoutId) : undefined
  );
  const editing = stored != null;

  // The resumed draft, read once on mount. Only when asked (`resume=1`) and
  // never while editing — see the docblock: an edit has a saved copy, so it
  // keeps no draft, and reading one here could only mix two sessions.
  const [draft] = useState<LiveDraft | null>(() =>
    resume && !workoutId ? readResumableDraft() : null
  );

  // The watch's record of a session the owner is filling in (0054). Read once,
  // in the initializer, like `stored` — op-sqlite is synchronous, so there is no
  // loading state to render. An id that names nothing (the row aged out of the
  // re-sync window between the hub reading it and this screen opening) reads
  // null, and the screen is simply an ordinary new session.
  //
  // It falls back to the DRAFT's id for the same reason `routineId` does: iOS
  // can kill the app between tapping the blank and finishing the sets, and a
  // resumed fill that forgot which session it was filling would save as an
  // ordinary workout dated today — leaving the blank still asking and a second
  // session beside it.
  const [ingest] = useState(() => {
    const id = ingestId ?? draft?.ingestId ?? null;
    return id && !workoutId ? getIngestedWorkout(getDb(), id) : null;
  });
  /** Filling in a session the watch already measured: its span is a fact, not a clock to run. */
  const filling = ingest != null && !editing;

  // The paired watch record of a session being EDITED — a different join from
  // `ingest` above, which is the seeded-fill path.
  //
  // In STATE rather than read straight off `stored`, because since 2026-09-21
  // it is the one thing on this screen the owner can break: pairing now reaches
  // sessions with no start time, matching them on the day, and the tap that
  // says "these are not the same session" has to take the line with it.
  const [pairedWatch, setPairedWatch] = useState<PairedIngest | null>(
    () => stored?.ingested ?? null
  );
  // Two strings for the same reason the Train hub keeps two: whatever the label
  // says, VoiceOver speaks, and "avg 142 · max 171 bpm" read aloud is tokens
  // rather than a measurement.
  const storedWatch = pairedWatch ? ingestDetail(pairedWatch, units) : null;
  const storedWatchSpoken = pairedWatch ? ingestDetail(pairedWatch, units, { spoken: true }) : null;

  /**
   * Break the pair. ONE tap and no confirmation, unlike every other control on
   * this screen that removes something: nothing of the owner's goes. The sets
   * stay, the watch's own record stays on the Data tab, and what is discarded is
   * an inference ARC made — which is also why it must not come back on the next
   * sync, and does not (the refusal is recorded with the unlink).
   */
  const unpairWatch = () => {
    if (!workoutId) return;
    try {
      unlinkIngestedWorkout(getDb(), workoutId);
    } catch (error) {
      console.warn('[workout-live] unpair failed', error);
      return;
    }
    setPairedWatch(null);
  };

  // A resumed session keeps the instant it really started, so the elapsed clock
  // says how long this workout has been going, not how long the app has been
  // open again. Same for the routine it came from: Finish still stamps it used.
  const [startedAt] = useState(() => draft?.startedAt ?? Date.now());
  const draftRoutineId = draft?.routineId ?? routineId;
  const [now, setNow] = useState(startedAt);
  const [blocks, setBlocks] = useState<LiveBlock[]>(() =>
    initialBlocks(draft, stored, routineId, exerciseIds, units)
  );
  // Editing starts CLEAN. A past session is already full of data, so the live
  // logger's "anything typed means unsaved" test would prompt to discard on the
  // way out of a screen that was only ever read.
  const [dirty, setDirty] = useState(false);
  /**
   * The away-gym flag (0055), and the whole of "off by default, deliberately
   * not sticky".
   *
   * A RESUMED session gets back what it was set to; an EDIT of a past session
   * opens on what that session was stored as; anything else starts `false`. No
   * preference is read and none is written, and that asymmetry is the argument:
   * forgetting to turn it ON costs one session's PR fidelity and can be fixed
   * afterwards on this same screen, where forgetting to turn it OFF at home
   * would silently kill PR detection indefinitely, with no symptom the owner
   * would ever notice.
   */
  const [away, setAway] = useState<boolean>(() => draft?.away ?? stored?.away ?? false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // A resumed rest timer counts from its stored target instant; one that ran out
  // while the app was away is simply over, so it comes back as null rather than
  // as a countdown showing zero.
  const [restEndsAt, setRestEndsAt] = useState<number | null>(() =>
    draft?.restEndsAt != null && draft.restEndsAt > Date.now() ? draft.restEndsAt : null
  );
  // The id of the pending OS rest-alert (to cancel/replace it). null when none.
  const restNotifId = useRef<string | null>(null);
  // A monotonic token that serialises the async schedule: only the latest arm
  // keeps its id. scheduleRestAlert resolves after a tick, so two rapid arms (or
  // an arm then unmount) would otherwise leak the earlier alert — its id lands
  // in the .then after the cancel already ran against a null ref. An id that
  // resolves under a stale token is cancelled on arrival instead. Latent until
  // expo-notifications ships.
  const restSeq = useRef(0);
  const savedRef = useRef(false);

  /** Arm a fresh OS rest alert `seconds` out, cancelling any pending one. */
  const armRestAlert = (seconds: number) => {
    void cancelRestAlert(restNotifId.current);
    restNotifId.current = null;
    const seq = ++restSeq.current;
    void scheduleRestAlert(seconds).then((id) => {
      if (seq === restSeq.current) {
        restNotifId.current = id;
      } else if (id) {
        // A newer arm (or teardown) superseded this schedule before it resolved
        // — cancel the just-returned id rather than leave it pending.
        void cancelRestAlert(id);
      }
    });
  };
  const disarmRestAlert = () => {
    restSeq.current++;
    void cancelRestAlert(restNotifId.current);
    restNotifId.current = null;
  };

  // One-second tick drives the elapsed clock + rest countdown (same pattern as
  // app/workout-log.tsx). Foreground only; both are computed from timestamps, so
  // they stay correct across a background/foreground cycle.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const restRemaining =
    restEndsAt == null ? null : Math.max(0, Math.round((restEndsAt - now) / 1000));

  // The same test the draft store and the hub's Resume card use — one function,
  // so "is there anything here" cannot mean three different things across the
  // write-through, the discard prompt and the offer to resume.
  const hasData = draftBlocksHaveData(blocks);
  // Every entered value must fit the schema's own bound (0003_exercise.sql:
  // weight_kg >= 0 AND weight_kg < 1000). A single over-limit set throws that
  // CHECK inside finish()'s one transaction, rolling the WHOLE session back
  // with an opaque "Save failed" that names no cause — so block Finish and name
  // the movement instead. A non-numeric value is not flagged: it stores as null
  // (bodyweight), exactly as finish() already treats it.
  //
  // 0046 put two more CHECK'd columns on the same row (`duration_sec < 36000`,
  // `distance_m < 1000000`), and they fail the same way — so the guard covers
  // all three rather than leaving two of them to discover the rollback.
  const overLimitBlock = blocks.find((b) =>
    b.sets.some((s) => {
      if (s.weight.trim() !== '') {
        const kg = toCanonicalKg(Number(s.weight), units);
        if (Number.isFinite(kg) && (kg < 0 || kg >= 1000)) return true;
      }
      const seconds = parseClock(s.time);
      if (seconds != null && seconds >= 36000) return true;
      if (s.distance.trim() !== '') {
        const metres = toCanonicalMetres(Number(s.distance), units);
        if (Number.isFinite(metres) && (metres < 0 || metres >= 1_000_000)) return true;
      }
      return false;
    })
  );
  const weightProblem = overLimitBlock
    ? `A value on ${overLimitBlock.name} won’t save — it’s past the logger’s limit.`
    : null;
  // A session no longer needs a name to be finishable — workouts have no names
  // (owner, 2026-08-14). Sets are the whole requirement. When editing, an empty
  // session is still savable: deleting every set is how you correct a workout
  // that never happened, and the confirm below asks before it lands.
  const canFinish = (editing || hasData) && weightProblem == null;
  const unsaved = editing ? dirty : hasData;

  /** Drop the stored draft — on Finish, and on an explicit Discard. */
  const discardDraft = () => {
    try {
      clearWorkoutDraft(getDb(), 'live');
    } catch (error) {
      // Never let losing the draft lose the navigation with it.
      console.warn('[exercise] draft clear failed', error);
    }
  };

  /**
   * **The write-through.** Every edit to the session lands in `workout_drafts`
   * before the next render settles, which is the whole of surviving a kill: iOS
   * gives no warning it is about to reclaim the app, so there is no "save on
   * background" hook that can be trusted — the only safe moment to write is the
   * moment the value changes.
   *
   * It runs on `blocks` and `restEndsAt`, the two pieces of state that are the
   * session. The serialised payload is compared against the last one written,
   * so a re-render that changed nothing (the one-second clock tick, opening the
   * picker) does not touch the database.
   *
   * `hasData` gates existence both ways: the draft appears the moment something
   * is typed and DISAPPEARS when the last of it is deleted, so an emptied
   * session leaves no Resume card pointing at nothing. Editing writes no draft
   * at all.
   */
  const lastWrittenRef = useRef<string | null>(null);
  useEffect(() => {
    if (editing || savedRef.current) return;
    try {
      if (!hasData) {
        if (lastWrittenRef.current !== null) {
          lastWrittenRef.current = null;
          clearWorkoutDraft(getDb(), 'live');
        }
        return;
      }
      const payload: LiveDraft = {
        version: DRAFT_VERSION,
        startedAt,
        routineId: draftRoutineId ?? null,
        ingestId: ingest?.id ?? null,
        restEndsAt,
        away,
        blocks,
      };
      const serialised = JSON.stringify(payload);
      if (serialised === lastWrittenRef.current) return;
      lastWrittenRef.current = serialised;
      saveWorkoutDraft(getDb(), 'live', payload);
    } catch (error) {
      // A failed draft write must never break the logger the user is standing
      // in — the session is still on screen and Finish still saves it.
      console.warn('[exercise] draft write failed', error);
    }
  }, [blocks, restEndsAt, away, hasData, editing, startedAt, draftRoutineId, ingest]);

  // Guard an accidental back from vaporising unsaved work.
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (savedRef.current || !unsaved) return;
      e.preventDefault();
      Alert.alert(
        editing ? 'Discard these changes?' : 'Discard this workout?',
        editing
          ? 'The session stays as it was.'
          : 'It has not been saved to your training history. Discarding deletes the sets you have typed.',
        [
          { text: editing ? 'Keep editing' : 'Keep logging', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              // Discard means discard: the stored draft goes too, or the hub
              // would offer to resume a session the user just threw away.
              if (!editing) {
                savedRef.current = true; // stop the write-through re-creating it
                discardDraft();
              }
              navigation.dispatch(e.data.action);
            },
          },
        ]
      );
    });
    return unsub;
  }, [navigation, unsaved, editing]);

  const patchSet = (blockKey: number, setKey: number, patch: Partial<Omit<LiveSet, 'key'>>) => {
    setDirty(true);
    setBlocks((prev) =>
      prev.map((b) =>
        b.key !== blockKey
          ? b
          : { ...b, sets: b.sets.map((s) => (s.key === setKey ? { ...s, ...patch } : s)) }
      )
    );
  };

  const addSet = (blockKey: number) => {
    setDirty(true);
    setBlocks((prev) =>
      prev.map((b) =>
        b.key !== blockKey ? b : { ...b, sets: [...b.sets, blankSet(b.sets[b.sets.length - 1])] }
      )
    );
  };

  const removeSet = (blockKey: number, setKey: number) => {
    setDirty(true);
    setBlocks((prev) =>
      prev.map((b) =>
        b.key !== blockKey ? b : { ...b, sets: b.sets.filter((s) => s.key !== setKey) }
      )
    );
  };

  const cycleSetType = (blockKey: number, setKey: number, current: SetType) => {
    const next = SET_TYPES[(SET_TYPES.indexOf(current) + 1) % SET_TYPES.length]!;
    patchSet(blockKey, setKey, { setType: next });
  };

  const addExercise = (exerciseId: string) => {
    const block = buildBlock(exerciseId, 1, null);
    if (block) {
      setDirty(true);
      setBlocks((prev) => [...prev, block]);
    }
  };

  const removeBlock = (blockKey: number) => {
    setDirty(true);
    setBlocks((prev) => prev.filter((b) => b.key !== blockKey));
  };

  /**
   * Flip the away-gym flag (0055).
   *
   * Turning it ON clears every PR stamp already earned this session, because
   * the stamp is a claim the app has just stopped making: an away session sets
   * no record, and a "PR" tag left standing on one would contradict the line of
   * copy directly beneath the control. Turning it back off simply resumes
   * detection from the next completed set — nothing is restored, because a set
   * completed while the flag was on was never measured.
   */
  const toggleAway = () => {
    setDirty(true);
    setAway((prev) => {
      const next = !prev;
      if (next) {
        setBlocks((bs) =>
          bs.map((b) => ({ ...b, sets: b.sets.map((s) => ({ ...s, pr: false })) }))
        );
      }
      return next;
    });
  };

  /** Group / ungroup a block with the one below it into a superset. */
  const toggleLink = (blockKey: number) => {
    setDirty(true);
    setBlocks((prev) =>
      prev.map((b) => (b.key === blockKey ? { ...b, linkedToNext: !b.linkedToNext } : b))
    );
  };

  /** Toggle a set done; on completion start rest + tag a PR if it beats best e1RM. */
  const toggleDone = (block: LiveBlock, set: LiveSet) => {
    const done = !set.done;
    let pr = set.pr;
    // Editing a past session awards no PRs and starts no rest timer: both are
    // claims about right now, and this set happened days ago.
    // A PR here is an e1RM record, which only a set carrying BOTH a load and
    // its reps can hold (0046) — a plank can never set one, and asking is
    // cheaper than computing an e1RM that `countsForE1rm` would reject anyway.
    // An AWAY session tags none at all (0055), even when the numbers are the
    // best on record: `bestE1rm` is a bar every future session must clear, and
    // a friendlier machine raising it permanently is the false stall this whole
    // feature exists to prevent. The control's own copy says so, so it is never
    // a surprise. The stored side is `personalRecordsFrom`'s `baselineSets`.
    if (done && !editing && !away && isLoadedRepsMeasures(block.measures)) {
      const weightKg = set.weight.trim() === '' ? null : toCanonicalKg(Number(set.weight), units);
      const reps = set.reps.trim() === '' ? null : Number(set.reps);
      const rpe = set.rpe.trim() === '' ? null : Number(set.rpe);
      const e = e1rmForSet(weightKg, reps, rpe, set.setType);
      if (e != null && (block.bestE1rm == null || e > block.bestE1rm + 1e-6)) {
        pr = true;
        // Raise the bar so only the first record-crossing set this session tags.
        setBlocks((prev) => prev.map((b) => (b.key === block.key ? { ...b, bestE1rm: e } : b)));
      }
    }
    patchSet(block.key, set.key, { done, pr: done ? pr : false });
    if (done && !editing && block.restSec && block.restSec > 0) {
      setRestEndsAt(Date.now() + block.restSec * 1000);
      armRestAlert(block.restSec);
    }
  };

  const bumpRest = (delta: number) => {
    if (restEndsAt == null) return;
    const next = restEndsAt + delta * 1000;
    setRestEndsAt(next);
    armRestAlert(Math.max(1, Math.round((next - Date.now()) / 1000)));
  };

  const dismissRest = () => {
    setRestEndsAt(null);
    disarmRestAlert();
  };

  const finish = () => {
    if (savedRef.current || !canFinish) return;
    const groups = supersetGroups(blocks);
    const sets = blocks.flatMap((b, bi) =>
      b.sets
        .filter(
          (s) =>
            s.done ||
            s.reps.trim() !== '' ||
            s.weight.trim() !== '' ||
            s.time.trim() !== '' ||
            s.distance.trim() !== ''
        )
        .map((s) => {
          const reps = s.reps.trim() === '' ? null : Number(s.reps);
          const durationSec = parseClock(s.time);
          const distanceDisplay = s.distance.trim() === '' ? null : Number(s.distance);
          const distanceM =
            distanceDisplay != null && Number.isFinite(distanceDisplay)
              ? toCanonicalMetres(distanceDisplay, units)
              : null;
          // An untouched loaded weight writes back its exact stored kg rather
          // than re-deriving from the display string: displayWeight rounds to
          // the unit spec, so toCanonicalKg of that rounded string drifts off
          // the original whenever the stored kg didn't come from a round display
          // value (a kg-logged set edited in lb, say) — silently rewriting a set
          // the user never touched. Only a changed string re-converts.
          const weightKg =
            s.weight.trim() === ''
              ? null
              : s.storedWeightText != null && s.weight === s.storedWeightText
                ? (s.storedWeightKg ?? null)
                : toCanonicalKg(Number(s.weight), units);
          const rpe = s.rpe.trim() === '' ? null : Number(s.rpe);
          return {
            exercise: b.name,
            exerciseId: b.exerciseId,
            reps: reps != null && Number.isFinite(reps) ? Math.round(reps) : null,
            weightKg: weightKg != null && Number.isFinite(weightKg) ? weightKg : null,
            rpe: rpe != null && Number.isFinite(rpe) ? rpe : null,
            // Passed whatever the block draws; `insertSet` nulls anything the
            // movement does not measure, so the repository has the last word
            // (0046) and a stale field can never ride along.
            durationSec,
            distanceM,
            setType: s.setType,
            supersetGroup: groups[bi],
          };
        })
    );
    // Elapsed, clamped at zero (SQLite's clock and Date.now() can disagree by a
    // hair) and DISCARDED past six hours. A resumed draft carries the instant
    // the session really started, so a workout begun on Monday and finished
    // from the hub on Wednesday would otherwise record a 2,880-minute session —
    // a number no reader could tell from a real one. No duration is honest;
    // that one is not.
    const elapsedMin = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
    const durationMin = elapsedMin <= MAX_SESSION_MIN ? elapsedMin : 0;
    try {
      const db = getDb();
      if (stored) {
        // Correcting a past session: its date, kind and duration are facts
        // about that day and are left exactly as they were. Only the sets — the
        // thing the editor edits — and the away flag are rewritten. The flag is
        // free to change afterwards precisely because nothing derived from it
        // is stored: PRs are awarded live and never written, and every other
        // affected read is computed from the sets on demand.
        replaceWorkout(
          db,
          stored.id,
          { kind: stored.kind, durationMin: stored.durationMin, notes: stored.notes, away },
          sets
        );
      } else {
        // No name: workouts don't have them (owner, 2026-08-14). The column
        // takes '' from the repository and nothing renders it.
        //
        // **Filling in the watch's blank takes the WATCH's span, not the
        // clock.** The session happened this morning and is being typed up now,
        // so the elapsed timer would record however long the typing took. The
        // day, the duration and the start instant are all facts the watch
        // already measured; the sets are the only thing the owner is adding.
        const newId = logWorkout(
          db,
          {
            date: ingest ? ingest.date : todayISODate(),
            kind: 'strength',
            durationMin: ingest ? ingest.durationMin : durationMin > 0 ? durationMin : null,
            // A resumed session still belongs to the saved workout it started
            // from, so Finish stamps that workout used exactly as it would have
            // before the app closed.
            routineId: draftRoutineId ?? null,
            // 0054 — the span pairing matches on. A live session knows when it
            // began; a filled-in one takes the watch's own start. Null when the
            // duration was discarded as implausible, because a start with no
            // credible end is not a span.
            startedAt: ingest
              ? ingest.startTime
              : durationMin > 0
                ? new Date(startedAt).toISOString()
                : null,
            away,
          },
          sets
        );
        if (draftRoutineId) touchRoutineStarted(db, draftRoutineId, new Date().toISOString());
        if (ingest) {
          // An assertion, not an inference: the owner said these sets are that
          // session. `linked_by = 'user'`, and it replaces any automatic link.
          linkIngestedWorkout(db, newId, ingest.id);
        } else {
          // Pair-on-save — the other half of pair-on-sync. The watch's copy of
          // the session just finished is usually already in `wearable_data`.
          pairIngestedWorkouts(db);
        }
      }
      disarmRestAlert();
      savedRef.current = true;
      // The draft has become a workout. Clear it AFTER the write succeeds —
      // if the save throws, the draft is the only copy of the session and the
      // screen stays open holding it.
      if (!editing) discardDraft();
      router.back();
    } catch (error) {
      console.warn('[exercise] workout save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Please try again.');
    }
  };

  /**
   * Delete the whole session. Two taps, because the workout log is execution
   * history with no server copy and no undo — the destructive style plus a named
   * consequence is the pattern every other delete in the app uses.
   */
  const removeWorkout = () => {
    if (!stored) return;
    Alert.alert(
      'Delete this session?',
      'Its sets go with it, and the freshness and volume it contributed disappear. This cannot be undone.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            try {
              deleteWorkout(getDb(), stored.id);
              savedRef.current = true;
              router.back();
            } catch (error) {
              console.warn('[exercise] workout delete failed', error);
              Alert.alert('Delete failed', 'The session is unchanged. Please try again.');
            }
          },
        },
      ]
    );
  };

  // Cancel any pending OS rest alert if the screen is left without finishing.
  // Bump the token first so an in-flight schedule that resolves after teardown
  // sees a stale seq and cancels its own id, rather than leaking an alert whose
  // id landed too late for this cleanup to have seen it.
  useEffect(
    () => () => {
      restSeq.current++;
      void cancelRestAlert(restNotifId.current);
    },
    []
  );

  // Superset group per block, derived from the linked-to-next flags.
  const groups = supersetGroups(blocks);

  return (
    <Screen>
      <ScrollView
        className="-mx-5 flex-1"
        contentContainerClassName="grow px-5 pb-10"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets>
        <View className="pt-2">
          <StackHeader title={editing ? 'Session' : 'Workout'} />
        </View>

        {/*
          The clock line. Live, it is the elapsed timer; editing, it is the day
          the session happened and how long it took — the same slot, because
          both answer "when is this workout". The session-name input that used
          to sit under it is GONE (owner, 2026-08-14: *"Workouts dont need
          names, remove this"*), and nothing replaced it: the movements below
          are the session's identity.
        */}
        {/*
          The clock and the away-gym control share one row: the control belongs
          beside the thing that says *when* this session is, because it says
          *where*. It takes no device of its own — devices never nest, and the
          set tables below are already plates — and no accent: this screen's
          budget is exactly one primary action (Finish workout) plus the
          completion stamps. Off it is a hairline outline; on it takes the
          protocol editor's selected treatment (border-ink + the recessed fill).
        */}
        <View className="mt-2 flex-row items-center justify-between gap-3">
          <View className="flex-row items-baseline gap-2">
            {editing ? (
              <>
                <Text className="font-mono text-2xl text-ink">
                  {dayLabel(stored.date, todayISODate())}
                </Text>
                {stored.durationMin != null ? (
                  <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                    {Math.round(stored.durationMin)} min
                  </Text>
                ) : null}
              </>
            ) : filling ? (
              /* The watch's span, stated rather than timed — this session already
                 happened, and the clock would only measure the typing. */
              <>
                <Text className="font-mono text-2xl text-ink">
                  {dayLabel(ingest.date, todayISODate())}
                </Text>
                <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                  {Math.round(ingest.durationMin)} min
                </Text>
              </>
            ) : (
              <>
                <Text className="font-mono text-2xl text-ink">
                  {formatClock((now - startedAt) / 1000)}
                </Text>
                <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                  elapsed
                </Text>
              </>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: away }}
            accessibilityLabel={
              away
                ? 'Away gym, on. This session sets no records and does not steer progression. Tap to turn off.'
                : 'Away gym, off. Tap to mark this session as logged away from your usual gym.'
            }
            onPress={toggleAway}
            className={`min-h-[44px] justify-center rounded-btn border px-3 active:bg-paper-dim ${
              away ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'
            }`}>
            <Text
              className={`font-label text-[12px] uppercase tracking-[1px] ${
                away ? 'font-semibold text-ink' : 'text-ink-secondary'
              }`}>
              Away gym
            </Text>
          </Pressable>
        </View>

        {/* What the WATCH measured about the session being corrected (0054,
            docs §15). The editor has loaded `stored.ingested` since pairing
            shipped and never rendered it; heart rate is the first figure on it
            worth reading while looking at the sets. One mono line, the same
            string the Train hub prints — this screen is where the owner asks
            "how hard was that actually", and the answer was one join away.

            Since 2026-09-21 the line is also the DOOR OUT of a wrong pair, and
            this screen is the only place it can be: it is where a session and
            the watch's claim about it are both on screen at once. The label
            voice and the neutral ink are the hub's own "Log sets" row — an
            action that is not the screen's primary one, so it takes no accent —
            and the 44px is the tap target every row here keeps. */}
        {editing && storedWatch ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`From your watch: ${storedWatchSpoken ?? storedWatch}. Unpair this record from the session.`}
            onPress={unpairWatch}
            className="mt-1 min-h-[44px] flex-row items-center gap-3 active:opacity-60">
            <Text className="flex-1 font-mono text-[11px] leading-4 text-ink-muted">
              {storedWatch}
            </Text>
            <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink">
              Unpair
            </Text>
          </Pressable>
        ) : null}

        {/* What is being filled in, and where it came from. Mono metadata, one
            line — the owner tapped a row that said this, and the screen has to
            confirm it landed on the right session before he types anything. */}
        {filling ? (
          <Text className="mt-1 font-mono text-[11px] leading-4 text-ink-muted">
            {ingest.activity ?? 'Workout'} from Apple Health · {deviceLabel(ingest.sourceDevice)} ·
            add the sets you did
          </Text>
        ) : null}

        {/*
          The entire feature, said where the decision is made — including the
          corner case the owner will hit first: the away gym's machine is
          EASIER, he genuinely moves more weight, and there is still no record.
          Prose about the session, so: serif, muted, no device.
        */}
        {away ? (
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            Loads from this session won’t set records or steer progression, even if they’re the best
            on record. It still counts as training.
          </Text>
        ) : null}

        {/*
          Exercise blocks — one ruled plate per exercise, and THE BIND for
          supersets (owner ask, 2026-08-11: "really join the two together").

          Linking two exercises doesn't decorate them — it makes them ONE
          object. The lower plate springs upward until the two plates' facing
          borders overlap into a single shared rule (marginTop 20 → −1, a
          Reanimated layout spring — the plates visibly snap together), and a
          small SUPERSET seam chip stamps into the fused joint with a spring
          overshoot, the way a press stamp lands on a ledger seam. Tapping the
          seam splits the plates apart again (the same spring, reversed; the
          chip fades). This is the joining drawn with the system's own
          vocabulary — plates, one rule, the label voice — no new chrome, no
          lone strokes (the left rule the 2026-08-10 sweep cut stays cut).

          When a block is NOT linked to the one below, the quiet link affordance
          sits in the gap, as before.
        */}
        {blocks.length === 0 ? (
          <Text className="mt-8 font-serif text-[14px] leading-6 text-ink-secondary">
            {editing
              ? 'This session has no sets left. Save to keep it empty, or delete it.'
              : 'Nothing logged yet.'}
          </Text>
        ) : (
          <View className="mt-6">
            {blocks.map((block, bi) => {
              const linkedAbove = bi > 0 && groups[bi] != null && groups[bi] === groups[bi - 1];
              return (
                <Animated.View
                  key={block.key}
                  layout={BIND_SPRING}
                  style={bi === 0 ? undefined : { marginTop: linkedAbove ? -1 : 20 }}>
                  {linkedAbove ? (
                    <SupersetSeam onPress={() => toggleLink(blocks[bi - 1]!.key)} />
                  ) : null}
                  <ExerciseBlock
                    block={block}
                    units={units}
                    spec={spec}
                    onPatch={patchSet}
                    onAddSet={addSet}
                    onRemoveSet={removeSet}
                    onCycleType={cycleSetType}
                    onToggleDone={toggleDone}
                    onRemove={removeBlock}
                    onOpenDetail={() => {
                      // A free-text block has no catalog id and no detail page.
                      if (block.exerciseId != null) {
                        router.push({
                          pathname: '/exercise-detail',
                          params: { id: block.exerciseId },
                        });
                      }
                    }}
                  />
                  {bi < blocks.length - 1 && !block.linkedToNext ? (
                    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Superset ${block.name} with the next exercise`}
                        onPress={() => toggleLink(block.key)}
                        className="mt-1 min-h-[40px] flex-row items-center justify-center gap-1.5 active:opacity-60">
                        <Ionicons name="link-outline" size={14} color={palette.inkMuted} />
                        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                          Superset with next
                        </Text>
                      </Pressable>
                    </Animated.View>
                  ) : null}
                </Animated.View>
              );
            })}
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add exercise"
          onPress={() => setPickerOpen(true)}
          className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            Add exercise
          </Text>
        </Pressable>

        {/* Why Finish is off — an annotation, so: margin. A single over-limit
            weight would otherwise roll the whole session back on the CHECK. */}
        {weightProblem ? (
          <View className="mt-5">
            <Block device="margin">
              <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                {weightProblem}
              </Text>
            </Block>
          </View>
        ) : null}

        {/*
          The one primary action on this screen. Disabled reads as an unfilled
          outline rather than a filled grey: muted ink on the sheet clears 4.5:1,
          where muted ink on a hairline fill does not.
        */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Save changes' : 'Finish workout'}
          accessibilityState={{ disabled: !canFinish }}
          disabled={!canFinish}
          onPress={finish}
          className={`mt-8 h-12 items-center justify-center rounded-btn ${
            canFinish ? 'bg-pine active:opacity-70' : 'border border-hairline'
          }`}>
          <Text
            className={`font-label text-[15px] font-semibold ${
              canFinish ? 'text-pine-on' : 'text-ink-muted'
            }`}>
            {editing ? 'Save changes' : 'Finish workout'}
          </Text>
        </Pressable>

        {/* Deleting the session. Muted ink, exactly as protocol-edit and
            screening-form draw theirs: not the accent, which belongs to the one
            forward action above, and emphatically not signal `poor` — signal
            colour marks biological state and never interface chrome (the
            firewall, 00-design-spec.md §2). The weight of the act lives in the
            confirm, which is where it can actually be read. */}
        {editing ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete this session"
            onPress={removeWorkout}
            className="mt-3 min-h-[44px] items-center justify-center active:opacity-60">
            <Text className="font-label text-[13px] text-ink-muted">Delete session</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {/* Rest timer — a quiet docked line, no modal, no glow. Foreground only. */}
      {restRemaining != null ? (
        <View className="absolute inset-x-0 bottom-0 bg-paper-hi">
          {/* The bar's top edge. A `border-t` here would draw all four sides —
              see Divider's docblock — so the edge is a filled 1px view, and it
              sits outside the bar's padding so it spans the full width. */}
          <Divider />
          <View className="flex-row items-center gap-3 px-5 py-3">
            <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
              Rest
            </Text>
            <Text className="font-mono text-lg text-ink">{formatClock(restRemaining)}</Text>
            <View className="flex-1" />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Subtract 15 seconds"
              onPress={() => bumpRest(-15)}
              hitSlop={8}
              className="min-h-[32px] justify-center rounded-btn border border-hairline px-2.5 active:bg-paper-dim">
              <Text className="font-mono text-[12px] text-ink-secondary">−15</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add 15 seconds"
              onPress={() => bumpRest(15)}
              hitSlop={8}
              className="min-h-[32px] justify-center rounded-btn border border-hairline px-2.5 active:bg-paper-dim">
              <Text className="font-mono text-[12px] text-ink-secondary">+15</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss rest timer"
              onPress={dismissRest}
              hitSlop={8}
              className="h-8 w-8 items-center justify-center active:opacity-60">
              <Ionicons name="close" size={16} color={palette.inkMuted} />
            </Pressable>
          </View>
        </View>
      ) : null}

      <ExercisePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(ex) => addExercise(ex.id)}
      />
    </Screen>
  );
}

/**
 * One exercise = one **ruled plate**. The title line, the column header rule and
 * the set rows all live on the same plate, because they are one record: a set
 * table is the most literal "a record is a table" surface in ARC.
 *
 * The block carries no device of its own beyond that plate, and nothing is drawn
 * around it: the superset left rule was cut on 2026-08-10 (see the call site).
 */
function ExerciseBlock({
  block,
  units,
  spec,
  onPatch,
  onAddSet,
  onRemoveSet,
  onCycleType,
  onToggleDone,
  onRemove,
  onOpenDetail,
}: {
  block: LiveBlock;
  units: UnitPreferences;
  spec: ReturnType<typeof weightSpec>;
  onPatch: (bk: number, sk: number, patch: Partial<Omit<LiveSet, 'key'>>) => void;
  onAddSet: (bk: number) => void;
  onRemoveSet: (bk: number, sk: number) => void;
  onCycleType: (bk: number, sk: number, cur: SetType) => void;
  onToggleDone: (block: LiveBlock, set: LiveSet) => void;
  onRemove: (bk: number) => void;
  onOpenDetail: () => void;
}) {
  const cols = blockColumns(block.measures);
  return (
    // Superset grouping is drawn by THE BIND at the call site (fused plates +
    // the seam chip), not by anything on the block itself. The old left rule
    // was cut 2026-08-10 (a lone vertical stroke — the same mark the `margin`
    // device lost); the old "Superset" eyebrow above the first block moved into
    // the seam chip, which names the group at the joint it actually joins.
    <View>
      <Block device="plate">
        <View className="flex-row items-center gap-2">
          {/* The title is the door to the movement's detail — history, trend,
              records, and how it looks — for the mid-session "how does this
              one go again?" (2026-08-11). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${block.name}. Open history, records and form.`}
            onPress={onOpenDetail}
            hitSlop={6}
            className="flex-1 flex-row items-center gap-1.5 active:opacity-60">
            <Text className="shrink font-serif text-[16px] font-semibold text-ink">
              {block.name}
            </Text>
            <Ionicons name="chevron-forward" size={13} color={palette.inkMuted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${block.name}`}
            onPress={() => onRemove(block.key)}
            hitSlop={10}
            className="h-8 w-8 items-center justify-center active:opacity-60">
            <Ionicons name="close" size={16} color={palette.inkMuted} />
          </Pressable>
        </View>

        {/* Column header — the label voice, closed by the rule beneath it. The
            value columns are whatever the movement measures (0046), in the
            canonical order reps · load · time · distance, so a plank offers one
            clock and a run a clock and a distance. The unit is in the HEADER,
            never in the field, so every cell below stays a bare mono number. */}
        <View className="mt-1.5 flex-row items-center gap-1.5 pb-1.5">
          <Text className="w-7 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            Set
          </Text>
          {cols.prev ? (
            <Text className="w-16 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
              Prev
            </Text>
          ) : null}
          {cols.load ? (
            <Text className="flex-1 text-center font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
              {spec.unit}
            </Text>
          ) : null}
          {cols.reps ? (
            <Text className="flex-1 text-center font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
              Reps
            </Text>
          ) : null}
          {cols.time ? (
            <Text className="flex-1 text-center font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
              mm:ss
            </Text>
          ) : null}
          {cols.distance ? (
            <Text className="flex-1 text-center font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
              {units.distance}
            </Text>
          ) : null}
          <Text className="w-12 text-center font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            RPE
          </Text>
          <View className="w-8" />
        </View>
        {/* The rule that closes the column header. Drawn, not bordered — a
            `border-b` here is the same four-sided trap as `border-t`. */}
        <Divider />

        {block.sets.map((set, i) => {
          const prev = block.prev[i];
          const tag = setTypeTag(set.setType);
          return (
            <View key={set.key}>
              <Divider first={i === 0} />
              <View className="flex-row items-center gap-1.5 py-1.5">
                {/* Set number / type tag */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Set ${i + 1} type: ${set.setType}. Tap to change.`}
                  onPress={() => onCycleType(block.key, set.key, set.setType)}
                  hitSlop={10}
                  className="h-8 w-7 items-center justify-center active:opacity-60">
                  <Text className="font-mono text-[12px] text-ink-secondary">{tag || i + 1}</Text>
                </Pressable>

                {cols.prev ? (
                  <Text className="w-16 font-mono text-[11px] text-ink-muted" numberOfLines={1}>
                    {prevColumnText(prev, cols, units)}
                  </Text>
                ) : null}

                {cols.load ? (
                  <View className={`min-h-[36px] flex-1 ${INPUT_WELL}`}>
                    <TextInput
                      value={set.weight}
                      onChangeText={(weight) => onPatch(block.key, set.key, { weight })}
                      placeholder={
                        prev?.weightKg != null ? String(displayWeight(prev.weightKg, units)) : '—'
                      }
                      placeholderTextColor={palette.inkMuted}
                      keyboardType="decimal-pad"
                      returnKeyType={KEYPAD_DONE}
                      className="py-1.5 text-center font-mono text-[15px] text-ink"
                      accessibilityLabel={`Weight for set ${i + 1}`}
                    />
                  </View>
                ) : null}

                {cols.reps ? (
                  <View className={`min-h-[36px] flex-1 ${INPUT_WELL}`}>
                    <TextInput
                      value={set.reps}
                      onChangeText={(reps) => onPatch(block.key, set.key, { reps })}
                      placeholder={prev?.reps != null ? String(prev.reps) : '—'}
                      placeholderTextColor={palette.inkMuted}
                      keyboardType="number-pad"
                      returnKeyType={KEYPAD_DONE}
                      className="py-1.5 text-center font-mono text-[15px] text-ink"
                      accessibilityLabel={`Reps for set ${i + 1}`}
                    />
                  </View>
                ) : null}

                {/* The clock (owner, 2026-09-23: *"plank time should not require
                    me to put in a colon"*). A plain number pad whose digits fill
                    from the right — 1 3 0 draws 1:30 — so the colon is drawn,
                    never typed. The well is the same 36pt well as its
                    neighbours; the field inside it overhangs to a 44pt target
                    (src/components/exercise/duration-field.tsx). `set.time`
                    stays the m:ss text `finish()` reads with `parseClock`. */}
                {cols.time ? (
                  <View className={`min-h-[36px] flex-1 ${INPUT_WELL}`}>
                    <DurationField
                      value={set.time}
                      onChangeText={(time) => onPatch(block.key, set.key, { time })}
                      placeholder={
                        prev?.durationSec != null ? secondsToClock(prev.durationSec) : '0:00'
                      }
                      centered
                      accessibilityLabel={`Time for set ${i + 1}, minutes and seconds`}
                    />
                  </View>
                ) : null}

                {cols.distance ? (
                  <View className={`min-h-[36px] flex-1 ${INPUT_WELL}`}>
                    <TextInput
                      value={set.distance}
                      onChangeText={(distance) => onPatch(block.key, set.key, { distance })}
                      placeholder={
                        prev?.distanceM != null
                          ? String(displayDistance(prev.distanceM, units))
                          : '—'
                      }
                      placeholderTextColor={palette.inkMuted}
                      keyboardType="decimal-pad"
                      returnKeyType={KEYPAD_DONE}
                      className="py-1.5 text-center font-mono text-[15px] text-ink"
                      accessibilityLabel={`Distance for set ${i + 1}, in ${units.distance}`}
                    />
                  </View>
                ) : null}

                <View className={`min-h-[36px] w-12 ${INPUT_WELL}`}>
                  <TextInput
                    value={set.rpe}
                    onChangeText={(rpe) => onPatch(block.key, set.key, { rpe })}
                    placeholder="—"
                    placeholderTextColor={palette.inkMuted}
                    keyboardType="decimal-pad"
                    returnKeyType={KEYPAD_DONE}
                    className="py-1.5 text-center font-mono text-[13px] text-ink"
                    accessibilityLabel={`RPE for set ${i + 1}`}
                  />
                </View>

                {/*
                The completion stamp. Chrome, not biology — so it is the accent
                and never a signal green (the firewall, 00-design-spec.md §2).
              */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ checked: set.done }}
                  accessibilityLabel={`Mark set ${i + 1} ${set.done ? 'incomplete' : 'complete'}`}
                  onPress={() => onToggleDone(block, set)}
                  onLongPress={() => onRemoveSet(block.key, set.key)}
                  hitSlop={8}
                  className={`h-8 w-8 items-center justify-center border ${
                    set.done ? 'border-pine bg-pine' : 'border-hairline'
                  } active:opacity-70`}>
                  <Ionicons
                    name="checkmark"
                    size={16}
                    color={set.done ? palette.pineOn : palette.hairline}
                  />
                </Pressable>
              </View>
            </View>
          );
        })}

        {/* PR marker + add set */}
        <Divider />
        <View className="flex-row items-center gap-2 pt-1.5">
          {block.sets.some((s) => s.pr) ? (
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
              PR
            </Text>
          ) : null}
          <View className="flex-1" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add a set to ${block.name}`}
            onPress={() => onAddSet(block.key)}
            hitSlop={8}
            className="min-h-[32px] flex-row items-center gap-1 active:opacity-60">
            <Ionicons name="add" size={15} color={palette.inkSecondary} />
            <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
              Add set
            </Text>
          </Pressable>
        </View>
      </Block>
    </View>
  );
}
