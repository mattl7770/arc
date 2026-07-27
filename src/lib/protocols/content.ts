/**
 * Reading and shaping `protocol_versions.content` JSON.
 *
 * The DB only guarantees `json_valid(content)` — the *shape* is this module's
 * contract. Parsing is deliberately forgiving (a version written by an older
 * app or by the Coach must never crash the editor); writing is deliberately
 * strict (normalizeItems produces one canonical shape, so comparing two
 * versions' content is a plain string compare).
 */
import type { ProtocolContent, ProtocolItem } from './types';

/** 'HH:MM' — the same shape the schema GLOB-checks on log_entries. */
const TIME_SHAPE = /^[0-2][0-9]:[0-5][0-9]$/;

function asOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * One canonical item: trimmed title, every optional field explicitly null when
 * absent, keys always in the same order. Both the parser and the editor build
 * items through this, so JSON.stringify on two contents with the same meaning
 * yields the same string (how the editor skips no-op versions).
 */
export function normalizeItem(item: {
  title: string;
  scheduled_time?: string | null;
  dose?: string | null;
  notes?: string | null;
}): ProtocolItem {
  const time = asOptionalText(item.scheduled_time ?? null);
  return {
    title: item.title.trim(),
    scheduled_time: time !== null && TIME_SHAPE.test(time) ? time : null,
    dose: asOptionalText(item.dose ?? null),
    notes: asOptionalText(item.notes ?? null),
  };
}

/**
 * Parse a stored content document into the typed shape, dropping anything that
 * isn't a titled item. Never throws: malformed or foreign JSON reads as an
 * empty protocol, not a crash.
 */
export function parseProtocolContent(json: string | null | undefined): ProtocolContent {
  if (!json) return { items: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { items: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { items: [] };
  const rawItems = (parsed as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) return { items: [] };

  const items: ProtocolItem[] = [];
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.title !== 'string' || candidate.title.trim() === '') continue;
    items.push(
      normalizeItem({
        title: candidate.title,
        scheduled_time:
          typeof candidate.scheduled_time === 'string' ? candidate.scheduled_time : null,
        dose: typeof candidate.dose === 'string' ? candidate.dose : null,
        notes: typeof candidate.notes === 'string' ? candidate.notes : null,
      })
    );
  }
  return { items };
}
