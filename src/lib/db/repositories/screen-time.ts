/**
 * Screen time's data layer — one number per day in, the record and the Undo out.
 *
 * ## The store is the one `hrv 48` uses
 *
 * A `wearable_data` row: `metric_type = 'screen_time_min'`, `unit = 'min'`,
 * `source_device = 'manual'`, `source_raw_id` NULL. No migration: the metric
 * type is free text and `manual` is already an allowed source (0021). The row
 * reads back through the keypad's line (`recentSummary`) and the Coach's metric
 * discovery (read-tools.ts), and one declaration in src/lib/log/metrics.ts
 * names it. It is deliberately NOT in the Log feed (`listEntriesOn`): a day's
 * total typed the next morning has no capture time on the day it is about.
 *
 * ## One row per day, and the newest write wins
 *
 * Water is one row per capture because a day of water IS several captures. A
 * day of screen time is one fact, read off one screen, so {@link
 * recordScreenTime} DELETES whatever manual row the day holds and inserts the
 * new one, in one transaction. "A second entry for the same day replaces the
 * first" is therefore true of the table, not only of a screen that happens to
 * sum the right way.
 *
 * ## Where a write came from, and what it replaced — in the row's own metadata
 *
 * `source_device` is a CHECK-constrained vocabulary with no word for a Shortcut,
 * and widening it is a table rebuild. So provenance rides in `metadata`, which
 * is free JSON: `{"via":"typed"}` or `{"via":"shortcuts"}`.
 *
 * The same JSON carries `replaced` — each row the write removed, as its id,
 * value, created_at and door. That is what makes Undo a restore rather than a
 * delete: {@link undoScreenTime} removes the new row and puts the old one back,
 * id, value, timestamp and door included. And because it lives in the row
 * rather than in a screen's memory, the Undo outlives the process — which is
 * the point for a write a Shortcut made at 23:55 while the owner was asleep
 * and iOS reclaimed the app before he opened it again.
 *
 * **Undo is one level deep, and that is what keeps the row small.** A snapshot
 * does not carry the snapshot's own `replaced`. The first build did — each
 * write stored the previous row's metadata whole, as a string — and every
 * level re-escaped the one below it, so the metadata DOUBLED with each
 * replace: 15 bytes, then 863 after five writes to a day, 3 MB after
 * eighteen, until `JSON.stringify` threw and the day could never be saved
 * again. Every screen offers exactly one Undo (the newest write's), so the
 * chain bought nothing a person could reach. Now a row's metadata is bounded
 * by the number of rows it replaced, which is one.
 *
 * ## A repeated write is not a second write
 *
 * The same number from the same door for a day that already holds it writes
 * nothing and reports `wrote: false`. A link a Shortcut opens twice, or a
 * screen that mounts twice, therefore leaves one row whose `replaced` still
 * names what the FIRST write took off the record — not a copy of itself.
 *
 * ## The Shortcuts cursor
 *
 * Two facts about the link are not facts about any one row, so they live in
 * the integration-cursor KV (`health_sync_state`, 0021; free JSON under a key
 * with no CHECK, which workout-ingest.ts already uses the same way) under
 * `screen_time`:
 *
 *   - **`lastLink`** — the last valid link a Shortcut opened. Settings reads
 *     "has a Shortcut ever sent a number" from here, because the rows cannot
 *     say it: a typed correction replaces the Shortcut's row the next morning.
 *   - **`receiptSeenThrough`** — the newest write the Log tab's receipt has
 *     already shown, so a Shortcuts write is reported once
 *     (src/lib/screen-time/entry.ts `pickReceipt`).
 *
 * Depends only on the {@link Database} interface, so db/log.test.mjs runs it
 * against node:sqlite with the real migrations.
 */
import type { Database, Scalar } from '../database';
import { newId } from '../id';
import { isScreenTimeMinutes, SCREEN_TIME_METRIC } from '@/lib/screen-time/entry';

/** Which door a number came through. */
export type ScreenTimeVia = 'typed' | 'shortcuts';

/** One day's number as the screens and the Coach read it. */
export type ScreenTimeEntry = {
  id: string;
  /** The local day it is filed under, `YYYY-MM-DD`. */
  date: string;
  /** Whole minutes. */
  minutes: number;
  via: ScreenTimeVia;
  /** ISO instant the row was written. */
  createdAt: string;
  /**
   * What this write took off the record, oldest first — each as the number and
   * the door. Empty for a first entry. Undo puts these back.
   */
  replaced: { minutes: number; via: ScreenTimeVia }[];
};

/** A write's outcome: the entry now on record, and whether this call wrote it. */
export type ScreenTimeWrite = ScreenTimeEntry & { wrote: boolean };

type Row = {
  id: string;
  date: string;
  value: number;
  created_at: string;
  metadata: string;
};

/**
 * A removed row, kept so Undo can put it back: its id, value, timestamp and
 * door — and NOT its own `replaced` (the header says why).
 */
