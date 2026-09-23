# The protocol interface rethink

**Status: BUILT (Phases 0–4)** — 2026-09-19, branch `claude/protocols`, **no migration** (head stays `0058`; `0059` was still free at the time of writing and three sibling builds were holding `0059`/`0060`/`0061`). **Phase 5, the mission day picker, was deliberately left for its own build** and **shipped 2026-09-19 on branch `claude/daypicker`** from `docs/spikes/mission-day-picker-and-future-checkoff.md`, which is the authoritative record of it. Everything under *What Phase 5 inherits* below was consumed as written; the three items listed there as "not done" — the arrival re-derive, the widening of `DayBounds.latest`, the checked-ahead stamp (shipped as `done_on`) and the `day-cursor.ts:5` citation fix — all landed with it.

The owner answered all five questions in §12 and **took option (a) every time**. §5's recommendation therefore shipped whole: the mission row's chevron and its named VoiceOver action; the description off the hub row; the owner writing the why-line with the Coach allowed to reword or clear it; the day picker sequenced as Phase 5; and `update_protocol` learning to create.

## What the build departs from what is written below

| # | The plan | What shipped | Why |
| --- | --- | --- | --- |
| 1 | *Move to …* opens the shared `TimeControl` (§6.1) | a sibling **`MoveControl`** reusing its presets, its field and its keyboard — but not its second half | `TimeControl`'s other half is the **reminder** toggle, and a reminder is a fact about the protocol ITEM: it lives in the versioned content and applies on every day the item lands. Moving today's row writes `log_entries.scheduled_time` on one row of one day. Drawing "Remind me" there would offer a control that either does nothing or silently edits the protocol from a screen about today |
| 2 | a quota-only protocol's hub row reads `3 today · 1 of 3 this wk` (§6.2) | the allowance is printed only when the live phase holds **exactly one item and it is a quota** | there is no one honest figure for two allowances, and a combined one would be invented. A protocol with several quota items prints the day count alone |
| 3 | the per-item save's document rebuild lives in the screen (§6.4) | the placement rules are pure, in **`src/lib/protocols/item-edit.ts`** | the plan's own test 5 asks that a per-item save be *byte-identical to the full editor's for the same change*. That cannot be asserted headlessly against logic inside a `.tsx` save handler, and it is the one rule where a second implementation would drift |
| 4 | the settings sheet writes and pops (§6.5) | it also **re-derives today** | the editor's standing rule since 2026-08-25 is that a save reaches today, and a pause must pull that protocol's untouched rows off it. Not re-deriving would have made pausing take effect tomorrow, silently |
| 5 | `committing: false` drops the carry and the quota (§6.0) | it also drops **`missed_days`** | that mark is computed from the same `outstandingCarries` read and is the same artefact wearing a native row: projected forward, today's un-ticked creatine would read as outstanding on every day of next week |
| 6 | the ledger's accounting starts from **9,241** (§8.2) | measured on `main`: **9,236** | the figure in `db/coach-eval.test.mjs` §6's C13 entry was stale. The +1 arithmetic is unchanged and reproduced exactly (`update_protocol` **424 → 425**); the headroom is 14 rather than 9. Corrected in the test's own comment |
| 7 | `quotaDoneThisWeek` is tested against `quotaCompletionsThisWeek` (§9.2) | `quotaCompletionsThisWeek` is **exported** for that test | the two differ only in their bound, the difference is deliberate, and an assertion that cannot see both halves cannot prove it |
| 8 | the detail's *Add an item* appears on a version-less protocol (§6.4) | it appears whenever the live phase **lists no items** | the same state arrives by a second route — an edit that emptied a phase — and the row is the only way out of either |
| 9 | `day-cursor.ts:5` cites a "§9" that does not exist; whichever phase touches the file fixes it (§1.4) | **left alone** | Phases 0–4 do not touch that file. Phase 5 rewrites it (the bound widening) and should take the fix with it |

Everything else is as written, including every "Considered and rejected" note.

## What Phase 5 inherits

The two things its plan expects are in place and in the shape it expects:

- **`planForDay(db, date, { committing })`** — `src/lib/db/repositories/mission-generate.ts`. Default `true`, so every existing caller is unchanged. Phase 5 flips the flag for a future day rather than writing a third rule set.
- **`projectDays` / `nextOccurrence` / `quotaDoneThisWeek` / `PROJECTION_DAYS`** — same file, over that flag. `projectDays` is strictly forward-looking from **tomorrow**, and the day picker's own plan may widen that; nothing else reads it.

Not done, and still Phase 5's: the arrival re-derive of a pre-committed day, the widening of `DayBounds.latest` past today (`src/lib/utils/day-cursor.ts`, pinned by `db/day-boundary.test.mjs` §7 and §8), `value.checked_ahead_on`, and the `day-cursor.ts:5` citation fix. Nothing in Phases 0–4 writes a future day or moves a bound.

---

**Status of the text below: PROPOSAL, third draft** (2026-09-15, after two independent critiques; every disputed citation re-read on `main` at `0ae73ea`). It is kept verbatim as the reasoning record; read the banner above for what actually shipped.
**Expected migration: none** — every read below is over columns and JSON that exist (§7). What is new is computation: one flag on `planForDay`, a projection over
it, two small repository functions, and three pushed routes. **Backlog:** `docs/backlog-2026-09.md` › Parked, first bullet (`:63`); the owner's note is at the
head of `docs/project-status.md` §1 (`:9`, item (1)). The model behind these screens is settled — content schema 2 and the phase clock (`0043`), the time control,
reminders and carry-over (C9–C11, `0050`, `docs/spikes/protocol-carryover.md`) — and none of it is reopened. What has never been rethought is the *interface* over
it, which the owner has now run daily for two weeks.

**Two defects found while reading, independent of any interface decision:** a Coach edit silently erases every item's rationale line (§8.1), and the hub's "draft
one with the Coach" path ends in prose because no tool can create a protocol (§8.2). Both should be fixed whether or not the rest of this document is taken.

---

## 1. Current state

### 1.1 Four screens, one long form

Four routes in the flat stack (`app/_layout.tsx:329-334`): hub, detail, editor, version history. Two ways in — Home's label-voice link under the mission plate
(`app/(tabs)/index.tsx:122-137`) and Data's row — and one from the mission record, where a failing *source* row pushes the detail
(`app/mission-history.tsx:452-461`).

**The hub** (`app/protocols.tsx`) spends its one accent on *New protocol* (`:133-140`) and draws three ruled plates. A row's head line is the name, a mono figure
that is the adherence rate since the live version landed or `no record yet` (`:63-67`, `:84`), and a chevron (`:85`); then up to two lines of description
(`:88-94`), a dashed rule, and a foot of `type · phase summary` left, `vN · cadence summary` right (`:101-110`). The cadence summary is `contentCadenceSummary`
(`src/lib/protocols/format.ts:94-99`): one word when every item agrees, **`mixed`** the moment two differ — a daily creatine beside a Mon/Wed/Fri lift says
`mixed`, and so does a protocol with one 3×/wk quota. Every row's figure costs an adherence read inside the per-protocol loop (`src/hooks/use-protocols.ts:74-89`,
`:77`). Nothing on the screen says what any protocol puts on today or when the next thing lands.

