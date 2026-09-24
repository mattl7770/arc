# The Coach domain registry

**Built 2026-09-19.** Implements Phases 0–2 of `docs/spikes/coach-whole-app-access.md`.
**Deletion widened 2026-09-23** to follow the screens (§10a; ADR in `docs/decisions.md`).
Spec of record for `src/lib/ai/domains/*` and `src/lib/ai/tools/record-tools.ts`.
Read this before adding a domain, a field, or a removal policy.

---

## 1. What it is, and why it is not sixty-eight tools

The owner's direction was *"basically the entire app should be accessible for reading and writing
for the coach"* (`docs/backlog-2026-09.md:66`). The audit found ~68 gaps: repository functions the
screens call that no tool could reach.

A bespoke tool per gap prices at **~14,000 tokens** of cached prefix at the registry's mean of 210 —
more than the entire existing toolbox, against a ceiling of 9,250 with 17 tokens of headroom. It is
not affordable, and it was never the right shape: sixty-eight descriptions restating one rule is the
duplication `db/coach-eval.test.mjs` §6 exists to punish.

So the app is described **once, in TypeScript**, as a list of DOMAINS, and three generic tools read
that description. What varies per domain — its fields, how each is validated, what the confirmation
card says, whether a row may be removed at all — costs nothing on the wire and is headless-testable
against real SQLite (`db/coach-domains.test.mjs`).

## 2. The principle

> **Parity with the screens, through the repositories, never past them.**
> A domain the user can read on a screen is readable; a change the user can make on a screen is
> proposable; a deletion the user can make on a screen is proposable too, behind a card that names
> what goes.

The last clause read *"…is the Coach's only where it is undo, not history"* until 2026-09-23, when
the owner reversed it (§10a). Deletion now obeys the same rule as every other act.

Every `read`, `edit`, `create` and `remove` in the registry calls the same repository function the
matching screen calls. **No entry writes SQL**, and there is no `run_query` tool — the audit rejected
one outright, because a card cannot say what arbitrary SQL will do. That is what makes the day
boundary (`src/lib/db/date.ts`), unit conversion, tombstones, provenance columns and every `CHECK`
*inherited* rather than re-implemented. Whatever the repository refuses, the tool refuses.

Parity covers what the screen does **after** the repository call, too. The protocol Settings sheet
saves through `reviseProtocol` and then re-derives today; the `protocols` domain's `edit` did only
the first half until 2026-09-23, so a pause or a carry-over change made through the Coach reached
today's mission the next morning. It now calls `rederiveMissionFromToday` after the write, exactly
as the sheet does: a pause takes the protocol's untouched rows off today, and anything already done
or skipped stays. That added no schema or description, so no tokens (`db/coach-levers.test.mjs` R7).

## 3. The shape of a domain

`src/lib/ai/domains/types.ts` is the contract. A `CoachDomainEntry` carries:

| Field | What it is |
| --- | --- |
| `key` | the enum value the model writes (`reminders`, `experiments`, …) |
| `label` | what the user calls it — the noun in every error and card |
| `resolve(db, id, ctx)` | id → a `DomainRow`, **throwing** when unknown, with a message naming the read that hands ids out. A bare id must never reach the user |
| `fields` | name → `{ parse, editable, requiredOnCreate?, note }` |
| `read` | `{ kind: 'bespoke', via }`, `{ kind: 'list', run }` or `{ kind: 'compute', needs, run }` |
| `edit?` | apply a validated patch — **read-modify-write, always** |
| `create?` / `createVia?` | a create path, or the bespoke tool that owns it |
| `summarize(args)` | the one human line the confirmation card shows |
| `selfEvident?(args)` | short card vs long. **Absent means long** |
| `remove?` | `hard` (with `gone`, the card's date-and-figures line, and `run`, the screen's own delete) \| `refuse` (with `because`, naming where the row lives). Every domain that holds rows declares one |
| `retires?` | the `UNCOVERED_DOMAINS` lines this entry makes false |

