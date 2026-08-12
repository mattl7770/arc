import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import type { MissionItem } from '@/types/home';

type Props = {
  item: MissionItem | null;
  onDone: (id: string) => void;
  onSnooze: (id: string) => void;
  onSkip: (id: string) => void;
};

/**
 * The dimension rule — the drafting mark that makes the figure beside it read
 * as a **measurement** rather than as a caption.
 *
 * The mockup draws it as an inline SVG (`.cf-hero-dim svg`): a baseline with a
 * vertical extension tick at each end, stretched to fill whatever width the
 * figure leaves. It is the single most characteristic mark on the Home sheet and
 * the app had no equivalent for it anywhere — which is a large part of why the
 * shipped hero read as a card rather than as a drawing.
 *
 * Built from three filled `View`s rather than from an SVG: this app ships no
 * vector package (the owner is on a dev client, so a new native module costs a
 * cloud rebuild), and the mark is two ticks and a rule. **Filled views, never
 * borders** — a one-sided border width plus a whole-element border colour is the
 * exact shape that drops React Native off its CoreAnimation path and paints a
 * full rectangle instead (see `Divider` in src/components/ui/block.tsx). Here
 * that failure would draw three small boxes across the hero.
 *
 * The container takes `flex-1` so the rule *shrinks under* the figure it
 * measures; the mockup needs `min-width: 0` for the same reason, and RN's
 * `flexBasis: 0%` gives it for free.
 *
 * ## It is drawn only when it can be a rule (2026-08-11)
 *
 * `flex-1` makes this mark the row's shock absorber: it gets whatever the figure
 * leaves. That is right when the figure is a figure. It is a trap when the string
 * beside it is long, because the rule does not degrade into a shorter rule — it
 * degrades into a **stub**, and a 90pt bar with two end ticks floating to the
 * left of a full-width string does not read as a dimension. It reads as a line
 * someone left behind, which is what the owner saw on hardware.
 *
 * Two things fixed that, and they work together. The figure is now bounded by
 * construction (see {@link HeroCard} — the unbounded protocol name moved off this
 * row), and {@link MAX_DIMENSIONED_FIGURE} is the backstop for the cases that
 * bound cannot reach. **The rule is a mark, not leftover space:** when there is
 * not enough width left for it to span, it is not drawn at all and the figure
 * stands alone as the mono measured line it already is.
 */
function DimensionRule() {
  return (
    <View className="h-2 flex-1 flex-row items-center">
      <View className="h-[7px] w-px bg-ink-secondary" />
      <View className="h-px flex-1 bg-ink-secondary" />
      <View className="h-[7px] w-px bg-ink-secondary" />
    </View>
  );
}

/**
 * The longest dimension figure the rule will sit beside, in characters.
 *
 * Calibrated, not guessed, and it can be calibrated in characters precisely
 * because the figure is **mono**: Menlo's advance is a fixed 0.6023em, so 12px
 * type is 7.23pt per character no matter what the string says.
 *
 * The narrowest device this ships to is 375pt. Content width there is
 * 375 − 40 (`Screen`'s `px-5` gutter) − 3 (the stamp's 1.5px border, both edges)
 * − 32 (the stamp's `px-4`) = **300pt**, less the row's own 10pt gap. Holding the
 * rule to at least 40% of the row — the ratio it has on the sheet, where
 * `07:30 · 35 MIN · TRAINING` leaves it 42% — allows the figure 170pt, or 23–24
 * characters. On a 390pt device the same threshold leaves the rule 45%.
 *
 * In practice this never fires: the two figures the hero actually produces are
 * `07:30 · 35 MIN` (14) and `07:30 · 5G` (11). It exists for the pathological
 * dose — `07:30 · 35 MIN · 2 × 500 MG (AM)` — where dropping the mark is the
 * honest outcome and stubbing it is not.
 */
const MAX_DIMENSIONED_FIGURE = 24;