**The detail** (`app/protocol-detail.tsx`) is a reference surface with an accent budget of zero, by design (`:61-64`). The head is `type · Paused` (`:105-108`),
the description as serif prose (`:109-113`); then a `field` headed *Now* (`:117-119`) listing the live phase's items as text; a `plate` headed *Adherence*; and a
`plate` headed *The document* with Edit and Version history (`:265-281`). No item line is tappable. The only way to change anything is *Edit*.

**The editor** (`app/protocol-edit.tsx`) is one scrolling form for create and for every edit. Its contract is at `:29-42`: identity in place, phases and items as
a version, a save reaching today. Top to bottom: name and description; seven type chips (`PROTOCOL_TYPES`, `format.ts:17-25`); the phases, each item a title row,
a dose field, a collapsed time line (`TimeControl`, local to the file at `:309`) and a collapsed cadence line (`CadenceControl`, `:448`); then on the edit path
the Active/Paused pair, the two `0050` policy pairs, change notes, *Save as vN* and *Delete protocol*. Save goes through `reviseProtocol`
(`src/lib/db/repositories/protocols.ts:197-243`) with all four identity fields, the flag, the anchor, both policies, and `content: null` when the canonical JSON
is unchanged and no notes were typed (`protocol-edit.tsx:715-732`); then `rederiveMissionForDay` and `syncReminderNotifications` (`:750-755`). Nothing below
changes that contract. What the form refuses: an item's `notes` — "Not edited here (Coach territory)" (`:100-101`), carried through a save blind (`:695`). That
field is the `why` the generator stamps on the row (`src/lib/db/repositories/mission-generate.ts:495`, `:499`) and the italic line the hero prints
(`src/components/home/hero-card.tsx:314-318`).

### 1.2 What a protocol looks like from Home

Home reads one day (`src/hooks/use-today-mission.ts:82-84`), seeding it on every read (`:51-57`; `src/lib/db/seed.ts:102-113`). A mission row
(`src/components/home/mission-item.tsx`) is ONE `Pressable` with `accessibilityRole="checkbox"` and a label that *replaces* its children's text (`:107-112`,
`:26-30`). Its line is `flex-row items-baseline` (`:119`): mono time, then the title carrying `flex-1` and no line limit (`:124-128`, `:163-167`), then the
category text at `numberOfLines={1}` with no shrink class (`:133-143`), already carrying `CATEGORY · 2 DAYS LATE · Snoozed`. Tap flips completed↔pending
(`toggleMission`, `mission.ts:311-317`). The protocol name left the row on 2026-08-10 (`:42-46`) and survives in the hero's head (`hero-card.tsx:288-294`); Skip
and Snooze exist only on the hero (`:324-354`), and a mis-tapped Skip is awkward to undo because `toggleMission` moves a `skipped` row to `completed`, never back
to `pending` — the hero's own docblock names the fix: *"the fix is `toggleMission` — the undo — not a third row of chrome"* (`:230-236`). Snooze is session state
in the hook (`use-today-mission.ts:63-64`, `:85`, `:162-164`), cleared by any status write (`:145`, `:155`) and by the rollover (`:108`); no pushed screen can
reach it.

The view-model carries the protocol's *name* and nothing else (`src/types/home.ts:46-47`); `toMissionItem` never reads `log_entries.protocol_id` or `daily_log_id`
(`mission.ts:73-91`) though every generated row carries both (`mission-generate.ts:506`, `:619`; `LogEntryRow.daily_log_id`, `src/lib/db/types.ts:234`) and the
item's id as `value.item` (`:501`). A carried row IS the debt (`home.ts:55-61`); every status write on it also settles or re-opens the original (`mission.ts:238`,
`:245`, `:284-308`). So a row cannot say which protocol put it there, cannot be skipped, moved, removed, un-snoozed or un-skipped by hand, and cannot reach the
protocol that made it.

### 1.3 The Coach's view

`get_protocols` (`src/lib/ai/tools/read-tools.ts:1459-1504`) emits per item title · scheduled_time · dose · cadence (`:1493-1498`) and per protocol slug · name ·
type · isActive · versionNumber · the live phase; output costs nothing against the schema budget (`:1468-1472`). Not emitted: `notes`, `description`, `remind`,
`started_on`, `carry_over`, `checkoff_mode`. `update_protocol` (`src/lib/ai/tools/write-tools.ts:945-1045`) is a complete replacement, the rule stated once in the
system prompt: "Anything you omit is DROPPED" (`src/lib/ai/system-prompt.ts:105`). Its item schema declares `notes` (`:980`); ids are inherited by title as a
multiset (`:859-865`); `remind` is inherited by id *because the model cannot see it* (`:867-879`); `notes` is taken from the call or nulled (`:906`). The schema
is 424 tokens, "still the largest schema and still unswept" (`db/coach-eval.test.mjs:809-810`); the last accounting is 9,241 against `< 9250` and 3,669 against `<
3700` (`:807`, `:814`, `:820`, `:759`). `adjust_today` (`:1201-1206`) is the only per-row surface, today only. No tool creates a protocol; the hub's empty state
nonetheless seeds the Coach with a drafting prompt (`protocols.tsx:116-118`, `:162-176`; `app/(tabs)/coach.tsx:122-128` seeds and never sends).

### 1.4 What exists that the interface does not use — and what it costs

- **`planForDay` is a pure read over any date** (`mission-generate.ts:447-585`), and the reminder scheduler walks it six days ahead
  (`src/lib/notifications/protocol-reminders.ts:155-163`). **On a future date it produces artefacts.** Quota eligibility comes from `quotaCompletionsThisWeek(db,
  date)` over `[weekStart(date), date)` (`:200-221`, `:213`), so any day in *next* week has `done = 0` and a 3×/wk item lands on every day of it (`landsOn`,
  `:399-402`). For a protocol with `carry_over = 1` (`:456-458`, `:486-489`) the carry source `outstandingCarries(db, date)` reads `pending` rows in `[date − 7,
  date)` (`:281-310`, `:300-301`), so projected from today, every untouched row of today reads as a debt on every future day. The scheduler survives both only
  because it filters to `remind === true` with a time and keeps the *earliest* day per item (`:142-148`, `:159-161`). A visual list has neither guard. Its
  docblock is the codebase's most explicit structural rule: *"This function is the one definition of 'what this day should contain' … a carry computed anywhere
  else would drift from it inside a release"* (`:409-419`). Any projection must be this function, not a sibling.
- The shared `DayPicker` was "deliberately shaped so Today's Mission can reuse it unchanged" (`src/components/ui/day-picker.tsx:13-20`), takes no device
  (`:50-56`), and its forward bound is *always the logical today* by contract (`src/lib/utils/day-cursor.ts:19-25`, `:72-77`, `:86-88`), pinned in
  `db/day-boundary.test.mjs` §7 (`:530`) and §8 (`:610`). `day-cursor.ts:5` cites "§9", which does not exist; whichever phase touches the file fixes it.
- `moveMissionItem` and `removeMissionItem` exist with the right guards and each takes the day's `dailyLogId` (`mission.ts:363-377`, `:399-418`); only the Coach
  calls them. `setMissionStatus(id, 'pending')` un-skips, and re-opens a carried debt only when the original was settled by a *late completion* — the undo branch
  is guarded `status = 'skipped' AND late_on IS NOT NULL` (`:291-299`, `DONE_LATE_SQL` at `:162`).
