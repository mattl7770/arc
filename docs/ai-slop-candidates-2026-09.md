# AI-slop candidates — September 2026

**Status, 2026-09-23 (later): a fourth walk (§11), before the next build, applied 14 entries covering 19 string sites: the round-1 and round-2 builds, three screens no walk had read whole, and four key gates that still carried a tail the walk cut elsewhere. It confirmed all five lines an independent verifier flagged. Same approval, same fact-keeping rule; 13 of the 14 kept a fact. 3 more are held for the owner (§11.G).**

**Status, 2026-09-23: a third walk (§10) applied 28 more entries covering 39 string sites the first two walks could not reach, most of them built in `src/lib` rather than written in a screen. The same blanket approval and the same fact-keeping rule applied. 4 are held for the owner (§10.G).** The 2026-09-19 status below still describes §0–§9.

**Status: FULLY APPLIED, 2026-09-19, by owner approval of the WHOLE list** (Matt: *"Execute the full AI slop candidate list, we can always add stuff back later if we need to."*). This supersedes the partial approval below.

A first pass applied 40 of the 46 candidates on **2026-09-15** (Matt: *"go ahead and implement the proposed slop removals"*) and **kept five** on the list's own argument — `progress-photos`, `settings-units`, `workout-log`, the ended-protocol rule on `app/protocols.tsx`, and the `Open chat` label on `src/components/home/coach-brief.tsx`. The owner has overruled that judgement. Every one of the five is now applied; each carries a second **Outcome (2026-09-19):** line saying what happened to the fact it was carrying. §0 (the protocol adherence plate) was re-set in an earlier branch, before either approval.

**The rule that survives the blanket approval:** *never take a FACT with the cut.* "We can always add stuff back later" licenses removing COPY, not removing information that exists nowhere else. Where a cut would have dropped a measurement, a unit, a consequence-of-save line, an honest caveat or the way out of an error, the fact was kept and the filler alone went — those entries say `applied, fact kept — <what>`. Where a kept entry's own argument was that it stated a fact with no other home, the fact was moved to where it belongs rather than deleted, and the Outcome says where it went.

**Nine new entries** were found by re-walking the app on 2026-09-19 under the same method, and are filed as **§8 — Found on the second walk**. The `not found` entry in §2 was re-checked and reopened: the sentence had *moved*, not gone.

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

**Counts, revised 2026-09-19.** **55 candidates** across 38 files: the original 46, plus **9 found on the second walk** and filed as §8. All 46 originals are now applied, including the five the first pass kept and the one it recorded as `not found` — that one had *moved*, and was applied where it had moved to. Of the 6 noted-but-not-counted lines, **all 6 were re-read and all 6 kept**: each is already one sentence carrying one fact, and §7's Outcome says why for each. **One line was judged too risky to trim and is flagged rather than cut** (`settings-backups.tsx:576`). A further **7 lines read on the second walk were deliberately not cut**, listed in §9 with reasons. **Across all 55 applied entries, 27 are `applied, fact kept` — no entry on this list removed a fact that exists nowhere else.**

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
**Outcome (2026-09-19):** applied — the words are gone, the chevron stays. **No fact went with it:** the block is one `Pressable` whose `accessibilityLabel` reads "Open the full Coach conversation", so the destination is still spoken to a screen-reader user and still visible as a chevron to everyone else. The docblock paragraph that defended the neutral-ink link was rewritten to record why the words went. Refuted on the `home` render in `db/screens-render.test.mjs`.

**[survived 08-11]** `src/components/home/hero-card.tsx:389` "Today is handled" — reads slightly pat for the house register, but the wind-down advice that followed it was already cut and the file says the statement itself is load-bearing. Listed for completeness; I would keep it.
**Outcome (2026-09-19):** kept, re-examined under the blanket approval. It is the *headline* of a completion stamp (22px serif, under a stamped check), not a sentence in an empty state — `00-design-spec.md` H-02 authors this exact state and names it. Below it, "Nothing left on the list." is the one sentence shape 1 asks for. There is no second paragraph to cut: the wind-down advice that was the actual slop here went on 2026-08-11. Cutting either of the two surviving lines would leave a bare check mark with no statement of what is complete.

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
**Outcome (2026-09-19):** **reopened and applied — it had moved, not gone.** Re-checking under any wording found it rewritten at `app/knowledge.tsx:341–345`, in the Coach-memory empty state: *"One line each, carried into every turn — how you like to train, something that disagrees with you, what you're working toward. Write one yourself, or tell the Coach and it will ask to keep it."* Same sentence, same job, new address. Cut to **"Write one yourself, or tell the Coach and it will ask to keep it."**
*Fact kept —* the consent fact (nothing is remembered without being asked), which is the Proposal's own fallback sentence and is stated nowhere else. *Facts NOT lost by the cut —* "one line each, carried into every turn" is the editor's own sentence at `app/coach-memory.tsx:138–142` ("The Coach carries this in every single turn, so keep it to a line"), stated where the line is being written; the examples were a tutorial. This is the "keep the statement nearest the action" shape. Pinned in `db/screens-render.test.mjs` (`knowledge hub (no memories)`), with both halves of the old sentence refuted.

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
**Outcome (2026-09-19):** applied, **fact kept — a session saves with no sets, for cardio and mobility work.** That permission is the half nothing else in the app states, and it survives verbatim; what went is "Add sets below", the pointer at the control immediately underneath. No render covers `app/workout-log.tsx`, so there is no assertion to update and none to add.

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
**Outcome (2026-09-19):** applied — and **the premise was wrong**. The ended-protocol rule is *not* stated only here. `app/protocol-detail.tsx:120–128` already carries it, in a fuller form, on the screen where the fix is taken: *"This protocol has ended. Its last phase ran out on {date}. It puts nothing on a day until you extend a phase or add another."* That version adds the date and sits beside the Edit control that extends the phase, so **the fact did not move — it was already where it belongs**, and the hub line was the duplicate. This is shape 2 (a mechanism stated twice; keep the one nearest the action). The hub's "Ended" section label and its count are untouched. *No test assertion changed and none added: no render in `db/screens-render.test.mjs` reaches an ended protocol, so a refutation there would be vacuous. Flagged rather than faked.*

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
**Outcome (2026-09-19):** applied — deleted. **No fact went with it.** The pose set it recommended is already named in the sentence directly above, which survives untouched: *"No photos yet. Photograph yourself in the iOS Camera app — front, side, back — then bring them in here. ARC keeps a working copy; your originals stay in Photos."* What went is the advice about morning and light — capture technique, not a measurement, a unit, a consequence or a caveat, and the one line in the app the list itself called "the closest thing to an unsolicited tip". This is also shape 1: the empty state is back to one authored statement. Refuted on `progress photos (empty)` in `db/screens-render.test.mjs`. *(The shorter sibling `app/progress-photos.tsx:349`, "Pick two photos to compare. Same pose reads best.", was NOT cut — see §9.)*

**`app/wearables.tsx:144`** · `marketing` · **unsure**
> "The HealthKit module rides the next dev build. Once it lands, connect Apple Health and your ring or watch data flows in here."
"your ring or watch data flows in here" is brochure-ish; the build fact is the point.
**Proposal:** "The HealthKit module rides the next dev build. Connect Apple Health once it lands."
**Outcome:** applied, fact kept — the build-gate fact.

**[survived 08-11]** `app/labs.tsx:253` "Function Health PDF, parsed on-device. Review every row before anything is saved; the markers ARC carries an optimal range for are graded against it." — dense but every clause is load-bearing, and the file records that the unverifiable "160+ biomarkers" claim was already removed from it. Keep.
**Outcome (2026-09-19):** kept, re-examined. Three clauses, three facts, no filler between them: *parsed on-device* (where the data goes — CLAUDE.md §2), *review every row before anything is saved* (the no-auto-commit guarantee, the same one the list protected at `meal-estimate.tsx`), and *only markers with an optimal range are graded* (the honest caveat that an ungraded row is not a passing row). Every clause is on the protected list at the top of this document. Nothing here is copy.

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
**Outcome (2026-09-19):** applied — now **"Storage stays metric; these toggles only change how numbers display."** **Fact kept — storage stays metric**, which is the clause the 2026-08-11 cut took and which had to be restored; it is untouched and it is the whole reason this line exists. The tail was not a second fact to protect but a *false* one: all five unit rows ship above it today, so "distance and temperature once workouts and environment tracking land" described a roadmap the screen had already overtaken. **Cutting it removed a wrong statement and a filler in the same edit** — the one case on this list where the slop and the staleness were the same words. The file's comment now records both the 2026-08-11 restore and this trim, so the next reader does not re-litigate either. No render covers `app/settings-units.tsx`; no assertion to update.

