> **BUILT 2026-09-25 (migration 0064, branch `claude/fb-notify`).** The owner accepted all six recommendations on 2026-09-25; the recommended combination was built in its build order — (c) with the total-cap guard, the tap upgrade for (a) with the `checkin` flag (Q5 yes), and the morning check-in as an opt-in, sequenced after the Health sync. The account of what was built, and the three decisions this plan left open (a silent pass does NOT cancel pending nudges; what a tap shows when a check-in gets no answer; the `about` link deferred), is `docs/ai-coach.md` §3 › Coach notifications. This file stays as the plan and its reasoning; where the two differ, the build is the record. Nothing is on a device yet.
>
> **Coach parity for the controls, 2026-09-25 (branch `claude/fb-nudgeparity`, no migration).** The chat Coach can now switch nudges off and on, move quiet hours, set or clear the morning check-in, and cancel one planned nudge, each behind a card and through the function the screen calls. §4's "The Scheduled list on the Coach tab cancels one nudge at a time" holds for the Coach as well. The record is `docs/coach-domains.md` §10c.
>
> *(Original status line: PLAN — not built, written and fact-checked 2026-09-23.)*

# Coach notifications: plan

**Asked:** 2026-09-23, from the device: *"coach sends push notifications"*.
**Status:** a plan. Nothing is built. Everything under "today" was read from `main` at `b3e6e42`, and the token numbers were measured by running `db/coach-eval.test.mjs`. (checked 2026-09-23: `main` has since moved to `386e5d0`. The merges in between change only copy strings in the files this plan cites, and a re-run on committed `main` gives the same 9,067 / 3,652 / 7,028. These figures come from the test's character-count proxies: about 2.8 characters per token for JSON and 3.6 for prose, "good to ~10%" by the test's own comment. They are not tokenizer counts. A merge was in progress in the main checkout at the time of checking, the Coach-deletion change from `claude/fb-delete`. With it applied, the proxies read about 9,039 / 3,648 / 7,024. That is slightly more headroom, and no conclusion below changes.)

---

## 1. The short answer

ARC has no server, so "push" can only mean **local notifications scheduled on the phone**. That leads to the fact the whole plan rests on:

> **The Coach can only think while ARC is open.** Anything it sends was decided the last time the app was open. It cannot notice something while ARC is closed and tell him about it.

That is not a gap to hide. It is how the plan works. A lot of this is already built:

- **"Remind me at 3 to take the creatine" works today.** `set_reminder` writes a row, and the same OS pass that fires protocol reminders schedules it. "Protocol reminders fire" was confirmed on the device on 2026-09-23.
- **The Coach already speaks without being asked**, once a day when the app opens (the coach pass).
- **A "check-in" is half built.** `PassTrigger` has a `checkin` kind with morning and evening directives, and a notification tapped with `kind: 'checkin'` already routes to the Coach tab. Nothing schedules one and nothing makes the pass run one.

**Recommendation:** keep (a) as it is and make its tap more useful. Build **(c)**: when the pass runs, the Coach may plan up to two nudges for the next day. The model decides whether to send one, what it says and when. Code enforces the cap, quiet hours and delivery. (b) becomes one of those nudges. The check-in doorbell is opt-in. **Reject (d).** The core adds **0 tokens to either ceiling**.

---

## 2. What the code does today

### 2.1 Notifications

- **One reconciliation pass owns the OS schedule:** `syncReminderNotifications` in `src/lib/notifications/reminders.ts`. It **cancels every scheduled notification**, then reschedules from two sources:
  1. active `reminders` rows (0009) with a time: daily and weekly repeat natively, and a one-off is one dated moment;
  2. protocol items with their reminder on (`src/lib/notifications/protocol-reminders.ts`): one notification per item at its next occurrence within 7 days, earliest first.
