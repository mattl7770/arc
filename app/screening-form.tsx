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
import { todayISODate } from '@/lib/db/date';
import {
  addScreening,
  deleteScreening,
  getScreening,
  markScreeningDone,
  resolveNextDue,
  updateScreening,
} from '@/lib/db/repositories/screenings';
import {
  CATEGORY_LABELS,
  dayTextLong,
  isValidDay,
  SCREENING_CATEGORIES,
} from '@/lib/screenings/format';
import type { ScreeningCategory, ScreeningInput } from '@/lib/screenings/types';

/**
 * Add / edit one standing screening (pushed from /screenings). Cadence is
 * whole months (quick chips for the common intervals, a mono field for the
 * rest); dates are typed YYYY-MM-DD — a native date picker is a new native
 * dep, which waits for the batched rebuild (docs/project-status.md caveats).
 *
 * The "next due" field is an explicit override (a doctor's told-you date).
 * Left blank, the repository derives it from last done + cadence — the
 * preview line shows exactly what will be stored. On edit, a stored next_due
 * that merely equals the derivation is shown as the preview, not the override,
 * so later edits keep re-deriving.
 *
 * Conformed Set treatment: every field is **recessed stock** (paper-dim on a
 * paper-deep edge, square), and the two explanatory lines are **margin
 * annotations**. Dates and cadences are measured values, so they are mono
 * everywhere they appear.
 *
 * Accent budget: exactly one — Save, the single primary action on the screen.
 * "Mark done today" and "Delete" are neutral ink.
 */

const INTERVAL_CHIPS: { label: string; months: number }[] = [
  { label: '6 mo', months: 6 },
  { label: '1 yr', months: 12 },
  { label: '2 yr', months: 24 },
  { label: '5 yr', months: 60 },
  { label: '10 yr', months: 120 },
];

/** Shared by every plain text field here: recessed stock, square, no radius. */
const FIELD =
  'mt-2 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';

