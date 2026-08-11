import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { RoutinePicker } from '@/components/exercise/routine-picker';
import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  activateProgram,
  createProgram,
  deactivateProgram,
  deleteProgram,
  updateProgram,
} from '@/lib/db/repositories/programs';
import { localWeekRange } from '@/lib/db/repositories/exercise';
import type { ProgramDetail, ProgramInput, Weekday, WeekKind } from '@/lib/exercise/types';
import { useProgram } from '@/hooks/use-training';

/**
 * Program builder — a multi-week mesocycle over routines, pushed from the
 * Exercise hub. Set a length, assign a routine to each weekday (the repeating
 * split), and mark deload/test weeks; then Start it to schedule it on the
 * calendar. Mirrors the routine/protocol editors' discipline (in-flight guard,
 * deep-link id coercion, atomic save).
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Weekly split   plate   a schedule is a record — seven ruled lines
 *   Save problems  margin  the "why Save is off" annotation
 *
 * The week-kind row stays a strip of tappable chips: it is a control, not a
 * record, so it takes no device. Name/notes/length are recessed stock drawn
 * inline — an input is not a content block.
 *
 * **Accent budget: one.** Save. Start/Stop is a secondary outlined action and
 * Delete is a quiet text button, because neither should outshine the thing the
 * screen is actually for.
 */

const DOWS: { dow: Weekday; label: string }[] = [
  { dow: 1, label: 'Monday' },
  { dow: 2, label: 'Tuesday' },
  { dow: 3, label: 'Wednesday' },
  { dow: 4, label: 'Thursday' },
  { dow: 5, label: 'Friday' },
  { dow: 6, label: 'Saturday' },
  { dow: 7, label: 'Sunday' },
];

const WEEK_KIND_LABEL: Record<WeekKind, string> = {
  accumulation: '',
  deload: 'deload',
  test: 'test',
};
/** Tap cycles a week through the three kinds. */
const NEXT_KIND: Record<WeekKind, WeekKind> = {
  accumulation: 'deload',
  deload: 'test',
  test: 'accumulation',
};

type DayMap = Partial<Record<Weekday, { routineId: string; routineName: string }>>;

function initialDays(detail: ProgramDetail | null): DayMap {
  const map: DayMap = {};
  if (detail)
    for (const d of detail.days)
      map[d.dow] = { routineId: d.routineId, routineName: d.routineName };
  return map;
}
function initialKinds(detail: ProgramDetail | null): WeekKind[] {
  if (detail) return [...detail.weekKinds];
  return Array.from({ length: 4 }, () => 'accumulation');
}

export default function ProgramEditScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  return <ProgramEditor key={id ?? 'new'} id={id} />;
}

