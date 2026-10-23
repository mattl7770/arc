/**
 * Headless test of the Garmin Personal API link (docs/wearables-subapp.md §26):
 * the key store, the one client (token mint, reuse, the re-mint under an hour,
 * the stops on 401/403 and 429/5xx, the per-pass request budget, the read-path
 * allow-list), every mapper, the Apple Health dedup, an idempotent re-fetch,
 * Home's Recovery reading Garmin HRV, the Coach reading the new types, and the
 * key never landing anywhere but the Keychain.
 *
 * NO NETWORK. Every request goes to an injected fetch that answers from
 * db/fixtures/garmin/, which were built from Garmin's published OpenAPI
 * schemas on 2026-10-21 — not from a real account. The owner can replace them
 * with his own 7-night pull later; the assertions name the values they expect.
 *
 * Run: npm run db:test.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  dailyMetricSeries,
  GARMIN_SYNC_KEY,
  getSyncStateValue,
  pickDailyMetric,
  setSyncStateValue,
  upsertWearableRows,
} from '../src/lib/db/repositories/wearables.ts';
import { shiftISODate } from '../src/lib/db/date.ts';
import {
  decodeJwtPayload,
  forgetGarminToken,
  GARMIN_API_ORIGIN,
  GARMIN_REQUESTS_PER_PASS,
  GARMIN_TOKEN_URL,
  GarminBackoffError,
  GarminBudgetError,
  GarminNetworkError,
  GarminRejectedError,
  GarminRequestError,
  GarminTokenError,
  openGarminSession,
  parseRetryAfter,
  parseTokenResponse,
} from '../src/lib/garmin/client.ts';
import {
  createGarminKeyStore,
  GARMIN_KEYCHAIN_ITEM,
  garminKeyStore,
  normaliseGarminKey,
} from '../src/lib/garmin/key-store.ts';
import {
  activityVo2Rows,
  bodyBatteryRows,
  dailySummaryRows,
  dropHealthSupplied,
  gmtMs,
  hrvRows,
  sleepRows,
} from '../src/lib/garmin/mapping.ts';
import {
  BACKFILL_DAYS,
  backoffDelayMs,
  disconnectGarmin,
  emptyGarminState,
  failureDetail,
  garminLink,
  isGarminSyncRunning,
  planGarminPass,
  readGarminState,
  recentWindow,
  runGarminPass,
  SAVE_FAILED_DETAIL,
  saveGarminKey,
  shouldAutoSyncGarmin,
  startGarminPass,
  syncGarminIfDue,
  waitForGarminSyncIdle,
} from '../src/lib/garmin/sync.ts';
import { deriveReadiness } from '../src/lib/home/readiness.ts';
import {
  metricCellPress,
  metricSyncCell,
  GARMIN_KEY_REFUSED,
} from '../src/lib/home/metric-sync.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';
import { buildExport, serializeExport } from '../src/lib/export/serializer.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};
const check = (cond, name, detail) =>
  cond ? ok(name) : bad(name, detail === undefined ? '' : JSON.stringify(detail));

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = {
    run: (sql, params = []) => {
      raw.prepare(sql).run(...params);
    },
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  migrate(
    {
      exec: (sql) => raw.exec(sql),
      getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
      transaction: db.transaction,
    },
    MIGRATIONS
  );
  return { raw, db };
}

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/garmin/${name}.json`, import.meta.url), 'utf8'));
const FIX = {
  hrv: fixture('hrv-daily'),
  sleep: fixture('sleep-summaries'),
  summary: fixture('daily-summaries'),
  battery: fixture('body-battery'),
  activities: fixture('activities'),
};

// A test key and tokens made up here. Never a real credential.
const KEY = 'gpk_TEST_ONLY_7f3a9c1e5b2d4086';
const KEY2 = 'gpk_TEST_ONLY_SECOND_aa11bb22';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expMs, sub = 'fixture') =>
  `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub, exp: Math.floor(expMs / 1000) })}.c2lnbmF0dXJl`;

/** 2026-10-21 12:00 LOCAL — the fixtures' "today". */
const NOON = new Date(2026, 9, 21, 12, 0, 0, 0);
const TODAY = '2026-10-21';

/**
 * A scripted Garmin. `route(url, init)` may return a response object to
 * override the default; the default answers the token URL with a fresh JWT
 * and every read path with its fixture.
 */
function fakeGarmin(clock, route = () => null) {
  const calls = [];
  let mints = 0;
  const lastJwt = { value: null };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const override = route(url, init, calls.length);
    if (override instanceof Error) throw override;
    let response = override;
    if (!response) {
      if (url === GARMIN_TOKEN_URL) {
        mints++;
        lastJwt.value = jwt(clock() + 24 * 3600 * 1000, `mint${mints}`);
        response = {
          status: 200,
          body: JSON.stringify({ access_token: lastJwt.value, expires_in: 86400 }),
        };
      } else if (url.includes('/hrv-service/'))
        response = { status: 200, body: JSON.stringify(FIX.hrv) };
      else if (url.includes('/sleep-service/'))
        response = { status: 200, body: JSON.stringify(FIX.sleep) };
      else if (url.includes('/usersummary-service/'))
        response = { status: 200, body: JSON.stringify(FIX.summary) };
      else if (url.includes('/bodyBattery/'))
        response = { status: 200, body: JSON.stringify(FIX.battery) };
      else if (url.includes('/activitylist-service/'))
        response = { status: 200, body: JSON.stringify(FIX.activities) };
      else response = { status: 404, body: '' };
    }
    const headers = response.headers ?? {};
    return {
      status: response.status,
      ...(response.url !== undefined ? { url: response.url } : {}),
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => response.body ?? '',
    };
  };
  return { fetchImpl, calls, mints: () => mints, lastJwt };
}

function deps(garmin, clock, key = KEY, extra = {}) {
  return {
    getKey: () => key,
    fetchImpl: garmin.fetchImpl,
    now: () => new Date(clock()),
    waitForHealth: () => Promise.resolve(),
    ...extra,
  };
}

const gpRows = (db) =>
  db.all(`SELECT * FROM wearable_data WHERE source_raw_id LIKE 'gp:%' ORDER BY metric_type, date`);
const valueOf = (db, metric, date) =>
  db.get(`SELECT value FROM wearable_data WHERE source_raw_id = ?`, [`gp:${metric}:${date}`])
    ?.value;

