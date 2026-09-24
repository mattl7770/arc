import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  activeNutritionTargets,
  dayFiberTotal,
  dayMicroTotals,
} from '@/lib/db/repositories/nutrition';
import { fmtMicro } from '@/lib/nutrition/format';
import { MICROS, type Micros } from '@/lib/nutrition/micros';

/**
 * Today's micronutrient totals (0014 snapshots), summed from meal items.
 *
 * Conformed Set treatment: the closing prose passage is a **margin annotation**
 * (unmarked as of 2026-08-09 — prose sits on the sheet, set apart by air and the
 * serif voice, not by a rule), and the
 * totals are a **ruled plate**, because a list of measured records is a table.
 *
 * The Cal-AI "goal ring" translated to ARC (docs/nutrition-subapp.md §2): mono
 * numbers and a thin neutral rule against a general reference value, never a
 * neon dial and never a good/bad colour — a daily micro total is not a
 * biological state, so the signal palette stays out of it (the firewall,
 * 00-design-spec.md §2), and the reference is context rather than a verdict the
 * user set. Sodium's and caffeine's references are ceilings to stay under,
 * framed accordingly. Read-only, so there is **no accent on this screen at
 * all**.
 *
 * **Where every reference value comes from** — sourced in
 * `src/lib/nutrition/micros.ts`, which is the one place they are written:
 * FDA Daily Values (21 CFR 101.9) for the minerals and vitamins, sodium's
 * 2,300 mg included; the IOM's Adequate Intake for omega-3 (ALA); and the FDA's
 * 400 mg/day figure for healthy adults for caffeine, which is guidance about a
 * compound rather than a nutrient requirement. Fiber is the exception and is
 * read against the user's OWN target — see the note on its plate below.
 *
 * A micronutrient with no recorded contribution reads "not recorded" and draws
 * no rule — no data, no number. A PARTIAL one still draws a figure and a filled
 * rule, because the sum cannot tell which foods were missing from it; the
 * caveat above the rows is what keeps that figure honest.
 *
 * Fiber is the one figure here read against a **personal target**, not a
 * reference — `nutrition_targets.fiber_g`, the same value the Coach reads. It is
 * summed from meal items (manual meals record none) and lives in its own plate
 * so the reference-value firewall stays intact: the micros plate's closing
 * annotation says "not personal targets", and fiber is exactly that, so it must
 * not sit under it. (The Eat tab reads fiber too since 2026-09-23 — eaten
 * against the same target, beside sodium and caffeine under its macro bars, and
 * never counted down: src/components/nutrition/day-micros.tsx.)
 *
 * **The plate stands whether or not a target is set** (changed 2026-09-14,
 * backlog A8 — caffeine, fiber, sodium are the three the owner named, and one
 * of them was invisible on a profile that had never opened the targets screen).
 * With no target the figure prints alone: no denominator, no rule, and a label
 * that says a target is what is missing. That is §5 of 00-design-spec.md —
 * *no denominators until targets exist* — rather than the old behaviour of
 * hiding a number the day genuinely recorded.
 */

type MicrosData = {
  micros: Micros;
  /** Fiber eaten today, summed from meal items (0 when none recorded). */
  fiberEaten: number;
  /** The active fiber target in grams, or null until one is set. */
  fiberTarget: number | null;
};

function readMicros(): MicrosData {
  const db = getDb();
  const date = todayISODate();
  return {
    micros: dayMicroTotals(db, date),
    fiberEaten: dayFiberTotal(db, date),
    fiberTarget: activeNutritionTargets(db, date)?.fiber_g ?? null,
  };
}