- `setActive` (`protocols.ts:413-424`) has **no app caller** — `db/protocols.test.mjs:279-313`, `db/mission-generate.test.mjs:171`, `:900`. The editor pauses
  through `reviseProtocol`'s `active` (`protocol-edit.tsx:723`, `protocols.ts:204-210`). `addVersion` (`protocols.ts:151-163`) writes a version and touches
  nothing else — the Coach's path (`write-tools.ts:1022-1028`) — and on a version-less protocol it writes v1 (`insertVersionRow`, `:99-108`).
---

## 2. The owner's words

> **Parked — Protocol interface rethink** — *"just make a note in project status and we will continue later, it will require much rethinking."*
> (`docs/backlog-2026-09.md:63`)

Three September items touched these screens and were each answered in the model: **C9** — *"Items carry `scheduled_time`; the editor needs a picker"* (`:45`);
**C10** — reminders (`:46`); **C11** — *"if you miss something, it stays tomorrow until you check it off"* (`:47`), whose second toggle is *"deferred by the owner
until the mission has a day picker"* (`:47`, `:67`). Two adjacent parked bullets bind §8: **whole-app Coach access** — *"basically the entire app should be
accessible for reading and writing for the coach"* (`:66`; `project-status.md:9`, item (3)) — and the Modes revamp, after which "the Coach adjusts mission items,
the workout plan, etc. itself" (`:64`). **A9** settled all three protocol slop candidates (`docs/ai-slop-candidates-2026-09.md:248-265`); the one this rethink
inherits is the ended-protocol sentence at `protocols.tsx:218-221`, *kept* because it is the only statement of that rule (`:254-258`) — §6.2 must not drop it with
the description. One older call binds the shape of any answer: the create screen read as *"boxes on top of other boxes"* (`protocol-edit.tsx:67-81`), so that form
carries no plate and must not get one back.

---

## 3. The critique

The screens are honest and internally consistent; the two-week complaint is not that anything is wrong. It is that the sub-app is organised as a **filing system**
— documents, each with a reference sheet and an editor — when what a daily user does with a protocol is **adjust it while running it**.

**Every change is the whole form, and the ruler is taps.** A dose change today: Home → *Protocols* (1) → the row (2) → *Edit* (3) → scroll to the item → its dose
field (4) → type → scroll to the foot → *Save as vN* (5). Five taps and two scrolls, and tap 2 is a guess when two protocols run, because the row on Home does not
say which one put the item there (§1.2). `docs/home-screen.md:65` asks that everything on Home be actionable "in ≤ 2 taps when possible"; a dose is not a two-tap
thing, but five-plus-a-guess is the number to beat. Pausing — one bit, no version (`protocols.ts:204-210`) — walks the same form past every item. The repository
already distinguishes identity, policy and content (`ProtocolRevision`, `:166-189`); the interface presents them as one scroll. §5 states the post-change count.

**The form asks identity questions first.** Seven type chips, a description the Coach never sees, all above the items on the create path. The type does three
things, none of them daily: it selects the `log_entries.type` a row takes (`LOG_TYPE_BY_PROTOCOL`, `mission-generate.ts:51-59`), which (a) is the **category word
on every mission row and in the hero's tag** — `CATEGORY_BY_TYPE` is the fallback for every protocol row (`mission.ts:52-61`, `:80`; drawn at
`mission-item.tsx:133-143`, spoken at `:96-104`, the hero at `hero-card.tsx:269`), so a Daily routine re-typed as a Supplement stack reads `SUPPLEMENTS` instead
of `ROUTINE`; (b) is what Sick mode drops (`src/lib/modes/registry.ts:154`, applied at `mission-generate.ts:462-464`); and (c) shares its vocabulary with
`adjust_today`'s `type` (`write-tools.ts:1144-1153`). It is identity, set once and changed rarely.

**The rationale line has no author.** The editor refuses it (`:100-101`); the Coach cannot read it (§1.3) and clears it on any edit (§8.1). It is write-once, by a
model, blind.

**The mission row is a dead end** (§1.2). The verb the rows need most — *change this item* — is the five taps above; *put it back* exists as a repository call
nobody draws; *un-snooze* exists nowhere.

**Nothing shows tomorrow — and for one cadence kind, nothing honestly can.** Home is today; the hub says `mixed`; the detail lists cadence words without the day
an item next lands. For `daily`, `weekdays` and `every_n_days` the next day is a pure function (`cadenceLandsOn`, `src/lib/protocols/cadence.ts:81-98`). A `quota`
has no next day: it is an allowance, `1 of 3 this week`, and any surface that prints a day for it is printing §1.4's artefact.

Adherence is not a defect — measured correctly, bounded at the live version for a stated reason. The question is placement: it leads the hub row and is the
detail's second object, above the way in to change anything.

---

## 4. Six directions

| | A — a week strip on the hub | B — an editable detail | C — mission first, protocols behind it | D — a day picker on the mission | E — fix the toggle | F — a Tomorrow fold on Home |
| --- | --- | --- | --- | --- | --- | --- |
| **Lead move** | the hub opens on seven days | the detail is an in-place form | a row opens an item sheet; the detail leads with now/next and per-item editing; the form shrinks to structure | `DayPicker` on Today's Mission; a future day is committed and checkable | `toggleMission` moves `skipped → pending` | a read-only "Tomorrow: N items" line under the mission plate |
| **Answers** | what is coming | change it where I read it | why is this here, and change it from here | the parked future check-off | the undo the hero docblock asks for | what is coming, on Home |
| **Generator** | needs §6.0 | none | needs §6.0 | §6.0's flag plus a start-of-day re-derive and a bound widening | none | needs §6.0 |
| **Verdict** | rejected as the lead; kept as *Coming up* on the detail | rejected as in-place editing; kept as a pushed per-item editor | **recommended** | sequenced after C — question 4 | **taken as Phase 0** | rejected; kept as an option in question 4 |

**Why not A.** A week strip at the top of the hub is a second Home: CLAUDE.md §5 makes Home the one answer to "what now", `docs/home-screen.md:66` forbids a
dashboard there, and the hub's job is the plan *behind* the day. Grids are a sanctioned device (`00-design-spec.md:24`), so the objection is not the shape; it is
that every cell would be a projection and the honesty rules (`:170-172`) would have it say so on every cell. Scoped to one section of one protocol's detail, the
reading is small and can carry its one caveat once.

**Why not B.** A form carries no block — form (b) of the capture-surface rule (`src/components/ui/block.tsx:50-58`) — and devices never nest (`:129-132`;
`00-design-spec.md:44`). An in-place form on the detail would put recessed fields on the plate's raised stock, the mechanism the editor's docblock describes as
"boxes on top of other boxes" (`protocol-edit.tsx:67-73`). It also makes one screen both navigation and a dirty form, and the version discipline loses its one
moment. The good half — the edit starts from the item — survives as a pushed editor.

**Why C.** Its first move is on Home, where the two weeks were spent. It turns the row into a door without changing what the row draws, re-orders objects the
detail already has, keeps every write path the repository has, and leaves the full editor for the two jobs that need a document: building a protocol and
restructuring phases.

