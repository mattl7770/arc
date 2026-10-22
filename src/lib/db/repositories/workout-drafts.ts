/**
 * The unfinished-workout store — `workout_drafts` (0045), a two-slot KV.
 *
 * This is the whole of "the app was killed mid-session and nothing was lost".
 * The logging screens write through here on every change; reopening reads back
 * what was typed. The table is deliberately NOT `workouts` / `workout_sets`:
 * every training read in the app (freshness, weekly volume, PRs, e1RM, the
 * Coach's training tools, the report assembler, the export) queries those two
 * tables, and a draft that lived there would have to be excluded by a predicate
 * in each of them, forever. Here the exclusion is structural — nothing that
 * reads training can see this table at all. See 0045's header for the full
 * argument.
 *
 * Shape discipline lives in src/lib/exercise/draft.ts; this file only moves
 * JSON in and out. Depends on the {@link Database} interface only — never
 * op-sqlite — so the same code runs on device and in db/exercise.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import { mayClearLiveSlot, type DraftKey } from '@/lib/exercise/draft';

type DraftRow = { value: string; updated_at: string };

/**
 * Who hears that a slot changed (item 71). The session bar — above the tab bar,
 * and at the foot of every pushed screen (src/components/exercise/
 * session-bar.tsx) — shows the session while the owner is elsewhere in the
 * app, so it has to learn the moment a session is finished or discarded,
 * including the clears that land while it is not the focused screen: Finish
 * clears the slot and THEN pops the logger, and the logger's quiet drop runs
 * in `beforeRemove`. A bar that only re-read on focus would show a session
 * that no longer exists for the length of the pop.
 *
 * It lives here because every write to the table goes through the functions
 * below; an announcement made anywhere else would miss one. Listeners are told
 * WHICH slot changed, never what is in it: they re-read it through
 * {@link readWorkoutDraft}, so there is still one reading of a draft. The key
 * is there so a listener can ignore the slot it does not draw — the bar shows
 * only 'live', and the manual logger writes its slot on every keystroke
 * (review, 2026-10-21).
 */
type DraftListener = (key: DraftKey) => void;
const listeners = new Set<DraftListener>();

/** Hear every write and clear of either slot. Returns the unsubscribe. */
export function subscribeWorkoutDrafts(listener: DraftListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announce(key: DraftKey): void {
  // A copy, so a listener that unsubscribes mid-loop cannot skip its neighbour;
  // and one that throws must stop neither the others nor the write that called it.
  for (const listener of [...listeners]) {
    try {
      listener(key);
    } catch (error) {
      console.warn('[exercise] draft listener failed', error);
    }
  }
}

/** A stored draft, still as parsed JSON — the caller decides what it is. */
export type StoredDraft = {
  /** The payload, parsed. `null` when the stored text is not valid JSON. */
  value: unknown;
  /** When it was last written — the "in progress since" the Resume card shows. */
  updatedAt: string;
};

/**
 * Write (or overwrite) one draft slot. An UPSERT on the UNIQUE `key`, because a
 * draft has no history — only a latest. One statement, so the hot path (a write
 * per keystroke in the logger) is a single prepared insert and never a
 * read-then-write race with itself.
 */
export function saveWorkoutDraft(db: Database, key: DraftKey, value: unknown): void {
  db.run(
    `INSERT INTO workout_drafts (id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [newId(db), key, JSON.stringify(value)]
  );
  announce(key);
}

/**
 * Read one draft slot, or `null` when the slot is empty. Unparseable JSON also
 * reads as `null`: this runs in the logger's mount path and a corrupt row must
 * not be able to make the screen un-openable (the CHECK makes that
 * near-impossible, but "near" is not a guarantee worth a crash).
 */
export function readWorkoutDraft(db: Database, key: DraftKey): StoredDraft | null {
  const row = db.get<DraftRow>('SELECT value, updated_at FROM workout_drafts WHERE key = ?', [key]);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as unknown, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

/**
 * Discard one draft slot. This is the whole of "abandon a session": one row
 * goes, and because a draft was never a workout there is no half-session, no
 * orphaned sets and no cascade to get right. Unknown keys are a no-op.
 */
export function clearWorkoutDraft(db: Database, key: DraftKey): void {
  db.run('DELETE FROM workout_drafts WHERE key = ?', [key]);
  announce(key);
}

/**
 * Empty the live slot for one logger screen — on Finish, on its Discard, when
 * its last exercise goes, and on a quiet drop (2026-09-25) — but only when the
 * slot holds that screen's session or nothing ({@link mayClearLiveSlot}). A
 * different session in the slot belongs to whoever started it. Returns false
 * only when it refused for that reason.
 */
export function clearOwnLiveDraft(db: Database, sessionId: string): boolean {
  if (!mayClearLiveSlot(readWorkoutDraft(db, 'live')?.value ?? null, sessionId)) return false;
  clearWorkoutDraft(db, 'live');
  return true;
}
