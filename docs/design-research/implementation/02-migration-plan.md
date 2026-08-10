# Migration plan — and the record of what actually happened

> **STATUS: ADOPTED AND EXECUTED, 2026-08-08.** This started life as a forward plan with three open Phase-0 decisions. All three were decided, and Phases 1–4 were carried out **across the whole app in one pass**, not screen-by-screen as the plan proposed. **Phase 5 was deliberately not done.** The file is kept — not archived — because the sequencing rationale is still the right shape for the next restyle, and because the *deviations* from it are the interesting part.
>
> The shipped description of the system is `docs/project-status.md` §3; the decision record is the 2026-08-08 ADR in `docs/decisions.md`; the spec is `00-design-spec.md`.
>
> ⚠️ **PARTLY SUPERSEDED 2026-08-09 — this file is now a record of what was built, not a description of what renders.** It went on a phone, and three of the six devices did not survive the look: `field` (corner ticks), `margin` (2px left rule + indent) and `grid` (between-cell hairlines) now draw **nothing at all**, and the Coach thread came off the `well`. Everything below describing those marks as shipped is history — it is deliberately **not** edited in place, because the sequencing and the deviations from it are what this file is for. **`00-design-spec.md` §1 is the amended spec; `src/components/ui/block.tsx` is the truth.**
>
> ⚠️ **The "nothing here has been seen on an iPhone" warning that used to head this file is now out of date in the only way that matters: it has been.** Every "done" below still means only *typechecks, lints and the headless suites pass* at the time it was written — the device pass came afterwards, and it is what produced the supersession above. See "What is still open".

---

## Phase 0 — decisions that blocked implementation — **ALL THREE DECIDED**

| # | Decision | Outcome |
| --- | --- | --- |
| **1** | **Adopt at all?** | **ADOPTED**, whole-app. The owner's call. The surface system is a genuine information gain: under Porcelain Ledger every block was a card, so the container told the reader nothing. |
| **2** | **Accent** — petrol `#12454E` vs redline `#C4222E` | **PETROL.** Redline forces `bio-poor` → umber `#7A4A1E` and permanently strains the chrome/biology firewall in a product whose worst health state is red — a finding in all six hostile reviews. Petrol has no collision, so the firewall costs nothing to hold. |
| **3** | **Type faces** | **iOS-NATIVE, no `expo-font` payload.** The mockup's Bahnschrift SemiCondensed (label) and Constantia (serif) **do not exist on iOS**. Shipped: label `Avenir Next Condensed → Helvetica Neue → system-ui`, serif `Iowan Old Style → Palatino → Georgia` (unchanged from Porcelain), mono `Menlo → Courier New`. Shipping a real face stays available if the label voice reads generic on hardware. |

**A fourth decision the plan did not anticipate, and the reason a rename sweep never happened: token KEY NAMES were kept.** `palette` (`src/constants/theme.ts`) is imported by **51** files, almost all for Ionicons `color` props. Only the *values* moved. **Read `pine` as "the one accent" and `hairline` as "the rule"** — the names outlived their hues, which is a fair trade against a rename whose entire yield is that the names match again. Two shims exist for the same reason: `porcelain` survives as an alias of `paper-hi`, and `rounded-card` is mapped to **`0px`** rather than deleted. Note the shims turned out to protect nothing — a sweep of all 191 source files on 2026-08-09 found **zero** consumers of either — so they are kept because a dead token costs one line, not because anything depends on them.

> Counts in this file are restatements. `docs/project-status.md` §3 is their one home and carries the commands that produced them; if they disagree, §3 wins.

**The "cheapest way to de-risk" was NOT taken.** The plan recommended Phase 1 + 2 on **Home only**, run on a device, then judge. That did not happen — the restyle went app-wide in one pass, and **no device has run any of it.** The de-risking step is therefore still owed, just at a much larger diff size than the plan intended. Record that honestly rather than pretending the sequencing was followed.

---

## Phase 1 — tokens — **DONE**