function ProgramEditor({ id }: { id: string | undefined }) {
  const router = useRouter();
  const detail = useProgram(id);
  const editing = id != null;

  const [name, setName] = useState(detail?.name ?? '');
  const [notes, setNotes] = useState(detail?.notes ?? '');
  const [weeksText, setWeeksText] = useState(String(detail?.weeks ?? 4));
  const [days, setDays] = useState<DayMap>(() => initialDays(detail));
  const [weekKinds, setWeekKinds] = useState<WeekKind[]>(() => initialKinds(detail));
  const [pickerDow, setPickerDow] = useState<Weekday | null>(null);
  const inFlight = useRef(false);

  const isActive = detail?.activeStart != null;
  const weeks = Math.min(52, Math.max(1, Number(weeksText) || 1));
  const weeksValid = /^\d+$/.test(weeksText.trim()) && weeks >= 1 && weeks <= 52;
  const trainingDays = DOWS.filter((d) => days[d.dow]).length;
  const canSave = name.trim() !== '' && weeksValid && trainingDays > 0;

  // Keep weekKinds length in lockstep with the week count (pad / truncate).
  const kindsFor = (n: number): WeekKind[] =>
    Array.from({ length: n }, (_, i) => weekKinds[i] ?? 'accumulation');

  const setDay = (dow: Weekday, routine: { id: string; name: string } | null) => {
    setDays((prev) => {
      const next = { ...prev };
      if (routine) next[dow] = { routineId: routine.id, routineName: routine.name };
      else delete next[dow];
      return next;
    });
  };

  const cycleWeek = (index: number) => {
    setWeekKinds((prev) => {
      const next = kindsFor(weeks);
      next[index] = NEXT_KIND[next[index] ?? 'accumulation'];
      return next;
    });
  };

  const buildInput = (): ProgramInput => ({
    name: name.trim(),
    notes: notes.trim() || null,
    weeks,
    days: DOWS.filter((d) => days[d.dow]).map((d) => ({
      dow: d.dow,
      routineId: days[d.dow]!.routineId,
    })),
    weekKinds: kindsFor(weeks),
  });

  const save = () => {
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    try {
      const db = getDb();
      if (detail) updateProgram(db, detail.id, buildInput());
      else createProgram(db, buildInput());
      router.back();
    } catch (error) {
      inFlight.current = false;
      console.warn('[programs] save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Please try again.');
    }
  };

  const toggleActive = () => {
    if (!detail || inFlight.current) return;
    inFlight.current = true;
    try {
      const db = getDb();
      if (isActive) deactivateProgram(db, detail.id);
      // Start on the Monday of the current week so week 1 aligns to the calendar.
      else activateProgram(db, detail.id, localWeekRange().start);
      router.back();
    } catch (error) {
      inFlight.current = false;
      console.warn('[programs] activate failed', error);
      Alert.alert('Could not update', 'Please try again.');
    }
  };

  const confirmDelete = () => {
    if (!detail) return;
    Alert.alert('Delete this program?', 'Your routines and logged workouts are untouched.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (inFlight.current) return;
          inFlight.current = true;
          try {
            deleteProgram(getDb(), detail.id);
            router.back();
          } catch (error) {
            inFlight.current = false;
            console.warn('[programs] delete failed', error);
            Alert.alert('Delete failed', 'Please try again.');
          }
        },
      },
    ]);
  };

  if (editing && !detail) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Edit program" />
        </View>
        <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
          This program no longer exists.
        </Text>
      </Screen>
    );
  }

  const displayKinds = kindsFor(weeks);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={editing ? 'Edit program' : 'New program'} />
      </View>

      <View className="mt-3">
        <SectionLabel label="Program" />
        <View className="mt-2 min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Upper/Lower Meso"
            placeholderTextColor={palette.inkMuted}
            className="py-2.5 font-serif text-[15px] text-ink"
            accessibilityLabel="Program name"
          />
        </View>
        <View className="mt-2 min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Notes (optional)"
            placeholderTextColor={palette.inkMuted}
            className="py-2.5 font-serif text-[15px] text-ink"
            accessibilityLabel="Program notes"
          />
        </View>
        <View className="mt-2 flex-row items-center gap-3">
          <View className="w-24">
            <View className="min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
              <TextInput
                value={weeksText}
                onChangeText={setWeeksText}
                placeholder="4"
                placeholderTextColor={palette.inkMuted}
                keyboardType="number-pad"
                className="py-2.5 text-center font-mono text-[15px] text-ink"
                accessibilityLabel="Length in weeks"
              />
            </View>
          </View>
          <Text className="font-label text-[11px] uppercase tracking-[1px] text-ink-muted">
            {weeksValid ? 'weeks long' : 'weeks (1–52)'}
          </Text>
        </View>
      </View>

      {/* Weekly split — a schedule is a record, so: one ruled plate. */}
      <View className="mt-7">
        <Block device="plate">
          {/* The tally reconciles: seven lines are drawn, `trainingDays` of them assigned. */}
          <SectionLabel label="Weekly split" note={`${trainingDays} of 7`} />
          {/* The instruction that opened this line ("Assign a routine to each
              training day.") was cut by the owner as explanatory copy on
              2026-08-11 — the rows afford it. What survives is the fact the
              rows do not state. */}
          <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
            This split repeats every week.
          </Text>
          <View className="mt-2">
            {DOWS.map((d, i) => {
              const assigned = days[d.dow];
              return (
                <View key={d.dow}>
                  <Divider first={i === 0} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${d.label}: ${assigned ? assigned.routineName : 'rest'}. Change.`}
                    onPress={() => setPickerDow(d.dow)}
                    className="min-h-[44px] flex-row items-center gap-3 py-2 active:opacity-60">
                    <Text className="w-24 font-label text-[11px] uppercase tracking-[1px] text-ink-muted">
                      {d.label}
                    </Text>
                    <Text
                      className={`flex-1 font-serif text-[15px] ${
                        assigned ? 'text-ink' : 'text-ink-muted'
                      }`}>
                      {assigned ? assigned.routineName : 'Rest'}
                    </Text>
                    <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        </Block>
      </View>

      {/* Week kinds — a control strip, not a record: chips, no device. */}
      <View className="mt-7">
        <SectionLabel label="Weeks" />
        {/* Cut on 2026-08-11 as an affordance the chips already show. The tap
            is afforded; the ORDER is not, and an accumulation week carries no
            label at all (WEEK_KIND_LABEL), so the state a chip starts in is
            unnamed too. There is no other route to setting a week kind, which
            left the survivor naming "Deload weeks" with no account of how one
            comes about. The order is back, declarative rather than the
            imperative it was, and in agreement with each chip's spoken "Tap to
            change." (The sibling cut in the Weekly split above was correct —
            those rows are pressable, chevroned and say "Change." — so it
            stays cut.) */}
        <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
          Tapping a week cycles accumulation → deload → test. Deload weeks run the same split with
          the volume cut.
        </Text>
        <View className="mt-2 flex-row flex-wrap gap-2">
          {displayKinds.map((kind, i) => {
            const marked = kind !== 'accumulation';
            return (
              <Pressable
                key={i}
                accessibilityRole="button"
                accessibilityLabel={`Week ${i + 1}: ${kind}. Tap to change.`}
                onPress={() => cycleWeek(i)}
                // 44pt floor (§4), matching FilterChip in
                // src/components/exercise/exercise-picker.tsx. The strip wraps,
                // so the extra height only makes each wrapped row taller.
                className={`min-h-[44px] justify-center rounded-btn border border-hairline px-3 active:opacity-60 ${
                  marked ? 'bg-paper-dim' : ''
                }`}>
                <View className="flex-row items-baseline gap-1">
                  <Text
                    className={`font-mono text-[12px] ${
                      marked ? 'font-semibold text-ink' : 'text-ink-secondary'
                    }`}>
                    W{i + 1}
                  </Text>
                  {WEEK_KIND_LABEL[kind] ? (
                    <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-secondary">
                      {WEEK_KIND_LABEL[kind]}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Why Save is off — an annotation, so: margin. */}
      {!canSave && name.trim() !== '' && trainingDays === 0 ? (
        <View className="mt-5">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              Assign at least one training day before saving.
            </Text>
          </Block>
        </View>
      ) : null}

      {/*
        The one primary action. Disabled reads as an unfilled outline rather than
        a filled grey: muted ink on the sheet clears 4.5:1, on a hairline fill it
        does not.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={editing ? 'Save program' : 'Create program'}
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={`mt-6 h-12 items-center justify-center rounded-btn ${
          canSave ? 'bg-pine active:opacity-70' : 'border border-hairline'
        }`}>
        <Text
          className={`font-label text-[15px] font-semibold ${
            canSave ? 'text-pine-on' : 'text-ink-muted'
          }`}>
          {editing ? 'Save program' : 'Create program'}
        </Text>
      </Pressable>

      {editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isActive ? 'Stop program' : 'Start program'}
          onPress={toggleActive}
          className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons
            name={isActive ? 'stop-outline' : 'play-outline'}
            size={16}
            color={palette.inkSecondary}
          />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            {isActive ? 'Stop program' : 'Start program this week'}
          </Text>
        </Pressable>
      ) : null}

      {editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete program"
          onPress={confirmDelete}
          className="mt-5 min-h-[44px] items-center justify-center active:opacity-60">
          <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
            Delete program
          </Text>
        </Pressable>
      ) : null}

      <RoutinePicker
        visible={pickerDow !== null}
        onClose={() => setPickerDow(null)}
        onSelect={(routine) => {
          if (pickerDow !== null) setDay(pickerDow, routine);
        }}
      />
    </Screen>
  );
}
