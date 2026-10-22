import { Switch, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import type { CalendarAccess } from '@/lib/calendar/calendar';

/**
 * The Calendar switch in Settings › Coach (2026-10-21, docs/decisions.md
 * "Calendar context to the model") — presentational: the screen owns the
 * state, the permission request and the write.
 *
 * OFF until he turns it on. Turning it on is what asks iOS for calendar access;
 * a refusal leaves it off and says why, and access revoked later in iOS
 * Settings leaves his choice standing but says the Coach sees nothing. Every
 * calendar on the phone is read — no per-calendar picker in v1, and the margin
 * note says so.
 *
 * A ruled plate like the Web search switch above it: a setting, a record. Zero
 * accent, as everywhere in Settings.
 */
export function CalendarSetting({
  on,
  access,
  onChange,
}: {
  on: boolean;
  /** Null until the first check answers. */
  access: CalendarAccess | null;
  onChange: (on: boolean) => void;
}) {
  const note = calendarAccessNote(on, access);
  return (
    <View>
      <Block device="plate">
        <View className="min-h-[44px] flex-row items-center gap-3 py-3">
          <View className="flex-1">
            <Text className="font-serif text-[15px] text-ink">Calendar</Text>
            <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
              The next 7 days, so the Coach can plan around them · read-only
            </Text>
          </View>
          <Switch
            accessibilityLabel="Calendar"
            value={on}
            disabled={access === 'unavailable'}
            onValueChange={onChange}
            trackColor={{ true: palette.ink, false: palette.hairlineStrong }}
            ios_backgroundColor={palette.hairlineStrong}
          />
        </View>
        {note ? (
          <Text className="pb-3 font-serif text-[12px] leading-4 text-ink-secondary">{note}</Text>
        ) : null}
      </Block>
      <View className="mt-4">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            Every calendar on this phone. Each event&rsquo;s title, times, place and calendar name
            go to Anthropic inside the Coach&rsquo;s own call; never its notes, attendees or links.
            ARC never writes to your calendar and stores none of it.
          </Text>
        </Block>
      </View>
    </View>
  );
}

/** The one sentence under the switch when access is not what the switch implies. */
export function calendarAccessNote(on: boolean, access: CalendarAccess | null): string | null {
  switch (access) {
    case 'unavailable':
      return 'This build of ARC can’t read calendars yet. It comes with the next app build.';
    case 'denied':
      return on
        ? 'Calendar access is off for ARC in iOS Settings, so the Coach sees no events. Allow Full Access under ARC › Calendars there.'
        : 'iOS has calendar access off for ARC. Allow Full Access in iOS Settings under ARC › Calendars, then turn this on.';
    case 'undetermined':
      return on
        ? 'iOS hasn’t been asked on this phone yet, so the Coach sees no events. Turn this off and on to allow it.'
        : null;
    default:
      return null;
  }
}