1. ✅ `tailwind.config.js` ← `theme.extend` from `tailwind.tokens.js`, accent set to petrol.
2. ✅ `src/constants/theme.ts` ← `theme.ts`. Key names unchanged, so the 51 `palette` importers needed no edits — as designed.
3. ✅ `app.json` splash `backgroundColor` → the new `paper` (`#F6F3EC` → `#E7E4DA`).
4. ✅ The imperative chrome, which does **not** follow a Tailwind change: `app/_layout.tsx` (nav theme) and `app/(tabs)/_layout.tsx` (tab bar). The tab bar also picked up the label voice — and with it the one unfallback-able font reference in the app; see "What is still open".
5. ✅ Gates green.

**One thing the plan did not list and the implementation added:** the palette gained a **second cut per biological signal** — `signal-{state}` is the **swatch** (fills/icons, 3:1) and `signal-{state}-ink` is the **text** cut (4.5:1). The spec called for it in §2; the token file is where it became real, with the measured ratios recorded in the comment so nobody re-derives them. Also fixed here: React Navigation's `notification` slot (tab-bar badges — pure chrome) had been wired to `signal.caution`, a dormant firewall breach; it now takes the accent.

## Phase 2 — the surface system — **DONE**

1. ✅ `src/components/ui/block.tsx` — the six devices + `CornerTicks`.
2. ✅ `src/components/ui/section-label.tsx`.
3. ✅ Home converted (readiness → `field`, mission → `plate`, coach brief → `margin`, metrics → `grid`, hero → `stamp`).
4. ❌ **"Judge on a device before continuing" — SKIPPED.** Phase 3 started immediately.

> ⚠️ **Superseded 2026-08-09 — and item 4 is exactly why.** `CornerTicks` no longer exists; `field`, `margin` and `grid` are empty class strings that draw nothing. The device *assignments* in item 3 all still stand (the call site is still a claim about what kind of content it holds) — only three of the treatments went away. The skipped device check in item 4 is what let the marks reach the owner's phone before anyone had looked at them.

**Two additions the plan did not call for, both worth keeping:**
- **The one-device/never-nest rule is enforced at runtime in `__DEV__`.** A nested `Block` logs a `console.error` naming both devices. Prose was the only guard on a primitive that now has **137 call sites across 58 files**, so the cheapest place to catch the mistake is the moment it renders.
- **Two implementation traps are recorded in the primitive's own doc comment**, because both are easy to get wrong and one is wrong *in this kit*: (a) the `grid` device's last cell takes **no** trailing rule — the port guide's §1.3 snippet and the mockup's `nth-child` CSS both draw a rule off the final cell when the count is odd; `src/components/home/metrics-strip.tsx` has the correct form. (b) A `well` is a surface, not a container: **an input is never `bg-paper-hi`**. A census found 9 inputs drawn on raised fill *inside* a well, which inverts the whole surface system.

> ⚠️ **Trap (a) is now moot** (2026-08-09): the `grid` device draws no rules on any cell, so there is no trailing rule to get wrong. Trap (b) is **live and unchanged** — it governs `well`, which is one of the three devices still drawn.

## Phase 3 — the rest of the screens — **DONE, all five groups**

Coach, Log/Keypad, Data, Settings/Protocols/Screenings, and Nutrition/Exercise all converted. The plan's "each is independently shippable" ordering held in principle but was not used as a shipping boundary — it all landed together (**83 files changed**).

## Phase 4 — new views the mockup designed but the app lacked — **DONE**

- ✅ **Protocols version history** — `app/protocol-versions.tsx` + `src/hooks/use-protocol-versions.ts`, reached from `app/protocol-edit.tsx`. Includes the *suspended* state (a dashed "proposed · awaiting your OK" marker) that keeps it consistent with a pending Coach write.
- ✅ **Screenings horizon axis** — the measured timeline above the grouped ledger, with rotated-square diamond markers at the terminals.
- ✅ **Alternate states** — mission-complete, Coach preview/no-key, empty feed, keypad blank / water quick-adds.

Both of the new-view details flagged above (`border-dashed`, the rotated diamonds) are **first-of-kind in this tree** and fail silently if iOS does not support them. That is the price of Phase 4 landing without a device check.

## Phase 5 — the type scale — **NOT DONE, deliberately**

Adding `fontSize` / `letterSpacing` tokens and sweeping out the arbitrary values. **Current state, recounted 2026-08-09:** `tailwind.config.js` defines **no** `fontSize` or `letterSpacing` tokens, and **63 files** still carry arbitrary type values — **627** `text-[Npx]` occurrences (612 tracked; the gap is two files still untracked at count time) and **147** `tracking-[…]` occurrences.

