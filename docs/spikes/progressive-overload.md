# Item 87 — PR stamps, or a progressive-overload mark?

**Status: STUDY ONLY** (round 3, 2026-10-21). Nothing here is built. The owner's
note, verbatim: *"idea study: swap prs for progressive overload indication"*.
This page says what each would show, where, and what it would cost, then
recommends one shape and asks one question (§6).

---

## 1. What ARC shows today

Three surfaces already speak about progress, and they answer three different
questions.

| Surface | Where | What it says | Computed by |
| --- | --- | --- | --- |
| **PR stamp** | live logger, per set, at the tick | "this set beat a record" — and which: best e1RM, heaviest, rep max at a weight, set volume, most reps, session volume / reps, longest, farthest, fastest pace | `stampFor` → `recordsBeaten` (`src/lib/exercise/records.ts`) |
| **PR line** | live logger, under each block | "Set 3: best e1RM, heaviest" | `prSummaryParts` |
| **Direction of travel** | Train hub's Exercises rows; exercise detail's Trend | "+6% on the previous 3 sessions" — the latest home session against the mean of the three before it, level within ±2% | `trendOf` / `directionOf` |
| **Progression target** (new, round 3) | live logger, per set, as grey numbers | "hold 95 lb and add a rep" / "add a plate, back to 6" / "drop ~10% and rebuild" | `suggestProgression` (`progression.ts`) via `set-hints.ts` |

Away sessions (0055) are excluded from all four as a baseline; assisted
movements (0062) are judged on reps, not on the help.

## 2. What is wrong with PR stamps as the main signal

1. **They are rare by construction, and get rarer.** A record needs a previous
   best to beat. After the first months, a lifter on double progression beats
   an all-time record on a minority of sessions — most sessions are *the plan
   working* (a rep more at the same load), which beats nothing. So the stamp is
   silent on exactly the sessions that are going right.
2. **They are noisy when they do fire.** Ten record kinds means a set can stamp
   for "set volume" on a light, high-rep back-off set the owner did not mean as
   a test. The stamp is true and uninformative.
3. **They answer "best ever?", not "on track?".** Progressive overload is a
   statement about *this session against the last few*, which is what the
   direction line and the progression target already compute.

## 3. What a progressive-overload mark would show

### Per set (in the logger, at the tick)

The set is compared with **its own target** — the grey numbers it was shown —
not with history at large:

| Mark | When | Example (target 95 × 9) |
| --- | --- | --- |
| **▲ ahead** | more reps at the target load, or the target reps at more load | 95 × 10, or 100 × 9 |
| **● on target** | the target met | 95 × 9 |
| **▽ short** | under the target | 95 × 7 |
| (none) | a warm-up, an away session, a row with no target | — |

This is cheap: the target is already on the row (`SetTarget`, round 3), and the
comparison is reps-at-load against reps-at-load. No new data, no migration.

### Per session (on the hub row and the session record)

One word per movement, from the progression engine's own state, not a new rule:

| Word | Means | Source |
| --- | --- | --- |
| **progressing** | the engine's last answer was `progress`, or the session met/beat its targets | `suggestProgression` + the per-set marks |
| **holding** | `hold`, targets partly met | same |
| **stalled** | `deload` — the engine's three-session stall rule fired | `STALL_SESSIONS` |

The existing direction line ("+6% on the previous 3 sessions") stays as the
number behind the word.

## 4. The two options

**A. Replace the PR stamp with the overload mark.** The stamp slot on the row
shows ▲ / ● / ▽; records live only on exercise detail (where `recordSessionIds`
already marks record sessions in History) and in the self-review.

- For: one signal at the tick, and it is the one that says whether today is
  going to plan. Fires every working set, so it is never silent.
- Against: a genuine all-time best — the moment people actually enjoy — loses
  its stamp in the logger. And the mark is only as good as the target: on a
  movement with no target (never done, a plank, a run, assisted) it is blank.

**B. Keep PRs, demote them, add the mark.** The tick shows the overload mark;
a set that ALSO beats a record keeps a small `PR` in the block's PR line (as
today), but only for the three kinds that mean strength — best e1RM, heaviest,
rep max at a weight. Volume and rep-count records stay on exercise detail.

- For: keeps the rare good moment, removes most of the noise, and puts the
  everyday signal where the eye is.
- Against: two marks on one table; the footer line has to say which is which.

## 5. Recommendation

**B**, with the per-set mark first and the per-session word second:

1. The per-set ▲ / ● / ▽ beside the stamp, compared with the row's own target.
   Pure, testable (`set-hints.ts` already holds the target), no migration.
2. Trim the live PR line to the three strength records.
3. Then the hub row's word (progressing / holding / stalled), read from the
   engine, beside the existing direction figure.

Nothing in it is a new training rule: "on target" is the engine's own target,
and "stalled" is the engine's own stall rule.

**What only a phone can settle:** whether a mark on every working set reads as
encouragement or as nagging mid-set, and whether ▽ on a set the owner
deliberately cut short (a bad day, a niggle) feels like a verdict. The marks
would be ink, never signal colour — they describe a plan, not his body.

## 6. The question for the owner

> **When you said "swap PRs for progressive overload", did you want the PR
> stamp gone from the logger entirely (A), or kept for real strength records
> only, with an ahead / on target / short mark on every working set beside it
> (B, recommended)?**
