import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  lastShortcutsLink,
  latestScreenTime,
  type ScreenTimeEntry,
  type ShortcutsLink,
} from '@/lib/db/repositories/screen-time';
import {
  filedDayWords,
  formatHm,
  LINK_MAX_DAYS_BACK,
  SCREEN_TIME_LINK_FORMAT,
  SCREEN_TIME_MAX_MINUTES,
} from '@/lib/screen-time/entry';

/**
 * Settings › Screen time — where the number comes from, and the Shortcut setup.
 *
 * The owner looks for a data source in Settings, so the setup note lives here
 * as well as in docs/screen-time.md (the two say the same thing; the doc
 * carries the reasons). There is nothing to switch on: typing works on the Log
 * tab with no setup, and the link works whenever a Shortcut opens it. What
 * this screen adds is the one thing only it can say — **what is on record,
 * and whether a Shortcut has ever sent a number**, which is how he finds out
 * that an automation he set up last week has been running.
 *
 * The Shortcut section is marked **only if the check returns a total**. As of
 * 2026-09-25 nobody has seen what iOS 26's "Get App & Website Data" returns;
 * if it gives names but no total, the steps do not apply and typing is the
 * route. The screen says that rather than promising an automation that may
 * not be possible.
 *
 * Conformed Set: the record is a plate (a record is a table); the typing note
 * is prose, so a margin annotation; the steps are a ruled plate, one row per
 * action, with the step number and the URL in mono (it is a literal to be
 * copied, not speech). Zero accent, as everywhere in Settings.
 */

type OnRecord = { latest: ScreenTimeEntry | null; lastLinked: ShortcutsLink | null };

/**
 * "Has a Shortcut ever sent a number" is read from the Shortcuts cursor, not
 * from the rows: the morning after a nightly automation, a typed correction
 * replaces the Shortcut's row, and a screen reading rows would then say no
 * Shortcut had ever sent one — the wrong answer to the one question this
 * screen exists to answer.
 */
function read(): OnRecord {
  const db = getDb();
  const today = todayISODate();
  return {
    latest: latestScreenTime(db, today),
    lastLinked: lastShortcutsLink(db),
  };
}

/** The automation, one action per row. Order is the Shortcut's order. */
const STEPS: string[] = [
  'Shortcuts › Automation › New: Time of Day, 23:55, Daily, Run Immediately.',
  'Add Screen Time › Get App & Website Data. If it asks for a day or a range, choose today.',
  'Take the day’s total from its result. If it is not in minutes, add Calculate to convert it. Then add Round Number, so it is whole.',
  'Add Format Date: Current Date, Custom format yyyy-MM-dd.',
  'Add URL and type the link below, with the rounded number in place of N and the formatted date in place of YYYY-MM-DD.',
  'Add Open URLs.',
];

export default function SettingsScreenTimeScreen() {
  const [record, setRecord] = useState(read);
  useFocusEffect(useCallback(() => setRecord(read()), []));
  const today = todayISODate();

  const latestLine = record.latest
    ? `${formatHm(record.latest.minutes)} for ${filedDayWords(record.latest.date, today)}, ${
        record.latest.via === 'shortcuts' ? 'from Shortcuts' : 'typed'
      }`
    : 'Nothing logged yet';
  const linkedLine = record.lastLinked
    ? `Last sent ${formatHm(record.lastLinked.minutes)} for ${filedDayWords(record.lastLinked.date, today)}`
    : 'No Shortcut has sent a number yet';

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Screen time" parent="Settings" />
      </View>

      {/* What is on record — the reading that says whether any of this works. */}
      <View className="mt-6">
        <SectionLabel label="On record" />
        <View className="mt-3">
          <Block device="plate">
            <View className="min-h-[44px] justify-center py-2">
              <Text className="font-serif text-[15px] text-ink">Latest day</Text>
              <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">{latestLine}</Text>
            </View>
            <Divider />
            <View className="min-h-[44px] justify-center py-2">
              <Text className="font-serif text-[15px] text-ink">Shortcuts</Text>
              <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">{linkedLine}</Text>
            </View>
          </Block>
        </View>
      </View>

      {/* Typing — the route that needs no setup. */}
      <View className="mt-8">
        <SectionLabel label="Type it" />
        <View className="mt-3">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink">
              On the Log tab, type <Text className="font-mono text-[12px]">screen 3h20</Text> or{' '}
              <Text className="font-mono text-[12px]">st 200</Text>, or tap Screen time under Quick
              add. Before noon the number is filed to yesterday, from noon to today; add{' '}
              <Text className="font-mono text-[12px]">today</Text> or{' '}
              <Text className="font-mono text-[12px]">yesterday</Text> to choose. One number per
              day: a second one replaces the first, and the Log tab offers an Undo.
            </Text>
          </Block>
        </View>
      </View>

      {/* The Shortcut — conditional on a check nobody has run yet. */}
      <View className="mt-8">
        <SectionLabel label="From a Shortcut" note="only if the check returns a total" />
        <View className="mt-3">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink">
              First, the check: in Shortcuts, make a shortcut with one action, Screen Time › Get App
              & Website Data, and run it. If the result includes a day’s total, the steps below
              apply. If it lists only apps or names, keep typing the number.
            </Text>
          </Block>
        </View>
        <View className="mt-4">
          <Block device="plate">
            {STEPS.map((step, index) => (
              <View key={step}>
                <Divider first={index === 0} />
                <View className="min-h-[44px] flex-row items-start gap-3 py-2.5">
                  <Text className="w-4 font-mono text-[12px] text-ink-muted">{index + 1}</Text>
                  <Text className="flex-1 font-serif text-[14px] leading-5 text-ink">{step}</Text>
                </View>
              </View>
            ))}
            <Divider />
            <View className="py-2.5">
              <Text selectable className="font-mono text-[12px] leading-5 text-ink">
                {SCREEN_TIME_LINK_FORMAT}
              </Text>
            </View>
          </Block>
        </View>
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              For today or yesterday, ARC saves the number without asking and marks it as from
              Shortcuts. The Undo is on the screen the link opens, and once on the Log tab the next
              time you open it. For an older day, or a day that holds a number you typed, it asks
              first. It refuses anything but whole minutes from 1 to {SCREEN_TIME_MAX_MINUTES} and a
              real date no later than today and no more than {LINK_MAX_DAYS_BACK} days back, and
              says why on the screen the link opens. Not yet tried on the phone: whether iOS opens
              ARC from an automation while the phone is locked.
            </Text>
          </Block>
        </View>
      </View>
    </Screen>
  );
}
