import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { Sparkline } from '@/components/ui/sparkline';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useWearables, type WearableMetricRow } from '@/hooks/use-wearables';
import { deviceLabel } from '@/lib/db/repositories/wearables';

/**
 * Data › Wearables — the wearable history ledger (docs/wearables-subapp.md §7).
 * Recovery / Sleep / Activity metric rows (30-day sparkline + latest value +
 * source · date qualifier) and the recent ingested workouts.
 *
 * ## The surface system
 *
 * Each metric group is a **ruled plate** — a record is a table
 * (src/components/ui/block.tsx). The one exception is the first-run state,
 * which is a **measured field**, because "no wearable data yet" is a *verdict*
 * about the state of the record, not a record itself. That device is now
 * **unmarked** — it drew 11px corner ticks until 2026-08-09, when the owner
 * read them as artefacts on hardware and they were cut (block.tsx, "Devices
 * that stopped paying rent"). The verdict is separated by air and type instead,
 * which on this screen is the whole point: an empty state should be the
 * quietest thing on the sheet.
 *
 * **The accent budget on this screen is zero.** This is a reading surface and
 * it is never directive, so even the one call to action — nothing synced yet,
 * go and connect Apple Health — is a neutral pointer into Settings rather than
 * a stamped action. Signal colours are absent for the mirror reason: a sleep
 * duration is a measurement here, not a graded biological verdict, and grading
 * it would put a signal colour on a number nothing has actually assessed.
 *
 * ## No data, no number
 *
 * A metric with no reading renders an em-dash and says so in its descriptor
 * slot; it draws no sparkline, because a flat line implies a measured flat
 * series. Each section note tallies exactly the rows drawn beneath it
 * (`n of total reporting`), so the header can never claim data the plate does
 * not show.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-29" → "Jul 29". For a local YYYY-MM-DD day string only — parsing
 * one via `new Date(string)` would read it as UTC midnight and shift the day. */
function shortDay(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ''} ${d ?? ''}`;
}

/** An ISO *instant* → "Jul 29" in LOCAL time. Distinct from {@link shortDay}:
 * slicing the date out of an instant would print its UTC day, which for an
 * evening sync west of Greenwich is tomorrow — a sync stamped in the future,
 * disagreeing with Settings › Apple Health for the very same sync. */
function shortDayOfInstant(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}`;
}

/** The tally a metric plate is responsible for — it counts only its own rows. */
function reportingNote(rows: WearableMetricRow[]): string {
  const reporting = rows.filter((r) => !r.empty).length;
  return reporting === 0 ? 'No data yet' : `${reporting} of ${rows.length} reporting`;
}

function MetricRow({ row, first }: { row: WearableMetricRow; first: boolean }) {
  return (
    <View
      accessible
      accessibilityLabel={
        row.empty
          ? `${row.name}. No data yet.`
          : `${row.name}. ${row.value} ${row.unit}${row.qualifier ? ', ' + row.qualifier : ''}.`
      }
      className={`min-h-[44px] flex-row items-center gap-3 py-3 ${
        first ? '' : 'border-t border-hairline'
      }`}>
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{row.name}</Text>
        {/* Authored empty in the descriptor slot, so the value slot stays a
            value slot and never has to carry a sentence. */}
        <Text className="mt-0.5 font-serif text-[11px] leading-4 text-ink-muted">
          {row.empty ? 'No data yet' : row.sub}
        </Text>
      </View>

      {/* No mark without a series: two points are the minimum that can trend. */}
      {!row.empty && row.spark.length > 1 ? (
        <Sparkline data={row.spark} baseline={row.sparkBaseline} />
      ) : null}

      <View className="items-end">
        <View className="flex-row items-baseline gap-1">
          {/* `row.value` is already '—' when the metric is empty (use-wearables). */}
          <Text
            className={
              row.empty ? 'font-mono text-[17px] text-ink-muted' : 'font-mono text-[17px] text-ink'
            }>
            {row.value}
          </Text>
          {!row.empty && row.unit ? (
            <Text className="font-mono text-[11px] text-ink-muted">{row.unit}</Text>
          ) : null}
        </View>
        {!row.empty && row.qualifier ? (
          <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{row.qualifier}</Text>
        ) : null}
      </View>
    </View>
  );
}

