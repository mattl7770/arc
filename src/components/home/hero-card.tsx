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
 * The dimension rule — the drafting mark that makes the line beside it read as
 * a **measurement** rather than as a caption.
 *
 * The mockup draws it as an inline SVG (`.cf-hero-dim svg`): a baseline with a
 * vertical extension tick at each end, stretched to fill whatever width the
 * metadata string leaves. It is the single most characteristic mark on the Home
 * sheet and the app had no equivalent for it anywhere — which is a large part of
 * why the shipped hero read as a card rather than as a drawing.
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
 * The "Do this next" hero.
 *
 * Conformed Set treatment — the **stamped plate** device: paper-hi inside a
 * 1.5px accent border, square corners. It is the only block on the sheet drawn
 * in the accent, because it is the only block claiming to be the single most
 * important thing right now. If everything is emphasised, nothing is directive.
 *
 * All three voices in one block: the tag in `font-label` (tracked caps), the
 * headline and why-line in `font-serif` (serif speaks), the metadata line in
 * `font-mono` (mono measures). The primary action is solid in the accent and
 * the escapes are neutral ink, so the hierarchy of the three buttons is
 * unmistakable at a glance.
 *
 * All three controls — Done, Snooze, Skip — are set in `font-label`, per
 * 00-design-spec.md §3: "buttons" means every button at every weight, filled,
 * outlined or bare. Weight is carried by fill and ink, never by face; the three
 * share one size and casing because they are one control group, and a bare
 * escape that fell back to the reading face stopped looking pressable.
 *
 * ## Conformed against the sheet, 2026-08-10
 *
 * Five things were off the mockup and are now on it:
 *
 *   - **The dimension rule was missing entirely** (above). The metadata line sat
 *     alone on its own row and read as a caption.
 *   - **The metadata is mono BOLD, uppercase, in `ink`** — `07:30 · 35 MIN ·
 *     MORNING STACK` — not a quiet secondary line. It is the measured statement
 *     of when and how long; the rule beside it is what dimensions it.
 *   - **The headline is regular weight.** The sheet sets it at 400; the app had
 *     it semibold, which put two bold blocks (headline + metadata) in the one
 *     card and flattened the difference between them.
 *   - **The why-line is serif ITALIC.** Italic is this design's consistent mark
 *     for *rationale* prose — it recurs on the mission why-line and the readiness
 *     verdict — and the app had dropped it at all three sites, so a system-wide
 *     signal was carried nowhere.
 *   - **The two-up controls are 2:1 and UPPERCASE.** `.cf-herorow` gives Done
 *     `flex: 2` against Snooze's `flex: 1`; the app had Done at `flex-1` beside
 *     an intrinsically-sized Snooze, which is nearly 1:1 and reads as two equal
 *     choices. Casing follows 00-design-spec §3, which puts inline/compact
 *     actions at 11–13px uppercase and reserves 15px sentence case for
 *     full-width primaries — so the sheet and the spec already agreed against
 *     the code. The checkmark glyph on Done goes with them: the sheet draws no
 *     icons here, and at 2:1 the fill is what says "primary".
 *
 * `grow-[2] basis-0` / `grow basis-0` rather than `flex-[2]` / `flex-1`: these
 * are flex LONGHANDS, which react-native-css-interop maps straight onto
 * `flexGrow` / `flexBasis`, where the `flex` shorthand has to be parsed into
 * three values first. Same geometry, one less thing to be wrong about on device.
 */
export function HeroCard({ item, onDone, onSnooze, onSkip }: Props) {
  if (!item) return <MissionComplete />;

  const metadata = [
    item.scheduledTime,
    item.estimatedMinutes && `${item.estimatedMinutes} min`,
    item.protocol,
  ]
    .filter(Boolean)
    .join(' · ');

  const tag = item.category ? `${item.category} · Do this next` : 'Do this next';

  return (
    <Block device="stamp">
      <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
        {tag}
      </Text>

      <Text className="mt-2 font-serif text-[22px] leading-7 text-ink">{item.title}</Text>

      {metadata ? (
        <View className="mt-3 flex-row items-center gap-2.5">
          <DimensionRule />
          {/* One line, ellipsised — the RN equivalent of the sheet's
              `white-space: nowrap` on `.cf-hero-dim-v`. Without it a long
              category wraps and the rule beside it collapses to nothing. */}
          <Text
            numberOfLines={1}
            className="shrink font-mono text-[12px] font-bold uppercase tracking-[0.3px] text-ink">
            {metadata}
          </Text>
        </View>
      ) : null}

      {item.why ? (
        <Text className="mt-3 font-serif text-[13px] italic leading-5 text-ink-secondary">
          {item.why}
        </Text>
      ) : null}

      <View className="mt-4 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Mark ${item.title} done`}
          onPress={() => onDone(item.id)}
          className="min-h-[44px] shrink grow-[2] basis-0 items-center justify-center rounded-btn border-[1.4px] border-pine-deep bg-pine px-3 py-3 active:opacity-70">
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[0.6px] text-pine-on">
            Done
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Snooze ${item.title}`}
          onPress={() => onSnooze(item.id)}
          className="min-h-[44px] shrink grow basis-0 items-center justify-center rounded-btn border-[1.4px] border-ink px-3 py-3 active:opacity-60">
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[0.6px] text-ink-secondary">
            Snooze
          </Text>
        </Pressable>
      </View>

      <View className="mt-1 items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Skip ${item.title}`}
          onPress={() => onSkip(item.id)}
          className="min-h-[44px] items-center justify-center rounded-btn px-6 py-3 active:opacity-60">
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