**D, on its merits.** The owner's stated prerequisite for the parked item (`backlog:67`); the component exists for it (`day-picker.tsx:13-20`); the spike worked
out its mechanics — stepping onto a future day commits the whole day through `generateMissionForDay`, because a second way for rows to come into existence is how
two earlier bugs happened (`protocol-carryover.md:400-405`), and the check stamps `value.checked_ahead_on` (`:406-410`). What the spike did not have in front of
it is §1.4: a day committed early through today's `planForDay` carries today's untouched rows into it and a quota onto every day of next week, and is then frozen
— `generateMissionForDay` no-ops on a day with planned entries (`mission-generate.ts:608`) and the re-derive runs only on an edit or a mode change, for today
(`protocol-edit.tsx:750`, `write-tools.ts:1033`). So D needs the future-day plan without the carry and the quota (§6.0's flag, built in Phase 1 *for this*), a
re-derive of a pre-committed day when it becomes today, and a widening of `DayBounds.latest` past today against a contract that says it is always the logical
today (`day-cursor.ts:21-25`; `db/day-boundary.test.mjs` §8). That is the expensive half the spike named (`:393-396`), and it must not collide with the Modes
removal's `0043` renumbering (`backlog:64`).

**E, taken.** `toggleMission` (`mission.ts:311-317`) becomes `completed → pending`, `skipped → pending`, else `completed`. One line, the hero docblock's own
prescription, and it answers "put it back" for every plain skipped row with no route and no view-model change. Its cost: completing a skipped item becomes two
taps instead of one, the right price for making a mis-tap reversible. The sheet's *Put back* (§6.1) is then needed only for a *carried* skip, whose undo has to
reach the original.

**Why not F.** Cheap — `planForDay(tomorrow, { committing: false })` and one folded line — and on the right screen. It loses because it answers "what is tomorrow"
while the question the row provokes is "when does *this* land next", which the sheet answers per item at the moment it is asked; because it is a fifth block on
the one screen whose every row is committed, so its one line must carry the projection caveat; and because Home must not grow toward a dashboard
(`home-screen.md:66`). It is the cheapest thing that shows a future day, so question 4 keeps it as an option.

**Considered and rejected — D as the lead direction.** The first critique asked why the owner's prerequisite stays unmet after a rethink of the protocol
interface. It does not: Phase 1 builds the flag D needs. Leading with D would put three generator changes ahead of every screen the owner complained about;
question 4 lets the owner pull it forward.

---

## 5. Recommendation

Direction C, in order of weight, with E as its Phase 0:

1. **A mission row can be opened.** A pushed sheet per row — what it is, which protocol and phase, its cadence and next day (or its allowance), and the verbs:
   skip, move, remove, un-snooze, and for a carried skip *put back*. The row's tap stays a toggle; VoiceOver reaches the sheet through a named action.
2. **A per-item editor.** One pushed form for one item — title, dose, why-line, time and reminder, cadence, phase — writing a version through `addVersion` and
   touching nothing on the `protocols` row.
3. **The detail becomes the working screen.** Now first, with tappable items; *Coming up* from the projection; adherence third; the document rows last; *Settings*
   in the header.
4. **The hub row leads with what the protocol is doing**, not with its rate; `mixed` is retired.
5. **The full editor is for structure.** On the edit path it loses identity, status and policy.
6. **The Coach's two defects are fixed first**, at zero schema cost; the create path at a measured +1.

**The same dose change, after:** chevron (1) → *Edit this item* (2) → the dose field (3) → type → *Save as vN* (4). Four taps, no scroll, no guess — the row knows
its protocol. From the detail: row (1) → item (2) → field (3) → save (4). Pausing: row (1) → *Settings* (2) → *Paused* (3) → *Save* (4), against five taps and two
scrolls today. Nothing above requires a column, a table, a native module, or a change to how *today* is generated.

---

## 6. The screens, in Conformed Set vocabulary

Labels are product nouns; empty states are authored, one sentence, not written here. Measured values mono, labels the label voice, titles serif; a measured value
inside a label — `v4` — stays mono (`00-design-spec.md:87`, `:90`, `:92`). Adherence is behaviour and never a signal colour (`protocol-detail.tsx:61-64`).

### 6.0 The projection — `planForDay` under a flag, not a sibling

`planForDay(db, date, opts = { committing: true })`. With `committing: false` it never reads `outstandingCarries` — a debt is a fact about days that have happened
— and never places a `quota` item. Everything else is byte-for-byte the function at `mission-generate.ts:447-585`: the active-with-a-version filter (`:449`), the
mode's `dropTypes` for that date (`:462-464` — a Travel mode set through Sunday is a fact about the plan), `phaseOn` (`:470-471`), `cadenceLandsOn`, and the
`adjusting` clock read from `lastCompletions(db, date)` for that date (`:459`, `:392-398`) — so the docblock's one-definition rule (`:409-419`) is kept rather
than forked, and Phase 5 flips the flag instead of writing a third rule set.

Over it, two thin helpers in the same file. `projectDays(db, from, days)` is `days` calls of the flagged function, **strictly forward-looking: `from` is
tomorrow**, horizon six days, the scheduler's (`:155`). Today is never projected — today is the committed rows. That is what makes the `adjusting` read honest:
each day's `lastCompletions(db, date)` counts completions strictly before it (`:338-341`), which for tomorrow includes a completion made this morning, exactly as
tomorrow's real generation will read it. `nextOccurrence(projection, protocolId, itemId)` is the first day whose entries carry `extras.item === itemId`; null for
a quota, an ended or a paused protocol. A quota is reported as an allowance `{ per_week, done }` from a **new** `quotaDoneThisWeek(db, today)` over
`[weekStart(today), today]` *inclusive*. It must be a sibling of `quotaCompletionsThisWeek`, not a call to it: the generator's bound is `< date` on purpose — a
row standing on its own day must not be judged by it (`:191-194`) — but a display that excludes today under-reports by exactly the session just ticked. Nor can
the display call the generator's query with `addDays(today, 1)`: on a Sunday that is next Monday, `weekStart` moves with it, and the range is empty.

**Read once per render, never per row.** The hub reads one projection, one `quotaDoneThisWeek`, and one today-count grouped by `protocol_id` over today's
committed rows under the standing predicates, and hands each row its slice inside the loop at `use-protocols.ts:74-89`. Cost, stated: six flagged `planForDay`
calls, each `getActiveMode` + `listProtocols` + one `getCurrentVersion` per protocol + `experimentsRunningOn` + (if any protocol is `adjusting`) `lastCompletions`
— for six protocols about sixty small synchronous statements on device, once per hub or detail render. The scheduler is left alone: its guards make it correct for
its own purpose, and the notification path has device-verified behaviour this does not; the two can share the flag in a later round.

### 6.1 Home — the row and the item sheet

**The row draws what it draws today.** The change is structural: the row becomes a `View` holding the existing checkbox `Pressable` (`flex-1`, role, label,
unchanged) and, as a *sibling* outside it, an 18pt chevron `Pressable` in `ink-muted` with `hitSlop` to a 44pt target (`screen.tsx:177`) that pushes the sheet. A
sibling, because an accessible Touchable collapses its subtree on iOS — a chevron nested inside the checkbox is never independently focusable. The chevron is
hidden from assistive tech, and the checkbox gains `accessibilityActions={[{ name: 'open', label: 'Open item' }]}` with `onAccessibilityAction`, the water tile's
exact shape (`quick-add-grid.tsx:311-317`), so VoiceOver reaches the sheet from the rotor without the role or the spoken row (`mission-item.tsx:96-104`) changing.

**What the width costs, correctly attributed.** The element that yields on this line is the *title*: it carries `flex-1` (`:163-167`) and no `numberOfLines`,
while the category text has `numberOfLines={1}` and no shrink class (`:133-143`) and React Native's default `flexShrink` is 0. So ~30pt off the trailing edge
squeezes the title, which wraps — and a wrapped title breaks the single-baseline `when → what → what kind` reading the row is built on (`:32-40`). The fix is to
give the title `numberOfLines={1}`. Its cost: a long item name truncates where today it wraps; the hero prints the full title of the active item and the sheet
prints every title in full. Whether the longest real category string plus a carry mark still fits beside a truncated title at 375pt is a device question (§11);
the render suite proves one line, not legibility.

**Considered and rejected — that a long-press has no accessible equivalent.** `quick-add-grid.tsx` shipped one exposed as a named action.
Question 1 keeps long-press as (b); it is not recommended because a gesture with nothing visible is undiscoverable on a row that has always been one tap.
*(2026-09-21: that precedent is gone. The Water tile's long-press was deleted after the owner reported on device that "the button just adds 8" — he never found the gesture, and a named VoiceOver action did nothing for a sighted user. It is the argument in the second sentence here, confirmed on hardware.)*

**The item sheet** (`/mission-item`, pushed, parent *Home*):

```
  StackHeader   <title>                                   ‹ Home
  label         CATEGORY · <protocol name> · Phase 2 of 3            (protocol rows only)
  mono          07:30 · 5 g
  serif italic  <why-line>                                           (when present)
  margin        owed from Mon 14 Sep · 2 days late                   (carried rows only)

  SectionLabel  CADENCE
  field         Mon · Wed · Fri  ·  next Wed 17 Sep                  (next drawn only when later than tomorrow)
                3×/wk  ·  1 of 3 this week                           (a quota: the allowance, no day)

  SectionLabel  TODAY
  plate         <the verbs for this row's status — below>

  SectionLabel  MOVE TO                                              (opens under the plate on Move to …)
                TimeControl — presets · HH:MM · Move                 (no block: a control, form (b))

  SectionLabel  THE ITEM
  plate         Edit this item →                                     (pushes /protocol-item)
                Open <protocol name> →                               (pushes /protocol-detail)
```

**The TODAY plate by status.** `pending`: *Skip today* (`setMissionStatus(id, 'skipped')`, `mission.ts:232-239`), *Move to …* (`moveMissionItem(db, dailyLogId,
id, time)`, `:363-377`, the control opening below the plate because a recessed field inside a plate is the inversion §4-B rejects), *Remove from today*
(`removeMissionItem`, `:399-418`), and *Unsnooze* when the row is snoozed. `skipped` on a plain row: one authored line — with Phase 0, the row's own tap is the
put-back. `partial`: *Put back* (`setMissionStatus(id, 'pending')`). `completed`: *Mark not done* (the toggle). **A carried row** is the debt itself, so its verbs
are stated: *Skip* writes `skipped` on the copy AND on the original — a hand-tapped skip is a decision not to do it (`protocol-carryover.md:21`), and leaving the
original `pending` would re-levy it tomorrow (`outstandingCarries` reads `pending` originals, `:300-301`) — through one new function `skipCarried(db, copyId)`
that stamps the original `value.skipped_via = <copy id>`, guarded on `status = 'pending'` and the standing predicates like the settle branch
(`mission.ts:301-307`). *Put back* on that copy calls `setMissionStatus(copy, 'pending')`, whose undo branch (`:291-299`) is **widened** to re-open an original
marked either `late_on` *or* `skipped_via = this copy`, removing both keys — one undo path, mirroring the two ways a copy can settle its original, and reachable
by the Phase-0 toggle unchanged. The record's reading: the original's day changes from untouched to `skipped` — a miss on a non-excusing day either way — and back
on undo; the adherence ledger reads neither mark (`DONE_LATE_SQL` feeds only the `doneLate` annotation, `mission.ts:745-746`; `skipped_via` feeds only the undo
guard). This is a deliberate write on a row the user is looking at, the same class as the settle-on-completion write the spike accepted (`:27-29`), not the
every-app-open annotation its departure row 3 rejected (`:19`). *Remove* tombstones the copy only and the debt returns tomorrow, which the sheet says; *Move*
moves the copy. Mode and experiment rows draw only the TODAY plate; so does a row whose item has since been edited out of the live version, with one authored line
in CADENCE's place.

**Snooze.** The snoozed set leaves hook state for a module store `src/lib/home/snooze-store.ts` with the `subscribeModeChange` shape
(`src/lib/modes/store.ts:22-35`); `useTodayMission` subscribes and keeps its two clears (`:108`, `:145`). Semantics unchanged — never persisted — and now a pushed
route can clear one entry.

Accent budget zero, for the detail's reason (`protocol-detail.tsx:61-64`). The sheet needs four view-model fields on `MissionItem` (`home.ts:15-69`) —
`dailyLogId` from `log_entries.daily_log_id`, `protocolId` from `protocol_id`, `itemId` from `value.item`, `carriedFrom` from `value.carried_from` — all read in
`toMissionItem` (`mission.ts:73-91`) off what every generated row carries. `TimeControl` and `CadenceControl` move out of `protocol-edit.tsx` (`:309`, `:448`)
into `src/components/protocols/`, unchanged, because §6.4 needs them too.

### 6.2 The hub

The three plates, the one accent, the row chevron (`:85`) and the ended-protocols sentence (`:218-221`) stay. The row leads with what the protocol is doing:

```
  serif 16 semibold   <name>                     mono  3 today · next Wed   ›
  label 10            SUPPLEMENT STACK · Phase 2 of 3 · day 4 of 28
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
  label 10            VERSION  mono v4                  mono  82% run
```

`3 today` is this protocol's slice of the once-per-render today-count (§6.0). The next-day half is a **suppression rule**: drawn only when the earliest
`nextOccurrence` over the live phase's non-quota items is strictly later than tomorrow. A daily protocol therefore reads `3 today`; daily creatine beside a
Mon/Wed/Fri lift reads `1 today · next Wed` on a Monday and `1 today` on a Tuesday; a quota-only protocol reads `3 today · 1 of 3 this wk`, and no day is printed
because none is true. Adherence moves to the foot beside the version; a paused row's figure reads `paused`, an ended row keeps `Ended 12 Jul`
(`format.ts:115-125`). `contentCadenceSummary` is deleted with its one caller (`use-protocols.ts:82`); no test asserts `mixed` (the populated-hub assertions are
names and the phase, `db/screens-render.test.mjs:2210-2218`). **The description leaves the row** — two serif lines per row (`:88-94`) is what makes a six-protocol
hub a page and a half — and stays on the detail, one tap away. That is a change to a screen the owner has read daily; question 2 asks.

### 6.3 The detail — the working screen

```
  StackHeader   <name>                                        ‹ Protocols     [Settings]
  label         SUPPLEMENT STACK · mono v4 · Paused                  (Paused when is_active = 0, as today)
  margin        <description, serif prose>                           (when present)

  SectionLabel  NOW                                  note   Phase 2 of 3 · day 4 of 28
  field         <phase title or "Running">
                mono  started 7 Sep · phase ends 4 Oct
                ┌ items of the live phase, one per line, each a 44pt row ────────────
                │ mono 07:00   serif Creatine  mono 5 g     label MON·WED·FRI     ›
                │ mono —       serif Lower body             label 3×/WK · 1 OF 3  ›
                └──────────────────────────────────────────────────────────────────

  SectionLabel  COMING UP                            note   next 6 days
  plate         Wed 17   Creatine · Lower body
                Thu 18   Creatine
                margin   projected from the plan; not yet committed

  SectionLabel  ADHERENCE                            note   82%
  plate         (as today; the per-item rows now tappable into the item editor)

  SectionLabel  THE DOCUMENT
  plate         Edit the whole protocol →            (phases, order — the full form)
                Version history →                    mono  now v4
```

The items inside *Now* stay inside the `field` — rows that push a screen are content, not a nested device (`block.tsx:129-132`; `00-design-spec.md:44`). *Coming
up* is a `plate` because it is a record of days, this protocol's slice of §6.0's projection; a quota item never appears in it and reads its allowance on its NOW
row. The margin line is the projection's one honesty sentence: a computed day must not wear the face of a committed one — the provenance rule `0034` states for
numbers (`db/migrations/0034_recipe_photo_autoresolve.sql:17-19`), of the family `00-design-spec.md:170-172` keeps. **A paused protocol** keeps `· Paused`; its
NOW field's first line reads *Paused — puts nothing on a day*, the phase line stays prefixed *clock reads*, because the clock runs while paused by design
(`protocols.ts:405-411`); *Coming up* is not drawn. *Settings* is the `StackHeader.action` slot (`src/components/ui/stack-header.tsx:47-61`), label voice. Accent
zero.

### 6.4 The per-item editor (`/protocol-item`)

A form, so no block — form (b) of the capture-surface rule (`block.tsx:50-58`); every field is recessed stock.

```
  StackHeader   <item title or "New item">                    ‹ <protocol name>

  SectionLabel  ITEM
  field (recessed stock)   title
  field (recessed stock)   dose or short how-to
  field (recessed stock)   why — the rationale the hero prints         (multiline)

  SectionLabel  WHEN        (TimeControl, open by default: presets · HH:MM · reminder)
  SectionLabel  HOW OFTEN   (CadenceControl, open by default)
  SectionLabel  PHASE       chips  Loading · Maintenance               (phased protocols only)

  problem line, if any
  [ Save as v5 ]                                              the screen's one accent
  footnote as today: the save updates today's mission
  Remove this item                                            (edit path only; neutral)
```

**Write path, stated exactly.** `reviseProtocol` has no identity-untouched branch: `name`, `type`, `description` and `active` are required and always written
(`protocols.ts:166-170`, `:204-210`), and a defaulted `active: true` would stamp `started_on` on a protocol whose clock was null (`:217-222`). So this screen does
not call it. Save re-reads the live version *at save time* (`getCurrentVersion`), rebuilds the document with this one item replaced, appended or removed, runs
`normalizeContent` and `validateContent` (`src/lib/protocols/content.ts:189`, `:297`) as the full form does, and writes through **`addVersion(db, id, content,
note, 'user')`** (`protocols.ts:151-163`) — the Coach's own path — so the `protocols` row is untouched by construction. Then `rederiveMissionForDay` and
`syncReminderNotifications` (`protocol-edit.tsx:750-755`); the no-op guard is the same string compare (`:715-718`). **A version-less protocol**
(`current_version_id` NULL) renders no items; its NOW field offers *Add an item*, and that save writes v1 with one phase holding one item — legal, and what the
Coach's tool does on the same protocol (`write-tools.ts:1021-1022`, `liveContentOf` parsing null). Phases stay the full editor's. **Staleness:** `useProtocol`
seeds once (`use-protocols.ts:137-142`), so a Coach `update_protocol` approved while this sheet is open would be reverted by a save built from mount-time content;
the re-read at save prevents that, and if the item's id is no longer in the live version the save refuses with one authored line.

**Grain: every item save is a version**, with an auto-filled note naming the item. Folding several saves into one would need a draft state on the detail — a dirty
form on a navigation screen, B's rejected shape — and would make *Restore* mean "to a fold". Whether a version per dose tweak reads as record or noise after a
month is a device question (§11). The `why` field is the one genuinely new authoring surface, placed here and not on the create path (eight empty multiline
wells); question 3 asks who owns it once three parties can write it.

### 6.5 The settings sheet (`/protocol-settings`)

A form, no block. Name; description; the seven type chips (the CHECK vocabulary, `db/migrations/0001_init.sql`); Active/Paused; *Phase 1 starts* for a phased
protocol; the two `0050` pairs with their notes as drawn today; Save; Delete. It writes through `reviseProtocol` with `content: null` — it draws all four identity
fields, so the required-fields shape is exactly right, and `content: null` is the branch that writes no version (`protocols.ts:232`); `setActive` stays test-only.
The same re-read-at-save rule as §6.4 applies to the policy fields. **The type chips move one tap further from the detail, and what moves with them is the
category word** (§3): re-typing a protocol changes `ROUTINE` to `SUPPLEMENTS` on every row it generates — from *tomorrow*, because the re-derive's kept-row UPDATE
writes `value` and `scheduled_time` only, never `type` (`mission-generate.ts:836-840`). The sheet says so in one line under the chips. That is why the chips are
settings and not a daily control: their consequences are the word on the row, Sick's `dropTypes`, and nothing a day changes at the time.

### 6.6 The full editor, trimmed

The create path stays whole (`protocol-edit.tsx:49-55`). On the **edit** path it loses the identity block at its head and the status, policy and delete controls
at its foot; it keeps phases, items, *Add a phase*, the start date and change notes. Its writes change to match: content through `addVersion`, the anchor through
`setStartedOn` (`protocols.ts:427-429`), nothing else — a structure-only save leaves `name`, `type`, `description`, `is_active`, `carry_over` and `checkoff_mode`
byte-identical (§9). Two additions it has lacked: move an item within its phase, and move a phase — order is the one thing the per-item editor cannot express. No
plate, ever (`:75-81`). The version history is unchanged, except that `+ N more` (`protocol-versions.tsx:296-300`) becomes a tap that expands.

### 6.7 Routes and documents

Three routes register beside the four at `app/_layout.tsx:329-334`: `mission-item`, `protocol-item`, `protocol-settings`. Typed routes regenerate only under `expo
start` (`.expo/` is gitignored), so a worktree typecheck cannot catch a bad `pathname` — a route typo shipped on 2026-09-14 and was fixed in `3fd46fa`. §11 lists
it. `docs/information-architecture.md` changes in the same pass: the pushed sub-screen list (`:20`), the Protocols entry (`:72`), and `:182`, which still says the
mission record's rows tap through to `/protocol-edit` when the code pushes `/protocol-detail` (`mission-history.tsx:457-459`). The record keeps its per-source
unit — `MissionItemRecord` carries a title and six counters and no id (`mission.ts:730-747`, by the argument at `:749-754`) — so there is no third door into the
item editor from it; the detail's tappable items make an item two taps from the record.

---

## 7. Data model: no migration, and what is new instead

No column, no table. The item sheet reads `daily_log_id`, `protocol_id`, `value.item` and `value.carried_from`, on every generated row today. `skipped_via` is one
more key in `log_entries.value` JSON, read by one guard; nothing shipped reads or rejects it. The per-item editor and the trimmed form write through `addVersion`;
the settings sheet through `reviseProtocol`'s existing branches. Head stays `0058`; `0059` stays free (`docs/backlog-2026-09.md:72`).

What is new is computation: the `committing` flag, `projectDays` / `nextOccurrence` / `quotaDoneThisWeek`, `skipCarried` and the widened undo, the snooze store,
four view-model fields, the hub's today-count. Three things that could tempt a migration and are not proposed: a per-item paused bit (a cadence change or a
removal, in versioned content a restore brings back); an item order column (order is array order in the version); a stored next occurrence (derived; storing it is
how it goes stale). No new native module; the date field stays typed for the reason C9's time control is not a wheel (`backlog:45`). *(2026-09-23: that reason was overruled from the device — the time control is now the native iOS wheel; the date field is the obvious next candidate for the same picker.)*

---

## 8. The Coach

Both parked bullets in §2 point the same way — the Coach should eventually read and write the whole app — and this section is written against that instruction.
What it refuses, it refuses on token grounds it states.

### 8.1 Defect: a Coach edit erases every rationale line

`get_protocols` does not emit `notes` (`read-tools.ts:1493-1498`); `update_protocol` takes `notes` from the call or writes null (`write-tools.ts:906`). Any Coach
edit re-sends every item without a field the model never saw, and every `why` the hero prints is gone from the new version. **Fix: emit `notes` in `get_protocols`
output**, omitted rather than nulled when empty (the C13 rule, `coach-eval.test.mjs:789-791`). The model then re-sends it as it re-sends `dose`, the complete-set
sentence (`system-prompt.ts:105`) becomes true for this field, and a deliberate rewording is possible. Schema cost 0.

**Considered and rejected — inheriting `notes` by id, as `remind` is.** The `remind` exception is justified *by* invisibility (`:872-873`) and emitting `notes`
removes the justification; the prompt's "anything you omit is DROPPED" would then be false for one field, which needs a sentence the prompt has 31 tokens to
spend. And `optString` returns `undefined` for an absent key and an empty string alike (`src/lib/ai/tools/types.ts:99-105`), so at `:906` "omitted" and "cleared"
are one case — inheritance would make a note un-clearable, and letting the Coach reword but not clear would need a sentinel value and a sentence to explain it.
Question 3 separates the two.

### 8.2 Defect: the drafting path has no write — measured

The empty state sends the owner to the Coach (`protocols.tsx:116-118`); no tool creates a protocol. Four options, question 5. The recommended one, **measured with
the suite's own formula** (`jsonTok = length / 2.8`, `coach-eval.test.mjs:386`) on a reconstruction of the schema that reproduces its current **424** exactly:
`protocol_slug` becomes optional (`required` shrinks, −6), `name` and `type` are added as **bare strings** (+9 each), and the tool description gains ` No slug +
"name" + "type" creates one.` (+15). A call with `name` and no slug creates through `createProtocolWithVersion` (`protocols.ts:130-143`); a typo in a slug still
errors (`requireProtocol`, `write-tools.ts:933-939`), because creation needs the slug *absent*; an unknown `type` errors naming the seven values, the registry's
own pattern (`coach-eval.test.mjs:746`). Paid for by two restatements, deleted: `protocol_slug`'s `"From get_protocols."` (`:960`, −13; the tool description
already says "by its slug from get_protocols", `:955`) and `phases`' `"Ordered; usually one."` (`:963`, −14; its own children say it — `"Omit if single-phase."`
at `:967` and `"the LAST phase"` at `:970`). **Net +1: 424 → 425, 9,241 → 9,242 against `< 9250`, 8 of headroom.** The confirmation card reads "Create *name*: N
items".

