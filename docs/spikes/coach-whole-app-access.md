# Whole-app read/write access for the Coach

**Status: PROPOSAL** (2026-09-15). Nothing here is built. The owner parked the item on 2026-09-14
with the instruction to note it and check on it later (`docs/backlog-2026-09.md:66`); this is the
audit and plan that note asked for. Every number was measured against `main` at migration head
`0058` (`:72`) by running the ceiling test's own proxies (`db/coach-eval.test.mjs:386-387`) over the
live registry — a scratchpad script, no network, no key, no writes — and by reading
`db/measure-coach-request.mjs`.

**The short form.** A domain registry behind three generic tools, funded inside the existing
ceilings by folding six status-change tools (970 tokens) into one generic edit (203). The costs sit
where they fall: the chip row loses six verbs, two behavioural rails move from tool descriptions to
read payloads, and one shipped rule — logged history is not the Coach's to rewrite — goes to the owner.

**Backlog:** `docs/backlog-2026-09.md`, Parked. It pairs with the parked Modes revamp above it
(`:64`), whose design assumes the Coach can *"adjust mission items, the workout plan, etc. itself"*
— today no tool reaches a saved workout. That entry retires the old Modes system, so `set_mode` is
left alone.

---

## 1. Current state

### 1.1 The registry, measured

`COACH_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]` (`src/lib/ai/tools/index.ts:23`) is 44 tools: 18
reads (`read-tools.ts:2157-2176`) and 26 writes. Two are written and withheld —
`complete_mission_item` and `navigate_to` (`stubs.ts:47-87`) — and `search_knowledge` is
unregistered because the embedder is not installed (`read-tools.ts:2146-2155`;
`coach-eval.test.mjs:765-773`).

The schemas measure **9,236 against a 9,250 ceiling** and the static prompt **3,669 against 3,700**
(`db/coach-eval.test.mjs:814-822`, chars/2.8 and chars/3.6; the assertion counts the *whole* wire
tool, description included); the mean tool is 210. The ledger has drifted from the live number in
three places a new entry must reconcile: C14's NET books "9,223 → 9,218" (`:758`), C13's "9,224 →
9,241" (`:807`) against a measured 9,236, and C13 still names `get_metric_series` at 354 (`:810`)
after C14 trimmed it to 309 (`:741`). The tool ceiling has been raised three times (`:393-401`,
`:403`, `:442-443`), the prompt ceiling twice; since then the rule at `:398-401` — trim duplication,
never raise — has held, the manifest "has been mined twice now" (`:509-510`), and the VOICE section
is the named reserve (`:438-439`).

On the wire, the owner's reported "milk" turn carried a **14.6k cache write**
(`db/measure-coach-request.mjs:7-9`, `:63`) — a device measurement from the 39-tool era (`:828`),
when the proxies read ~8,973 / ~3,499; scaled by that device-to-proxy ratio, today's 44-tool prefix
is **≈15.1k**. Each 1,000 tokens of prefix costs ~$0.004 per cold turn, ~$4.40 a year at three
bursts a day (`PRICE_IN`, `:579`); a per-turn tool subset is ruled out, since every subset is a
different cache entry (`:825-828`).

### 1.2 What the model is told it cannot see

The coverage manifest (`index.ts:243-265`) is derived from `COACH_DOMAINS` (`:114-164`) plus the
hand-maintained `UNCOVERED_DOMAINS` (`:174-211`, "the half that cannot be derived", `:169`). It
prints labels, never tool names — "the schemas are already on the wire" (`:219-221`). Measured as
whole-prompt deltas (the assertion is over the entire prompt, so per-line rounding does not
compose), the nine CANNOT lines are **153 tokens**: food catalog 21 (`:184`) · saved workouts 7
(`:185`) · lab files 14 (`:186`) · photos 18 (`:192`) · appointments 18 (`:193`) · create protocol
or screening 14 (`:194`) · editing-or-deleting-logged 32 (`:202`) · reports 15 (`:209`) · Settings
16 (`:210`). `coverageProblems` (`:273-285`; `db/coach-tools.test.mjs:2583-2586`) checks that
registered tools are classified; nothing guards `UNCOVERED_DOMAINS` except its own rule, that a
line becoming false is the worst thing it can be (`:195-201`).

### 1.3 The rails a write passes through, and one live hole

Each rail is code. **`readOnly` is the pivot**: every write suspends the loop until `confirmWrite`
resolves, and with no gate present every write is declined (`tools/types.ts:36-37`;
`coach-service.ts:175-212`). **The card is one human line built from validated input**, resolving
any id to what it names, and must throw at card time for any knowable failure (`types.ts:39-67`);
one clock serves card and execute (`coach-service.ts:146-167`). **The receipt is minted past
`execute`** (`:220-233`); a throw returns `isError` with no receipt (`:234-236`); the thread prints
receipts, falling back to the tool name only for rows written before receipts existed
(`ai-chat.ts:336-343`), via `isWriteTool` → `toolByName` (`use-coach-chat.ts:103-105`).
**Invitation-only doctrine** governs `adjust_today` and `save_knowledge_entry`
(`system-prompt.ts:109-110`); **judgment stays in the model** (`:114`); `adjust_today` addresses
today only (`write-tools.ts:1260`). **The unattended pass runs `claude-haiku-4-5` with read tools
only** (`coach-pass.ts:188`, `:232-234`). **Provenance is a column** (`0034:22-33`), stamped where
one exists (`write-tools.ts:758`, `:1091`, `:1746`, `:2002`, `:2158`, `:2361`); the plain log tools
stamp `'manual'` through the screens' repositories (`nutrition.ts:44-48`; `logs.ts:103-109`).

Two rails are product decisions, and this plan touches both. **Execution history is not the
Coach's to rewrite**: `adjust_today` refuses to flip a settled mission row — "already completed
today — its record stands; change it on the mission if that's wrong" (`write-tools.ts:1306-1311`)
— and the manifest says the same of logs (`index.ts:202`). **Editing a memory is deliberately not
a Coach tool** — "a model correcting one is `forget` then `remember`" (`coach-memory.ts:148-158`) —
and `retire_knowledge_entry` is deliberately silent about restoring so retiring never reads as
cheap (`write-tools.ts:2377-2379`). §3.4 and Q2 say what happens to each.