- **Because it cancels everything, any new source must join this pass.** A second scheduler would be wiped by the next Coach turn. The file header says this. (checked 2026-09-23: it is the doc comment on `syncReminderNotifications` and the header of `protocol-reminders.ts` that say this. The file header of `reminders.ts` is stale: it still says "Reminders are the only thing ARC schedules". A nudge branch should fix that header too.)
- The pass is serialized: a call made during a pass queues one trailing run. It runs at boot, after every Coach turn, after mission and protocol edits, at day rollover, and on the foreground that sees a timezone change.
- **The rest timer** (`rest-timer.ts`) is a separate one-shot that keeps its OS id so it can cancel it. Any resync also wipes it. That cost is documented and accepted.
- **Permission:** `ensurePermission` asks only when there is something to schedule. If `canAskAgain` is false it reports "not granted" and does not ask. `syncAndReportForReminder` gives the Coach an observed verdict per reminder (`scheduled`, `permission-not-granted`, `moment-passed` …), and the system prompt tells it to relay that verdict and never promise a buzz.
- **Identifiers:** ARC sets no request `identifier`. The ids the OS returns are thrown away, except the rest timer's. Identity lives in the `data` payload: `reminderId`, `protocolItem` + `protocolId`, `kind: 'rest-timer'`. `routeForNotification` maps a tap: reminder to the Coach tab (scrolled to the reminders card), protocol item to Home, `kind: 'checkin'` to the Coach tab.
- **Presentation:** a handler makes a notification show while ARC is in front (iOS drops it otherwise). ARC sets no badge on purpose.
- **The 64 cap:** iOS keeps the 64 soonest pending notifications per app and silently drops the rest. A repeating trigger counts as one. ARC stays under it by capping protocol items at **32** (`PROTOCOL_REMINDER_MAX`) and one per item. **Reminders have no cap and nothing guards the total**, so in practice ARC stays under 64 only because a person has few reminders.
- **On the device:** `expo-notifications` has been in the binary since the 2026-08-25 build. "Protocol reminders fire" is confirmed on hardware (`docs/project-status.md`, 2026-09-23). A reminder set by the Coach goes through the same pass, but nobody has recorded seeing one buzz.

### 2.2 How the Coach is called

