# C5 — Auto-ask clarifying questions

**Status:** design proposal, for owner approval. No code written.
**Migration:** **none.** Questions are a property of an estimate in flight, not of a logged record — nothing is persisted that `meal_items` cannot already hold.
**Citations verified against `main` at `950c846`.** `main` moves several times a day; if a line number below misses, the surrounding quote is the anchor.

---

## 1. Current state

### The estimator is one turn, no tools, JSON out — and it asks nothing

```
src/lib/nutrition/estimate.ts:258-284   estimateMeal
src/lib/nutrition/estimate.ts:127-153   MEAL_ESTIMATION_SYSTEM_PROMPT
src/lib/nutrition/estimate.ts:199-248   parseMealEstimate
```

`estimateMeal` builds one `AgenticRequest` (`:266`), runs it through the Coach's `runCoachTurn` with `tools: []` (`:268-279`), and hands the reply text to `parseMealEstimate`. The prompt's closing instruction is *"Respond with ONLY a JSON object, no prose"* (`:147`) against a fixed three-key shape — `title`, `items`, `notes` (`:148-151`). There is no channel in that contract for the model to say *"I need to know something"*.

The nearest thing today is the `notes` field, rendered as a margin annotation above the item table (`app/meal-estimate.tsx:680-688`) and described in the prompt as *"say so in notes when [hidden fats] materially affect the estimate"* (`estimate.ts:138-139`). That is a **statement of uncertainty the reader can do nothing with** — it names the doubt and leaves the number as it was.

### The review screen goes estimate → ground → table, with nothing in between

```
app/meal-estimate.tsx:259-277   run()
app/meal-estimate.tsx:125-130   Phase
```

`run()` is `setPhase({kind:'estimating'})` → `groundMealEstimate(getDb(), await estimateMeal(...))` → `toReview()`. The phase machine has five states and none of them is "asking". The review itself is a `Block device="plate"` of editable rows (`:694-757`) whose kcal total recomputes live from the rows (`:434-437`), above a future-tense pending-write line and `Save meal` (`:766-792`).

### The logging methods, as they actually exist

Six in the Log sheet (`src/components/nutrition/log-sheet.tsx:391-431`): **Describe or photograph** · **Add food** (catalog) · **Scan a barcode** · **From a template** · **Cook a recipe** · **Enter it manually**. Two more are promoted to accent buttons on the Eat tab — **Photo** and **Describe** (`app/nutrition.tsx:571-588`). Plus the plain-English correction path, `reviseMeal` (`src/lib/nutrition/estimate.ts:403-429`, `app/meal-revise.tsx`), and recipe import (`app/recipe-import.tsx`, whose own line-pricing lives in `src/lib/recipes/estimate.ts`).

**Only two of those are model calls that could carry a question:** describe and photo. Barcode resolves offline-first against the cache then Open Food Facts (`docs/nutrition-subapp.md:243`); catalog, template and manual never touch a model at all.

### Two facts about cost that decide the design

- **`messages` carries no prompt-cache breakpoint.** `buildMessagesRequest` puts one on the system block and one on the last tool (`src/lib/ai/model-client.ts:268-278`) and passes `messages: request.messages` verbatim (`:290`). So **a second round trip on the photo path re-bills the whole image at full input price** — ~1,369 tokens for a ~1024px JPEG (`docs/nutrition-subapp.md:76`).
- **The estimator's system prompt measures ~449 prose tokens** (1,616 chars ÷ 3.6, the estimator `db/coach-eval.test.mjs:383` uses). It is below Opus 5's 512-token cache minimum (`model-client.ts:60-62`), so it has never cached either. It measured **296** earlier the same day; backlog A8 (sodium / caffeine) merged five prompt lines and a schema key in between (`estimate.ts:140-144`, `:150-152`). Nothing guards this prompt — see §3.6.

---

## 2. The owner's words