**The hole, live today.** `get_protocols` emits `title`, `scheduled_time`, `dose`, `cadence` per
item and nothing else (`read-tools.ts:1493-1499`); `update_protocol` takes the COMPLETE document
and parses `notes: optString(item, 'notes') ?? null` (`write-tools.ts:906`); `notes` is user data
the editor reads and writes (`app/protocol-edit.tsx:139`, `:695`). Every Coach protocol edit
silently wipes every item's notes — the class C10 fixed by hand for `remind`
(`write-tools.ts:867-877`). Phase 0 fixes it, free.

### 1.4 The coverage matrix — all 37 repositories

✓ a registered tool; ◐ partial; ✗ no tool, with the repository function the screens use; "parity"
means the app has no such path either; "internal" means infrastructure, not a user-facing domain,
sealed by §3.5.

| Domain (repository) | Read | Write (create / edit) | Delete |
| --- | --- | --- | --- |
| Today's mission (`mission.ts`) | ✓ `get_today_snapshot` (ids, `read-tools.ts:678-685`) | ◐ `adjust_today`, today only (`write-tools.ts:1260`); settled rows refused (`:1306-1311`) | ✓ tombstone (`mission.ts:399`) |
| Mission history & adherence | ✗ `missionDailySeries` `mission.ts:598`; `protocolAdherence` `protocol-adherence.ts:101` — an aggregate, per-item `itemId` nullable (`:108-110`) | — | — |
| Mission derivation (`mission-generate.ts`) | internal: `generateMissionForDay` `:606`, `rederiveMissionForDay` `:697`, already run by `update_protocol` (`write-tools.ts:1033`) | — | — |
| Meals (`nutrition.ts`) | ◐ totals only (`:69`, `:499`); no items, no past-day list | ◐ `log_meal`, `log_recipe`; no items (`:272`), no edit (`:629`, `:673`, `:400`) | ✗ `deleteMeal` `:696` |
| Food catalog (`foods.ts`) | ✗ `searchFoods` `:114` | ✗ `:32`, `:70`, favourite `:105` | ✗ `:97` |
| Meal templates (`meal-templates.ts`) | ✗ `:112` | ✗ `:55`, `:143`, `:169` | ✗ `:158` |
| Micronutrients | ✗ `dayMicroTotals` `nutrition.ts:801` | — | — |
| Pending estimates (`pending-estimates.ts`) | internal queue (`:96`, `:119`), drained by the app | ✗ | ✗ |
| Goal direction (`user.ts`) | ✗ (the pillar is computed from it, `readiness.ts:925-932`) | ✗ `setGoalDirection` `:248` | — |
| Water (`water.ts`) | ✓ `get_metric_series water` | ◐ `log_metric water` — a manual `wearable_data` row (`logs.ts:103-109`); no edit (`:144`), no target (`user.ts:211`) | ✗ `:171` — manual rows, hard, no FK points at them (`:162-170`) |
| Body metrics (`body.ts`) | ✓ | ◐ `log_metric` (weight, body_fat, waist, hrv, rhr, water — `write-tools.ts:215-219`) | parity |
| Workouts (`exercise.ts`) | ✓ `get_training_summary` | ◐ `log_workout`; no `away`; no edit (`replaceWorkout` `:265` is whole-replace) | ✗ `:300` |
| Per-exercise stats (`training-stats.ts`) | ✗ `personalRecords` `:163`, `e1rmSeries` `:240` — computations returning one object / points, no row ids | — | — |
| Training engine (`training-recommend.ts`) | ✓ `get_training_recommendation` is `buildRecommendation` `:149` | — | — |
| Exercise catalog, anchors (`exercise-catalog.ts`, `muscle-anchors.ts`) | ◐ names resolve in `log_workout` | ✗ `createCustomExercise` `:220`; ✗ `setMuscleAnchor` `:38` | soft only: `archiveExercise` `:274` (`routine_exercises` CASCADE, `0012:54`); ✗ anchors `:51` |
| Saved workouts (`routines.ts`) | ✗ `:82` | ✗ `:37`, `:55` | ✗ `:68` |
| Workout drafts (`workout-drafts.ts`) | internal — "a separate draft store no training query can see" (`backlog:14`; `:38-67`) | ✗ | ✗ |
| Ingested workouts (`workout-ingest.ts`) | ◐ unpaired in the summary | ✗ pairing `:289` — not in any phase | — |
| Symptoms (`symptoms.ts`) | ✓ | ◐ | parity |
| Captures & notes (`logs.ts`) | ◐ today only (`listTodayEntries` `:190`); no by-day read exists | ◐ `log_capture`, `log_note` | parity |
| Protocols (`protocols.ts`) | ◐ `get_protocols`: content and `isActive` (`read-tools.ts:1483`); **not** `startedOn`/`carryOver`/`checkoffMode` (`protocols.ts:378-380`), item `notes`, versions (`:322`), adherence | ◐ `update_protocol`; no create (`:130`), no `updateProtocolMeta` (`:391`), no policy edit (`reviseProtocol` with `content: null`, `:171-172`), no pause (`setActive` `:413`) | ✗ `:490` |
| Day modes (`day-modes.ts`) | ✓ | ✓ `set_mode` — untouched pending the Modes revamp | ✓ |
| Timezone days (`day-meta.ts`) | ✗ (excuses the readiness verdict, `readiness.ts:932`) | internal: `observeTimezone` `:91` is the boot path's | ✗ |
| Experiments (`experiments.ts`) | ✓ | ✓ create / complete (`:148`) / abandon (`:161`) | parity |
| Reminders (`reminders.ts`) | ✓ | ✓ set / complete (`:151`) / dismiss (`:156`) | parity |
| Recipes (`recipes.ts`) | ✓ | ◐ save, log; no edit (`:146`, lines `:314-472`), favourite (`:199`), folders (`:919-1014`) | ✗ `:191` — `meals.recipe_id` SET NULL (`0031:98`) |
| Grocery (`grocery.ts`) | ✓ | ◐ add / check off / add recipe; no uncheck (`:141`), edit (`:288`), staples (`:404`) | ✗ `:343` |
| Screenings (`screenings.ts`) | ✓ | ◐ `log_screening_done` only; cadence kept on the screen (`write-tools.ts:2166-2174`) | ✗ `:140` |
| Appointments | ✓ inside `get_screenings` | ✗ `:186`, `:205`, `:235` | ✗ `:255` |
| Labs (`labs.ts`, `biomarkers.ts`) | ✓ | ✗ manual entry (`log_labs` "planned", `docs/ai-coach.md:174-183`); list `labs.ts:104` | ✗ `:141` — `lab_results` CASCADE (`0001:137`) |
| Wearables (`wearables.ts`) | ✓ | manual rows already written by `log_metric`; device rows (`source_raw_id IS NOT NULL`) are the Health upsert's alone (`:201`) | manual rows only |
| Memories (`coach-memory.ts`) | ✓ | ◐ `remember`, `forget` (soft, `:124`); edit user-only by design (`:148-158`); restore user-only (`:138`) | hard `:178` — "the trash action", user only |
| Knowledge base (`knowledge.ts`) | ◐ keyword via `search_history`; no browse (`:428`) | ✓ save (create + whole rewrite), retire (`:334`); restore user-only (`:351`) | hard `:372` — user only |
| RAG substrate (`rag.ts`) | internal: pack and memory chunks (`:49`, `:80`); the pack is `knowledge_chunks WHERE source = 'arc-longevity-v1' AND entry_id IS NULL` (`knowledge.ts:18-19`; `0038:115-116`) | ✗ | ✗ |
| Conversations & messages (`ai-chat.ts`) | ◐ past turns via `search_history`; no thread list (`:115`, `:147`) | ✗ — the thread is the app's own record (`appendMessage` `:83`) | refuse: the receipts live here (`:316-343`) |
| Progress photos (`progress-photos.ts`) | ✗ owner call 2026-08-12 (`index.ts:187-191`); `:90`, `listPhotoAnalyses` `:350` | ✗ | ✗ |
| Reports (`reports.ts`) | ✗ by design (`index.ts:203-208`); `listReports` `:94` | ✗ | ✗ |
| Profile, units, day boundary (`user.ts`) | ◐ state block | ✗ `:57`, `:330`, `:284` | — |
| App lock, API key, Health sync, backups | ✗ | ✗ (`user.ts:348`, `api-key-store.ts:2-6`, `user.ts:141`, `:173`) | ✗ |

