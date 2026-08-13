/**
 * A one-shot, in-memory handoff of draft text from the import screen to the
 * editor — the manual floor's prefill (docs/knowledge-subapp.md §5).
 *
 * ## Why this is not a route param
 *
 * The obvious implementation is
 * `router.replace({ pathname: '/knowledge-entry-edit', params: { body: text } })`,
 * and it is wrong for a payload of this shape. Expo Router params are search
 * params: they round-trip through URL encoding, and `useLocalSearchParams`
 * decodes what it receives. A pasted article is 5–40 KB of arbitrary prose that
 * routinely contains `%` ("50% of patients", "%20" inside a quoted URL) — and a
 * stray percent sign is not a cosmetic problem, it is a `URIError` or a silently
 * mangled paragraph, landing on the exact path the user reaches when import has
 * *already* failed them once. Content goes through memory; identifiers go
 * through params. `topic` and `id` are still params, correctly.
 *
 * The module-scoped read-and-clear is the shape `consumeIncomingShare`
 * (src/lib/recipes/incoming-share.ts) already establishes, including its replay
 * window: React can run a screen's state initializer more than once for a single
 * mount (StrictMode, and the compiler's re-renders), and the first call has
 * already cleared the store. Without the window the second run gets nothing and
 * the user's paste vanishes.
 */

/** How long a just-consumed draft stays replayable. Matches incoming-share. */
const REPLAY_MS = 3000;

let pending: string | null = null;
let lastConsumed: { body: string; at: number } | null = null;

/** Stash text for the editor to pick up on its next mount. */
export function stashKnowledgeDraft(body: string): void {
  const trimmed = body.trim();
  pending = trimmed === '' ? null : trimmed;
}

/**
 * Read-and-clear the stashed draft body, or null if there isn't one. Safe to
 * call from a `useState` initializer — a second call within the replay window
 * returns the same text rather than losing it.
 *
 * `now` is injectable so db/knowledge-import.test.mjs can exercise the window
 * without sleeping.
 */
export function consumeKnowledgeDraft(now: number = Date.now()): string | null {
  if (pending !== null) {
    const body = pending;
    pending = null;
    lastConsumed = { body, at: now };
    return body;
  }
  if (lastConsumed && now - lastConsumed.at < REPLAY_MS) return lastConsumed.body;
  return null;
}

/** Test-only: forget everything, so suites don't leak state into each other. */
export function resetKnowledgeDraft(): void {
  pending = null;
  lastConsumed = null;
}
