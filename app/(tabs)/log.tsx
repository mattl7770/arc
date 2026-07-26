import { Text, View } from 'react-native';

import { CommandField } from '@/components/log/command-field';
import { QuickAddGrid } from '@/components/log/quick-add-grid';
import { RecentLogs } from '@/components/log/recent-logs';
import { Screen } from '@/components/ui/screen';

/**
 * Log — fast capture. Direction A ("Open Line"), locked 2026-07-25
 * (docs/information-architecture.md). Three layers:
 *   1. the command / voice field (free notes + parse) — the hero,
 *   2. six quick-add tiles (Meal → Nutrition and Workout → Exercise push
 *      sub-app screens; the rest open a sheet or the metric keypad),
 *   3. today's running record.
 *
 * Skeleton for now: the structure is real and navigable, but capture doesn't
 * persist and the recents are mock. Wiring writes/reads to the DB (and the
 * command-field parse) is the next step.
 */
export default function LogScreen() {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <Screen scroll>
      <View className="pt-2">
        <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">{today}</Text>
        <Text className="mt-1 font-serif text-[26px] font-semibold text-ink">Log</Text>
      </View>

      <View className="mt-5">
        <CommandField />
      </View>

      <View className="mt-6">
        <QuickAddGrid />
      </View>

      <View className="mt-8">
        <RecentLogs />
      </View>
    </Screen>
  );
}
