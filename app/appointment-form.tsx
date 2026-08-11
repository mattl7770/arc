import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import {
  addAppointment,
  completeAppointment,
  deleteAppointment,
  getAppointment,
  listScreenings,
  setAppointmentStatus,
  updateAppointment,
} from '@/lib/db/repositories/screenings';
import { isValidDay } from '@/lib/screenings/format';
import type { AppointmentInput } from '@/lib/screenings/types';

/**
 * Add / edit one calendar appointment (pushed from /screenings). Date and time
 * are typed (YYYY-MM-DD + 24-hour HH:MM) — a native picker is a new native
 * dep, which waits for the batched rebuild. The pair is stored as one ISO-8601
 * UTC instant (appointments.scheduled_at), decomposed back to local wall-clock
 * on edit.
 *
 * Linking the appointment to a standing screening makes "Mark completed" stamp
 * that screening done and roll its cadence — attending the booked colonoscopy
 * IS completing the screening (completeAppointment, one transaction).
 *
 * Conformed Set treatment: every field is **recessed stock** (paper-dim on a
 * paper-deep edge, square); date and time are measured values and stay in mono;
 * the two explanatory lines are **margin annotations**.
 *
 * Accent budget: exactly one — Save, the single primary action here. "Mark
 * completed", "Cancel appointment" and "Delete" are neutral ink.
 */

const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Shared by every plain text field here: recessed stock, square, no radius. */
const FIELD =
  'mt-2 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';

