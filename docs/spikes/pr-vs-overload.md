# PR stamps vs a progressive-overload mark

**Item 87.** Status: **DECIDED and BUILT** (2026-10-21). The owner chose **option C**, answered **Q1 no** and **Q2 yes**, and put the per-set mark (appendix) at **not now**. As built: `docs/exercise-subapp.md` §20. The study below is kept as written; where the build differs, a note says so.

Owner's note, verbatim: *"idea study: swap prs for progressive overload indication"*.

**Migration:** none. Everything below is computed from `workout_sets`.

**Citations** are verified against `main` at `6991f6c`.

## What exists now

ARC already shows three things about how a lift is going.

**1. PR stamps and marks** (`src/lib/exercise/records.ts`)

- There are ten record kinds (`:292-315`): e1RM, heaviest, best at N reps, set volume, most reps, session volume, session reps, duration, distance, pace.
- One rule, `kindsBeating` (`:590-656`), drives every PR surface:
  - the live stamp per set, via `stampFor`, `app/workout-live.tsx:1208-1232`, with its "PR" line at `:2073-2082`;
  - the history's PR mark, via `recordSessionIds` (`records.ts:740`, `app/exercise-detail.tsx:448-483`);
  - the self-review's record line (`src/lib/reports/assemble-self-review.ts:517-522`).
- The Records grid on exercise detail (`app/exercise-detail.tsx:379`) is drawn from the same kinds.

**2. The direction of travel**

- Rule: the latest home session's e1RM against the mean of the up-to-3 before it, reading level within ±2% (`trendOf`, `records.ts:1042-1096`).
- It shows as `+4%` / `−3%` / `level` on each Train hub row (`app/exercise.tsx:623-628`, from `src/lib/db/repositories/training-stats.ts:338-350`), and as lines under the exercise-detail Trend (item 66).

**3. The progression engine** (`src/lib/exercise/progression.ts:81-135`)

- Each session's best set is chosen by effort-adjusted e1RM (`training-stats.ts:174-199`). Double progression then runs on it:
  - At the top of the rep range with a rep in reserve: add load.
  - On a stall: deload 10%. A stall is 3 sessions (`STALL_SESSIONS`, `constants.ts:317`) with no session-to-session e1RM gain, all below the top of the range.
  - Otherwise: hold the load and add a rep.
- Rep ranges are 6–10 for compounds and 8–15 for isolations (`constants.ts:294-297`).

### What is wrong with them, as signals of overload

- **PRs reward the cheap.** "Session volume" and "session reps" are beaten by adding a set (Example 3). "Best at N reps" fires the first time a heavier load meets a rep count. In a 3-set double-progression block, some PR fires most sessions, so the stamp stops meaning "you got stronger".
- **The % arrow punishes the right move.** A load jump resets reps to the bottom of the range, which lowers e1RM. The hub then reads `−4%` on exactly the session progression asked for (Example 1).
- **The engine misses a zig-zag stall.** Its test is "did any session beat the one before it", so 7, 6, 7 reps at one load counts as improving, and it keeps prescribing "add a rep" forever (Examples 2 and 3).

## The mark, defined

The mark is per movement, from **home sessions only** (the 0055 rule, `baselineRows`, `records.ts:122`). Each session is represented by its best set, as the engine sees it.

**A session ADVANCED** if its best set beats **each** of the up-to-3 home sessions before it, where *a beats b* when any of the following holds:

1. **Load up, held in range:** `a.load > b.load` and `a.reps ≥ range.low`. This is a successful double-progression jump, even though e1RM drops.
2. **Rep added at the same load:** `a.load = b.load`, `a.reps > b.reps`, and the effort-adjusted e1RM is not lower. A grinder at RPE 10 does not out-rank a clean set at RPE 7.
3. **Anything else clearly stronger:** e1RM up by **≥1%**. This covers a lighter load for many more reps, or the same set at lower RPE (e1RM uses reps + RIR, `e1rm.ts:17-21`). The 1% threshold sits under one rep at 8 reps (≈2.6%) and one small plate on a mid-weight lift (≈1.3%), and over unit-conversion jitter.

"Each of the previous 3" rather than "the previous one" is what makes a rebound (7 → 6 → 7) not count. The session has to set a new high-water mark.

**`sinceBest`** is the number of home sessions since the last one that advanced. The mark is:

