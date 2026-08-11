import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { logMetric, recentSummary } from '@/lib/db/repositories/logs';
import {
  isLoggableCanonical,
  METRICS,
  metricByKey,
  resolveDisplay,
  type MetricDescriptor,
  type MetricKey,
} from '@/lib/log/metrics';

/**
 * Single-number entry — the "calibrated instrument" drill-in (direction F,
 * living as a secondary screen). Reached by tapping a numeric tile (Weight,
 * Water) or switched via the metric chips. Big mono readout, a full keypad,
 * a live "recent" line, and — for Water — additive quick-estimates.
 *
 * Fully wired: "Log" converts the typed display value to the metric's canonical
 * unit and writes it (src/lib/db/repositories/logs.ts → body_metrics /
 * wearable_data / log_entries), then returns; the Log tab re-reads on focus.
 *
 * Conformed Set treatment (00-design-spec.md §1): the readout is the
 * **measured field** — a verdict about a number, so no enclosure at all.
 * Everything below it is instrument, not content: square chips, square keys,
 * every digit in mono ("serif speaks, mono measures"). The one accent on this
 * screen is the Log button; the active metric chip is stamped in ink, not pine,
 * because a selection is chrome and the budget is a ceiling.
 *
 * This paragraph used to say the field "draws nothing now — its corner ticks and
 * its padding were cut together", and that the readout therefore had to supply
 * its own inset. Both halves have expired. The ticks were never a design
 * failure: each was an 11×11 view carrying `border-l border-t`, which React
 * Native paints as a small box (the full account is in the header of
 * src/components/ui/block.tsx). The ticks and the device's `px-3 py-3` are both
 * back, so the compensating wrapper came out with them.
 *
 * **That subtraction matters more here than on any other screen**, because this
 * one renders inside a `Screen` with **no `scroll`**. Surplus vertical padding
 * does not push content down the page; it comes straight out of the Log button's
 * clearance at the bottom, and on a 375×667 phone the stack is already close to
 * the full height. 24pt where the design asks 12 is the difference between a
 * reachable primary action and a clipped one.
 *
 * ## The blank keypad (mockup sheet K-02)
 *
 * Audited against K-02 and left alone, which is the finding rather than an
 * omission. The blank state is already authored end to end and by the right
 * component: the readout drops to `ink-muted` so an untyped `0` reads as a
 * placeholder and not as a reading, and the line beneath it is written by the
 * repository, which knows whether there is history to report — "No readings
 * yet", "No readings yet — usually auto from Apple Health", "No water logged yet
 * today" (src/lib/db/repositories/logs.ts → `recentSummary`). No data, no
 * number: the screen never invents a plausible last value to sit under the pad.
 *
 * The one thing that could have gone blank is that line collapsing to zero
 * height, which would shift the pad; it now falls back to an em-dash — the
 * spec's own answer for an absent value (§5) — rather than to nothing.
 *
 * The screen is deliberately NOT scrollable: a keypad that scrolls under the
 * thumb is a broken instrument. That is also why the water estimates carry no
 * section label of their own, tempting as one is — the "+8 oz" line already says
 * what they do, and every point of height added above the pad comes out of the
 * Log button's clearance on a small phone.
 */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'] as const;

/**
 * Additive water shortcuts, sitting just above the keypad (Water only). Amounts
 * are in the CURRENT display unit — a "Glass" adds 8 oz or 240 ml depending on
 * the volume preference — so the additive maths stays in display units and the
 * stored value is still converted to canonical ml at log time.
 *
 * These already conform to K-02's `.cf-quickadd` (raised plate stock inside a
 * hairline, sitting on the sheet rather than in a well, so the raise is a
 * button's and not an inverted recess) and to the three voices — with one
 * deliberate departure from the mockup, which sets the whole tile in mono. It is
 * split here because the two halves are different things: "Glass" is a button
 * label and takes the label voice, "+8 oz" is a measured value and takes mono.
 * §3 is explicit that a measured value inside a label stays mono, and that a
 * control which falls back to the reading face stops looking pressable.
 *
 * The `+` is load-bearing: these ADD to whatever is on the readout rather than
 * replacing it, so three taps of Glass is 24 oz. Without the sign a tile reading
 * "8 oz" would promise a set, not an add.
 */
const WATER_QUICK: Record<'oz' | 'ml', readonly { label: string; amount: number }[]> = {
  oz: [
    { label: 'Glass', amount: 8 },
    { label: 'Bottle', amount: 16 },
    { label: 'Large', amount: 24 },
  ],
  ml: [
    { label: 'Glass', amount: 240 },
    { label: 'Bottle', amount: 500 },
    { label: 'Large', amount: 750 },
  ],
};

/** Cap significant digits so the big readout can't overflow its row. */
function withinCap(next: string): boolean {
  return next.replace('.', '').length <= 6;
}

/**
 * Metric switch chips. Whole class strings, never a built prefix — Tailwind's
 * scanner only sees literals. Both states carry an explicit 44pt floor.
 */
