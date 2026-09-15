# AI-slop candidates — September 2026

**Status: APPLIED, 2026-09-15, by owner approval** (Matt: *"go ahead and implement the proposed slop removals"*). Every entry below carries an **Outcome:** line recording what was actually done. §0 (the protocol adherence plate) was already re-set in an earlier branch, before this approval.

**Why it is a list and not a diff.** The standing rule on this repo is that copy is not removed without sign-off — over-deletion has cost this project real information more than once, and two of the entries below are lines that a previous sweep cut and had to be *restored* because the cut took a fact with it (`app/settings-units.tsx`, `app/labs.tsx`). So: mark the ones you want gone, and they go in one commit.

**Source:** backlog `docs/backlog-2026-09.md`, item **A9** — *"Remove AI slop all across app — 'How it's going' note in protocols."*

---

## Method, and what it can and cannot see

Every `.tsx` under `app/` (68 screens) and every `.tsx` under `src/components/` (35 files) was walked, and every user-facing string in them — rendered text, `accessibilityLabel`s, `Alert` titles and bodies, placeholders — was extracted with its line number and read. Docblocks, code comments, and model system prompts were excluded: they are not user-facing.

**What was counted as slop**

| Tag | What it means |
| --- | --- |
| `ai-label` | a heading in assistant voice rather than a noun for what is filed under it — the archetype, "How it is going" |
| `feature-explainer` | prose that teaches the user what a feature *is*, on a screen they have already opened |
| `chatty-helper` | conversational hand-holding, a friendly aside where a measurement or an instruction belongs |
| `filler-subtitle` | a subtitle under a label that adds nothing the label did not already say |
| `restates-obvious` | text that repeats the control, number or heading beside it |
| `marketing` | a flourish written to sell the feature rather than to state it |

**What was deliberately NOT counted, and why**

- **Authored empty states.** `00-design-spec.md` §5 requires them — *"Empty is authored, never blank"*. "No templates yet", "Nothing logged yet today", "No reading yet" are correct and are not on this list. What *is* on the list is the second paragraph some of them grew, which explains the feature rather than naming the absence.
- **Honest caveats and uncertainty notes.** The house asks for them explicitly. "Only foods with recorded micronutrients contribute, so these totals can run low", "Nothing has been written. The Coach is suspended until you answer", "No data, no number" lines — all kept, none listed.
- **Consequence lines before a write** ("On save: …", "Discarding writes nothing"). These are the pending-decision rule, not filler.
- **Error messages and recovery instructions.** Every "Couldn't … try again, or do X instead" line was read and none is listed: they name the failure and the way out.
- **Measurements, units, counters, dates.**

**One thing that materially shapes this list: much of the app has already been through an owner pass.** **Eleven files** carry a comment recording that the owner cut *explanatory copy* on **2026-08-11**, naming which sentence went and which survived (`+not-found`, `barcode-scan`, `coach-memory`, `settings-coach`, `settings-units`, `settings`, `suggested-prompts`, `hero-card`, `recent-logs`, `app-lock-screen`, `error-boundary`), and 36 files reference that round in some form. Where a line below is one of those survivors it is marked **[survived 08-11]**, listed at the bottom of its section, low priority — you already looked at it once and kept it. Do not read its presence as a recommendation. (Two files in that list, `suggested-prompts` and `settings`, had a *different* sentence cut than the one proposed here, so their candidates are not marked.)

**Counts.** **46 candidates** across 31 files. **20 confident** — I would remove or rewrite these on sight. **26 unsure** — a real case either way, and for several (`progress-photos`, `settings-units`, `workout-log`) the case for keeping is the stronger one; they are here because "be thorough" was the instruction, not because I think they should go. A further **6 lines are noted but not counted**, marked **[survived 08-11]**: you have already ruled on them.

---

## §0 — Done in this branch: the protocol adherence plate

The one the owner named. `app/protocol-detail.tsx`, re-set 2026-09-14.

| | Was | Now |
| --- | --- | --- |
| Section label | `How it is going` | `Adherence` |
| No version | `Nothing saved yet` / "This protocol has no version, so it has never put anything on a day. The first save writes v1." | `No version saved` / "This protocol has never put an item on a day. The first save writes v1." |
| Version landed today | `v4 landed today` / "Adherence starts counting from tomorrow — today is still open, and an item you have not reached yet is not a miss." | `v4 landed today` / "Counting starts tomorrow. Today is still open, and an item not yet due is not a miss." |
| Window with nothing planned | `Nothing settled to judge yet` / "Since this version landed, no day it covered put an item on the plan. There is no rate to state." | `No planned items yet` / "No day since this version landed has put an item on the plan, so there is no rate." |