/*
 * A DOSE AND A RATIONALE ARE DIFFERENT FACTS, AND THE APP ALWAYS KNEW WHICH
 * — so this file no longer guesses.
 *
 * The defect that produced the owner's "5g" fragment was real and is worth
 * keeping on the record: `why` was two different things wearing one field name.
 * `planForDay` filled it as `item.dose ?? item.notes`, so it arrived as either a
 * **dose** (`5g`, `400 mg`, `2 caps`) or **rationale prose** ("Recovery beats
 * training when ill…"). The hero set both in 13px serif italic, which is right
 * for the second and a category error for the first — 00-design-spec.md §3 is
 * explicit that mono is "every measured value" and "a standalone measurement set
 * in the label or serif face is a bug". A dose is not an argument; it is the
 * quantity, and it belongs in the dimension figure beside the time, in exactly
 * the slot the sheet gives `35 MIN`. Duration and dose are the same fact — *how
 * much of this thing* — which is what lets one row serve a training session and
 * a supplement.
 *
 * The first fix for that sniffed the string back apart here: leading digit AND
 * at most fourteen characters meant "dose". It was a reasonable heuristic and it
 * was the wrong shape of answer. `planForDay` has `item.dose` and `item.notes`
 * as SEPARATE columns and flattens them one line before this file has to
 * un-flatten them, so the guess was re-deriving, imperfectly, a fact that was
 * thrown away upstream. `400 mg magnesium` is sixteen characters and would have
 * come out as prose; `3 sets, RPE 7` is thirteen and would have come out as a
 * dose. Every such miss is avoidable by construction.
 *
 * So `MissionItem` carries `dose` and `why` separately, end to end
 * (src/types/home.ts → mission-generate.ts → mission.ts). This file reads the
 * field; it does not inspect the value.
 *
 * ONE MIGRATION NOTE, because it is visible for a day: rows already on the
 * owner's device were written under the old flattening and hold a dose in `why`
 * with no `dose` field. They render as prose — i.e. exactly as they did before
 * any of this — until the mission regenerates, which happens daily. No backfill
 * and no compatibility sniff: reintroducing the guess to rescue one day of rows
 * would put the defect back permanently to fix something that expires by
 * morning.
 */

