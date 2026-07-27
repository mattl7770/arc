import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useScreenings } from '@/hooks/use-screenings';
import {
  apptDateText,
  apptTimeText,
  cadenceLabel,
  CATEGORY_LABELS,
  dueDateText,
  dueLabel,
} from '@/lib/screenings/format';
import type { ScreeningRow, UpcomingAppointment } from '@/lib/screenings/types';

/**
 * Screenings — the preventive ledger, pushed from the Data tab
 * (docs/information-architecture.md: browsable in Data; Home later surfaces
 * what's *due* from the same dueScreenings seam).
 *
 * Top to bottom: screenings grouped by due status (overdue first — the point
 * of the ledger), the one pine action (Add screening), then the calendar of
 * upcoming appointments with a ghost add. Rows push their edit form.
 *
 * Colour note, flagged for owner review: an OVERDUE row's due text uses
 * signal-caution — a missed screening is a genuine health-urgency state, not
 * UI chrome (the design brief sanctions this narrowly). Everything else on the
 * screen is neutral; the only pine is the Add button.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

type GroupKey = 'overdue' | 'dueSoon' | 'scheduled' | 'untracked';

const GROUP_LABELS: Record<GroupKey, string> = {
  overdue: 'Overdue',
  dueSoon: 'Due soon',
  scheduled: 'Scheduled',
  untracked: 'Not scheduled',
};

const GROUP_ORDER: GroupKey[] = ['overdue', 'dueSoon', 'scheduled', 'untracked'];

function ScreeningRowView({
  screening,
  group,
  today,
  first,
  onPress,
}: {
  screening: ScreeningRow;
  group: GroupKey;
  today: string;
  first: boolean;
  onPress: () => void;
}) {
  const sub = `${CATEGORY_LABELS[screening.category]} · ${cadenceLabel(screening.interval_months)}`;

  let value: string | null = null;
  let qualifier: string | null = null;
  if (screening.next_due != null) {
    if (group === 'scheduled') {
      value = dueDateText(screening.next_due, today);
    } else {
      value = dueLabel(screening.next_due, today);
      qualifier = dueDateText(screening.next_due, today);
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${screening.name}. ${sub}. ${value ?? 'No date'}. Edit.`}
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
        first ? '' : 'border-t border-hairline-soft'
      }`}>
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{screening.name}</Text>
        <Text className="mt-0.5 text-[11px] text-ink-muted">{sub}</Text>
      </View>
      {value != null ? (
        <View className="items-end">
          {/* Signal colour marks a biological/health state only — see header note. */}
          <Text
            className={`font-mono text-[13px] ${
              group === 'overdue' ? 'text-signal-caution' : 'text-ink'
            }`}>
            {value}
          </Text>
          {qualifier ? (
            <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{qualifier}</Text>
          ) : null}
        </View>
      ) : (
        <Text className="text-[12px] text-ink-muted">No date</Text>
      )}
      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
    </Pressable>
  );
}

function AppointmentRowView({
  appt,
  today,
  first,
  onPress,
}: {
  appt: UpcomingAppointment;
  today: string;
  first: boolean;
  onPress: () => void;
}) {
  const sub = [
    appt.provider,
    appt.location,
    appt.screening_name ? `for ${appt.screening_name}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${appt.title}. ${apptDateText(appt.scheduled_at, today)}, ${apptTimeText(
        appt.scheduled_at
      )}. Edit.`}
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
        first ? '' : 'border-t border-hairline-soft'
      }`}>
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{appt.title}</Text>
        {sub ? (
          <Text className="mt-0.5 text-[11px] text-ink-muted" numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <View className="items-end">
        <Text className="font-mono text-[13px] text-ink">
          {apptDateText(appt.scheduled_at, today)}
        </Text>
        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
          {apptTimeText(appt.scheduled_at)}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
    </Pressable>
  );
}

export default function ScreeningsScreen() {
  const router = useRouter();
  const { today, groups, emptyLedger, appointments, pastAppointments } = useScreenings();

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Screenings" />
      </View>

      {/* a. The ledger — screenings grouped by due status, overdue first. */}
      {emptyLedger ? (
        <View className="mt-4 rounded-card border border-hairline bg-porcelain p-4">
          <Text className="font-serif text-[17px] font-semibold text-ink">
            The preventive ledger
          </Text>
          <Text className="mt-1 text-[12.5px] leading-5 text-ink-secondary">
            The exams that guard the long game — colonoscopy, skin checks, imaging, dental, vision —
            each with its cadence, so nothing quietly slips a year.
          </Text>
        </View>
      ) : (
        GROUP_ORDER.map((key) => {
          const items = groups[key];
          if (items.length === 0) return null;
          return (
            <View key={key} className="mt-6">
              <SectionLabel>{GROUP_LABELS[key]}</SectionLabel>
              <View className="mt-3 rounded-card border border-hairline bg-porcelain">
                {items.map((s, index) => (
                  <ScreeningRowView
                    key={s.id}
                    screening={s}
                    group={key}
                    today={today}
                    first={index === 0}
                    onPress={() =>
                      router.push({ pathname: '/screening-form', params: { id: s.id } })
                    }
                  />
                ))}
              </View>
            </View>
          );
        })
      )}

      {/* b. THE ONE PINE — add a screening. Nothing else on this screen is pine. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add screening"
        onPress={() => router.push('/screening-form')}
        className="mt-5 flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5 active:opacity-70">
        <Ionicons name="add" size={18} color={palette.pineOn} />
        <Text className="text-[15px] font-semibold text-pine-on">Add screening</Text>
      </Pressable>

      {/* c. Awaiting outcome — bookings whose day passed while still
          'scheduled'. Kept visible so they can be closed (mark completed /
          cancel) — completing a linked one stamps its screening done as of
          the visit. Hidden entirely when there's nothing to resolve. */}
      {pastAppointments.length > 0 ? (
        <View className="mt-8">
          <SectionLabel>Awaiting outcome</SectionLabel>
          <View className="mt-3 rounded-card border border-hairline bg-porcelain">
            {pastAppointments.map((a, index) => (
              <AppointmentRowView
                key={a.id}
                appt={a}
                today={today}
                first={index === 0}
                onPress={() => router.push({ pathname: '/appointment-form', params: { id: a.id } })}
              />
            ))}
          </View>
        </View>
      ) : null}

      {/* d. Calendar — upcoming booked appointments, soonest first. */}
      <View className="mt-8">
        <SectionLabel>Calendar</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
          {appointments.length === 0 ? (
            <View className="px-4 py-3">
              <Text className="text-[12px] text-ink-muted">Nothing booked</Text>
            </View>
          ) : (
            appointments.map((a, index) => (
              <AppointmentRowView
                key={a.id}
                appt={a}
                today={today}
                first={index === 0}
                onPress={() => router.push({ pathname: '/appointment-form', params: { id: a.id } })}
              />
            ))
          )}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add appointment"
          onPress={() => router.push('/appointment-form')}
          className="mt-3 flex-row items-center justify-center gap-2 rounded-btn border border-hairline-strong py-3 active:bg-paper-deep">
          <Ionicons name="add" size={16} color={palette.inkSecondary} />
          <Text className="text-[14px] font-medium text-ink-secondary">Add appointment</Text>
        </Pressable>
      </View>
    </Screen>
  );
}