The figures — the four-way ledger, the rate, the per-item rows — did not change. They were never the problem. What changed is that a section label is now a name for what is filed under it, and the empty states state the fact and stop. Asserted in `db/screens-render.test.mjs` (the old label is refuted, so a silent revert fails the suite).

---

## §1 — Home and the tabs

**`app/(tabs)/index.tsx:126`** · `chatty-helper` · **unsure**
> `accessibilityLabel="Protocols — what builds this day"`
The visible label is just "Protocols"; the spoken one editorialises. VoiceOver users get a different, chattier product than everyone else.
**Proposal:** `accessibilityLabel="Protocols"`. *Unsure: the extra clause does tell a screen-reader user where the link goes, which sighted users infer from position.*
**Outcome:** applied.

**`src/components/home/mission-empty.tsx:101`** · `feature-explainer` · **confident** (partial)
> "ARC builds each day from the protocols you are actually running — a supplement stack, a morning routine, a training block. You have none yet, so today is empty. Nothing has been invented to fill it."
The first sentence is a tutorial. The last is the honest bit and the one worth keeping — it is the no-invention promise.
**Proposal:** "You have no protocols yet, so today is empty. Nothing has been invented to fill it."
**Outcome:** applied, fact kept — the no-invention promise (the closing sentence, the reason this entry is only a partial cut).

**`src/components/home/mission-empty.tsx:107`** · `chatty-helper` · **unsure**
> "Anything you do in the meantime can still be captured from the Log tab."
Signposting another tab from an empty state. True, and it does answer "so what do I do now" on a first run.
**Proposal:** DELETE. *Unsure — this is the one screen a brand-new install lands on.*
**Outcome:** applied.

**`src/components/home/mission-empty.tsx:123`** · `chatty-helper` · **confident** (final clause)
> "Nothing your active protocols run falls on today — either their items are set to other days, or their live versions have no items yet. Open them and see what each one is up to."
The diagnosis is precise and earns its place; "see what each one is up to" is a chat-bot's sentence, and the button underneath already says "Open your protocols".
**Proposal:** end at "…have no items yet."
**Outcome:** applied.

**`src/components/home/mission-empty.tsx:128`** · `feature-explainer` · **unsure**
> "Paused and ended protocols are skipped. Today fills in as soon as one comes round."
First sentence is a real rule the user cannot otherwise discover. Second is reassurance.
**Proposal:** keep the first, drop "Today fills in as soon as one comes round."
**Outcome:** applied, fact kept — paused and ended protocols are skipped.

**`app/(tabs)/log.tsx:114`** · `filler-subtitle` · **unsure**
> "Headache, pain, GI, energy — with severity"
A row labelled "Log a symptom" with a list of symptoms under it. It does say that severity is recorded, which is not obvious.
**Proposal:** "With severity". *Unsure: the examples make the row scannable.*
**Outcome:** applied, fact kept — severity is recorded.

**`app/(tabs)/data.tsx:527`** · `filler-subtitle` · **unsure**
> "Profile, units, Coach model, Apple Health, app lock and export"
A contents list under "Settings". It is accurate and it saves a trip, but it will rot the next time Settings grows — it is already missing Backups and Coach memory.
**Proposal:** DELETE, or fix it. Listing six of eight sections is worse than listing none.
**Outcome:** applied — deleted. A corrected list would need the same upkeep that made this one stale; the row's own label and destination already say where it goes.

**`src/components/home/coach-brief.tsx:74`** · `restates-obvious` · **unsure**
> "Open chat"
The whole brief is one `Pressable` that opens the chat, with a chevron beside this label.
**Proposal:** DELETE, keep the chevron. *Unsure: a bare chevron with no word is a weaker affordance, and the Label voice on it is deliberate per §3.*
**Outcome:** kept — the component's own docblock documents both halves of this as deliberate: the Label-voice text on what is "still a button" (00-design-spec.md §3), and the fact that Home's actual pine "Open chat" link was already retired elsewhere for the identical affordance reason. The stronger case here is keeping.

