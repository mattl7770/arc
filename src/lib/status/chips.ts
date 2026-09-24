/**
 * The status rail's five chips, and the sentence each one sends.
 *
 * **One table, two surfaces.** The sheet behind the status door — the same
 * sheet on Home and on the Coach tab — and the store that sends these
 * sentences both read this file, because two copies of a five-word vocabulary
 * is how two surfaces start offering different words. Pure values — no React, no database, no clock — so
 * db/statuses.test.mjs can assert on it headlessly.
 *
 * ## The five, and why these five
 *
 * Sick · Traveling · Injured · Off day · Night out (his Q1(a)). They are not a
 * taxonomy and nothing in the schema knows about them: `day_statuses.label` is
 * free text precisely so anything else the user says is a first-class status
 * that the Coach records with `set_status`. These five are the ones worth a
 * button, which is a claim about frequency, not about biology.
 *
 * Deload is deliberately absent and is not a status at all — it is a decision
 * about the training plan, made with `update_protocol`. The doctrine says so
 * and so does the tool description.
 *
 * ## Three sentences per chip, because three gestures
 *
 * Each chip carries what to say when it goes ON, what to say when it is tapped
 * AGAIN (day two of a five-day flu — the re-ask), and what to say when it ENDS.
 * They are written in the owner's own voice, ending in his own sentence from
 * the backlog entry: *"Check what's up and adjust accordingly."* They are the
 * USER's words, not the Coach's, so the prompt voice rules do not apply to
 * them.
 *
 * The end sentence is SEEDED rather than sent (the composer, behind the
 * `chat-input.tsx` seeding rule): ending is bookkeeping that may not warrant a
 * turn. The other two are SENT — the empty-thread plate is the precedent, and a
 * quick-button that needs a second tap on send is not a quick-button.
 *
 * ## The end sentences were rewritten (2026-09-23)
 *
 * The owner, on the device: *"the message for unchecking a status feels weird
 * but otherwise this is ok."* They read *"Over the bug — back to normal.
 * Re-check today and put back what you took out."* — a phrase he would not
 * type, then the MECHANISM narrated back at the Coach, presuming it had taken
 * something out. Each is now what he would actually say ("I'm feeling
 * better."), ending in the same sentence of his the other two gestures end in.
 *
 * That sentence stays on the end, rather than being trimmed for terseness,
 * because on the day a status ends the seeded line is the Coach's ONLY cue:
 * the × sets `ended`, so the state block stops listing the status at once, and
 * its *"ended yesterday"* revert cue does not print until tomorrow
 * (src/lib/ai/turn-context.ts). Since 2026-09-23 that cue prints whether or not
 * another status is still running; before, it printed only when none was, so
 * ending Sick on a trip never produced it. A bare "I'm feeling better." asks
 * for nothing.
 */

/** A status the rail draws as a fixed button. */
export type StatusChipSpec = {
  /** The stored, normalized label — lower-case, what `day_statuses` holds. */
  label: string;
  /** How a surface prints it. */
  display: string;
  /**
   * Does it end tonight? Off day and Night out do (the owner's Q4(a)): they are
   * statements about a day, so they are written bounded at today and simply
   * have no tomorrow. The other three run until the × ends them.
   */
  endsTonight: boolean;
  /** Sent when the chip goes off → on. */
  prompt: string;
  /** Sent when an already-on chip is tapped — the re-ask. */
  again: string;
  /**
   * Seeded, never sent, when the × ends it. Off day and Night out carry one
   * too, but no × is drawn on a status with no tomorrow (status-rail.tsx), so
   * today nothing seeds theirs.
   */
  ended: string;
};

const ADJUST = "Check what's up and adjust accordingly.";

