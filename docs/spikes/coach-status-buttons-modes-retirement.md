# Modes revamp — Coach status buttons, and retiring the day-Modes system

**Status: BUILT — 2026-09-19.** Migration **`0061_status_replaces_modes.sql`**, branch
`claude/status`, five commits. The ADR is at the head of `docs/decisions.md`; the record of
record is `docs/information-architecture.md` §Status. Everything below is the design as it was
proposed; **what actually shipped departed from it in the ways listed immediately under this
note, and where the two disagree, this note wins.**

---

## What departed from this plan, and why

### 1. THE OWNER DIVERGED ON TWO OF THE FIVE QUESTIONS (§9)

**Q2 — excusal. He took (b), not the recommended (a).** Excusal is decided **per status, by the
Coach, through an `excuses` flag on `set_status`** — not uniformly. Consequences this plan did not
carry:

- `day_statuses` has an **`excuses integer NOT NULL CHECK (excuses IN (0,1))`** column, with **no
  DEFAULT**: every writer states it, so a row can never carry a judgement nobody made.
- The shared excusal definition reads **the flag**, not "every status". `excusedDatesIn` unions
  `excusingStatusDaysIn` (the `excuses = 1` subset), the frozen modes, and the timezone days.
- **The rail's own chip write defaults to `excuses = 1`.** The rail writes before any model turn —
  that is the point of it — so the chip needs a deterministic answer. The argument, and it is in
  the migration header: all five chips say *don't judge me by today*; a wrong `true` is recoverable
  by the Coach on the same turn; a wrong `false` silently counts a flu day as a run of misses.
- **An omitted `excuses` on `set_status` means "leave it as the row has it"**, never "default
  true". A re-ask must never re-excuse a day the Coach just un-excused. One clause in the tool
  description carries it, measured at ~14 tokens of the schema.
- §3.4's *Considered and rejected: an excusal flag on set_status* is **overruled by the owner**.
  Its worry about "a class of chip the rail cannot draw" did not materialise: the rail draws every
  status the same way and Home's line says `skips still count` when none of the open ones excuse.
- §3.4's rule that **a deload is never a status** stands, and got easier rather than harder: with a
  per-status flag the Coach can record a non-excusing state without anything having to refuse.
- **Baseline exclusion stayed uniform** (his Q3(a) says so with no mention of excusal), and that is
  argued where the two predicates live: excusal asks *should this be held against him*, a baseline
  asks *is this day evidence of what his normal looks like*.

**Q5 — Home. He took (c), not the recommended (a).** Home carries **both** the one mono line and a
control beside the date. The control is ONE small target in the label voice opening the rail's own
chips in a sheet — not a row of chips inlined on the folio row, because CLAUDE.md §5 is binding.
The chip row was extracted (`src/components/status/status-rail.tsx`) so Home and the Coach screen
cannot drift. Setting a status from Home does exactly what the rail does: writes the row first,
then carries the canned prompt to the Coach tab, seeded.

### 2. THE MIGRATION IS `0061`, NOT `0059`

`0059` (meal_item_piece_name) and `0060` (timezone_zone_pair) both merged while this was parked;
`0060`'s own header reserved `0061` for this build. Every in-file reference moved with it.

### 3. `day_statuses` HAS A SIXTH COLUMN THIS PLAN DID NOT NAME: `ended`

§3.3's DDL cannot support both gestures the owner's Q4(a) asks for. `end_date` says WHICH DAYS A
STATUS COVERS; `ended` says WHETHER IT IS STILL RUNNING, and they are different questions:

- **Night out** is born bounded at today, because it ends tonight — and its chip must read ON for
  the rest of today.
- **Sick** is open-ended, and the × must turn its chip OFF the instant it is tapped while leaving
  today excused, i.e. `end_date = today`.

With one column those two rows are byte-identical. So closing a status flips `ended` and writes
`end_date = today`; a bounded status is born `ended = 0` and simply has no tomorrow. **`ended`
never changes which days a status covered** — the accounting readers do not look at it.

### 4. `set_status`'s CARDS AND COST