**[survived 08-11]** `app/settings-backups.tsx:576` (the encryption paragraph), `app/settings-profile.tsx:181` ("This record never leaves the phone."), `src/components/ui/error-boundary.tsx:70` ("Your data is safe on this device — nothing is written when a screen fails."), `app/+not-found.tsx:49` ("Nothing was lost — every log, protocol and lab on this device is exactly where you left it.") — all privacy or data-safety statements on screens where the user is most likely to be worried. All four read as reassurance, which is why they are noted; all four state a fact you cannot get anywhere else, which is why none is proposed for removal.
**Outcome (2026-09-19):** all four kept, each re-read line by line against the blanket approval. Each is already **one sentence carrying one fact**, with nothing around it to cut:
- `settings-profile.tsx:242` "This record never leaves the phone." — seven words, and CLAUDE.md §2's first non-negotiable. The file records that it was cut once and restored *because* the sweep left the app asserting local-first ownership nowhere. Cutting it a second time would repeat a known mistake.
- `error-boundary.tsx:70` "Your data is safe on this device — nothing is written when a screen fails." — the second clause is the fact (a crash is not a partial write) and the first is what makes it legible at the moment a person is worried. The two sentences that *were* slop here — one restating the headline, one restating the button — went on 2026-08-11.
- `+not-found.tsx:49` "Nothing was lost — every log, protocol and lab on this device is exactly where you left it." — same shape, same round; the restatement of the headline is already gone.
- `settings-backups.tsx:576` (the encryption paragraph) — the only one of the four with more than a sentence, and the one place I stopped. Four clauses, four distinct facts: *encrypted before it is written* (when), *the encrypted file is the only thing that reaches iCloud* (what leaves), *Apple stores bytes it cannot read; ARC keeps the key* (**who holds the key — not a restatement of "encrypted"; it is the custody fact, and it is stated nowhere else in the app**), and *photos are not included, the originals are in Photos, which has its own backup* (the scope gap and why it is safe). This paragraph is the user-facing form of the architecture CLAUDE.md §2 and `docs/backups-subapp.md` are built on. **Judged too risky to trim; flagged rather than cut silently — the owner can still overrule.**

---

## §8 — Found on the second walk (2026-09-19)

The app was walked again under the same method — every `.tsx` under `app/` and `src/components/`, every rendered string, `accessibilityLabel`, `Alert` title and body, and placeholder, with docblocks and system prompts excluded. Nine lines the first walk missed. All nine are applied; each says what the first walk would have tagged it.

**`app/reports.tsx:320`** · `ai-label`/aphorism · **confident**
> "Raw data export — everything, as one JSON file — lives in Settings › Security & data. **A report is a document for a reader; the export is the data itself.**"
The first sentence is the fact and the route. The second is the same conceit shape `00-design-spec.md` §5 rules out and the same one that took `knowledge-entry-edit.tsx:267` ("An entry is a page, not a paper") in the first round — an aphorism explaining a distinction the two destinations make for themselves.
**Proposal:** end at "…Security & data."
**Outcome:** applied, **fact kept — the route** (raw export lives in Settings › Security & data, and it is one JSON file). `db/screens-render.test.mjs` already asserted the route clause; a refutation of the aphorism was added, and the stale comment claiming the clause "survives, unrelated, further down this screen" was corrected.

**`app/settings-coach.tsx:184`** · `marketing` · **confident**
> "Sonnet handles this workload **at near-Opus quality for a fraction of the cost**; Opus is **worth it** for deep, whole-history analysis."
Vendor-brochure register — the most obviously *sold* sentence left in the app, in the house's own voice about someone else's product.
**Proposal:** "Sonnet is the cheaper of the two; Opus is stronger on deep, whole-history analysis."
**Outcome:** applied, **fact kept — the choice itself** (Sonnet costs less; Opus is the one for deep, whole-history work), which is a real decision aid on a picker where the user is billed directly. The billing fact stays where it belongs, on the key row above ("pay-as-you-go, billed to you"). No render covers this screen.

**`src/components/home/metrics-strip.tsx:116`** · `chatty-helper` · **confident**
> "No readings yet today. Connect Apple Health in Settings **to populate this**."
The tail narrates the widget reacting to you.
**Proposal:** "No readings yet today. Connect Apple Health in Settings."
**Outcome:** applied, **fact kept — the route in** (Apple Health, in Settings), which is the only way this strip ever fills. *No refutation added: the component's own docblock records that this branch is defensive and unreachable from today's caller, so an assertion on it would be vacuous.*

**`app/water.tsx:397`** · `chatty-helper` · **confident**
> "No water logged yet. **Tap an amount below and the record starts.**"
Points at the quick-add row three lines under it, then narrates what happens when you use it.
**Proposal:** "No water logged yet."
**Outcome:** applied. No fact lost — the quick-add row is on the same screen and labelled. Pinned and refuted on `water (never logged)`.

**`app/water.tsx:535`** · `restates-obvious` · **confident**
> "Nothing logged today. **Anything you add appears here to correct or remove.**"
Describes rows the first entry shows for itself; the sibling branch ("Nothing was logged on {date}.") is already one sentence.
**Proposal:** "Nothing logged today."
**Outcome:** applied. Shape 1. Pinned and refuted on `water (never logged)`.

**`app/exercise.tsx:530`** · `chatty-helper` · **confident**
> "Nothing logged yet — **start a workout above.**"
The identical archetype to `app/exercise.tsx:506` in §4, in the same file, missed the first time: an empty state that sends you to the control directly above it.
**Proposal:** "Nothing logged yet."
**Outcome:** applied. Refuted on `exercise hub (never trained)`.

**`app/workout-live.tsx:1209`** · `chatty-helper` · **confident**
> "Nothing logged yet. **Add the first exercise to start recording sets.**"
Same archetype again; the "Add exercise" button is ~55 lines below in the same view. The sibling branch ("This session has no sets left. Save to keep it empty, or delete it.") states two real options and is untouched.
**Proposal:** "Nothing logged yet."
**Outcome:** applied. No render covers `app/workout-live.tsx`.

**`src/components/exercise/exercise-picker.tsx:457`** · `chatty-helper` · **confident**
> "**Not one of these?** ARC doesn't have a close match."
A rhetorical question in assistant voice — and the branch beside it, for a search with no results at all, is already a plain statement ("ARC doesn't have this one."). The two branches now match.
**Proposal:** drop "Not one of these? "
**Outcome:** applied, **fact kept — the review guarantee** in the sentence that follows it ("AI can write the catalog entry — you review it before it's saved") is untouched. No render covers this component.

**`app/exercise-detail.tsx:312`** · `chatty-helper` · **confident**
> "Log a couple of weighted sessions and **the estimated-1RM trend appears here.**"
Narrates the chart's arrival. The requirement behind it is real and precise — the chart is gated on `series.length >= 2`, and only weighted sets produce a point.
**Proposal:** "An estimated-1RM trend needs two weighted sessions."
**Outcome:** applied, **fact kept and sharpened — two weighted sessions**, which is the actual gate; "a couple" was vaguer than the code. Newly pinned on `exercise detail` (which has exactly one session on record), with the old wording refuted.

**`app/nutrition-history.tsx:474`** · `chatty-helper` · **confident**
> "No energy logged in the last {window} days. Log meals with calories and **the trend fills in here.**"
**Proposal:** "No energy logged in the last {window} days. Only meals with calories count toward this."
**Outcome:** applied, **fact kept — a meal logged without calories contributes nothing**, which is the same class of caveat the list protected at `nutrition-micros.tsx` ("Only foods with recorded micronutrients contribute, so these totals can run low"). Refuted on `nutrition-history (an empty day)`.

---

## §9 — Read on the second walk and deliberately not cut

Lines the second walk stopped on and left. Each is here so the decision is on the record rather than invisible; the owner can still overrule any of them.

