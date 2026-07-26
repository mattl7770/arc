import { Text, View } from 'react-native';

import { CommandField } from '@/components/log/command-field';
import { QuickAddGrid } from '@/components/log/quick-add-grid';
import { RecentLogs } from '@/components/log/recent-logs';
import { Screen } from '@/components/ui/screen';
import { useLogFeed } from '@/hooks/use-log-feed';

/**
 * Log — fast capture. Direction A ("Open Line"), locked 2026-07-25
 * (docs/information-architecture.md). Three layers:
 *   1. the command / voice field (free notes + parse) — the hero,
 *   2. six quick-add tiles (Nutrition & Workout push sub-app screens; Water &
 *      Weight open the metric keypad; Supplement & Therapy open a capture sheet),
 *   3. today's running record, read live from the DB.
 *
 * The command field and the keypad persist to on-device SQLite; the feed reloads
 * on capture and whenever the tab regains focus (returning from the keypad).
 */
export default function LogScreen() {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const { entries, reload } = useLogFeed();

  return (
    <Screen scroll>
      <View className="pt-2">
        <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">{today}</Text>
        <Text className="mt-1 font-serif text-[26px] font-semibold text-ink">Log</Text>
      </View>

      <View className="mt-5">
        <CommandField onLogged={reload} />
      </View>

      <View className="mt-6">
        <QuickAddGrid />
      </View>

      <View className="mt-8">
        <RecentLogs entries={entries} />
      </View>
    </Screen>
  );
}