export default function AppointmentFormScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editingId = typeof id === 'string' && id.length > 0 ? id : null;

  // Load once in the initializer (op-sqlite is synchronous) — the row can't
  // change underneath an open form in a single-user app.
  const [initial] = useState(() => (editingId ? getAppointment(getDb(), editingId) : undefined));
  const [screenings] = useState(() => listScreenings(getDb()));

  const [title, setTitle] = useState(initial?.title ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [date, setDate] = useState(() =>
    initial ? todayISODate(new Date(initial.scheduled_at)) : ''
  );
  const [time, setTime] = useState(() => (initial ? clockFromISO(initial.scheduled_at) : ''));
  const [screeningId, setScreeningId] = useState<string | null>(initial?.screening_id ?? null);
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const dateOk = isValidDay(date.trim());
  const timeOk = TIME_SHAPE.test(time.trim());
  const canSave = title.trim().length > 0 && dateOk && timeOk;

  const input = (): AppointmentInput => {
    const [y, m, d] = date.trim().split('-').map(Number);
    const [hh, mm] = time.trim().split(':').map(Number);
    return {
      title: title.trim(),
      provider: provider.trim() || null,
      // Local wall-clock -> UTC instant; JS applies that date's own offset.
      scheduledAt: new Date(y!, m! - 1, d!, hh!, mm!).toISOString(),
      location: location.trim() || null,
      screeningId,
      notes: notes.trim() || null,
    };
  };

  const save = () => {
    if (!canSave) return;
    try {
      if (editingId) updateAppointment(getDb(), editingId, input());
      else addAppointment(getDb(), input());
      router.back();
    } catch (error) {
      // A failed write must not crash the tap handler.
      console.warn('[screenings] appointment save failed', error);
    }
  };

  const linkedName = screenings.find((s) => s.id === screeningId)?.name ?? null;

  const markCompleted = () => {
    if (!editingId) return;
    try {
      completeAppointment(getDb(), editingId);
      router.back();
    } catch (error) {
      console.warn('[screenings] appointment complete failed', error);
    }
  };

  const confirmCancel = () => {
    if (!editingId) return;
    Alert.alert('Cancel this appointment?', 'It drops off the calendar.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel appointment',
        style: 'destructive',
        onPress: () => {
          try {
            setAppointmentStatus(getDb(), editingId, 'cancelled');
            router.back();
          } catch (error) {
            console.warn('[screenings] appointment cancel failed', error);
          }
        },
      },
    ]);
  };

  const confirmDelete = () => {
    if (!editingId) return;
    Alert.alert('Delete this appointment?', 'It is removed entirely.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          try {
            deleteAppointment(getDb(), editingId);
            router.back();
          } catch (error) {
            console.warn('[screenings] appointment delete failed', error);
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      {/* Own ScrollView (mirroring Screen's scroll variant) so the keyboard
          insets adjust — six system-keyboard inputs live here, and the save
          button must stay reachable while typing (same as workout-log). */}
      <ScrollView
        className="-mx-5 flex-1"
        contentContainerClassName="grow px-5 pb-10"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets>
        <View className="pt-2">
          <StackHeader title={editingId ? 'Edit Appointment' : 'Add Appointment'} />
        </View>

        {/* Title */}
        <View className="mt-3">
          <SectionLabel label="Appointment" />
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Dermatology skin check"
            placeholderTextColor={palette.inkMuted}
            className={FIELD}
            accessibilityLabel="Appointment title"
          />
        </View>

        {/* When — both halves are measured values, so both are mono. */}
        <View className="mt-8">
          <SectionLabel label="When" />
          <View className="mt-2 flex-row gap-2">
            <TextInput
              value={date}
              onChangeText={setDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={palette.inkMuted}
              keyboardType="numbers-and-punctuation"
              className="min-h-[44px] flex-1 border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[15px] text-ink"
              accessibilityLabel="Appointment date"
            />
            <TextInput
              value={time}
              onChangeText={setTime}
              placeholder="HH:MM"
              placeholderTextColor={palette.inkMuted}
              keyboardType="numbers-and-punctuation"
              className="min-h-[44px] w-24 border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[15px] text-ink"
              accessibilityLabel="Appointment time, 24-hour"
            />
          </View>
          <Text className="mt-1.5 font-serif text-[11px] text-ink-muted">
            Local time, 24-hour clock
          </Text>
        </View>

        {/* Provider / location */}
        <View className="mt-8">
          <SectionLabel label="Provider (optional)" />
          <TextInput
            value={provider}
            onChangeText={setProvider}
            placeholder="e.g. Dr. Osei"
            placeholderTextColor={palette.inkMuted}
            className={FIELD}
            accessibilityLabel="Provider"
          />
          <TextInput
            value={location}
            onChangeText={setLocation}
            placeholder="Location"
            placeholderTextColor={palette.inkMuted}
            className={FIELD}
            accessibilityLabel="Location"
          />
        </View>

        {/* Link to a standing screening */}
        {screenings.length > 0 ? (
          <View className="mt-8">
            <SectionLabel label="For screening (optional)" />
            <View className="mt-2 flex-row flex-wrap gap-2">
              {screenings.map((s) => {
                const on = screeningId === s.id;
                return (
                  <Pressable
                    key={s.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => setScreeningId((cur) => (cur === s.id ? null : s.id))}
                    className={`min-h-[44px] justify-center rounded-btn border px-3 py-2 active:bg-paper-dim ${
                      on ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'
                    }`}>
                    <Text
                      className={`font-label text-[13px] ${
                        on ? 'font-semibold text-ink' : 'text-ink-secondary'
                      }`}>
                      {s.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View className="mt-2">
              <Block device="margin">
                <Text className="font-serif text-[11px] leading-4 text-ink-muted">
                  Completing a linked appointment marks the screening done.
                </Text>
              </Block>
            </View>
          </View>
        ) : null}

        {/* Notes */}
        <View className="mt-8">
          <SectionLabel label="Notes (optional)" />
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Prep instructions, referral number, questions…"
            placeholderTextColor={palette.inkMuted}
            multiline
            className="mt-2 max-h-28 min-h-[64px] border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] leading-5 text-ink"
            accessibilityLabel="Notes"
          />
        </View>

        {/* The one accent on this screen. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editingId ? 'Save appointment' : 'Add appointment'}
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={save}
          className={`mt-8 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn py-3.5 ${
            canSave ? 'bg-pine active:opacity-70' : 'border border-hairline bg-paper-dim'
          }`}>
          <Ionicons
            name="calendar-outline"
            size={18}
            color={canSave ? palette.pineOn : palette.inkMuted}
          />
          <Text
            className={`font-label text-[15px] font-semibold ${
              canSave ? 'text-pine-on' : 'text-ink-muted'
            }`}>
            {editingId ? 'Save appointment' : 'Add appointment'}
          </Text>
        </Pressable>

        {editingId ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mark completed"
              onPress={markCompleted}
              className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
              <Ionicons name="checkmark" size={16} color={palette.inkSecondary} />
              <Text className="font-label text-[14px] font-medium text-ink-secondary">
                {linkedName ? `Mark completed · stamps ${linkedName} done` : 'Mark completed'}
              </Text>
            </Pressable>

            <View className="mt-4 flex-row justify-center gap-8">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel appointment"
                onPress={confirmCancel}
                className="min-h-[44px] justify-center active:opacity-60">
                <Text className="font-label text-[13px] text-ink-muted">Cancel appointment</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete appointment"
                onPress={confirmDelete}
                className="min-h-[44px] justify-center active:opacity-60">
                <Text className="font-label text-[13px] text-ink-muted">Delete</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
