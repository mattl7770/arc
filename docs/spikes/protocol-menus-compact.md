> **PLAN — not built (written and fact-checked 2026-09-23).** The owner's two protocol-menu notes; options A/B/C, recommendation C. Phase 0 (three mission-layer defects) is BUILT and merged 2026-09-23; the rest waits on the owner's answers. The owner's answers are collected on the round-two decisions page; this file is the plan of record until they arrive.

# Compacting the protocol editing surfaces

**Status: PROPOSAL.** Written 2026-09-23.

Read on `main` at `f6ca05b`. `main` moved to `70557b0` during the read, when the iOS time wheel merged. That merge changed only import lines in `app/protocol-edit.tsx` and `app/protocol-item.tsx`, so every citation there below line 24 still holds. It also kept `TimeControl`'s props: `time`, `remind`, `onChange`, `itemLabel`, `defaultOpen`. Nothing in this plan depends on the old time chips. Test line numbers were re-checked on `70557b0`.

**Expected migration: none — confirmed in §8.**

Paths are relative to `C:\Users\timmy\Desktop\arc`.

**The owner's words.**
- *"this is ok but theres like so many protocol editing menus now, i think we should compact"*. This was written on the device after using the protocol re-cut that shipped 2026-09-19, and is recorded at `docs/project-status.md:21`.
- *"Having two settings menus for protocols is confusing"*. This is from his round-2 list, 2026-09-23. Resolving it is a **required outcome of every option** (R1 in §2).

## 0. The answer on one screen

- **Inventory.** There are 7 surfaces on the protocol path, and 3 of them are forms that write the protocol. The protocol page opens 4 of them.
- **Overlaps.** Once a protocol exists, 8 facts are editable in two places. At creation, 3 more are asked twice. Three verbs look alike but write different things, and one of those is a bug.
- **The two settings menus** are *Settings* (`app/protocol-settings.tsx`) and *Edit* (`app/protocol-edit.tsx`). They are two protocol-wide forms opened from the same page. The split between them follows how the data is stored, which the owner never sees, and both carry *Phase 1 starts*.
- **Options.**
  - (A) One editor for everything.
  - (B) The protocol page becomes the editor.
  - (C) Two scopes: a mission row opens the item itself, and one protocol form replaces Settings and Edit.
- **Recommendation: C.**

  | | Now | C |
  |---|---|---|
  | Surfaces | 7 | 5 |
  | Settings menus | 2 | 1 |
  | Dose change from Home | 4 taps, 2 screens | 3 taps, 1 screen |
  | Pause | 5 taps | 4 taps |

- **Three defects found while reading** (§1.4) should land first.

## 1. Inventory

### 1.1 The surfaces

Tap counts start from Home.