> *Fires on anything ambiguous, from **any** logging method; **max 3 questions**; **button-answerable** (an "other / type here" option is allowed but only as a click); only for things that **matter** and that the user would **actually know** — "we shouldn't ask questions the user likely doesn't know themselves (i.e. cooking methods in a restaurant)." Archetype: "how many shots are in this latte?"*
> — `docs/backlog-2026-09.md:39`

Five rules, and each one lands somewhere specific below: *any method* → §3.4, *max 3* → §3.5, *button-answerable* → §3.3, *matters* + *would know* → §3.2, *the latte* → the worked example in §3.1.

---

## 3. Proposed design

### 3.1 The shape: one call, questions that carry their own arithmetic

The estimator's structured output gains one optional key:

```
"questions": [{"id": string, "ask": string,
               "options": [{"label": string, "effect": <one of four>}],
               "allow_other": boolean}]
```

and each `effect` is one of a **tiny closed vocabulary the parser can validate**:

| effect | means | the archetype |
| --- | --- | --- |
| `{"scale_item": name, "factor": n}` | multiply that item's portion and macros | *"How many shots?"* → `1` = ×0.5, `2` = ×1, `3` = ×1.5 on the espresso item |
| `{"set_grams": name, "grams": n}` | set that item's portion outright | *"Small, medium or large?"* on the latte's milk |
| `{"add_item": {name, grams, kcal, protein_g, carbs_g, fat_g}}` | add a whole item | *"Was there dressing?"* → yes, ~30 g vinaigrette |
| `{"remove_item": name}` | drop an item | *"Did you eat the bun?"* → no |

**The model returns its best estimate AND the questions in the same call.** Choosing an answer is then **pure on-device arithmetic** over the review rows — no second call, instant, and it works with the network gone once the first reply has landed.

Worked, on the owner's own archetype. He photographs a latte. The model returns:

```json
{"title":"Latte","items":[
   {"name":"Espresso","grams":60,"kcal":5,...,"confidence":"medium"},
   {"name":"Whole milk","grams":300,"kcal":186,...,"confidence":"medium"}],
 "notes":null,
 "questions":[{"id":"shots","ask":"How many shots?",
   "options":[{"label":"1","effect":{"scale_item":"Espresso","factor":0.5}},
              {"label":"2","effect":{"scale_item":"Espresso","factor":1}},
              {"label":"3","effect":{"scale_item":"Espresso","factor":1.5}}],
   "allow_other":false}]}
```

He taps `3`. The espresso row goes 60 g → 90 g on screen and the plate's total moves. Nothing was written, nothing was re-requested, and the answer is *visible as a change to the record he is about to save* — which is the same confirmation discipline the screen already uses (`00-design-spec.md:172`, a pending write is a live decision).

**Why judgment still lives in the model.** ARC's standing rule is that clinical and interpretive decisions are the model's, not a rule table's. Nothing here moves that: the model decides *whether* to ask, *what* to ask, *which answers are plausible*, and *what each answer implies*. The four effects are a **wire format for what it decided**, not a decision table — the same relationship `MealEstimate`'s JSON shape already has to the estimate itself.

### 3.2 The prompt rules: materiality and knowability

Drafted verbatim (measured in §3.6):

```
Questions (optional, and USUALLY ABSENT):
- Ask nothing unless an answer would move the estimate by more than ~15% of its energy or
  ~10 g of protein. Most meals need no question at all; returning an empty list is the norm.
- Ask only what the person was there for — how many shots, how big the glass, how much was
  left. Never what happened in a kitchen they did not stand in (a restaurant's oil, the
  butter under a steak). Never what the photo already answers.
- At most 3, and one good question beats three weak ones. Each carries 2-4 button answers,
  and each answer carries the EFFECT of choosing it, as one of:
  {"scale_item": name, "factor": n} · {"set_grams": name, "grams": n} ·
  {"remove_item": name} · {"add_item": {name, grams, kcal, protein_g, carbs_g, fat_g}}
- Name the most likely answer first; the items you return must already assume it.
```