// ---------------------------------------------------------------------------
console.log('1. the key store — Keychain only, device-only, in call order');
{
  const writes = [];
  const DEVICE_ONLY = 17;
  const fake = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: DEVICE_ONLY,
    items: new Map(),
    async getItemAsync(k) {
      return this.items.get(k) ?? null;
    },
    async setItemAsync(k, v, options) {
      writes.push({ op: 'set', k, v, options });
      this.items.set(k, v);
    },
    async deleteItemAsync(k) {
      writes.push({ op: 'delete', k });
      this.items.delete(k);
    },
  };
  const store = createGarminKeyStore(fake);
  const stored = store.setKey(`  ApiKey ${KEY}  `);
  await store.flush();
  check(
    stored === KEY && store.get() === KEY,
    'a pasted "ApiKey <key>" is stored as the bare key',
    stored
  );
  check(
    writes.length === 1 &&
      writes[0].k === GARMIN_KEYCHAIN_ITEM &&
      writes[0].options?.keychainAccessible === DEVICE_ONLY,
    'written to the Keychain with WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    writes
  );
  store.setKey(KEY2);
  store.clearKey();
  await store.flush();
  check(
    !fake.items.has(GARMIN_KEYCHAIN_ITEM) && store.get() === null,
    'save then Disconnect leaves nothing at rest'
  );
  check(
    store.setKey('   ') === null && !store.has(),
    'a blank paste clears rather than storing nothing'
  );

  fake.items.set(GARMIN_KEYCHAIN_ITEM, KEY);
  const later = createGarminKeyStore(fake);
  await later.hydrate();
  check(
    later.get() === KEY && later.isPersistent(),
    'a relaunch reads the key back from the Keychain'
  );

  const memoryOnly = createGarminKeyStore(null);
  memoryOnly.setKey(KEY);
  check(
    memoryOnly.get() === KEY && !memoryOnly.isPersistent(),
    'no native module: memory-only, and it says so'
  );
  check(
    normaliseGarminKey('apikey   abc') === 'abc' && normaliseGarminKey('') === null,
    'normalise is pure'
  );
}

// ---------------------------------------------------------------------------
console.log('2. the token response — every shape the unpublished schema could take');
{
  const t0 = Date.UTC(2026, 9, 21, 9);
  const token = jwt(t0 + 20 * 3600 * 1000);
  const a = parseTokenResponse(JSON.stringify({ access_token: token, expires_in: 86400 }), t0);
  check(
    a?.token === token && a.expiresAt === Math.floor((t0 + 20 * 3600 * 1000) / 1000) * 1000,
    "the JWT's own exp wins over expires_in",
    a
  );
  const opaque = 'opaque-token-not-a-jwt';
  const b = parseTokenResponse(JSON.stringify({ accessToken: opaque, expiresIn: 3600 }), t0);
  check(
    b?.token === opaque && b.expiresAt === t0 + 3600 * 1000,
    'camelCase fields and a stated lifetime',
    b
  );
  const c = parseTokenResponse(JSON.stringify({ token: opaque }), t0);
  check(c?.expiresAt === t0 + 24 * 3600 * 1000, "no lifetime stated: Garmin's documented 24 h", c);
  const d = parseTokenResponse(token, t0);
  check(d?.token === token, 'a bare JWT body', d);
  const e = parseTokenResponse(
    JSON.stringify({ access_token: opaque, apiKeyExpirationDate: '2027-01-19T00:00:00Z' }),
    t0
  );
  check(
    e?.keyExpiresAt === '2027-01-19T00:00:00.000Z',
    "a field naming the KEY's expiry is kept",
    e
  );
  check(
    parseTokenResponse('<html>nope</html>', t0) === null && parseTokenResponse('{bad', t0) === null,
    'an unreadable body is null, never a guess'
  );
  check(
    decodeJwtPayload(token)?.sub === 'fixture' && decodeJwtPayload('a.b') === null,
    'JWT claims decode without atob'
  );
  check(
    parseRetryAfter('120', 0) === 120_000 && parseRetryAfter(null, 0) === null,
    'Retry-After seconds'
  );
}

