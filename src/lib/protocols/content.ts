/**
 * Reading, shaping and checking `protocol_versions.content` JSON.
 *
 * The DB only guarantees `json_valid(content)` — the *shape* is this module's
 * contract. Three responsibilities, deliberately separate:
 *
 *   - **{@link parseProtocolContent} is forgiving.** A version written by an
 *     older app, by the Coach, or by a hand-edited export must never crash a
 *     screen. Anything it cannot read degrades to the safest legible thing;
 *     nothing throws. It ALSO owns the v1 → v2 normalisation, so no caller
 *     downstream ever sees a v1 document.
 *   - **{@link normalizeContent} is canonical.** One shape, one key order, so
 *     `JSON.stringify` on two contents with the same meaning yields the same
 *     string — which is how the editor skips no-op versions and how the diff
 *     decides a field is unchanged.
 *   - **{@link validateContent} is strict.** It is the gate the editor's Save
 *     and the Coach's `update_protocol` both pass through, and it returns a
 *     sentence a human (or a model) can act on rather than a boolean.
 *
 * ## The legacy read path is not optional
 *
 * Every version already on the owner's device is v1 — `{ items: [...] }`, no
 * `schema` key — and `protocol_versions` is IMMUTABLE, so those rows can never
 * be rewritten. They are normalised on read into one open-ended phase whose
 * items are all `daily`, which is exactly what the old generator did with them,
 * so nothing about the owner's existing days changes shape under them.
 *
 * The ids for those normalised items are DERIVED, not generated: the same
 * stored v1 bytes must always yield the same ids, or every read of an immutable
 * old version would invent new identities and a diff between two v1 versions
 * would read as "everything was replaced".
 */
import { parseCadenceText } from './cadence';
import type { Cadence, ProtocolContent, ProtocolItem, ProtocolPhase } from './types';

/**
 * A real 24h clock time, 'HH:MM' zero-padded — deliberately STRICTER than the
 * schema's `[0-9][0-9]:[0-9][0-9]` GLOB on log_entries (which would admit
 * '99:99') and exactly as strict as the editor's own time validation, so
 * content from any author round-trips through the editor without tripping it.
 */
const TIME_SHAPE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The default for anything that does not say otherwise — including all of v1. */
export const DAILY: Cadence = { kind: 'daily' };

function asOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * FNV-1a, 32-bit, as 8 lowercase hex characters.
 *
 * Used only to DERIVE ids for legacy content, where the requirement is
 * determinism rather than unpredictability: the same bytes must give the same
 * id on every device, forever. Real ids come from src/lib/db/id.ts (SQLite
 * `randomblob`), because Hermes has no `crypto`.
 */
function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The single phase a normalised v1 document collapses into. */
export const LEGACY_PHASE_ID = 'v1-phase';

/** The derived id of the `index`-th item of a v1 document titled `title`. */
export function legacyItemId(index: number, title: string): string {
  return `v1-${index}-${hash32(`${index} ${title.trim()}`)}`;
}

/**
 * One canonical cadence. Anything unreadable becomes `daily` — the v1
 * behaviour, and the only failure mode that keeps a broken document WORKING:
 * an item that lands too often is visible and can be fixed, an item that
 * silently stops landing is not. {@link validateContent} is what stops such a
 * cadence being authored in the first place.
 */
export function normalizeCadence(value: unknown): Cadence {
  if (typeof value === 'string') return parseCadenceText(value) ?? DAILY;
  if (value === null || typeof value !== 'object') return DAILY;
  const raw = value as Record<string, unknown>;
  switch (raw['kind']) {
    case 'daily':
      return DAILY;
    case 'weekdays': {
      const days: unknown[] = Array.isArray(raw['days']) ? raw['days'] : [];
      const clean = [
        ...new Set(
          days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)
        ),
      ].sort((a, b) => a - b);
      return clean.length === 0 ? DAILY : { kind: 'weekdays', days: clean };
    }
    case 'every_n_days': {
      const n = raw['n'];
      return Number.isInteger(n) && (n as number) >= 2 && (n as number) <= 365
        ? { kind: 'every_n_days', n: n as number }
        : DAILY;
    }
    case 'quota': {
      const per = raw['per_week'];
      return Number.isInteger(per) && (per as number) >= 1 && (per as number) <= 7
        ? { kind: 'quota', per_week: per as number }
        : DAILY;
    }
    default:
      return DAILY;
  }
}

/** What {@link normalizeItem} accepts — everything optional except identity. */
export type ItemDraft = {
  id: string;
  title: string;
  scheduled_time?: string | null;
  dose?: string | null;
  notes?: string | null;
  cadence?: unknown;
};

/**
 * One canonical item: trimmed title, every optional field explicitly null when
 * absent, keys always in the same order. Both the parser and the editor build
 * items through this, so JSON.stringify on two contents with the same meaning
 * yields the same string.
 */
export function normalizeItem(item: ItemDraft): ProtocolItem {
  const time = asOptionalText(item.scheduled_time ?? null);
  return {
    id: item.id,
    title: item.title.trim(),
    scheduled_time: time !== null && TIME_SHAPE.test(time) ? time : null,
    dose: asOptionalText(item.dose ?? null),
    notes: asOptionalText(item.notes ?? null),
    cadence: normalizeCadence(item.cadence),
  };
}

/** A positive whole number of days, or null. Anything else reads as null. */
function normalizeDuration(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : null;
}