/**
 * The "Do this next" hero.
 *
 * Conformed Set treatment — the **stamped plate** device: paper-hi inside a
 * 1.5px accent border, square corners. It is the only block on the sheet drawn
 * in the accent, because it is the only block claiming to be the single most
 * important thing right now. If everything is emphasised, nothing is directive.
 *
 * All three voices in one block: the head row in `font-label` (tracked caps), the
 * headline and rationale in `font-serif` (serif speaks), the dimension figure in
 * `font-mono` (mono measures). The primary action is solid in the accent and the
 * escapes are neutral ink, so the hierarchy of the three buttons is unmistakable
 * at a glance.
 *
 * All three controls — Done, Snooze, Skip — are set in `font-label`, per
 * 00-design-spec.md §3: "buttons" means every button at every weight, filled,
 * outlined or bare. Weight is carried by fill and ink, never by face; the three
 * share one size and casing because they are one control group, and a bare
 * escape that fell back to the reading face stopped looking pressable.
 *
 * ## Conformed against the sheet, 2026-08-10
 *
 * Five things were off the mockup and were put on it. Three still stand as
 * written; the last two are superseded by the section below and are kept only so
 * the argument they lost stays legible.
 *
 *   - **The dimension rule was missing entirely** (above). The metadata line sat
 *     alone on its own row and read as a caption. *Still true — but the rule is
 *     now conditional, see below.*
 *   - **The metadata is mono BOLD, uppercase, in `ink`** — `07:30 · 35 MIN ·
 *     MORNING STACK` — not a quiet secondary line. It is the measured statement
 *     of when and how long; the rule beside it is what dimensions it. *Still true
 *     of the voice; its CONTENT changed, see below.*
 *   - **The headline is regular weight.** The sheet sets it at 400; the app had
 *     it semibold, which put two bold blocks (headline + metadata) in the one
 *     card and flattened the difference between them.
 *   - ~~**The why-line is serif ITALIC.**~~ Italic is still this design's mark for
 *     *rationale* prose — it recurs on the mission why-line and the readiness
 *     verdict. What was wrong was applying it to **everything** that lands in
 *     `why`, half of which was a dose — a split the generator now carries as
 *     `item.dose` rather than leaving this file to infer it.
 *   - ~~**The two-up controls are 2:1 and UPPERCASE.**~~ The 2:1 ratio and the
 *     casing stand and are unchanged; what does not is `.cf-herofoot` putting
 *     Skip on a row of its own. See below.
 *
 * `grow-[2] basis-0` / `grow basis-0` rather than `flex-[2]` / `flex-1`: these
 * are flex LONGHANDS, which react-native-css-interop maps straight onto
 * `flexGrow` / `flexBasis`, where the `flex` shorthand has to be parsed into
 * three values first. Same geometry, one less thing to be wrong about on device.
 *
 * ## Reworked from hardware, 2026-08-11
 *
 * The owner's report was *"the do next hero at the top isn't looking great"*, on
 * a day whose next item was a 5g creatine dose. Four things were wrong and all
 * four have one root: **the sheet draws this hero exactly once, with a 35-minute
 * Zone 2 session and a three-line rationale, and the app has to draw it for every
 * item on every day.** Conforming to a single drawn instance conformed to its
 * proportions as well as to its marks, and the proportions do not survive
 * contact with a one-word supplement.
 *
 * **1. The protocol name left the dimension row.** The sheet's figure is
 * `07:30 · 35 MIN · TRAINING`, where the last term is the CATEGORY — one short
 * word from a closed vocabulary. The app was putting `item.protocol` there
 * instead, which is user-authored and unbounded, so the real string was
 * `07:30 · DAILY SUPPLEMENT STACK`: 30 characters that squeezed the rule to a
 * third of the row. Two independent arguments say the same thing about it. By
 * §3, a protocol name is a proper noun, and mono is for measured values — setting
 * it in mono bold ink at the same weight as the time is the same category error
 * as the italic dose. And by geometry, the one string on this card nobody can
 * bound must not be the one competing with a fixed drafting mark.
 *
 * It moved to the head row, right-aligned in the metadata voice — the same
 * treatment the mission row gives its category (./mission-item.tsx), because it
 * is the same kind of fact: attribution, not measurement. That row was a short
 * tag against ~150pt of empty paper, so this costs **no height at all**; it
 * spends width that was already there. It also has to stay on this card: the
 * mission rows dropped the protocol name on 2026-08-10 explicitly because "the
 * hero above already names the one for the item you are about to do".
 *
 * The two runs cannot collide, and that is structural rather than lucky. An item
 * with a `protocol` gets its `category` from `CATEGORY_BY_TYPE` — eight words,
 * longest "Medications". The items whose category IS long are modes ("Recover")
 * and experiments (`Experiment · <title>`, unbounded), and neither carries a
 * protocol at all, so the head row is a single full-width run for exactly the
 * cases that need one.
 *
 * **2. The dose left the why-line** for the dimension figure, where the sheet
 * puts `35 MIN`. This is the change that fixes the
 * screenshot: the orphaned fragment stops existing, and the row that was measuring
 * a proper noun starts measuring a quantity. It also removes ~32pt of the card's
 * height in the creatine case, and **zero** in the Zone 2 case, which is the right
 * shape for the complaint — the card was too tall precisely when it had least to
 * say.
 *
 * **3. Skip joined the button row.** The sheet gives it `.cf-herofoot`, a
 * centred row of its own; at 44pt plus its gap that is 48pt of card for one bare
 * word, under which sits another 16pt of the stamp's own padding. On the sheet
 * that footer is a small fraction of a tall card. Under a one-line supplement it
 * was a quarter of the block and read as dead paper — three controls of near-equal
 * vertical weight for one 5g dose.
 *
 * Three-up at **2:1:1** keeps the sheet's Done:Snooze ratio intact and states the
 * hierarchy the way §3 says to state it — by fill and ink, not by position: solid
 * accent, outlined ink, bare muted, at 2, 1 and 1 of the width. Every target is
 * still ≥44pt, held by `min-h` and padding, and Skip's is now larger than it was
 * (a quarter of the row rather than the width of the word).
 *
 * The cost, recorded because it is real: the vertical break was also a safety
 * margin, and a mis-tapped Skip is awkward to undo — `toggleMission` moves a
 * `skipped` row to `completed`, not back to `pending`. Skip is mitigated here by
 * being the furthest control from the primary, the only one with no border, and
 * the faintest ink, with ~16pt of clear space between Snooze's border and its
 * text. If that proves not to be enough on hardware, the fix is `toggleMission`
 * — the undo — not a third row of chrome.
 *
 * **4. Vertical rhythm, against the sheet at its own scale.** The mockup is drawn
 * at 344px to represent a 390pt device, so its numbers are pt × 0.882 and every
 * gap in it had been rounded to the app's nearest step in the wrong direction:
 * tag → title 5px (5.7pt) shipped as 8pt, title → figure 12px (13.6pt) shipped as
 * 12pt. Both are now `mt-1.5` / `mt-3.5`, which binds the tag to the headline it
 * labels and opens the figure away from it — the two gaps had been within 4pt of
 * each other, so the tag floated between the two blocks instead of belonging to
 * one. The headline's leading goes to the sheet's 1.18 (`leading-[26px]`, was
 * `leading-7` = 1.27); display type wants tight leading, and it pays twice on the
 * two-line titles a Zone 2 session produces.
 *
 * The mono figure deliberately stays at 12px rather than moving to the sheet's
 * 13.6pt equivalent. It is the one remaining off-sheet size and it is off-sheet on
 * purpose: every point added to that face widens the figure and shortens the rule,
 * which is the exact failure this rework exists to undo.
 */