export default function ScreeningFormScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editingId = typeof id === 'string' && id.length > 0 ? id : null;

  // Load once in the initializer (op-sqlite is synchronous) — the row can't
  // change underneath an open form in a single-user app.
  const [initial] = useState(() => (editingId ? getScreening(getDb(), editingId) : undefined));

  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState<ScreeningCategory>(initial?.category ?? 'exam');
  const [intervalText, setIntervalText] = useState(
    initial?.interval_months != null ? String(initial.interval_months) : ''
  );
  const [lastCompleted, setLastCompleted] = useState(initial?.last_completed ?? '');
  // Only surface the stored next_due as an override when it differs from what
  // the cadence would derive — otherwise leave it deriving.
  const [nextDueOverride, setNextDueOverride] = useState(() => {
    if (!initial?.next_due) return '';
    const derived = resolveNextDue({
      name: initial.name,
      category: initial.category,
      intervalMonths: initial.interval_months,
      lastCompleted: initial.last_completed,
    });
    return initial.next_due === derived ? '' : initial.next_due;
  });
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const intervalMonths = intervalText.trim() === '' ? null : Number(intervalText.trim());
  const intervalOk =
    intervalMonths === null || (Number.isInteger(intervalMonths) && intervalMonths > 0);
  const lastOk = lastCompleted.trim() === '' || isValidDay(lastCompleted.trim());
  const overrideOk = nextDueOverride.trim() === '' || isValidDay(nextDueOverride.trim());
  // Mirrors the DB's cross-column CHECK: a next-due at or before the last
  // completion is always a typo — grey the Save instead of failing at insert.
  const orderOk =
    !lastOk ||
    !overrideOk ||
    lastCompleted.trim() === '' ||
    nextDueOverride.trim() === '' ||
    lastCompleted.trim() <= nextDueOverride.trim();
  const canSave = name.trim().length > 0 && intervalOk && lastOk && overrideOk && orderOk;

  const input = (): ScreeningInput => ({
    name: name.trim(),
    category,
    intervalMonths: intervalOk ? intervalMonths : null,
    lastCompleted: lastOk && lastCompleted.trim() !== '' ? lastCompleted.trim() : null,
    nextDue: overrideOk && nextDueOverride.trim() !== '' ? nextDueOverride.trim() : null,
    notes: notes.trim() || null,
  });

  const storedNextDue = canSave ? resolveNextDue(input()) : null;

  const save = () => {
    if (!canSave) return;
    try {
      if (editingId) updateScreening(getDb(), editingId, input());
      else addScreening(getDb(), input());
      router.back();
    } catch (error) {
      // A failed write must not crash the tap handler.
      console.warn('[screenings] save failed', error);
    }
  };

  const markDone = () => {
    if (!editingId) return;
    try {
      markScreeningDone(getDb(), editingId);
      router.back();
    } catch (error) {
      console.warn('[screenings] mark done failed', error);
    }
  };

  const confirmDelete = () => {
    if (!editingId) return;
    Alert.alert('Delete this screening?', 'Its linked appointments are kept.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          try {
            deleteScreening(getDb(), editingId);
            router.back();
          } catch (error) {
            console.warn('[screenings] delete failed', error);
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      {/* Own ScrollView (mirroring Screen's scroll variant) so the keyboard
          insets adjust — five system-keyboard inputs live here, and the save
          button must stay reachable while typing (same as workout-log). */}
      <ScrollView
        className="-mx-5 flex-1"
        contentContainerClassName="grow px-5 pb-10"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets>
        <View className="pt-2">
          <StackHeader title={editingId ? 'Edit Screening' : 'Add Screening'} />
        </View>

        {/* Name */}
        <View className="mt-3">
          <SectionLabel label="Screening" />
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Colonoscopy"
            placeholderTextColor={palette.inkMuted}
            className={FIELD}
            accessibilityLabel="Screening name"
          />
        </View>

        {/* Category */}
        <View className="mt-8">
          <SectionLabel label="Category" />
          <View className="mt-2 flex-row flex-wrap gap-2">
            {SCREENING_CATEGORIES.map((c) => {
              const on = category === c;
              return (
                <Pressable
                  key={c}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => setCategory(c)}
                  className={`min-h-[44px] justify-center rounded-btn border px-3 py-2 active:bg-paper-dim ${
                    on ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'
                  }`}>
                  <Text
                    className={`font-label text-[13px] ${
                      on ? 'font-semibold text-ink' : 'text-ink-secondary'
                    }`}>
                    {CATEGORY_LABELS[c]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Cadence */}
        <View className="mt-8">
          <SectionLabel label="Cadence (optional)" />
          <View className="mt-2 flex-row flex-wrap items-center gap-2">
            {INTERVAL_CHIPS.map((chip) => {
              const on = intervalMonths === chip.months;
              return (
                <Pressable
                  key={chip.months}
                  accessibilityRole="button"
                  accessibilityLabel={`Every ${chip.label}`}
                  accessibilityState={{ selected: on }}
                  onPress={() =>
                    setIntervalText((cur) =>
                      cur === String(chip.months) ? '' : String(chip.months)
                    )
                  }
                  className={`min-h-[44px] justify-center rounded-btn border px-3 py-2 active:bg-paper-dim ${
                    on ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'
                  }`}>
                  {/* A cadence is a measured value — mono. */}
                  <Text
                    className={`font-mono text-[13px] ${on ? 'text-ink' : 'text-ink-secondary'}`}>
                    {chip.label}
                  </Text>
                </Pressable>
              );
            })}
            <TextInput
              value={intervalText}
              onChangeText={setIntervalText}
              placeholder="months"
              placeholderTextColor={palette.inkMuted}
              keyboardType="number-pad"
              className="min-h-[44px] w-24 border border-paper-deep bg-paper-dim px-3.5 py-2.5 font-mono text-[13px] text-ink"
              accessibilityLabel="Cadence in months"
            />
          </View>
          <Text className="mt-1.5 font-serif text-[11px] text-ink-muted">
            Whole months between rounds · leave empty for a one-off
          </Text>
        </View>

        {/* Last done */}
        <View className="mt-8">
          <SectionLabel label="Last done (optional)" />
          <View className="mt-2 flex-row items-center gap-2">
            <TextInput
              value={lastCompleted}
              onChangeText={setLastCompleted}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={palette.inkMuted}
              keyboardType="numbers-and-punctuation"
              className="min-h-[44px] flex-1 border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[15px] text-ink"
              accessibilityLabel="Last done date"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Set last done to today"
              onPress={() => setLastCompleted(todayISODate())}
              className="min-h-[44px] justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
              <Text className="font-label text-[13px] font-medium text-ink-secondary">Today</Text>
            </Pressable>
          </View>
        </View>

        {/* Next due override */}
        <View className="mt-8">
          <SectionLabel label="Next due (optional)" />
          <TextInput
            value={nextDueOverride}
            onChangeText={setNextDueOverride}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={palette.inkMuted}
            keyboardType="numbers-and-punctuation"
            className="mt-2 border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[15px] text-ink"
            accessibilityLabel="Next due date override"
          />
          <View className="mt-2">
            <Block device="margin">
              <Text className="font-serif text-[11px] leading-4 text-ink-muted">
                {storedNextDue
                  ? `Will be stored as due ${dayTextLong(storedNextDue)}`
                  : 'Leave empty to derive from last done + cadence'}
              </Text>
            </Block>
          </View>
        </View>

        {/* Notes */}
        <View className="mt-8">
          <SectionLabel label="Notes (optional)" />
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Prep, provider preferences, what to ask…"
            placeholderTextColor={palette.inkMuted}
            multiline
            className="mt-2 max-h-28 min-h-[64px] border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] leading-5 text-ink"
            accessibilityLabel="Notes"
          />
        </View>

        {/* The one accent on this screen. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editingId ? 'Save screening' : 'Add screening'}
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
            {editingId ? 'Save screening' : 'Add screening'}
          </Text>
        </Pressable>

        {editingId ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mark done today"
              onPress={markDone}
              className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
              <Ionicons name="checkmark" size={16} color={palette.inkSecondary} />
              <Text className="font-label text-[14px] font-medium text-ink-secondary">
                Mark done today · rolls the next due date
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete screening"
              onPress={confirmDelete}
              className="mt-4 min-h-[44px] items-center justify-center active:opacity-60">
              <Text className="font-label text-[13px] text-ink-muted">Delete screening</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
