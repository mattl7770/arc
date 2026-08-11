import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { FRESHNESS_SPOKEN, freshnessTone } from '@/components/exercise/freshness-display';
import { MuscleFigure, MuscleFigureLegend } from '@/components/exercise/muscle-figure';
import { Block, Divider } from '@/components/ui/block';
import { GaugeTrack, gaugeTextClass } from '@/components/ui/gauge';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { recentMuscleLoads } from '@/lib/db/repositories/training-stats';
import { FRESHNESS_LOOKBACK_DAYS, MUSCLE_LABEL } from '@/lib/exercise/constants';
import { muscleFreshness } from '@/lib/exercise/freshness';
import type { MuscleFreshness } from '@/lib/exercise/types';

/**
 * Muscle freshness in full — pushed from the hub's body figure. The figure
 * repeats at the top (larger), then the complete per-muscle ledger: name, a
 * gauge track, and the toned mono score, one ruled row per muscle. The hub
 * shows the figure; this screen shows the numbers behind it.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Figure + legend  field  a readout about the body — corner ticks, no box
 *   Ledger           plate  a record, ruled
 *
 * No accent — nothing here is an action. Freshness is a biological state, so
 * its marks ride the gauge's closed biological tones, never the accent; the
 * track/fill treatment and its contrast measurements live on
 * src/components/ui/gauge.tsx, and the shared state→tone/spoken maps in
 * src/components/exercise/freshness-display.ts. Each row is `accessible` so a
 * screen reader hears "Quads 82 percent, fresh" as one element — geometry and
 * colour say nothing to it (the pattern of src/components/home/signal.tsx).
 */

const read = () => muscleFreshness(recentMuscleLoads(getDb(), FRESHNESS_LOOKBACK_DAYS));

export default function MuscleFreshnessScreen() {
  const [ledger, setLedger] = useState<MuscleFreshness[]>(read);
  const reload = useCallback(() => setLedger(read()), []);
  useFocusEffect(reload);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Muscle freshness" />
      </View>

      {/* The figure — a readout about the body, so: measured field. */}
      <View className="mt-4">
        <Block device="field">
          <MuscleFigure mode="freshness" ledger={ledger} figureWidth={150} />
          <View className="mt-3">
            <MuscleFigureLegend mode="freshness" />
          </View>
        </Block>
      </View>

      {/* The complete ledger — a record, so: ruled plate. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="Per muscle" note={`Last ${FRESHNESS_LOOKBACK_DAYS} days`} />
          <View className="mt-2">
            {ledger.map((m, i) => (
              <View key={m.muscle}>
                <Divider first={i === 0} />
                <View
                  accessible
                  accessibilityLabel={`${MUSCLE_LABEL[m.muscle]} ${m.freshness} percent, ${FRESHNESS_SPOKEN[m.state]}`}
                  className="flex-row items-center gap-3 py-2">
                  <Text className="w-24 font-serif text-[13px] text-ink">
                    {MUSCLE_LABEL[m.muscle]}
                  </Text>
                  <View className="flex-1">
                    <GaugeTrack value={m.freshness} tone={freshnessTone(m.state)} />
                  </View>
                  {/* The row states its condition twice — once in the fill,
                      once in the figure's matching ink cut — and the % says
                      what the number is a number OF. */}
                  <Text
                    className={`w-10 text-right font-mono text-[12px] font-semibold ${gaugeTextClass(freshnessTone(m.state))}`}>
                    {m.freshness}%
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </Block>
      </View>

      <Text className="mt-4 font-serif text-[12px] leading-5 text-ink-muted">
        Freshness decays with every hard set and recovers on each muscle&rsquo;s own timescale —
        large muscles take ~72 h, small ones ~36 h. 100 means fully recovered.
      </Text>
    </Screen>
  );
}
