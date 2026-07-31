import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { Sparkline } from '@/components/ui/sparkline';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { deviceLabel } from '@/lib/db/repositories/wearables';
import { useWearables, type WearableMetricRow } from '@/hooks/use-wearables';

/**
 * Data › Wearables — the wearable history ledger (docs/wearables-subapp.md §7).
 * Recovery / Sleep / Activity metric rows (30-day sparkline + latest value +
 * source · date qualifier) and the recent ingested workouts. Exploratory, never
 * directive; no pine anywhere — the one call-to-action state (nothing synced
 * yet) is a neutral pointer into Settings › Apple Health.
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

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
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
      className={`flex-row items-center gap-3 px-4 py-3 ${
        first ? '' : 'border-t border-hairline-soft'
      }`}>
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{row.name}</Text>
        <Text className="mt-0.5 text-[11px] text-ink-muted">{row.sub}</Text>
      </View>

      {row.empty ? (
        <Text className="text-[12px] text-ink-muted">No data yet</Text>
      ) : (
        <>
          {row.spark.length > 1 ? (
            <Sparkline data={row.spark} baseline={row.sparkBaseline} />
          ) : null}
          <View className="items-end">
            <View className="flex-row items-baseline gap-1">
              <Text className="font-mono text-[17px] text-ink">{row.value}</Text>
              {row.unit ? (
                <Text className="font-mono text-[11px] text-ink-muted">{row.unit}</Text>
              ) : null}
            </View>
            {row.qualifier ? (
              <Text className="mt-0.5 text-[10px] text-ink-muted">{row.qualifier}</Text>
            ) : null}
          </View>
        </>
      )}
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

      {/* Honest first-run: nothing ingested yet → point at the switch. */}
      {allEmpty ? (
        <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
          <Text className="font-serif text-[16px] font-semibold text-ink">
            No wearable data yet
          </Text>
          <Text className="mt-1 text-[12.5px] leading-5 text-ink-secondary">
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
            className="mt-3 flex-row items-center justify-between rounded-btn border border-hairline-strong px-3 py-2.5 active:bg-paper-deep">
            <Text className="text-[13.5px] font-medium text-ink">Settings › Apple Health</Text>
            <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
          </Pressable>
        </View>
      ) : null}

      {sections.map((section) => (
        <View key={section.title} className="mt-8">
          <SectionLabel>{section.title}</SectionLabel>
          <View className="mt-3 rounded-card border border-hairline bg-porcelain">
            {section.rows.map((row, index) => (
              <MetricRow key={row.key} row={row} first={index === 0} />
            ))}
          </View>
        </View>
      ))}

      {/* Recent workouts as ingested from other apps/devices. */}
      <View className="mt-8">
        <SectionLabel>Workouts · via Apple Health</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
          {workouts.length === 0 ? (
            <View className="px-4 py-3">
              <Text className="text-[12px] text-ink-muted">
                None ingested yet — sessions logged in ARC live in the Exercise tab.
              </Text>
            </View>
          ) : (
            workouts.map((workout, index) => (
              <View
                key={`${workout.date}-${index}`}
                accessible
                accessibilityLabel={`${workout.activity ?? 'Workout'}, ${Math.round(workout.durationMin)} minutes, ${shortDay(workout.date)}, ${deviceLabel(workout.sourceDevice)}.`}
                className={`flex-row items-center gap-3 px-4 py-3 ${
                  index === 0 ? '' : 'border-t border-hairline-soft'
                }`}>
                <View className="flex-1">
                  <Text className="text-[14px] text-ink">{workout.activity ?? 'Workout'}</Text>
                  <Text className="mt-0.5 text-[11px] text-ink-muted">
                    {shortDay(workout.date)} · {deviceLabel(workout.sourceDevice)}
                  </Text>
                </View>
                <View className="items-end">
                  <Text className="font-mono text-[15px] text-ink">
                    {Math.round(workout.durationMin)} min
                  </Text>
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
      </View>

      {/* Sync footer — quiet, mono, honest. */}
      <Text className="mt-6 px-1 font-mono text-[10px] text-ink-muted">
        {lastSyncedAt
          ? `Last synced ${shortDayOfInstant(lastSyncedAt)} · sources labelled per device`
          : 'Never synced'}
      </Text>
    </Screen>
  );
}
