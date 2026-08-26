/**
 * What changed between two protocol versions.
 *
 * "Versioned like code" was the storage half with none of the payoff: history
 * was immutable and real, and nothing could tell you what a version actually
 * DID. `change_notes` sat beside a version number and an item count, so the
 * author's own sentence was the only account of the change and nothing checked
 * it. This module is the other half.
 *
 * Pure over two ALREADY-NORMALISED contents (`parseProtocolContent` output), so
 * a v1 version and a v2 version diff against each other exactly like two v2
 * versions do — which matters, because the version where the schema turned over
 * is the one the owner will most want to read.
 *
 * ## Matching rules, in order
 *
 *   1. **Phases by `id`.** Ids are stable across versions by construction (the
 *      editor carries them through a save; a v1 document always normalises to
 *      the same `v1-phase`), so a retitled or re-timed phase is recognised as
 *      the same phase.
 *   2. **Phases left over, by position.** Two documents that share no phase ids
 *      at all — a hand-written import, say — still line up first-with-first
 *      rather than reading as a total replacement.
 *   3. **Items by `id`, within a matched pair of phases.**
 *   4. **Items left over, by case-insensitive title.** This is what makes a
 *      v1↔v2 diff legible when ids were re-generated rather than carried, and
 *      it is why an item renamed AND re-dosed in one save reads as
 *      removed + added: nothing links the two, and inventing a link would put a
 *      false "changed from" in front of the reader.
 *
 * An item MOVED from one phase to another reads as removed there and added
 * here. That is deliberate: which phase an item belongs to is the substance of
 * a phased protocol, so a move is a real change and not a re-shuffle to hide.
 */
import { cadenceText } from './cadence';
import type { ProtocolContent, ProtocolItem, ProtocolPhase } from './types';

/** The item fields the diff reports individually. */
export type ItemField = 'title' | 'scheduled_time' | 'dose' | 'notes' | 'cadence';

export type ItemChange =
  | { kind: 'added'; before: null; after: ProtocolItem }
  | { kind: 'removed'; before: ProtocolItem; after: null }
  | { kind: 'changed'; before: ProtocolItem; after: ProtocolItem; fields: ItemField[] }
  | { kind: 'unchanged'; before: ProtocolItem; after: ProtocolItem };

export type PhaseChange = {
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
  before: ProtocolPhase | null;
  after: ProtocolPhase | null;
  titleChanged: boolean;
  durationChanged: boolean;
  items: ItemChange[];
};

export type ContentDiff = {
  phases: PhaseChange[];
  added: number;
  removed: number;
  changed: number;
  /** True when the two documents mean the same thing, field for field. */
  identical: boolean;
};

const FIELDS: ItemField[] = ['title', 'scheduled_time', 'dose', 'notes', 'cadence'];

/** Which of an item's fields differ. Cadence compares by its canonical text. */
function changedFields(before: ProtocolItem, after: ProtocolItem): ItemField[] {
  return FIELDS.filter((field) =>
    field === 'cadence'
      ? cadenceText(before.cadence) !== cadenceText(after.cadence)
      : before[field] !== after[field]
  );
}

const titleKey = (item: ProtocolItem): string => item.title.trim().toLowerCase();

/**
 * Pair up two item lists, then classify each pair. Returns the changes in
 * AFTER order with removals appended, so the list reads as the new version with
 * what left it noted at the end.
 */
function diffItems(before: ProtocolItem[], after: ProtocolItem[]): ItemChange[] {
  const unmatched = new Map<string, ProtocolItem>();
  for (const item of before) unmatched.set(item.id, item);

  const pairs = new Map<string, ProtocolItem>(); // after.id -> before
  for (const item of after) {
    const match = unmatched.get(item.id);
    if (match) {
      pairs.set(item.id, match);
      unmatched.delete(item.id);
    }
  }
  // Second pass: whatever is still unmatched, line up by title. A multiset, so
  // a protocol legitimately listing the same title twice (two doses) does not
  // collapse its second entry into the first.
  const byTitle = new Map<string, ProtocolItem[]>();
  for (const item of unmatched.values()) {
    const list = byTitle.get(titleKey(item)) ?? [];
    list.push(item);
    byTitle.set(titleKey(item), list);
  }
  for (const item of after) {
    if (pairs.has(item.id)) continue;
    const list = byTitle.get(titleKey(item));
    const match = list?.shift();
    if (match) {
      pairs.set(item.id, match);
      unmatched.delete(match.id);
    }
  }

  const changes: ItemChange[] = [];
  for (const item of after) {
    const match = pairs.get(item.id);
    if (!match) {
      changes.push({ kind: 'added', before: null, after: item });
      continue;
    }
    const fields = changedFields(match, item);
    changes.push(
      fields.length === 0
        ? { kind: 'unchanged', before: match, after: item }
        : { kind: 'changed', before: match, after: item, fields }
    );
  }
  for (const item of before) {
    if (unmatched.has(item.id)) changes.push({ kind: 'removed', before: item, after: null });
  }
  return changes;
}