export function HeroCard({ item, onDone, onSnooze, onSkip }: Props) {
  if (!item) return <MissionComplete />;

  // Two fields, two kinds of content, and no inspection of either: the dose is
  // a quantity and joins the figure, the rationale is prose and keeps the
  // italic serif line. Which is which is a fact the generator carries, not a
  // shape this file infers.
  const why = item.why?.trim() || undefined;
  const dose = item.dose?.trim() || undefined;

  // What the rule dimensions: when, how long, how much.
  const figure = [item.scheduledTime, item.estimatedMinutes && `${item.estimatedMinutes} min`, dose]
    .filter(Boolean)
    .join(' · ');

  const tag = item.category ? `${item.category} · Do this next` : 'Do this next';

  return (
    <Block device="stamp">
      {/* The head row: what kind of thing on the left, where it came from on the
          right. Both are attribution, so both are the label voice, and the accent
          is spent only on the half that says "do this next". */}
      <View className="flex-row items-baseline justify-between gap-3">
        {/* Two lines, where the protocol beside it gets one. The tag is the only
            run on this row that may wrap, and it may only ever need to in the
            case where it is alone: an experiment's category carries the
            experiment's title, and an experiment carries no protocol. Truncating
            it would cut "· Do this next", which is the hero's entire claim. */}
        <Text
          numberOfLines={2}
          className="shrink font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
          {tag}
        </Text>

        {item.protocol ? (
          <Text
            numberOfLines={1}
            className="shrink font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            {item.protocol}
          </Text>
        ) : null}
      </View>

      <Text className="mt-1.5 font-serif text-[22px] leading-[26px] text-ink">{item.title}</Text>

      {figure ? (
        <View className="mt-3.5 flex-row items-center gap-2.5">
          {figure.length <= MAX_DIMENSIONED_FIGURE ? <DimensionRule /> : null}
          {/* One line, ellipsised — the RN equivalent of the sheet's
              `white-space: nowrap` on `.cf-hero-dim-v`. The bound above is what
              normally keeps this from ever truncating; this is the floor under
              it, not the plan. */}
          <Text
            numberOfLines={1}
            className="shrink font-mono text-[12px] font-bold uppercase tracking-[0.3px] text-ink">
            {figure}
          </Text>
        </View>
      ) : null}

      {why ? (
        <Text className="mt-3 font-serif text-[13px] italic leading-5 text-ink-secondary">
          {why}
        </Text>
      ) : null}

      {/* Commit, defer, abandon — one row, three weights, descending left to
          right. `px-2` rather than `px-3`: width comes from the flex ratio, and
          the tighter inset is what keeps "Snooze" on one line in the narrowest
          quarter (375pt device → 71pt cell against ~36pt of condensed caps). */}
      <View className="mt-4 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Mark ${item.title} done`}
          onPress={() => onDone(item.id)}
          className="min-h-[44px] shrink grow-[2] basis-0 items-center justify-center rounded-btn border-[1.4px] border-pine-deep bg-pine px-2 py-3 active:opacity-70">
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[0.6px] text-pine-on">
            Done
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Snooze ${item.title}`}
          onPress={() => onSnooze(item.id)}
          className="min-h-[44px] shrink grow basis-0 items-center justify-center rounded-btn border-[1.4px] border-ink px-2 py-3 active:opacity-60">
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[0.6px] text-ink-secondary">
            Snooze
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Skip ${item.title}`}
          onPress={() => onSkip(item.id)}
          className="min-h-[44px] shrink grow basis-0 items-center justify-center rounded-btn px-2 py-3 active:opacity-60">
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[0.6px] text-ink-muted">
            Skip
          </Text>
        </Pressable>
      </View>
    </Block>
  );
}