- `runCoachTurn` (`src/lib/ai/model-client.ts`) sends a streaming POST from `expo/fetch` straight to `api.anthropic.com/v1/messages`, with the key in the `x-api-key` header. It allows at most 8 model round trips per turn. There are two cache breakpoints (tools, static prompt) with a 1-hour TTL. The ~1.4k-token "Current state" block goes after the breakpoint and is not cached.
- **The key** is in the iOS Keychain through `expo-secure-store` at **`WHEN_UNLOCKED_THIS_DEVICE_ONLY`**, with an in-memory copy loaded at boot (`api-key-store.ts`).
- **Chat** runs on Sonnet 5 by default. Every write stops at a confirmation card.
- **Tools:** 41 registered, 19 read and 22 write. The domain registry (`src/lib/ai/domains/`) sits behind three generic tools: `query_records` (15 domains), `edit_record` (18), `delete_record` (11). (checked 2026-09-23: `query_records`' domain enum now has **17** keys. Commit C added `muscle_anchors` and `settings` to it after `docs/coach-domains.md` §9 said fifteen. The counts of 18 and 11 are correct on committed `main`.)
- **Reminders in the registry:** `set_reminder` is the create path. `docs/coach-domains.md` §6 lists its pinned day as "stays bespoke, permanently", and the reminders domain declares `createVia: 'set_reminder'`. `list_reminders` is the read. `edit_record { reminders, status: done | dismissed }` is the only edit. Reminders are not in `delete_record`, because dismissing is how one is removed.
- **The coach pass** (`coach-pass.ts`, `pass-schedule.ts`, `pass-store.ts`):
  - It runs once per day on the first open, and again on a new watch-tone signal or a timezone landing.
  - It uses **Haiku 4.5** with **read tools only**: 18, because `query_records` is held back.
  - It may reply `SKIP`.
  - It does not run while the app lock is up or before the key has loaded.
  - An offline failure does not use up the day.
  - What it says goes into the thread and onto Home's "Coach noticed" card.
  - `duePass` only ever returns `daily` or `signal`. The `checkin` directives exist but cannot be reached.

### 2.3 The token ceilings, measured today

| Budget (`db/coach-eval.test.mjs` §6) | Now | Ceiling | Headroom |
| --- | ---: | ---: | ---: |
| Tool schemas, all 41 tools | 9,067 | 9,250 | **183** |
| Static system prompt | 3,652 | 3,700 | **48** |
| Pass prefix (prompt + 18 read tools) | 7,028 | must stay above Haiku's 4,096 cache floor | 2,932 |

What things cost against these ceilings:

- **A new tool** costs roughly what `set_reminder` does: **244 tokens**. That is more than the whole schema headroom.
- **A doctrine bullet** in the prompt costs about 40 to 80 tokens. That is more than the prompt headroom. (checked 2026-09-23: overstated. The test's own log prices the last two doctrine additions at +27 and about +30 tokens, and both would fit inside 48. A full "you may schedule notifications" bullet would come to about 50 by the same proxy, so it would go over. The conclusion holds regardless, because the tool alone, at 244, already exceeds the 183 schema headroom.)
- The test's standing rule: **the next addition trims before it raises**, and neither ceiling is raised a fourth time.
- **A new registry domain** costs about 3 tokens (one enum key). **A new field costs 0**, because the model learns field names from the discovery call. The limit on domains is not tokens. It is **parity**: the Coach may only do what a screen can do.
- **The pass directive is a user message, not system prompt** (`coach-pass.ts:231`). It sits outside both ceilings and outside the cached prefix. Each pass pays for its length once, at Haiku's uncached rate: about $0.0001 per 100 tokens. (checked 2026-09-23: wrong. It is paid on **every round trip**, not once. `buildMessagesRequest` puts breakpoints only on the last tool and the static system block, so `messages`, including the directive, are re-sent uncached on each of a pass's 2 to 8 round trips. That makes about $0.0002 to $0.0008 per 100 directive tokens per pass. It is still negligible, and nothing in the recommendation depends on it.)

### 2.4 Background execution

**ARC has none.** `app.json` has no `UIBackgroundModes`. There is no `expo-task-manager` or `expo-background-task` in `package.json`. The HealthKit plugin is `"background": false`. `docs/coach-intelligence-review.md` §1 checked this as well.

What iOS actually offers is a background refresh through `BGTaskScheduler`:

- **No timing guarantee.** "Earliest begin" is a floor, not a schedule. iOS decides from how often the app is used, battery and charging state. Low Power Mode or the user's Background App Refresh switch turns it off. After a force-quit from the app switcher it usually stops until the next manual launch.
- An app-refresh window is about 30 seconds.

Four things specific to ARC make it worse:

1. **The key cannot be read while the phone is locked.** It is `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so a fresh background launch at 5 a.m. finds no key. (checked 2026-09-23: true only for a *cold* background launch. If iOS resumes a suspended ARC, the key is already in the in-memory mirror (`api-key-store.ts` module state), and the Keychain is not consulted. This reason is weaker than it reads. Reasons 2 and 3 carry the rejection on their own.)
2. **HealthKit cannot be read while the phone is locked.** A dawn wake cannot see last night's sleep, which is the one thing a morning nudge would want.
3. **The pass has a lock rule.** It refuses to send health data to the model "on the say-so of whoever is holding the phone" (`pass-store.ts`). A background run has, by definition, no one authenticated.
4. **Money is spent where no one sees it.** A pass is 2 to 8 streaming round trips. If iOS kills it at 30 seconds, the round trips that finished are still billed and nothing is delivered.

---

## 3. The options

Money figures use Haiku 4.5 ($1 in / $5 out per million tokens, 1-hour cache writes at 2×, cache reads at 0.1×). **One pass costs about $0.02**: a cold write of the ~7k prefix is about $0.014, and the state block, tool results and a short reply add the rest. The worst case, 8 round trips, is about $0.05. Passes hours apart always start with a cold cache. **The existing daily pass already costs this: about $0.65 a month.**

### (a) The Coach schedules one from a conversation

*"Remind me at 3 to take the creatine." "Check in tonight about the knee."*

- **What he sees:** this already works. He sees a card, "Set reminder "Take creatine" at 15:00", taps Approve, and the phone buzzes at 15:00. A tap opens the Coach tab scrolled to the reminders card. The knee check-in works the same way, but the tap only shows the reminder. The Coach says nothing and he has to type.
- **Judgment:** his. He asked, and the model only fills in the fields.
- **Tokens:** 0. It is built.
- **Money:** the chat turn only.
- **Failure modes:** all handled and reported: no time means in-app only, the moment has passed, permission denied, no module. A one-off stays on the in-app list until he marks it done.
- **Is the registry the path? No, and it does not need to be.** The registry already routes creation to `set_reminder` (`createVia`). **There is no reminders screen.** Reminders exist only as the card on the Coach tab, which offers Done and Dismiss. That has two consequences:
  - Under the registry's parity rule, the Coach **may not move a reminder** ("make it 4 instead"), because no screen can. Adding `time` and `date` fields would cost 0 tokens and still break the rule. Today that request takes two cards: dismiss, then set a new one.
  - Opening that up means building a small Reminders screen first (list, create, edit time/date/repeat, dismiss). That screen is also where he would see everything that will buzz.
- **Build (small, JS only):**
  - A reminder tap highlights its row and offers **"Talk about this"**, which puts the title into the composer and never sends it. This follows the composer-seed rule in `coach.tsx`.
  - Optional: a `checkin` flag on `set_reminder` (about 25 schema tokens, fits in 183). With it, a tap on a check-in makes the Coach speak first through a pass about that topic, at about $0.02 per tap. He is present when he taps, so none of that money is spent unseen.

### (b) A morning brief notification, written by the model at the last open

- **What he sees:** a notification at 07:00 every day with a line the Coach wrote the evening before.
- **Judgment:** the model's, but on **stale data.** It is written before the night happened: no sleep, no HRV, nothing HealthKit hands over in the morning. The part of a morning brief that matters is exactly the part it cannot know.
- **Tokens:** 0, if it lives in the pass directive.
- **Money:** a dedicated call is about $0.02 a day. Folded into (c) it costs nothing extra.
- **Failure modes:**
  - It fires every day, so it becomes wallpaper.
  - It repeats Home's brief (the owner already had the Coach tab's copy removed for that reason, 2026-08-10).
  - If he doesn't open ARC for a day, the same text goes out again, or nothing does.
  - Readiness guesses land on the lock screen.
- **Verdict:** not as a separate feature. Keep the good half: the evening pass *may* choose a morning line about things known in advance (today's plan, an experiment reading out, "you said you'd check the knee"). That is one of the nudges in (c).

### (c) The Coach plans the next day's nudges when the app opens (recommended core)

- **What he sees:**
  - Some days nothing. Other days one or two notifications written by the Coach, such as "Leg day. Eat before you lift; you trained fasted Monday and stalled."
  - A **Scheduled** line on the Coach tab lists what is pending, each with **Cancel**.
  - The thread records what was planned.
- **Judgment:** the **model's**: whether to send, what to say and when.
- **What code enforces** (none of it is clinical):
  - at most **N per logical day**;
  - nothing inside **quiet hours**, and nothing in the past;
  - a horizon of 36 hours or less;
  - a length cap, with markdown stripped;
  - **dropped, never moved**, when a time is not allowed. This is the protocol-reminder precedent: moving a nudge would be ARC deciding to nudge.
- **Tokens: 0 against both ceilings.**
  - The instruction goes in `passDirective`, which is the pass's user message.
  - **No tool is added.** The model ends its reply with strict lines, for example `NUDGE 07:30 Leg day. Eat before you lift.`
  - A pure parser, headless-tested like `isPassSkip`, pulls out the lines that match and drops any that don't. It never guesses. The rest of the reply goes to `isPassSkip` unchanged, so a pass can say `SKIP` and still plan a nudge.
  - The pass stays **read-only by construction**: it proposes, and deterministic code in `pass-store.ts` applies the caps and writes the rows.
  - A pass-only `schedule_nudge` tool was considered and rejected. The token cost is not the issue. It would be the pass's first side effect, called mid-loop before the model had reached its verdict.
- **Money:**
  - It rides passes that already run: the daily pass costs $0 extra.
  - Planning tomorrow well needs an **evening pass**: the first open after an evening hour, using the existing `checkin: evening` directive (plan against what happened, plus tomorrow's nudges). That is about +$0.02 a day, about $0.65 a month. It runs only when he opens the app in the evening.
- **Failure modes:**
  - **He doesn't open ARC:** nothing new is planned. What was already planned still fires. The 36-hour horizon means no nudge is ever older than a day and a half.
  - **The nudge is about something he already did:** a nudge can carry an optional `about` link to a mission item. The resync drops it once that item is ticked or skipped, and every tick triggers a resync. That is grounding, not judgment. For anything else the directive tells the model to write text that still holds if it is already done.
  - **Travel:** store a logical day plus `HH:MM` and fire through `fireInstant`, so a trip re-anchors the nudge the way it does protocol items. On an eastbound trip a moment that has passed is dropped.
  - **Build-up:** each completed pass states the **whole** pending set (it sees the current set in its directive), so the count can never grow by piling up. A pass that fails changes nothing. (checked 2026-09-23: a consequence the plan leaves unstated. Under this rule, a pass that completes silently (`SKIP`) with no `NUDGE` lines cancels every pending nudge. That includes the evening pass's plan for the morning, if a signal pass or an early daily pass runs first and does not restate it. The branch has to decide which rule holds: either a silent pass leaves the set alone, or restating is mandatory and the directive says so.)
  - **Permission denied:** the sync reports it, and the Coach tab says so.
- **Build (medium, one branch):**
  - Migration **0062** `coach_nudges` (`id`, `day`, `time`, `text`, `about`, `status` pending/delivered/cancelled, stamps). (checked 2026-09-23: 0062 is already taken. The `fb-lifts` worktree holds an uncommitted `db/migrations/0062_exercise_load_basis.sql` from the same day's device notes. Use the next number free above `main`'s head *and* every live branch, re-checked at merge. The runner silently skips a migration numbered below a device's `user_version`.)
  - The parser.
  - A third source in `runReminderSyncPass` with `data: { kind: 'nudge', nudgeId }`.
  - A total guard of 60 or fewer (reminders + nudges + protocol items, leaving room for the rest timer), because none exists today.
  - An evening trigger in `duePass`, with its state in `users.preferences.coachPass`, so no migration.
  - Settings controls, the Coach-tab list, and tap routing.
  - Tests in `db/coach-pass.test.mjs`, `db/notifications.test.mjs` and the timezone suite.
  - No new native module. Because there is no OTA, it reaches the phone in the **next EAS build**.

### (d) Background refresh writes nudges while the app is closed

- **What he'd see:** in theory, a nudge based on data that arrived while ARC was closed. In practice a nudge at a time iOS picks, or no nudge at all.
- **Judgment:** the model's, on data it cannot read. HealthKit and the key are both locked while the phone is.
- **Tokens:** 0 more than (c).
- **Money:** about $0.02 to $0.05 per wake, however many times iOS chooses, and nobody sees the spend. A run killed at 30 seconds still bills the round trips it finished.
- **Failure modes:** everything in §2.4. Making it work means weakening the key to `AFTER_FIRST_UNLOCK` (checked 2026-09-23: the minimal change would be `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, which keeps the key out of device backups. It is still a weakening, and HealthKit stays unreadable while the phone is locked either way), carving an exception into the pass's lock rule, adding two native modules and a `BGTaskScheduler` identifier, and doing an EAS rebuild. The result would still have no timing guarantee.
- **Verdict: reject.** It spends his money unseen to produce worse nudges than (c), and it breaks the one rule that keeps the pass safe.