The log tools backdate, but nothing can list, correct or remove a row once written; the largest
read gap is a computation with no rows and no ids, which §3.3 designs for. Three unbuilt tools
(`docs/ai-coach.md:174-183`) stay out: `explain_metric` (`search_history` plus
`get_biomarker_history` until the embedder), `generate_grocery_list` (prose plus `add_grocery_items`
once templates are readable), `search_knowledge` (an on-device model — the one EAS rebuild here).

### 1.5 Where the screens write

No screen runs SQL; every `getDb()` call in `app/` goes through a repository. The only
non-repository writers of user data in `src/lib` are `pass-schedule.ts:62` and `rag/corpus.ts:130`;
`migrate.ts`, `seed.ts:5` and `backup/snapshot.ts:218-222` (`VACUUM INTO`) are infrastructure. So
"parity with the screens" is well-defined: the repository exports are the write surface, and what
they do not offer (an edit to a symptom) the Coach cannot be given either.

---

## 2. The owner's words

> **Whole-app read/write access for the Coach** — *"basically the entire app should be accessible
> for reading and writing for the coach, make a note of this and we will check on it later."*
> (`docs/backlog-2026-09.md:66`)

And C14's version at smaller scale: *"The Coach must read AND write both"* (`:50`). This is broader
than the 2026-08-12 calls withholding photos and reports (Q4), and than the shipped rule that
logged history is corrected on its own screen (Q2).

---

## 3. Proposed design

### 3.1 The principle

> **Parity with the screens, through the repositories, never past them.** A domain the user can
> read on a screen is readable; a change the user can make on a screen is proposable; a deletion
> the user can make on a screen is the Coach's only where it is undo, not history.

The Coach never sees SQL or a table: it sees a *domain* with fields, and the code behind it is the
repository function the screen calls, so the day boundary (`date.ts:168-177`), unit conversion,
tombstones and CHECKs are inherited. Whatever the repository refuses, the tool refuses.

### 3.2 Options, with the accounting

**(a) Generic tools over a domain registry.** `query_records`, `edit_record`, `delete_record`,
fields validated per domain in code, `domain` a real `enum` on each so the model never guesses a
key. Mocked and measured with the test's proxy: `edit_record` over Phase 1's four keys **203**;
`query_records` over 15 keys **291** (13: 285); the Phase 2 `edit_record` over 26 keys **311**;
`delete_record` over 7 keys **160**. Field vocabularies stay out of the prefix: a no-filter
`query_records` returns them, so discovery costs one warm round trip, never a permanent tax.

**(b) Folding the six status-change tools into the generic edit.** Measured as the ceiling counts
them (whole / schema / description): `complete_reminder` 144 / 36 / 86, `dismiss_reminder` 115 / 36
/ 58, `forget` 153 / 36 / 100, `retire_knowledge_entry` 119 / 36 / 59, `complete_experiment` 221 /
105 / 95, `abandon_experiment` 218 / 68 / 128 — **970**. Each executes one `UPDATE … SET status`
(`reminders.ts:151-158`, `experiments.ts:148-170`, `coach-memory.ts:124-134`, `knowledge.ts:334`),
which is what `edit_record { domain, id, fields: { status } }` expresses. **9,236 − 970 + 203 =
8,468**, 8,760 with the read, 9,028 after Phase 2 — 222 under a ceiling that never moves; the
prefix *shrinks*. Kept — this is the funding.

