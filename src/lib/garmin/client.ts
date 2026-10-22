/**
 * The Garmin Personal API client — the ONE module in ARC that talks to Garmin
 * (docs/wearables-subapp.md §26, docs/decisions.md "Garmin via the official
 * Personal API", 2026-10-21). Nothing else imports `fetch` for Garmin, and
 * nothing here is reachable by the Coach: it has no tool, and the sync that
 * calls this is deterministic.
 *
 * ## The protocol, as Garmin published it (2026-10-21)
 *
 *   1. POST {@link GARMIN_TOKEN_URL} with `Authorization: ApiKey <key>` returns
 *      a bearer JWT that lives 24 hours. There is no refresh token: a new one
 *      is minted by presenting the key again.
 *   2. Every data read is a GET on {@link GARMIN_API_ORIGIN} with
 *      `Authorization: Bearer <jwt>`.
 *
 * Garmin's own reference client (github.com/garmin/connect-personal-api-python)
 * re-mints when under an hour of the token remains; so does this one
 * ({@link TOKEN_REMINT_MARGIN_MS}).
 *
 * ## What it refuses to do
 *
 *   - **Any host but Garmin's**, and any path outside {@link GARMIN_READ_PATHS}.
 *     The token could do more than read; the code is what keeps ARC to reads.
 *   - **Hold the token anywhere but this module's memory.** It is re-minted on a
 *     cold start (one request) rather than written to the Keychain: a 24-hour
 *     credential that a relaunch can replace is not worth a second secret at
 *     rest.
 *   - **Say the key or the token out loud.** Every error carries a fixed message
 *     and a status code, never a response body (a body can echo a header).
 *   - **More than its budget.** A session counts every request — the mint
 *     included — and stops at {@link GARMIN_REQUESTS_PER_PASS}. Garmin's rate
 *     limits are undocumented, so ARC stays far below anything plausible.
 *
 * ## How a failure is named
 *
 *   - 401/403 at the mint, or a 401 on a read that survives one re-mint and
 *     retry: {@link GarminRejectedError}. The key is revoked or expired, only a
 *     new key fixes it, and the sync stops and says so.
 *   - Any other failure at the mint (an unexpected status, a body ARC cannot
 *     read): {@link GarminTokenError}. The sync stops the pass — nothing can be
 *     read without a token, and stepping over every request would walk the
 *     backfill past history it never fetched.
 *   - 429 or any 5xx: {@link GarminBackoffError}, carrying Retry-After when sent.
 *   - A 403 on a read, and any other 4xx: {@link GarminRequestError} — that one
 *     endpoint refusing, not the key (the mint would have said so).
 *   - fetch itself throwing (offline, timeout): {@link GarminNetworkError}.
 *
 * Pure apart from the injected `fetch` and clock, so db/garmin.test.mjs drives
 * every branch with fixtures and no network.
 */

/** The only origin ARC ever sends a Garmin request to. */
export const GARMIN_API_ORIGIN = 'https://personal.connectapi.garmin.com';

/** Where the key is exchanged for a 24-hour bearer token. */
export const GARMIN_TOKEN_URL = `${GARMIN_API_ORIGIN}/personalapitoken-service/personal-api/personal-api-key/token`;

/** The read endpoints ARC uses — prefixes; nothing outside them is requested. */
export const GARMIN_READ_PATHS: readonly string[] = [
  '/hrv-service/hrv/daily/',
  '/sleep-service/sleep/dailySleepSummariesByDate',
  '/usersummary-service/v2/dailysummaries',
  '/wellness-service/wellness/bodyBattery/reports/daily',
  '/activitylist-service/activities/search/activities',
];

/** Re-mint when less than this much of the token's life remains (Garmin's client: 1 h). */
export const TOKEN_REMINT_MARGIN_MS = 60 * 60 * 1000;
/** Assumed lifetime when the token response states none: Garmin documents 24 h. */
export const TOKEN_DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** A token minted this recently is reused even when its stated life is under the margin. */
export const FRESH_MINT_REUSE_MS = 10 * 60 * 1000;
/** Every request a single sync pass may make, the mint included. */
export const GARMIN_REQUESTS_PER_PASS = 8;
/** One request's ceiling before it counts as a network failure. */
export const GARMIN_REQUEST_TIMEOUT_MS = 20_000;

/** The fetch surface the client needs; React Native's global fetch satisfies it. */
export type GarminFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<GarminFetchResponse>;

export type GarminFetchResponse = {
  status: number;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
};