### (e) Other options found

1. **The check-in doorbell** (the half-built piece):
   - A fixed daily notification at a time he picks, reading **"Morning check-in"** with no health content.
   - A tap opens the Coach tab. If the day's pass hasn't run yet, it runs as `checkin: morning` with **fresh** data. That costs $0 extra, because it *is* the daily pass. If the pass already ran, the tap just shows its note.
   - This is the only way to get a morning word that has seen the night. The risk is that it becomes wallpaper, so it is **opt-in**.
   - (checked 2026-09-23: "fresh" is not what the code does today. In `app/_layout.tsx`, `syncHealthIfEnabled` is started fire-and-forget. `coachPassStore.maybeRun` waits only for the app lock and the Keychain key, both of which usually settle before a 14-day HealthKit sync finishes. The pass's state block is built when the call starts, so a cold-start check-in can read the database before last night's sleep and HRV land. The same race affects today's daily pass. To earn "has seen the night", the check-in pass must wait for the boot or foreground Health sync to settle, with a short timeout so an unlinked or slow HealthKit cannot block it.)
   - Build: small, a daily trigger plus wiring the route and trigger that already exist, **plus sequencing the check-in pass after the Health sync** (checked 2026-09-23, see above).
   - (checked 2026-09-23, also a gap: if the day's pass already ran and chose `SKIP`, the tap finds no note, and the doorbell opens onto nothing. Decide what the tap shows then.)
2. **Nudges tied to a mission item**, cancelled by the resync when the item is settled. This is folded into (c) above.
3. **Interruption level.** `expo-notifications` accepts `interruptionLevel` (`passive | active | timeSensitive | critical`). Nudges should use the normal level and **never `timeSensitive`**: the Coach's opinion should not break through his Focus. (checked 2026-09-23: today the binary enforces this rule without any code. `app.json` declares no entitlements, and `timeSensitive` needs the Time Sensitive Notifications capability plus an EAS rebuild. Without the capability, iOS falls back to `active`. `critical` needs an entitlement Apple grants on request. Keep the rule so that a future entitlement does not quietly change it.)
4. **Rejected:**
   - *Notification action buttons* ("Done" without opening the app) run JS in the background and write to the database while the phone may be locked, which brings back (d).
   - *Widgets* need an extension and an App Group; `docs/spikes/water-fast-logging.md` already costs this.
   - *Sending the pass's note as a notification* is pointless: the pass runs while he is looking at the app.

---

## 4. The recommendation

**(a) as built, plus the tap upgrade · (c) on the existing pass, with (b) as one of its nudges · the doorbell as an opt-in · (d) rejected.**

### What a tap opens

| Notification | Tap lands on | Then |
| --- | --- | --- |
| A reminder he asked for | Coach tab, that reminder highlighted | "Talk about this" puts it in the composer. A check-in makes the Coach speak first (if Q5 is yes) |
| A protocol item | Home | Unchanged |
| A Coach nudge | Coach tab | The nudge is added to the thread as the Coach's latest message, so his reply has context. It is marked delivered. The daily pass runs as usual and is told what was sent, so it doesn't repeat it |
| The doorbell | Coach tab | The daily pass runs as a morning check-in if it hasn't run today, after the Health sync settles (checked 2026-09-23: nothing sequences this today, see §3 (e)1) |

### How he turns it off

- **Settings › Coach** (`app/settings-coach.tsx`) gets a **Notifications** section:
  - **Coach nudges** on/off. Off cancels everything pending at once, through the same resync, and removes the nudge instructions from the directive.
  - **Quiet hours**: two times, reusing the new time wheel (`src/components/protocols/time-wheel.tsx`).
  - **Morning check-in**: off, or a time.
- The **Scheduled** list on the Coach tab cancels one nudge at a time.
- **iOS Settings › Notifications › ARC** remains the master switch, and it also silences his own reminders.

### Quiet hours

- A nudge whose time falls inside quiet hours is **dropped, not moved**.
- The directive tells the model the window, so it doesn't waste a nudge there.
- **Reminders he set himself, and protocol items, are exempt**, because he chose those times.
- iOS Focus and Sleep still apply to everything on top of this.

### What the ceiling squeeze means for it

- The core costs **0 schema tokens and 0 prompt tokens**. It runs in the pass, whose directive is outside both budgets, and it adds no tool. The pass prefix doesn't move either, so Haiku's cache floor is not affected.
- The only charge against the chat ceilings is optional: the `checkin` flag on `set_reminder`, about 25 of the 183 schema tokens, with its explanation in the property itself so it costs 0 prompt tokens.
- **What the squeeze rules out:** a chat tool such as `schedule_notification` plus a doctrine bullet. That would take most of the schema headroom and go past the prompt's 48, forcing a fourth raise. (checked 2026-09-23: the tool does more than "take most of" the headroom. At about 244 it exceeds the 183 schema headroom on its own, and still would at the ~211 left once the pending deletion merge lands. A minimal bullet (~27 to 30) could fit the prompt's 48, but a full one (~50) would not. The conclusion stands.) The chat Coach doesn't need one, because `set_reminder` is already that tool and is already paid for.

### Money

- The daily pass already costs about $0.65 a month.
- The recommendation adds at most **the evening pass (about $0.65 a month)** and **about $0.02 per check-in tap**.
- Every call runs while he has the app open.
- Side note: `src/lib/ai/cost.ts` still prices Sonnet 5 at its introductory $2/$10. That ended 2026-08-31, and the file's own REVISIT note says to change it to $3/$15. (checked 2026-09-23: **wrong.** Anthropic's pricing page now says the $2/$10 announced as introductory pricing through 2026-08-31 "is now the standard price". The scheduled 2026-09-01 increase to $3/$15 "will not occur". `cost.ts` prices Sonnet 5 correctly. What is stale is its REVISIT comment, and acting on it would overstate Sonnet by 50%, which is the error the comment itself warns about. The fix is to delete the REVISIT note, not to change the price. The Haiku 4.5 rates used in §3 ($1/$5, 1-hour write $2, read $0.10) match the same page.)

