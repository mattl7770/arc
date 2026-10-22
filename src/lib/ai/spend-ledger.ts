/**
 * The spend ledger — what ARC spends on the model, by day and by call type
 * (2026-10-21, Track 0 item 2; docs/ai-coach.md "The spend ledger").
 *
 * Before this nothing recorded it. The chat's usage caption was computed in
 * memory and dropped with the bubble, and the passes and one-shot calls
 * (estimates, imports, lab parses, photo readings, report reads…) recorded
 * nothing at all — so "what does the Coach cost me?" had no answer in the app,
 * and the usage policy that is to come (Track 1) would have had no budget to
 * read.
 *
 * ## Shape, and why it is aggregates
 *
 * One bucket per (logical day, call type), summing calls, the four token
 * counts, web searches and estimated USD. Not one row per call: the owner asked
 * "what did today / this week / this month cost, and on what", which a daily
 * aggregate answers exactly, and a per-call log would grow without bound in a
 * JSON column every preference read parses. It lives in `users.preferences`
 * under {@link LEDGER_KEY} — no migration — and keeps {@link KEEP_DAYS} days.
 *
 * ## It is an ESTIMATE, and says so
 *
 * The USD figures are the app's own price table (src/lib/ai/cost.ts) applied
 * to the usage the API reported. They are not the invoice: a price can drift,
 * and a call whose model has no price is counted (`unpriced`) but adds no
 * dollars — never a guessed figure. Every rendering says "est.".
 *
 * ## Pure
 *
 * Everything here is a function of a ledger value; the read/write and the
 * sink live in src/lib/ai/spend-store.ts. Headless-tested in
 * db/spend-ledger.test.mjs.
 */
import { shiftISODate } from '@/lib/db/date';

import { isModelCallType, MODEL_CALL_TYPES, type ModelCallType } from './call-types';
import type { ModelCallRecord } from './model-client';

/** The `users.preferences` key the ledger lives under. */
export const LEDGER_KEY = 'spendLedger';

/** Days kept, today included. Older days are pruned on every write. */
export const KEEP_DAYS = 120;

/** One (day, call type) total. Short keys: this is parsed on every preference read. */
export type SpendBucket = {
  /** Billed round trips. */
  n: number;
  /** Uncached input, output, cache-read and cache-write tokens. */
  in: number;
  out: number;
  cr: number;
  cw: number;
  /** Provider-side web searches. */
  ws: number;
  /** Estimated USD, summed over the priced calls. */
  usd: number;
  /** Calls whose model had no price — counted, but in no dollar figure. */
  np: number;
  /** Calls per model id. */
  m: Record<string, number>;
};

export type SpendLedger = {
  v: 1;
  /** `YYYY-MM-DD` (the logical day, src/lib/db/date.ts) → call type → bucket. */
  days: Record<string, Partial<Record<ModelCallType, SpendBucket>>>;
};

export const EMPTY_LEDGER: SpendLedger = { v: 1, days: {} };

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function readBucket(raw: unknown): SpendBucket | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const models: Record<string, number> = {};
  if (b.m && typeof b.m === 'object' && !Array.isArray(b.m)) {
    for (const [id, count] of Object.entries(b.m as Record<string, unknown>)) {
      if (finite(count) > 0) models[id] = finite(count);
    }
  }
  return {
    n: finite(b.n),
    in: finite(b.in),
    out: finite(b.out),
    cr: finite(b.cr),
    cw: finite(b.cw),
    ws: finite(b.ws),
    usd: finite(b.usd),
    np: finite(b.np),
    m: models,
  };
}

/**
 * A stored ledger, tolerant of anything: a missing, corrupt or foreign value
 * reads as empty, an unknown day or call type is dropped, a bad number reads 0.
 * The ledger is a convenience the owner reads; it must never be a way to break
 * the screen that reads it.
 */
export function parseLedger(raw: unknown): SpendLedger {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { v: 1, days: {} };
  const days = (raw as Record<string, unknown>).days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) return { v: 1, days: {} };
  const out: SpendLedger = { v: 1, days: {} };
  for (const [day, types] of Object.entries(days as Record<string, unknown>)) {
    if (!DAY_SHAPE.test(day) || !types || typeof types !== 'object' || Array.isArray(types)) {
      continue;
    }
    const kept: Partial<Record<ModelCallType, SpendBucket>> = {};
    for (const [type, bucket] of Object.entries(types as Record<string, unknown>)) {
      const read = readBucket(bucket);
      if (isModelCallType(type) && read) kept[type] = read;
    }
    if (Object.keys(kept).length > 0) out.days[day] = kept;
  }
  return out;
}

/** Round to a millionth of a dollar — enough for a sub-cent call, and short. */
const roundUsd = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

/**
 * The ledger with one billed call added on `day`, and every day older than
 * {@link KEEP_DAYS} pruned. Returns a new value; the input is not touched.
 */