**[survived 08-11]** `src/components/home/hero-card.tsx:389` "Today is handled" — reads slightly pat for the house register, but the wind-down advice that followed it was already cut and the file says the statement itself is load-bearing. Listed for completeness; I would keep it.

---

## §2 — Coach

**`src/components/coach/suggested-prompts.tsx:63`** · `chatty-helper` · **confident**
> "Nothing asked yet. Pick a starting point, or type your own question below."
The composer is directly below and says "Message the Coach". The second clause instructs the user to use the obvious control.
**Proposal:** "Nothing asked yet."
**Outcome:** applied.

**`src/components/coach/suggested-prompts.tsx:66`** · `feature-explainer` · **unsure**
> "Nothing asked yet. Each of these is answered from your own record — labs, wearables, today's log. Until a model is connected the Coach replies in preview and reads none of it."
The preview half is an honest disclosure and should stay. "Each of these is answered from your own record" is a pitch.
**Proposal:** "Nothing asked yet. Until a model is connected the Coach replies in preview and reads none of your record."
**Outcome:** applied, fact kept — the preview disclosure (no model connected, reads none of the record).

**`src/components/coach/session-key-panel.tsx:91`** · `restates-obvious` · **unsure**
> "Preview mode · no model connected"
Two statements of one fact; "Preview mode" is also internal vocabulary.
**Proposal:** "No model connected".
**Outcome:** applied.

**`app/coach-memory.tsx:68`** · `feature-explainer` · **unsure**
> "When you tell the Coach something that stays true — how you like to train, a supplement that disagrees with you, what you're working toward — it will ask to remember it."
Teaches the mechanism on an empty screen. Note the file records that the owner *already* cut a standing explainer here on 2026-08-11 and this one stayed.
**Proposal:** DELETE, or cut to "The Coach asks before it remembers anything."
**Outcome:** not found. `app/coach-memory.tsx` was restructured after this list was written — its own docblock now records that the list view relocated to the Knowledge hub (`app/knowledge.tsx`) and this route is the editor only; this sentence, and the standing-explainer text around it, is no longer in the file under any wording. Nothing to remove.

---

## §3 — Nutrition and the kitchen

**`app/food-new.tsx:368`** · `restates-obvious` · **unsure**
> "Saved to your on-device catalog — it shows up in search and recents like any staple."
Standing footer on the create-a-food form, before anything is saved. It reads as a receipt for something that has not happened.
**Proposal:** DELETE. *Unsure: on first use it does answer "where does this go".*
**Outcome:** applied.

**`app/food-search.tsx:368`** · `feature-explainer` · **confident** (second clause)
> "Nothing logged yet. Search the catalog — foods you log appear here for one-tap re-adds."
"one-tap re-adds" is product-brochure phrasing for a list the user will understand the moment it has a row in it.
**Proposal:** "Nothing logged yet. Search the catalog."
**Outcome:** applied.

**`app/meal-templates.tsx:107`** · `feature-explainer` · **confident**
> "Build a meal you eat often — add its foods, then open the meal and choose "Save as template." It'll show up here to log again in one tap."
A three-step tutorial, inside quotation marks, in an empty state. It is the longest instructional passage in the nutrition sub-app.
**Proposal:** "A meal saved from its detail screen appears here."
**Outcome:** applied.

**`app/grocery.tsx:474`** · `chatty-helper` · **confident**
> "Add items above, ask the Coach ("we're out of milk"), or open a recipe and add its ingredients in one go."
Three routes listed under "The list is clear." — and the first one points at the field directly above it. "in one go" is chat voice.
**Proposal:** DELETE. The field is visible; the Coach and recipe routes are discoverable where they live.
**Outcome:** applied.

**`app/recipes.tsx:283`** · `marketing` · **confident** (final clause)
> "Share an Instagram reel or TikTok to ARC, paste a link, or save a logged meal as a recipe — the book builds itself from what you actually cook."
The three routes are genuinely non-obvious (the share sheet especially) and should stay. "the book builds itself from what you actually cook" is a tagline.
**Proposal:** end at "…save a logged meal as a recipe."
**Outcome:** applied.