// ---------------------------------------------------------------------------
console.log('3. the client — mint, reuse, re-mint, refusals, backoff, budget, allow-list');
{
  let now = Date.UTC(2026, 9, 21, 7);
  const clock = () => now;
  forgetGarminToken();
  const garmin = fakeGarmin(clock);
  const open = (key = KEY, budget) =>
    openGarminSession({
      key,
      fetchImpl: garmin.fetchImpl,
      now: clock,
      ...(budget ? { budget } : {}),
    });

  const s1 = open();
  const body = await s1.get('/hrv-service/hrv/daily/2026-10-19/2026-10-21');
  check(
    body?.hrvSummaries?.length === 2 && garmin.mints() === 1,
    'the first read mints once, then reads'
  );
  const tokenCall = garmin.calls[0];
  const dataCall = garmin.calls[1];
  check(
    tokenCall.url === GARMIN_TOKEN_URL &&
      tokenCall.init.method === 'POST' &&
      tokenCall.init.headers.Authorization === `ApiKey ${KEY}`,
    'the key goes ONLY in the ApiKey header of the token POST'
  );
  check(
    dataCall.init.method === 'GET' &&
      dataCall.init.headers.Authorization === `Bearer ${garmin.lastJwt.value}` &&
      !JSON.stringify(dataCall.init).includes(KEY),
    'a data read carries the bearer token and never the key'
  );
  check(
    garmin.calls.every((c) => c.url.startsWith(`${GARMIN_API_ORIGIN}/`)),
    'every request is to Garmin’s one origin'
  );

  now += 22 * 3600 * 1000; // 2 h of life left: reuse
  await open().get('/sleep-service/sleep/dailySleepSummariesByDate', {
    startDate: '2026-10-19',
    endDate: '2026-10-21',
  });
  check(garmin.mints() === 1, 'a second session inside the token’s life mints nothing');
  now += 61 * 60 * 1000; // 59 min left: re-mint
  await open().get('/sleep-service/sleep/dailySleepSummariesByDate');
  check(garmin.mints() === 2, 'under an hour left: re-minted');
  await open(KEY2).get('/sleep-service/sleep/dailySleepSummariesByDate');
  check(garmin.mints() === 3, 'a different key never reuses the old key’s token');

  // A data 401 → one re-mint and a retry.
  forgetGarminToken();
  let refusedOnce = false;
  const flaky = fakeGarmin(clock, (url) => {
    if (url.includes('/hrv-service/') && !refusedOnce) {
      refusedOnce = true;
      return { status: 401 };
    }
    return null;
  });
  const retried = await openGarminSession({ key: KEY, fetchImpl: flaky.fetchImpl, now: clock }).get(
    '/hrv-service/hrv/daily/2026-10-19/2026-10-21'
  );
  check(
    retried?.hrvSummaries && flaky.mints() === 2,
    'a data 401 re-mints once and the retry is served'
  );

  const tryGet = async (
    fetchRoute,
    path = '/hrv-service/hrv/daily/2026-10-19/2026-10-21',
    budget
  ) => {
    forgetGarminToken();
    const g = fakeGarmin(clock, fetchRoute);
    try {
      await openGarminSession({
        key: KEY,
        fetchImpl: g.fetchImpl,
        now: clock,
        ...(budget ? { budget } : {}),
      }).get(path);
      return { error: null, g };
    } catch (error) {
      return { error, g };
    }
  };
  const revokedData = await tryGet((url) =>
    url.includes('/hrv-service/') ? { status: 401 } : null
  );
  check(
    revokedData.error instanceof GarminRejectedError && revokedData.g.calls.length === 4,
    'a read 401 twice (mint, read, re-mint, read): the key is rejected — no third try',
    revokedData.g.calls.length
  );
  const forbiddenRead = await tryGet((url) =>
    url.includes('/hrv-service/') ? { status: 403 } : null
  );
  check(
    forbiddenRead.error instanceof GarminRequestError && forbiddenRead.g.calls.length === 2,
    'a 403 on a READ is that endpoint refusing — no re-mint, and not a rejected key',
    forbiddenRead.g.calls.length
  );
  const mintBad = await tryGet((url) => (url === GARMIN_TOKEN_URL ? { status: 400 } : null));
  const mintUnreadable = await tryGet((url) =>
    url === GARMIN_TOKEN_URL ? { status: 200, body: '<html>maintenance</html>' } : null
  );
  check(
    mintBad.error instanceof GarminTokenError && mintUnreadable.error instanceof GarminTokenError,
    'a mint that fails any other way is a token error, never a skipped read'
  );
  // A short stated life is still used for this pass, not re-minted on every read.
  forgetGarminToken();
  const shortLived = fakeGarmin(clock, (url) =>
    url === GARMIN_TOKEN_URL
      ? { status: 200, body: JSON.stringify({ access_token: 'opaque', expires_in: 1800 }) }
      : null
  );
  const shortSession = openGarminSession({ key: KEY, fetchImpl: shortLived.fetchImpl, now: clock });
  await shortSession.get('/hrv-service/hrv/daily/2026-10-19/2026-10-21');
  await shortSession.get('/hrv-service/hrv/daily/2026-10-19/2026-10-21');
  check(
    shortLived.mints() === 0 && shortLived.calls.length === 3,
    'a token with under an hour of life, minted just now, is reused rather than re-minted per read',
    shortLived.calls.length
  );
  const revokedMint = await tryGet((url) =>
    url === GARMIN_TOKEN_URL ? { status: 401, body: `{"echo":"${KEY}"}` } : null
  );
  check(
    revokedMint.error instanceof GarminRejectedError && revokedMint.g.calls.length === 1,
    'a 401 at the mint stops at once'
  );
  check(
    !String(revokedMint.error?.message).includes(KEY),
    'the error never repeats a response body that echoed the key'
  );
  const limited = await tryGet((url) =>
    url.includes('/hrv-service/') ? { status: 429, headers: { 'retry-after': '600' } } : null
  );
  check(
    limited.error instanceof GarminBackoffError && limited.error.retryAfterMs === 600_000,
    '429 → backoff with Retry-After'
  );
  const down = await tryGet((url) => (url.includes('/hrv-service/') ? { status: 503 } : null));
  check(
    down.error instanceof GarminBackoffError && down.error.retryAfterMs === null,
    '5xx → backoff'
  );
  const badRange = await tryGet((url) => (url.includes('/hrv-service/') ? { status: 400 } : null));
  check(
    badRange.error instanceof GarminRequestError && badRange.error.status === 400,
    'another 4xx → that request only'
  );
  const offline = await tryGet(() => new TypeError('Network request failed'));
  check(offline.error instanceof GarminNetworkError, 'fetch throwing → offline');
  const empty = await tryGet((url) => (url.includes('/hrv-service/') ? { status: 204 } : null));
  check(empty.error === null, 'a 204 (a night with no HRV) is data, not an error');
  const outside = await tryGet(null, '/userprofile-service/userprofile/settings');
  check(
    outside.error instanceof Error && outside.g.calls.length === 0,
    'a path outside the read allow-list is refused before any request'
  );
  const sneaky = await tryGet(null, '/hrv-service/hrv/daily/../../userprofile-service');
  check(
    sneaky.error instanceof Error && sneaky.g.calls.length === 0,
    'a traversal inside an allowed prefix is refused too'
  );

  forgetGarminToken();
  const budgeted = fakeGarmin(clock);
  const session = openGarminSession({
    key: KEY,
    fetchImpl: budgeted.fetchImpl,
    now: clock,
    budget: 3,
  });
  await session.get('/hrv-service/hrv/daily/2026-10-19/2026-10-21');
  await session.get('/hrv-service/hrv/daily/2026-10-19/2026-10-21');
  let spent = null;
  try {
    await session.get('/hrv-service/hrv/daily/2026-10-19/2026-10-21');
  } catch (error) {
    spent = error;
  }
  check(
    spent instanceof GarminBudgetError &&
      budgeted.calls.length === 3 &&
      session.requestsMade() === 3,
    'the budget counts the mint and stops at the limit',
    budgeted.calls.length
  );
  check(GARMIN_REQUESTS_PER_PASS <= 10, 'a pass may make a few requests, never dozens');

  // Redirects: the key or the token must never follow one off-host.
  check(
    budgeted.calls.every((c) => c.init.redirect === 'error'),
    'every request is sent with redirect: error'
  );
  const moved = await tryGet((url) =>
    url.includes('/hrv-service/')
      ? { status: 302, headers: { location: 'https://evil.example/steal' } }
      : null
  );
  check(
    moved.error instanceof GarminRequestError && moved.g.calls.length === 2,
    'a 3xx on a read is that request refused — never followed, never retried',
    moved.g.calls.length
  );
  const followed = await tryGet((url) =>
    url.includes('/hrv-service/')
      ? { status: 200, url: 'https://evil.example/steal', body: JSON.stringify(FIX.hrv) }
      : null
  );
  check(
    followed.error instanceof GarminRequestError,
    'a reply whose final URL is off Garmin’s origin is refused, its body unread'
  );
  const lookalike = await tryGet((url) =>
    url.includes('/hrv-service/')
      ? {
          status: 200,
          url: `${GARMIN_API_ORIGIN}.evil.example/hrv-service/hrv/daily/x`,
          body: JSON.stringify(FIX.hrv),
        }
      : null
  );
  check(
    lookalike.error instanceof GarminRequestError,
    'a look-alike host that merely starts with Garmin’s origin is off-host too'
  );
  const sameHost = await tryGet((url) =>
    url.includes('/hrv-service/')
      ? { status: 200, url, body: JSON.stringify(FIX.hrv) }
      : null
  );
  check(sameHost.error === null, 'a reply that states Garmin’s own URL reads as before');
  const mintMoved = await tryGet((url) =>
    url === GARMIN_TOKEN_URL ? { status: 307, headers: { location: 'https://evil.example/' } } : null
  );
  const mintFollowed = await tryGet((url) =>
    url === GARMIN_TOKEN_URL
      ? {
          status: 200,
          url: 'https://evil.example/token',
          body: JSON.stringify({ access_token: jwt(now + 86400_000) }),
        }
      : null
  );
  check(
    mintMoved.error instanceof GarminTokenError &&
      mintFollowed.error instanceof GarminTokenError &&
      mintMoved.g.calls.length === 1 &&
      mintFollowed.g.calls.length === 1,
    'a redirected mint stops the pass as a token error — its token is never used'
  );
}

