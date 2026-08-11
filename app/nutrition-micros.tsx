import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { dayMicroTotals } from '@/lib/db/repositories/nutrition';
import { fmtMicro } from '@/lib/nutrition/format';
import { MICROS, type Micros } from '@/lib/nutrition/micros';

/**
 * Today's micronutrient totals (0014 snapshots), summed from meal items.
 *
 * Conformed Set treatment: the two prose passages are **margin annotations**
 * (unmarked as of 2026-08-09 — prose sits on the sheet, set apart by air and the
 * serif voice, not by a rule), and the
 * totals are a **ruled plate**, because a list of measured records is a table.
 *
 * The Cal-AI "goal ring" translated to ARC (docs/nutrition-subapp.md §2): mono
 * numbers and a thin neutral rule against a general reference value, never a
 * neon dial and never a good/bad colour — a daily micro total is not a
 * biological state, so the signal palette stays out of it (the firewall,
 * 00-design-spec.md §2), and the reference is context rather than a verdict the
 * user set. Sodium's reference is a ceiling to stay under, framed accordingly.
 * Read-only, so there is **no accent on this screen at all**.
 *
 * A micronutrient with no recorded contribution reads "not recorded" and draws
 * no rule — no data, no number.
 */

function readMicros(): Micros {
  return dayMicroTotals(getDb(), todayISODate());
}

export default function NutritionMicrosScreen() {
  const [micros, setMicros] = useState<Micros>(readMicros);
  const reload = useCallback(() => setMicros(readMicros()), []);
  useFocusEffect(reload);

  const recorded = MICROS.filter((m) => micros[m.key] != null).length;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Micronutrients" />
      </View>

      <View className="mt-2">
        <Block device="margin">
          <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
            Today’s totals from logged foods, against a general daily reference. Only foods with
            recorded micronutrients contribute — coverage grows as your catalog does.
          </Text>
        </Block>
      </View>

      {recorded === 0 ? (
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          Nothing recorded yet today. Log foods from the catalog (many seeded staples carry micros)
          to see this fill in.
        </Text>
      ) : (
        <>
          <View className="mt-6">
            <Block device="plate">
              <SectionLabel label="Today" note={`${recorded} of ${MICROS.length} recorded`} />
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
                Reference values are general daily guidance (FDA Daily Values; omega-3 uses the ALA
                adequate intake), not personal targets. Sodium is shown as an upper limit.
              </Text>
            </Block>
          </View>
        </>
      )}
    </Screen>
  );
}