type Snapshot = { id: string; value: number; created_at: string; via: ScreenTimeVia };

type Meta = { via?: unknown; replaced?: unknown };

function readMeta(text: string): Meta {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Meta) : {};
  } catch {
    return {};
  }
}

function viaOf(meta: Meta): ScreenTimeVia {
  return meta.via === 'shortcuts' ? 'shortcuts' : 'typed';
}

function snapshotsOf(meta: Meta): Snapshot[] {
  if (!Array.isArray(meta.replaced)) return [];
  const out: Snapshot[] = [];
  for (const s of meta.replaced as unknown[]) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (
      typeof o.id !== 'string' ||
      typeof o.value !== 'number' ||
      typeof o.created_at !== 'string'
    ) {
      continue;
    }
    out.push({
      id: o.id,
      value: o.value,
      created_at: o.created_at,
      via: o.via === 'shortcuts' ? 'shortcuts' : 'typed',
    });
  }
  return out;
}

function toEntry(row: Row): ScreenTimeEntry {
  const meta = readMeta(row.metadata);
  return {
    id: row.id,
    date: row.date,
    minutes: row.value,
    via: viaOf(meta),
    createdAt: row.created_at,
    replaced: snapshotsOf(meta).map((s) => ({ minutes: s.value, via: s.via })),
  };
}

const COLUMNS = 'id, date, value, created_at, metadata';
/** The rows this module owns: typed or linked, never a device's. */
const OWNED = `metric_type = '${SCREEN_TIME_METRIC}' AND source_device = 'manual'`;

function rowsOn(db: Database, date: string): Row[] {
  return db.all<Row>(
    `SELECT ${COLUMNS} FROM wearable_data WHERE ${OWNED} AND date = ?
     ORDER BY created_at ASC, rowid ASC`,
    [date]
  );
}

function rowById(db: Database, id: string): Row | undefined {
  return db.get<Row>(`SELECT ${COLUMNS} FROM wearable_data WHERE ${OWNED} AND id = ?`, [id]);
}

/**
 * Put `minutes` on the record for `date`, replacing whatever the day held.
 * Throws on a value {@link isScreenTimeMinutes} refuses or a malformed date —
 * every caller has already validated, so reaching the throw is a bug, and the
 * schema's own date CHECK would refuse it anyway.
 */
export function recordScreenTime(
  db: Database,
  date: string,
  minutes: number,
  via: ScreenTimeVia
): ScreenTimeWrite {
  if (!isScreenTimeMinutes(minutes)) {
    throw new Error(`recordScreenTime: minutes must be a whole number 1–1440, got ${minutes}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`recordScreenTime: date must be YYYY-MM-DD, got ${date}`);
  }

  const prior = rowsOn(db, date);
  const only = prior.length === 1 ? prior[0]! : null;
  if (only && only.value === minutes && viaOf(readMeta(only.metadata)) === via) {
    return { ...toEntry(only), wrote: false };
  }

  const id = newId(db);
  const replaced: Snapshot[] = prior.map((r) => ({
    id: r.id,
    value: r.value,
    created_at: r.created_at,
    via: viaOf(readMeta(r.metadata)),
  }));
  const metadata = JSON.stringify(replaced.length > 0 ? { via, replaced } : { via });
  db.transaction(() => {
    db.run(`DELETE FROM wearable_data WHERE ${OWNED} AND date = ?`, [date]);
    db.run(
      `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device, metadata)
       VALUES (?, ?, ?, ?, 'min', 'manual', ?)`,
      [id, date, SCREEN_TIME_METRIC, minutes, metadata]
    );
  });
  return { ...toEntry(rowById(db, id)!), wrote: true };
}

/**
 * Take a write back: remove the row `id` and restore the rows it replaced —
 * id, value, timestamp and door. One level: a restored row carries no Undo of
 * its own (the header says why). Returns false — and changes nothing — when
 * `id` is no longer on record (already undone, or replaced by a newer write
 * since the receipt was drawn), so an Undo can only ever take back the write
 * it names.
 */
export function undoScreenTime(db: Database, id: string): boolean {
  const row = rowById(db, id);
  if (!row) return false;
  const restore = snapshotsOf(readMeta(row.metadata));
  db.transaction(() => {
    db.run(`DELETE FROM wearable_data WHERE ${OWNED} AND id = ?`, [id]);
    for (const s of restore) {
      const params: Scalar[] = [
        s.id,
        row.date,
        SCREEN_TIME_METRIC,
        s.value,
        JSON.stringify({ via: s.via }),
        s.created_at,
      ];
      db.run(
        `INSERT INTO wearable_data
           (id, date, metric_type, value, unit, source_device, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'min', 'manual', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        params
      );
    }
  });
  return true;
}

/** One write by id, or null once it has been undone or replaced. */
export function getScreenTime(db: Database, id: string): ScreenTimeEntry | null {
  const row = rowById(db, id);
  return row ? toEntry(row) : null;
}