// ---------------------------------------------------------------------------
console.log('4. the mappers — one per endpoint, against the fixtures');
{
  const hrv = hrvRows(FIX.hrv);
  const byKey = new Map(hrv.map((r) => [r.sourceRawId, r]));
  check(
    byKey.get('gp:hrv:2026-10-21')?.value === 39 && byKey.get('gp:hrv:2026-10-21')?.unit === 'ms',
    'HRV: the nightly average, in ms'
  );
  check(
    byKey.get('gp:hrv_status:2026-10-21')?.value === 3 &&
      byKey.get('gp:hrv_status:2026-10-19')?.value === 4,
    'HRV status as its own type: UNBALANCED 3, BALANCED 4'
  );
  check(
    byKey.get('gp:hrv_baseline_low:2026-10-21')?.value === 42 &&
      byKey.get('gp:hrv_baseline_high:2026-10-21')?.value === 56,
    'the balanced range as two types of its own'
  );
  check(byKey.get('gp:hrv_weekly_avg:2026-10-19')?.value === 47, 'the weekly average');
  check(
    !hrv.some((r) => r.date === '2026-10-20'),
    'the night with no HRV (absent from the range) writes nothing'
  );
  check(
    hrv.every((r) => r.sourceDevice === 'garmin' && r.metadata.via === 'garmin_personal_api'),
    "source 'garmin', tagged"
  );
  check(hrvRows(null).length === 0, 'a 204 range (null body) writes nothing');
  check(
    hrvRows({ hrvSummary: FIX.hrv.hrvSummaries[0] }).length === 5,
    'the single-date shape maps too'
  );
  check(
    hrvRows({ hrvSummaries: [{ calendarDate: '2026-10-22', status: 'NONE', lastNightAvg: 0 }] })
      .length === 0,
    'status NONE and a zero average write nothing'
  );

  const sleep = sleepRows(FIX.sleep);
  const s = (m, d) => sleep.find((r) => r.sourceRawId === `gp:${m}:${d}`);
  check(
    s('sleep_duration_min', '2026-10-19')?.value === 435 &&
      s('sleep_deep_min', '2026-10-19')?.value === 90 &&
      s('sleep_core_min', '2026-10-19')?.value === 240 &&
      s('sleep_rem_min', '2026-10-19')?.value === 105 &&
      s('sleep_awake_min', '2026-10-19')?.value === 30,
    'sleep: asleep minutes, and light filed as core'
  );
  check(
    s('sleep_duration_min', '2026-10-19')?.startTime === '2026-10-18T22:10:00.000Z' &&
      s('sleep_duration_min', '2026-10-20')?.endTime === '2026-10-20T06:25:00.000Z',
    'session bounds from epoch ms AND from a zoneless GMT string'
  );
  check(
    s('sleep_score', '2026-10-19')?.value === 82 && s('sleep_score', '2026-10-21')?.value === 77,
    'sleep score'
  );
  check(
    s('sleep_score', '2026-10-20') === undefined &&
      s('sleep_duration_min', '2026-10-20')?.value === 375,
    'a night with no score keeps its other rows and gets no score row'
  );
  check(
    s('spo2_pct', '2026-10-19')?.value === 95.4 && s('spo2_lowest_pct', '2026-10-19')?.value === 89,
    'SpO2 average and lowest, overnight'
  );
  check(
    s('respiratory_rate', '2026-10-21')?.value === 14.5 &&
      s('respiratory_rate', '2026-10-21')?.unit === 'brpm',
    'respiration in the HealthKit unit'
  );
  const noRem = sleepRows([{ ...FIX.sleep[0], deviceRemCapable: false }]);
  check(
    !noRem.some((r) => r.metricType === 'sleep_rem_min'),
    'no REM row from a device that cannot tell'
  );
  const backwards = sleepRows([
    {
      ...FIX.sleep[0],
      sleepStartTimestampGMT: 1792389300000,
      sleepEndTimestampGMT: 1792361400000,
    },
  ]);
  check(
    backwards.length > 0 && backwards.every((r) => r.startTime === null && r.endTime === null),
    'bounds that run backwards are dropped, so the CHECK cannot sink the batch'
  );

  const summary = dailySummaryRows(FIX.summary);
  const d = (m, day) => summary.find((r) => r.sourceRawId === `gp:${m}:${day}`);
  check(
    d('rhr', '2026-10-21')?.value === 54 && d('stress_avg', '2026-10-19')?.value === 27,
    'resting HR and stress'
  );
  check(
    d('body_battery_high', '2026-10-19')?.value === 86 &&
      d('body_battery_low', '2026-10-19')?.value === 18,
    'Body Battery high and low'
  );
  check(d('stress_avg', '2026-10-20') === undefined, "stress's -1 sentinel writes nothing");
  check(
    !summary.some((r) => r.date === '2026-10-18'),
    'a day without wellness data writes nothing'
  );

  const battery = bodyBatteryRows(FIX.battery);
  check(
    battery.length === 1 &&
      battery[0].sourceRawId === 'gp:body_battery_wake:2026-10-21' &&
      battery[0].value === 79,
    'Body Battery at wake: the reading at the end of the SLEEP event',
    battery
  );

  const vo2 = activityVo2Rows(FIX.activities);
  check(
    vo2.length === 1 &&
      vo2[0].date === '2026-10-20' &&
      vo2[0].value === 51 &&
      vo2[0].unit === 'ml_kg_min',
    "VO₂max: the day's latest activity wins; an activity without one writes nothing",
    vo2
  );
  check(
    gmtMs('2026-10-20T22:40:00.0') === Date.parse('2026-10-20T22:40:00Z') && gmtMs(null) === null,
    'GMT parsing'
  );
}

// ---------------------------------------------------------------------------
console.log('5. dedup with Apple Health — pure');
{
  const rows = [...sleepRows(FIX.sleep), ...dailySummaryRows(FIX.summary), ...hrvRows(FIX.hrv)];
  const { keep, drop } = dropHealthSupplied(
    rows,
    new Set(['sleep_duration_min|2026-10-20', 'rhr|2026-10-21', 'hrv|2026-10-21'])
  );
  check(
    drop.filter((r) => r.date === '2026-10-20').every((r) => r.metricType.startsWith('sleep_')) &&
      drop.some((r) => r.metricType === 'sleep_deep_min' && r.date === '2026-10-20'),
    'Apple Health has that night: the WHOLE sleep family is dropped, not just duration'
  );
  check(
    drop.some((r) => r.sourceRawId === 'gp:rhr:2026-10-21'),
    'Apple Health resting HR wins that day'
  );
  check(
    keep.some((r) => r.sourceRawId === 'gp:hrv:2026-10-21'),
    'HRV is never dropped — Garmin is preferred'
  );
  check(
    keep.some((r) => r.sourceRawId === 'gp:spo2_lowest_pct:2026-10-20'),
    'a Garmin-only figure is never dropped'
  );
}

