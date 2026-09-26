/**
 * The Coach composer's seed: which sentence the field mounts holding, and the
 * React key that remounts it when a new one arrives.
 *
 * Two sources seed the composer, and neither ever sends:
 *
 *   - a `prompt` route param — Home's status door (a status set or ended from
 *     Home's sheet) and the Protocols hub's empty state push the Coach tab with
 *     one;
 *   - the × in the Coach tab's own status sheet, which seeds the end sentence
 *     in place (`endOpenStatus` in ./store.ts says why ending is seeded).
 *
 * `ChatInput` reads its `initialText` once and owns the draft after that, so a
 * seed reaches the field only by changing the key. The rule is **the latest
 * seed wins, whichever screen it came from, and each one remounts the field
 * exactly once.** One counter keys both sources, so neither can shadow the
 * other.
 *
 * ## The latch this replaced (2026-09-23)
 *
 * The screen used to hold the × seed in its own state and read
 * `railSeed ?? prompt`. `railSeed` was never cleared, so after the first × on
 * the Coach tab every later `prompt` from Home was shadowed for as long as the
 * tab stayed mounted: a status tapped on Home wrote its row, and no prompt
 * followed it — the old Modes failure the store's header warns about.
 *
 * ## Why the tab also drops the param it consumed
 *
 * An arrival is recognised as a CHANGE in the param. Home sends the same
 * sentence every time a given chip goes on, so Sick → × on the Coach tab → Sick
 * again on Home pushes a param identical to the one already sitting on the
 * route, and no change would be seen. The tab therefore sets `prompt` back to
 * undefined once it has taken it (expo-router's `useLocalSearchParams` hides an
 * undefined param for exactly this use), and the next push is an arrival again.
 * Dropping it is not itself an arrival: the key holds, so a draft being edited
 * is not wiped.
 */
export type ComposerSeed = {
  /** What the composer mounts holding; undefined is an empty draft. */
  text: string | undefined;
  /** How many seeds have reached the composer, from either source. The key. */
  count: number;
  /** The `prompt` param last seen, so a new arrival can be told from the old. */
  param: string | undefined;
};

/** A tab that has received nothing. */
export const NO_SEED: ComposerSeed = { text: undefined, count: 0, param: undefined };

/**
 * The `prompt` param as the tab currently sees it. Returns `seed` itself when
 * nothing arrived, so a caller can compare by identity and skip a state update.
 */
export function seedFromParam(seed: ComposerSeed, param: string | undefined): ComposerSeed {
  if (param === seed.param) return seed;
  // Dropped (by the tab, after taking it) or emptied: nothing new to seed.
  if (!param) return { ...seed, param };
  return { text: param, count: seed.count + 1, param };
}

/** The × in the tab's own sheet: its end sentence, always a fresh seed. */
export function seedFromRail(seed: ComposerSeed, text: string): ComposerSeed {
  return { text, count: seed.count + 1, param: seed.param };
}

/**
 * A control on the tab itself — the reminders card's **Talk about this** (0064,
 * owner's Q5: a plain reminder's tap "opens with 'Talk about this'"). The same
 * rule as the ×: always a fresh seed, never a send.
 */
export function seedFromTap(seed: ComposerSeed, text: string): ComposerSeed {
  return seedFromRail(seed, text);
}

/** What "Talk about this" puts in the composer for a reminder. */
export function talkAboutReminder(title: string): string {
  return `About my reminder "${title}": `;
}

/** The composer's React key. Unseeded mounts exactly as it always has. */
export function composerKey(seed: ComposerSeed): string {
  return seed.count === 0 ? 'composer' : `seed-${seed.count}`;
}