/**
 * Shown once nothing is left.
 *
 * Conformed Set treatment — the **ruled plate**, restored 2026-08-10. The sheet
 * that authors this state (H-02, "Today is handled") draws it on a `.cf-card`:
 * a bordered `paper-hi` plate, its contents centred, the completion mark stacked
 * above the title rather than beside it. The app was drawing it on the unmarked
 * `field` device with a left-aligned row — almost certainly a casualty of the
 * de-plating sweep whose governing rule the owner rejected outright the same day
 * ("All the wrong boxes were removed, bring them back!", decisions.md 2026-08-10
 * §1a). It is the reward for a clean day; it should look like a record stamped
 * complete, not like a stray sentence.
 *
 * The mark stays a **square**: 00-design-spec.md §4 is "corners: square", and
 * the mockup's `border-radius: 50%` here is the mockup diverging from its own
 * spec — the same call already made for the mission row's status control.
 *
 * The check is stamped in the accent rather than in a signal green: completion
 * is chrome, not biology, and the signal palette is reserved for biological
 * state (00-design-spec.md §2). The old green disc was on the wrong side of
 * that firewall.
 */
function MissionComplete() {
  return (
    <Block device="plate">
      <View className="items-center px-2 py-3">
        <View className="h-7 w-7 items-center justify-center bg-pine">
          <Ionicons name="checkmark" size={18} color={palette.pineOn} />
        </View>
        <Text className="mt-2.5 text-center font-serif text-[22px] font-semibold text-ink">
          Today is handled
        </Text>
        {/* The wind-down advice that followed was cut by the owner as
            explanatory copy on 2026-08-11. The statement of the empty state
            itself is load-bearing and stays. */}
        <Text className="mt-2 max-w-[260px] text-center font-serif text-[13px] leading-5 text-ink-secondary">
          Nothing left on the list.
        </Text>
      </View>
    </Block>
  );
}