// ---------------------------------------------------------------------------
console.log('6. planning — the recent window, the backfill order, the horizon');
{
  const fresh = emptyGarminState();
  const plan = planGarminPass(fresh, TODAY, 3);
  check(
    plan
      .slice(0, 5)
      .every((st) => st.kind === 'recent' && st.from === '2026-10-19' && st.to === TODAY),
    'five recent requests over the last three days'
  );
  check(
    plan[5]?.endpoint === 'hrv' &&
      plan[5].to === '2026-10-18' &&
      plan[5].from === '2026-09-18' &&
      plan[6]?.endpoint === 'summary' &&
      plan[6].from === shiftISODate(TODAY, -(BACKFILL_DAYS - 1)),
    'backfill starts with HRV (31 days), then a whole year of daily summaries in one request',
    plan.slice(5)
  );
  const later = planGarminPass(
    {
      ...fresh,
      backfill: { hrv: '2026-09-18', summary: shiftISODate(TODAY, -(BACKFILL_DAYS - 1)) },
    },
    TODAY,
    2
  );
  check(
    later[5]?.endpoint === 'sleep' && later[6]?.endpoint === 'body_battery',
    'the least-fetched endpoint goes next, so the first month fills evenly',
    later.slice(5)
  );
  const done = Object.fromEntries(
    ['hrv', 'summary', 'sleep', 'body_battery', 'activities'].map((e) => [
      e,
      shiftISODate(TODAY, -(BACKFILL_DAYS - 1)),
    ])
  );
  check(
    planGarminPass({ ...fresh, backfill: done }, TODAY, 5).length === 5,
    'a full year back: recent only'
  );
  const away = recentWindow('2026-10-11T08:00:00.000Z', TODAY);
  check(
    away.from === '2026-10-11' && !away.reset,
    'ten days away: the recent window covers the gap'
  );
  const long = recentWindow('2026-08-01T08:00:00.000Z', TODAY);
  check(
    long.reset && long.from === shiftISODate(TODAY, -30),
    'longer than a month: capped, and the backfill restarts'
  );
  check(
    backoffDelayMs(0, null) === 15 * 60_000 &&
      backoffDelayMs(2, null) === 60 * 60_000 &&
      backoffDelayMs(20, null) === 24 * 3600_000,
    'backoff: 15 min doubling, capped at a day'
  );
}