/** Pair phases by id, then line the leftovers up by position. */
function pairPhases(
  before: ProtocolPhase[],
  after: ProtocolPhase[]
): { before: ProtocolPhase | null; after: ProtocolPhase | null }[] {
  const taken = new Set<string>();
  const matched = new Map<string, ProtocolPhase>();
  for (const phase of after) {
    const match = before.find((p) => p.id === phase.id && !taken.has(p.id));
    if (match) {
      matched.set(phase.id, match);
      taken.add(match.id);
    }
  }
  const spare = before.filter((p) => !taken.has(p.id));
  const pairs: { before: ProtocolPhase | null; after: ProtocolPhase | null }[] = [];
  for (const phase of after) {
    pairs.push({ before: matched.get(phase.id) ?? spare.shift() ?? null, after: phase });
  }
  for (const phase of spare) pairs.push({ before: phase, after: null });
  return pairs;
}

/** The full change set from `before` to `after`. Both must be normalised. */
export function diffContent(before: ProtocolContent, after: ProtocolContent): ContentDiff {
  const phases: PhaseChange[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const pair of pairPhases(before.phases, after.phases)) {
    const items = diffItems(pair.before?.items ?? [], pair.after?.items ?? []);
    for (const item of items) {
      if (item.kind === 'added') added++;
      else if (item.kind === 'removed') removed++;
      else if (item.kind === 'changed') changed++;
    }
    const titleChanged =
      pair.before !== null && pair.after !== null && pair.before.title !== pair.after.title;
    const durationChanged =
      pair.before !== null &&
      pair.after !== null &&
      pair.before.duration_days !== pair.after.duration_days;
    const kind: PhaseChange['kind'] =
      pair.before === null
        ? 'added'
        : pair.after === null
          ? 'removed'
          : titleChanged || durationChanged || items.some((i) => i.kind !== 'unchanged')
            ? 'changed'
            : 'unchanged';
    phases.push({ kind, before: pair.before, after: pair.after, titleChanged, durationChanged, items });
  }

  return {
    phases,
    added,
    removed,
    changed,
    identical:
      added === 0 &&
      removed === 0 &&
      changed === 0 &&
      phases.every((p) => p.kind === 'unchanged'),
  };
}

/** How a phase's length reads on its own. */
export function phaseLengthText(phase: ProtocolPhase): string {
  if (phase.duration_days === null) return 'until you change it';
  return phase.duration_days === 1 ? '1 day' : `${phase.duration_days} days`;
}

/** An item field's value as one short string, for the "x → y" line. */
function fieldText(item: ProtocolItem, field: ItemField): string {
  if (field === 'cadence') return cadenceText(item.cadence);
  return item[field] ?? 'none';
}

/**
 * The change set as short lines, newest-version-first in reading order — what
 * the version history draws beside each `change_notes`.
 *
 * Deliberately NOT a sentence generator: each line is one fact, so a save that
 * touched eight things reads as eight lines rather than as a paragraph that
 * buries the seventh.
 */
export function diffLines(diff: ContentDiff): string[] {
  const lines: string[] = [];
  for (const phase of diff.phases) {
    const name =
      phase.after?.title ?? phase.before?.title ?? (diff.phases.length > 1 ? 'Phase' : null);
    const prefix = name ? `${name}: ` : '';
    if (phase.kind === 'added' && diff.phases.length > 1) {
      lines.push(`${name ?? 'Phase'} added (${phaseLengthText(phase.after!)})`);
    } else if (phase.kind === 'removed') {
      lines.push(`${name ?? 'Phase'} removed`);
    } else {
      if (phase.titleChanged) {
        lines.push(`Renamed ${phase.before?.title ?? 'the phase'} → ${phase.after?.title ?? 'untitled'}`);
      }
      if (phase.durationChanged) {
        lines.push(`${prefix}length ${phaseLengthText(phase.before!)} → ${phaseLengthText(phase.after!)}`);
      }
    }
    for (const item of phase.items) {
      if (item.kind === 'added') lines.push(`${prefix}added ${item.after.title}`);
      else if (item.kind === 'removed') lines.push(`${prefix}removed ${item.before.title}`);
      else if (item.kind === 'changed') {
        for (const field of item.fields) {
          if (field === 'title') {
            lines.push(`${prefix}renamed ${item.before.title} → ${item.after.title}`);
          } else {
            lines.push(
              `${prefix}${item.after.title}: ${FIELD_LABEL[field]} ${fieldText(item.before, field)} → ${fieldText(item.after, field)}`
            );
          }
        }
      }
    }
  }
  return lines;
}

/** How each field is named in a diff line. Whole words, no column names. */
const FIELD_LABEL: Record<Exclude<ItemField, 'title'>, string> = {
  scheduled_time: 'time',
  dose: 'dose',
  notes: 'note',
  cadence: 'cadence',
};
