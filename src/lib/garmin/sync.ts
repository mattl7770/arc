/**
 * The Garmin Personal API sync — orchestration over the one client
 * (./client.ts), the pure mappers (./mapping.ts) and the wearables repository
 * (docs/wearables-subapp.md §26).
 *
 * ## When it runs
 *
 * On app open and on every return to the foreground, once the app lock has
 * opened (src/hooks/use-garmin.ts, mounted at the root beside the Coach pass),
 * throttled to the Apple Health sync's own cadence
 * ({@link AUTO_SYNC_THROTTLE_MIN}), and from Settings › Garmin's Sync now and
 * Home's HRV cell. Each pass waits for the Apple Health pass the same
 * foreground started (bounded), so the dedup below sees HealthKit's rows
 * first. Nothing runs without a key, and nothing at all runs in the background:
 * ARC has no background fetch.
 *
 * ## What a pass fetches
 *
 *   1. **Recent** — one request per endpoint covering the last
 *      {@link RECENT_DAYS} days (more after an absence, up to
 *      {@link RECENT_MAX_DAYS}), because Garmin revises last night after a late
 *      band sync.
 *   2. **Backfill** — whatever budget is left goes to older history, in chunks
 *      as large as each endpoint allows (31 days; a year for daily summaries),
 *      back to {@link BACKFILL_DAYS}. The endpoint with the least history
 *      fetched goes next, so the first month fills evenly — Recovery's 30-day
 *      baseline needs every endpoint's first month before it needs anyone's
 *      second.
 *
 * Every request — the token mint included — counts against
 * {@link GARMIN_REQUESTS_PER_PASS}. A first connect therefore takes about two
 * dozen opens to bring a year in; a steady day costs five requests per pass.
 *
 * ## How it stops
 *
 *   - **The key refused (401/403 at the mint, or a 401 a re-mint does not
 *     cure):** the pass stops, the status is `rejected`, automatic passes stop
 *     trying, and Settings › Garmin and Home's HRV cell say so. Saving a new
 *     key clears it.
 *   - **Any other mint failure** (a token reply ARC cannot read): the pass
 *     stops as `error` with no cursor moved — nothing can be read without a
 *     token, and stepping over every request would lose history unread.
 *   - **429/5xx:** the pass stops and the next automatic pass waits —
 *     Retry-After when Garmin sends one, else 15 minutes doubling to a day.
 *   - **Offline:** the pass stops quietly; the next foreground tries again.
 *   - **Any other 4xx** on one request (a 403 on a read included — the mint
 *     would have refused a bad key): that request is skipped and named in
 *     Settings › Garmin, the rest of the pass continues. A backfill chunk Garmin will not serve is
 *     stepped over rather than retried forever. A RECENT window it will not serve is not
 *     coverage: that endpoint's next recent request reaches back to it again (one request,
 *     inside the usual throttle), for up to {@link RECENT_MAX_DAYS} — then stepped over too.
 *   - **A write that throws:** the pass is `error` and throttled, but no cursor and no
 *     `lastSyncedAt` moves — nothing it fetched is on disk, so the next pass asks again.
 *
 * Rows fetched before a stop are still written: what arrived is real.
 */
import type { Database } from '@/lib/db/database';
import { formatLocalDate, shiftISODate } from '@/lib/db/date';
import {
  applyGarminRows,
  deleteSyncStateValue,
  GARMIN_SYNC_KEY,
  getSyncStateValue,
  healthBucketKeys,
  setSyncStateValue,
  type WearableUpsert,
} from '@/lib/db/repositories/wearables';
import { AUTO_SYNC_THROTTLE_MIN, waitForHealthSyncIdle } from '@/lib/health/sync';
import { daysBetween } from '@/lib/protocols/cadence';

import {
  deviceFetch,
  forgetGarminToken,
  GARMIN_REQUESTS_PER_PASS,
  GarminBackoffError,
  GarminBudgetError,
  GarminNetworkError,
  GarminRejectedError,
  GarminRequestError,
  GarminTokenError,
  openGarminSession,
  type GarminFetch,
} from './client';
import { garminKeyStore } from './key-store';
import {
  activityVo2Rows,
  bodyBatteryRows,
  dailySummaryRows,
  dropHealthSupplied,
  HEALTH_SUPPLIED_BY,
  hrvRows,
  sleepRows,
} from './mapping';