// ---------------------------------------------------------------------------
console.log('7. a pass end to end — rows, dedup, budget, state');
const { raw, db } = freshDb();
let clockMs = NOON.getTime();
const clock = () => clockMs;
forgetGarminToken();
const garmin = fakeGarmin(clock);
{
  // What Garmin Connect already sent to Apple Health: the 10-20 night and 10-21 resting HR.
  upsertWearableRows(db, [
    {
      date: '2026-10-20',
      metricType: 'sleep_duration_min',
      value: 380,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: 'hk:sleep_duration_min:2026-10-20',
      startTime: null,
      endTime: null,
      metadata: {},
    },
    {
      date: '2026-10-21',
      metricType: 'rhr',
      value: 55,
      unit: 'bpm',
      sourceDevice: 'garmin',
      sourceRawId: 'hk:rhr:2026-10-21',
      startTime: null,
      endTime: null,
      metadata: {},
    },
    // The phone's own sleep guess for 10-19: another device, so it must NOT suppress the band's night.
    {
      date: '2026-10-19',
      metricType: 'sleep_duration_min',
      value: 300,
      unit: 'min',
      sourceDevice: 'other',
      sourceRawId: 'hk:sleep_duration_min:2026-10-19',
      startTime: null,
      endTime: null,
      metadata: {},
    },
    // A typed HRV for today, the habit this link retires.
    {
      date: TODAY,
      metricType: 'hrv',
      value: 60,
      unit: 'ms',
      sourceDevice: 'manual',
      sourceRawId: 'manual:hrv:test',
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);
  const result = await runGarminPass(db, deps(garmin, clock));
  check(
    result.outcome === 'synced' && result.requests === GARMIN_REQUESTS_PER_PASS,
    'synced, spending exactly the per-pass budget (1 mint + 5 recent + 2 backfill)',
    result
  );
  check(garmin.calls.filter((c) => c.url === GARMIN_TOKEN_URL).length === 1, 'one mint');
  check(
    valueOf(db, 'hrv', TODAY) === 39 && valueOf(db, 'hrv_status', TODAY) === 3,
    'HRV and its status landed'
  );
  check(
    valueOf(db, 'sleep_duration_min', '2026-10-20') === undefined &&
      valueOf(db, 'sleep_deep_min', '2026-10-20') === undefined,
    'the night Apple Health already has is not written twice'
  );
  check(
    valueOf(db, 'sleep_duration_min', '2026-10-19') === 435,
    'a night Garmin Connect did not send to Apple Health is filled — a phone’s own row does not suppress it'
  );
  check(
    valueOf(db, 'rhr', TODAY) === undefined && valueOf(db, 'rhr', '2026-10-20') === 53,
    'resting HR: Apple Health’s day kept, the other days filled'
  );
  check(
    valueOf(db, 'body_battery_wake', TODAY) === 79 && valueOf(db, 'vo2max', '2026-10-20') === 51,
    'Body Battery and VO₂max'
  );
  const st = readGarminState(db);
  check(
    st.status === 'ok' &&
      st.lastSyncedAt === NOON.toISOString() &&
      st.backfill.hrv === '2026-09-18' &&
      st.backfill.summary === shiftISODate(TODAY, -(BACKFILL_DAYS - 1)),
    'state: ok, synced, the HRV and summary cursors moved back',
    st
  );
  check(
    pickDailyMetric(db, 'hrv', TODAY)?.sourceDevice === 'garmin',
    'today’s HRV: Garmin beats the typed one'
  );

  const before = gpRows(db).length;
  clockMs += 16 * 60_000;
  const again = await runGarminPass(db, deps(garmin, clock));
  check(
    again.rowsWritten === 0 && gpRows(db).length === before,
    'a re-fetch of the same days updates nothing and duplicates nothing',
    { again, before, after: gpRows(db).length }
  );
  check(
    garmin.calls.filter((c) => c.url === GARMIN_TOKEN_URL).length === 1 &&
      again.requests === GARMIN_REQUESTS_PER_PASS,
    'the second pass reuses the token and spends the mint’s slot on history'
  );

  // Garmin revises last night after a late band sync.
  const revised = structuredClone(FIX.hrv);
  revised.hrvSummaries[1].lastNightAvg = 41;
  const reviser = fakeGarmin(clock, (url) =>
    url.includes('/hrv-service/') ? { status: 200, body: JSON.stringify(revised) } : null
  );
  clockMs += 16 * 60_000;
  await runGarminPass(db, deps(reviser, clock));
  check(
    valueOf(db, 'hrv', TODAY) === 41 &&
      db.all(
        `SELECT * FROM wearable_data WHERE metric_type = 'hrv' AND date = ? AND source_device = 'garmin'`,
        [TODAY]
      ).length === 1,
    'a revised night updates in place'
  );

  // Apple Health catches up on last night after the Garmin pass wrote it.
  upsertWearableRows(db, [
    {
      date: TODAY,
      metricType: 'sleep_duration_min',
      value: 418,
      unit: 'min',
      sourceDevice: 'garmin',
      sourceRawId: `hk:sleep_duration_min:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
  ]);
  check(
    pickDailyMetric(db, 'sleep_duration_min', TODAY)?.value === 418,
    'until the next Garmin pass, the read side already prefers the Apple Health row of the tie'
  );
  clockMs += 16 * 60_000;
  const healed = await runGarminPass(db, deps(garmin, clock));
  check(
    valueOf(db, 'sleep_duration_min', TODAY) === undefined &&
      valueOf(db, 'sleep_rem_min', TODAY) === undefined &&
      healed.rowsWritten >= 5,
    'the next Garmin pass removes its own rows for that night — one night, one source',
    healed
  );
  check(
    db.get(
      `SELECT count(*) AS n FROM wearable_data WHERE source_raw_id = 'hk:sleep_duration_min:${TODAY}'`
    ).n === 1,
    'and never touches the Apple Health row'
  );
}

// ---------------------------------------------------------------------------
console.log('8. Home’s Recovery reads Garmin HRV');
{
  const { db: rdb } = freshDb();
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const day = shiftISODate(TODAY, -i);
    rows.push({
      date: day,
      metricType: 'hrv',
      value: 50,
      unit: 'ms',
      sourceDevice: 'garmin',
      sourceRawId: `gp:hrv:${day}`,
      startTime: null,
      endTime: null,
      metadata: {},
    });
  }
  rows.push(
    {
      date: TODAY,
      metricType: 'hrv',
      value: 40,
      unit: 'ms',
      sourceDevice: 'garmin',
      sourceRawId: `gp:hrv:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    },
    // A Watch SDNN on the same morning: a different measure, and it must not win.
    {
      date: TODAY,
      metricType: 'hrv',
      value: 70,
      unit: 'ms',
      sourceDevice: 'apple_watch',
      sourceRawId: `hk:hrv:${TODAY}`,
      startTime: null,
      endTime: null,
      metadata: {},
    }
  );
  upsertWearableRows(rdb, rows);
  const view = deriveReadiness(rdb, TODAY, { now: NOON });
  const recovery = view.pillars.find((p) => p.label === 'Recovery');
  check(
    view.readiness.detail.startsWith('HRV 40 ms · 20% below'),
    'the verdict sentence is Garmin’s 40 against its 50 baseline',
    view.readiness.detail
  );
  check(recovery?.level === 'caution', 'Recovery is graded from it (0.80 → caution)', recovery);
  check(
    view.metrics.find((m) => m.id === 'hrv')?.value === '40 ms',
    'the HRV cell shows the Garmin figure'
  );
  check(
    dailyMetricSeries(rdb, 'hrv', 1, TODAY)[0]?.sourceDevice === 'garmin',
    'and the Data tab and the Coach read the same row'
  );
  check(
    dailyMetricSeries(rdb, 'rhr', 1, TODAY).length === 0,
    '(other metrics keep the ordinary priority)'
  );
}

// ---------------------------------------------------------------------------
console.log('9. a revoked key — stop, say so, wait for a new key');
{
  const { db: kdb } = freshDb();
  let t = NOON.getTime();
  forgetGarminToken();
  const revoked = fakeGarmin(
    () => t,
    (url) => (url === GARMIN_TOKEN_URL ? { status: 401 } : null)
  );
  const result = await runGarminPass(
    kdb,
    deps(revoked, () => t)
  );
  check(
    result.outcome === 'rejected' && result.requests === 1 && gpRows(kdb).length === 0,
    'one request, then stop',
    result
  );
  const st = readGarminState(kdb);
  check(st.status === 'rejected' && st.rejectedAt !== null, 'the state says rejected');
  check(
    garminLink(kdb, true) === 'rejected' && garminLink(kdb, false) === 'off',
    'the link reads rejected (off without a key)'
  );
  t += 60 * 60_000;
  const auto = await syncGarminIfDue(
    kdb,
    deps(revoked, () => t)
  );
  check(auto === null && revoked.calls.length === 1, 'automatic passes stop trying a refused key');
  check(!shouldAutoSyncGarmin(st, new Date(t)), 'shouldAutoSyncGarmin agrees');

  const ctx = {
    link: 'unsupported',
    available: false,
    running: false,
    lastSyncedAt: null,
    failedAt: null,
    log: null,
    sources: [],
    today: TODAY,
    garmin: { link: 'rejected', running: false, lastSyncedAt: null },
  };
  const cell = metricSyncCell({ id: 'hrv', value: '—' }, ctx);
  check(
    cell.kind === 'garmin' &&
      cell.state === 'rejected' &&
      cell.note === GARMIN_KEY_REFUSED &&
      metricCellPress(cell) === 'garmin_settings',
    'Home’s HRV cell says so and leads to Settings › Garmin',
    cell
  );
  check(metricSyncCell({ id: 'rhr', value: '—' }, ctx).kind === 'blank', 'no other cell changes');
  const offer = metricSyncCell(
    { id: 'hrv', value: '—' },
    { ...ctx, garmin: { link: 'connected', running: false, lastSyncedAt: NOON.toISOString() } }
  );
  check(
    offer.kind === 'garmin' && offer.state === 'offer' && metricCellPress(offer) === 'garmin_sync',
    'connected: the blank HRV offers a Garmin pass, not an Apple Health one'
  );
  check(
    metricSyncCell({ id: 'hrv', value: '39 ms' }, ctx).kind === 'reading',
    'a reading is never replaced'
  );

  const saved = saveGarminKey(kdb, KEY2);
  check(
    saved && readGarminState(kdb).status === 'never' && garminKeyStore.get() === KEY2,
    'a new key clears the refusal'
  );
  garminKeyStore.clearKey();
}

// ---------------------------------------------------------------------------
console.log('10. 429 and offline — back off, never throw');
{
  const { db: bdb } = freshDb();
  let t = NOON.getTime();
  forgetGarminToken();
  const limited = fakeGarmin(
    () => t,
    (url) =>
      url.includes('/sleep-service/') ? { status: 429, headers: { 'retry-after': '1800' } } : null
  );
  const result = await runGarminPass(
    bdb,
    deps(limited, () => t)
  );
  check(
    result.outcome === 'backoff' && result.backoffUntil === new Date(t + 1800_000).toISOString(),
    'a 429 stops the pass and honours Retry-After',
    result
  );
  check(valueOf(bdb, 'hrv', TODAY) === 39, 'what arrived before the 429 is still written');
  check(
    readGarminState(bdb).lastSyncedAt === null,
    'an unfinished recent window does not count as synced'
  );
  const callsBefore = limited.calls.length;
  t += 10 * 60_000;
  const waiting = await runGarminPass(
    bdb,
    deps(limited, () => t)
  );
  check(
    waiting.outcome === 'backoff' && limited.calls.length === callsBefore,
    'inside the wait: no request at all'
  );
  t += 30 * 60_000;
  const ok2 = await runGarminPass(
    bdb,
    deps(
      fakeGarmin(() => t),
      () => t
    )
  );
  check(
    ok2.outcome === 'synced' && readGarminState(bdb).backoffStep === 0,
    'after it: synced, and the doubling resets'
  );

  forgetGarminToken();
  const gone = fakeGarmin(
    () => t,
    () => new TypeError('Network request failed')
  );
  const off = await runGarminPass(
    bdb,
    deps(gone, () => t + 3600_000)
  );
  check(
    off.outcome === 'offline' && readGarminState(bdb).status === 'offline',
    'offline: a quiet stop'
  );

  forgetGarminToken();
  const skip = fakeGarmin(
    () => t,
    (url) => (url.includes('/bodyBattery/') ? { status: 400 } : null)
  );
  const partial = await runGarminPass(
    bdb,
    deps(skip, () => t + 2 * 3600_000)
  );
  const ps = readGarminState(bdb);
  check(
    partial.outcome === 'synced' && ps.skipped.includes('body_battery') && ps.lastSyncedAt !== null,
    'a 400 on one endpoint skips it, names it, and the pass goes on',
    ps
  );

  // The token reply ARC cannot read — the first real connect's likeliest surprise.
  const { db: tdb } = freshDb();
  forgetGarminToken();
  const unreadable = fakeGarmin(
    () => t,
    (url) => (url === GARMIN_TOKEN_URL ? { status: 200, body: '<html>maintenance</html>' } : null)
  );
  const tokenFail = await runGarminPass(
    tdb,
    deps(unreadable, () => t)
  );
  const ts = readGarminState(tdb);
  check(
    tokenFail.outcome === 'error' &&
      unreadable.calls.length === 1 &&
      ts.status === 'error' &&
      ts.lastSyncedAt === null &&
      Object.keys(ts.backfill).length === 0 &&
      ts.lastAttemptAt !== null,
    'an unreadable token reply stops the pass: one request, no cursor moved, not "synced", throttled',
    { tokenFail, ts }
  );

  // A different key pasted while a pass is out.
  const { db: kdb2 } = freshDb();
  let current = KEY;
  forgetGarminToken();
  const swap = fakeGarmin(
    () => t,
    (url) => {
      if (url.includes('/usersummary-service/')) current = KEY2;
      return null;
    }
  );
  const swapped = await runGarminPass(kdb2, { ...deps(swap, () => t), getKey: () => current });
  check(
    swap.calls.length === 3 &&
      getSyncStateValue(kdb2, GARMIN_SYNC_KEY) === null &&
      swapped.requests === 3,
    'a new key mid-pass: the old key’s pass stops sending and writes no state over the new one',
    { calls: swap.calls.length, swapped }
  );
}

// ---------------------------------------------------------------------------
console.log('10b. a write that fails, and a refused recent window, move no coverage');
{
  // The probe's case: every wearable_data INSERT throws (a full disk, a CHECK).
  const { raw: wraw, db: wbase } = freshDb();
  let failWrites = false;
  const wdb = {
    ...wbase,
    run: (sql, params = []) => {
      if (failWrites && /INSERT INTO wearable_data/.test(sql)) throw new Error('SQLITE_FULL');
      wraw.prepare(sql).run(...params);
    },
  };
  let t = NOON.getTime();
  forgetGarminToken();
  const g0 = fakeGarmin(() => t);
  await runGarminPass(wdb, deps(g0, () => t));
  const s0 = readGarminState(wdb);
  const reads = (g) => g.calls.map((c) => c.url).filter((u) => u !== GARMIN_TOKEN_URL);

  failWrites = true;
  t += 20 * 60_000;
  const g1 = fakeGarmin(() => t);
  const r1 = await runGarminPass(wdb, deps(g1, () => t));
  const s1 = readGarminState(wdb);
  check(
    r1.outcome === 'error' &&
      s1.status === 'error' &&
      s1.lastAttemptAt === new Date(t).toISOString() &&
      s1.lastSyncedAt === s0.lastSyncedAt &&
      JSON.stringify(s1.backfill) === JSON.stringify(s0.backfill),
    'a write that throws: error and throttled, but lastSyncedAt and every backfill cursor stay put',
    { s0, s1 }
  );

  failWrites = false;
  t += 20 * 60_000;
  const g2 = fakeGarmin(() => t);
  await runGarminPass(wdb, deps(g2, () => t));
  check(
    JSON.stringify(reads(g2)) === JSON.stringify(reads(g1)),
    'the next pass asks for the very chunks the failed write lost',
    { failed: reads(g1), next: reads(g2) }
  );

  // A recent window one endpoint refuses (a 400), while the others serve.
  const { db: rdb } = freshDb();
  let rt = NOON.getTime();
  forgetGarminToken();
  // The recent requests come first, so the first call to a path is its recent one.
  const recentRange = (g, part) => g.calls.map((c) => c.url).find((u) => u.includes(part));
  const refuser = fakeGarmin(
    () => rt,
    (url) => (url.includes('/hrv-service/') && url.includes(TODAY) ? { status: 400 } : null)
  );
  const first = await runGarminPass(rdb, deps(refuser, () => rt));
  const fs = readGarminState(rdb);
  check(
    first.outcome === 'synced' &&
      fs.skipped.includes('hrv') &&
      fs.refused.hrv === shiftISODate(TODAY, -2) &&
      fs.refused.sleep === undefined,
    'a refused recent window is held per endpoint, not counted as read',
    fs
  );
  check(
    !shouldAutoSyncGarmin(fs, new Date(rt + 5 * 60_000)),
    'and the throttle still holds — no retry on every foreground'
  );
  rt += 2 * 24 * 3600_000;
  const later = fakeGarmin(() => rt);
  await runGarminPass(rdb, deps(later, () => rt));
  const day2 = shiftISODate(TODAY, 2);
  check(
    recentRange(later, '/hrv-service/')?.includes(`/${shiftISODate(TODAY, -2)}/${day2}`) &&
      recentRange(later, '/sleep-service/')?.includes(`startDate=${TODAY}`),
    'two days on, HRV asks back to its refused day while sleep asks only the usual three',
    later.calls.map((c) => c.url)
  );
  check(
    readGarminState(rdb).refused.hrv === undefined,
    'served at last: the refusal clears'
  );
  const capped = planGarminPass(
    { ...emptyGarminState(), lastSyncedAt: NOON.toISOString(), refused: { hrv: '2026-08-01' } },
    TODAY,
    0
  );
  check(
    capped[0].endpoint === 'hrv' && capped[0].from === shiftISODate(TODAY, -30),
    'a refusal older than 31 days is stepped over — the window never grows past the cap',
    capped[0]
  );
}

// ---------------------------------------------------------------------------
console.log('10c. the mint asks as Garmin’s own client does, and a failure names itself');
{
  // 2026-10-23, on device: "Sync failed" with no way to tell which step. The
  // mint now sends Accept: */* (Garmin's reference client; the reply is a
  // bare JWT in text), and an error pass carries a detail in fixed words.
  const { db: mdb } = freshDb();
  let t = NOON.getTime();
  forgetGarminToken();
  const plain = fakeGarmin(
    () => t,
    (url) => (url === GARMIN_TOKEN_URL ? { status: 200, body: jwt(t + 24 * 3600_000) + '\n' } : null)
  );
  const r0 = await runGarminPass(mdb, deps(plain, () => t));
  const mintCall = plain.calls.find((c) => c.url === GARMIN_TOKEN_URL);
  check(
    mintCall?.init.method === 'POST' &&
      mintCall.init.headers.Accept === '*/*' &&
      mintCall.init.headers.Authorization === `ApiKey ${KEY}`,
    'the mint is a POST with Accept: */* and the ApiKey header, as Garmin’s client sends it',
    mintCall?.init
  );
  check(
    plain.calls.filter((c) => c.url !== GARMIN_TOKEN_URL).every((c) => c.init.headers.Accept === 'application/json'),
    'reads still ask for JSON'
  );
  check(r0.outcome === 'synced' && r0.detail === undefined, 'a bare-JWT text reply mints and the pass syncs', r0);

  const ECHO = 'ECHOED-BODY-gpk_TEST_ONLY';
  const failing = (status, body) => {
    forgetGarminToken();
    return fakeGarmin(() => t, (url) => (url === GARMIN_TOKEN_URL ? { status, body } : null));
  };
  t += 20 * 60_000;
  const r406 = await runGarminPass(mdb, deps(failing(406, ECHO), () => t));
  const s406 = readGarminState(mdb);
  check(
    r406.outcome === 'error' &&
      r406.detail === 'Garmin would not issue a token (HTTP 406)' &&
      s406.status === 'error' &&
      s406.lastError === r406.detail,
    'a 406 at the mint: error, and both the result and the stored state say which step and which status',
    { r406, lastError: s406.lastError }
  );
  check(
    !JSON.stringify(s406).includes('ECHOED') && !String(r406.detail).includes('ECHOED'),
    'Garmin’s reply body never reaches the detail or the state'
  );
  t += 20 * 60_000;
  const rBad = await runGarminPass(mdb, deps(failing(200, '<html>maintenance</html>'), () => t));
  check(
    rBad.detail === "Garmin's token reply was unreadable (HTTP 200)",
    'a 200 whose body is not a token says "unreadable"',
    rBad
  );
  check(
    failureDetail(new TypeError('x')) === 'Unexpected error (TypeError)' &&
      failureDetail({ name: '<script>' }) === 'Unexpected error (unknown)' &&
      SAVE_FAILED_DETAIL === 'Could not save what Garmin sent',
    'anything else is named by its class only; a save that fails has its own words'
  );
  t += 20 * 60_000;
  forgetGarminToken();
  const rOk = await runGarminPass(mdb, deps(fakeGarmin(() => t), () => t));
  check(
    rOk.outcome === 'synced' && readGarminState(mdb).lastError === null,
    'a clean pass clears the stored failure'
  );
  const legacy = { ...emptyGarminState() };
  delete legacy.lastError;
  const { db: ldb } = freshDb();
  setSyncStateValue(ldb, GARMIN_SYNC_KEY, { ...legacy, status: 'error' });
  check(readGarminState(ldb).lastError === null, 'a state written before this field reads as no detail');
}

// ---------------------------------------------------------------------------
console.log('11. single flight and the throttle');
{
  const { db: fdb } = freshDb();
  let t = NOON.getTime();
  forgetGarminToken();
  const g = fakeGarmin(() => t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const d = deps(g, () => t, KEY, { waitForHealth: () => gate });
  const a = startGarminPass(fdb, d);
  const b = startGarminPass(fdb, d);
  check(
    a === b && isGarminSyncRunning(),
    'a second start joins the running pass, which is marked running at once'
  );
  const idle = waitForGarminSyncIdle(5000);
  release();
  await a;
  check(
    (await idle) === 'idle' && !isGarminSyncRunning(),
    'the Coach’s wait resolves when the pass settles'
  );
  t += 5 * 60_000;
  const calls = g.calls.length;
  check(
    (await syncGarminIfDue(fdb, d)) === null && g.calls.length === calls,
    'inside 15 minutes: no automatic pass'
  );
  t += 11 * 60_000;
  check((await syncGarminIfDue(fdb, d))?.outcome === 'synced', 'after 15 minutes: one runs');
  check(
    (await syncGarminIfDue(
      fdb,
      deps(g, () => t, null)
    )) === null,
    'no key: nothing at all'
  );
}

// ---------------------------------------------------------------------------
console.log('12. the Coach reads the new types through the existing paths');
{
  const ctx = { now: NOON };
  const snapshot = JSON.parse(toolByName('get_today_snapshot').execute(db, {}, ctx));
  const today = snapshot.wearables?.today ?? {};
  check(today.hrv?.source === 'Garmin', 'today’s HRV, attributed to Garmin', today.hrv);
  check(
    typeof today.body_battery_wake?.label === 'string' &&
      today.body_battery_wake.label.includes('Body Battery') &&
      !today.body_battery_wake.inferred,
    'Body Battery at wake arrives labelled, not inferred',
    today.body_battery_wake
  );
  check(
    today.hrv_status?.label?.includes('4 balanced'),
    'HRV status carries its code key',
    today.hrv_status
  );
  const series = JSON.parse(
    toolByName('get_metric_series').execute(db, { metric: 'sleep_score', days: 7 }, ctx)
  );
  check(
    JSON.stringify(series).includes('82') && !series.inferred,
    'get_metric_series reads sleep score',
    series
  );
}

// ---------------------------------------------------------------------------
console.log('13. the key and the token are never at rest anywhere ARC writes');
{
  const jwtSeen = garmin.lastJwt.value;
  const captured = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => {
      captured.push(args.map(String).join(' '));
    };
  }
  try {
    forgetGarminToken();
    clockMs += 3600_000;
    await runGarminPass(db, deps(fakeGarmin(clock), clock));
    forgetGarminToken();
    await runGarminPass(
      db,
      deps(
        fakeGarmin(clock, (url) => (url === GARMIN_TOKEN_URL ? { status: 401 } : null)),
        clock
      )
    );
  } finally {
    Object.assign(console, original);
  }
  const tables = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((r) => r.name);
  const dump = tables
    .map((name) => JSON.stringify(raw.prepare(`SELECT * FROM "${name}"`).all()))
    .join('\n');
  check(
    jwtSeen && !dump.includes(KEY) && !dump.includes(jwtSeen),
    `no table of ${tables.length} holds the key or a token`
  );
  const exported = serializeExport(buildExport(db, { exportedAt: NOON.toISOString() }));
  check(
    !exported.includes(KEY) &&
      !exported.includes(jwtSeen) &&
      exported.includes('garmin_personal_api'),
    'the export carries the link’s cursor and neither secret'
  );
  check(
    !JSON.stringify(getSyncStateValue(db, GARMIN_SYNC_KEY)).includes(KEY),
    'the cursor itself is clean'
  );
  check(
    captured.every((line) => !line.includes(KEY) && !line.includes(jwtSeen)),
    'nothing logged either'
  );
}

// ---------------------------------------------------------------------------
console.log('14. Disconnect — forget the key and the token, keep the rows');
{
  garminKeyStore.setKey(KEY);
  const rowsBefore = gpRows(db).length;
  disconnectGarmin(db);
  check(
    garminKeyStore.get() === null && getSyncStateValue(db, GARMIN_SYNC_KEY) === null,
    'key and cursor gone'
  );
  check(gpRows(db).length === rowsBefore && rowsBefore > 0, 'every synced row stays');
  const g = fakeGarmin(clock);
  await openGarminSession({ key: KEY, fetchImpl: g.fetchImpl, now: clock }).get(
    '/hrv-service/hrv/daily/2026-10-19/2026-10-21'
  );
  check(g.mints() === 1, 'the token went with it: the next session mints');

  // Disconnect lands while a pass is out: its rows stay, its cursor is not recreated.
  const { db: ddb } = freshDb();
  let key = KEY;
  forgetGarminToken();
  const midway = fakeGarmin(clock, (url) => {
    if (url.includes('/activitylist-service/')) key = null;
    return null;
  });
  await runGarminPass(ddb, { ...deps(midway, clock), getKey: () => key });
  check(
    gpRows(ddb).length > 0 && getSyncStateValue(ddb, GARMIN_SYNC_KEY) === null,
    'a Disconnect during a pass keeps what arrived and leaves no cursor behind'
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
