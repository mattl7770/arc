import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { LogFeedItem } from '@/types/log';

/**
 * Today's log so far — a running record beneath the capture controls, newest
 * first. Times in mono, hairline-soft row separators; notes set in serif italic
 * with a "for Coach" label so a bucket-less note reads as something the Coach
 * will read, not a half-filled metric. Reads real entries from the DB
 * (src/hooks/use-log-feed.ts); empty until the first capture of the day.
 */
export function RecentLogs({ entries }: { entries: LogFeedItem[] }) {
  return (
    <View>
      <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
        Logged today
      </Text>
      {entries.length === 0 ? (
        <Text className="mt-3 text-[15px] leading-6 text-ink-muted">
          Nothing logged yet today. Use the field above, a tile, or the keypad — it lands here.
        </Text>
      ) : (
        <View className="mt-1">
          {entries.map((entry, index) => (
            <View
              key={entry.id}
              className={`flex-row gap-3 py-3 ${index === 0 ? '' : 'border-t border-hairline-soft'}`}>
              <Text className="w-11 pt-0.5 font-mono text-[11px] text-ink-muted">{entry.time}</Text>
              <View className="flex-1">
                <Text
                  className={
                    entry.note
                      ? 'font-serif text-[15px] italic leading-5 text-ink-secondary'
                      : 'text-[15px] leading-5 text-ink'
                  }>
                  {entry.title}
                </Text>
                <View className="mt-1 flex-row items-center gap-1.5">
                  {entry.note ? (
                    <Ionicons
                      name="reader-outline"
                      size={11}
                      color={palette.inkMuted}
                      accessibilityElementsHidden
                      importantForAccessibility="no"
                    />
                  ) : null}
                  <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">
                    {entry.note ? 'Note · for Coach' : entry.category}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
