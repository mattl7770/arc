import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * Today's log so far — a running record beneath the capture controls. Times in
 * mono, hairline-soft row separators, notes set in serif italic with a
 * "for Coach" label so a bucket-less note reads as something the Coach will
 * read, not a half-filled metric.
 *
 * Skeleton: mock content. Wiring this to read today's `log_entries` from the DB
 * (like Home's mission) is the next step.
 */
type Entry = {
  id: string;
  time: string;
  title: string;
  category: string;
  note?: boolean;
};

const MOCK: Entry[] = [
  { id: '1', time: '07:15', title: 'AM stack — 6 items', category: 'Supplements' },
  { id: '2', time: '07:40', title: '178.2 lb', category: 'Weight' },
  { id: '3', time: '08:05', title: 'Breakfast — Protein Forward', category: 'Nutrition' },
  {
    id: '4',
    time: '09:20',
    title: 'Felt unusually sharp after morning light — best focus this week.',
    category: 'Note',
    note: true,
  },
  { id: '5', time: '12:30', title: 'Lunch — Template B', category: 'Nutrition' },
];

export function RecentLogs({ entries = MOCK }: { entries?: Entry[] }) {
  return (
    <View>
      <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
        Logged today
      </Text>
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
                  <Ionicons name="reader-outline" size={11} color={palette.inkMuted} />
                ) : null}
                <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">
                  {entry.note ? 'Note · for Coach' : entry.category}
                </Text>
              </View>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