export default function WearablesScreen() {
  const router = useRouter();
  const { supported, enabled, lastSyncedAt, sections, workouts, allEmpty } = useWearables();

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Wearables" />
      </View>

      {/* Honest first-run: nothing ingested yet → point at the switch. A verdict
          about the record, so it takes the measured field, not a plate. */}
      {allEmpty ? (
        <View className="mt-4">
          <Block device="field">
            <Text className="font-serif text-[17px] font-semibold text-ink">
              No wearable data yet
            </Text>
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              {!supported
                ? 'The HealthKit module rides the next dev build. Once it lands, connect Apple Health and your ring or watch data flows in here.'
                : !enabled
                  ? 'Connect Apple Health in Settings and sleep, recovery, and activity history land here — all on-device.'
                  : 'Connected, but nothing has come through yet. If data looks missing, check Settings → Privacy & Security → Health → ARC — iOS doesn’t tell apps whether read access was granted.'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Apple Health settings"
              onPress={() => router.push('/settings-health')}
              className="mt-3 min-h-[44px] flex-row items-center justify-between border border-hairline px-3 py-2.5 active:opacity-60">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
                Settings › Apple Health
              </Text>
              <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
            </Pressable>
          </Block>
        </View>
      ) : null}

      {sections.map((section) => (
        <View key={section.title} className="mt-7">
          <Block device="plate">
            <SectionLabel label={section.title} note={reportingNote(section.rows)} />
            <View className="mt-1">
              {section.rows.map((row, index) => (
                <MetricRow key={row.key} row={row} first={index === 0} />
              ))}
            </View>
          </Block>
        </View>
      ))}

      {/* Recent workouts as ingested from other apps/devices. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel
            label="Workouts"
            note={workouts.length === 0 ? 'None ingested' : `${workouts.length} ingested`}
          />
          <View className="mt-1">
            {workouts.length === 0 ? (
              <Text className="py-3 font-serif text-[13px] leading-5 text-ink-muted">
                Nothing has come through Apple Health yet — sessions logged in ARC live in the
                Exercise tab.
              </Text>
            ) : (
              workouts.map((workout, index) => (
                <View
                  key={`${workout.date}-${index}`}
                  accessible
                  accessibilityLabel={`${workout.activity ?? 'Workout'}, ${Math.round(workout.durationMin)} minutes, ${shortDay(workout.date)}, ${deviceLabel(workout.sourceDevice)}.`}
                  className={`min-h-[44px] flex-row items-center gap-3 py-3 ${
                    index === 0 ? '' : 'border-t border-hairline'
                  }`}>
                  <View className="flex-1">
                    <Text className="font-serif text-[15px] text-ink">
                      {workout.activity ?? 'Workout'}
                    </Text>
                    <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                      {shortDay(workout.date)} · {deviceLabel(workout.sourceDevice)}
                    </Text>
                  </View>
                  <View className="items-end">
                    <View className="flex-row items-baseline gap-1">
                      <Text className="font-mono text-[15px] text-ink">
                        {Math.round(workout.durationMin)}
                      </Text>
                      <Text className="font-mono text-[11px] text-ink-muted">min</Text>
                    </View>
                    {workout.kcal !== null ? (
                      <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                        {Math.round(workout.kcal)} kcal
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))
            )}
          </View>
        </Block>
      </View>

      {/* Sync footer — quiet, mono, honest. Unruled: a rule here would close a
          box around the page rather than around an object. */}
      <Text className="mt-6 font-mono text-[10px] text-ink-muted">
        {lastSyncedAt
          ? `Last synced ${shortDayOfInstant(lastSyncedAt)} · sources labelled per device`
          : 'Never synced'}
      </Text>
    </Screen>
  );
}