Four things in that are load-bearing:

1. **Materiality as a magnitude, not a list.** "~15% of its energy or ~10 g of protein" is a threshold the model can evaluate against the estimate it just made. A list of askable topics would be a rule table and would be wrong the first time the owner eats something not on it.
2. **Knowability stated as a place, not a category.** *"what the person was there for"* vs *"a kitchen they did not stand in"* — and then the owner's own two examples, one of each. Examples teach; the restaurant-oil case is his exact words and belongs in the prompt verbatim.
3. **"USUALLY ABSENT" and "returning an empty list is the norm."** A model handed a `questions` field will fill it. Saying zero is normal, twice, is the cheapest defence there is and it is the one the existing prompt already uses for the same class of problem (*"Prefer underestimating an unknown over inventing precision"*, `estimate.ts:145`).
4. **"the items you return must already assume it."** This is what makes a skipped question safe: the estimate on screen is already the most-likely-answer estimate, so skipping every question leaves a coherent record rather than a half-specified one.

### 3.3 The UX — question cards before finalise

Where: in the `review` phase, **between the title/notes and the Items plate** (`app/meal-estimate.tsx:671-694`, above `:694`). Answer first, then read the result — because the result *changes* as you answer, and a control below the thing it changes makes the change happen off-screen on a phone.

Draw:

- One `Block device="plate"` — questions are a short ruled record, and a record is a plate (`00-design-spec.md:21`). `SectionLabel label="A few things"` with the tally as its note: `1 of 2` → `2 of 2`. (Not "Questions", which reads like a form; not a conceit noun — `00-design-spec.md:174`.)
- Each question is one `Divider`-ruled row: the ask in **serif 15px `ink`** (it is a sentence, and serif speaks — `00-design-spec.md:88`), then a wrapping row of **outlined option chips** in the **label voice at 13px uppercase**, each ≥44pt tall (`00-design-spec.md:101`), `rounded-btn`, `border-hairline`, `active:bg-paper-dim` — the exact treatment `Other ways to log` already wears (`app/nutrition.tsx:597-606`).
- **No accent anywhere in this block.** In the `review` phase the accent is `Save meal` and stays there (`meal-estimate.tsx:89-90`, `:774-793`). An answered chip fills `bg-ink` with `text-paper-hi` — a state mark in ink, not a claim to being the next action.
- **`Skip`** as a bare text button at the row's trailing edge, label voice 12px `ink-muted`, matching `Discard` (`:793-801`). **Skipping is always allowed and never blocks Save.**
- **An answered question collapses to one mono line** in the metadata cut: `Shots · 3`. It stays tappable to change. A ledger keeps its record of what was asserted.
- **What it says back: nothing, in words.** Tapping a chip re-prices the rows in the plate below. The Items label's kcal total already recomputes from the live rows (`:434-437`), so the ledger keeps summing to itself with no new code. That is the whole answer — the screen shows the consequence rather than announcing it.
- **"Other"** is a fourth chip, shown only when the model set `allow_other`. Tapping it reveals a one-line `TextInput` inside a `Block device="well"` (a capture surface is a well — `00-design-spec.md:25`) plus an `Apply` control. It is reached **by a click**, which is the owner's constraint; typing is opt-in behind that click. See §3.5 for what it costs.

### 3.4 Which logging methods it covers