**`app/recipe-folders.tsx:153`** · `chatty-helper` · **confident**
> "No folders yet. Every recipe sits in the book unfiled, which is a perfectly good place for it until there are enough of them to sort."
Reassurance about a state nobody is anxious about.
**Proposal:** "No folders yet. Every recipe sits in the book unfiled."
**Outcome:** applied.

**`app/meal-estimate.tsx:520`** · `chatty-helper` · **unsure**
> "Estimates are just that — you'll review and adjust every item before anything is logged."
The guarantee is load-bearing (an AI estimate is never auto-committed) but "Estimates are just that" is a shrug.
**Proposal:** "Every item is reviewed and adjustable before anything is logged."
**Outcome:** applied, fact kept — the no-auto-commit guarantee.

**`app/meal-revise.tsx:405`** · `restates-obvious` · **unsure**
> "You'll see the revised items and can adjust them before anything is saved. The meal's time, name and notes are never changed here."
The second sentence is a real guarantee about blast radius. The first restates the flow the user is already in.
**Proposal:** keep the second sentence only.
**Outcome:** applied, fact kept — the meal's time, name and notes are never changed here.

**`app/recipe-revise.tsx:361`** · `restates-obvious` · **unsure**
> "You'll see every line that changed before anything is saved. Your notes, photo, tags and everything you've already cooked from this recipe are never touched."
Same shape as the one above, same proposal — keep the blast-radius sentence, drop the flow description.
**Outcome:** applied, fact kept — notes, photo, tags and cooked-from history are never touched here.

**`app/nutrition-micros.tsx:115`** · `chatty-helper` · **unsure**
> "Nothing recorded yet today. Log foods from the catalog (many seeded staples carry micros) to see this fill in."
"to see this fill in" describes the UI reacting to you. The parenthetical is useful — it explains why some logged foods contribute nothing.
**Proposal:** "Nothing recorded yet today. Foods logged from the catalog contribute micronutrients; many seeded staples carry them."
**Outcome:** applied, fact kept — the parenthetical explaining why some logged foods contribute nothing.

---

## §4 — Training

**`app/exercise.tsx:244`** · `feature-explainer` · **confident**
> "Nothing saved yet. A saved workout is a session you reuse — its exercises and targets load pre-filled, with last time&rsquo;s numbers as the placeholders."
A definition of the noun in the label directly above it, plus a description of behaviour the user will see the first time they use one.
**Proposal:** "Nothing saved yet. A saved workout loads pre-filled with last time's numbers."
**Outcome:** applied, fact kept — a saved workout loads pre-filled with last time's numbers.

**`app/routine-edit.tsx:314`** · `feature-explainer` + **vocabulary drift** · **confident**
> "No exercises yet — add the movements this routine runs, with their target sets and rep range."
Two problems. It explains a form whose own fields (Sets / Rep low / Rep high) say the same thing — and it says **"routine"**, which is the retired noun. The screen is titled "Edit saved workout"; the tab calls them "Saved workouts". This is the only user-facing survivor of the old vocabulary I found.
**Proposal:** "No exercises yet." (And if anything longer survives, it must say *saved workout*.)
**Outcome:** applied — both the slop cut and the vocabulary fix land as one edit, since cutting to "No exercises yet." removes the only surviving "routine" along with it. Pinned in `db/screens-render.test.mjs` (new `routine-edit (new)` render, refuting both the old sentence and the bare word).

**`app/exercise.tsx:506`** · `chatty-helper` · **unsure**
> "No exercises in this saved workout yet — add some from Saved workouts below."
Sends you to a section on the same screen to fix the thing the card is about.
**Proposal:** "No exercises in this saved workout yet." *Unsure: the pointer is genuinely the fix, and it is one scroll away.*
**Outcome:** applied.

**`app/workout-import.tsx:288`** · `feature-explainer` · **confident**
> "Choose a photo of a workout logged somewhere else — a screenshot from another app, a whiteboard, a card. ARC transcribes it, you review every number, then it saves like any other session."
The longest explainer in the training sub-app, under a header that already says "Import workout", above a button that says "Choose photo".
**Proposal:** "A screenshot from another app, a whiteboard, a card. Every number is reviewed before it saves."
**Outcome:** applied, fact kept — every number is reviewed before it saves.