Measured, not estimated: **282 tokens**, against `set_mode`'s 285 — **−3**, not the −49 this plan
predicted, because the `excuses` property is ~30 tokens the recommendation did not have. Paid for
by deleting a restatement inside the new tool (`label`'s description repeated the tool
description's `"normal" ends every open status`, −11).

The cards shipped as: `Status: traveling today` / `… from 2026-09-22 through 2026-09-26` /
`traveling is already set` / `End the sick status today` / `Nothing is set — no status to end` /
`work crunch: skips still count`. The last two are new: an empty reset must not promise a change,
and a non-excusing status must say so on the card, or the one thing the user would want to argue
with is the one thing the card does not mention.

**`set_status('normal')` does NOT cancel a scheduled future status**, where `set_mode`'s reset
cancelled future modes and had to name the casualties. Modes were forced into that by
newest-wins; statuses do not supersede each other at all, and *"I'm back to normal today"* is not
a statement about a flight on Monday.

### 5. THE PROMPT WENT OVER BY ONE, AND THE PLAN'S OWN FALLBACK WAS TAKEN

§3.5 predicted +13 against 31 of headroom. The real numbers, re-measured with the suite's formula
(main's `9,241` comment was stale; it is **9,237 / 3,669**):

- **Schema 9,237 → 9,233.** 17 of headroom.
- **Prompt 3,669 → 3,692.** The first measurement landed at **exactly 3,700**, which the `< 3700`
  assertion refuses. §3.5 names the trim to take if that happened — *the bullet's example list,
  −8* — and it was taken: the bullet carries `("sick", "traveling")` rather than four examples.
  8 of headroom, and the honest reading is that the prompt is now FULL.
- Haiku's cache floor: pass prefix 7,053 → 7,076, against 4,096.

### 6. THE STATE BLOCK'S ESCALATION IS GATED ON A COUNTERFACTUAL, NOT ON `recoveryDaysRemaining`

§3.4 says the line escalates to *"no recovery verdict until it ends"* once
`recoveryDaysRemaining > 0`. That is false on a phone with no watch: Recovery is `unknown` there
for a reason that predates this morning's status by months, and the sentence would blame the
status for a silence it had nothing to do with. `deriveReadiness` therefore also returns
**`recoveryPausedByStatus`** — *would Recovery grade if the status days had counted?* — computed
from series already in hand. The test that caught it is in `db/turn-context.test.mjs` §S.

### 7. `allTrips` GAINED A SECOND DECLARATION SOURCE

The timezone second pass (0060) landed after this plan was written, and it closes a derived trip on
a declared Travel MODE window. Retiring modes would have silently re-opened every journey the owner
declared. `allTrips` now reads a bounded `traveling` **status** and a frozen Travel **mode**; the
status half is the one place in the app that reads a status label rather than treating it as
opaque, and it is one-directional (a declaration can only close a trip), so a differently-worded
label costs nothing but the 21-day settle clock.

### 8. SMALLER ONES

- **The `Chip` was already extracted** from `app/protocol-edit.tsx` into
  `src/components/protocols/form-controls.tsx` before this build. It moved again, to
  `src/components/ui/chip.tsx`, and gained a `trailing` slot for the end glyph — the × is a sibling
  target inside the chip's outline, not part of its press area.
- **`db/modes.test.mjs` was retired one phase earlier than §7 plans**, alongside `set_mode`'s
  deletion rather than after it, so every commit on the branch is green. Its survivors landed where
  §6.14 put them.
- **§6.13's `refute('Set mode')`** is joined by refutations of `Normal`, `Today's mode` and
  `No training today` on Home, plus the status line asserted with an open status.
- **`AdherenceSection.modeNote` was renamed `excusedNote`**, because it now names three kinds of
  reason and a day may carry more than one — so the note says so out loud rather than letting a
  reader sum the counts and get more days than the period has.
- **`accountForDay`, `modeDirective`, `modeChangesPlan`, `MODE_KEYS` and `ModeItem` are deleted**,
  not merely unexported: §5 listed `accountForDay` as a survivor, but the reports assembler was its
  last caller and it moved onto `excusedDatesIn`.
- **The rail is `src/components/status/status-rail.tsx`**, not under `components/coach/`, because
  Home's sheet renders the same component.

### 9. THE GATE, AS RUN

`npx tsc --noEmit` exit 0 · `npm run db:validate` 20 passed · `npm run db:test` **56 suites, 0
failed** · `npm run lint` 0 errors (3 pre-existing warnings) · `npx expo export --platform ios
--clear` exit 0.

**Not verified on a device.** §8 below still stands in full, and its acceptance bar for "does the
Coach actually adjust" is unmet because it cannot be met headlessly.

---

## The plan as proposed

**Status: PROPOSED** (2026-09-15; second revision the same day, after an independent critique —
every finding is answered where it lands; where one is not followed, a *Considered and rejected*
note says why). Design only; no file on `main` has changed. The owner decided the *shape* on
2026-09-14 (§2); this is how it lands, what it costs, and the five calls only he can make (§9).

**Migration number: `0059`.** Main's head is `0058_composite_meal_items.sql` (`git ls-tree
--name-only main -- db/migrations/`, re-checked 2026-09-15), no branch holds a `0059` or higher,
and the runner applies only `version > user_version` (`src/lib/db/migrate.ts:70`) — a file numbered
at or below a device's head is never applied; a duplicate throws at boot (`:64-68`,
`db/migrate.test.mjs:98`). Re-measure at merge (memory `migration-forward-only-numbering`).

**The parked branch is not reused.** `claude/modes-feature-evaluation-579177` (`7a347d5`,
2026-08-25) removes Modes completely; its retirement migration is `0043`, colliding with main's
`0043_protocol_started_on.sql`. §5 lifts its ideas and its SQL and rewrites the rest.

**Backlog:** `docs/backlog-2026-09.md:64`. **Three deliberate changes ride along, named so nobody
reads them as accidents:** `outstandingCarries` adopts the shared excusal definition, altering C11
carry-over on timezone-changed days; status days join the readiness baselines' exclusions, which can
regress the Recovery gate during a long status; and the self-review report moves onto the shared
excusal definition, so it starts excusing timezone days it counts as misses today (§3.4).

---

## 1. Current state

### Modes is fully live on main, and every lever is a rule

The registry (`src/lib/modes/registry.ts:53-62`) defines six keys and five levers per key:
`dropTypes`, `addItems`, `heroFocus`, `coachTone`, `excusesSkips`. Sick drops every `workout` and
injects "Immune support — Vitamin D, zinc"; Deload injects "cut training volume ~40%" — clinical
decisions as constants, against the rule that the deterministic layer *detects, grounds and routes
attention* and never *decides the response* (`docs/ai-coach.md:8`; `system-prompt.ts:114`; memory
`coach-judgment-not-rules`). One asymmetry §3.5 must not lose: **Deload does not excuse**
(`registry.ts:209`) — *"a plan you are still meant to execute"*, the control case in
`db/data-trends.test.mjs:477-478`. A mode item at 07:00 *takes the hero* (`registry.ts:27-35`); §3.4.

### Where the mode reaches today

- **Storage.** `day_modes` (`db/migrations/0026_day_modes.sql:23-39`): a row per declaration with
  `start_date`, nullable `end_date`, `label`, `note`, `mode` CHECKed to six keys. *Newest covering
  row wins* (`src/lib/db/repositories/day-modes.ts:27-40`); a `normal` row is a reset (`:155-157`);
  `activeModesIn` (`:65-99`) reads a window.
- **Home.** `ModeControl` beside the date (`app/(tabs)/index.tsx:156-159`), `ModeBanner` above the
  hero (`:186-190`), `useMode` (`:18`, `:143`), the store's broadcast (`src/lib/modes/store.ts:26-35`),
  a mission re-read on change (`src/hooks/use-today-mission.ts:132-135`). Every mode set from Home
  is **open-ended** (`store.ts:50`); a re-tap is a guarded no-op (`:46-48`).
- **The generator — the only per-future-day mechanism.** `planForDay` reads the mode *for the date
  it is generating* (`src/lib/db/repositories/mission-generate.ts:448`), drops whole types (`:464`)
  and appends the mode's items with their 07:00 leads (`:535-548`) — so an open-ended Sick row
  dropped the workout on **every** covered day with nobody opening anything. `rederiveMissionForDay`
  reads it too (`:699`, `:724`, `:754-757`) and returns `RederiveResult.mode` (`:624-625`);
  `ensureTodaySeeded` guards on it (`src/lib/db/seed.ts:121`).
- **Adherence.** `excusedDatesIn` (`src/lib/db/repositories/mission.ts:506-513`) is excusing-mode
  days ∪ timezone-changed days, read by `missionDailySeries` (`:638-659`) and `missionBySource`
  (`:884-893`). An excused item leaves the denominator and never counts as met (`:444-466`); an
  untouched item is excused once the day is over (`:648-652`). `outstandingCarries`
  (`mission-generate.ts:287-289`) applies a mode-only filter.
- **Readiness and reminders — Modes reaches neither.** `oddDays` (timezone days) leaves the HRV/RHR
  baselines (`src/lib/home/readiness.ts:855-859`), the energy baseline (`:869`) and the Recovery
  gate (`:938-941`). **Strain's baseline is session-counted** (`:871-882`) and never sees `oddDays`;
  Sleep (`:913`) and Nutrition (`:925-933`) read today only. `protocolRemindersDue` takes today from
  *pending* rows (`src/lib/notifications/protocol-reminders.ts:119`, `mission.ts:202-216`) and later
  days from `planForDay` (`:120`): a sick day's workout row did not exist, so neither did its nudge.
- **Reports — a second excusal definition, already diverged.** `assemble-self-review.ts` imports
  only `getActiveMode` and `accountForDay` (`:46-47`), resolves the mode per day (`:931-937`),
  excuses through `accountForDay` (`:256-261`), sends PENDING rows to `unmarked` (`:248-250`), and
  never reads `excusedDatesIn`: **a D4 timezone day is excused on Home and counted as a plain skip
  in a self-review today.** `app/mission-history.tsx` names the reason (`:500-508`, `:552-556`).
- **The Coach.** `get_today_snapshot` returns `mode` (`src/lib/ai/tools/read-tools.ts:668-674`); the
  state block prints `Mode: Normal` every turn (`src/lib/ai/turn-context.ts:85-93`); the doctrine has
  a Modes bullet (`system-prompt.ts:106`) and names "what mode am I in?" (`:97`); `set_mode`
  (`write-tools.ts:1364-1475`) takes `from`, refuses a past one, and **always bounds a non-normal
  mode — omitted `until` means today only** (`:1392-1397`); a `normal` reset names the future modes
  it cancels (`:1431-1441`). The `day modes` domain (`tools/index.ts:126`) feeds the coverage
  manifest, part of the cached prompt (`:243-248`; `system-prompt.ts:145`, `:175`). The brief has an
  excusing-mode branch (`src/lib/ai/insights.ts:913-923`); `thread-summary.ts:127` and the DECLINE
  lines (`ai-chat.ts:298`, `:248`) key on `'mode'`. **The daily pass** is READ tools only
  (`src/lib/ai/coach-pass.ts:13-17`, `:232-234`).

### The ceilings, measured

`db/coach-eval.test.mjs` §6 asserts 44 tool schemas under **9,250** tokens and the static prompt
under **3,700** (`:814-822`), by the formulas at `:386-387` (≈2.8 chars/token JSON, 3.6 prose). The
tools sit at **9,241 — 9 of headroom** (`:807`). The prompt ceiling rose to 3,700 on 2026-08-12
(`:441`) and the file's latest measurement is **3,669** (`:759`) — **31 of headroom**; the "~1
token" warning at `:424-425` predates the raise. `set_mode` on the wire is **285**, the Modes bullet
**127**, both re-measured with the file's own formulas.

### The Coach screen's seams

`SuggestedPrompts` is a **ruled plate** on an empty thread (`src/components/coach/suggested-prompts.tsx:14-18`)
and **it sends**: `onPick={chat.send}` (`app/(tabs)/coach.tsx:267`, `suggested-prompts.tsx:68`). A
**seeded** prompt also exists: `app/protocols.tsx:166-169` pushes `params: { prompt }`,
`coach.tsx:127-128` reads it into `ChatInput` behind a React key (`:284-289`), *"seeded, never
SENT"* (`src/components/coach/chat-input.tsx:23-32`) — a rule about that param. The composer is
blocked under a pending write (`coach.tsx:289`); the neutral `Chip` the rail wants is
**module-local to a route** (`app/protocol-edit.tsx:170`).

### What the parked branch did, and how far main has moved

`7a347d5` removed everything §5 lists, kept `rederiveMissionForDay`, froze labels and excusal flags
in a read-only shim, and added `0043_retire_day_modes.sql`, found **by name** (its
`db/modes.test.mjs:91`). The divergence, reproducibly: the branch touches **48 files**
(+797/−1,837), 27 under `src/` or `app/`; over those 27, `git diff --stat fe6eabc main` reports
**18 changed, +2,176/−407**; main is **93 commits** past the base. Two edits are wrong outright: the
branch's `day-modes.ts` has no `activeModesIn` (`git show 7a347d5:src/lib/db/repositories/day-modes.ts`),
which `mission.ts:508` and `mission-generate.ts:287` now require; and its bullet edits a line D4 and
C14 rewrote since. Its reasoning is credited; §4 answers its four positions.

---

## 2. The owner's words

> **Modes revamp** — the shape is decided, the build is later: **status quick-buttons on the Coach
> screen** (Sick, Traveling, …) that send a canned prompt — *"I am traveling right now. Check
> what's up and adjust accordingly"* — after which the Coach adjusts mission items, the workout
> plan, etc. itself. Pairs with retiring the old Modes system. — `docs/backlog-2026-09.md:64`

The verdicts that got here: *"the modes switcher right now doesn't do much"* (2026-08-09), still thin
after three levers were wired (`docs/information-architecture.md:276-292`). D4 drew the line: a
timezone change is the **fact**, the Traveling button the **intent**, *"neither should try to be
the other"* (`docs/spikes/timezone-days.md:485-487`).

---

## 3. Proposed design

### 3.1 The governing split

> **A status is a fact the user states about themself. What to do about it is the Coach's call,
> every time.**

The old system stored a fact *and* a fixed response. The new one stores the fact in a row —
deterministic readers need it on days the Coach is never opened — and routes the response through
the model's gated writes. **The cost, stated once:** a status never touches generation, so the only
thing that reshapes a day is a Coach turn on that day (§3.4).

### 3.2 The rail: status chips on the Coach screen

**Where, and what.** Docked directly above the composer on the same opaque `bg-paper` band, hidden
while a write awaits approval (as the activity line is, `coach.tsx:272-278`), disabled while a turn
runs (`chat.isResponding`). It occludes scrolling content, the screen's own test for chrome
(`coach.tsx:85-100`); a control that scrolls away on a long thread is not a quick-button. Chips in a
row are content, not a device (`00-design-spec.md:44`), so no `Block`; no accent (the send owns it)
and no signal colour — circumstance, not biology (`mode-control.tsx:22-27`). The empty-thread plate
(`:266-268`) still authors the sheet (`00-design-spec.md:170`).

**The chip is extracted, not borrowed.** `protocol-edit.tsx:169-201`'s `Chip` moves verbatim to
`src/components/ui/chip.tsx` and the editor imports it back; a route module cannot be a component's
dependency. A status chip is a **toggle of state on the day**, the shape the editor draws in rows
(`flex-row flex-wrap`, `protocol-edit.tsx:351`, `:478`, `:840`). **The rail wraps**, never scrolls,
never hides a chip. Five `compact` chips (12px, `px-2`) measure roughly 320–350px against ~350px
usable at 390px (`px-5`, `coach.tsx:216`), and an on-chip gains an end glyph, so expect two rows; if
that reads as a wall, question 1(b) trims the set.

**The set, and the prompt each sends** — five words, each ending in the owner's own sentence:

| chip | span | on tap (off → on) |
| --- | --- | --- |
| **Sick** | open until ended | *I'm sick right now. Check what's up and adjust accordingly.* |
| **Traveling** | open until ended | *I'm traveling right now. Check what's up and adjust accordingly.* |
| **Injured** | open until ended | *I'm injured right now. Check what's up and adjust accordingly.* |
| **Off day** | today only | *Taking today off. Check what's up and adjust accordingly.* |
| **Night out** | today only | *Night out tonight. Check what's up and adjust accordingly.* |

Deload is not a chip and not a status — a decision about the training plan, made with
`update_protocol` (§3.4 says why that is load-bearing); Social becomes Night out because it names
the thing; anything else is typed and recorded with §3.5's tool. **The rail's bound:** the five
fixed chips plus **up to two** open statuses whose label matches none of them, most recently started
first, each an on-chip carrying its label; any further open status is visible on Home's line and in
the snapshot, and endable through the Coach.

**Three gestures, not one.** (1) *Off → on* writes the row (§3.3) and **sends** the prompt through
`chat.send` — the precedent is the empty-thread plate, which already sends through the same
function (`coach.tsx:267`); the `chat-input.tsx:23-32` seeding rule stays the rule for the
deep-linked param the other two gestures use. (2) *Tap an on-chip* — the **re-ask**, day two of a
five-day flu: sends *Still sick. Check what's up and adjust accordingly.* (3) *The end glyph* — a
`×` at the right of an on-chip, its own 44pt-tall target — ends the status (§3.3) and **seeds** the
composer: *Over the bug — back to normal. Re-check today and put back what you took out.* Seeded,
not sent: ending is bookkeeping that may not warrant a turn (`coach.tsx:284-289`). The row is
written before any send and never waits on it: on a plane the fact lands and the turn fails as every
turn fails offline. Accessibility: role button, `selected` state, the bare word as label, a hint per
state, the glyph its own target.

### 3.3 Where the status lives: one small table, `0059`

```sql
CREATE TABLE day_statuses (
  id          text PRIMARY KEY NOT NULL,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 40 AND label <> 'normal'),
  start_date  text NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date    text CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note        text,
  source      text NOT NULL CHECK (source IN ('user', 'coach')),
  created_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
-- index on (start_date DESC); the standard AFTER UPDATE trigger on updated_at
```

**A row with a span, not a preference and not a memory.** Reports resolve per past day
(`assemble-self-review.ts:931-937`) and the ledger needs dates over a window (`mission.ts:506-513`);
a scalar in `users.preferences` (the timezone *cursor*, `user.ts:293-324`) has no history, and a
Coach memory is "anything still true next month" (`system-prompt.ts:110`) with no expiry. Questions 2 and 3.

**Free-text `label`, no enum.** Nothing branches on the value — every status is judged identically
(§3.4) — so an enum is a taxonomy nobody maintains, and widening a CHECK is a table rebuild
(`docs/spikes/gym-away-note.md:140-141`). The repository trims and lower-cases; surfaces capitalise.
`note` is the Coach's, the slot `day_modes.label` never got a writer for
(`information-architecture.md:290`). **`source` is provenance as a column** (0034's rule): the rail
writes `user`, the tool `coach`. **Several can be open at once**, and "any open status covers the
day" is the predicate. **`'normal'` is a command, never a row:** the CHECK refuses it,
`set_status('normal')` closes every open row and inserts nothing; the `0059` reset row in
`day_modes` (§5) is the only `normal` this feature writes. **One day definition:** every writer
passes the app's logical day — `todayISODate()`, preference-aware (`src/lib/db/date.ts:232-236`,
`logicalDate` `:168-175`) — never SQL `date('now')`; the retirement row is the one UTC date (§5).

**The repository (`src/lib/db/repositories/statuses.ts`).** `openStatuses(db, today)`, newest
first. `statusDaysIn(db, from, to): Set<string>` — the shape of `timezoneChangedDaysIn`
(`day-meta.ts:149-163`): empty for an inverted range, each row's span clamped to `[from, to]` with
an open end clamped to `to`, days listed as `activeModesIn` lists them (`day-modes.ts:78-85`).
`startStatus(db, {label, startDate, endDate, note, source})` — **re-tap guard, as `store.ts:46-48`
has:** a trimmed, lower-cased label already open today is a no-op returning that row. `endStatus`.

**Ending, and why nothing is ever deleted from the rail.** Ending sets `end_date = today`; today
stays excused. A same-day start ends the same way, never deleted: a Night out declared at 18:00 and
ended at 23:00 is not a mis-tap, and deleting the row would flip the evening's skips back to misses
after Home had shown them excused. A true mis-tap costs one excused day, the cheaper error; the sent
prompt cannot be recalled anyway (`use-coach-chat.ts:398` persists it first). *Considered and
rejected:* a timed Undo — a rule with a number that cannot un-send the turn.

**No automatic expiry.** A forgotten open status is the old failure mode (§5), answered with
visibility gated on the *exclusion*, not on its eventual failure: Home's line and the state block
name an open status, its age, and *"readiness baselines exclude N status days"* the moment N > 0
(§3.4, §3.6), escalating once Recovery has no verdict; the doctrine has the Coach ask whether a
long-open one still holds. Question 4 offers the cap. **A restore** replaces the whole database
file (`docs/backups-subapp.md:167-170`), so an open status stays open and Home states its age.

### 3.4 Who reads it, and what each does with it

**Reach past today — the plain statement.** A status never enters `planForDay`. Every later day of
an open status regenerates *whole*: day two of a flu has the workout on the mission, in the hero if
the protocol schedules it first, and its 07:00 reminder fires (§1). **So does today's, on the day
it is set:** a reminder is dropped only by a write — `adjust_today`'s skip or remove empties the
pending row and the post-turn sync (`coach.tsx:130-135`, `mission.ts:202-216`) drops the nudge; if
the Coach answers without adjusting, or the turn fails offline, today's reminders fire as
scheduled. Strictly less than Modes on that axis — the price of
judgment over rules, paid down by the **re-ask** gesture (§3.2), **Home's line seeding the same
re-ask** (§3.6), and the **doctrine** (§3.5) telling the Coach a status with a known length can be
bounded with `update_protocol` (424 tokens, `coach-eval.test.mjs:809`; a new version, reverted on
the "ended" cue). Until a turn runs, Home shows the standard plan beside "skips excused".

*Considered and rejected:* letting the daily pass carry `adjust_today`. The pass is read-only by
construction — *"acting on that happens in the thread, where the confirmation gate lives and the
user is present"* (`coach-pass.ts:13-17`); a pass-proposed write needs a pending-write card on Home,
a new surface. Its note can *say* "the workout is still on today's list", which the seeded re-ask
acts on. *Also rejected:* a status-aware reminder silence — "sick → no reminders" is a rule, and
silencing a medication reminder because the owner is traveling is the kind that is wrong.

**The excusal ledger** (`mission.ts:506-513`). `excusedDatesIn` gains a third source:
`statusDaysIn(db, from, to)`. That reaches `missionDailySeries` (`:638-659`), `missionBySource`
(`:884-893`), and through them Home, mission history and protocol detail — **not the reports, which
hold a second definition today** (§1) and are moved onto this one below. **A status day is
excused, uniformly, whatever the word** — accounting, not judgment, with the D4
precedent the owner approved: a timezone day is excused without a mode (`day-meta.ts:15-18`). The
one status that must never exist under uniform excusal is a deload-shaped one, because the registry
refuses to excuse it on purpose (`registry.ts:209`, `data-trends.test.mjs:477-478`): the doctrine
and the tool description both say a deload is a plan change, never a status (§3.5). *Considered and
rejected:* an excusal flag on `set_status` — a schema property, a class of chip the rail cannot
draw, and write-time model judgment over accounting deterministic readers apply alone; question 2(b).

**`outstandingCarries` — the deliberate second change.** It switches from its own mode filter
(`mission-generate.ts:287-289`) to `excusedDatesIn`, as `missionBySource` reads (`mission.ts:892`).
Consequence: no carry out of a timezone-excused day, which C11 never considered — a day the ledger
forgave should not breed a debt. Pinned by test 6.

**Readiness baselines** (`readiness.ts:855-859`, `:869`, `:938-941`). `oddDays` becomes timezone
days ∪ status days, so a fortnight of illness does not lower the 30-day HRV baseline and make the
first well week read as recovery. **The consequence, exactly:** with `BASELINE_WINDOW_DAYS = 30`
(`:37`) and `BASELINE_MIN_DAYS = 5` (`:39`), a status open past ~25 days starves the HRV, RHR and
active-energy baselines — the **Recovery** pillar reads `unknown` until it ends, and Strain loses
its energy corroboration but **still grades off logged sets**, whose baseline is session-counted
and never sees `oddDays` (`:871-882`, `strainVerdict` `:214-229`); Sleep and Nutrition read today
only. Not silent, and not late: `deriveReadiness` returns the count of status days it excluded,
Home's line carries *"readiness baselines exclude N status days"* from the first excluded day and
*"no recovery verdict until it ends"* once `recoveryDaysRemaining > 0`; the state block carries the
same clause; test 7 pins day 3, day 31 and the still-graded Strain. *Considered and kept
unbounded:* a cap is a rule with a number about biology; question 3(b) offers it. **The training
recommender** is unaffected: `training-recommend.ts:15-20` imports exercise, routine and stats
repositories only, and mentions neither modes nor excusal.

**The Coach, every turn.** The `Mode:` line (`turn-context.ts:85-93`) becomes a `Status:` line
printed **only when a status is open**, the Timezone line's economy (`:95-125`):

> `Status: traveling — day 4, open-ended (set by you) · sick — since today (set by you). Status days are excused in adherence and left out of readiness baselines. Baselines exclude 4 status days.`

**Per-turn, uncached** (this block sits after the cache breakpoint, `system-prompt.ts:156-172`): an
ordinary day loses `Mode: Normal`, **−3**; one open status costs 35, two 44, so **+32 to +41** net,
plus **+9** for the exclusion clause while it applies; the day after a status ends, `Status:
traveling ended yesterday — put back what it took out.` is 17, **+14** net. `get_today_snapshot`'s
`mode` (`read-tools.ts:668-674`) becomes `statuses: [{label, since, until, source}]`; the pass reads
the same block (`coach-pass.ts:230`); **the brief** (`insights.ts:913-923`) is re-keyed on an open status.

**Reports — moved onto the one definition, the deliberate third change.** `assemble-self-review.ts`
adopts `excusedDatesIn` for the period: a skipped row on an excused day is excused, and a PENDING
row on a *settled* excused day is excused too, as Home already counts it (`mission.ts:648-652`) —
so the two ledgers cannot disagree, and a timezone day stops reading as a miss in a self-review.
The frozen `modeByDate` (§5) stays for *labels only*: the sentence under the table names every
reason — "3 Sick days · 4 traveling days · 1 timezone day" — and "What changed" gains `'Status'`
runs beside `'Mode'` ones (`:870-882`); `mission-history.tsx` reads three reasons (`:500-508`);
`docs/reports-subapp.md:54` is rewritten.

### 3.5 "Adjust accordingly" — the gap list against the registry

| need | today | verdict |
| --- | --- | --- |
| Excuse today's items | status row + `adjust_today` skip (`write-tools.ts:1298-1316`) | covered |
| Add rest / fluids / whatever it judges | `adjust_today` add (`:1280-1290`) | covered |
| Drop the workout today | `adjust_today` remove (`:1326-1334`) | covered |
| **Reach later days of an open status** | `adjust_today` is *"Today only — edit the protocol to change future days"* (`:1204-1206`) | **gap** — paid down by re-ask, Home seed, and the doctrine's `update_protocol` option (§3.4); residual stated there |
| Move a workout to another day | no future-day surface (`docs/spikes/protocol-carryover.md` §1) | deferred to C1: skip today (excused) + `set_reminder` |
| Reshape a week, incl. a deload | `update_protocol`, complete set, effective today (`:955-956`) | covered, heavy (424 tok, `coach-eval.test.mjs:809`); "ended yesterday" is the revert cue |
| Set the status | `set_mode` | replaced by `set_status` |

**`set_status`** — one write tool, paid for by deleting `set_mode`:

```
name: set_status
description: Record a standing state the user reports ("sick", "traveling") so its days are
  excused in adherence and left out of readiness baselines. Never for a deload — that is a
  plan change (update_protocol). "normal" ends every open status.
properties: label (required; 'Short, lower-case. "normal" ends all open ones.') ·
  from ('"YYYY-MM-DD"; omit for today. Never past.') · until ('"YYYY-MM-DD" inclusive; omit
  for one day.') · note
```

**236 tokens** by the `:386` formula against `set_mode`'s **285**: **net −49**, headroom 9 → ≈58.
**`from` stays.** Dropping it would discard a named improvement — `docs/coach-intelligence-review.md:62`
recorded the gap (*"I fly out Monday" cannot be scheduled*), `:123` the fix, and
`db/coach-levers.test.mjs:283-315` pins it — and Traveling is the status most often known a week
ahead; ~30 tokens, reusing the resolver pattern (`write-tools.ts:1366-1373`). **Omitted `until`
means today only**, the existing rule (`:1392-1397`); open-ended is reachable only from the rail, a
user gesture with a visible chip, so the Coach can never mint the permanently-open row the `0059`
retirement exists to clean up. Cards: `Status: traveling through 2026-09-19` / `… from 2026-09-22` /
`End the traveling status today` / `traveling is already set`; one resolver serves `confirmSummary`
and `execute` so a refused window never reaches a card; `humanizeToolName` stays injective
(`db/coach-tools.test.mjs:137-152`).

**The doctrine.** The Modes bullet (`system-prompt.ts:106`, 127 tok) becomes:

> *Status: an off-normal stretch ("sick", "traveling", "jet-lagged", "work crunch") has no switch —
> YOU are how the day adapts. When the state block shows one, or they tell you: reshape TODAY with
> adjust_today (skip or remove the workout, add rest or fluids); bound anything longer with
> update_protocol and revert it on the "ended" cue. Record the state with set_status so later days
> are judged right. A deload is a PLAN change — update_protocol, never a status. Never nag about a
> skip they already explained.*

**141 tokens.** The prompt accounting, complete: bullet −127 +141 = **+14**; "what mode am I in?"
(`:97`) → "what's my status?" **−1**; the `day modes` domain label (`tools/index.ts:126`) → `your
status`, which feeds the cached manifest (`:243-248`), **0** (+2 chars). **Net +13 against 31 of
headroom** (`coach-eval.test.mjs:441`, `:759`), leaving ≈18. The 14 tokens buy the Deload carve-out
§3.4 requires; if the build's measurement lands over, the trim is the bullet's example list (−8),
never the carve-out. The formula is good to ~10%; the build measures with
`db/measure-coach-request.mjs` §7 (`:684-699`) and records the §6 comment entry.

### 3.6 Home: the fact stays visible, the control does not

The folio row loses `ModeControl` (`index.tsx:156-159`), the banner (`:186-190`) and their imports
(`:12`, `:18`, `:143`). One line takes the banner's place *directly above the hero*, in the timezone
line's device (`:174-176`: mono, 11px, muted, zero height otherwise; hook as `use-timezone-note.ts:21-34`):

> `Traveling since 12 Sep · sick since today — skips excused · readiness baselines exclude 4 status days`

The last clause appears while the excluded count is above zero and becomes *"no recovery verdict
until it ends"* once `recoveryDaysRemaining > 0` (§3.4). Pressable: it routes to the Coach tab with
`params: { prompt: 'Still traveling. Check what's up and adjust accordingly.' }` — the
`protocols.tsx:166-169` seam, seeded not sent — so day two of a trip is two taps from a re-check;
*"never silently on"* (`information-architecture.md:266`) is kept, the picker is not.

---

## 4. Alternatives considered

| # | Alternative | Verdict |
| --- | --- | --- |
| A | **Nothing persists** — the thread carries "I'm traveling" | Rejected. Tomorrow's ledger, baselines and pass see nothing; the parked ADR names this cost ("no excusal mechanism for future days at all") |
| B | **A durable memory** | Rejected (§3.3) — unless questions 2(c) and 3(c) are both chosen, when it becomes the right answer (§9) |
| C | **A preference scalar** | Rejected. No per-day history (§3.3) |
| D | **Reuse `day_modes` with `mode = 'custom'`** | Rejected. `custom` is frozen non-excusing (§5); flipping it re-judges lived Custom days |
| E | **Per-item skip-with-reason** (the parked ADR's leading candidate) | Not now. Needs a control on every skip; gives the baselines no day predicate. Can sit beside a status later |
| F | **Buttons only send; the Coach writes the row** | Rejected. One more approval per status, and the fact would depend on AI and a network — CLAUDE.md §2 forbids it |
| G | **Keep `addItems`/`dropTypes` as defaults the Coach may override** | Rejected. The hardcoded clinical layer under a new name |
| H | **Authored profiles** — a status as a versioned, protocol-like document the user writes (`information-architecture.md:292`'s open question; the parked evaluation's second position) | Rejected, and this is the answer that section left open: the registry with the user as author is still a fixed response bound to a fact, so still a rule deciding the day. The owner chose the Coach as the adapter (`7a347d5`); this plan is the *Coach-owned context* position with the smallest deterministic row accounting needs |
| I | **Finish the registry's reach** (the evaluation's fourth position) | Rejected by the owner, 2026-08-25 |
| J | **Cherry-pick the parked branch, renumber** | Rejected — §1, §5 |

---

## 5. Retiring day modes: what is kept, what goes, why the branch is rewritten

**Data kept, forever.** `day_modes`, `0026` and every row stay: they decide how past days are
judged, and *"changing them would silently rewrite verdicts on days already lived"* (the parked
ADR). The registry becomes the frozen shim — `ModeKey`, `{label, excusesSkips}` (Travel/Sick/Social
`true`), `getModeDefinition`, `accountForDay`; the other levers, `MODE_KEYS`, `modeDirective` and
`modeChangesPlan` go. `day-modes.ts` keeps `getActiveModeRow`, `getActiveMode` **and
`activeModesIn`**; `setMode`, `clearMode`, `modesSupersededFrom` go. **A future-dated `day_modes`
range** (`set_mode`'s `from`, `write-tools.ts:1461-1472`) is **cancelled by the retirement row, not
converted** — newest-wins outranks it from its start date, as a `normal` reset does today
(`day-modes.ts:87-94`); converting would write a label on his behalf for a near-zero-odds case, and
he re-declares from the rail.

**Removed — code.** `mode-control.tsx`, `use-mode.ts`, `store.ts`; `index.tsx:12, 18, 143, 156-159,
186-190`; `use-today-mission.ts:132-135` (the focus re-read at `:130` covers a Coach-tab write then a
tab switch). **Generator:** the mode read and both intercepts (`mission-generate.ts:448`, `:464`,
`:535-548`); the re-derive's reads (`:699`, `:724`) and seed-drop branch (`:754-757`), the function
staying for `update_protocol` (`write-tools.ts:1033`); **`RederiveResult` loses `mode`** (`:624-625`)
— no consumer reads it (`write-tools.ts:1041-1042`, `:1471` read `added`/`removed`; `store.ts:52`,
`protocol-edit.tsx:750`, `protocol-versions.tsx:165` discard the result); `seed.ts:121`. **Coach:**
`set_mode`, the snapshot's `mode`, the `Mode:` line, the bullet, the domain, the brief's branch
re-keyed, the stale comment at `stubs.ts:41-43`; **the two `'mode'` key lists** (`thread-summary.ts:127`,
`ai-chat.ts:298`) take `'label'` instead, and `ai-chat.ts:248`'s `"set_mode deload"` example becomes
`"set_status sick"` — otherwise a declined status reads with no noun for thirty days. Four comments
pointing at `mode-control.tsx` are re-pointed (`log-sheet.tsx:37`, `app-lock-screen.tsx:38`,
`use-timezone-note.ts:12`, `day-meta.ts:172`), as is `reports/types.ts:79`.

**Removed or re-driven — tests.** `db/experiments.test.mjs:186` drops the `toolByName('set_mode')`
conjunct — as written it fails the moment `set_mode` goes. `db/coach-memory.test.mjs:220` and `:529`
re-fixture to `{ name: 'set_status', input: { label: 'sick' } }`. `db/insights.test.mjs:143` plants a
`day_statuses` row instead. `db/coach-tools.test.mjs:1798-1813` (§28) and `db/coach-levers.test.mjs:283-315`
(§5) re-drive through `set_status`; R3 (`:466-494`) through `update_protocol`, as the branch did.
`db/turn-context.test.mjs:109`, `:168-170` and `db/screens-render.test.mjs:1058-1066` are rewritten
(§6). The raw historical INSERTs stay (test 5).

**Docs.** `information-architecture.md` §Modes becomes this design's record and answers its own
closing question (§4 H); `ai-coach.md` (`:59`, `:73`, `:106`, `:128`, `:247`, `:425-426`);
`home-screen.md:116-122`; `project-status.md` (`:441`, `:443`, `:542-554`, `:598`, `:634`);
`reports-subapp.md:54`; `coach-intelligence-review.md` (`:23`, `:62`, `:123`, `:175` — history,
annotated not rewritten); `nutrition-subapp.md` (`:55`, `:283`); `decisions.md` (a new ADR
superseding `:560-567`); `tools/index.ts:5-7`; **`CLAUDE.md:191`**. **Phase 1's size, from main:**
21 code files with live references plus 4 comment cross-references, 13 test files, 9 docs and
`CLAUDE.md` — ≈**44 files**, mostly deletion.

**The retirement row is still required, and `0059` carries it.** The owner's installed build
predates `0044`, and any mode he set from Home is open-ended (`store.ts:50`); with the picker gone
nothing could end such a row, and `excusedDatesIn` would excuse every future day. The parked SQL,
with an **unnumbered id** so a renumber cannot lie:

```sql
INSERT INTO day_modes (id, mode, start_date, end_date, label, note)
VALUES ('modes-retired', 'normal', date('now'), NULL, NULL,
        'Modes retired 2026-09 — ends all mode coverage from here on; history before this date is unchanged.');
```

Newest-covering-row-wins makes it final from its start; earlier dates are untouched by
construction. `date('now')` is UTC and a migration cannot read the app's day preference: a Pacific
evening install starts it on the local tomorrow, so an old open-ended mode can cover that one
evening — accepted, as the branch accepted it, since `'-1 day'` could re-judge a lived local
yesterday. That is why this row is the only UTC date in the file and `day_statuses` gets its dates
from `todayISODate()` alone (§3.3). **One migration, not two:** each number is a collision to
re-check (seven in one week, `0053_timezone_changes.sql:71-78`); `0059_status_replaces_modes.sql`
holds both, `npm run db:bundle` regenerates `migrations.generated.ts`. **The CLAUDE.md §9 gate:**
`npm run db:validate` (`package.json:16`) runs the bundle check and `db/validate-schema.mjs`, which
takes **one** file and defaults to `0001` (`validate-schema.mjs:19`) — `0059`'s INSERT needs
`0026`'s table, so its schema assertions run over the full chain in `db/statuses.test.mjs` (test 1,
at least twelve) while `db:validate` still gates the bundle. **Why rewrite rather than
cherry-pick:** §1's two wrong edits, 93 commits of drift, and a test asserting the retirement is the
*head* — true only until `0060`.

**Fallback if the Coach does not adjust.** Phases 0–2 cannot be un-applied on the device
(`migrate.ts:70`) and need not be: the row alone excuses the day and guards the baselines with no
model in the loop. What a paragraph-instead-of-a-write costs is the *reshaping*, the bullet's to fix
under the ceiling (§8 names the bar); phases 3–4 revert cleanly. If judgment proves insufficient, the
escalation is a status-aware generation rule — rejected here (§4 G), an owner decision then, not a rollback.

---

## 6. Tests that would pin it

Headless, `node:sqlite`, the existing harness (`db/coach-tools.test.mjs:101-108`), never a model
call. New file `db/statuses.test.mjs`; the rest are edits to the suites §5 names.

1. **`0059` on a fresh database:** `day_statuses` with every CHECK (41-char label, `'normal'`,
   `end_date < start_date`, unknown `source` all refuse), the NOT-NULL id, the index, the trigger;
   the retirement row exists, open-ended, `normal`. Found **by name**, never by version.
2. **Production ordering and the numbering guard in one:** stage every migration up to
   `0058_composite_meal_items` **by name**, plant an open-ended `sick` row dated last month **and a
   `travel` range dated next week**, migrate the rest, assert last month Sick, today Normal, **next
   week Normal** (§5). A `0059` renumbered at or below the staged head is filtered out and this fails.
3. **The repository:** open-ended, ranged, future-dated, two concurrent, a Coach-authored label;
   `statusDaysIn` clamped and empty for an inverted range; **re-tap is a no-op returning the open
   row**; a same-day end keeps today in the set; `'normal'` closes every open row **and inserts none**.
4. **The ledger:** on a status day a tapped skip and an untouched item are both excused once the day
   has ended; a live status day excuses only the tap (`db/data-trends.test.mjs` §13d, `:477-485`).
5. **Frozen history:** §13d and `:604-607` plant historical mode rows by raw INSERT (`setMode` is
   gone) and their verdicts hold — Deload still not excused; same for `db/reports.test.mjs:35`,
   `db/timezone.test.mjs:60`, `db/measure-coach-request.mjs:45`.
6. **`outstandingCarries`:** no carry out of a status day **and none out of a timezone-excused day**
   — the C11 change, asserted.
7. **Baselines, three shapes,** each with ≥5 logged prior sessions so Strain is never vacuous: (a)
   three of 30 HRV days under a status — the baseline is the mean of the other 27, marked points
   still render, `excludedStatusDays === 3`, Recovery still has a verdict; (b) day 3 of a status
   with a full history — the exclusion line is present, `recoveryDaysRemaining === 0`; (c) a 31-day
   open status — Recovery `unknown`, `recoveryDaysRemaining > 0`, **Strain still levelled from
   `setsRatio`**, Sleep and Nutrition unchanged.
8. **The state block:** no `Mode:` line ever (`db/turn-context.test.mjs:109` rewritten); no
   `Status:` on an ordinary day; the two-status line with the exclusion clause (`:168-170`
   rewritten); `ended yesterday` for one day, then nothing.
9. **The snapshot and `set_status`:** `statuses` present, `mode` absent; every card wording incl.
   `already set`; omitted `until` = today only; a future `from` stored for its span and refused when
   past (the `coach-levers` §5 shape); an inverted window refused before the card; `source = 'coach'`.
10. **The `'label'` key:** a declined `set_status` renders as `set_status "sick"` in
    `recentDeclines`, and a summarised thread's did-line names the label.
11. **Coverage, names, ceilings:** `coverageProblems()` empty; `humanizeToolName` injective;
    `coach-eval.test.mjs` §6 passes and gains the entry (−285 +236 schema; −127 +141 −1 +0 prompt).
12. **Reports:** a status day and a timezone day both count in Excused, a settled excused day's
    pending rows are excused, the sentence names all three reasons, "What changed" lists both runs.
13. **Screens.** `db/screens-render.test.mjs` refutes `Set mode` on Home (`refute`, `:201`; the
    render at `:1058-1066` is rewritten) and asserts the status line above the hero. **The Coach tab
    is not rendered by that suite**, so the rail is a pure `StatusRail({ open, disabled, hidden,
    onToggle, onEnd })` rendered in isolation: five off; two on; two on plus two Coach-authored
    chips **and a third not rendered**; hidden under a pending write.
14. **Retired, with the survivors named.** `db/modes.test.mjs` §§0–13 go. Its re-derive fence
    (§§8–13, `:471-643`) is **not lost**: `db/mission-generate.test.mjs` §13 (`:574`),
    `db/reminders.test.mjs:490-497` and coach-levers R3 carry it; `mission-generate.test.mjs` §7
    (`:300-307`) becomes "all seed rows survive".

---

## 7. Phases, and what they touch

| phase | what | countable size |
| --- | --- | --- |
| 0 | **The migration.** `0059_status_replaces_modes.sql` — the retirement row and the table, one file; `db:bundle`, `db:validate` | 1 migration, the bundle; tests 1–2 |
| 1 | **Retire.** The shim, the read-only repo (keeping `activeModesIn`), Home/generator/Coach removals incl. the two key lists and `RederiveResult`, the test re-fixtures, the comment re-points, docs incl. CLAUDE.md | ≈44 files on main, mostly deletion; tests 5, 14 |
| 2 | **Substrate.** `statuses.ts`, `statusDaysIn` → `excusedDatesIn`, `outstandingCarries`, `oddDays` + `excludedStatusDays`, the reports assembler onto `excusedDatesIn`, mission-history, Home line + hook + seeded route | ≈11 source files; tests 3–4, 6–7, 12–13 |
| 3 | **The Coach.** `set_status`, the `Status:` line, the snapshot, the bullet, the domain, the brief, the §6 entry | ≈6 files; tests 8–11 |
| 4 | **The rail.** `src/components/ui/chip.tsx` extracted, `protocol-edit.tsx` re-pointed, `StatusRail`, `coach.tsx` | 4 files; test 13's rail states |
| 5 | Docs and the ADR; the §8 acceptance check | 10 docs |

0–2 land together (§5); 3–4 may trail by a day, not by a build. No native module; no EAS gate.

---

## 8. What only a device can settle

- **Whether the Coach actually adjusts — with a bar.** Every test above is deterministic; the
  owner's sentence is a request to a model. **Acceptance:** of the first three real taps (Sick,
  Traveling, Off day), at least two must produce `get_today_snapshot` then an `adjust_today` card —
  or an explicit "nothing to change today, because …" — in the same turn, read from the
  `ai_messages` tool records. Fewer, and the bullet is rewritten before phase 5 closes.
- **The rail's rows.** Whether five compact chips wrap at 390px, whether two rows above the composer
  read as chrome or a wall, whether the rail and the empty-thread plate read as two "start here"s,
  whether the end glyph is hittable, and whether the rail should hide while typing (`coach.tsx:210-212`).
- **Day two, and day thirty.** Whether Home's line plus a seeded re-ask is enough on the second
  morning of a trip, or the hero leading with a workout under "skips excused" reads as the thinness
  that killed Modes; whether a month under "no recovery verdict until it ends" reads as honest.
- **The update itself.** One look at Home after `0059`: the UTC evening (§5) and any scheduled mode.

---

## 9. Questions for the owner

**Dependency, before the buttons.** Choosing **2(c) together with 3(c)** removes every deterministic
reader but Home's line and the reports sentence — then the table is not needed: the rail becomes a
prompt sender, the status lives in Coach memory (alternative B), and phase 2 is cut.

**1. The chip set.**
- (a) **Sick · Traveling · Injured · Off day · Night out**, wrapping to two rows if the phone needs
  it; everything else typed (Recommended)
- (b) Sick · Traveling only, one row guaranteed
- (c) **Travel · Sick · Deload · Social** — the old words minus Custom (the typed status does its
  job); Deload then becomes a status that excuses skips, which §3.4 argues against

**2. Does a status excuse the day's skips?**
- (a) **Yes, every status, uniformly** — a status says "don't judge me by today"; what to *do*
  stays the Coach's call; a deload is never a status (Recommended)
- (b) The Coach decides per status, through an excusal flag on `set_status`
- (c) Never — a status is context only; the ledger is unchanged (see the dependency note)

**3. Do status days leave the 30-day readiness baselines?**
- (a) **Yes, while open — Home and the Coach say how many days are excluded; past ~25 days Recovery
  reads `unknown` until it ends; Strain, Sleep and Nutrition keep grading** (Recommended)
- (b) Yes, but only a status's first 14 days — after that it has become the normal
- (c) No — keep the baselines whole (see the dependency note)

**4. How does a status end?**
- (a) **The × on its chip, seeding an end prompt you can send or discard; Off day and Night out end
  tonight; the Coach can bound one ("through Friday") and asks about a long-open one** (Recommended)
- (b) Every status ends at midnight unless the Coach extends it
- (c) A hard cap — 7 days — after which it ends on its own

**5. Home.**
- (a) **One mono line above the hero stating the open status, its age and the excluded baseline
  days; tap seeds the re-check in the Coach; no control on Home** (Recommended)
- (b) Nothing on Home — overrides "never silently on" (`information-architecture.md:266`) and
  removes the visibility §3.3 relies on instead of an expiry
- (c) A control on Home as well, beside the date