const CHIP = 'min-h-[44px] justify-center rounded-btn border border-hairline px-3.5';
const CHIP_ON = 'min-h-[44px] justify-center rounded-btn border border-ink bg-ink px-3.5';

/**
 * Where the back control says it goes.
 *
 * The sheet's `.cf-back` on K-01 reads `‹ Log`, and for two of this screen's
 * three entry points that is simply true — both numeric tiles in the Log tab's
 * quick-add grid open it. The third is the Weight trend row on the Data tab, and
 * `router.back()` returns there, so a hardcoded "Log" would put a confident lie
 * on the control. Hence a param with the sheet's answer as the default: the two
 * Log-tab callers say nothing and get "Log", and Data passes its own name.
 *
 * A param rather than reading navigation state because expo-router exposes no
 * supported "title of the screen below me" — and inventing one from the history
 * stack would be a lot of machinery to render one word.
 */
const DEFAULT_PARENT = 'Log';

export default function MetricEntryScreen() {
  const router = useRouter();
  const { metric, from } = useLocalSearchParams<{ metric?: string; from?: string }>();
  const { units } = useUnitPreferences();
  const today = todayISODate();
  const initialKey = metricByKey(metric ?? '')?.key ?? 'weight';

  const [activeKey, setActiveKey] = useState<MetricKey>(initialKey);
  const [value, setValue] = useState('');
  const [recent, setRecent] = useState(() => recentSummary(getDb(), initialKey, today, units));

  const active = useMemo<MetricDescriptor>(
    () => metricByKey(activeKey) ?? METRICS[0]!,
    [activeKey]
  );

  // Preference-aware display contract for the active metric: what unit to show,
  // how to round, and how to convert the typed value to/from the canonical store.
  const spec = useMemo(() => resolveDisplay(active, units), [active, units]);

  const press = (key: (typeof KEYS)[number]) => {
    if (key === 'del') {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key === '.') {
      setValue((v) => (v.includes('.') ? v : v === '' ? '0.' : v + '.'));
      return;
    }
    setValue((v) => {
      const next = v === '0' ? key : v + key;
      return withinCap(next) ? next : v;
    });
  };

  const addWater = (amount: number) => {
    setValue((v) => {
      const next = String((Number(v) || 0) + amount);
      return withinCap(next) ? next : v;
    });
  };

  const switchMetric = (key: MetricKey) => {
    setActiveKey(key);
    setValue('');
    setRecent(recentSummary(getDb(), key, today, units));
  };

  // A logged value must be a real positive number within the metric's domain:
  // 0/"0."/blank, and out-of-range body values (e.g. body-fat > 100, weight
  // ≥ 1000 kg) are not loggable — they'd otherwise trip a schema CHECK and throw
  // out of this handler. The typed value is in the display unit, so it converts
  // to canonical via the resolved spec; the guard checks the canonical value
  // (unit-independent) against the schema bounds.
  const canonical = spec.toCanonical(Number(value));
  const canLog = isLoggableCanonical(active, canonical);
  const outOfRange = value !== '' && Number(value) > 0 && !canLog;

  const log = () => {
    if (!canLog) return;
    try {
      logMetric(getDb(), today, active.key, canonical);
      router.back();
    } catch (error) {
      // canLog already gates the known cases; this is a backstop so a write
      // failure never crashes the tap handler.
      console.warn('[log] metric write failed', error);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <View className="pt-2">
        {/* A deep link can repeat a param, which expo-router delivers as
            string[] despite the generic — coerce so a malformed link falls back
            to the default rather than rendering "[object Object]". */}
        <StackHeader
          title={active.label}
          parent={(Array.isArray(from) ? from[0] : from) || DEFAULT_PARENT}
        />
      </View>

      {/* Metric switch chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="-mx-5 mt-1 grow-0"
        contentContainerClassName="gap-2 px-5">
        {METRICS.map((m) => {
          const on = m.key === activeKey;
          return (
            <Pressable
              key={m.key}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => switchMetric(m.key)}
              className={on ? CHIP_ON : CHIP}>
              <Text
                className={
                  on
                    ? 'font-label text-[13px] font-semibold text-paper-hi'
                    : 'font-label text-[13px] font-semibold text-ink-secondary'
                }>
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Readout — the measured field: corner ticks, no enclosure.

          NO extra padding of its own. It carried an inner `py-3` for one day,
          added while `field` was drawing nothing and supplying no inset. The
          device draws and pads again, so that wrapper was 24pt of vertical
          padding where the design asks 12 — and this screen renders inside a
          `Screen` with no `scroll`, so the surplus does not push content down,
          it eats the Log button's clearance at the bottom of a small phone. */}
      <View className="mt-7">
        <Block device="field">
          <View>
            <View className="flex-row items-baseline justify-center gap-2">
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
                className={
                  value
                    ? 'font-mono text-6xl font-semibold text-ink'
                    : 'font-mono text-6xl font-semibold text-ink-muted'
                }>
                {value || '0'}
              </Text>
              <Text className="font-mono text-lg text-ink-muted">{spec.unit}</Text>
            </View>
            {/*
              `recent` is authored by the repository when there is nothing to
              report ("No readings yet", "No water logged yet today") — no data,
              no number. The out-of-range warning is prose, so it takes the serif
              voice; the recent line is a measurement and stays mono.

              The em-dash fallback is defensive, not a state this screen reaches:
              `recentSummary` only returns '' for a metric key it cannot resolve,
              and the key here always comes from the METRICS table. It is here so
              the line can never collapse to zero height and shift the pad under a
              thumb already on its way down — and an em-dash is what the spec says
              an absent value looks like (§5), so the fallback is honest rather
              than a filler string.
            */}
            <Text
              className={
                outOfRange
                  ? 'mt-2 text-center font-serif text-[13px] leading-5 text-ink-secondary'
                  : 'mt-2 text-center font-mono text-[11px] text-ink-muted'
              }>
              {outOfRange
                ? `That looks out of range for ${active.label.toLowerCase()}`
                : recent || '—'}
            </Text>
          </View>
        </Block>
      </View>

      {/* Keypad */}
      <View className="mt-6 flex-1 justify-end">
        {active.key === 'water' ? (
          <View className="mb-3 flex-row gap-2">
            {WATER_QUICK[units.volume].map((q) => (
              <Pressable
                key={q.label}
                accessibilityRole="button"
                accessibilityLabel={`Add ${q.amount} ${spec.unit} (${q.label})`}
                onPress={() => addWater(q.amount)}
                className="min-h-[44px] flex-1 items-center justify-center rounded-btn border border-hairline bg-paper-hi px-1 py-2 active:bg-paper-dim">
                <Text className="font-label text-[12px] font-semibold text-ink">{q.label}</Text>
                <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                  +{q.amount} {spec.unit}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* Square keys, tight gaps: an instrument, not a set of cards. Every
            key is mono; the two function keys sit back in ink-muted.

            "Every key" now includes backspace. The port substituted an Ionicon
            for the sheet's `⌫`, which put a drawn icon among eleven typeset
            glyphs and quietly falsified the claim this very comment makes — one
            key in a different medium is exactly the kind of stray mark the owner
            has been reporting off hardware. `.` and `⌫` are now one pair — same
            face, same size, same muted ink — set apart from the digits by colour
            weight alone, which is exactly what `.cf-key--fn` does on the sheet.

            **U+232B renders.** The mono stack is `Menlo` first
            (tailwind.config.js), whose Bitstream Vera / DejaVu ancestry carries
            the Miscellaneous Technical block; and iOS falls back through
            CoreText to Apple Symbols for anything a face is missing, so this
            codepoint cannot draw as tofu on the one platform ARC ships to. The
            spoken label stays "Delete" — a glyph has no reading, and VoiceOver
            must not be handed a symbol name. */}
        <View className="-mx-0.5 flex-row flex-wrap">
          {KEYS.map((key) => (
            <View key={key} className="w-1/3 p-0.5">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={key === 'del' ? 'Delete' : key}
                onPress={() => press(key)}
                className="h-16 items-center justify-center active:bg-paper-dim">
                <Text
                  maxFontSizeMultiplier={1.3}
                  className={
                    key === '.' || key === 'del'
                      ? 'font-mono text-2xl font-semibold text-ink-muted'
                      : 'font-mono text-2xl font-semibold text-ink'
                  }>
                  {key === 'del' ? '⌫' : key}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>

        {/* The one pine action on this screen. Disabled is a bordered recess
            rather than a filled hairline — ink-muted clears 4.5:1 on paper-dim
            (5.17:1), which it does not on the hairline it used to sit on.

            The enabled state carries an EDGE as well as a fill. The sheet's
            `.cf-btn--solid` is the accent fill on a `1.4px solid
            var(--accent-deep)` border, and it is not decoration: a flat pine
            rectangle has no drawn boundary, so on this sheet it reads as a
            coloured area rather than as a stamped control, and it is the only
            control in the app's primary form that was missing one. The
            established pattern is the Done button in home/hero-card.tsx, which
            already ships exactly these two classes; the disabled branch keeps
            its own hairline edge, so both states are now enclosed and the
            difference between them is fill and ink alone. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Log ${active.label}`}
          accessibilityState={{ disabled: !canLog }}
          disabled={!canLog}
          onPress={log}
          className={
            canLog
              ? 'mt-4 min-h-[48px] items-center justify-center rounded-btn border-[1.4px] border-pine-deep bg-pine active:opacity-70'
              : 'mt-4 min-h-[48px] items-center justify-center rounded-btn border border-hairline bg-paper-dim'
          }>
          <Text
            className={
              canLog
                ? 'font-label text-[12px] font-semibold uppercase tracking-[1px] text-pine-on'
                : 'font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink-muted'
            }>
            Log {active.label}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