export function recordInLedger(
  ledger: SpendLedger,
  record: ModelCallRecord,
  day: string
): SpendLedger {
  const type: ModelCallType = isModelCallType(record.callType) ? record.callType : 'other';
  const previous = ledger.days[day]?.[type];
  const u = record.usage;
  const bucket: SpendBucket = {
    n: (previous?.n ?? 0) + 1,
    in: (previous?.in ?? 0) + finite(u.inputTokens),
    out: (previous?.out ?? 0) + finite(u.outputTokens),
    cr: (previous?.cr ?? 0) + finite(u.cacheReadTokens),
    cw: (previous?.cw ?? 0) + finite(u.cacheWriteTokens),
    ws: (previous?.ws ?? 0) + finite(u.webSearchRequests),
    usd: roundUsd((previous?.usd ?? 0) + (record.usd === null ? 0 : finite(record.usd))),
    np: (previous?.np ?? 0) + (record.usd === null ? 1 : 0),
    m: { ...(previous?.m ?? {}), [record.model]: (previous?.m?.[record.model] ?? 0) + 1 },
  };
  const next: SpendLedger = {
    v: 1,
    days: { ...ledger.days, [day]: { ...(ledger.days[day] ?? {}), [type]: bucket } },
  };
  return pruneLedger(next, day);
}

/** The ledger without any day older than `keepDays` days before `today`. */
export function pruneLedger(ledger: SpendLedger, today: string, keepDays = KEEP_DAYS): SpendLedger {
  const oldest = shiftISODate(today, -(keepDays - 1));
  const days: SpendLedger['days'] = {};
  for (const [day, types] of Object.entries(ledger.days)) {
    if (day >= oldest) days[day] = types;
  }
  return { v: 1, days };
}

/** One window's totals. */
export type SpendTotals = {
  calls: number;
  usd: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
};

const ZERO_TOTALS: SpendTotals = {
  calls: 0,
  usd: 0,
  unpriced: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearches: 0,
};

function addBucket(totals: SpendTotals, b: SpendBucket): SpendTotals {
  return {
    calls: totals.calls + b.n,
    usd: roundUsd(totals.usd + b.usd),
    unpriced: totals.unpriced + b.np,
    inputTokens: totals.inputTokens + b.in,
    outputTokens: totals.outputTokens + b.out,
    cacheReadTokens: totals.cacheReadTokens + b.cr,
    cacheWriteTokens: totals.cacheWriteTokens + b.cw,
    webSearches: totals.webSearches + b.ws,
  };
}

/** Totals over the days that pass `inWindow`, overall and per call type. */
function totalsWhere(
  ledger: SpendLedger,
  inWindow: (day: string) => boolean
): { all: SpendTotals; byType: Partial<Record<ModelCallType, SpendTotals>> } {
  let all = ZERO_TOTALS;
  const byType: Partial<Record<ModelCallType, SpendTotals>> = {};
  for (const [day, types] of Object.entries(ledger.days)) {
    if (!inWindow(day)) continue;
    for (const [type, bucket] of Object.entries(types) as [ModelCallType, SpendBucket][]) {
      all = addBucket(all, bucket);
      byType[type] = addBucket(byType[type] ?? ZERO_TOTALS, bucket);
    }
  }
  return { all, byType };
}

/**
 * Estimated USD spent on `today` (a logical day, `YYYY-MM-DD`), every call
 * type together.
 *
 * THE function the usage policy reads for its soft daily budget
 * (docs/spikes/chief-of-staff-release.md, Track 1). Pure, so the policy can be
 * tested against a literal ledger; priced calls only, so a model with no price
 * can never push the day over a budget on a guess.
 */
export function spentToday(ledger: SpendLedger, today: string): number {
  return totalsWhere(ledger, (day) => day === today).all.usd;
}

/** One call type's line on the usage screen. */
export type SpendByType = { type: ModelCallType; totals: SpendTotals };

/** What Settings › Coach usage shows. */
export type SpendSummary = {
  today: SpendTotals;
  /** Today and the six days before it. */
  last7: SpendTotals;
  /** The calendar month `today` falls in, to date. */
  month: SpendTotals;
  /** This month, by call type, most expensive first (then most calls). */
  monthByType: SpendByType[];
  /** How many days the ledger holds, and the first of them — so the screen
   *  can say "since 21 Oct" rather than imply a whole month it never saw. */
  daysRecorded: number;
  firstDay: string | null;
};

/** The ledger, summarised for the screen. Pure. */
export function summarizeLedger(ledger: SpendLedger, today: string): SpendSummary {
  const weekStart = shiftISODate(today, -6);
  const monthPrefix = today.slice(0, 7);
  const month = totalsWhere(ledger, (day) => day.startsWith(monthPrefix) && day <= today);
  const monthByType = MODEL_CALL_TYPES.flatMap((type) => {
    const totals = month.byType[type];
    return totals && totals.calls > 0 ? [{ type, totals }] : [];
  }).sort((a, b) => b.totals.usd - a.totals.usd || b.totals.calls - a.totals.calls);
  const days = Object.keys(ledger.days).sort();
  return {
    today: totalsWhere(ledger, (day) => day === today).all,
    last7: totalsWhere(ledger, (day) => day >= weekStart && day <= today).all,
    month: month.all,
    monthByType,
    daysRecorded: days.length,
    firstDay: days[0] ?? null,
  };
}

/**
 * USD at a glance, never more precision than is real: "$0.00" only for a true
 * zero, "<$0.01" for a real fraction of a cent, cents otherwise.
 */
export function formatUsd(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