/** Days re-fetched on every pass — Garmin revises last night after a late upload. */
export const RECENT_DAYS = 3;
/** The recent window after an absence never exceeds the smallest endpoint range. */
export const RECENT_MAX_DAYS = 31;
/** How far back the backfill reaches. */
export const BACKFILL_DAYS = 365;
/** First automatic wait after a 429/5xx with no Retry-After; doubles each time. */
export const BACKOFF_BASE_MS = 15 * 60 * 1000;
export const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** How long the Coach pass waits for a Garmin pass before going ahead. */
export const GARMIN_SETTLE_TIMEOUT_MS = 10_000;

export type GarminEndpoint = 'hrv' | 'summary' | 'sleep' | 'body_battery' | 'activities';

/** Recent order, and the tie-break order for backfill. HRV first: it is Home's. */
export const GARMIN_ENDPOINTS: readonly GarminEndpoint[] = [
  'hrv',
  'summary',
  'sleep',
  'body_battery',
  'activities',
];

type EndpointSpec = {
  /** The largest inclusive range one request may ask for. */
  maxDays: number;
  request(from: string, to: string): { path: string; query?: Record<string, string | number> };
  map(body: unknown): WearableUpsert[];
};

/**
 * HRV's range limit is undocumented, so it is held to the 31 days the sleep and
 * Body Battery endpoints state; daily summaries state a year.
 */
const ENDPOINTS: Record<GarminEndpoint, EndpointSpec> = {
  hrv: {
    maxDays: 31,
    request: (from, to) => ({ path: `/hrv-service/hrv/daily/${from}/${to}` }),
    map: hrvRows,
  },
  summary: {
    maxDays: 365,
    request: (from, to) => ({
      path: '/usersummary-service/v2/dailysummaries',
      query: { startDate: from, endDate: to },
    }),
    map: dailySummaryRows,
  },
  sleep: {
    maxDays: 31,
    request: (from, to) => ({
      path: '/sleep-service/sleep/dailySleepSummariesByDate',
      query: { startDate: from, endDate: to },
    }),
    map: sleepRows,
  },
  body_battery: {
    maxDays: 31,
    request: (from, to) => ({
      path: '/wellness-service/wellness/bodyBattery/reports/daily',
      query: { startDate: from, endDate: to },
    }),
    map: bodyBatteryRows,
  },
  activities: {
    maxDays: 31,
    request: (from, to) => ({
      path: '/activitylist-service/activities/search/activities',
      query: { startDate: from, endDate: to, start: 0, limit: 100 },
    }),
    map: activityVo2Rows,
  },
};

// --- State --------------------------------------------------------------------

export type GarminStatus = 'never' | 'ok' | 'rejected' | 'backoff' | 'offline' | 'error';

/** The JSON under health_sync_state key 'garmin_personal_api'. Nothing secret. */
export type GarminSyncState = {
  /** The last pass that got through every recent request. Drives the recent window. */
  lastSyncedAt: string | null;
  /** The last pass that started fetching. Drives the throttle. */
  lastAttemptAt: string | null;
  status: GarminStatus;
  /** When Garmin last refused the key. */
  rejectedAt: string | null;
  /** No automatic pass before this instant. */
  backoffUntil: string | null;
  /** Consecutive backoffs, for the doubling. */
  backoffStep: number;
  /** The KEY's expiry, when Garmin's token response states it. */
  keyExpiresAt: string | null;
  /** Per endpoint, the oldest day fetched so far (everything since is in). */
  backfill: Partial<Record<GarminEndpoint, string>>;
  /** Endpoints Garmin would not serve on the last pass (a 4xx), by name. */
  skipped: GarminEndpoint[];
  /**
   * Per endpoint, the first day of a RECENT window Garmin refused (a 4xx) and
   * no pass has read since. That endpoint's next recent request reaches back to
   * it, within {@link RECENT_MAX_DAYS}; older than that it is stepped over, as a
   * refused backfill chunk is. Cleared when the endpoint serves its window.
   */
  refused: Partial<Record<GarminEndpoint, string>>;
};

export function emptyGarminState(): GarminSyncState {
  return {
    lastSyncedAt: null,
    lastAttemptAt: null,
    status: 'never',
    rejectedAt: null,
    backoffUntil: null,
    backoffStep: 0,
    keyExpiresAt: null,
    backfill: {},
    skipped: [],
    refused: {},
  };
}