Its costs, plainly. (i) The chip row is `humanizeToolName` over the tool name (`index.ts:53`;
`use-coach-chat.ts:147`, `:302`, `:346`), so six verb phrases become "edit record"; the *receipt*
survives for every write since receipts existed (`ai-chat.ts:341-343`), so the audit trail keeps
"Dismiss reminder …" while the chip loses it. (ii) `isWriteTool` answers via `toolByName`
(`use-coach-chat.ts:103-105`), so rows naming a retired tool would fall out of the receipt line; a
`RETIRED_WRITE_NAMES` set that `isWriteTool` consults fixes it, asserted by test. (iii) **Two of the
six descriptions carry rails that exist nowhere else** — `complete_reminder`'s recurring rule
(`write-tools.ts:779-782`) and `abandon_experiment`'s abandon-not-conclude rule (`:1608-1612`); the
prompt covers concluding (`system-prompt.ts:107`) and nothing else. The 970 is not all duplication;
§3.4 says where the rails go and what they cost, §3.11 prices keeping those two tools. (iv) It
reverses C14's separate-tool call for `retire_knowledge_entry` (`coach-eval.test.mjs:724-730`);
§3.11 gives the reading.

**(c) A bespoke tool per gap, ceiling raised to fit** — ~68 gaps at the mean of 210 is ~14,000
tokens and a registry of ~110, a selection problem the suite cannot measure; rejected. **(d) Tool
tiers by intent** — tools render before the system block (`model-client.ts:258-278`), so a
different list is a different cached prefix (`measure-coach-request.mjs:825-828`); rejected. **(e)
Raise the ceiling and keep the six** — 9,236 + 203 + 291 + 311 + 160 = **9,999** measured, a fourth
raise with (b) measured against it; rejected.

### 3.3 The recommendation

A **domain registry** in `src/lib/ai/domains/`, one file per domain, and three tools over it. Each
entry carries `key` (the enum value the model writes); `read`, either `{ kind: 'list' }` — capped,
ids on every row — or `{ kind: 'compute' }` — one typed object, no ids, `id` and a window required
(adherence, per-exercise stats); `fields`, a map of parsers (`editable`, `requiredOnCreate`,
`dateKind`); `resolve` from id to name; optional `create` (stamps provenance) and `edit`
(read-modify-write, §3.4); `summarize(op, row, patch)` for the card line — today's six status cards
verbatim; **`selfEvident(op, patch, row)`, a function, defaulting false** — the card file's own
fail-closed direction (`pending-write-card.tsx:61-66`): `{ status: 'done' }` on a one-off reminder
is self-evident exactly as `complete_reminder` is today (`:100-105`), `{ status: 'dismissed' }` is
not, because "permanence is exactly the consequence a summary cannot carry on its own" (`:81-83`);
`remove`, one of `refuse | hard | own`; and `retires`, the CANNOT lines the entry makes false.

`COACH_DOMAINS` gains the three tools by joining the existing entries (the fold's four domains keep
their labels at zero cost) plus one entry, "the domains in query_records", so the manifest names the
generic read once and the keys stay where the house rule puts them — on the wire, in the enum
(`index.ts:219-221`). `UNCOVERED_DOMAINS` **stays hand-maintained** — it cannot be derived from what
the Coach *can* reach (`:166-173`) — and the new assertion is that every `retires` line is absent
from it.

- **`query_records`** `{ domain, id?, query?, from?, to?, limit? }` — `domain` an enum over domains
  with **no bespoke read** (15 with Q4(a), 13 without), so the schema steers the model to
  `get_protocols` for protocols; default 10, cap 25 (`read-tools.ts:1882-1893`); no filter also
  returns `fields` and `removable`. A compute domain without `id` errors naming what it needs.
- **`edit_record`** `{ domain, id?, fields }` — `domain` an enum: **four keys in Phase 1**
  (reminders, experiments, memories, knowledge), 26 in Phase 2. With `id` a patch: only the fields
  sent change, and the card prints each as before → after. Without `id` a create (Phase 2 only):
  the domain parser enforces `requiredOnCreate` at card time — as `update_protocol`'s parser
  enforces a non-empty title (`write-tools.ts:897-899`) — and the card prints every field. A status
  patch's companions (`conclusion` for `concluded`, `reason` for `abandoned`) are required in code.
  **`fields` is the registry's first open schema** — every other `inputSchema` ends
  `additionalProperties: false` (32 occurrences in `write-tools.ts`, 19 in `read-tools.ts`); the
  outer object keeps it and `fields` alone is `{ type: 'object' }`. The model learns the vocabulary
  from the Phase 1 description (the one field and its values per domain, ~40 of the 203), from
  `query_records`' `fields`, and from the unknown-field error naming the set.
- **`delete_record`** `{ domain, id }` — separate because a removal must never be a *value* the
  model can set in passing (the flag objection of `coach-eval.test.mjs:724-730` applied to
  deletion), because its enum is the smaller set of removable domains so the schema refuses the
  rest at zero round trips, and because its chip and receipt fallback read "delete record".