| Method | Asks? | Why |
| --- | --- | --- |
| **Describe** (`/meal-estimate`) | **Yes** | The richest case. A description is *where* ambiguity lives — "a latte" carries no shot count, no cup size, no milk. |
| **Photo** (`/meal-estimate?start=camera`, library) | **Yes** | Portion is the dominant error source (MAPE ≈ 36%, portion-dominated — `docs/nutrition-subapp.md:77`), and portion is exactly what the person present knows and the photo does not. |
| **Barcode** (`/barcode-scan`) | **No, and this is a design position, not an omission** | A barcode is an *exact identity*, and Open Food Facts returns an exact per-100 g panel. The only unknown is how much, and the portion sheet already asks that with a keypad and a prefilled last-used portion (`docs/nutrition-subapp.md:407`). Adding a model round trip here would (a) buy no accuracy on a path that is already exact, and (b) break the offline story — barcode is offline-first by construction (`nutrition-subapp.md:243`) and the whole app is *offline-except-AI* (CLAUDE.md §2). **A path that works with the network unplugged must not grow a question that needs the network.** |
| **Cook a recipe** (`logRecipe`) | **Yes, but not through a model** | The one thing unknown when you cook a recipe is *how much of it you ate*. That is a deterministic, local question with numeric options (`the whole thing · ½ · a serving · 2 servings`) and it should be asked by the same card component with locally-constructed options. Same UI, no model call, works offline. |
| **Add food / template / manual** | **No** | The user is asserting numbers. Asking him to clarify his own assertion is absurd. |
| **`reviseMeal`** (`/meal-revise`) | **No** | A revision *is* the user stating a fact. A question there is a loop. |
| **Recipe import** (`/recipe-import`) | **Deferred** | A different pipeline (`src/lib/recipes/estimate.ts`), and a recipe is authored once rather than logged daily. The card component is reusable there later; it is not in this round. |

### 3.5 Keeping it from over-asking — three gates, in order

1. **The prompt** (§3.2) — the judgment gate, and the only one that can be smart.
2. **A deterministic confidence gate, in `parseMealEstimate`:** if **every** item came back `confidence: 'high'`, drop all questions. A model that is certain about every item and still wants to ask has contradicted itself, and a certain estimate is the one case where an extra tap is pure friction. One line.
3. **A hard cap in the parser:** `questions.slice(0, 3)`. The owner said three; the model is not the enforcer of that.

Plus the parser's existing tolerance discipline (`estimate.ts:199-248`), extended:

- An option whose `effect` names an item **not in `items`** is dropped (the commonest model error — a renamed item).
- A question left with **fewer than 2 options** after that is dropped entirely. One button is not a question.
- An unknown `effect` key is dropped. A `factor` ≤ 0, or a `set_grams` ≤ 0, or grams > 5,000, is dropped — the same bounds `parseGrams` already applies (`meal-estimate.tsx:155-158`) and the same `CHECK (grams > 0)` the schema enforces (`0014:88`).
- Questions are asked **once per estimate.** Re-estimating produces a new call and may ask again; that is correct, it is a new estimate.

### 3.6 Token cost, honestly

Measured with `db/coach-eval.test.mjs`'s estimators (`:382-383`):

| | chars | prose tok |
| --- | --- | --- |
| `MEAL_ESTIMATION_SYSTEM_PROMPT` today | 1,616 | **449** |
| \+ the question rules (§3.2, verbatim) | 863 | **+240** |
| \+ the `questions` clause on the schema line | 95 | **+26** |
| **after C5** | ~2,574 | **~715** |
| **after C4 + C5** (C4 adds ~153 — see `composite-foods.md` §3.5) | ~2,928 | **~868** |

**Input, per turn.** On a photo turn the prompt goes from ~25% of the request to ~34%, against a ~1,369-token image (`docs/nutrition-subapp.md:76`) — in absolute terms **+266 input tokens on a ~1,800-token request.** On describe-in-words the prompt is the bulk and grows by ~60%, from ~450 to ~715 tokens, which is still a very small request.

**The trend is the real finding.** This prompt measured 296 tokens in the morning and 449 by the afternoon (A8), and C4 + C5 together would take it to ~868 — **2.9× its morning size, in one week, with no ceiling anywhere in the suite.** The Coach's prompt has two guards and a documented accounting discipline precisely because it drifted once; this one has neither and is drifting faster.

**Output.** A question with three options and their effects costs ~60–100 output tokens; three questions ~200–300. Most meals return none, which is the point of "usually absent".