const STATUSES: readonly GarminStatus[] = [
  'never',
  'ok',
  'rejected',
  'backoff',
  'offline',
  'error',
];
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Corrupt or absent state reads as a fresh link; the next pass self-heals it. */
export function readGarminState(db: Database): GarminSyncState {
  const state = emptyGarminState();
  const raw = getSyncStateValue(db, GARMIN_SYNC_KEY);
  if (raw === null || typeof raw !== 'object') return state;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  state.lastSyncedAt = str(r.lastSyncedAt);
  state.lastAttemptAt = str(r.lastAttemptAt);
  state.rejectedAt = str(r.rejectedAt);
  state.backoffUntil = str(r.backoffUntil);
  state.keyExpiresAt = str(r.keyExpiresAt);
  if (typeof r.status === 'string' && (STATUSES as readonly string[]).includes(r.status)) {
    state.status = r.status as GarminStatus;
  }
  if (typeof r.backoffStep === 'number' && Number.isFinite(r.backoffStep)) {
    state.backoffStep = Math.max(0, Math.floor(r.backoffStep));
  }
  if (r.backfill && typeof r.backfill === 'object') {
    for (const endpoint of GARMIN_ENDPOINTS) {
      const value = (r.backfill as Record<string, unknown>)[endpoint];
      if (typeof value === 'string' && DAY_SHAPE.test(value)) state.backfill[endpoint] = value;
    }
  }
  if (r.refused && typeof r.refused === 'object') {
    for (const endpoint of GARMIN_ENDPOINTS) {
      const value = (r.refused as Record<string, unknown>)[endpoint];
      if (typeof value === 'string' && DAY_SHAPE.test(value)) state.refused[endpoint] = value;
    }
  }
  if (Array.isArray(r.skipped)) {
    state.skipped = r.skipped.filter((e): e is GarminEndpoint =>
      (GARMIN_ENDPOINTS as readonly unknown[]).includes(e)
    );
  }
  return state;
}

function writeGarminState(db: Database, state: GarminSyncState): void {
  setSyncStateValue(db, GARMIN_SYNC_KEY, state);
}

// --- Planning (pure) ----------------------------------------------------------

export type GarminStep = {
  endpoint: GarminEndpoint;
  kind: 'recent' | 'backfill';
  /** Inclusive. */
  from: string;
  to: string;
};

/**
 * The recent window, oldest day first: {@link RECENT_DAYS}, stretched to cover
 * every day since the last full pass, capped at {@link RECENT_MAX_DAYS}.
 * `reset` is true when the absence was longer than the cap — the backfill
 * cursors then restart from the new window, so the days in between are not
 * left as a hole.
 */
export function recentWindow(
  lastSyncedAt: string | null,
  today: string
): { from: string; to: string; reset: boolean } {
  let days = RECENT_DAYS;
  let reset = false;
  if (lastSyncedAt !== null) {
    const at = new Date(lastSyncedAt);
    if (!Number.isNaN(at.getTime())) {
      const gap = daysBetween(formatLocalDate(at), today) + 1;
      if (gap > RECENT_MAX_DAYS) reset = true;
      days = Math.min(RECENT_MAX_DAYS, Math.max(RECENT_DAYS, gap));
    }
  }
  return { from: shiftISODate(today, -(days - 1)), to: today, reset };
}

/**
 * Every request this pass would like to make, in order: the five recent
 * ranges, then up to `backfillSteps` older chunks. The session's budget is
 * what actually stops it, so asking for more than will be served costs nothing.
 *
 * An endpoint whose recent window Garmin refused last time (`state.refused`)
 * asks from that window's first day again — still one request, so a refusal
 * that never lifts costs nothing extra — but never past {@link RECENT_MAX_DAYS}.
 */
