/**
 * How a knowledge entry says where it came from (docs/knowledge-subapp.md §3).
 *
 * Shared by the hub's row sub-line and the reader's footer so the two can never
 * describe the same document differently — a provenance line that disagrees with
 * itself across two screens is worse than none, because the reader has no way to
 * tell which one is the lie.
 *
 * Pure string work: no DB, no network. The URL is only ever DISPLAYED and (from
 * the reader) handed to `Linking` — nothing here fetches.
 */
import type { KnowledgeEntryRow } from '@/lib/db/repositories/knowledge';

/** The bare host of a URL, for attribution. Null when it isn't one. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase().replace(/^www\./, '') : null;
}

/**
 * The hub's one-line provenance: the mechanism, not the table. "imported ·
 * outlive.com" is the only part that changes how the words below it should be
 * read.
 */
export function provenanceLine(entry: KnowledgeEntryRow): string {
  if (entry.source === 'import') {
    const host = hostOf(entry.source_url);
    return host ? `imported · ${host}` : 'imported';
  }
  if (entry.source === 'coach') return 'saved from a Coach conversation';
  return 'written by you';
}

/**
 * The reader's fuller footer, set in mono — a provenance stamp is a record of
 * where a document came from and when, which is measurement, not speech.
 *
 * Dates are the ISO day off `created_at`; "since" rather than "on" for a
 * hand-written entry, because a document you keep editing has no single date it
 * was written.
 */
export function provenanceFooter(entry: KnowledgeEntryRow): string {
  const day = entry.created_at.slice(0, 10);
  if (entry.source === 'import') {
    const parts = ['Imported'];
    const host = hostOf(entry.source_url);
    if (host) parts.push(host);
    if (entry.source_author) parts.push(entry.source_author);
    parts.push(day);
    return parts.join(' · ');
  }
  if (entry.source === 'coach') return `Saved from a Coach conversation · ${day}`;
  return `Written by you · since ${day}`;
}