**The second call, and exactly when it happens.** Taking "Other" and typing an answer fires a second turn — **text-only**, `reviseMeal`-shaped: the items as they now stand plus *"the user says: 3 shots"* (`buildMealRevisionRequest`, `estimate.ts:361-394`, already exists and already does this). It **does not resend the image**, which matters because `messages` carries no cache breakpoint (`model-client.ts:290`) and a resent photo would be ~1,369 tokens at full price every time. The text-only revision is ~400–700 input tokens. It happens only when the owner leaves the offered options, which is the rare path by construction.

**Neither Coach ceiling moves.** `db/coach-eval.test.mjs:651` guards `toWireTools(COACH_TOOLS)` at 9,250 and `:657` guards `buildCoachSystemPrompt` at 3,700. The estimator is a different system prompt on a tool-less turn (`estimate.ts:270`, `tools: []`) and is measured by neither. **It is guarded by nothing at all today**, and after C4 + C5 it is 2.4× its current size — so this round should add an `ESTIMATOR_PROMPT_CEILING` to `db/nutrition-v2.test.mjs`, in §6's accounting style, with the headroom stated and the instruction that the next addition trims rather than raises.

One incidental: at ~715 tokens the estimator's system block finally clears **Opus 5's** 512-token cache minimum (`model-client.ts:60-62`) and would start caching at the breakpoint `buildMessagesRequest` already sets (`:269`). It stays under Sonnet's 1,024 and Haiku's 4,096. Not a reason to do anything; recorded so nobody claims it as a win it is not.

**One thing A8 already built that C5 inherits.** `parseMealEstimate` now takes a nested per-item object out of the model's reply and through a vocabulary filter — `coerceMicros` / `serializeMicros`, dropping unknown keys and non-numbers, serialising an empty result back to NULL rather than `{}` (`estimate.ts:235-238`). The `questions` array and its typed `effect` objects are the same discipline applied to a second key, so §3.5's drop rules extend an established pattern rather than inventing one.

### 3.7 The tests that would pin it

In `db/nutrition-v2.test.mjs`, beside the existing parser/grounding assertions:

1. `parseMealEstimate` on a reply with **four** questions keeps three.
2. An option whose `scale_item` names a food not in `items` is dropped; a question left with one option is dropped; a question with all options dropped disappears entirely.
3. `factor: 0`, `factor: -1`, `set_grams: 0` and `set_grams: 9000` are each dropped, and the surviving question still renders.
4. An estimate whose every item is `confidence: 'high'` returns **zero** questions after the gate, even when the reply carried three.
5. A reply with no `questions` key parses exactly as it does today (the whole existing suite must pass unchanged — the key is optional).
6. `applyAnswer(rows, effect)` — the pure function — for each of the four effects: `scale_item` scales macros and micros proportionally; `set_grams` re-prices via `rescaleLoggedItem`; `add_item` appends; `remove_item` removes.
7. **After any answer, the plate's total equals the sum of the rows drawn.** The ledger rule (`00-design-spec.md:168`), asserted as arithmetic.
8. Skipping every question leaves the estimate byte-identical to the unanswered one (the "items already assume the most likely answer" rule).
9. Answering, then changing the answer, produces the same state as answering the second option first — no accumulation.
10. `db/screens-render.test.mjs`: `/meal-estimate` renders the question plate; `/barcode-scan` renders with **no** question surface at all (the negative, pinned, so the offline path cannot grow one by accident).

---

## 4. Alternatives considered