| # | Surface | File | How you reach it (taps) | What it can change |
|---|---|---|---|---|
| 1 | Hub | `app/protocols.tsx` | `PROTOCOLS ›` under the mission (1; `app/(tabs)/index.tsx:164-181`). The empty-day action (1; `src/components/home/mission-empty.tsx:100-129`). Data › Protocols (2; `app/(tabs)/data.tsx:284`). The Mission record (3; `app/mission-history.tsx:664`, `:677`). | Nothing itself. *New protocol* opens #3 in create mode (`:194-201`). The empty state seeds the Coach (`:223-237`). |
| 2 | Protocol page (detail) | `app/protocol-detail.tsx` | A hub row (2). The item sheet's *Open ‹protocol›* (2; `app/mission-item.tsx:314-321`). Mission record › Where it's failing (3; `app/mission-history.tsx:502`). | Nothing itself. It has four doors. *Settings* in the header (`:123-136`) opens #5. Each Now row (`:207-256`) opens #4, and so does *Add an item*, **which is drawn only when the live phase has no items** (`:261-272`). *Edit* (`:403-413`) opens #3. *Version history* (`:416-434`) opens #6. |
| 3 | Full editor | `app/protocol-edit.tsx` | Create: hub › *New protocol* (2). Edit: page › *Edit*, at the foot (3, plus a scroll). | **Create:** name, description, type (`:484-521`), then phases, items and *Phase 1 starts*. **Edit — structure only since 2026-09-19:** phases: name, length, add, remove and order (`:540-573`, `:639-646`). Items: title (`:580`), dose (`:607`), time and reminder (`:614`), cadence (`:620`), order within the phase (`:587`), add (`:628`), remove (`:593`). Also *Phase 1 starts* (`:651-666`) and the change note (`:675-689`). The why-line is carried through unseen (`:130`). Saves through `addVersion` and `setStartedOn` (`:413-425`), from the document as it was when the form opened. |
| 4 | Item editor | `app/protocol-item.tsx` | Item sheet › *Edit this item* (2). Page › a Now row (3). Page › *Add an item* (3; empty phase only). | One item: title, dose and why-line (`:262-293`); time and reminder, with the wheel open on arrival (`:295-304`); cadence (`:306-314`); which phase, where a move appends to the end of the new phase (`:316-335`); removal from the protocol (`:349-357`). Re-reads the live version at save and writes `addVersion` with an automatic note (`:177-222`). |
| 5 | Settings | `app/protocol-settings.tsx` | Page › *Settings* (3). Item sheet › *Open* › *Settings* (3). | Name, description, type (`:207-249`); Active/Paused (`:251-268`); *Phase 1 starts* (`:273-288`); *If you miss it* (`:293-314`); *When you check it off* (`:316-336`); Delete (`:349-355`). Saves through `reviseProtocol` with `content: null` (`:131-146`), writing all four identity fields from the values the form opened with. |
| 6 | Version history | `app/protocol-versions.tsx` | Page › *Version history* (3, plus a scroll). | Restore, which writes a new version (`:157-178`). |
| 7 | Item sheet | `app/mission-item.tsx` | The mission row's chevron (1; `app/(tabs)/index.tsx:334`). | **Today's row only:** Skip today (a carried row goes through `skipCarried`; `:181-192`), Move to … (`:194-199`, `:272-284`), Remove from today (`:202-209`), Unsnooze, Put back, Mark not done. Doors to #4 and #2 (`:295-325`). |
| — | Plan | `app/mission-day.tsx` | `PLAN ›` (1). | Ticks only. Its rows draw no chevron (`:283-288`). Out of scope and unchanged by every option. |
| — | Hero card and mission row | `src/components/home/hero-card.tsx`, `src/components/home/mission-item.tsx` | Home itself (0). | Today's row: Done, Snooze, Skip. Tapping the row toggles it. |
| C1 | Coach `update_protocol` | `src/lib/ai/tools/write-tools.ts:1014-1153` | Coach tab | The whole document: phases, and each item's title, time, dose, why-line and cadence. Can create a protocol. The reminder is inherited and never set. Re-derives today. |
| C2 | Coach `edit_record` (protocols domain) | `src/lib/ai/domains/write-domains.ts:522-607` | Coach tab | Name, type, description, active, carry-over, check-off mode, start date. Delete is refused. **Does not re-derive today** (§1.4). |
| C3 | Coach `adjust_today` | `src/lib/ai/tools/write-tools.ts:1215-1451` | Coach tab | Today's rows: complete, skip, add, move, remove. |

### 1.2 Which facts are editable where

✓ means editable. *(row)* means today's mission row, which is a different fact from the item itself. Bold marks the facts editable in two places.

| Fact | #3 create | #3 edit | #4 item | #5 Settings | #7 sheet | #6 versions | Coach |
|---|---|---|---|---|---|---|---|
| Identity: name, description, type | ✓ | | | ✓ | | | C2 (C1 at creation) |
| Status: active or paused | | | | ✓ | | | C2 |
| Policy: carry-over, check-off mode | | | | ✓ | | | C2 |
| **Phase 1 starts** | ✓ | **✓** | | **✓** | | | C2 |
| Delete | | | | ✓ | | | refused |
| Phases: add, remove, name, length, order | ✓ | ✓ | | | | restore | C1 |
| **Items: add** | ✓ | **✓** | **✓** (empty phase only) | | | restore | C1 |
| **Items: remove** | ✓ | **✓** | **✓** | | remove from today *(row)* | restore | C1; C3 *(row)* |
| Items: order within a phase | ✓ | ✓ | | | | restore | C1 |
| Items: which phase | ✓ | only by remove and re-add (new id) | ✓ | | | restore | C1 |
| **Title** | ✓ | **✓** | **✓** | | | restore | C1 |
| **Dose** | ✓ | **✓** | **✓** | | | restore | C1 |
| Notes (why-line) | carried unseen | carried unseen | ✓ | | read only | restore | C1 |
| **Time** | ✓ | **✓** | **✓** | | move today *(row)* | restore | C1; C3 *(row)* |
| **Reminder** | ✓ | **✓** | **✓** | | | restore | inherited |
| **Cadence** | ✓ | **✓** | **✓** | | | restore | C1 |
| Versions: note, restore | | typed note | automatic note | | | ✓ restore | C1 note |
| *(row)* skip, put back, not done, unsnooze | | | | | ✓ | | C3; hero Skip; row toggle |