**Considered and rejected — re-ranking (c), the editor handoff, because the arithmetic did not close.** The second critique was right that the first draft's "≈ 50
tokens" did not close: the seven-value `type` enum alone measures **52**, and with it the addition is **+72**. The enum was the cost, not the create path; a bare
`type` string plus the error-names-the-set pattern is 9, and the number above is the whole accounting. (c) stays as the zero-Coach-cost alternative; its own cost
is a fourth one-shot prompt under its own ceiling (the food-entry precedent, `:830-857`).

### 8.3 Output-only widenings — schema cost 0, output cost counted

`get_protocols` gains `notes` per item and, per protocol, `carryOver`, `checkoffMode`, `startedOn` — each omitted at its default so a default device carries no
"no". Output is billed uncached on every turn that calls the tool: on a device with six protocols of five items, `notes` is ≈ 30 × 14 ≈ **420 tokens a call**, the
three protocol fields ≈ 24 each when non-default. `notes` is the fix and is worth it. **Per-item `nextOn` is not emitted**: ≈ 9 tokens × every item, every call,
for a figure the model can derive from cadence, `startedOn` and `checkoffMode`, which it now has. Judgment stays in the model (`system-prompt.ts:114`).

### 8.4 What is not added, and the four assertions

No `update_protocol_item`: ~150 tokens of schema against 8 of headroom, and a second write path into versions with its own id resolution. The complete-set tool
already reaches every item; the per-item editor is the owner's surface; `adjust_today` covers the per-row verbs (`write-tools.ts:1141`). The Modes revamp
(`backlog:64`), when the Coach is asked to re-plan days itself, is the round to revisit the budget as a whole.