| Alternative | Why not |
| --- | --- |
| **Ask first, then estimate** (two calls, questions up front) | The honest-looking shape, and the wrong one. On the photo path it bills the image twice (~1,369 tokens, no message cache — `model-client.ts:290`), it puts a wait *before* the user sees anything, and the model has to invent questions about a meal it has not yet analysed. |
| **Estimate, then answers trigger a second call** (questions carry no effects) | One extra call per answered question, or a batched one at the end — on the photo path either resends the image or loses it. It is also slower at the exact moment the user wants to be done. Kept as the **"Other" path only**, where it is genuinely needed and genuinely rare. |
| **A tool-use loop** (give the estimator an `ask_user` tool) | Elegant, and it would let the model ask mid-reasoning. But it turns a one-shot turn into an agentic loop, drags the Coach's tool machinery into the estimator, and every tool schema added is measured against the 9,250 ceiling (`coach-eval.test.mjs:651`) — a ceiling `:415` says is full. A JSON key costs 26 tokens and no architecture. |
| **Free-text answers throughout** | Directly contrary to the owner's *"button-answerable"*. It is also slower to answer than to be offered three numbers, which is the entire value. |
| **Deterministic question rules in code** ("if an item is a coffee, ask shots") | A rule table that is wrong the first time he eats something that is not on it, and it violates the standing rule that judgment lives in the model. |
| **Ask *after* saving** (a nudge on the meal record) | The correction is least likely to be made once you have moved on — the exact reasoning `docs/nutrition-subapp.md:22` gives for why `meal-revise` exists at all. Ask while the plate is still on screen. |
| **Blocking Save until every question is answered** | Turns a refinement into a form. The estimate is already saveable and already assumes the most likely answers. |

---

## 5. Effort

| | |
| --- | --- |
| Schema + prompt rules in `estimate.ts` | 1 h |
| `parseMealEstimate` extension + the three gates + validation drops | 2 h |
| `applyAnswer` (pure, 4 effects, over `rescaleLoggedItem`) | 2 h |
| The question plate in `app/meal-estimate.tsx` (chips, skip, collapse, "Other" well) | 3–4 h |
| The "Other" → `reviseMeal` second call, with abort wiring (`meal-estimate.tsx:209-210`) | 1.5 h |
| The recipe-log portion card (local options, same component) | 1.5 h |
| The 10 tests + `ESTIMATOR_PROMPT_CEILING` + the gate | 3 h |
| **Total** | **~1.5–2 focused days.** |

**No migration, no native dependency, no EAS rebuild.**

**Shares three files with C4** (`estimate.ts`, `parseMealEstimate`, `app/meal-estimate.tsx`). Build them on one branch or sequence them deliberately; C4 first is the easier order, because C4 changes the item *shape* and C5 then writes effects against the shape that exists.

---

## 6. Questions only the owner can answer

**Q1. Where do the questions sit relative to the item table?**

- **(a) Above it.** Answer first, watch the rows below change. **← recommended** — the rows *are* the answer, and on a phone a control below the thing it changes makes the change happen off-screen.
- (b) Below it, above `Save`. Read the estimate, then refine. Reads more like a checklist, but the effect of a tap scrolls away.
- (c) As a step of their own before the review appears. Cleanest to draw, but you cannot see what you are correcting while you correct it.

**Q2. Does "Other" cost a second model call, or does it just drop you into the ordinary grams fields?**
"Other" is the one answer the model could not pre-compute.

- **(a) A second, text-only call** — `reviseMeal`-shaped, the photo is **not** resent, ~400–700 tokens, a second or two. **← recommended.** It is the only way a typed answer actually changes the numbers.
- (b) No second call — "Other" dismisses the question and leaves you to edit the grams by hand. Free and instant; the typed sentence does nothing.
- (c) No "Other" at all. Fastest, and you are stuck when none of the three buttons is right.

**Q3. Should an unanswered question ever hold up `Save`?**

- **(a) Never. Skip is always available and `Save` is always live.** **← recommended.** The estimate already assumes the most likely answer, so an unanswered question costs accuracy, not coherence.
- (b) `Save` stays live, but an unanswered question leaves a mark on the saved meal (`confidence` forced to `low` on the items it would have touched), so the record remembers it was never pinned down.
- (c) `Save` is disabled until every question is answered or explicitly skipped. Guarantees a considered record; turns a five-second log into a form.