export default function NutritionMicrosScreen() {
  const [data, setData] = useState<MicrosData>(readMicros);
  const reload = useCallback(() => setData(readMicros()), []);
  useFocusEffect(reload);

  const { micros, fiberEaten, fiberTarget } = data;
  const recorded = MICROS.filter((m) => micros[m.key] != null).length;
  const fiberPct =
    fiberTarget !== null && fiberTarget > 0 ? Math.min(100, (fiberEaten / fiberTarget) * 100) : 0;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Micronutrients" />
      </View>

      {/* The opening annotation was cut on 2026-08-11 against the closing one.
          Half of that was right — "today's totals from logged foods" is what
          the title already says. The other half was not: the closing annotation
          qualifies the DENOMINATOR (reference values), and the clause cut with
          it qualified the NUMERATOR. `dayMicroTotals` sums only meal items
          `WHERE mi.micros IS NOT NULL` (repositories/nutrition.ts), so a day
          holding any food without micro data undercounts, silently — the
          section note counts micros with a value, not foods that contributed,
          and the per-row "not recorded" only fires at zero. That is a number
          the data cannot support (00-design-spec.md §5), so the numerator
          caveat is restored below, next to the figures it governs rather than
          in the closing annotation. Not on this empty branch: nothing is
          claimed here, and the line below already names the catalog. */}
      {recorded === 0 ? (
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          Nothing recorded yet today. Foods from the catalog contribute micronutrients, and an
          estimate records the ones a food is a notable source of.
        </Text>
      ) : (
        <>
          <View className="mt-6">
            <Block device="plate">
              <SectionLabel label="Today" note={`${recorded} of ${MICROS.length} recorded`} />
              {/* The numerator caveat, inside the plate so it governs every
                  figure under it. Muted 13px serif is this file's caveat voice
                  (the closing annotation). */}
              <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-muted">
                Only foods with recorded micronutrients contribute, so these totals can run low.
              </Text>
              <View className="mt-1">
                {MICROS.map((m, index) => {
                  const value = micros[m.key] ?? null;
                  const pct = value !== null ? Math.min(100, (value / m.reference) * 100) : 0;
                  return (
                    <View key={m.key}>
                      <Divider first={index === 0} />
                      <View className="py-3">
                        <View className="flex-row items-baseline justify-between gap-3">
                          <Text className="flex-1 font-serif text-[14px] text-ink">{m.label}</Text>
                          <View className="flex-row items-baseline gap-1">
                            {value !== null ? (
                              <>
                                <Text className="font-mono text-[14px] text-ink">
                                  {fmtMicro(value, m.decimals)}
                                </Text>
                                <Text className="font-mono text-[10px] text-ink-muted">
                                  {m.unit} {m.ceiling ? 'of ' : '/ '}
                                  {fmtMicro(m.reference, m.decimals)}
                                  {m.ceiling ? ' limit' : ''}
                                </Text>
                              </>
                            ) : (
                              <Text className="font-mono text-[10px] text-ink-muted">
                                not recorded
                              </Text>
                            )}
                          </View>
                        </View>
                        {value !== null ? (
                          <View className="mt-1.5 h-[3px] bg-paper-deep">
                            <View
                              className="h-[3px] bg-ink-secondary"
                              style={{ width: `${pct}%` }}
                            />
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            </Block>
          </View>

          <View className="mt-3">
            <Block device="margin">
              <Text className="font-serif text-[13px] leading-5 text-ink-muted">
                Reference values are general daily guidance (FDA Daily Values; omega-3 the ALA
                adequate intake; caffeine the FDA’s 400 mg figure for healthy adults), not personal
                targets. Sodium and caffeine are shown as upper limits.
              </Text>
            </Block>
          </View>
        </>
      )}

      {/* Fiber stands apart from the micros above: it is read against the
          user's own target, not a general reference, so it cannot sit under the
          "not personal targets" annotation and gets its own plate. With no
          target there is no denominator and no rule — the figure alone, and a
          label naming what is missing. */}
      <View className="mt-3">
        <Block device="plate">
          <SectionLabel
            label="Fiber"
            note={fiberTarget !== null ? 'daily target' : 'no target set'}
          />
          <View className="mt-1 py-3">
            <View className="flex-row items-baseline justify-between gap-3">
              <Text className="flex-1 font-serif text-[14px] text-ink">Eaten today</Text>
              <View className="flex-row items-baseline gap-1">
                <Text className="font-mono text-[14px] text-ink">{fmtMicro(fiberEaten, 0)}</Text>
                <Text className="font-mono text-[10px] text-ink-muted">
                  {fiberTarget !== null ? `g of ${fmtMicro(fiberTarget, 0)} g` : 'g'}
                </Text>
              </View>
            </View>
            {/* No target, no rule: a bar with no denominator would be drawing a
                proportion of nothing. The label carries the absence instead. */}
            {fiberTarget !== null ? (
              <View className="mt-1.5 h-[3px] bg-paper-deep">
                <View className="h-[3px] bg-ink-secondary" style={{ width: `${fiberPct}%` }} />
              </View>
            ) : null}
          </View>
        </Block>
      </View>
    </Screen>
  );
}