**Prefer the specific tool, enforced in code.** A domain whose act has a bespoke tool registers no
generic path for that act: no `create` on meals, workouts, recipes, protocols, reminders,
experiments, memories, knowledge, grocery or screenings (`edit_record` without `id` errors "use
log_meal"), no `content` field on protocols, no mission domain at all (it is `adjust_today`'s). The
doctrine sentence in §3.4 is the model's copy; the parser is the rule. What stays bespoke: every
tool whose input is not a flat patch — the versioned documents, the batches
(`complete_grocery_items`, `adjust_today`), the composites, `set_reminder`'s pinned day,
`log_screening_done`'s roll-forward.

### 3.4 The generic write path, rail by rail

**Edit is read-modify-write, always.** The entry loads the row and its children, applies the patch,
and calls the repository with the complete set; a field the patch omits is preserved, never
cleared. `replaceWorkout` deletes every set and re-inserts the argument (`exercise.ts:288-289`), so
a literal patch omitting `sets` wipes the session behind a card that would not say so — the C10
class (`write-tools.ts:867-877`, `exercise.ts:260-263`). The protocol domain's `edit` is
`updateProtocolMeta` (`protocols.ts:391`), `setActive` (`:413`) and `reviseProtocol` with `content:
null` (`:171-172`); **`content` is excluded**.

**The card shows before → after, resolved from the row, and carries weight and verb.** A bare id
never reaches the user (`types.ts:39-42`); a non-editable field or future `past` date throws at
card time (`:58-61`, `:189-204`). `PendingWrite` is `{ id, tool, summary }`
(`src/types/coach.ts:51-61`), the brief/full split is a `Set` of four tool names
(`pending-write-card.tsx:100-110`), and the fixed "On approve" line (`:142-144`) is false for a
deletion; so `WriteConfirmation` and `PendingWrite` gain `kind: 'create' | 'edit' | 'delete' |
'status'` and `selfEvident` (the card's own proposal, `:85-98`), threaded through
`coach-service.ts:186` and `use-coach-chat.ts`, and `ConsequenceLanes` words a delete as removal.

**Staleness between card and execute, and what the user sees.** The card is built before `await
options.confirmWrite` (`coach-service.ts:178-186`) and the row can move in that window — a Health
sync, the pending-estimate drain (`pending-estimates.ts:96-125`), a carry-over rederive. The shared
`context` (`:167`) gains a slot the card sets (`context.card = { before }`); `execute` re-reads the
row and refuses if any field the card printed as "was X" no longer reads X. The refusal is a thrown
error, so no receipt is minted (`:234-236`), and its text is specified: *"kcal changed while the
card was open (was 700, now 640). Nothing written. Read it again and propose once more."* — the
model re-proposes once with a fresh card; the thread shows the `edit_record` chip with no receipt
for that call and, if the re-proposal lands, one receipt. Test #6 asserts that end state.

**Provenance.** A create stamps the column where one exists — `foods.source = 'ai'` (`0014:65`),
`exercises.source = 'ai'` (`0056:69`), recipes `'ai'`, grocery `'coach'` — asserted against `PRAGMA
table_info`. An edit has no column anywhere; the receipt in `ai_messages.tool_calls` is the record.

**The two rails leave the descriptions and ride the payloads.** The recurring rule ("recurring
reminders cannot be completed — doing a recurring one today needs no write at all; use
dismiss_reminder only to END it", `write-tools.ts:779-782`) and the abandon rule ("use this INSTEAD
of concluding it: a verdict with no adherence behind it is worse than no verdict", `:1608-1612`)
cannot sit in a generic tool's description without making it domain prose, and the prompt has no
room for them (§3.7). They go where the ledger already puts a conditional fact — emitted by
`execute` "in the one case where it is true" (`coach-eval.test.mjs:735-740`, the `get_screenings`
precedent; "result fields are not in this budget", `:708-709`): `list_reminders`
(`read-tools.ts:1419-1431`, which already returns `repeat`) gains one `note` line, "a recurring
reminder is never completed; dismiss only to end it" (27 uncached tokens per call), and
`get_experiments` (`:1560-1593`) gains "an experiment with no adherence behind it is abandoned (with
a reason), never concluded" (35). Both reads precede any status write, since that is where the id
comes from. The card-time throw is the belt: `{ status: 'done' }` on a `repeat !== 'once'` reminder
throws at `summarize`, before an Approve tap is spent (`write-tools.ts:796-800`'s rule, moved into
the domain). What is lost against today: the rail is read on the turn it applies rather than held
in the prefix; a model that skips the read meets the throw and costs one round trip.

**Invitation only.** One doctrine bullet replacing the clauses stating the rule today
(`system-prompt.ts:109`, `:110`) and the two tool names the fold retires (`:107`
`complete_experiment`, `:110` `forget`): *INVITATION ONLY. adjust_today, save_knowledge_entry,
edit_record and delete_record act on what the user asked for in THIS thread — never to tidy, never
to file away your own output. Say the before → after first (a knowledge entry in full, so they
approve text and not a title). Prefer the specific tool; edit_record only where none fits.* The
bullet measures 94; the whole-prompt delta, with `:107` reading "then conclude it (edit_record,
status concluded, with the verdict)" and `:110` "retire a stale fact by id (edit_record, status
archived)", is **+27**.

**Restore stays the user's.** `restoreMemory` is "an undo for a forget the user regrets"
(`coach-memory.ts:138`) and `retire_knowledge_entry` hides restoring on purpose
(`write-tools.ts:2377-2379`); the memories and knowledge domains accept `status: 'archived'` only,
and memory edit stays `forget` then `remember` (`coach-memory.ts:148-158`).

**Deletion is undo, not history — row-scoped, not table-scoped.** Soft retirement is never a
`delete_record` mode: it is `edit_record { status }`, one tool per act. `remove` is `refuse` on
every domain that is a record of a day (meals, workouts, captures, body metrics, symptoms, lab
reports and results, protocol versions, conversations), the refusal naming the screen; mission rows
are `adjust_today`'s to tombstone (`mission.ts:399`). `hard` only for objects that are not a day:
recipes, foods, templates, routines, appointments, muscle anchors, and **manual water rows** —
`wearable_data WHERE source_raw_id IS NULL`, the predicate `water.ts:148-152` already uses. `own` is
Q2(b): a logged meal, workout or capture deletable only when **this thread's Coach wrote it** — the
tool results carry the new id (`write-tools.ts:332`, `:509`) and the thread persists them, so it
derives with no migration. A hard delete must not strand history (CLAUDE.md §9): recipes → `meals`
SET NULL (`0031:98`), `grocery_items` SET NULL (`0032:41`); foods → `meal_items` (`0014:86`),
`recipe_ingredients` (`0031:78`), template items (`0018:42`), all SET NULL; routines →
`workouts.routine_id` SET NULL (`0013:28`); screenings → `appointments` SET NULL (`0007:86`).
Exercises cascade into `routine_exercises` (`0012:54`), hence archive only; `lab_reports` cascade
into `lab_results` (`0001:137`), hence `refuse`. The export enumerates `sqlite_master` and dumps
every table (`db/export.test.mjs:72-83`, `:98-110`; `serializer.ts:185`) and the ARCB1 snapshot is
`VACUUM INTO` (`snapshot.ts:218-222`) — both the file at a moment, so a Coach hard delete leaves
them exactly as a screen delete does.

**The day boundary.** Every date field declares `dateKind` and is parsed against `context.now`; a
dateless create lands on `todayISODate(context.now)` as the log tools do (`write-tools.ts:142-145`).

**The pass.** `query_records` is **excluded** from the Haiku pass in Phase 1 (a filter beside
`coach-pass.ts:234`, asserted by test): Haiku's selection over a 15-key enum is unmeasured, a
discovery call spends one of eight round trips (`model-client.ts:87`) and re-bills the ~1.4k
uncached context block (`turn-context.ts:39-44`), and the pass is triage over curated reads. Its
prefix is 7,053 today (3,384 + 3,669) and **7,023 after Phase 1 with Q4(a), 7,055 without**, above
the 4,096 floor (`coach-eval.test.mjs:863-872`). The writes cannot join it (`readOnly`).

### 3.5 Off-limits, permanently

Not registrable, asserted absent by a row-predicate test: the API key and model choice
(`api-key-store.ts`); backups (`user.ts:173`, `src/lib/backup/*`); the app lock (`user.ts:348`); the
Health sync toggle (`user.ts:141`, `wearables.ts:632-758`); **device-ingested rows** — `wearable_data
WHERE source_raw_id IS NOT NULL` and the `body_metrics` rows the Health upsert owns
(`wearables.ts:201`, `body.ts:233`) — not the tables, which `log_metric` already writes; **the
shipped pack**, which is not a row the knowledge domain can address: it lives in `knowledge_chunks
WHERE source = 'arc-longevity-v1' AND entry_id IS NULL` (`knowledge.ts:18-19`; `0038:115-116`) and
the domain reads and writes `knowledge_entries` only, so a pack chunk's id is an unknown id there;
hard deletion of memories and knowledge (`coach-memory.ts:178`, `knowledge.ts:372`); workout drafts,
the pending-estimate queue, the timezone observer's rows (`day-meta.ts:91`), the conversation store
(`ai-chat.ts`); any URL fetch (`system-prompt.ts:113`). Photos and reports are Q4, not this list.

### 3.6 Data model and migration impact

**None for Phases 0–2.** Every read and write is an existing repository function over existing
columns; the own-write undo derives from `ai_messages.tool_calls`; a by-day read for captures is a
new function beside `listTodayEntries` (`logs.ts:190`), not a schema change. `0059` stays free.
**No native module; no EAS rebuild.** Stated as a position, not asked: an edit leaves a receipt and
a moved `updated_at`, and nothing on the row says who changed it; v1 accepts that. An `edit_log`
written by the Coach *and* the screens' edit paths — the 0034 rule applied to edits — is its own
spike, numbered at landing and never below main's head then. Say so if row authorship matters.

### 3.7 Coach impact, with the token accounting

Measured with the ceiling test's proxies from **9,236 / 3,669**; every prompt figure is a
whole-prompt delta, not a sum of lines.

| Phase | Schema | Prompt | Standing |
| --- | --- | --- | --- |
| 0 — payload | 0 (`:708-709`) | 0 cached; +8 uncached (goal-direction state line) | 9,236 / 3,669 |
| 1A — the fold, `edit_record` (4 keys) | −970 +203 = **−767** | doctrine **+27** | 8,468 / 3,696 |
| 1B — `query_records` (13 keys), no Q4 | **+285** | CANNOT −28 (food catalog, saved workouts), lab line narrows −7, label +10 → **−25** | **8,753 / 3,671** |
| 1B with Q4(a): 15 keys | +6 more | −32 more | **8,760 / 3,639** |
| 2 — `edit_record` 26 keys, `delete_record` | −203 +311 +160 = **+268** | appointments −18, create narrows −9, Settings narrows −6, labels +25: **−8** with Q2(b) (the logged line narrows, same length); −6 with Q2(a); −38 with Q2(c) | **9,028 / 3,631** |
| 3 — `create` on `update_protocol` | +~40 | −5 | ~9,070 / ~3,626 |

The ceilings never move. The tightest point is the end of Phase 1 without Q4(a): 3,671, **29
tokens** of headroom, and Commit A alone stands at 3,696 for the hours between the two commits —
which is why A and B land the same day. If the doctrine bullet lands over 94, the reserve is the
VOICE section (`:438-439`), not the manifest. The two payload notes add 27 and 35 uncached tokens to
the two reads that carry them, per call. The wire prefix goes ≈15.1k → ≈14.5k after Phase 1 and
≈14.8k after Phase 2, re-derived by the ratio in §1.1. Each phase adds one accounting entry to §6's
block; the first restates the measured total (9,236) and names `:807` as the entry it supersedes.

### 3.8 Tests that would pin it

Headless, `node:sqlite`. A new `db/coach-domains.test.mjs`; new sections in
`db/coach-tools.test.mjs` and `db/coach-eval.test.mjs`.

1. **Registry shape and seals.** Every domain has `key`, `read`, `resolve`, `summarize`, `remove`;
   every `create` stamps its provenance column (checked against `PRAGMA table_info`); nothing
   touches a row matching the §3.5 predicates (run against a seeded ingested row); for every `hard`
   domain, `PRAGMA foreign_key_list` shows no CASCADE from a log table; a seeded pack chunk's id is
   an unknown id to `edit_record { domain: 'knowledge' }`.
2. **Manifest agreement.** Every `retires` line is absent from `UNCOVERED_DOMAINS`;
   `coverageProblems()` is empty; every enum value is a registered key and vice versa.
3. **`query_records`**: `list` domains — ≤ limit, ids on every row, windows respect the logical
   day; `compute` domains — one typed object, `id` required, no `limit`; unknown domain errors with
   the set; no filter returns `fields`.
4. **Read-modify-write.** Patch one field on each domain with children; children byte-identical
   after; `content` on a protocol edit rejected; `edit_record` without `id` on a bespoke-create
   domain rejected naming the tool.
5. **The card**: before → after per changed field, resolved from the row; a create prints every
   field; non-editable field and future `past` date throw at card time; `kind` and `selfEvident`
   reach `PendingWrite`; the delete lane text differs.
6. **Staleness**: a fake `confirmWrite` mutates the row before resolving `true` — `execute` throws
   the specified text, the call has `isError` and no receipt, `landedWriteReceipts` yields nothing
   for it, and a scripted re-proposal renders a card reading "was 640".
7. **The fold is invisible on the card**: (a) the six summary lines render byte-identically to
   today's; (b) `selfEvident` is true for `{ status: 'done' }` on a one-off reminder and false for
   `'dismissed'`, `'archived'`, `'concluded'`, `'abandoned'`; (c) `{ status: 'done' }` on a
   recurring reminder throws at card time; (d) the two payload notes are present.
8. **Retired names**: `isWriteTool` is true for every `RETIRED_WRITE_NAMES` entry; a stored
   `complete_reminder` call still yields its receipt.
9. **Golden transcripts**: "mark the dentist reminder done" → `edit_record` `status: 'done'`;
   "we're done with the daily stretch reminder" → `'dismissed'`; "forget that I don't tolerate
   magnesium citrate" → exactly one call, `edit_record { memories, status: 'archived' }`; "I
   stopped the magnesium trial last week" → `'abandoned'` with a reason; "add magnesium to the
   evening stack" → `update_protocol`; Phase 2: "change yesterday's lunch to 620 kcal" →
   `edit_record`, not `log_meal`.
10. **Ceilings and floor**: `< 9250`, `< 3700`, pass prefix > 4,096 with the entry;
    `humanizeToolName` injective over the new registry; the pass sends neither write and not
    `query_records`.
11. **`update_protocol` preserves notes**: a get → update round trip omitting `notes` keeps them; an
    explicit `notes: null` clears them.

### 3.9 Phases

**Phase 0 — see what is already there** (half a day, no schema, no prompt). `get_protocols` gains
`startedOn`, `carryOver`, `checkoffMode` (already on `listProtocols`), per-item **`notes`**, and the
live version's adherence; `update_protocol` inherits `notes` by item id when the key is absent —
decided on `'notes' in item`, since `optString` returns `undefined` for absent and empty alike
(`types.ts:99-105`) — the `remind` precedent. `get_today_snapshot` gains `goalDirection` and
`waterTarget`; the state block a goal-direction line. Docs: `docs/ai-coach.md` §2 rows for both.

**Phase 1 — the registry, the fold, the read** (two to three days; **two commits the same day: B
reverts alone, A takes B with it** — the arithmetic in §3.10). Commit A: the registry type,
`edit_record` with a four-key enum, the six status tools retired into it, the two payload notes,
`RETIRED_WRITE_NAMES`, the card's `kind`/`selfEvident`, the doctrine edit — no new capability, the
old six in the new shape, which is what the device week measures. Commit B: `query_records` over 13
read domains — meals by day with items, foods, templates, micronutrients, water entries, captures by
day, adherence (compute), per-exercise stats (compute), exercise catalog, saved workouts, protocol
versions, lab report list, knowledge browse — plus, with Q4(a), photo metadata with stored readings
and the reports list; excluded from the pass. Day modes are **not** registered: the parked Modes
revamp retires them (`backlog-2026-09.md:64`). Docs: `docs/ai-coach.md` §2 (the counts, stale at
"43" in both `:433` and `:450` against a measured 44; the duplicated §2d block `:142-155`; a new §2g),
the ceiling entry (§3.7), `CLAUDE.md` §6, and a new `docs/coach-domains.md`.

**Phase 2 — the writes** (three to four days, mostly cards; one commit C), after the device week
and after Q2. `delete_record`, and `edit_record` over: meals (name, time, macros, items), workouts
(kind, duration, notes, `away`, sets), captures, water entries, foods, templates, routines, custom
exercises (incl. `status: 'archived'`), muscle anchors, protocol identity and policy (never
`content`), recipes and lines, grocery (uncheck, edit, staples), screenings (per Q5), appointments,
and per Q3 profile, units, day boundary, goal direction, water target. The shipped "its record
stands" prose in `adjust_today` (`write-tools.ts:1311`) stays true — mission rows are not an
`edit_record` domain — and the CANNOT line at `index.ts:202` is rewritten to whatever Q2 leaves
true. Docs: the same three plus an ADR in `docs/decisions.md` recording how far the 2026-09-14
direction supersedes the logged-history rule.

**Phase 3 — what a generic path serves badly**, as separate items: a protocol from scratch (an
optional `create: { name, type }` on `update_protocol`, ~40 tokens); `log_labs` (dedupe rules are
the open design); the `edit_log` spike; `navigate_to`, still waiting on a seam.

### 3.10 What only a device can settle, and the exit criteria

The suite pins which tool a scripted turn selects; it cannot say whether a real Sonnet or Opus turn
reaches for `edit_record { status }` as reliably as it reached for `complete_reminder`, whether it
guesses a key the enum does not hold, or whether it over-reaches into edits nobody asked for. So
Phase 1 ships and the owner uses it for **one week** before Phase 2 begins.

**Phase 1, degraded means** — read off the chips and receipts on the phone or off an export
(`ai_messages.tool_calls` is dumped like every table, `db/export.test.mjs:72-83`; each call carries
`input`, `result` and `isError`, `src/lib/ai/types.ts:41-51`): (1) a turn that *describes* a status
change and calls nothing — captioned "Nothing saved" by `claimsCompletedWrite`
(`write-claim.ts:112-131`) — more than once in the week; (2) an `edit_record` call rejected for an
unknown domain or field (`isError`, the rejection text) more than once in the week — the detector
that separates "right tool, wrong key" from "called nothing", which (1) and (2) name separately;
(3) `query_records` on a domain with a bespoke read more than occasionally; (4) a discovery call
more than once per domain per thread; (5) `usageCaption` on comparable questions up by more than
the ~4% the prefix predicts. Any of (1)–(3) → **revert commit A, and B with it**: 9,236 + 291 =
9,527 would breach the ceiling once the six are back; (4) alone → revert B; the registry returns to
exactly 9,236 and this file records why. No ceiling was raised, so none is lowered.

**Phase 2, degraded means**, over its own week: (6) a `delete_record` refused by policy (a `refuse`
domain, or `own` on a row the Coach did not write) more than twice — the model reaching for
deletion; (7) an `edit_record` create refused for a bespoke-create domain more than twice — the
doctrine is not holding; (8) a staleness refusal more than once; (9) the owner's own signal, one
card he approved that did something the before → after did not say. Any of (6)–(9) → **revert
commit C**: the registry returns to Phase 1's 8,760 and the prompt to 3,639; Phase 1 stands, since
C adds capability and A/B add none.

Also unmeasured until then: time to first token with the new prefix; whether a six-field before →
after card is legible in the serif voice at phone width (a Conformed Set judgment never made on
hardware); Haiku's floor on device (`cache_read_input_tokens`).

### 3.11 Considered and rejected

**"The `forget`/`remember` separateness principle forbids the fold."** The sentence at
`write-tools.ts:2265-2268` — "taking something out of the base is not a smaller version of putting
something in it, and it deserves its own card" — is an argument about the *card*, and the fold
keeps it: `summarize` prints "Retire knowledge entry …" verbatim and `selfEvident` is false for it,
so the user sees the same card with the same lanes; only the tool name beneath changes. The schema
half of the argument (`:2258-2263`; `coach-eval.test.mjs:724-730` — a flag would make body/title
optional) is about a create arriving without a body, and §3.3 answers it in the parser:
`requiredOnCreate` is enforced at card time, and Phase 1 has no create path at all. That is also
why `save_knowledge_entry` is *not* a precedent for a patch: its `id` rewrites the entry whole
(`:2283-2286`), the opposite shape, and it stays bespoke for exactly that reason.

**"Keep `complete_reminder` and `abandon_experiment` bespoke; fold only the four rail-free
tools."** Measured: 9,236 − 609 + 203 = 8,830 after A, 9,122 with the read, and **9,390 after Phase
2 — a breach** needing ~140 of further trims the ledger says are not cheap (`:807-813`). It also
leaves two tools in the reminders domain split by status value, and two in experiments — the
overlap §3.3 otherwise forbids. Offered as Q1(b) because it is a real trade, not recommended.

**"The manifest is closed as a funding source (`:509-510`)."** Partly. That line closes *mining the
manifest's wording*, not a CANNOT line leaving because its claim became false — the list's own rule
(`index.ts:195-201`), and what C14 booked at `:759-763`. Phase 1 recovers 28 that way and spends 10
on one label; the doctrine is funded by the clauses it replaces.

**"Ship `query_records` alone for a week before any write."** 9,236 + 291 = 9,527 breaches the
ceiling, so the read cannot ship without the fold or a raise. The fold is a write-*shape* change
with no new capability — the safer thing to test first — and the device week is built around it.

**"Memories and knowledge under a `delete_record` soft mode."** Two tools for one act.
`delete_record` has no soft mode; archiving is a status patch, and the golden transcript in §3.8 #9
asserts that "forget that …" selects one tool.

---

## 4. Alternatives considered

(a)–(e) are priced in §3.2. Three more were considered and rejected: a `run_query` / raw SQL tool,
which bypasses the repositories and no card can say what it will do; field schemas in the cached
prompt or the uncached state block, 26 domains × ~25 tokens = ~650 in a prompt with 31 of headroom,
worse in the state block billed on every round trip (`turn-context.ts:39-44`); and the two rails
kept in the prompt, +46 on a prompt with 29 of headroom at Phase 1's tightest point (§3.7), against
the ledger's own payload precedent (`:735-740`). Gating reads too stays the owner's open question
(`docs/ai-coach.md:285`) and is not taken here.

---

## 5. Effort

| Piece | Size |
| --- | --- |
| Phase 0 payload fields, `notes` inheritance, state line, tests | half a day |
| Registry type, `edit_record` (4 keys), the fold with six cards verbatim, payload notes, `RETIRED_WRITE_NAMES`, card `kind`/`selfEvident` through `types/coach.ts` · `coach-service.ts` · `use-coach-chat.ts` · the card, doctrine, ceiling entry | two days |
| `query_records`, 13–15 read entries (two `compute`, one new by-day read in `logs.ts`) | one day |
| `edit_record` wide + `delete_record`: parsers, read-modify-write, cards for ~22 domains, staleness slot | three to four days |
| Golden transcripts, the eleven tests, three docs + the ADR | one day |
| **Total, Phases 0–2** | **≈ seven to eight days**, with a device week between 1 and 2 |
| Phase 3 | separate items; `create` on `update_protocol` half a day, `log_labs` unsized |

---

## 6. Questions for the owner

**1. Funding.** The generic path costs ~760 tokens across its phases; the budget has 14.

- (a) **(Recommended)** hold 9,250: fold the six status tools into `edit_record` — cards identical,
  receipts keep their verbs, the chip row reads "edit record" for all six, and the two rails their
  descriptions carried move to the `list_reminders` / `get_experiments` results behind a card-time
  refusal;
- (b) fold only the four rail-free tools and keep `complete_reminder` and `abandon_experiment` —
  Phase 1 fits, Phase 2 breaches (9,390) and needs ~140 of trims the ledger says are not cheap;
- (c) keep the six and raise the ceiling a fourth time, to 10,000.

**2. A logged meal, workout, metric or capture.** Today the rule is that the Coach never rewrites
logged history (`write-tools.ts:1306-1311`; `index.ts:202`) and the user corrects it on the screen.

- (a) keep the rule — the Coach neither edits nor deletes a logged row;
- (b) **(Recommended)** edit any logged row behind the before → after card; delete only a row this
  conversation's Coach wrote, as undo;
- (c) edit and delete anything the screens allow, behind the card.

**3. Settings within reach.** Profile (date of birth, sex), units, the day boundary, goal direction
and the water target — one repository call each.

- (a) **(Recommended)** all five, gated like any write;
- (b) goal direction and the water target only;
- (c) none; Settings stays on the CANNOT list.

**4. Progress photos and reports.** The 2026-08-12 photo call was a prefix-cost argument against a
bespoke tool (`index.ts:187-191`); a registry key costs ~3 tokens, and the stored readings' text is
what you would ask about. Reports' "revisit if transcripts show" (`:208`) is narrower than your
direction.

- (a) **(Recommended)** both as read-only domains — photo dates, poses and reading text; the
  reports list — no pixels, no writes;
- (b) photos only;
- (c) both stay withheld.

**5. Screenings.** The 2026-08-12 call keeps a screening's cadence off the Coach as a clinical
decision (`write-tools.ts:2166-2174`).

- (a) **(Recommended)** add, rename, untrack and log, editing everything but `interval_months`;
- (b) everything including cadence, the card naming the next-due consequence;
- (c) as today — log-done only.
