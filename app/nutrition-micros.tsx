import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { dayMicroTotals } from '@/lib/db/repositories/nutrition';
import { fmtMicro } from '@/lib/nutrition/format';
import { MICROS, type Micros } from '@/lib/nutrition/micros';

/**
 * Today's micronutrient totals (0014 snapshots), summed from meal items.
 *
 * The Cal-AI "goal ring" translated to Porcelain Ledger (docs/nutrition-subapp.md
 * §2): mono numbers and a thin neutral track against a general reference value,
 * never a neon dial and never a good/bad colour — a daily micro total is not a
 * biological state, and the reference is context, not a verdict the user set.
 * Sodium's reference is a ceiling to stay under, framed accordingly. Read-only,
 * so there is no pine action on this screen.
 */

function readMicros(): Micros {
  return dayMicroTotals(getDb(), todayISODate());
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

export default function NutritionMicrosScreen() {
  const [micros, setMicros] = useState<Micros>(readMicros);
  const reload = useCallback(() => setMicros(readMicros()), []);
  useFocusEffect(reload);

  const anyData = MICROS.some((m) => micros[m.key] != null);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Micronutrients" />
      </View>

      <Text className="mt-1 text-xs leading-5 text-ink-muted">
        Today’s totals from logged foods, against a general daily reference. Only foods with
        recorded micronutrients contribute — coverage grows as your catalog does.
      </Text>

      {!anyData ? (
        <Text className="mt-6 text-[13px] leading-5 text-ink-muted">
          No micronutrient data yet today. Log foods from the catalog (many seeded staples carry
          micros) to see this fill in.
        </Text>
      ) : (
        <View className="mt-6">
          <SectionLabel>Today</SectionLabel>
          <View className="mt-2 rounded-card border border-hairline bg-porcelain px-4">
            {MICROS.map((m, index) => {
              const value = micros[m.key] ?? null;
              const pct = value !== null ? Math.min(100, (value / m.reference) * 100) : 0;
              return (
                <View
                  key={m.key}
                  className={`py-3 ${index === 0 ? '' : 'border-t border-hairline-soft'}`}>
                  <View className="flex-row items-baseline justify-between">
                    <Text className="text-[14px] text-ink">{m.label}</Text>
                    <View className="flex-row items-baseline gap-1">
                      {value !== null ? (
                        <>
                          <Text className="font-mono text-[14px] text-ink">
                            {fmtMicro(value, m.decimals)}
                          </Text>
                          <Text className="font-mono text-[11px] text-ink-muted">
                            {m.unit} {m.ceiling ? 'of ' : '/ '}
                            {fmtMicro(m.reference, m.decimals)}
                            {m.ceiling ? ' limit' : ''}
                          </Text>
                        </>
                      ) : (
                        <Text className="font-mono text-[11px] text-ink-muted">not recorded</Text>
                      )}
                    </View>
                  </View>
                  {value !== null ? (
                    <View className="mt-1.5 h-1 overflow-hidden rounded-full bg-hairline">
                      <View
                        className="h-1 rounded-full bg-ink-secondary"
                        style={{ width: `${pct}%` }}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
          <Text className="mt-3 text-xs leading-5 text-ink-muted">
            Reference values are general daily guidance (FDA Daily Values; omega-3 uses the ALA
            adequate intake), not personal targets. Sodium is shown as an upper limit.
          </Text>
        </View>
      )}
    </Screen>
  );
}
