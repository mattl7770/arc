import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { CommandField } from '@/components/log/command-field';
import { QuickAddGrid } from '@/components/log/quick-add-grid';
import { RecentLogs } from '@/components/log/recent-logs';
import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { palette } from '@/constants/theme';
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
 *
 * Conformed Set treatment (00-design-spec.md §1) — one device per block, and
 * three of them on this sheet: the command field is a **recessed well** (it is
 * an input), the quick-adds are a **ruled grid** (equal peers, rules between
 * cells only), and "Logged today" is a **ruled plate** (a record is a table).
 * The symptom row is its own small plate. The screen's single accent is the
 * command field's send/mic action — the tiles are deliberately neutral, because
 * none of them is "the one next action".
 */

/**
 * The folio line's date, formatted by hand.
 *
 * `toLocaleDateString(undefined, {...})` used to build this. Hermes ships
 * without Intl, so on device the options object is silently ignored and the
 * string comes back in a different shape than the web preview shows. Same
 * hand-rolled approach as src/components/home/date-eyebrow.tsx.
 */
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function formatToday(now: Date): string {
  const weekday = WEEKDAYS[now.getDay()] ?? '';
  const month = MONTHS[now.getMonth()] ?? '';
  return `${weekday} ${now.getDate()} ${month}`;
}

export default function LogScreen() {
  const today = formatToday(new Date());
  const { entries, reload } = useLogFeed();
  const router = useRouter();

  return (
    <Screen scroll>
      <View className="pt-2">
        {/* The date is spoken, not measured — the label voice, not mono. */}
        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
          {today}
        </Text>
        <Text className="mt-1 font-serif text-[26px] font-semibold text-ink">Log</Text>
      </View>

      <View className="mt-5">
        <CommandField onLogged={reload} />
      </View>

      <View className="mt-6">
        <QuickAddGrid />
      </View>

      {/* Symptom capture — a distinct "something's off" entry, kept separate from
          the routine quick-adds. A record you can open: the plate device. It
          carries no accent; the command field owns this screen's one pine. */}
      <View className="mt-5">
        <Block device="plate">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log a symptom"
            onPress={() => router.push('/symptom')}
            className="min-h-[44px] flex-row items-center gap-3 active:opacity-60">
            <Ionicons name="pulse-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="font-label text-[13px] font-semibold text-ink">Log a symptom</Text>
              <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-muted">
                Headache, pain, GI, energy — with severity
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
          </Pressable>
        </Block>
      </View>

      <View className="mt-6">
        <RecentLogs entries={entries} />
      </View>
    </Screen>
  );
}