export function planGarminPass(
  state: GarminSyncState,
  today: string,
  backfillSteps: number = GARMIN_REQUESTS_PER_PASS
): GarminStep[] {
  const recent = recentWindow(state.lastSyncedAt, today);
  const floor = shiftISODate(today, -(RECENT_MAX_DAYS - 1));
  const steps: GarminStep[] = GARMIN_ENDPOINTS.map((endpoint) => {
    const unread = state.refused[endpoint];
    const from =
      unread !== undefined && unread < recent.from
        ? unread < floor
          ? floor
          : unread
        : recent.from;
    return { endpoint, kind: 'recent', from, to: recent.to };
  });
  const horizon = shiftISODate(today, -(BACKFILL_DAYS - 1));
  const cursors = new Map<GarminEndpoint, string>();
  for (const endpoint of GARMIN_ENDPOINTS) {
    const stored = recent.reset ? undefined : state.backfill[endpoint];
    // Never newer than the recent window's first day: those days are fetched anyway.
    cursors.set(endpoint, stored !== undefined && stored < recent.from ? stored : recent.from);
  }
  for (let i = 0; i < backfillSteps; i++) {
    let next: GarminEndpoint | null = null;
    for (const endpoint of GARMIN_ENDPOINTS) {
      const cursor = cursors.get(endpoint)!;
      if (cursor <= horizon) continue;
      if (next === null || cursor > cursors.get(next)!) next = endpoint;
    }
    if (next === null) break;
    const to = shiftISODate(cursors.get(next)!, -1);
    const earliest = shiftISODate(to, -(ENDPOINTS[next].maxDays - 1));
    const from = earliest < horizon ? horizon : earliest;
    steps.push({ endpoint: next, kind: 'backfill', from, to });
    cursors.set(next, from);
  }
  return steps;
}

/** The wait before the next automatic pass after a 429/5xx. Pure. */
export function backoffDelayMs(step: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null && retryAfterMs > 0) return Math.min(BACKOFF_MAX_MS, retryAfterMs);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, step));
}