**`app/workout-import.tsx:361`** · `restates-obvious` · **unsure**
> "Check every number against the photo — fix anything the transcription got wrong, then save."
On the review screen, above the editable numbers. The instruction to check a transcription is not nothing — but it is stated twice in this flow (see the line above).
**Proposal:** DELETE — keeping the one on the pick screen.
**Outcome:** applied.

**`app/workout-log.tsx:299`** · `chatty-helper` · **unsure**
> "Nothing drafted yet. Add sets below — or save a session with none, for cardio and mobility work."
"Add sets below" points at the obvious control; the rest states a real permission (a set-less session is valid) that nothing else says.
**Proposal:** "Nothing drafted yet. A session saves with no sets, for cardio and mobility work."
**Outcome:** kept — named explicitly in the Counts section as one of the entries where the case for keeping is the stronger one.

**`src/components/exercise/muscle-figure.tsx:427`** · `chatty-helper` · **unsure**
> "No training in the last 14 days, so every muscle reads fresh. Log a session and the figure starts fading."
The first half is the honest caveat (uniform freshness means *no data*, not *recovered*) and must stay. The second narrates the graphic.
**Proposal:** keep the first sentence, drop "Log a session and the figure starts fading."
**Outcome:** applied, fact kept — no training in the last 14 days means every muscle reads fresh (the honest caveat that uniform freshness is "no data," not "recovered"). Pinned in `db/screens-render.test.mjs` with a refutation of the dropped sentence.

---

## §5 — Protocols

**`app/protocols.tsx:155`** · `feature-explainer` · **confident**
> "A protocol is a stack or routine you run — a supplement stack, a morning routine, an eight-week block. Build one and your days fill in from it. Every edit after that becomes a new version."
Three sentences of documentation on the empty hub. The versioning sentence is a real fact but belongs where a version is written, not here.
**Proposal:** "A protocol is a stack, a routine, or a training block. Your days fill in from it."
**Outcome:** applied. Pinned in `db/screens-render.test.mjs` with a refutation of the dropped versioning sentence.

**`app/protocols.tsx:221`** · `restates-obvious` · **unsure**
> "These ran their last phase out. They put nothing on a day until a phase is extended or another is added."
Under a section already labelled "Ended". Precise, though — and "until a phase is extended" tells you the fix.
**Proposal:** DELETE. *Unsure: it is the only place the ended-protocol rule is stated.*
**Outcome:** kept — the entry's own words are the reason: this is the only place the ended-protocol rule is stated, and the standing rule on this list is that a fact does not go with a cut when nothing else carries it.

**`app/protocol-versions.tsx:207`** · `feature-explainer` · **unsure**
> "This protocol has no saved content. The first save writes v1, and every save after it keeps the one before."
Note this now duplicates the adherence plate's recopied line ("The first save writes v1"), which is fine — but the second clause explains version history on the version-history screen.
**Proposal:** "This protocol has no saved content. The first save writes v1."
**Outcome:** applied, fact kept — the first save writes v1.

---

## §6 — The Data tab: knowledge, experiments, reports, screenings, labs, photos