- **`app/settings-backups.tsx:576`** — the encryption paragraph. The one entry I judged too risky. Reasoning in §7 above: four clauses, four facts, one of them (key custody) stated nowhere else in the app.
- **`app/barcode-scan.tsx:314`** "Not in Open Food Facts. Add it manually and it's yours for next time." — reads close to the deleted `food-new.tsx` footer, but this one is a **failure message with the way out in it**, which the method excludes by name, and the two sibling branches already end at "Add it manually for now." The tail states a real consequence (it is cached for the next scan).
- **`app/progress-photos.tsx:349`** "Pick two photos to compare. Same pose reads best." — four words of guidance *at the moment of a live choice*, not an unsolicited gallery tip, and `progress-photo-compare.tsx:238` states the full caveat only after you have already picked badly. The long-form sibling on the same screen was cut; this one earns its place.
- **`app/knowledge.tsx:381`** — the prompt-cap sentence. It duplicates `coach-memory.tsx:253`, which looks like shape 2, but it renders **only when the cap bites**, and the file's own comment explains why: a store that has silently stopped riding along is the exact failure this run exists to make visible.
- **`app/mission-history.tsx:253`** "No mission has been planned yet — activate a protocol and each day gets a plan." — one sentence that names the absence and the only fix. Borderline on the tail, kept whole.
- **`app/nutrition.tsx:632`** "Nothing logged yet today, and no targets set — so there is nothing here to measure the day against." — a "no data, no number" line, excluded by the method.
- **`app/wearables.tsx:146`** and **`src/components/home/mode-control.tsx:273`** — lists of what arrives, and consequence-of-a-mode-change lines. Facts throughout.

---

## §10 — The third walk: where a string-walk cannot see (2026-09-23)

The owner's device note, after the 0061 build (2026-09-21): *"there is still plenty of slop in the app. another anti ai slop search should be conducted prior to the next build."* Numbered §10 because §9 was already taken.

**Why two walks missed these.** Both walks read the strings *written in* `app/` and `src/components/`. **22 of these 39 sites are not written there.** They are *built* somewhere else and handed to a screen: the brief under Home's hero comes from `src/lib/ai/insights.ts`, the readiness line from `src/lib/home/readiness.ts`, the Train hub's empty card from `src/lib/exercise/recommend.ts`, every coverage note on Settings › Apple Health from `src/lib/health/coverage.ts`, the model picker's notes from `src/lib/ai/model-client.ts`, the report's section prose from `src/lib/reports/`, the Coach's no-key replies from `src/lib/ai/coach-service.ts`. The screen file says `{recommendation.why}`, and a string-walk reads past a variable. **15 sites were inside the walked files, in places the method looked away from.** The first list excluded error messages wholesale (*"they name the failure and the way out"*). That is right about their facts and blind to their register, so eleven "Please try again." bodies could not be listed. Three more lines were simply read and passed. **2 lines were added by builds merged after the second walk** (`60bb653`).

**Method.** Every string of three or more words in `src/lib/**` and `src/hooks/**` was extracted (2,149 in `src/lib` alone), prompts and model-only text set aside, and each remaining one traced to the screen that prints it. Every `Alert.alert` / `Alert.prompt` in the app was inventoried: title, body and buttons (40 sheets). Every string new in `app/` and `src/components/` since `60bb653` was diffed out and read. Same six tags, same three shapes, same rule: never take a fact with the cut. Docblocks ignored, as before.