/** Whether an automatic (open/foreground) pass should run now. Pure. */
export function shouldAutoSyncGarmin(state: GarminSyncState, now: Date): boolean {
  if (state.status === 'rejected') return false;
  if (state.backoffUntil !== null && Date.parse(state.backoffUntil) > now.getTime()) return false;
  if (state.lastAttemptAt === null) return true;
  const last = Date.parse(state.lastAttemptAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= AUTO_SYNC_THROTTLE_MIN * 60_000;
}

// --- The pass -----------------------------------------------------------------

export type GarminSyncDeps = {
  /** The key, from the Keychain store. */
  getKey: () => string | null;
  fetchImpl: GarminFetch;
  now: () => Date;
  /** Resolves once the Apple Health pass this foreground started has settled. */
  waitForHealth: () => Promise<unknown>;
  budget?: number;
};

const DEVICE_DEPS: GarminSyncDeps = {
  getKey: () => garminKeyStore.get(),
  fetchImpl: deviceFetch(),
  now: () => new Date(),
  waitForHealth: () => waitForHealthSyncIdle(),
};

export type GarminPassOutcome = 'synced' | 'no_key' | 'rejected' | 'backoff' | 'offline' | 'error';

export type GarminPassResult = {
  outcome: GarminPassOutcome;
  /** Rows written or removed. */
  rowsWritten: number;
  /** Requests made, the token mint included. */
  requests: number;
  /** For `backoff`: when the next automatic pass may run. */
  backoffUntil: string | null;
};

/**
 * One pass. Exported for the headless suite; the app calls it through
 * {@link startGarminPass}, which keeps it single-flight.
 */
export async function runGarminPass(db: Database, deps: GarminSyncDeps): Promise<GarminPassResult> {
  const now = deps.now();
  const key = deps.getKey();
  if (key === null) return { outcome: 'no_key', rowsWritten: 0, requests: 0, backoffUntil: null };
  const state = readGarminState(db);
  if (state.backoffUntil !== null && Date.parse(state.backoffUntil) > now.getTime()) {
    return { outcome: 'backoff', rowsWritten: 0, requests: 0, backoffUntil: state.backoffUntil };
  }

  const today = formatLocalDate(now);
  const recent = recentWindow(state.lastSyncedAt, today);
  const steps = planGarminPass(state, today);
  const session = openGarminSession({
    key,
    fetchImpl: deps.fetchImpl,
    now: () => deps.now().getTime(),
    budget: deps.budget ?? GARMIN_REQUESTS_PER_PASS,
  });

  const rows: WearableUpsert[] = [];
  const backfill: Partial<Record<GarminEndpoint, string>> = recent.reset
    ? {}
    : { ...state.backfill };
  const skipped: GarminEndpoint[] = [];
  const refused: Partial<Record<GarminEndpoint, string>> = { ...state.refused };
  let recentReached = 0;
  let stop: 'rejected' | 'backoff' | 'offline' | 'error' | null = null;
  let retryAfterMs: number | null = null;

  for (const step of steps) {
    // Disconnected, or a different key pasted, while this pass was out: stop
    // sending the old key's requests at once.
    if (deps.getKey() !== key) break;
    const spec = ENDPOINTS[step.endpoint];
    const { path, query } = spec.request(step.from, step.to);
    try {
      const body = await session.get(path, query);
      rows.push(...spec.map(body));
      if (step.kind === 'recent') delete refused[step.endpoint];
    } catch (error) {
      if (error instanceof GarminBudgetError) break;
      if (error instanceof GarminRejectedError) stop = 'rejected';
      else if (error instanceof GarminBackoffError) {
        stop = 'backoff';
        retryAfterMs = error.retryAfterMs;
      } else if (error instanceof GarminNetworkError) stop = 'offline';
      else if (error instanceof GarminTokenError) stop = 'error';
      else if (error instanceof GarminRequestError) {
        if (!skipped.includes(step.endpoint)) skipped.push(step.endpoint);
        // A refused RECENT window is not coverage: that endpoint asks for it
        // again next pass (see `refused`), while the others move on.
        if (step.kind === 'recent') refused[step.endpoint] = step.from;
      } else stop = 'error';
      if (stop !== null) break;
    }
    // Served, or refused by that endpoint alone (named in `skipped`, shown in
    // Settings) — either way the backfill range is behind us, and a refused
    // recent window is held in `refused` above. A stop never gets here, so no
    // cursor moves past anything a stop left unread.
    if (step.kind === 'recent') recentReached++;
    else backfill[step.endpoint] = step.from;
  }

  // A write that throws (a CHECK the mappers did not foresee) must not skip the
  // state write below: without `lastAttemptAt` the throttle never engages and
  // every foreground would refetch the same bad range. But nothing this pass
  // fetched is on disk, so no cursor and no "synced" may move for it: the next
  // pass asks for the same ranges again.
  let rowsWritten = 0;
  let written = true;
  try {
    rowsWritten = writeRows(db, rows);
  } catch {
    stop = 'error';
    written = false;
  }

  // Disconnected, or a new key pasted, while the pass was out: what arrived is
  // kept (it is the owner's record), but this pass must not write its state
  // over the new key's (or recreate the cursor a Disconnect deleted).
  if (deps.getKey() !== key) {
    return {
      outcome: stop ?? 'synced',
      rowsWritten,
      requests: session.requestsMade(),
      backoffUntil: null,
    };
  }

  const next: GarminSyncState = {
    ...state,
    lastAttemptAt: now.toISOString(),
    backfill: written ? backfill : state.backfill,
    refused: written ? refused : state.refused,
    skipped,
    keyExpiresAt: session.keyExpiresAt() ?? state.keyExpiresAt,
  };
  if (written && recentReached === GARMIN_ENDPOINTS.length) next.lastSyncedAt = now.toISOString();
  let backoffUntil: string | null = null;
  if (stop === 'rejected') {
    next.status = 'rejected';
    next.rejectedAt = now.toISOString();
  } else if (stop === 'backoff') {
    backoffUntil = new Date(
      now.getTime() + backoffDelayMs(state.backoffStep, retryAfterMs)
    ).toISOString();
    next.status = 'backoff';
    next.backoffUntil = backoffUntil;
    next.backoffStep = state.backoffStep + 1;
  } else if (stop === 'offline' || stop === 'error') {
    next.status = stop;
  } else {
    next.status = 'ok';
    next.rejectedAt = null;
    next.backoffUntil = null;
    next.backoffStep = 0;
  }
  writeGarminState(db, next);

  return {
    outcome: stop ?? 'synced',
    rowsWritten,
    requests: session.requestsMade(),
    backoffUntil,
  };
}

/** Dedup against Apple Health, then write. */
function writeRows(db: Database, rows: WearableUpsert[]): number {
  if (rows.length === 0) return 0;
  // A later response for the same raw id (a recent range overlapping a chunk)
  // replaces the earlier one rather than writing twice.
  const byId = new Map<string, WearableUpsert>();
  for (const candidate of rows) byId.set(candidate.sourceRawId, candidate);
  const unique = [...byId.values()];
  let first = unique[0]!.date;
  let last = first;
  for (const candidate of unique) {
    if (candidate.date < first) first = candidate.date;
    if (candidate.date > last) last = candidate.date;
  }
  const deciders = [...new Set(Object.values(HEALTH_SUPPLIED_BY))];
  const { keep, drop } = dropHealthSupplied(unique, healthBucketKeys(db, deciders, first, last));
  return applyGarminRows(
    db,
    keep,
    drop.map((d) => d.sourceRawId)
  );
}

// --- Single flight, and who is listening -------------------------------------

let inFlight: Promise<GarminPassResult> | null = null;
/** The key the running pass was started with — a pass for another key is never joined. */
let inFlightKey: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A subscriber re-reads on the next event.
    }
  }
}