`db/coach-eval.test.mjs` §6 guards `allToolTokens < 9250` (`:814`), `systemTokens < 3700` (`:820`), the food-entry prompt's ceiling (`:853-857`), and Haiku's
cache floor `systemTokens + readToolTokens > 4096` (`:863-872`), which trimming moves *down* (`:824-829`). §8.1 and §8.3 are output and move nothing; §8.2's trims
are inside a write tool, so `readToolTokens` is untouched. The ledger's note that the cheap trims are spent (`:807-809`) is why §8.2 names two restatements rather
than two instructions, under the trim rule at `:393-400`.

---

## 9. Tests

Headless, `node:sqlite`, in the suites that own each seam.

1. `db/data-layer.test.mjs` §4 (`:149`) — `toggleMission` moves `skipped → pending` and `completed → pending`, and `pending → completed` as before; `protocolId`,
   `itemId`, `dailyLogId` and `carriedFrom` ride the view-model on generated rows and are absent on mode and experiment rows.
2. `db/mission-generate.test.mjs` after §21 (`:968`) — `planForDay(d, { committing: false })` returns no carried entry and no quota item on a database where
   `planForDay(d)` returns both, and every other entry is identical, day by day over the six-day horizon, for `daily`, `weekdays` and `every_n_days`, under
   `strict` and `adjusting`, across a phase boundary and under a mode that drops the type (the same function, so the assertion is that the flag touches nothing
   else); the default flag leaves §0–21 untouched; `nextOccurrence` is null for a quota, an ended and a paused protocol; `quotaDoneThisWeek` reads `3 of 3` for an
   item completed this morning while `quotaCompletionsThisWeek(db, today)` reads 2, and on a Sunday fixture the `addDays(today, 1)` shortcut would have read 0.
   Beside §17 (`:779`): `skipCarried` skips both rows and only both; `setMissionStatus(copy, 'pending')` re-opens an original marked `skipped_via` and one marked
   `late_on`, removing the mark, and touches an original marked neither not at all.