**The count.**
- **Once a protocol exists, 8 facts are editable in two places:**
  - *Phase 1 starts*, in #3 and #5;
  - seven item facts (add, remove, title, dose, time, reminder, cadence), in #3 and #4.
- **At creation, 3 more are asked twice:** name, description and type, in #3 and again in #5.
- **Three look-alikes**, where one verb writes different things:
  - the item's time versus *Move to …*;
  - *Remove this item* versus *Remove from today*;
  - the hero card's *Skip* versus the sheet's *Skip today*. These treat a carried row differently, and that is a bug (§1.4).

### 1.3 The two settings menus — verified

The working guess was that the full editor still carries settings and policy fields. That needs one correction. On `main`, the editor's edit path lost status, the two policies and Delete on 2026-09-19 (`app/protocol-edit.tsx:668-674`). A test pins their absence (`db/screens-render.test.mjs:2787-2792`).

The two menus are:
1. **Settings**: `app/protocol-settings.tsx`, titled "Settings" (`:204`). It opens from the header action on the protocol page (`app/protocol-detail.tsx:123-136`).
2. **Edit**: `app/protocol-edit.tsx` in edit mode, titled "Edit Protocol" (`:476`). It opens from the *Edit* row at the foot of the same page (`app/protocol-detail.tsx:403-413`).

How they overlap:
- Both are protocol-wide forms opened from the same page.
- Both edit *Phase 1 starts* (`protocol-edit.tsx:651-666` and `protocol-settings.tsx:273-288`), and both write `protocols.started_on`. The editor uses `setStartedOn` (`:424-425`); Settings uses `reviseProtocol` (`:143`).
- In create mode, #3 asks for name, description and type (`:484-521`), and #5 asks for them again (`:207-249`).
- Everything else is split by where it is stored: the `protocols` row versus the versioned document. That is an engineering line the owner cannot see.

From his side of the screen: to rename, go to Settings; to change how often, go to Edit; to change the start date, either one works.