/** The key is revoked or expired: Garmin refused it, or a token minted from it. */
export class GarminRejectedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Garmin refused the key (HTTP ${status})`);
    this.name = 'GarminRejectedError';
    this.status = status;
  }
}

/** Garmin asked ARC to slow down (429) or is failing (5xx). */
export class GarminBackoffError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`Garmin asked ARC to wait (HTTP ${status})`);
    this.name = 'GarminBackoffError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A request Garmin would not serve for its own reasons (400, 404…). */
export class GarminRequestError extends Error {
  readonly status: number;
  constructor(status: number, what: string = 'request') {
    super(`Garmin could not serve the ${what} (HTTP ${status})`);
    this.name = 'GarminRequestError';
    this.status = status;
  }
}

/** The pass spent its request budget. Not a failure: the next open continues. */
export class GarminBudgetError extends Error {
  constructor() {
    super('Garmin request budget for this pass is spent');
    this.name = 'GarminBudgetError';
  }
}

/** fetch threw — offline, a timeout, a dropped connection. */
export class GarminNetworkError extends Error {
  constructor() {
    super('Could not reach Garmin');
    this.name = 'GarminNetworkError';
  }
}

/**
 * The token could not be minted for a reason other than a refused key: an
 * unexpected status, or a body ARC cannot read. Nothing can be fetched without
 * a token, so the sync stops the pass on this rather than stepping over every
 * request (and walking its cursors past history it never read).
 */
export class GarminTokenError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Garmin's token reply could not be used (HTTP ${status})`);
    this.name = 'GarminTokenError';
    this.status = status;
  }
}

// --- The token --------------------------------------------------------------

type TokenCache = {
  token: string;
  expiresAt: number;
  /** The key it was minted from — a new paste must never reuse the old token. */
  mintedFrom: string;
  /** When it was minted — a token minted this pass is used for this pass, whatever its exp says. */
  mintedAt: number;
  keyExpiresAt: string | null;
};

// In memory only, for the life of the process. See the header.
let cached: TokenCache | null = null;

/** Drop the cached token (Disconnect, a new key, a refusal). */
export function forgetGarminToken(): void {
  cached = null;
}

/** Decode a base64url string to text without relying on `atob` (Hermes). */
function base64UrlDecode(input: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) return null;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  // UTF-8 decode, enough for a JSON claim set.
  try {
    return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return null;
  }
}

/** The claims of a JWT, or null when it is not one. The signature is not checked: ARC only reads `exp`. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const json = base64UrlDecode(parts[1]);
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const TOKEN_FIELDS = ['access_token', 'accessToken', 'token', 'jwt'] as const;
const LIFETIME_FIELDS = ['expires_in', 'expiresIn'] as const;

/** A date-ish field value → ISO instant, or null. Numbers are epoch seconds or ms. */
function instantOf(value: unknown): string | null {
  // Below 1e9 a number is a duration (seconds left), not an instant — never a date.
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1e9) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/**
 * Read the token response. The shape was not published with the spec, so this
 * accepts the common spellings (`access_token` / `accessToken` / `token` /
 * `jwt`, `expires_in` / `expiresIn` in seconds) and a bare JWT body. Expiry
 * comes from the JWT's own `exp` first, then the stated lifetime, then Garmin's
 * documented 24 hours. A field naming the KEY's expiry is kept when present so
 * Settings can show it; it is not a secret. Pure.
 */
export function parseTokenResponse(
  body: string,
  mintedAt: number
): { token: string; expiresAt: number; keyExpiresAt: string | null } | null {
  const text = body.trim();
  let token: string | null = null;
  let lifetimeMs: number | null = null;
  let keyExpiresAt: string | null = null;
  if (text.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    for (const field of TOKEN_FIELDS) {
      const value = parsed[field];
      if (typeof value === 'string' && value.length > 0) {
        token = value;
        break;
      }
    }
    for (const field of LIFETIME_FIELDS) {
      const value = parsed[field];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        lifetimeMs = value * 1000;
        break;
      }
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (/key/i.test(name) && /expir/i.test(name)) {
        keyExpiresAt = instantOf(value);
        if (keyExpiresAt) break;
      }
    }
  } else if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(text.replace(/^"|"$/g, ''))) {
    token = text.replace(/^"|"$/g, '');
  }
  if (token === null) return null;
  const exp = decodeJwtPayload(token)?.exp;
  const expiresAt =
    typeof exp === 'number' && Number.isFinite(exp) && exp > 0
      ? exp * 1000
      : mintedAt + (lifetimeMs ?? TOKEN_DEFAULT_LIFETIME_MS);
  return { token, expiresAt, keyExpiresAt };
}

/** Retry-After in ms: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(header: string | null | undefined, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// --- The session ------------------------------------------------------------

export type GarminSessionOptions = {
  /** The owner's key, read from the Keychain store by the caller. */
  key: string;
  fetchImpl: GarminFetch;
  now?: () => number;
  /** Requests this session may make, the mint included. */
  budget?: number;
  timeoutMs?: number;
};