3. `db/coach-tools.test.mjs` §13 (`:565`) — `get_protocols` emits `notes`, `carryOver`, `checkoffMode`, `startedOn` when set and omits them at their defaults; an
   `update_protocol` that re-sends a note keeps it, one that omits it drops it, one that changes it changes that item only; a call with `name`, `type` and no slug
   creates and reaches today; a bad `type` errors naming the seven values.
4. `db/coach-eval.test.mjs` §6 — all four assertions hold; the accounting comment records 0 for §8.1/§8.3 and the measured +1 for §8.2.
5. `db/protocols.test.mjs` after §12 (`:747`) — a per-item save of one dose change yields a version whose `content` is byte-identical to the full editor's for the
   same change, with `change_notes` asserted separately (auto-filled versus typed); an item edited back to itself writes nothing; a per-item save and a
   structure-only save leave `name`, `type`, `description`, `is_active`, `started_on`, `carry_over`, `checkoff_mode` byte-identical; a per-item save built after a
   Coach `addVersion` contains the Coach's change; a per-item add on a version-less protocol writes v1; the settings sheet's path writes no version.
6. `db/screens-render.test.mjs` — the item sheet renders name, phase, cadence and next day for a protocol row, the allowance for a quota row, no next day for a
   daily row, the owed-from line for a carried row, *Unsnooze* for a snoozed row, and only the TODAY plate for a mode row; the mission row keeps
   `accessibilityRole="checkbox"` and its spoken label, gains one `accessibilityActions` entry, and renders on one line with the longest category string plus a
   carry mark; the detail renders NOW as rows, *Coming up* with its margin line and no quota item, the paused head line, and the adherence assertions at
   `:2220-2243` keep passing; the hub row's figure in its four forms (`3 today`, `1 today · next Wed`, `3 today · 1 of 3 this wk`, `paused`) with the ended
   sentence still present; the settings sheet; the keypad check finds the item editor's fields dismissable.