A weaker reading is that he meant the item editor (#4), whose *When*, *Reminder* and *How often* sections look like settings. Every option below still ends with a single protocol-wide form. Option C's variant Q5(b) also ends with one place per item fact.

### 1.4 Found while reading — three defects, independent of any option

**1. A row moved by hand snaps back.**
- `moveMissionItem` writes `scheduled_time` without marking the row (`src/lib/db/repositories/mission.ts:738-752`).
- The next same-day `rederiveMissionForDay` re-syncs every pending kept row's time from the plan (`src/lib/db/repositories/mission-generate.ts:1248-1261`, `:1285-1293`).
- That re-derive runs after any protocol save, a restore, a Settings save, `update_protocol`, or an experiment starting or ending.
- So *Move to …*, and `adjust_today`'s move, are silently undone by the next unrelated edit that day. No test calls `moveMissionItem`.
- **Option C puts the item's Save on the same screen as *Move today*, so this becomes one tap away.**

**2. A pause made through the Coach does not reach today.**
- `edit_record` runs the domain's `edit` (`src/lib/ai/tools/record-tools.ts:207`), which calls `reviseProtocol` and `setActive` (`write-domains.ts:580-595`) and never `rederiveMissionFromToday`.
- So a Coach pause, or a carry-over change, leaves the protocol's untouched rows on today's mission.
- The rethink's departure #4 fixed exactly this for the Settings sheet ("would have made pausing take effect tomorrow, silently").
- Reminders are re-synced after a Coach write (`app/(tabs)/coach.tsx:138-152`); today's rows are not.

**3. Skipping a carried row settles the debt only when done from the sheet.**
- The hero's Skip (`app/(tabs)/index.tsx:291` → `src/hooks/use-today-mission.ts:157-167`) and `adjust_today`'s skip (`write-tools.ts:1397`) both call `setMissionStatus(…, 'skipped')`.
- On a carried copy, that runs only the undo branch of `settleCarriedOriginal` (`mission.ts:504-522`). The original row stays `pending`, so it is carried again tomorrow.
- The sheet calls `skipCarried` instead (`mission-item.tsx:188`). That function's own docblock states the rule: *"A hand-tapped skip is a DECISION not to do it … it has to reach the row that holds the obligation"* (`mission.ts:612-614`).
- Carry-over is still UNCONFIRMED on the device, so the owner has not hit this yet.

## 2. What every option must do

- **R1 — one settings menu. Required; this is the owner's round-2 note.**
  - After the change, the protocol page has exactly **one** door to a protocol-wide form.
  - *Phase 1 starts*, name, description, type, the two policies and Delete each live in exactly one place.
  - Creating a protocol uses the same form in create mode, not a second menu.
- **R2 — every save still reaches today.** Each save calls `rederiveMissionFromToday` and re-syncs reminders, as every current form does.
- **R3 — no Coach schema change.** Zero tokens, and all four `db/coach-eval.test.mjs` §6 ceilings stay where they are. The fix for defect 2 changes only what the tool does when it runs.
- **R4 — no migration** (§8), and no native module beyond the wheel's, which is already on `main`.
- **R5 — the Conformed Set holds.** A form carries no block, and devices never nest. Since the merge, the wheel draws its own `field` device (`src/components/protocols/time-wheel.tsx`). So it can never open inside another device; `src/components/ui/block.tsx:190-198` logs that in development.
- **R6 — the §1.4 fixes land first,** as Phase 0.
- **R7 — *Add an item* works on a protocol that already has items.** Today that needs the full editor.

## 3. Three options

### A — One editor

**Principle: the document.** Every protocol fact is edited in one form, `/protocol-edit`, which opens at the item you came from.

- **What remains:** the hub, the protocol page, the editor (create and edit), version history, and the item sheet. The sheet keeps only today's actions plus *Edit this item*, which opens the editor at that item. **5 surfaces.**
- **Removed:** `/protocol-item` and `/protocol-settings`.
- **How it meets R1:** Settings folds into the editor. The page loses its header *Settings*, *Edit* becomes the only door, and *Phase 1 starts* appears once.
- **The form, top to bottom:**
  - name, description, type;
  - Running / Paused;
  - the items, one line each (mono time · serif title · mono dose · label cadence), expanding in place to their fields one at a time, with ↑ ↓ ×;
  - phases;
  - *Phase 1 starts*;
  - the two policies;
  - change note, Save, Delete.

  Opening with `?item=` shows that item expanded and scrolled into view.
- **How it saves:** one Save and one transaction, writing only what changed. Because #4's re-read at save is gone, a whole-document save must **refuse if the live version moved since the form opened**.
- **What is lost:**
  - A small change stops being a small form. A dose tweak happens inside the largest form in the app, with Save at the foot below the settings. That is exactly the rethink's §3 complaint: "every change is the whole form".
  - The item's re-read-and-apply at save. A Coach edit approved mid-edit now costs a refusal and a redo, where today it is merged.
  - Pause as a one-step act.
  - The path from a row to the form still goes through the sheet.
- **Risks:**
  - Stale saves on the most frequent kind of edit.
  - Scrolling to the item after layout needs `Screen` to expose its scroll view.
  - The file grows to about 900 lines carrying both modes.
  - The "boxes on boxes" history applies: keep it a bare form with no plate.
- **Effort:** about 2.5 days, plus Phase 0.

### B — The protocol page is the editor

**Principle: the page.** An *Edit* in the header turns `/protocol-detail` into edit mode; Save and Cancel end it.

- **What remains:** the hub, the page (read mode, edit mode, and create mode when there is no id), version history, and the item sheet. **4 surfaces.**
- **Removed:** `/protocol-edit`, `/protocol-item` and `/protocol-settings`. The hub's *New protocol* opens the page in create mode.
- **How it meets R1:** the header's *Edit* is the only protocol-wide form, and both Settings and the full editor fold into edit mode.
- **The constraint that shapes it:** the page's *Now* is a `field` (`protocol-detail.tsx:164`), and so is the wheel. An item therefore cannot be edited in place inside *Now*; the development guard would fire. Edit mode has to draw **none** of the read devices (no *Now*, *Coming up*, *Adherence* or description margin) and become a bare form. In practice that is A's form, on the page's route.
- **What is lost:**
  - Reading while editing: the record disappears when the form appears.
  - The separate screen that keeps a dirty form off a navigation screen.
  - A focused form for one item.
  - B is also the direction the rethink set aside (§4, "Why not B"), in the recommendation the owner accepted on 2026-09-19.
- **Risks:**
  - The page's data hook re-reads on focus (`useProtocolRecord`, `src/hooks/use-protocols.ts:276-286`), so the form must be seeded once and frozen while editing.
  - A back swipe discards edits unless guarded. The precedent is `navigation.addListener('beforeRemove')` in `app/workout-log.tsx:385`.
  - Three routes are removed and the create entry is retargeted. Typed routes only regenerate under `expo start`, and commit `3fd46fa` fixed a route typo that had shipped for exactly that reason.
  - It is the largest change of the three.
- **Effort:** about 3.5–4 days, plus Phase 0.

### C — Two scopes: the item, and the protocol (recommended)

**Principle: what you touched.** Tapping an item edits the item. *Edit* on the protocol page edits the protocol.

- **What remains:** the hub; the protocol page; **the item screen**, which merges the item sheet and the item editor at `/protocol-item`; **the protocol form**, which merges the full editor and Settings at `/protocol-edit`; and version history. **5 surfaces.**
- **Removed:** `/mission-item` and `/protocol-settings`.
- **How it meets R1:**
  - Settings folds into the protocol form.
  - The page's header action, which reads *Settings* today, reads *Edit*, and the *Edit* row at the foot goes. That leaves one door.
  - *Phase 1 starts* appears once.
  - Status leaves forms altogether and becomes a Pause/Resume row on the page (Q2).

**The item screen.** Opened from a mission row, it combines the sheet the owner has already confirmed on the device with the item's form.

```
StackHeader   <item title>                                   ‹ Home
label         SUPPLEMENTS · Morning stack · Phase 2 of 3
mono          07:00 · 5 g
margin        Owed from Mon 14 Sep · 2 days late             (carried rows only)

SectionLabel  TODAY
plate         Skip today / Move today … / Remove from today / Unsnooze   (by status, as now;
              Move opens its control under the plate, as now)

SectionLabel  THE ITEM                               note  next Wed 17 Sep | 1 of 3 this week
(no block: a bare form)
              title · dose · why                     recessed fields
              TimeControl: collapsed line; opens to the wheel
              CadenceControl: collapsed line
              phase chips                            (phased protocols only)
              [ Save as v5 ]                         inert until something changes
              footnote
              Open Morning stack →                   (from a row only)
              Remove from Morning stack              (neutral; confirms)
```

- **Opened from the protocol page,** it has no *Today* section, and the back label is the protocol's name.
- **Opened on a row with no item behind it** (an experiment's intervention, a Coach-added row, an item since edited out, a deleted protocol), it draws *Today* only, as the sheet does now.
- **The save is exactly #4's:** re-read at save, `applyItemToContent`, `validateContent`, the no-op guard, `addVersion` with an automatic note, re-derive, reminder sync.
- **Accent:** the sheet spent none (`mission-item.tsx:41-45`). Save stays recessed and inert until the form has a change, so the screen at rest still spends none.
- **Guard:** *Remove from today* closes the screen, so it is disabled while the form has unsaved changes. Skip, Move and Unsnooze only reload the head of the screen; the form is seeded once and keeps its edits.

**The protocol page.**
- The header action is *Edit*.
- *Add an item* is **always** drawn at the end of *Now* when the protocol is running (R7). It defaults to the live phase; the current add mode defaults to phase 1 (`protocol-item.tsx:123-125`).
- The closing plate is renamed *The protocol*. It holds *Pause this protocol* (or *Resume*) and *Version history*. Pausing asks for confirmation and says what leaves today; there is no Save.
- The page still spends no accent.

**The protocol form.** One layout for create and edit.

```
PROTOCOL      name · description
TYPE          seven chips + "applies from tomorrow"                      (edit mode)
ITEMS / PHASE n
              one line per item: time · name · dose · cadence, ↑ ↓ ×;
              tap opens its fields in place, one at a time (Q5);
              every row open when creating
              Add item · Add a phase
PHASE 1 STARTS                                                            (phased; ONCE)
IF YOU MISS IT · WHEN YOU CHECK IT OFF                                    (edit mode)
WHAT CHANGED → v5                                                         (edit mode)
[ Save as v5 | Save | Create protocol ]    footnote    Delete protocol    (edit mode)
```

- **The Save button** reads *Save as vN* when the document or the note changed, *Save* when only settings changed, and is inert when nothing changed.
- **The save** is one transaction that writes only the groups that changed:
  - The new version is refused if the live version moved since the form opened. Today's editor saves its opening-time document blind (`protocol-edit.tsx:413-419`).
  - Name, description and type, the start date and the policies are written from the protocol row as re-read at save. Today, Settings rewrites all four identity fields from the values the form opened with.
- **The rules the tests already pin still hold by construction:** a structure-only save leaves identity and policy byte-identical, and a settings-only save writes no version (`db/protocols.test.mjs` §12b, `:811` onward).
- **The expanded item row uses the item screen's own fields,** through one shared component (`src/components/protocols/item-fields.tsx`). That gives the full editor two things it lacks today:
  - the why-line, which is currently carried through unseen (`protocol-edit.tsx:130`);
  - moving an item to another phase while keeping its id. Today that means removing and re-adding it, which mints a new id.

**Pause.** One function, used by the page **and** by the Coach's protocols domain, which also fixes defect 2:
- `setActive` (`src/lib/db/repositories/protocols.ts:413-424`), which today has no caller in the app;
- then a re-derive of today;
- then the caller syncs reminders.

Resume anchors only a phase clock that was never started, which is `setActive`'s existing rule.

**What is lost.**
- The sheet as a read-only card: it now shows fields.
- The explicit *Edit this item* step.
- Status as a form field.
- The word *Settings* as a way in.
- Seven item facts stay editable in two places: the item screen and the protocol form's expanded row. They share one component and one pinned save rule, and Q5(b) removes the duplication entirely.

**Risks.**
- Defect 1 becomes one tap from Save, so Phase 0 is a hard prerequisite.
- Two time controls share one screen. Today's *Move* keeps its six presets and typed field (`src/components/protocols/move-control.tsx` on `main`); the item's time is the wheel. See Q3.
- Home's push target changes and two routes go away, so run `expo start` before merging.
- The `slop3` worktree edits one line in each of the same six files; rebase after it.
- The protocol form gets identity fields back. The old complaint about identity sitting above the items on the dose screen cannot come back, because this form is no longer the dose screen.

**Effort:** about 2.5 days, including Phase 0 (§6).

## 4. Taps, before and after

Counted from Home. Numbers in parentheses are scrolls, estimated for a 375 × 812 screen and a protocol with 4–6 items, ignoring the keyboard. A spin of the wheel counts as one gesture.

| Task | Now | A | B | C |
|---|---|---|---|---|
| Change a dose, from its mission row | 4 (1): chevron → *Edit this item* → dose → Save | 4 (1–2): chevron → *Edit this item* → dose → Save at the foot | 4 (0): … → Save in the header | **3** (0–1): chevron → dose → Save |
| Change a dose, from Protocols | 5 (1): `PROTOCOLS ›` → protocol → item → dose → Save | 5 (1–2) | 5 (0) | 5 (0–1) |
| Change an item's time, from its row | 3 + spin (1). The first time control met, *Move to …*, changes today only | 4 + spin (1–2) | 4 + spin (0) | 3 + spin (0–1): chevron → time line → spin → Save. *Move today …* sits above it, labelled |
| Pause a protocol | 5 (1): `PROTOCOLS ›` → protocol → *Settings* → *Paused* → Save | 5 (1–2): … → *Edit* → *Paused* → Save | 5 (0) | **4** (1–2): `PROTOCOLS ›` → protocol → *Pause* → confirm |
| Add an item to a protocol that has items (name only) | 6 (2–3): … → *Edit* → *Add item* → name → Save | 5 (1) | 5 (0) | 5 (0–1): … → *Add an item* → name → Save |
| Screens opened for a dose change from a row | 2 | 2 | 2 | **1** |
| Protocol-wide forms (**the settings menus**) | **2** | **1** | **1** | **1** |
| Surfaces on the protocol path | 7 | 5 | 4 | 5 |
| Facts editable in two places, once a protocol exists | 8 | 0 | 0 | 7, through one shared component (0 under Q5(b)) |

## 5. Recommendation: C

1. **It shortens the path the owner actually walks.** The device checklist confirmed the chevron sheet. C makes that sheet the item itself, so a dose change from Home takes one screen instead of two and 3 taps instead of 4. No other option shortens the row path.
2. **It keeps the rethink's main win: a small change is a small form.** It removes only the two in-between surfaces: the sheet, which was a menu of actions plus two doors, and Settings, which was a second protocol-wide form. A puts every dose tweak back inside the whole document; B hides the record while editing.
3. **It meets R1 by folding Settings into Edit and turning the one-step status change into an action.** The page has one *Edit*, *Phase 1 starts* appears once, and pausing takes 4 taps with no form.
4. **Its everyday saves stay safe against Coach edits.** The item screen keeps the per-item re-read at save, so a Coach edit approved while it is open is merged rather than reverted. The stale-version refusal is needed only on the rarely used protocol form.
5. **It reuses shapes already on `main`:**
   - a plate of actions with a form under it is `app/mission-item.tsx` today;
   - identity and policy in the editor is what `app/protocol-edit.tsx` carried until 2026-09-19;
   - pause is `setActive`.

   No read screen is rewritten, and no new device question is raised.

**Why not A:** it has the fewest forms, but it gives up the rethink's main win. **Why not B:** the wheel's `field` device turns it into A on the page's route, plus a dirty form on a navigation screen, and it reopens a recommendation the owner accepted four days ago.

## 6. Building C

| Phase | Work | Size |
|---|---|---|
| **0 — fixes.** Independent; could ship on their own. | (1) A moved row keeps its time: `moveMissionItem` stamps a mark in the row's value, and the kept-row re-sync keeps a marked row's time and carries the mark forward while still updating its dose and why-line. `adjust_today`'s move gets this for free. (2) The protocols domain's `edit` re-derives today after writing; zero schema tokens. (3) One definition of skipping a carried row: the `skipCarried` branch moves into `setMissionStatus(…, 'skipped')`, so the hero card, `adjust_today` and the item screen agree. | half a day |
| **1 — the item screen** | Merge `app/mission-item.tsx` into `app/protocol-item.tsx`. Its parameters are `row`, or `id` + `item`, or `id` alone for adding. Home's `onOpen` pushes it with `row`. Add the shared `item-fields.tsx`. Save stays inert until there is a change; *Remove from today* is disabled while the form has unsaved changes. *Add an item* is always drawn and defaults to the live phase. Remove `mission-item` from `_layout.tsx`. | 1 day |
| **2 — one protocol form.** **One merge:** between the halves, two surfaces would be writing settings. | Fold `app/protocol-settings.tsx` into the edit mode of `protocol-edit.tsx`, in the layout above, with *Phase 1 starts* once. Add the atomic save that writes only what changed, with the stale-version refusal. Add the expand-in-place item rows. On the page: header *Edit*, and the closing plate with *Pause* / *Resume* and *Version history*. Add the shared pause function, also called by the Coach domain. Delete moves to the form's foot. Remove `protocol-settings` from `_layout.tsx`. | 1 day |
| **3 — docs** | `docs/information-architecture.md:20`, `:72`, `:74-80`. `docs/home-screen.md`: the sheet, and `:124`, which still says the empty day opens `/protocol-edit` when the code opens `/protocols`. A "superseded in part" banner on `docs/spikes/protocol-interface-rethink.md`. Both owner notes answered in `docs/project-status.md`. | 2 hours |
| **Total** | | **about 2.5 days** |

**Sequencing.**
- Build on `main` after `slop3` merges. It edits one line each in `app/(tabs)/index.tsx`, `app/mission-day.tsx`, `app/protocol-edit.tsx`, `app/protocol-item.tsx`, `app/protocol-settings.tsx` and `app/protocol-versions.tsx`.
- The wheel is already merged.
- C adds no native module, so it rides the EAS rebuild the wheel already requires.

**Tests.** Headless, each in the suite that owns the seam.

- **`db/screens-render.test.mjs`**
  - The item-sheet cases (`:2957-3117`) re-point at the item screen with `row`.
  - Add: *Today* and *The item* both appear when opened from a row; no *Today* when opened from the page; Save inert at rest.
  - The Settings cases (`:2809-2825`) move to the protocol form's edit mode, and the refute at `:2787-2792` becomes an expect.
  - The page shows *Edit* and not *Settings*, shows *Pause this protocol* or *Resume*, and shows *Add an item* when the protocol has items.
- **`db/protocols.test.mjs`**
  - Keep §12b's byte-identity check (`:848-855`) and its identity-untouched check (`:876`).
  - Add: a settings-only save writes no version; a save built on a stale version refuses and writes nothing; a settings save does not flip `is_active` from the value the form opened with; a phase move made from the form keeps the item's id.
- **`db/mission-generate.test.mjs`**
  - A moved row keeps its time through a same-day re-derive that changes its dose.
  - A row that was not moved still follows a time edit.
  - Pausing removes untouched rows from today and keeps rows already acted on.
  - Resuming anchors the phase clock only when it was null.
- **`db/data-layer.test.mjs`, or §17 of `db/mission-generate.test.mjs`**
  - A `setMissionStatus` skip on a carried copy also skips the original with `skipped_via`.
  - Tomorrow carries nothing.
  - The row toggle re-opens both rows.
- **`db/coach-tools.test.mjs`**
  - An approved `edit_record { protocols, is_active: false }` takes the protocol's untouched rows off today.
- **`db/coach-eval.test.mjs` §6**
  - All ceilings unchanged.

## 7. Questions for the owner

**1. Which shape?**
- (a) **(Recommended)** Two scopes. A mission row opens the item itself: today's actions on top, its fields below, one Save. Settings and Edit become one protocol form behind one *Edit*. Pausing is a tap on the protocol's page. 7 surfaces become 5, with one settings menu.
- (b) One editor. Every protocol fact is in one form, which opens at the item you came from. The row's sheet keeps today's actions. 7 surfaces become 5, with one settings menu.
- (c) The page is the editor. The protocol's own page switches into edit mode. 7 surfaces become 4, with one settings menu. This is the largest change, and it is the direction the September rethink set aside.
- (d) The settings fix only. Settings folds into Edit and nothing else moves. 7 surfaces become 6, with one settings menu.

**2. Pause and resume.**
- (a) **(Recommended)** A *Pause* / *Resume* row on the protocol's page, with a confirmation that says what leaves today's mission. No form and no Save.
- (b) *Running* / *Paused* chips inside the protocol form, saved with everything else, as Settings does today.

**3. (If 1a) The item screen would show two time controls: today's *Move* and the item's own time.**
- (a) **(Recommended)** Keep both, each labelled with its scope: *Move today …* in the Today section with its one-tap presets, and the item's time on the wheel under *The item*.
- (b) One wheel. When you open an item from today's row and change its time, Save asks *Today only* or *From today on*, the way Calendar asks about a repeating event. That is one control, but one extra tap on every time change made from Home.
- (c) Drop *Move today*. A one-day move goes through the Coach.

**4. (If 1a) What the chevron on a mission row opens.**
- (a) **(Recommended)** The item with its fields open, so a dose change is chevron → field → Save.
- (b) The item with its fields folded under one line, so it reads like today's sheet until you open it. That is 4 taps as now, with one screen fewer.

**5. (If 1a or 1b) How items appear inside the protocol form.**
- (a) **(Recommended)** One line per item (time · name · dose · cadence) that opens in place to the same fields the item screen shows, one at a time.
- (b) One line per item, for ordering and removal only; every field is changed on the item screen. No fact is editable in two places, but reshaping a titration takes one save per item.
- (c) Every item fully open, as the editor draws them today.

## 8. Migration — none, confirmed

- No new column and no new table. The protocol form and the item screen write existing columns and versions, and pause uses the existing `setActive`.
- Phase 0's moved-row mark is one key in `log_entries.value`. The existing `json_valid` CHECK guards it, and it is the same kind of key as `removed`, `skipped_via`, `done_on` and `ahead`. `parseExtras` ignores unknown keys, so reverting needs no data fix.
- The migration head stays at `0061`.
- No native module; the wheel's dependency is already on `main`.
- The Coach's tool schemas and prompt don't change: zero tokens.
- **Backing out:** each phase is routes, one shared component, repository calls and a docs pass. Reverting restores the two routes, and nothing written is unreadable by the old code.

## 9. What only a device can settle

- Whether a screen with fields, opened from a row, still reads as "about this item" at rest, with Save inert.
- Whether *Edit* in the header is where he looks, after two weeks of *Settings* being there.
- Whether *Pause* in the closing plate is easy to find.
- Whether a wheel opened inside an expanded row of the protocol form is too tall to keep that row's context on screen.
- Whether *Move today …* next to the item's time reads as two scopes, or as two ways of doing one thing (Q3).
