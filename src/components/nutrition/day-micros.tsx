import { Text, View } from 'react-native';

import { GridCell } from '@/components/ui/block';
import type { DayMicroReading } from '@/lib/nutrition/key-micro';

/**
 * Sodium, caffeine and fiber under the Today grid's macro bars (owner, from the
 * device, 2026-09-23: *"Sodium and caffeine more accessible"*, *"Fiber should
 * be more visible too"*). The readings and their words are computed in
 * src/lib/nutrition/key-micro.ts (`dayKeyMicros`); this file only draws them.
 *
 * ## One more row of the same grid, not a new block
 *
 * The three cells are `GridCell`s inside the Today `device="grid"` block, so
 * the rule above them is the grid's own rule BETWEEN rows — no second device,
 * nothing nested (00-design-spec.md §1). They sit a step below the macro cells
 * in every voice: a 10px label against the macros' 11px, a 15px mono figure
 * against their 20px, and **no bar**. A bar under a daily micro total would be
 * a gauge beside the macro gauges, and it would ask for the colour the firewall
 * refuses it: a daily micro total is not a biological state, and the macro
 * bars' signal fills are an owner override for macros alone
 * (docs/project-status.md §3). Mono figures against a reference, then, and ink
 * only — no signal colour and no accent.
 *
 * ## The three lines of a cell
 *
 *   SODIUM            label voice, what the figure is
 *   1,240 mg          mono, the day's total (an em-dash when nothing recorded it)
 *   of ~2,300 limit   mono, what it is read against — a ceiling for sodium and
 *                     caffeine, the owner's own target for fiber
 *
 * The unit sits on the figure so the reference line fits a 375pt phone's third
 * of the grid (15 characters of 10px mono in ~92pt). VoiceOver reads each cell
 * as one sentence (`spoken`), because three short lines read separately say
 * "sodium", "1,240", "mg" and lose the reference.
 *
 * The rest of the shortlist stays on the micronutrients screen, reached from
 * Over time as it always was — this row answers "how am I doing on the three
 * I named", not "show me everything".
 */
export function DayMicrosRow({
  readings,
  note,
}: {
  readings: DayMicroReading[];
  /** The totals-only caveat (`totalsOnlyNote`), or null on a day it is not true. */
  note: string | null;
}) {
  return (
    <>
      <View className="flex-row flex-wrap">
        {readings.map((reading, index) => (
          <GridCell key={reading.key} index={index} count={readings.length} columns={3}>
            <View accessible accessibilityLabel={reading.spoken}>
              <Text
                numberOfLines={1}
                className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-secondary">
                {reading.label}
              </Text>
              <View className="mt-1 flex-row items-baseline gap-1">
                <Text
                  className={
                    reading.figure !== null
                      ? 'font-mono text-[15px] text-ink'
                      : 'font-mono text-[15px] text-ink-muted'
                  }>
                  {reading.figure ?? '—'}
                </Text>
                {reading.figure !== null ? (
                  <Text className="font-mono text-[11px] text-ink-secondary">{reading.unit}</Text>
                ) : null}
              </View>
              <Text numberOfLines={1} className="mt-0.5 font-mono text-[10px] text-ink-muted">
                {reading.against}
              </Text>
            </View>
          </GridCell>
        ))}
      </View>
      {note ? (
        <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">{note}</Text>
      ) : null}
    </>
  );
}