7. `db/day-boundary.test.mjs` §5 (`:401`) — the projection walks `todayISODate` and the source scan stays clean.

---

## 10. Phases, effort, and what each one can be backed out to

| Phase | Piece | Size |
| --- | --- | --- |
| 0 | `toggleMission` un-skips (E); test 1's first half | an hour |
| 1 | §8.1 and §8.3; the `committing` flag, `projectDays`, `nextOccurrence`, `quotaDoneThisWeek` and test 2; the four view-model fields; `skipCarried` and the widened undo; the snooze store; `TimeControl`/`CadenceControl` extracted | 1 day |
| 2 | The item sheet and the per-item editor; the TODAY verbs; two routes | 1.5 days |
| 3 | The detail re-cut, the settings sheet and its route, the hub row, `contentCadenceSummary` deleted, the full editor trimmed, reordering, the versions expansion; the IA and status docs — **one merge** | 1.5 days |
| 4 | The Coach create path per question 5, the accounting comment | half a day |
| 5 | The day picker on the mission per question 4: `committing: false` for a future day, the arrival re-derive, the bound widening, `checked_ahead_on` | 1.5 days |
| | **Total** | **≈ 4 days for 0–3; 6 with 4 and 5** |

Phases 0 and 1 are a fix round and should not wait. Phase 2 without 3 leaves the item editor reachable only from Home, which is complete in itself. Phase 3 is one
merge because the settings sheet and the trimmed editor must land together: between them two surfaces would write identity, status and policy — both through
`reviseProtocol`, last write winning — and that window belongs on a branch, not in a build. **Backing out:** each phase is routes, a hook and a repository
function; reverting removes them and the IA lines. No phase writes data the previous code cannot read — a version is a version, `skipped_via` is a key nothing
else inspects, the flag's default is today's behaviour — so a revert never needs a data fix. Phase 1's shape is chosen for Phase 5 as much as for Phase 3: the
flag is the day picker's future-day plan. Phase 5 must land on a branch clear of the Modes removal's `0043` renumbering (`backlog:64`).

---

## 11. What only a device can settle

Whether an 18pt chevron with a 44pt hit area at the row's trailing edge is discoverable, and whether a truncated title beside `SUPPLEMENTS · 2 DAYS LATE ·
Snoozed` still reads at 375pt — the render suite proves one line, not legibility. Whether VoiceOver's rotor surfaces the row's custom action beside the checkbox
role. Whether the three new `pathname`s are typed routes: only `expo start` regenerates `router.d.ts`. Whether a reminder toggled in the per-item editor actually
fires — the one behaviour here with device-verified history (`protocol-reminders.ts`); the per-item save runs the same sync. Whether *Coming up* reads as a plan
or a dashboard with three running protocols. Whether the hub's figure is read or the eye stays on the name. Whether a version per dose tweak feels like a record
or noise after a month. Whether the settings sheet's *Delete* is findable off the form's foot.

---

## 12. Questions for the owner

**1. How does a mission row open its sheet?**

- (a) **(Recommended)** — a small chevron at the trailing edge, a separate 44pt target outside the checkbox, plus a named VoiceOver action on the row; the row's
  tap stays a toggle; long item titles truncate to one line, the sheet prints them whole;
- (b) long-press on the row with the same VoiceOver action; nothing visible is added and the title keeps wrapping;
- (c) no sheet — the detail's item rows are the only door to the item editor.

**2. The hub row: does the description leave it?**

- (a) **(Recommended)** — yes: name, `3 today · next Wed`, phase and version; the description reads on the detail;
- (b) keep one line of it, ellipsised;
- (c) keep it as today, two lines.

**3. Who writes an item's why-line, once three parties can?**

- (a) **(Recommended)** — you, in the item editor; the Coach reads it and re-sends it, and in an `update_protocol` you approve may reword it or clear it —
  clearing is omitting, the complete-set rule, and the card names the item whose note changed;
- (b) the Coach may reword but never clear — needs a sentinel value and a prompt sentence against 31 tokens of headroom, and runs against the whole-app
  instruction (`backlog:66`);
- (c) you only — the Coach inherits every note by id and never touches one; against `backlog:66`, and a note becomes un-clearable by the Coach.

**4. A future day on Home. The projection now exists; your standing answer is a day picker (`backlog:67`). When, and what first?**

- (a) **(Recommended)** — the day picker as Phase 5, after the Modes removal lands, so its generator changes never collide with `0043`'s renumbering;
- (b) the day picker right after Phase 3, before the Modes removal;
- (c) a read-only *Tomorrow* fold under the mission plate first — cheap, no committed rows — and the picker later.

**5. The Coach cannot create a protocol, and the hub says it can.**

- (a) **(Recommended)** — `update_protocol` learns to create (`name` + `type` as bare strings, no slug), measured **+1 token** after two restatement trims,
  checked against all four ceilings;
- (b) a separate `create_protocol`, ≈ 150 tokens and a larger trim the ledger says is not there;
- (c) a *Build this* handoff under a Coach turn into `/protocol-edit`, parsed by a one-shot prompt under its own ceiling — zero Coach schema cost, one more online
  step, every field reviewed before it saves;
- (d) leave it: the Coach drafts in prose and the empty state says so — offered for completeness; it runs against the whole-app instruction (`backlog:66`).