/** An open-ended phase with no items — the shape an empty protocol reads as. */
function emptyPhase(id: string): ProtocolPhase {
  return { id, title: null, duration_days: null, items: [] };
}

/** An empty schema-2 document — one open-ended phase, no items. */
export function emptyContent(): ProtocolContent {
  return { schema: 2, phases: [emptyPhase(LEGACY_PHASE_ID)] };
}

/** What {@link normalizeContent} accepts. */
export type ContentDraft = {
  phases: {
    id: string;
    title?: string | null;
    duration_days?: number | null;
    items: ItemDraft[];
  }[];
};

/**
 * The canonical content document: at least one phase, canonical items, keys in
 * a fixed order. It does NOT enforce the mid-phase open-ended rule — that is
 * {@link validateContent}'s job, because a stored document that breaks it must
 * still be readable.
 */
export function normalizeContent(content: ContentDraft): ProtocolContent {
  const phases: ProtocolPhase[] = content.phases.map((phase) => ({
    id: phase.id,
    title: asOptionalText(phase.title ?? null),
    duration_days: normalizeDuration(phase.duration_days ?? null),
    items: phase.items.map(normalizeItem),
  }));
  return { schema: 2, phases: phases.length > 0 ? phases : [emptyPhase(LEGACY_PHASE_ID)] };
}

/** Every item of every phase, in document order. */
export function allItems(content: ProtocolContent): ProtocolItem[] {
  return content.phases.flatMap((phase) => phase.items);
}

/** Drop anything that is not an object carrying a non-empty string title. */
function titledObjects(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const title = (entry as Record<string, unknown>)['title'];
    return typeof title === 'string' && title.trim() !== '';
  });
}

/** One raw item object → a canonical item, falling back to a derived id. */
function itemFrom(raw: Record<string, unknown>, index: number, cadence: unknown): ProtocolItem {
  const title = raw['title'] as string;
  return normalizeItem({
    id: typeof raw['id'] === 'string' && raw['id'] !== '' ? raw['id'] : legacyItemId(index, title),
    title,
    scheduled_time: typeof raw['scheduled_time'] === 'string' ? raw['scheduled_time'] : null,
    dose: typeof raw['dose'] === 'string' ? raw['dose'] : null,
    notes: typeof raw['notes'] === 'string' ? raw['notes'] : null,
    cadence,
  });
}

/**
 * Parse a stored content document into the canonical schema-2 shape. Never
 * throws: malformed or foreign JSON reads as an empty protocol, not a crash.
 *
 * The v1 branch is load-bearing and permanent — `protocol_versions` rows are
 * immutable, so v1 documents exist for as long as the owner's history does.
 */
export function parseProtocolContent(json: string | null | undefined): ProtocolContent {
  if (!json) return emptyContent();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return emptyContent();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyContent();
  const doc = parsed as Record<string, unknown>;

  // --- schema 2: ordered phases ---------------------------------------------
  if (Array.isArray(doc['phases'])) {
    const phases: ProtocolPhase[] = [];
    for (const entry of doc['phases']) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const phase = entry as Record<string, unknown>;
      // A phase with no identity cannot be matched by the diff or addressed by
      // the editor, so it is skipped rather than given an invented id that
      // would differ on every read of the same immutable row.
      if (typeof phase['id'] !== 'string' || phase['id'] === '') continue;
      phases.push({
        id: phase['id'],
        title: asOptionalText(phase['title'] ?? null),
        duration_days: normalizeDuration(phase['duration_days'] ?? null),
        items: titledObjects(phase['items']).map((raw, i) => itemFrom(raw, i, raw['cadence'])),
      });
    }
    return { schema: 2, phases: phases.length > 0 ? phases : [emptyPhase(LEGACY_PHASE_ID)] };
  }

  // --- schema 1: one flat item list, everything daily, one open-ended phase --
  return {
    schema: 2,
    phases: [
      {
        id: LEGACY_PHASE_ID,
        title: null,
        duration_days: null,
        items: titledObjects(doc['items']).map((raw, i) => itemFrom(raw, i, DAILY)),
      },
    ],
  };
}

/**
 * What is wrong with this document, in one sentence a person or a model can
 * act on — or null when nothing is.
 *
 * The two rules that are not merely cosmetic:
 *
 *   - **an open-ended phase must be the last one.** A phase with no duration
 *     never ends, so anything after it is unreachable — a protocol that would
 *     silently never advance to its second half.
 *   - **a `weekdays` cadence must name at least one day.** An empty list means
 *     "never", which is not something a person means to author; the parser's
 *     forgiving read turns it into `daily`, and this is what stops it reaching
 *     storage in the first place.
 */
export function validateContent(content: ProtocolContent): string | null {
  if (content.phases.length === 0) return 'A protocol needs at least one phase.';
  for (let i = 0; i < content.phases.length; i++) {
    const phase = content.phases[i]!;
    const last = i === content.phases.length - 1;
    if (!last && phase.duration_days === null) {
      return `Phase ${i + 1} has no length, so nothing after it would ever start. Give it a number of days, or make it the last phase.`;
    }
    for (const item of phase.items) {
      if (item.title.trim() === '') return `An item in phase ${i + 1} has no name.`;
      if (item.cadence.kind === 'weekdays' && item.cadence.days.length === 0) {
        return `"${item.title}" is set to specific days but names none.`;
      }
    }
  }
  return null;
}