export type GarminSession = {
  /** GET one read endpoint. Resolves to the parsed JSON, or null for 204 / an empty body. */
  get(path: string, query?: Record<string, string | number | boolean>): Promise<unknown>;
  /** Requests made so far, the mint included. */
  requestsMade(): number;
  /** What the token response said about the KEY's expiry, if anything. */
  keyExpiresAt(): string | null;
};

function isAllowedPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('//') &&
    GARMIN_READ_PATHS.some((prefix) => path.startsWith(prefix))
  );
}

function queryString(query: Record<string, string | number | boolean> | undefined): string {
  if (!query) return '';
  const pairs = Object.entries(query).map(
    ([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`
  );
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

/**
 * Open a session over one sync pass. The token is shared across sessions
 * through the module cache, so a pass inside the token's life mints nothing.
 */
export function openGarminSession(options: GarminSessionOptions): GarminSession {
  const now = options.now ?? (() => Date.now());
  const budget = options.budget ?? GARMIN_REQUESTS_PER_PASS;
  const timeoutMs = options.timeoutMs ?? GARMIN_REQUEST_TIMEOUT_MS;
  let made = 0;

  type Reply = { status: number; retryAfter: string | null; text: string };

  // The body is read inside the same timeout as the headers, so a stalled body
  // is a network failure too.
  const send = async (
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>
  ): Promise<Reply> => {
    if (made >= budget) throw new GarminBudgetError();
    made++;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await options.fetchImpl(url, {
        method,
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = response.status === 204 ? '' : await response.text();
      return {
        status: response.status,
        retryAfter: response.headers?.get('retry-after') ?? null,
        text,
      };
    } catch {
      throw new GarminNetworkError();
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const backoffOrNull = (reply: Reply): GarminBackoffError | null =>
    reply.status === 429 || reply.status >= 500
      ? new GarminBackoffError(reply.status, parseRetryAfter(reply.retryAfter, now()))
      : null;

  const mint = async (): Promise<TokenCache> => {
    const response = await send(GARMIN_TOKEN_URL, 'POST', {
      Authorization: `ApiKey ${options.key}`,
      Accept: 'application/json',
    });
    if (response.status === 401 || response.status === 403) {
      forgetGarminToken();
      throw new GarminRejectedError(response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw backoffOrNull(response) ?? new GarminTokenError(response.status);
    }
    const parsed = parseTokenResponse(response.text, now());
    if (parsed === null) throw new GarminTokenError(response.status);
    cached = { ...parsed, mintedFrom: options.key, mintedAt: now() };
    return cached;
  };

  const token = async (): Promise<TokenCache> => {
    const current = cached;
    if (current !== null && current.mintedFrom === options.key) {
      const left = current.expiresAt - now();
      // Fresh enough — or minted moments ago with a short stated life, which a
      // second mint would not lengthen: use it rather than mint on every read.
      if (left > TOKEN_REMINT_MARGIN_MS) return current;
      if (left > 0 && now() - current.mintedAt < FRESH_MINT_REUSE_MS) return current;
    }
    return mint();
  };

  return {
    async get(path, query) {
      if (!isAllowedPath(path)) throw new Error('garmin client: path outside the read allow-list');
      const url = `${GARMIN_API_ORIGIN}${path}${queryString(query)}`;
      let retried = false;
      for (;;) {
        const bearer = await token();
        const response = await send(url, 'GET', {
          Authorization: `Bearer ${bearer.token}`,
          Accept: 'application/json',
        });
        // 401 is the token (or the key behind it): re-mint once. A 403 on a
        // READ is this endpoint refusing, not the key — the mint would have
        // said so — so it is that request's failure only.
        if (response.status === 401) {
          forgetGarminToken();
          if (retried) throw new GarminRejectedError(response.status);
          retried = true;
          continue;
        }
        if (response.status === 204) return null;
        if (response.status < 200 || response.status >= 300) {
          throw backoffOrNull(response) ?? new GarminRequestError(response.status, 'read');
        }
        if (response.text.trim() === '') return null;
        try {
          return JSON.parse(response.text) as unknown;
        } catch {
          throw new GarminRequestError(response.status, 'read');
        }
      }
    },
    requestsMade: () => made,
    keyExpiresAt: () =>
      cached !== null && cached.mintedFrom === options.key ? cached.keyExpiresAt : null,
  };
}

/** React Native's global fetch, shaped as {@link GarminFetch}. Only the sync's default reaches it. */
export function deviceFetch(): GarminFetch {
  return (url, init) => (globalThis.fetch as unknown as GarminFetch)(url, init);
}