/** The number on record for one day, or null. */
export function screenTimeOn(db: Database, date: string): ScreenTimeEntry | null {
  const rows = rowsOn(db, date);
  const last = rows[rows.length - 1];
  return last ? toEntry(last) : null;
}

/**
 * The most recent day on record, on or before `onOrBefore` when given — the
 * Data row's headline and the Coach's "latest" read. A future-dated row (clock
 * skew, a hand-edited database) is not "the latest" of anything.
 */
export function latestScreenTime(db: Database, onOrBefore?: string): ScreenTimeEntry | null {
  const row = onOrBefore
    ? db.get<Row>(
        `SELECT ${COLUMNS} FROM wearable_data WHERE ${OWNED} AND date <= ?
         ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 1`,
        [onOrBefore]
      )
    : db.get<Row>(
        `SELECT ${COLUMNS} FROM wearable_data WHERE ${OWNED}
         ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 1`
      );
  return row ? toEntry(row) : null;
}

/**
 * The recorded days in `[since, until]`, oldest first — ONLY days with a
 * number. A day with none is unknown, not zero, so nothing here fills it: a
 * sparkline drawn from this has a bar per recorded day and no stand-in zeros.
 */
export function screenTimeSeries(
  db: Database,
  since: string,
  until: string
): { date: string; minutes: number }[] {
  return db
    .all<{ date: string; value: number }>(
      `SELECT date, value FROM wearable_data WHERE ${OWNED} AND date >= ? AND date <= ?
       ORDER BY date ASC, created_at ASC, rowid ASC`,
      [since, until]
    )
    .map((r) => ({ date: r.date, minutes: r.value }));
}

/**
 * The newest Shortcuts write for a day on or after `since`, or null — the
 * candidate the Log tab's receipt considers for a number an automation filed
 * while the app was closed. Whether it is still news is `pickReceipt`'s call
 * (src/lib/screen-time/entry.ts), against {@link receiptSeenThrough}.
 */
export function recentShortcutsWrite(db: Database, since: string): ScreenTimeEntry | null {
  const row = db.get<Row>(
    `SELECT ${COLUMNS} FROM wearable_data
     WHERE ${OWNED} AND date >= ? AND json_extract(metadata, '$.via') = 'shortcuts'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [since]
  );
  return row ? toEntry(row) : null;
}

// --- The Shortcuts cursor (health_sync_state, key 'screen_time') -------------

const STATE_KEY = 'screen_time';

/** The last valid link a Shortcut opened: when, and what it carried. */
export type ShortcutsLink = { at: string; date: string; minutes: number };

type ScreenTimeState = { lastLink: ShortcutsLink | null; receiptSeenThrough: string | null };

function readState(db: Database): ScreenTimeState {
  const state: ScreenTimeState = { lastLink: null, receiptSeenThrough: null };
  const row = db.get<{ value: string }>('SELECT value FROM health_sync_state WHERE key = ?', [
    STATE_KEY,
  ]);
  if (!row) return state;
  const parsed = readMeta(row.value) as Record<string, unknown>;
  const link = parsed.lastLink as Record<string, unknown> | null | undefined;
  if (
    link &&
    typeof link === 'object' &&
    typeof link.at === 'string' &&
    typeof link.date === 'string' &&
    typeof link.minutes === 'number'
  ) {
    state.lastLink = { at: link.at, date: link.date, minutes: link.minutes };
  }
  if (typeof parsed.receiptSeenThrough === 'string') {
    state.receiptSeenThrough = parsed.receiptSeenThrough;
  }
  return state;
}

function writeState(db: Database, state: ScreenTimeState): void {
  db.run(
    `INSERT INTO health_sync_state (id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [newId(db), STATE_KEY, JSON.stringify(state)]
  );
}

/**
 * Record that a Shortcut opened a valid link — whether or not it wrote (a
 * repeat, or one waiting on a confirm card, still proves the automation ran).
 * `at` defaults to now, in the same ISO shape as the rows' `created_at`.
 */
export function noteShortcutsLink(
  db: Database,
  date: string,
  minutes: number,
  at: string = new Date().toISOString()
): void {
  writeState(db, { ...readState(db), lastLink: { at, date, minutes } });
}

/** The last valid link a Shortcut opened, or null if none ever has. */
export function lastShortcutsLink(db: Database): ShortcutsLink | null {
  return readState(db).lastLink;
}

/** The newest write the Log tab's receipt has already shown, or null. */
export function receiptSeenThrough(db: Database): string | null {
  return readState(db).receiptSeenThrough;
}

/** Advance the receipt's cursor to `createdAt`. Never moves it backwards. */
export function markReceiptSeen(db: Database, createdAt: string): void {
  const state = readState(db);
  if (state.receiptSeenThrough !== null && state.receiptSeenThrough >= createdAt) return;
  writeState(db, { ...state, receiptSeenThrough: createdAt });
}