export const STATUS_CHIPS: readonly StatusChipSpec[] = [
  {
    label: 'sick',
    display: 'Sick',
    endsTonight: false,
    prompt: `I'm sick right now. ${ADJUST}`,
    again: `Still sick. ${ADJUST}`,
    ended: `I'm feeling better. ${ADJUST}`,
  },
  {
    label: 'traveling',
    display: 'Traveling',
    endsTonight: false,
    prompt: `I'm traveling right now. ${ADJUST}`,
    again: `Still traveling. ${ADJUST}`,
    ended: `I'm back home. ${ADJUST}`,
  },
  {
    label: 'injured',
    display: 'Injured',
    endsTonight: false,
    prompt: `I'm injured right now. ${ADJUST}`,
    again: `Still injured. ${ADJUST}`,
    ended: `My injury's better. ${ADJUST}`,
  },
  {
    label: 'off day',
    display: 'Off day',
    endsTonight: true,
    prompt: `Taking today off. ${ADJUST}`,
    again: `Still taking today off. ${ADJUST}`,
    ended: `I'm back on it. ${ADJUST}`,
  },
  {
    label: 'night out',
    display: 'Night out',
    endsTonight: true,
    prompt: `Night out tonight. ${ADJUST}`,
    again: `Still out tonight. ${ADJUST}`,
    ended: `I'm home for the night. ${ADJUST}`,
  },
];

/**
 * How many statuses the rail will draw that are NOT one of the five.
 *
 * Two, and then it stops. A status the Coach recorded from a sentence
 * ("jet-lagged", "work crunch") deserves a chip — otherwise the one control
 * that shows what is on would be silent about half of it — but a rail that
 * grows without bound becomes a wall, even inside the sheet it lives in now. Anything past two is still counted on the door, still named
 * in the sheet's header, still in the Coach's state block, and still endable
 * by asking.
 */
export const MAX_EXTRA_CHIPS = 2;

/** "night out" → "Night out". Statuses are stored lower-case; surfaces print. */
export function displayStatus(label: string): string {
  const found = STATUS_CHIPS.find((chip) => chip.label === label);
  if (found) return found.display;
  return label.length === 0 ? label : label[0]!.toUpperCase() + label.slice(1);
}

/** The spec for a stored label, or null when it is one the user typed. */
export function chipFor(label: string): StatusChipSpec | null {
  return STATUS_CHIPS.find((chip) => chip.label === label) ?? null;
}

/** What to send when a status goes on. Generic for a label with no chip. */
export function promptFor(label: string): string {
  return chipFor(label)?.prompt ?? `I'm ${label} right now. ${ADJUST}`;
}

/** What to send when an on-chip is tapped — the re-ask. */
export function reaskFor(label: string): string {
  return chipFor(label)?.again ?? `Still ${label}. ${ADJUST}`;
}

/**
 * What to SEED when a status ends. Never sent.
 *
 * A label the Coach recorded is free text — "jet-lagged", "work crunch", "on
 * call" — so the generic line cannot be conjugated into the first person the
 * five are in. "X is over." is the one shape that reads for an adjective and a
 * noun alike.
 */
export function endPromptFor(label: string): string {
  return chipFor(label)?.ended ?? `${displayStatus(label)} is over. ${ADJUST}`;
}

/** One chip as a surface draws it: the five, then up to two the user has open. */
export type RailChip = {
  label: string;
  display: string;
  /** The open row's id, when it is on — what the × ends. */
  openId: string | null;
  endsTonight: boolean;
};

/**
 * The rail's chips for a set of open statuses.
 *
 * The five fixed ones in their fixed order — a control whose buttons move
 * between taps is not a control — then up to {@link MAX_EXTRA_CHIPS} open
 * statuses matching none of them, most recently started first.
 */
export function railChips(
  open: readonly { id: string; label: string; end_date: string | null }[]
): RailChip[] {
  const openByLabel = new Map(open.map((row) => [row.label, row]));
  const fixed: RailChip[] = STATUS_CHIPS.map((chip) => ({
    label: chip.label,
    display: chip.display,
    openId: openByLabel.get(chip.label)?.id ?? null,
    endsTonight: chip.endsTonight,
  }));
  const extras: RailChip[] = open
    .filter((row) => chipFor(row.label) === null)
    .slice(0, MAX_EXTRA_CHIPS)
    .map((row) => ({
      label: row.label,
      display: displayStatus(row.label),
      openId: row.id,
      // A typed status the Coach bounded at today behaves like Night out: it
      // has no tomorrow, so there is nothing for an × to end.
      endsTonight: false,
    }));
  return [...fixed, ...extras];
}