A `DomainRow` is `{ id, name, values, raw }`. `values` is load-bearing twice over: it is the "was X"
half of the card, and it is what the staleness guard re-reads.

### Three enums, three different subsets

- **`query_records`** takes domains with **no bespoke read**. A domain a registered tool already
  reads is *absent from the enum*, so the schema itself steers the model to `get_protocols` rather
  than leaving two paths to one answer and a rule in the prompt about which to prefer.
- **`edit_record`** takes domains that can be patched or created.
- **`delete_record`** takes the `hard` set — the domains whose screen offers a delete — so the
  schema refuses the rest at zero round trips. Deletion is a separate tool on purpose: **a removal
  must never be a *value* the model can set in passing.**

## 4. The rails a generic write passes through

1. **`readOnly: false`** — every call suspends the agentic loop until `confirmWrite` resolves. With
   no gate present, every write is declined.
2. **The card is built from validated input, with every id resolved to what it names**, and it
   throws at card time for any knowable failure. The recurring-reminder refusal moved here from
   `complete_reminder`'s `execute` — one Approve tap earlier than the old tool refused it.
3. **Read-modify-write, always.** A field the patch omits is preserved, never cleared.
   `replaceWorkout` deletes every set and re-inserts its argument, so a literal patch omitting
   `sets` would wipe a session behind a card that did not say so. `content` is excluded from the
   protocol domain's edit for the same reason.
4. **The staleness re-read.** The card is drawn *before* `await confirmWrite`, and the row can move
   inside that window — a Health sync, the pending-estimate drain, a carry-over re-derive, or the
   user editing the same row on its own screen. `edit_record` records the values the card printed
   (`CoachToolContext.card`) and re-reads them past the gate; a mismatch **throws**:

   > `status changed while the card was open (was active, now completed). Nothing written. Read it again and propose once more.`

   A throw means no receipt is minted (receipts live past `execute`), the thread shows the chip with
   no receipt, and the model re-proposes once against a fresh card.

   `delete_record` re-reads the same values **and the whole line the card printed**, because a
   removal card prints figures that are not fields — a meal's kcal, a session's sets, a protocol's
   version count. A line that no longer matches refuses, quoting both:

   > `That meal changed while the card was open (the card said "Delete meal "Pasta" — 2026-09-23 20:00 · 700 kcal", it now reads "… 640 kcal"). Nothing deleted. Read it again and propose once more.`

   A row deleted on its own screen while the card was open refuses too (`No meal with id …`), so the
   Coach never mints a receipt for a removal the user made by hand.
5. **The receipt** is the card line the user approved, recorded in `ai_messages.tool_calls`. It is
   unforgeable by prose, and it survives a tool being retired.

## 5. `fields` is the registry's first open schema

Every other `inputSchema` in `src/lib/ai/tools/` ends `additionalProperties: false`. The outer
object of `edit_record` keeps it; **`fields` alone** is a bare `{ type: 'object' }`.