/** Called when a pass starts, when it settles, and when the link changes. */
export function subscribeGarminSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isGarminSyncRunning(): boolean {
  return inFlight !== null;
}

/**
 * Start a pass, or join the one running. Marked running at once — before it
 * waits for the Apple Health pass — so the Coach pass, which waits on this,
 * cannot slip in between.
 */
export function startGarminPass(
  db: Database,
  deps: GarminSyncDeps = DEVICE_DEPS
): Promise<GarminPassResult> {
  if (inFlight && inFlightKey === deps.getKey()) return inFlight;
  const pass = (async () => {
    try {
      await deps.waitForHealth();
    } catch {
      // A Health sync that failed is not a reason to skip Garmin.
    }
    return runGarminPass(db, deps);
  })();
  inFlight = pass;
  inFlightKey = deps.getKey();
  emit();
  const settle = () => {
    if (inFlight === pass) {
      inFlight = null;
      inFlightKey = null;
    }
    emit();
  };
  pass.then(settle, settle);
  return pass;
}

/** The open/foreground hook: silent, throttled, never throws. */
export async function syncGarminIfDue(
  db: Database,
  deps: GarminSyncDeps = DEVICE_DEPS
): Promise<GarminPassResult | null> {
  try {
    if (deps.getKey() === null) return null;
    if (!inFlight && !shouldAutoSyncGarmin(readGarminState(db), deps.now())) return null;
    return await startGarminPass(db, deps);
  } catch {
    return null;
  }
}

/**
 * Settings' Sync now and Home's HRV cell: no throttle, and a refused key is
 * tried again (the owner may have just fixed it). A 429 still waits — that is
 * Garmin's request, not ARC's.
 */
export function syncGarminNow(
  db: Database,
  deps: GarminSyncDeps = DEVICE_DEPS
): Promise<GarminPassResult> {
  return startGarminPass(db, deps);
}

/**
 * Resolve once no Garmin pass is running, or after `timeoutMs`. Yields one
 * macrotask before looking, so a pass started by a listener in the same
 * foreground emit is seen (the same reasoning as `waitForHealthSyncIdle`).
 */
export function waitForGarminSyncIdle(
  timeoutMs: number = GARMIN_SETTLE_TIMEOUT_MS
): Promise<'idle' | 'timeout'> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const running = inFlight;
      if (!running) {
        resolve('idle');
        return;
      }
      const timer = setTimeout(() => resolve('timeout'), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve('idle');
      };
      running.then(done, done);
    }, 0);
  });
}

// --- The link itself ----------------------------------------------------------

export type GarminLink = 'off' | 'connected' | 'rejected';

/** What Settings, Home and the Data tab say about the link. */
export function garminLink(db: Database, hasKey: boolean = garminKeyStore.has()): GarminLink {
  if (!hasKey) return 'off';
  return readGarminState(db).status === 'rejected' ? 'rejected' : 'connected';
}

/**
 * A pasted key: stored in the Keychain, the old token dropped, a refusal or a
 * backoff left by the OLD key cleared. History cursors stay — it is the same
 * owner's account. Returns false when the paste was blank.
 */
export function saveGarminKey(db: Database, raw: string): boolean {
  const stored = garminKeyStore.setKey(raw);
  forgetGarminToken();
  if (stored === null) return false;
  const state = readGarminState(db);
  // A Retry-After stands: the limit is Garmin's, on the account, not the key.
  if (state.status === 'rejected') {
    writeGarminState(db, {
      ...state,
      status: state.lastSyncedAt ? 'ok' : 'never',
      rejectedAt: null,
      backoffUntil: null,
      backoffStep: 0,
    });
  }
  emit();
  return true;
}

/**
 * Disconnect: forget the key (Keychain and memory) and the token, and the
 * link's cursor. Rows already synced stay — they are the owner's record.
 */
export function disconnectGarmin(db: Database): void {
  garminKeyStore.clearKey();
  forgetGarminToken();
  deleteSyncStateValue(db, GARMIN_SYNC_KEY);
  emit();
}