**Counts.** **28 entries, 39 string sites, all applied**: **19 `applied, fact kept`** and **9 `applied`** (the cut carried no fact). **4 held for the owner.** **Where it was hiding:** built in `src/lib` or `src/hooks` and printed by a screen — **22** (Home's brief and readiness line 7, the Coach's no-key replies, model note and relayed notes 6, the coverage notes 3, Train hub, Data tab and reports 6). Inside the walked files, where the method looked away — **15** (Alert and error bodies 12, the confirmation card's lanes 2, the questions label 1). Added since the second walk — **2**.

**A correction to §9's closing note.** It said `app/routine-edit.tsx:314` was *"the only user-facing survivor"* of the retired noun "routine". It was not. A second lived in `src/lib/exercise/recommend.ts:145`, out of the walk's reach (§10.D below).

### §10.A — Home's brief and readiness line, built in `src/lib`

**`src/lib/ai/insights.ts:925`** · `chatty-helper` · **confident**
> "Sick day. Nothing in your data needs attention. **Look after the basics.**"
The only piece of generic wellness advice in the brief, on the one day the user has said not to judge them.
**Now:** "Sick day. Nothing in your data needs attention."
**Outcome:** applied. Pinned exactly in `db/insights.test.mjs` §0b.

**`src/lib/ai/insights.ts:929`** · `chatty-helper` · **confident**
> "Nothing logged by hand yet. What I can see: {floor}. Add weight, meals and training **to widen what I can read.**"
**Now:** "…Add weight, meals and training."
**Outcome:** applied, **fact kept — the three things to log**. The tail described what logging them would do to the brief itself. Pinned in `db/insights.test.mjs` §20.

**`src/lib/ai/insights.ts:930`** · `chatty-helper` · **confident**
> "Nothing logged yet. Start with today: weight, what you eat, and any training. **Trends need a few days of anything at all.**"
**Now:** "…Trends need about ten days."
**Outcome:** applied, **fact kept and sharpened: about ten days**, which is the detectors' real gate (the next branch already said "Trends need about ten"). The same fix §8 made at `exercise-detail.tsx:312` ("a couple" → two). This is the brief a fresh install shows. Pinned exactly in `db/insights.test.mjs` §0 and on `home (never touched)` in `db/screens-render.test.mjs`.

**`src/lib/ai/insights.ts:935`** · `chatty-helper` (shape 3) · **confident**
> "Baseline building. 5 days of data so far. Trends need about ten. **Keep the cadence and they will start showing up.**"
**Now:** "Baseline building. 5 days of data so far. Trends need about ten."
**Outcome:** applied. What is left is the count and the gate. Refuted in `db/insights.test.mjs` §0b.

**`src/lib/ai/insights.ts:939`** · `ai-label`/aphorism · **confident**
> "Everything is holding steady. No trend, gap, or symptom pattern worth flagging today. **Stable is the goal, not the absence of news.**"
A maxim explaining a verdict the sentence before it already stated. Same shape as `reports.tsx:320` in §8.
**Now:** "Everything is holding steady. No trend, gap, or symptom pattern worth flagging today."
**Outcome:** applied. Pinned exactly on a new no-watch stable fixture in `db/insights.test.mjs` §0b, because no existing test reached this branch.

**`src/lib/home/readiness.ts:1126`** · `chatty-helper` · **confident**
> "Apple Health cannot be read in this build — the HealthKit module rides the next app build. **Whatever your watch or ring is syncing into Apple Health is safe there and will land here once it does.**"
**Now:** "…rides the next app build. Readings already in Apple Health will land then."
**Outcome:** applied, **fact kept: nothing is lost, and it arrives with the build**, in eight words instead of twenty-two. A reassuring sentence became a statement. Pinned in `db/readiness.test.mjs` §8 and on `home (never touched)`.

**`src/lib/home/readiness.ts:1128`** · `chatty-helper` (shape 3) · **confident**
> "Connect Apple Health in Settings **to power readiness.**"
The metrics strip's copy of this sentence lost "…to populate this" in §8. Its twin on the hero's readiness line is built in `src/lib`, so it survived.
**Now:** "Connect Apple Health in Settings."
**Outcome:** applied, **fact kept: the route in**. Pinned exactly in `db/readiness.test.mjs` §8.

### §10.B — The Coach, in `src/lib`

**`src/lib/ai/coach-service.ts:352`** · `chatty-helper` · **confident**
> "Morning. **I'm here, but I should be straight with you:** no model is connected this session, so this is **the chat foundation, not the intelligence.** Paste an API key in the panel above and I'll answer from your actual data **— trends, today's log, reminders, all of it. What would you want me to look at first?**"
These are the Coach's no-key replies, the thread's answer whenever no model is connected. The closing question invites a turn that can only get another canned reply.
**Now:** "Morning. No model is connected this session, so this is a preview. Paste an API key in the panel above and I'll answer from your actual data."
**Outcome:** applied, **fact kept: no model, a preview, the way out, what changes once there is a key**. "Preview" is the word the empty thread's own lede already uses.

**`src/lib/ai/coach-service.ts:361`** · `marketing` · **confident**
> "**Good question — and exactly the kind I'm built to answer.** I can't yet in this session: no model is connected, so I won't pretend to read your labs, wearables, or logs. Paste an API key in the panel above and I'll answer this with your actual numbers **and the trend behind them, not a generic take.**"
**Now:** "I can't answer that in this session: no model is connected, so I won't pretend to read your labs, wearables, or logs. Paste an API key in the panel above and I'll answer with your actual numbers."
**Outcome:** applied, **fact kept: what it cannot read, and the way out**. This was the most assistant-like sentence in the app.

**`src/lib/ai/coach-service.ts:369`** · `marketing` · **confident**
> "Noted. I'm running as a preview **right now — the chat works end to end, but** no model is connected this session, so I won't pretend to have answers I can't ground. Paste an API key in the panel above **and this same thread becomes the real thing.**"
**Now:** "Noted. I'm running as a preview — no model is connected this session, so I won't pretend to have answers I can't ground. Paste an API key in the panel above."
**Outcome:** applied, **fact kept**. "The chat works end to end" is a developer's claim about the pipeline, not something the user needs. *All three replies are refuted by a source scan in `db/screens-render.test.mjs` §22. `mockReply` is private and no suite drives a no-key turn.*

**`src/lib/ai/model-client.ts:67`** · `marketing` · **confident**
> Sonnet 5 — "**Near-Opus quality** · default"
§8 cut "near-Opus quality for a fraction of the cost" from the margin on Settings › Coach. The same claim survived just above it, as the picker row's own note, because the note is built in `src/lib`.
**Now:** "Default"
**Outcome:** applied, **fact kept: it is the default**. The comparison already lives, once, in the margin below ("Sonnet is the cheaper of the two; Opus is stronger on deep, whole-history analysis"). Opus keeps "Deepest reasoning · ~2.5× the cost", because the multiple is the decision aid. Pinned in `db/model-client.test.mjs` §12.

**`src/lib/notifications/reminders.ts:510`** · `chatty-helper` · **confident**
> "Saved, but notification permission is not granted, so no phone alert will fire — it surfaces in the app only. **The user can enable notifications for ARC in iOS Settings.**"
The type says this line is *"safe to relay to the user as-is"*, and the Coach relays it. Relayed as-is, it tells the user about "the user".
**Now:** "…Notifications for ARC can be turned on in iOS Settings."
**Outcome:** applied, **fact kept: the way out**.

**`src/lib/notifications/reminders.ts:512`** · `chatty-helper` · **confident**
> "Saved, but scheduling the OS notification failed, **so do not promise a phone alert** — it surfaces in the app."
An instruction to the model, inside a sentence documented as safe to hand the user word for word.
**Now:** "Saved, but scheduling the OS notification failed, so no phone alert will fire — it surfaces in the app only."
**Outcome:** applied, **fact kept**, and it now reads like its five siblings. Stating the fact tells the model not to promise the alert just as well as the instruction did. *Both are source-scanned (§22): neither branch is reachable under node.*

### §10.C — Settings › Apple Health: the coverage notes in `src/lib/health/coverage.ts`

**`src/lib/health/coverage.ts:128`** · `chatty-helper` (assistant voice) · **confident**
> "**Nothing in this repository establishes** that Garmin Connect writes in-workout heart-rate samples to Apple Health at all, at what cadence, or whether it associates them with the session **— none of the three was checked.** A blank can also mean the read grant was declined — iOS never tells ARC. Check Settings → Privacy & Security → Health → ARC → Heart Rate before reading a zero as a Garmin fact."
An audit memo addressed to someone reading the code, printed on a Settings screen. The user has no repository.
**Now:** "Unconfirmed whether Garmin Connect writes in-workout heart rate to Apple Health at all, at what cadence, or tied to the session. A blank can also mean…"
**Outcome:** applied, **fact kept: all three unknowns, the declined-grant caveat, the Settings path**. The existing `Privacy & Security` pin still holds.

**`src/lib/health/coverage.ts:173`** · `chatty-helper` (assistant voice) · **confident**
> "**Nothing in this repository establishes** that Garmin writes hydration to Apple Health**, and no source was checked when the scope was added — the premise is plausible and unconfirmed.** The test is one evening: log a hydration entry on the watch, sync, and see whether a row lands. Any other hydration app on the phone will also fill this**, which is the point of reading it.**"
**Now:** "Unconfirmed whether Garmin writes hydration to Apple Health. The test is one evening: log a hydration entry on the watch, sync, and see whether a row lands. Any other hydration app on the phone also fills this."
**Outcome:** applied, **fact kept: unconfirmed, the one-evening test verbatim, the other-apps fact**. Pinned in `db/health-coverage.test.mjs` §6.

**`src/lib/health/coverage.ts:110`** · `chatty-helper` (assistant voice) · **confident**
> "Syncs — Garmin publishes a dedicated FAQ about step counts **DIFFERING** between the two apps**, which presupposes it.**"
This argues the verdict instead of stating it. The FAQ does contain something the reader needs, though: the two apps' step counts can differ.
**Now:** "Syncs. Garmin's own FAQ says the step counts in the two apps can differ."
**Outcome:** applied, **fact kept, and pointed at the reader: expect a discrepancy**. A whole-table refutation in `db/health-coverage.test.mjs` §6 now fails if any note mentions a repository or argues its own verdict.

### §10.D — Other lines built in `src/lib` and `src/hooks`: Train hub, Data tab, reports

**`src/lib/exercise/recommend.ts:145`** · `chatty-helper` (shape 3) + retired noun · **confident**
> "Build a **routine** or log a few sessions **and ARC will start recommending your next workout.**"
Printed under "Train today" when there is nothing to recommend. It has the retired noun, the card narrating its own future, and ARC talking about itself in the third person.
**Now:** "A recommendation needs a saved workout or a few logged sessions."
**Outcome:** applied, **fact kept: the precondition, in the house noun**. This is the §8 `exercise-detail.tsx:312` shape. Pinned and refuted (both the noun and the promise) in `db/training-engine.test.mjs` §6. No page render reaches this branch: the render suite's hub always has fallback exercises to offer.

**`src/hooks/use-data-overview.ts:189`** · `chatty-helper` (shape 3) · **confident**
> Weight trend row, empty: "**Log weight to start a trend**"
Its five neighbours name the absence: "No water logged yet", "No meals yet", "Nothing logged this week"…
**Now:** "No weight logged yet"
**Outcome:** applied. Pinned and refuted on `data tab (never touched)`.

**`src/lib/reports/assemble-self-review.ts:274`** · `chatty-helper` · **confident**
> "This period holds only today, and adherence is scored on complete days — a two-hour-old day is not a day. **Check back tomorrow.**"
**Now:** ends at "…is not a day."
**Outcome:** applied. The rule stays, and the rule is the whole reason the section is empty. Pinned in `db/reports.test.mjs` §7.

**`src/lib/reports/assemble-self-review.ts:972`** · `ai-label`/aphorism · **confident**
> "No protocol revision, target change or status this period **— the plan you started with is the plan you finished with.**"
**Now:** "No protocol revision, target change or status this period."
**Outcome:** applied. Pinned in `db/reports.test.mjs` §7.

**`src/lib/reports/assemble-self-review.ts:738`** · `chatty-helper` · **confident**
> "No wearable readings in this period or the one before it. Apple Health syncs these**; nothing is missing by hand.**"
**Now:** "…Apple Health syncs these."
**Outcome:** applied, **fact kept: where these readings come from**. "Nothing is missing by hand" was reassurance. Pinned in `db/reports.test.mjs` §7.

**`src/lib/reports/assemble-doctor-pack.ts:291–293`** · `restates-obvious` (shapes 1 + 2) · **confident**
> "No bloodwork has been imported into ARC yet**, so this section has nothing to report. The catalogue tracks 65 markers and is waiting on a first draw.**"
The renderer prints the coverage line directly above it: "0 of 65 tracked markers measured." So the count appeared twice, beside a restatement and a flourish, in the document a clinician reads.
**Now:** "No bloodwork has been imported into ARC yet."
**Outcome:** applied, **fact kept: the catalogue size, stated once, by the coverage line**. Pinned in `db/reports.test.mjs` §6, along with the coverage line.

### §10.E — Inside the walked files, where the method looked away

The first list's exclusions were about facts: an error message names the failure and the way out, so none was listed. That is still true of every line below. What the exclusion could not see was register, and three more lines were read by both walks and passed.

**"Please try again." ×11** · `chatty-helper` (register) · **confident**
> `app/protocol-edit.tsx:455`, `app/protocol-item.tsx:240`, `app/protocol-settings.tsx:161` and `:191`, `app/protocol-versions.tsx:172`, `app/routine-edit.tsx:228` and `:251`, `app/workout-import.tsx:292`, `app/workout-live.tsx:1067` and `:1093`, `src/components/exercise/exercise-picker.tsx:587` — "Nothing was changed. **Please** try again." (and two variants).
The only "Please" in the app's copy. It is the customer-service register. The house form is "Try again.": five sibling error bodies already end with it (`meal-estimate`, `meal-revise`, `progress-photo-add`, `recipe-revise`, `settings`), and it is the label on every retry button.
**Now:** "Nothing was changed. Try again." (variants kept: "The session is unchanged. Try again.", "Couldn't save that exercise. Try again.")
**Outcome:** applied, **fact kept: the rollback statement and the way out**. Neither is a filler word. *Source-scanned across 73 files in `app/` and 46 in `src/components/` (§22). Alert bodies do not render.*

**`app/meal-detail.tsx:662`** · `feature-explainer` · **confident**
> Alert.prompt "Save as template": "Name it **so you can log it again in one tap.**"
It explains templates on a sheet opened by choosing to save one. Its sibling, "Save as recipe", carries a real fact ("servings default to 1") and is untouched.
**Now:** "Name it."
**Outcome:** applied. Source-scanned (§22). *One line, in a file the parallel slices work also touches, and kept to that one line.*

**`src/components/coach/pending-write-card.tsx:136–137`** · `restates-obvious` (shape 2) · **confident**
> ON APPROVE: "This is written to your on-device record, once**, and the Coach carries on from there.**" (and the delete twin, "This row leaves…")
The NOW lane directly above already says "The Coach is suspended until you answer." The tail said the same thing from the other side, on every write card. Both walks read the create line and passed it. The domain-registry build (2026-09-19, merged after the second walk) copied the tail into a new delete twin.
**Now:** "This is written to your on-device record, once." / "This row leaves your on-device record, once."
**Outcome:** applied, **fact kept: where the write goes, and that it happens once**. *Source-scanned, with a positive pin on the kept lines, in `db/screens-render.test.mjs` §22. The card imports the tools barrel, a directory import the render harness does not resolve. The docblock's quote of the 2026-08-11 wording was left alone as history.*

**`src/components/nutrition/estimate-review.tsx:462`** · `ai-label` · **confident**
> `SectionLabel label="A few things"` over the estimator's clarifying questions.
This is §0's shape exactly: "How it is going" became "Adherence". A section label names what is filed under it. It has been here since C5 (2026-09-14), and the second walk read it and passed it.
**Now:** `label="Questions"` (the tally note is unchanged)
**Outcome:** applied, **and it overrides a documented decision**. `docs/nutrition-subapp.md` ("The UX") and the auto-ask spike chose "A few things" because "Questions" *"reads like a form"*. That is a preference about tone, and tone is what the owner is reporting. The spec's two mentions were updated. The spike was left as dated history. Reverting is one line. Rendered from props and refuted in `db/screens-render.test.mjs` §22.

### §10.F — Added since the second walk

**`app/(tabs)/index.tsx:170`** · `chatty-helper` · **confident**
> Home's Protocols link: `hint="What builds the day"`
§1 cut this from the link's `accessibilityLabel` ("Protocols — what builds this day"). A rebuild of the control brought it back as the hint. A hint says what activating the control does. This one editorialised about what protocols are.
**Now:** no hint. The prop became optional, the one type change this pass made. The Plan link keeps "The mission on other days", because "Plan" alone does not say where it goes.
**Outcome:** applied. Source-scanned (§22): react-native-web drops `accessibilityHint`, so a render refutation would be vacuous.

**`app/mission-day.tsx:315`** · `restates-obvious` · **confident**
> "**This day is settled.** More than a week back, the record stands as it is."
**Now:** "More than a week back, the record stands as it is."
**Outcome:** applied, **fact kept: the one-week boundary and the consequence**. The opening sentence said the consequence twice. Pinned and refuted on `mission-day (beyond the carry window)`.

### §10.G — Held for the owner

- **`src/lib/status/chips.ts:57–58`**: the status chips' canned prompts, "Check what's up and adjust accordingly." and "Re-check today and put back what you took out." The first is **the owner's own sentence** from the backlog entry (the file's docblock quotes it), and both are sent in his voice, not the app's. The end-of-status seeded line built on the second is also being reworked by the parallel status work. Not touched.
- **`app/knowledge.tsx:633`**: "…removed for good — the Coach can never cite it again. **Restore exists; undelete does not.**" This has the aphorism shape the list cuts, but it is the consequence line of a permanent delete, and it separates the two verbs on that screen. The method excludes consequence lines. **Proposal if wanted:** end at "…never cite it again."
- **`src/lib/reports/assemble-self-review.ts:718–720`**: "Up 12% on the window before — **the direction you want** / **worth watching**. The gap is larger than your normal day-to-day variation." Which direction is good (HRV up, resting HR down) is a fact a reader may not know. "Worth watching" is the soft half. **Proposal if wanted:** "…— the direction you want / not the direction you want."
- **`src/lib/db/repositories/mission-generate.ts:804`**: "Day 3 **of this experiment**". This restates the "Experiment · {title}" chip beside it on Home, but it is three words and pinned by `db/coach-pass.test.mjs`. **Proposal if wanted:** "Day 3".

### §10.H — Read on this walk and deliberately not cut

- `src/lib/ai/insights.ts:689` "Correlation, not causation — worth watching.": the honest caveat on a correlation insight.
- `src/lib/notifications/rest-timer.ts:43–44` "Rest complete" / "Time for your next set.": a lock-screen notification needs a body, and this one is one imperative.
- `src/lib/exercise/recommend.ts:120` "…still recovering; go lighter or swap if it's flat.": guidance at the moment of a live choice. This is §9's ruling on `progress-photos.tsx:349`.
- `src/hooks/use-data-overview.ts:160` "No plan yet — build a protocol": the absence and the only fix. This is §9's ruling on `mission-history.tsx:253`.
- `src/lib/health/log.ts` (the sync log's `metricNote` / `publishNote`), `src/lib/exercise/format.ts` (the ingest and HR lines), `src/lib/db/repositories/day-meta.ts` (Home's timezone line) and `src/lib/status/line.ts` (Home's status line): measurements, routes and consequences throughout.
- `src/lib/recipes/video-outcome.ts`, `src/lib/recipes/import.ts`, `src/lib/knowledge/import.ts`: failures that each name the way out. The method excludes these by name.
- The Coach's card lines (`summarize` in `src/lib/ai/domains/`, `confirmSummary` in `src/lib/ai/tools/write-tools.ts`): terse and factual throughout ("Log workout · 45 min", "Start experiment "…" — 14 days").
- `src/lib/export/serializer.ts`'s notes inside the export file, and `src/lib/photos/analyze.ts:59–60` (the photo-reading consent line): facts about what leaves the phone and what is not included.
- The iOS purpose string in `app.json` ("…to power readiness and recovery"): Apple requires it to say why access is needed.

**Assertions.** Changed: 1 (`mission-day (beyond the carry window)` no longer expects "This day is settled"; it refutes it). **Added: 40 checks across seven suites.** With the branch base's copy (`6f3acf1`) of all 23 changed source files swapped back in, **35 of them fail**: 5 / 2 / 2 / 3 / 2 / 4 / 17 in `insights`, `readiness`, `training-engine`, `health-coverage`, `model-client`, `reports` and `screens-render`. The five that still pass are keep-the-fact pins (Opus's cost multiple, the doctor pack's coverage line) and the three new renders themselves. Where no render reaches a line (Alert bodies, an iOS-only hint, the confirmation card, the no-key replies, two relayed notes), the guard is a source scan of the line's code form, and the test says so.

---

## §11 — The fourth walk: the round-1 and round-2 builds (2026-09-23)

The owner, again, before the next build: *"there is still plenty of slop in the app. another anti ai slop search should be conducted prior to the next build."*

**Scope.** Every user-visible string added or changed by `git diff 05e39d7..a3d1bcf` on `app/`, `src/components/`, `src/hooks/` and `src/lib/`: the Coach's delete cards, the plank clock, water both ways and its pointer, the status door and its sheet, slices (ATE / OF), the logger (leave, resume, reorder, duration), lifts (load basis, records, trends, PR stamps, the Exercises list), the blank-HRV sync cell, food Undo / Combine / the scan name, micros (the Eat-tab row, the key micro), and the gap fixes. **Plus two merges no walk had read:** the protocol time wheel (`70557b0`) and the macro bars (`8045c03`) landed on main after the third walk's branch was cut from `6f3acf1` and before it merged, so they sit *inside* `05e39d7` and outside that diff. The bars carry no copy; the wheel carried one line (§11.A). **Plus five lines an independent verifier flagged** as breaking this list's own rules. All five are confirmed and applied below, and two of them showed that a screen had never been read whole: Settings › Apple Health, and Compare. Both were then read top to bottom, and so was the status sheet the brief names. **Plus four lines outside the range** (§11.F): an independent review of this branch found that the walk had cut a "come back" tail from Compare and a "meanwhile" from the time wheel, and left the same tail standing on four key-gate screens older than the range. The rule does not change with the diff, so they are cut too.

**Why three walks missed the flagged five.** Three are new: the micros empty state was rewritten by the micros build (`aad8b18`), the plank-clock note by the clock build (`7ac1f48`), and the water paragraph by the two-way build (`d825787`), which took it from three sentences to five before the gap fix (`d481865`) added when a glass goes out. The other two were never on anyone's list. The sync-log legend (`settings-health.tsx:651`, 2026-08-26) predates the first walk and was read and passed each time, because it reads like a caption. Compare's empty state is drawn only when the pair the screen was handed no longer resolves and no pose has two photos, and all three walks read screens in the states their fixtures reached.

**Method.** The diff was parsed with comments stripped, and every JSX text node and every string literal of three or more words on an added line was extracted by script and read: about 300 strings in 54 files. Each string built in `src/lib` or `src/hooks` was traced to the screen that prints it. That covers Alert titles, bodies and buttons, accessibility labels and hints, the Coach's delete-card lines, Undo rows, receipts and pointers. The same six tags, the same three shapes and the same rule applied: never take a fact with the cut, keep consequence lines of irreversible acts, and leave the owner's held lines alone (§10.G). **Out of scope, as the brief requires:** text addressed to the model rather than the user. That means tool descriptions, the system prompt, the domain refusal reasons (they say "read-only *to you*" and name `edit_record`), the state block's revert cue in `turn-context.ts`, and the read tools' notes about `null`. The Coach's token ceilings do not move.

**Counts.** **14 entries, 19 string sites, all applied**: **13 `applied, fact kept`**, **1 `applied`** (the cut carried no fact). **Where they were:** in the diff, **6** (the micros empty state, the water paragraph, the clock note, the combine foot, the day refusal, the anchor card). In the gap between the third walk's branch and its merge, **1** (the wheel). On screens the diff touched but no walk had read whole, **8** (Settings › Apple Health ×3, Settings › Backups ×1, Compare ×2, the logger's other optional-field note, the status sheet). Outside the diff, the same tail the walk cut inside it, **4** (the key gates, §11.F). **3 held for the owner** (§11.G).

### §11.A — The time wheel, merged between the third walk's branch and its merge

**`src/components/protocols/time-wheel.tsx:140`** · `chatty-helper` · **confident**
> "The wheel arrives with the next app build. **Type it here meanwhile.**"

The fallback field is directly above the sentence, holding the stored time. The second sentence pointed at it. This is the archetype §8 cut from `water.tsx:397` ("Tap an amount below…").
**Now:** "The wheel arrives with the next app build."
**Outcome:** applied, **fact kept: the build gate**. Refuted on `protocol-item (edit, no wheel)`, whose existing expect already pins the kept sentence.

### §11.B — Nutrition: the micros screen, and the combine foot

**`app/nutrition-micros.tsx:120`** · `feature-explainer` (shape 1) · **confident** · *flagged*
> "Nothing recorded yet today. Foods from the catalog contribute micronutrients, **and an estimate records the ones a food is a notable source of.**"

§3 left this empty state with a second sentence *because it carried a fact*: this screen is empty on a day whose logged meals carry no micros, and the sentence says why. The micros build kept that fact and added the estimator's selection rule to it. The rule was the explainer.
**Now:** "Nothing recorded yet today — only catalog foods and estimates carry micronutrients."
**Outcome:** applied, **fact kept: where micronutrients come from**, and it is now one sentence. How the estimator chooses what to record is its prompt's business. The caveat that governs a populated day ("Only foods with recorded micronutrients contribute, so these totals can run low") is untouched. Pinned and refuted on `nutrition-micros (no fiber recorded)`: three meals are logged in that fixture and none carries micros, which is the day this sentence exists for.

**`src/components/nutrition/combine-meals.tsx:75`** · `chatty-helper` · **confident**
> "Tap the meals that were **really** one meal."

**Now:** "Tap the meals that were one meal."
**Outcome:** applied. The toggle that opens combine mode is already labelled "Combine meals that were one meal", without the "really". Pinned on a new `combine foot (none chosen)` render. The existing resting-state refutation now uses the new wording, because the wording changed.

**`src/lib/nutrition/combine.ts:100`** · `restates-obvious` · **confident**
> "These were logged on different days. A meal belongs to one day, **so only meals from the same day combine.**"

The rule was stated twice, the second time as its own consequence.
**Now:** "These were logged on different days, and a meal belongs to one day."
**Outcome:** applied, **fact kept: what went wrong, and the rule**. The recipe refusal next to it has the same shape. `db/nutrition-v2.test.mjs`'s `includes('different days')` still holds. The Eat tab lists one day, so this branch is defensive. It is pinned from the planner itself on a new `combine foot (two days)` render.

### §11.C — Settings, read whole

**`app/settings-health.tsx:726–731`** · `feature-explainer` + `restates-obvious` · **confident** · *flagged*
> "**Water goes both ways.** A glass you log here is written to Apple Health as soon as you log it, and undoing or correcting it here changes it there too. Apple Health sends back one **merged** total per day with ARC's own glasses left out, so **nothing ARC wrote** is counted twice. A glass tapped on the watch and typed here is **still** two glasses, **though** — log a glass in one place **or the other, not both**. A day that looks doubled is fixed in Data → Water, **where the two entries sit side by side.**"

**Now:** "A glass you log here is written to Apple Health as soon as you log it, and undoing or correcting it here changes it there too. Apple Health sends back one total per day with ARC's own glasses left out, so none is counted twice. A glass tapped on the watch and typed here is two glasses — log it in one place. A doubled day is fixed in Data → Water."
**Outcome:** applied, **fact kept: every one of them.** That covers when a glass goes out (a render pins it, since it used to wait for a sync), that corrections follow, that ARC's own glasses are kept out, the pick-one-door rule, and the route. The opening sentence restated the `Both` tag on the scope row directly above it, and that tag has its own assertion. The last clause narrated a screen the route already names. The rest was filler inside facts. Five sentences became four. Two expects changed because their wording changed, each old phrase is now refuted, and the new sentences are pinned. `docs/spikes/water-fast-logging.md` quoted the old opening sentence as history, and a dated note now says it went.

**`app/settings-health.tsx:651–652`** · `restates-obvious` · **confident** · *flagged*
> "Each row reads: measurements Apple Health returned → measurements ARC kept. **A gap between the two is always explained on the line beneath it.**"

The legend is needed, because the arrow is not self-evident. The second sentence promised something about the rows, and the promise was false: `metricNote` returns nothing for a bucketed metric whose samples fold into fewer daily rows. The render suite's own fixture shows it, with `hrv` at `40 → 14` and no line beneath.
**Now:** the first sentence alone.
**Outcome:** applied, **fact kept: how to read the arrow**. Pinned and refuted on `settings-health (logged)`.

**`app/settings-health.tsx:380–381`** and **`app/settings-backups.tsx:479–481`** · `chatty-helper` (shape 3) · **confident**
> "The HealthKit module **is installed but** not in this **dev** build yet. Run the next EAS build (docs/dev-build.md) **and this screen goes live — nothing else to set up.**"
> "…so there is nowhere to write a snapshot. Run the next EAS build (docs/dev-build.md) **and this screen goes live — nothing else to set up.**"

The same tail on both Settings screens with a build gate. It narrated the screen coming to life, the shape-3 family. It was also untrue: after the build, Apple Health still has *Enable* and a permission sheet, and Backups still has its first snapshot. On Apple Health, "dev build" named a client the owner does not run (his phone takes TestFlight builds), and "installed" was a fact about `package.json`.
**Now:** "The HealthKit module isn't in this build yet. Run the next EAS build (docs/dev-build.md)." / "…nowhere to write a snapshot. Run the next EAS build (docs/dev-build.md)."
**Outcome:** applied, **fact kept: what is missing, and the way out**. Apple Health is pinned and refuted on `settings-health (no sync yet)`, which takes this branch under node. Backups has no render here, so it is source-scanned: all 72 screens are refuted and the kept sentence is positively pinned.

**`app/settings-health.tsx:785`** · `chatty-helper` · **confident**
> "Never — it stays in Garmin Connect, **and no amount of waiting will change that.**"

**Now:** "Never — it stays in Garmin Connect, and a later sync will not bring it."
**Outcome:** applied, **fact kept: "Never" is not a sync delay**, which is the reason the coverage table exists. The idiom went. Pinned and refuted on `settings-health (no sync yet)`.

### §11.D — Training and photos

**`app/workout-log.tsx:174`** (and **`:171`** in the same four-line function) · `feature-explainer` · **confident** · *flagged*
> "Time is optional. **Type the digits and they fill from the right — 1 3 0 is 1:30.**"
> "Time and distance are optional **— log either, or both.** Distance is stored in metres."

The first narrated how the new clock field works, under a field that draws its own colon as the digits arrive and whose placeholder reads `Time (mm:ss)`. The second restated "optional".
**Now:** "Time is optional." / "Time and distance are optional. Distance is stored in metres."
**Outcome:** applied, **fact kept: what is optional, and the unit**. The function's docblock now says the note never describes how a field is typed into. VoiceOver still hears the mechanism from the field's own hint (§11.H), which is source-pinned beside the render because react-native-web drops `accessibilityHint`. On `workout-log (resumed on a plank)` the expect changed from the narration to `>Time is optional.<`, and the narration is refuted.

**`app/progress-photo-compare.tsx:155`** · `ai-label`/aphorism + `chatty-helper` · **confident** · *flagged, never walked*
> "Two photos of the same pose are what makes a comparison worth looking at. Import a second one and come back."

**Now:** "Pick two photos in the gallery to compare them."
**Outcome:** applied, **fact kept: a comparison is two photos, and the gallery is where they are picked**. The "Back to photos" button under it goes there. The same-pose advice is not lost. The gallery says "Same pose reads best." at the moment of the choice (§9's ruling), and this screen states the different-poses caveat whenever a pair differs. **Not** "A comparison needs two photos of the same pose.", this entry's first draft, which the independent review of the branch caught. The gallery compares any two photos, and this screen draws a front-vs-side pair with its own caveat (the next entry). `pickDefaultPair`'s same-pose rule only chooses a fallback when the pair the screen was handed no longer resolves. It is not a rule of comparing, so "sharpening" the line to it stated a rule the app does not have. The §8 shape (`exercise-detail.tsx:312`) only holds when the gate named is the code's real gate. Pinned and refuted on a new `progress photo compare (nothing to pair)` render: the old sentence, and the same-pose claim.

**`app/progress-photo-compare.tsx:238`** · `chatty-helper` · **confident**
> "These are different poses, so most of what looks like a change is the angle. **Compare like with like where you can.**"

**Now:** the first sentence alone.
**Outcome:** applied, **fact kept: the caveat**. §9 cites this line as "the full caveat", and that part is the one kept. The advice pointed at the *Compare against* plate directly below, which lists the same pose by default. Pinned and refuted on a new `progress photo compare (front vs side)` render.

### §11.E — The Coach and the status sheet

**`src/lib/ai/domains/write-domains.ts:597`** · vocabulary drift · **confident**
> The muscle anchor's delete card: "Delete muscle anchor "chest" — freshness 70; **the engine's** own reading returns"

"The engine" is the code's word for the training model. A card is read by the user.
**Now:** "…freshness 70; ARC's own reading returns"
**Outcome:** applied, **fact kept: what removing the anchor does**. "ARC's reading" is the app's word for a derived value: the exercise screen says "ARC's reading of this movement is per hand". The exact card line in `db/coach-domains.test.mjs` changed because its wording changed, and it is an exact match, so the old word cannot come back.

**`src/components/status/status-control.tsx:239`** · `chatty-helper` · **confident**
> "Anything else, **just** tell the Coach. Skips on these days stop counting against you; their readings sit out of your 30-day baselines."

**Now:** "For anything else, tell the Coach. Skips on these days…" (the consequence sentence is untouched)
**Outcome:** applied, **fact kept: a status can be anything the user types**, and only the five have chips. The sheet is a native Modal that draws nothing until it is opened, so the pin is a source scan that checks both halves.

### §11.F — The same tail outside the range: the key gates

The walk did not find these. The independent review of this branch did. The walk cut "Import a second one and come back" from Compare and "Type it here meanwhile" from the time wheel, and four key-gate screens older than `05e39d7` still ended the same way. The brief's scope excused them, but a rule applied to one "come back" and not to four is not applied, and the owner's note was about the app.

**`app/meal-estimate.tsx:392`**, **`app/lab-import.tsx:279`**, **`app/meal-revise.tsx:229`**, **`app/recipe-revise.tsx:253`** · `chatty-helper` (shape 3) · **confident**
> "Add a key in the Coach tab**, then come back. Meanwhile,** Add food and **Manual entry** work offline."
> "Add a key in Settings › Coach**, then come back. It’s** the only part of this that goes online; matching, reviewing and storing all happen on your phone."
> "Add one in Settings › Coach**, then come back.** Editing items by hand works offline."
> "Add one in Settings › Coach**, then come back.** The recipe editor works offline."

"Then come back" narrates the round trip. "Meanwhile" framed the offline paths as something to do while waiting, when they are simply the other ways to log. The house form was already on two sibling gates: "Set one in Settings › Coach. Writing an entry yourself needs nothing at all." (`knowledge-import.tsx`) and "Add one in the Coach tab. Everything else on this screen works offline." (the photo reading panel).
**Now:** "Add a key in the Coach tab. Add food and manual entry work offline." / "Add a key in Settings › Coach. Reading the PDF is the only part of this that goes online; matching, reviewing and storing all happen on your phone." / "Add one in Settings › Coach. Editing items by hand works offline." / "Add one in Settings › Coach. The recipe editor works offline."
**Outcome:** applied, **fact kept: the route to a key, and what works without one**, on all four. Two small corrections rode along, both to facts. On meal estimate, "Manual entry" named a Log-sheet row that is now "Enter it manually", so it is lower-case and names the act rather than a label that no longer exists. On lab import, the cut left "It’s" pointing at adding a key, so it now says what it meant: reading the PDF is the one step that goes online. The privacy clause after it is the reason the line exists, and it is untouched. Meal estimate's route stays "the Coach tab", which is true: that tab's key panel saves the same Keychain key Settings › Coach manages. Pinned and refuted on `meal-estimate (no key)` and `recipe-revise (no key)`, and on two new renders, `meal-revise (no key)` and `lab-import (no key)`, which the suite had not drawn before.

### §11.G — Held for the owner

- **`src/components/coach/pending-write-card.tsx:142`**: "This row is deleted from your on-device record **for good. There is no undo.**" This says the irreversibility twice. It is the consequence line of a permanent delete, which the method keeps, and §22 pins its exact wording. **Proposal if wanted:** "This row is deleted from your on-device record. There is no undo."
- **`app/settings-health.tsx:494`**: the heart-rate ask. "**ARC can read the heart rate recorded during a workout and show it on the session.** It was added after you connected, so it has to be asked for on its own. If nothing appears, turn Heart Rate on under…, then tap this again." The first sentence is a small pitch, but it is also the only place that says where the result appears. It shows only while the scope is unasked, and the owner's phone has probably answered it. **Proposal if wanted:** "Heart rate during workouts shows on each session. It was added after you connected…"
- **`app/settings-health.tsx:712`**: "…and water from the first sync **after it was added**". The "it" is the water write scope, and the user cannot know when that shipped. This is not slop. It is a fact stated in build history. Since the gap fixes, a glass also goes out when it is logged, not at a sync. Rewording it means stating a boundary the code does not record, so it is held rather than guessed at.

### §11.H — Read on this walk and deliberately not cut

- `src/components/exercise/duration-field.tsx:155`, the clock field's `accessibilityHint` "Type the digits; they fill from the right.": this is the VoiceOver half of what sighted users see as the drawn colon, and a hint describing input is what that slot is for. Pinned as kept.
- The Order plate's line (`app/workout-live.tsx:2325`, `src/components/exercise/exercise-order.tsx:58`) "A superset moves as one. To move one of its exercises on its own, split it at the seam first.": a rule the user cannot otherwise discover, and the way out. It is shown only when a superset is on the list.
- Both loggers' leave and discard sheets ("Leave without a saved copy?" / "ARC could not store this workout for later, so leaving now loses it.", "Discard this workout?" / "…Discarding deletes the sets you have typed."), the editor's "Discard these changes?" / "The session stays as it was.", and the Train hub's "Anything typed in it will be deleted. This cannot be undone.": consequence lines of irreversible acts.
- The meal screen's count editor ("On save: …", "A count is more than 0 and at most 100.", "Type how many were eaten."): consequence lines before a write, plus one imperative at a live choice. This follows §9's ruling on `progress-photos.tsx:349`.
- The load basis (`LOAD_BASIS_MEANING` in `src/lib/exercise/load-basis.ts`, "Changing it relabels every set already logged. No number changes.", "Set by you"): a unit's definition, a consequence before a write, and provenance.
- `src/lib/exercise/records.ts`'s empty and trend notes ("A top-set trend needs two sessions with a weight logged.", "Only away sessions so far, and they set no records."): preconditions, already in §8's shape.
- The combine consequence ("On combine: these 2 become one meal, "Porridge", at 07:40 — 323 kcal, so the day's total does not change. Their items and photos move into it.") and the recipe refusal: a consequence line, and a refusal naming its rule.
- `src/lib/home/metric-sync.ts` (the blank cell's "never synced", "Garmin never sends this to Apple Health"), `waterPublishPointer`, `statusLine`, `openSessionLine`, `dayKeyMicros` and `totalsOnlyNote`, and the Undo words ("Removed Greek yogurt · 150 kcal", "Could not put … back — the meal has changed since."): measurements, routes and consequences throughout.
- `src/lib/health/log.ts:238`, "…so no water was read rather than risk counting it twice.": a failure that states its safe outcome, deliberately. `publishNote`'s "Armed —" is §10.H's keep. Only its tail changed, and the change was to a fact.
- The status sheet's "Says what kind of day this is, then asks the Coach to adjust it." is the one operative sentence, argued in its own comment. The consequence sentence after "For anything else, tell the Coach." is also kept.
- The status chips' end sentences (`src/lib/status/chips.ts`): rewritten in this range on the owner's own device note. Their shared tail is §10.G's held sentence.
- `src/lib/health/coverage.ts`'s `use` strings, including "since 2026-09-21": no screen renders them.

**Assertions.** Changed: **5**, each because its wording changed and each with the old phrase now refuted. In `settings-health (no sync yet)`, two water expects: "Water goes both ways." is refuted and the two-way fact stays pinned on the scope row's `Both` tag, and the pick-one-door phrase is expected in its new words. In `workout-log (resumed on a plank)`, the narration expect became `>Time is optional.<`. The resting Eat tab's refutation of the foot's first sentence changed. So did the anchor card's exact line in `db/coach-domains.test.mjs`. **Added: 58 checks** in `db/screens-render.test.mjs` (1,605 → 1,663). That includes six new renders: Compare with nothing to pair, Compare front vs side, the combine foot with none chosen and across two days, and the no-key states of meal revise and lab import. It also adds a new §27 for the two source scans. With the base copy (`a3d1bcf`) of all fourteen changed source files swapped back in, **42 checks fail**: 41 in `screens-render` and 1 in `coach-domains`. The seventeen new checks that still pass are the six renders themselves and keep-the-fact pins: the legend's first sentence, the build-gate title, the kept caveat, *Compare against*, "0 days apart", the disabled Combine button, "Back to photos", the clock field's hint, and the two key gates' opening lines. The last is a refutation of the first draft's same-pose claim, which the base copy never made.

**A correction to the three shapes' Outcome (2026-09-19).** Its first rule says *"Every remaining empty state in the app is now one authored statement."* After the micros build it was not true (§11.B), and it had never been true of Compare (§11.D). Both are one sentence now.

---

## The three shapes, if you want to decide by rule instead of line by line

1. **The empty state that grew a second paragraph.** Nine of these. The first line names the absence (correct, keep); the paragraph under it explains the feature (`meal-templates`, `protocols`, `reports`, `exercise`, `knowledge` ×2, `recipe-folders`, `food-search`, `experiments`). A rule that says *an empty state gets one sentence* would settle all nine.
2. **The mechanism explained three times in one sub-app.** The Coach's experiment loop is described on `experiments.tsx` twice and `experiment-detail.tsx` once; the knowledge precedence rule on `knowledge.tsx` twice and `knowledge-entry-edit.tsx` once. Keep the statement nearest the action; delete the rest.
3. **The flow narrated back to the user before they take it.** "You'll see the revised items…", "Check every number…", "…and it will be placed on this horizon." Where these sit beside a real guarantee (what is *not* touched, what is *not* written), the guarantee is the half worth keeping.

**Outcome (2026-09-19) — the three shapes, applied as rules.** The owner's blanket approval turned all three from suggestions into the pass's working rule, and the second walk found each still live somewhere the first walk had not looked:

1. *An empty state gets ONE sentence.* Nine cases in the first round. The second walk found five more and applied the rule to every one: `progress-photos:304` (the kept entry), `water:397`, `water:535`, `exercise:530`, `workout-live:1209`. Every remaining empty state in the app is now one authored statement — **none was left blank**, which `00-design-spec.md` §5 forbids. *(Corrected 2026-09-23: not so of `nutrition-micros`, once the micros build grew its sentence back, nor of `progress-photo-compare`, which no walk had reached. Both are one sentence as of §11.)*
2. *A mechanism is stated once, nearest the action.* Two new cases. The Coach-memory length rule was stated on the Knowledge hub and on the editor; the hub's copy went and the editor's — stated where the line is being written — stayed. The ended-protocol rule was stated on the Protocols hub and on the protocol's own detail screen; the hub's went and the detail screen's, which carries the date and sits beside the control that extends a phase, stayed. In both cases the **fact was already in the right place**; the cut removed the copy, not the information.
3. *A flow is not narrated before it is taken.* Four new cases, all of the "…and it fills in here" family: `metrics-strip:116`, `nutrition-history:474`, `exercise-detail:312`, `water:397`. In three of the four the sentence carried a real precondition (the route in, meals needing calories, two weighted sessions) and only the narration was cut.

**One non-slop finding, worth a line of your attention:** `app/routine-edit.tsx:314` still says **"routine"**. Everywhere else in the app the noun is **saved workout**. That is the only user-facing survivor of the retired vocabulary I found in the whole walk.

**Fixed 2026-09-15.** The line was also the confident candidate at §4 (`app/routine-edit.tsx:314`), so the same edit that cut the explainer removed the stale noun with it — nothing said "routine" left to fix separately. Pinned in `db/screens-render.test.mjs` (`routine-edit (new)`), refuting both the old sentence and the bare word.

**Corrected 2026-09-23.** "Nothing said 'routine' left to fix" was true of the screens and false of the app. The Train hub's empty card is built in `src/lib/exercise/recommend.ts:145`, and it still said "Build a routine…". Fixed in §10.D.