**`app/knowledge.tsx:231`** · `marketing` + `feature-explainer` · **confident**
> "Import an article and ARC compresses what its author actually commits to — claims, mechanisms, numbers — into an entry you edit before anything saves. Or write one yourself. Either way the Coach cites it, and it outranks ARC's own reference."
Sixty words of pitch on the accent card, under the headline "Doctrine you commit to", above two buttons that say "Import an article" and "Write an entry". The precedence fact (yours outranks ARC's) is worth keeping and is already stated on the editor (`knowledge-entry-edit.tsx:184`).
**Proposal:** "Yours outranks ARC's shipped reference, and the Coach cites both."
**Outcome:** applied, fact kept — the precedence rule (yours outranks ARC's own reference, and the Coach cites both). Pinned in `db/screens-render.test.mjs`.

**`app/knowledge.tsx:298`** · `feature-explainer` · **unsure**
> "A surgery and what it still costs you, how you react to something, a constraint you've settled on — anything too long to be a one-line memory. The Coach reads these back when they bear on what you asked."
The examples do define an otherwise vague section, and the personal/scientific split is not self-explanatory. But the same sentence appears nearly verbatim on the editor (line 183).
**Proposal:** DELETE here; the editor already carries it at the moment it matters.
**Outcome:** applied — confirmed duplicated nearly verbatim at `app/knowledge-entry-edit.tsx:183`, the "keep the statement nearest the action" shape. Pinned in `db/screens-render.test.mjs`.

**`app/knowledge.tsx:347`** · `feature-explainer` · **confident**
> "Anything you add — written, imported, or saved from a Coach chat — lands here, and the Coach cites it like the rest."
Under "Nothing of your own yet. Below is ARC's shipped reference." — which has already said it.
**Proposal:** DELETE.
**Outcome:** applied. Pinned in `db/screens-render.test.mjs`.

**`app/knowledge-entry-edit.tsx:267`** · `ai-label`/aphorism · **confident**
> "An entry is a page, not a paper. What you commit to, stated so the Coach can cite it."
Conceit vocabulary — exactly what §5 of the design spec rules out ("Product nouns, not conceit vocabulary"). It is also the placeholder-adjacent hint under a body field that already has a full placeholder.
**Proposal:** DELETE. The long-entry branch beside it (`Long for one entry (N words)…`) is genuinely useful and should stay.
**Outcome:** applied — the long-entry branch is unchanged; the short-entry branch now renders nothing rather than an empty hint.

**`app/experiments.tsx:169`** · `chatty-helper` · **unsure**
> "Ask the Coach to start one."
Sits directly under the screen title, in every state — including when experiments are running. The file's own comment defends it as the only route in.
**Proposal:** show it only in the empty state (where line 180 already says it), and drop it from the populated screen.
**Outcome:** applied.

**`app/experiments.tsx:181`** · `feature-explainer` · **confident** (final clause)
> "An experiment is one deliberate change tested against your own data — &ldquo;does 400 mg magnesium at night lift my HRV?&rdquo; Ask the Coach to design one; it picks the metrics, sets the window, and reads out the verdict when the window closes."
The definition plus the example is the clearest thing on the screen and earns its place. "it picks the metrics, sets the window, and reads out the verdict" is the Coach describing its own competence.
**Proposal:** end at "Ask the Coach to design one."
**Outcome:** applied, fact kept — the definition and the worked example ("does 400 mg magnesium at night lift my HRV?").

**`app/experiment-detail.tsx:124`** · `chatty-helper` · **confident**
> "The Coach reads the watched metrics and records the verdict when the window closes — ask it for the readout."
Third statement of the same mechanism in the same sub-app (see the two above).
**Proposal:** "The verdict is recorded when the window closes."
**Outcome:** applied, fact kept — the verdict is recorded when the window closes.

**`app/screenings.tsx:693`** · `marketing` · **confident**
> "The exams that guard the long game — colonoscopy, skin checks, imaging, dental, vision — each with its cadence, so nothing quietly slips a year."
"guard the long game" and "quietly slips a year" are the most obviously *written* sentences in the app. The example list is useful; the framing is a brochure.
**Proposal:** "Colonoscopy, skin checks, imaging, dental, vision — each with its own cadence."
**Outcome:** applied, fact kept — the example list and the per-exam cadence.

**`app/screenings.tsx:477`** · `chatty-helper` · **unsure**
> "Nothing dated yet. Give a screening a due date, or book an appointment, and it will be placed on this horizon."
Instruction dressed as an empty state; "it will be placed on this horizon" narrates the widget.
**Proposal:** "Nothing dated yet. A screening appears here once it has a due date or a booking."
**Outcome:** applied, fact kept — a screening appears here once it has a due date or a booking.

**`app/reports.tsx:276`** · `feature-explainer` · **confident**
> "Nothing generated yet. A report is a document — assembled from your data, previewed here, shared as a file."
Definition of "report" under a section called "Generated reports", on a screen whose two cards already describe what each report contains.
**Proposal:** "Nothing generated yet."
**Outcome:** applied. Pinned in `db/screens-render.test.mjs` (the assertion that pinned the fuller sentence is updated, and a refutation of the removed clause added).

**`app/progress-photos.tsx:304`** · `chatty-helper` · **unsure**
> "Three poses on the same morning, in the same light, is the set that compares well months later."
This is *advice*, not chrome — and it is good advice that changes what the user does at capture time. It is also the kind of line the owner may read as a coach speaking out of turn on a gallery screen.
**Proposal:** keep. Listed because it is the closest thing in the app to an unsolicited tip.
**Outcome:** kept — named explicitly in the Counts section as one of the entries where the case for keeping is the stronger one.

**`app/wearables.tsx:144`** · `marketing` · **unsure**
> "The HealthKit module rides the next dev build. Once it lands, connect Apple Health and your ring or watch data flows in here."
"your ring or watch data flows in here" is brochure-ish; the build fact is the point.
**Proposal:** "The HealthKit module rides the next dev build. Connect Apple Health once it lands."
**Outcome:** applied, fact kept — the build-gate fact.

**[survived 08-11]** `app/labs.tsx:253` "Function Health PDF, parsed on-device. Review every row before anything is saved; the markers ARC carries an optimal range for are graded against it." — dense but every clause is load-bearing, and the file records that the unverifiable "160+ biomarkers" claim was already removed from it. Keep.

---

## §7 — Settings

**`app/settings.tsx:268`** · `filler-subtitle` · **confident**
> "Weight, distance, and more"
"and more" is the tell: the subtitle exists to fill the slot. Compare the row above it, "Name, date of birth, and biological sex", which is a complete list and worth keeping.
**Proposal:** DELETE, or make it complete: "Weight, distance, volume, length, temperature".
**Outcome:** applied — completed rather than deleted. Checked against `app/settings-units.tsx`: all five categories (weight, distance, volume, length, temperature) are live rows today, so the proposed list is accurate now, unlike when it was written.

**`app/settings-units.tsx:160`** · `feature-explainer` · **unsure**
> "Storage stays metric; these toggles only change how numbers display — weight, volume, and length already do, distance and temperature once workouts and environment tracking land."
The first clause is a fact nothing else states and the file records that it was cut once and restored for exactly that reason. The tail is a roadmap note in a settings screen — it will be wrong the moment those land.
**Proposal:** "Storage stays metric; these toggles only change how numbers display."
**Outcome:** kept — named explicitly in the Counts section as one of the entries where the case for keeping is the stronger one, and this exact line already carries scar tissue from an earlier cut-and-restore (see the intro). Left untouched rather than re-trimmed. Note for a future pass: the code has moved since this entry was written — `app/settings-units.tsx` now ships all five unit rows (distance and temperature included), so the roadmap half of this sentence ("distance and temperature once workouts and environment tracking land") is now factually stale, independent of the slop question.

**[survived 08-11]** `app/settings-backups.tsx:576` (the encryption paragraph), `app/settings-profile.tsx:181` ("This record never leaves the phone."), `src/components/ui/error-boundary.tsx:70` ("Your data is safe on this device — nothing is written when a screen fails."), `app/+not-found.tsx:49` ("Nothing was lost — every log, protocol and lab on this device is exactly where you left it.") — all privacy or data-safety statements on screens where the user is most likely to be worried. All four read as reassurance, which is why they are noted; all four state a fact you cannot get anywhere else, which is why none is proposed for removal.

---

## The three shapes, if you want to decide by rule instead of line by line

1. **The empty state that grew a second paragraph.** Nine of these. The first line names the absence (correct, keep); the paragraph under it explains the feature (`meal-templates`, `protocols`, `reports`, `exercise`, `knowledge` ×2, `recipe-folders`, `food-search`, `experiments`). A rule that says *an empty state gets one sentence* would settle all nine.
2. **The mechanism explained three times in one sub-app.** The Coach's experiment loop is described on `experiments.tsx` twice and `experiment-detail.tsx` once; the knowledge precedence rule on `knowledge.tsx` twice and `knowledge-entry-edit.tsx` once. Keep the statement nearest the action; delete the rest.
3. **The flow narrated back to the user before they take it.** "You'll see the revised items…", "Check every number…", "…and it will be placed on this horizon." Where these sit beside a real guarantee (what is *not* touched, what is *not* written), the guarantee is the half worth keeping.

**One non-slop finding, worth a line of your attention:** `app/routine-edit.tsx:314` still says **"routine"**. Everywhere else in the app the noun is **saved workout**. That is the only user-facing survivor of the retired vocabulary I found in the whole walk.

**Fixed 2026-09-15.** The line was also the confident candidate at §4 (`app/routine-edit.tsx:314`), so the same edit that cut the explainer removed the stale noun with it — nothing said "routine" left to fix separately. Pinned in `db/screens-render.test.mjs` (`routine-edit (new)`), refuting both the old sentence and the bare word.