The alternative is 26 domains × ~25 tokens of field vocabulary in a cached prefix with single-digit
headroom. The model learns the vocabulary three cheaper ways, all of them warm: the tool's own
description (one field and its values per domain), `query_records` called with no filter (which
returns each domain's `fields`), and the unknown-field error, which **names the set** it should have
chosen from.

## 6. Prefer the specific tool — enforced in the parser

A domain whose act has a bespoke tool registers no generic path for that act. Every Phase-1 domain
declares `createVia`, and `edit_record` without an `id` refuses naming that tool. The doctrine
bullet in the system prompt is the model's copy of the rule; **the parser is the rule.**

What stays bespoke, permanently: every tool whose input is not a flat patch — the versioned
documents (`update_protocol`, `set_nutrition_targets`), the batches (`adjust_today`,
`complete_grocery_items`), the composites, `set_reminder`'s pinned day, `log_screening_done`'s
roll-forward, and `save_knowledge_entry`, whose `id` rewrites an entry *whole* rather than patching
it.

## 7. Off-limits, permanently

Not registrable, asserted absent by a predicate test (`db/coach-domains.test.mjs` §4): the API key
and model choice; backups; the app lock; the Health sync toggle; **device-ingested rows**
(`wearable_data WHERE source_raw_id IS NOT NULL`, and the `body_metrics` rows the Health upsert
owns) — not the tables, which `log_metric` already writes; **the shipped reference pack**, which is
not a row this registry can address at all, because it lives in `knowledge_chunks WHERE source =
'arc-longevity-v1' AND entry_id IS NULL` and the knowledge domain reads `knowledge_entries`, so a
pack chunk's id is simply an unknown id; hard deletion of memories and knowledge; workout drafts,
the pending-estimate queue, the timezone observer's rows, the conversation store; and any URL fetch.

**Hard deletion of memories and knowledge survived the 2026-09-23 widening on purpose** (§10a),
and is now a `refuse` whose text names the archive and the screen — asserted in
`db/coach-domains.test.mjs` §4d. Both screens do delete permanently; the Coach's removal is the
ARCHIVE (`edit_record { status: "archived" }`), which the user can restore, and a hard delete as
well would be two tools for "forget that", the overlap the fold exists to remove.

**Day modes are not a domain.** They were retired in 0061 and their repository is a read-only shim
over frozen history. Mission rows are not a domain either — they are `adjust_today`'s.

## 8. The fold (Commit A, 2026-09-19)

Six tools retired into `edit_record`, because each executed one `UPDATE … SET status`:

| Retired tool | Now | Card, verbatim |
| --- | --- | --- |
| `complete_reminder` | `reminders` `status: done` | `Mark reminder "X" done` |
| `dismiss_reminder` | `reminders` `status: dismissed` | `Dismiss reminder "X"` |
| `complete_experiment` | `experiments` `status: concluded` + `conclusion` | `Conclude experiment "X"` |
| `abandon_experiment` | `experiments` `status: abandoned` + `reason` | `Abandon experiment "X" — <reason>` |
| `forget` | `memories` `status: archived` | `Forget: "…"` |
| `retire_knowledge_entry` | `knowledge` `status: archived` | `Retire entry "X"` |

**970 tokens out, 216 in.** This is what funds the registry: no ceiling was raised, and the prefix
*shrinks*.

### What it costs, plainly

- **The chip row loses six verbs.** `humanizeToolName` runs on the tool name, so all six read "edit
  record" under a reply. The **receipt** survives for every write since receipts existed, so the
  audit trail still says "Dismiss reminder …".
- **`RETIRED_WRITE_NAMES` is required.** `isWriteTool` answers via `toolByName`, so a persisted row
  naming a retired tool would be classified as a *read* and drop out of the "these changes landed"
  line — in a thread where that line is the only record the change happened. The set is in
  `src/lib/ai/tools/index.ts` and the suite asserts every name in it still answers true.
- **Two behavioural rails left their descriptions.** `complete_reminder`'s recurring rule and
  `abandon_experiment`'s abandon-not-conclude rule existed *only* there. They now ride the read
  payloads that hand out the ids — `list_reminders` and `get_experiments`, each emitted **only when
  it is true of this device** — behind card-time refusals. Result fields are not in the ceiling
  budget; descriptions are. What is lost: the rail is read on the turn it applies rather than held
  in the prefix, and a model that skips the read meets the throw and spends one round trip.
- **It reverses C14's separate-tool call for `retire_knowledge_entry`**, and narrowly. C14's *card*
  argument the fold keeps exactly. C14's *schema* argument was that a `retire: true` flag on
  `save_knowledge_entry` would force `title` and `body` optional, so a create could arrive bodiless.
  `edit_record` is not that flag: it has no create path into the knowledge domain at all.

## 9. `query_records` (Commit B, 2026-09-19) — fifteen domains

| Domain | Read | What it closed |
| --- | --- | --- |
| `meals` | list, by day, items on a single-id call | `get_nutrition_summary` gave totals and the snapshot gave today. "What was in yesterday's lunch" had no answer |
| `food_catalog` | list, `query` searches | a CANNOT line |
| `meal_templates` | list | the same CANNOT line |
| `micronutrients` | **compute**, `id` = a day | the same CANNOT line |
| `water` | list, by day, one row per tap | `get_metric_series water` gave totals only; an entry had no id |
| `captures` | list, by day (`listEntriesOn`, new beside `listTodayEntries`) | the log tools always backdated and nothing could read a past day back |
| `protocol_adherence` | **compute**, `id` = protocol slug, from/to | the Protocols screen's own computation |
| `exercise_stats` | **compute**, `id` = exercise id or name | personal records, e1RM series, recent top sets |
| `exercise_catalog` | list, `query` searches | names resolved inside `log_workout` and nowhere else |
| `saved_workouts` | list, exercises on a single-id call | a CANNOT line; the parked Modes revamp assumes this |
| `protocol_versions` | list, `id` = protocol slug | `get_protocols` returns the LIVE version only |
| `lab_reports` | list | narrowed a CANNOT line to the PDF and the files |
| `knowledge` | list, `query` searches | browse — `search_history` finds, nothing listed |
| `progress_photos` | list, metadata + reading summaries | a CANNOT line (Q4a). **No pixels** |
| `reports` | list | a CANNOT line (Q4a). The list only; generation stays on its screen |

Four coverage lines left `UNCOVERED_DOMAINS` and one narrowed, which is **−40 prompt tokens**, and
one label was added for all fifteen (+12): the keys are already on the wire, in the enum.

**The discovery call.** `query_records { domain }` with no filter returns that domain's `fields`,
whether it is `editable`, which tool creates there, and whether it is `removable`. This is where
the field vocabulary lives instead of the cached prompt: the alternative is 26 domains × ~25 tokens
in a prefix with single-digit headroom.

**The unattended pass does not get it** (`PASS_EXCLUDED_TOOLS`). Haiku's selection over a
fifteen-key enum is unmeasured, a discovery call would spend one of the pass's eight round trips and
re-bill the ~1.4k uncached state block, and the pass is triage over curated reads. The pass prefix is
therefore carries the same eighteen read tools it always did (3,376 tokens of schema). The prefix
itself moves only with the system prompt, which SHRANK: 7,076 on main → 7,027 here, still ~2,900
clear of Haiku's 4,096-token cache floor, which the pass's whole economics depend on.

## 10. The writes (Commit C, 2026-09-19) — twenty-six domains

`edit_record` reaches **18**; `delete_record` reaches **12** (11 until 2026-09-23, when `protocols`
joined it). The two sets are different on purpose.

| Domain | Editable | Removable | Why |
| --- | --- | --- | --- |
| `meals` | name, date, time, notes | hard (was **own**) | macros are read-only: an itemized total is the sum of its items and must not disagree with them |
| `workouts` | kind, date, duration, notes, `away` | hard (was **own**) | `sets` is not a field — `replaceWorkout` deletes and re-inserts them |
| `water` | ml | hard | manual rows only; a device row refuses at resolve |
| `food_catalog` | name, brand, per-100 macros, basis, favourite | hard | `meal_items.food_id` is SET NULL and every item carries its own snapshot |
| `meal_templates` | name, notes | hard | a stamp, never a record of a day |
| `saved_workouts` | name | hard | `workouts.routine_id` is SET NULL |
| `exercise_catalog` | `status: archived` | refuse | `routine_exercises` CASCADES, so archive is the only safe retirement |
| `recipes` | title, servings, notes, favourite | hard | `meals.recipe_id` and `grocery_items.recipe_id` are SET NULL |
| `grocery` | name, qty, `status` (incl. **uncheck**), staple | hard | a working list |
| `screenings` | name, category, notes, next_due · **create** | hard (= untrack) | `interval_months` stays off the Coach — a clinical decision |
| `appointments` | title, provider, when, location, notes, status · **create** | hard | a booking that never happened is not a day |
| `muscle_anchors` | freshness | hard (= clear) | an override of a derived figure |
| `protocols` | name, type, description, active, carry-over, check-off mode, start date | hard (was **refuse**) | `content` is not a field: `update_protocol` takes the complete set |
| `settings` | date of birth, sex, five units, day boundary, goal direction, water target | — | Q3(a). The API key, app lock, Health sync and backups are **not here** |
| reminders · experiments · memories · knowledge | `status` | refuse | the Commit A fold; the status IS the removal |

**`own` WAS the undo, and it is gone** (2026-09-23, §10a). It derived "did this thread's Coach write
it?" from `ai_messages.tool_calls` (`idsWrittenInConversation`, with `conversationId` threaded into
every tool's context for it). Both are deleted rather than left dormant: nothing reads them, and a
revert of the 2026-09-23 commit restores them whole.

**Q2(b) superseded a shipped rule**, and its ADR in `docs/decisions.md` records how far: correction
is not rewriting. Its other half — *deletion is undo* — is itself superseded by the 2026-09-23 ADR.
Mission rows are still `adjust_today`'s alone, and a logged metric or capture is still untouchable —
by *parity*, since no repository function edits or deletes one.

## 10a. Deletion by parity (2026-09-23)

The owner, on a device check that asked the Coach to delete something it had just written and then
something he had logged himself (*the first should work, the second must be refused*):

> *"coach should actually be able to delete both. guardrails of needing approval should be in place
> but the coach should just be intelligent enough to only delete the right things when it is
> supposed to"*

So deletion follows the principle every other act follows: **what a screen can delete, the Coach may
delete, through the function that screen calls, behind the card.** There is no rule about which
rows or when — that is the model's judgment, and the user's Approve. The card is the whole
guardrail, so it is held to four things, each asserted in `db/coach-domains.test.mjs` §4d and §6:

1. **It says exactly what goes** — the row's name, its day, and its figures, from the domain's
   `gone` (`Delete meal "Salmon bowl" — 2026-09-23 12:30 · 700 kcal · P 45g · C 60g · F 20g ·
   2 items · 1 photo`). Its consequence lane says the row is deleted *for good* and that there is no
   undo.
2. **It is re-read past the gate** — values and printed line both (§4). A moved row refuses.
3. **It is never the brief card and never approved on anyone's behalf.** `confirmMeta` is
   `{ kind: 'delete', selfEvident: false }` for every call; with no gate present the service
   declines. One call removes one row — nothing batches a removal into another write's card.
4. **It CASCADES only into the row's own parts** — items, sets, photos, versions — which the card
   counts. Every other reference is SET NULL, walked over every table (so a future CASCADE fails the
   suite).

### The walk — every domain, and every screen delete in `app/`

| Domain | The screen that deletes it | Function | Now | Why |
| --- | --- | --- | --- | --- |
| `meals` | Eat › meal, *Delete this meal* (`meal-detail.tsx`) | `deleteMealWithPhotos` | **allowed** (was own) | the screen's function, not bare `deleteMeal`: the CASCADE takes photo rows and leaves the files |
| `workouts` | Train › session, *Delete session* (`workout-live.tsx`) | `deleteWorkout` | **allowed** (was own) | sets are its own parts; the watch's paired session stays |
| `water` | Water, *Remove* (`water.tsx`); the Log tab's quick-add undo | `removeWaterCapture` (edits: `editWaterCapture`) — the row, then its published sample in Apple Health | allowed | manual rows only — a device row refuses at resolve |
| `protocols` | Protocols › settings, *Delete protocol* (`protocol-settings.tsx`) | `deleteProtocol`, then `rederiveMissionFromToday` | **allowed** (was refuse) | its refusal asked for a screen "that shows what it would take with it"; the card now shows it — versions go, logged days keep their entries, unlinked |
| `meal_templates` | Eat › templates (`meal-templates.tsx`) | `deleteTemplate` | allowed | a stamp, never a day |
| `saved_workouts` | Train › saved workout (`routine-edit.tsx`) | `deleteRoutine` | allowed | sessions keep their sets (SET NULL) |
| `recipes` | Eat › recipe (`recipe-detail.tsx`) | `deleteRecipe` | allowed | cooked meals keep their macros (SET NULL) |
| `grocery` | Grocery, swipe (`grocery.tsx`) | `removeGroceryItem` | allowed | a working list |
| `screenings` | Data › Screenings (`screening-form.tsx`) | `deleteScreening` | allowed | appointments stay (SET NULL) |
| `appointments` | the appointment form (`appointment-form.tsx`) | `deleteAppointment` | allowed | — |
| `muscle_anchors` | Train › muscle freshness (`muscle-freshness.tsx`) | `clearMuscleAnchor` | allowed | a clear of nothing refuses at card time |
| `food_catalog` | **none** — `deleteFood` has no caller in `app/` | `deleteFood` | allowed, **ahead of the screens** | set 2026-09-19, before deletion followed the screens; strands nothing. The owner's call: a screen gains the delete, or the Coach loses it |
| `memories` | Data › Knowledge base › a memory, *Delete* (`coach-memory.tsx`) | `deleteMemory` | **refused — held below parity** | §7: the Coach's removal is the restorable archive; the hard delete stays the owner's |
| `knowledge` | Data › Knowledge base › Archived, *Delete* (`knowledge.tsx`) | `deleteKnowledgeEntry` | **refused — held below parity** | as memories; the screen deletes an archived entry only |
| `progress_photos` | Data › Progress photos › a photo (`progress-photo-detail.tsx`) | `deleteProgressPhotoWithFiles` | **refused — held below parity** | Q4(a) opened these read-only, "no pixels, no writes" |
| `reports` | Data › Reports › a report (`report-view.tsx`) | `deleteReport` | **refused — held below parity** | Q4(a) |
| `captures` | none — the Log tab's rows carry no action, and `logs.ts` has no delete | — | refused, names the Log tab | parity |
| `protocol_versions` | none — Versions restores an old one, never removes it | — | refused | immutable; what a past day was lived under |
| `lab_reports` | none — `deleteLabReport` has no caller | — | refused, names Data › Labs | parity; its results would CASCADE |
| `reminders` | none — dismissal ends one | — | refused → `status: dismissed` | — |
| `experiments` | none — concluded or abandoned | — | refused → `status` | — |
| `exercise_catalog` | none — archive only | — | refused → `status: archived` | `routine_exercises` CASCADE |
| `settings` · the three compute domains | nothing to delete | — | — | no rows |

**Held below parity** means a screen deletes it and an earlier owner call keeps the Coach out; each
is one `remove` entry to open, and the refusal says where the user does it. **Not domains, and
unchanged:** a mission row (`adjust_today`'s, and its settled past stands); a lab result under a
report; an item inside a meal (the meal's item editor); recipe folders; a photo's reading; workout
drafts and the conversation store (§7); the grocery list's batch clears (the Coach removes one line
at a time).

## 11. The card learned two things

`WriteConfirmation` and `PendingWrite` now carry `kind` (`create | edit | delete | status`) and
`selfEvident`. `src/components/coach/pending-write-card.tsx` had held a hardcoded set of four tool
names and a note proposing exactly this fix; the set had to move to stay true, because
`complete_reminder` was one of the four and `edit_record`'s weight depends on the call — `done` on a
one-off is self-evident, `dismissed` is not, and a set of names cannot say that.

`kind: 'delete'` is the first time the card can word a removal as one: its fixed "this is written to
your on-device record" line is false of a delete, and until now there was nothing to branch on.
Since 2026-09-23 that lane reads *"This row is deleted from your on-device record for good. There is
no undo."* — the write copy's "once" was never true of a removal — and the summary above it names
the row's day and figures (§10a).

## 12. Adding a domain

1. Write it in the right area file under `src/lib/ai/domains/`, or a new one.
2. Call the repository function the screen calls. Nothing else.
3. If it holds rows, give it a `remove` — the suite fails a domain that says nothing. `hard` when a
   screen deletes it, with `run` calling that screen's function (and whatever the screen runs next)
   and `gone` printing the row's day and figures; a record of a day is no exception. `refuse` when
   no screen does, with `because` naming where the row lives. Map its table in §4d's CASCADE walk.
4. If it makes an `UNCOVERED_DOMAINS` line false, put that exact line in `retires` and delete it
   from `src/lib/ai/tools/index.ts`. The suite fails if you do one and not the other.
5. Re-measure the two ceilings. A new enum key is ~3 tokens; a new field is 0.

## 13. Revert criteria — what a week of use has to show

The suite pins which tool a scripted turn selects. It cannot say whether a real Sonnet or Opus turn
reaches for `edit_record { status }` as reliably as it reached for `complete_reminder`, whether it
guesses a key the enum does not hold, or whether it over-reaches into edits nobody asked for. So
Phase 1 ships and is used for **one week** before Phase 2 begins, and these are the numbers that
decide it. All of them are readable off the chips and receipts on the phone, or off an export —
`ai_messages.tool_calls` is dumped like every table, and each call carries `input`, `result` and
`isError`.

**Phase 1 (commits A and B), degraded means:**

1. a turn that *describes* a status change and calls nothing — captioned "Nothing saved" by
   `claimsCompletedWrite` — **more than once in the week**;
2. an `edit_record` call rejected for an unknown domain or field (`isError`, the rejection text)
   **more than once in the week**. This is the detector that separates "right tool, wrong key" from
   "called nothing", which is why (1) and (2) are counted separately;
3. `query_records` on a domain that has a bespoke read, **more than occasionally**;
4. a no-filter discovery call **more than once per domain per thread**;
5. `usageCaption` on comparable questions up by **more than the ~4%** the prefix predicts.

Any of (1)–(3) → **revert commit A, and B with it**: 9,233 + 291 = 9,524 would breach the schema
ceiling once the six tools are back. (4) alone → **revert B**; the registry returns to exactly 9,233
and this file records why. No ceiling was raised, so none has to be lowered.

**Phase 2 (commit C), over its own week:**

6. a `delete_record` refused by policy — a `refuse` domain — **more than twice**: the model reaching
   for deletion where no screen offers one (until 2026-09-23 this also counted `own` on a row the
   thread's Coach did not write; that refusal no longer exists);
7. an `edit_record` create refused for a bespoke-create domain **more than twice**: the
   prefer-the-specific-tool doctrine is not holding;
8. a staleness refusal **more than once**;
9. the owner's own signal — **one card he approved that did something the before → after did not
   say**.

Any of (6)–(9) → **revert commit C**. Phase 1 stands, because C adds capability and A/B add none.

**Deletion by parity (2026-09-23), over its own week:**

10. **a deletion the owner did not intend** — a removal he approved and wanted back, or one proposed
    on a row he never asked about. **One is enough.** An edit can be corrected afterwards; a
    deletion cannot, and the phone holds the only copy of the data.

(10) → **revert the 2026-09-23 commit**: deletion returns to undo-only (`own`, and the
`conversationId` it reads, come back with it), and commit C stands. Nothing else has to move — no
migration was involved, and both ceilings were lower after it than before.

**Also unmeasured until a device says:** time to first token with the new prefix; whether a
six-field before → after card is legible in the serif voice at phone width (a Conformed Set judgment
never yet made on hardware); and Haiku's `cache_read_input_tokens` on the unattended pass.