| Mark | Condition | What it tells him |
|---|---|---|
| **Progressing** | `sinceBest = 0`: the latest session advanced | he added load or reps last time |
| **Holding** | `sinceBest = 1`; or `sinceBest ≥ 2` but one of the last 3 sessions reached the top of the range (the engine's next step is a load jump) | flat for now, and that is normal |
| **Stalled** | `sinceBest ≥ 2` and the last 3 sessions are all below the top of the range | 3 sessions without a new best; the engine prescribes a deload |
| *(none)* | fewer than 3 home sessions; last session more than 42 days ago (`CAPABILITY_WINDOW_DAYS`, `constants.ts:284`); assisted, or anything covering distance (the `directionMetricsFor` exclusions, `records.ts:951-955`) | — |

Movements with reps and no load use rule 2 alone, with load equal at zero.

**Stalled must mean exactly when the engine deloads.** The build therefore replaces the engine's `improved` test (`progression.ts:115-117`) with this advanced/`sinceBest` predicate: one exported function, two callers. **That changes behaviour.** Zig-zag stalls will now get a deload suggestion where they currently get "add a rep" (open question 2).

## Three worked examples (and a fourth, after a deload)

The numbers were computed with Epley on reps + RIR, which is ARC's own formula.

**1. Bench press, 6–10. The load jump.**

| Session | Best set | e1RM | Hub arrow today | PR today | Mark |
|---|---|---|---|---|---|
| S1 | 80 × 8 @ 8 | 106.7 | — | — | — |
| S2 | 80 × 9 @ 8 | 109.3 | +3% | e1RM, set vol, most reps, session vol/reps | — |
| S3 | 80 × 10 @ 8.5 | 110.7 | +2% | e1RM, set vol, most reps, session vol/reps | Progressing |
| S4 | 82.5 × 6 @ 8 | 104.5 | **−4%** | heaviest | **Progressing** (rule 1) |
| S5 | 82.5 × 7 @ 8 | 107.3 | level | best at 7 | Progressing (rule 2) |

The arrow calls the jump a regression, and the mark does not. The engine is right throughout: at S5 its target is 82.5 × 8.

**2. Overhead press, 6–10. The zig-zag stall.**

| Session | Best set | e1RM | Hub arrow | PR | Mark | Engine now → shared predicate |
|---|---|---|---|---|---|---|
| S1 | 50 × 7 @ 9 | 63.3 | — | — | — | |
| S2 | 50 × 7 @ 9.5 | 62.5 | level | — | — | |
| S3 | 50 × 6 @ 9 | 61.7 | level | — | Stalled | deload → deload |
| S4 | 50 × 7 @ 9.5 | 62.5 | level | — | **Stalled** | **hold 50 × 8** → deload 45 × 6 |

Four sessions at 50 kg × 6–7. Today, S4's rebound "improves" on S3, so the engine stops deloading, and nothing on any screen says he is stuck. The mark says so.

**3. Romanian deadlift, 6–10. A PR while stalled.**

| Session | Sets | Best set | e1RM | PR | Mark |
|---|---|---|---|---|---|
| S1 | 100 × 8, 8, 7 | 100 × 8 @ 8 | 133.3 | — | — |
| S2 | 100 × 8, 7, 7 | 100 × 8 @ 8.5 | 131.7 | — | — |
| S3 | 100 × 7, 7, 7 | 100 × 7 @ 8 | 130.0 | — | Stalled |
| S4 | 100 × 8, 8, 8, 7 | 100 × 8 @ 8 | 133.3 | **session volume, session reps** | **Stalled** |

The fourth set buys two PR stamps on a lift that has not moved in four sessions. *(Build note: ARC keeps "most reps in a session" only for a movement with no load, so on a loaded RDL the stamp was session volume alone; the point stands.)* The mark measures the best set, because that is what the engine progresses. Volume progression is real, and it stays visible where it is measured: the Trend's Volume chip and the weekly-volume ledger.

**4. Squat, 6–10. After the deload (added by the 2026-10-21 review, built).**

| Session | Best set | Mark | Engine, as first built | Engine now |
|---|---|---|---|---|
| S1–S3 | 100 × 6 @ 9, three times | Stalled at S3 | deload 90 × 6 | deload 90 × 6 |
| S4 | 90 × 6 @ 8 | **Holding** (no new best in 3 sessions) | **deload 81 × 6** | hold 90 × 7 |
| S5 | 90 × 7 @ 8 | **Progressing** (rule 2) | **deload 81 × 6** | hold 90 × 8 |
| S6 | 90 × 8 @ 8 | **Progressing** (rule 2) | **deload 81 × 6** | hold 90 × 9 |

As first built, every rebuild session was compared with the heavier 100s, so none advanced and the lift read Stalled while he added a rep a session. Now a load drop of at least 5% (`LOAD_DROP_FRACTION`, half the deload) starts a **block** (`blockStart`, `progression.ts`): the drop session is judged against what it dropped from (a deload is no advance; a lighter load for clearly more, rule 3, still is), and every session after it only against its own block. Stalled needs three sessions in the current block, so a rebuild that stalls on its own (90 × 6 three times) deloads again, to 81.

## Where the mark would appear

- **Train hub row.** The mark in the label voice replaces the `+4%` token (`app/exercise.tsx:623-628`). Its VoiceOver line reads "Progressing" plus `trendPhrase`.
- **Exercise detail.**
  - One line heads the Trend: "Stalled · no new best in 3 sessions · next: 45 kg × 6", where "next" is the engine's own target.
  - The % direction lines stay under the chart, where a range gives them meaning.
  - In History, a session that advanced is marked **ADVANCED**, replacing **PR** (`app/exercise-detail.tsx:483`).
- **Live logger.** The per-set PR stamp is replaced by one block-level line. It appears when the block's best set so far would make today an advance: "Advanced · +1 rep at 82.5 kg". It is computed with the same predicate against the logged history, as `stampFor` is now.
- **Coach.** `mark` and `sinceBest` per exercise go into `get_training_recommendation`'s result. That is payload, not schema, so it does not touch the §6 token ceilings. The Coach decides what a stall means; the mark only says one happened.
- **No signal colour.** This is a statement about training, not biology. It stays in ink, and the accent budget is untouched.

## Do PRs stay?

| Option | What it means |
|---|---|
| **A. Add the mark, keep every PR** | The least change. The noise stays, and two systems give two verdicts on the same set (Example 3: "PR", and "Stalled"). |
| **B. Remove PRs entirely** | The Records grid goes too. Losing all-time bests as a reference is a real loss for a decades-long log. |
| **C. Swap the signals, keep the reference** | The mark replaces the live PR stamp, the history PR mark and the hub %. The **Records grid stays** on exercise detail as a table of facts. The self-review's e1RM record line stays, since it is retrospective and rare. |

**Decided: C** (owner, 2026-10-21). **Recommendation: C.** It is the owner's "swap" applied to the signals while keeping the record. It also makes the mark and the engine one rule, which closes the zig-zag hole that neither PRs nor the arrow can see.

**Size:** M, about 2 days.

- A pure `overloadMark` in `records.ts`. *(Built as `overloadMarkOf`; the predicate is `advanceRule` / `sessionAdvanced` / `isStalled` in `progression.ts`.)*
- The shared predicate in `progression.ts`, with headless tests built from these three examples.
- The four surfaces above.
- The `kindsBeating` and grid code stay, minus the two stamp call sites.

## Questions for the owner

**Q1. In the gym, should a set that beats your all-time best e1RM still say so, beside the "Advanced" line?** *Answered: no.*

- **Recommended: no.** The best is one tap away in Records.
- A second stamp brings back the two-verdict problem.

**Q2. May the deload suggestion change so that "Stalled" and "deload" always agree?** *Answered: yes.*

- **Recommended: yes.** This means a zig-zag such as 7, 6, 7 at one load now earns a deload, where it currently earns "add a rep".

## Appendix: a per-set mark against the target (from the logger round, 2026-10-21)

The agent that built the per-set targets (65) studied the same item independently and proposed a complementary mark: each working set compared with **its own grey target** at the tick.

| Mark | When | Example (target 95 × 9) |
| --- | --- | --- |
| **▲ ahead** | more reps at the target load, or the target reps at more load | 95 × 10, or 100 × 9 |
| **● on target** | the target met | 95 × 9 |
| **▽ short** | under the target | 95 × 7 |
| (none) | a warm-up, an away session, a row with no target | — |

It needs no new data: the target is already on the row (`src/lib/exercise/set-hints.ts`). It sits beside the session mark above rather than replacing it: the session mark says whether the lift is moving, the per-set mark whether today is going to plan. That study also suggested trimming the live PR line to the three strength records (best e1RM, heaviest, rep max at a weight) rather than removing it; option C above removes the live stamp outright and keeps every record in the Records grid.

The risk it names: a mark on every working set may read as nagging mid-set, and ▽ on a set cut short on purpose may feel like a verdict. Marks are ink, never signal colour. **Recommendation:** not now; build the session mark (option C), use the targets on the phone, and add the per-set mark only if the targets prove useful. *Decided: not now* (owner, 2026-10-21).
