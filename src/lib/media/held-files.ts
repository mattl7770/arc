/**
 * Photo files an open Undo still needs (owner, device, 2026-09-23: *"undo for
 * removing a food"*).
 *
 * Deleting a meal deletes its rows at once and its FILES only when the Undo
 * window closes (src/lib/media/meal-photo-store.ts) — a removed file is the one
 * thing an Undo could not bring back. In between, the files are on disk and no
 * row claims them, which is exactly what the two reconcile passes call an
 * orphan. A name held here is not an orphan: both sweeps skip it.
 *
 * **In memory, on purpose.** A hold lasts as long as the process that can undo.
 * If the app is killed inside the window, the hold dies with the Undo it was
 * for; the rows are already gone, so on the next launch the files are genuine
 * orphans and the sweep reclaims them. Persisting the hold would keep files
 * alive for an Undo that can no longer happen. The two failures the owner's
 * brief names are both impossible by this shape: a row never survives without
 * its file (the rows go first and come back only through the Undo, while the
 * files are held), and no file outlives the next launch (nothing holds it then).
 *
 * Names are the random `<uuid>.jpg` base names every photo directory uses, so
 * one set serves `meal-photos/` and `pending-estimates/` without collision.
 * Pure state — no database, no native module.
 */

const held = new Set<string>();

/** Keep these files out of every orphan pass until {@link releaseFiles}. */
export function holdFiles(names: readonly string[]): void {
  for (const name of names) held.add(name);
}

/** The Undo that needed them is closed — undone, or settled. */
export function releaseFiles(names: readonly string[]): void {
  for (const name of names) held.delete(name);
}

/** What is held now — the default the sweeps skip. */
export function heldFiles(): ReadonlySet<string> {
  return held;
}