**Why it was judged optional, plainly:** the three type **voices** ship regardless, because a voice is a `fontFamily` token the whole app inherits — the design's typographic *meaning* ("serif speaks, mono measures", every button in the label voice) is fully delivered without this phase. Phase 5 is an **enforceability** refactor: it stops the next person inventing a fourteenth size. Highest file count in the plan, lowest visual return, and no user-visible change if done correctly. It remains available at any time and blocks nothing.

---

## What is still open

- ✅ **"NOBODY HAS SEEN THIS ON AN IPHONE" — closed 2026-08-09.** The owner ran it on their phone. The de-risking step this plan opened with had been skipped, and the diff was the whole app rather than one screen, so the bill arrived all at once: the first note back was *"there are some weird boxes and lines in some places, notably the metrics and coach brief on the home screen, but there are more."* Three devices lost their marks and the Coach thread came off the `well` as a result (`00-design-spec.md` §1). **The lesson is the one this plan wrote down and the implementation ignored: judge the surface system on hardware before spending it across 83 files.**
- ⚠️ Three details fail **silently** when unsupported. The device pass produced no report either way on any of them, so treat them as still open:
  - **`Avenir Next Condensed`** — inside `font-label` it heads a CSS stack, so native falls through to Helvetica Neue. **But `app/(tabs)/_layout.tsx` sets `fontFamily` imperatively as a single string, and React Native takes no fallback list there** — a missing family drops just the five tab labels to the system face, silently, while every other label in the app renders correctly. Fallback if it happens: `'Helvetica Neue'`, not unset.
  - **`border-dashed`** (`app/protocol-versions.tsx`).
  - **Rotated-square diamond markers** (`app/screenings.tsx`, `transform: [{ rotate: '45deg' }]`).
- ⚠️ **Serif at 600 weight** — Iowan Old Style was unconfirmed under Porcelain Ledger and is still unconfirmed. Palatino is next in the stack.
- 📋 Several screens still define a local `SectionLabel`; sweeping them onto the shared primitive is a separate pass.
- 📋 Phase 5, above.

## Docs updated on adoption — **DONE**

ARC's convention (`CLAUDE.md` §9) is that docs move in the same change as reality:

- ✅ `docs/decisions.md` — the 2026-08-08 ADR (supersession, petrol, the iOS typeface substitution, the kept key names, and the unretired device risk); the 2026-07-24 Porcelain Ledger ADR marked superseded, with the three of its calls that survive.
- ✅ `docs/project-status.md` §3 — replaced wholesale with the Conformed Set; Status Board, the Home-screen to-do entry, Known caveats and Related documents all updated.
- ✅ `docs/design-directions.md` — the Conformed Set appended as the chosen direction with its provenance; the file re-titled as the archive it now is.
- ✅ `tailwind.config.js` + `src/constants/theme.ts` header comments — they named Porcelain Ledger; they now describe the Conformed Set and the kept key names.
- ✅ `CLAUDE.md` — §3 now names the design system.
- ✅ `README.md` in this folder — its opening line still claimed nothing had been applied; corrected 2026-08-09.
- ⚠️ **Not updated, and outside the scope of the adoption pass:** `docs/architecture-migration.md`, `docs/exercise-subapp.md` and `docs/nutrition-subapp.md` each describe their surfaces in Porcelain Ledger terms. None is load-bearing for the visual system — `project-status.md` §3 is — but they are stale and should be swept.

## What was deliberately **not** in scope — held

- ✅ **No new native dependency** (no `react-native-svg`, no `expo-linear-gradient`) → the restyle needs **no EAS rebuild of its own**. The corner ticks and diamond markers were bordered / rotated Views precisely to keep it that way. *(The constraint held through the device pass and beyond: the ticks are gone, and the paper grid that replaced the missing blueprint ground ships as a repeat-tiled PNG rather than a gradient, for the same reason — the owner runs a dev client and a new package costs a ~20-minute cloud rebuild.)*
- ✅ **No change to data, hooks, or navigation structure** — presentation only. The one new route (`protocol-versions`) is a Phase-4 view, not a restructure.
- ✅ The mockup's desk background, registration marks, sheet numbers and title blocks are presentation chrome and **did not ship**. Inside the phone, every mark must pay rent.