### Build order

1. **(c)** on its own branch, gated like the others: `tsc`, `db:validate`, `db:test`, `expo export`, lint. It includes the total-cap guard, which is owed anyway.
2. **The tap upgrade for (a)**, plus the `checkin` flag if Q5 is yes.
3. **The doorbell**, if he wants it, with the check-in pass sequenced after the Health sync (checked 2026-09-23: without that, it does not deliver the "seen the night" word that justifies it).

All three are JS plus one migration, so they can ship in one EAS build.

---

## 5. Questions for the owner

1. **May the Coach schedule a notification without asking you first?** Recommended: **yes, at most 2 per day.** Each one is listed and cancellable on the Coach tab and recorded in the thread. A confirmation card only exists while you're in the app, and a Coach that has to ask permission to nudge you is not sending you anything.
2. **Quiet hours?** Recommended: **21:30 to 07:00**, editable in Settings › Coach. Reminders you set yourself and protocol items are exempt.
3. **What may a nudge show on the lock screen?** Your Face ID lock guards the app, not the lock screen. Recommended: **the Coach's line in full.** The model is told to keep numbers out of it, and iOS's own *Show Previews: When Unlocked* for ARC is the switch if you want it hidden. The alternative is a generic "Coach has a note" every time.
4. **Allow a second, evening pass so the Coach can plan tomorrow?** It is the first open after 18:00 and costs about $0.02 a day. Recommended: **yes.** Without it, nudges are planned in the morning, a day ahead of when they matter.
5. **When you tap a check-in ("check in tonight about the knee"), should the Coach speak first?** That is one Haiku call, about $0.02, and only while you're there. Recommended: **yes, for check-ins only.** A plain reminder like the creatine one just opens with "Talk about this".
6. **Do you want a Reminders screen**, where you'd see everything that will buzz and could move one? That would also let the Coach move reminders under the parity rule. Recommended: **not yet.** "Move it to 4" costs two cards today. Build the screen the first time that annoys you.
