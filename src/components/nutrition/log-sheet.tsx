import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Block, Divider } from '@/components/ui/block';
import { PaperGrid } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { logMeal } from '@/lib/db/repositories/nutrition';

/**
 * **Log** — every way to record a meal, behind one button.
 *
 * The Eat tab used to present five parallel entry points in its most valuable
 * strip (owner, 2026-08-10: *"five ways to log, presented as a menu… that is an
 * entry-method chooser, which is pushed-screen grammar; a tab root wants one
 * obvious action and the rest behind it"*), and then a round of this redesign
 * replaced them with a stamp plus a fold, which was the same menu one tap
 * deeper. The owner's call on that round was blunter and better: *"condense all
 * the logging into just one Log button… and tone it down on the word salad,
 * just call the button 'Log'"*. So the tab carries a single accent button
 * reading `Log`, and this is what it opens.
 *
 * **A modal, not a pushed route.** Same shape as the mode picker and the
 * exercise picker (src/components/home/mode-control.tsx): a native `Modal`
 * building its own root, so it dismisses with a close control and never leaves
 * a back-stack entry behind a meal you logged. Because it is its own root it
 * also prints its own {@link PaperGrid} — a Modal never passes through
 * `Screen`, and without this it would be the one surface in the app on blank
 * stock.
 *
 * **No descriptions.** Six rows, each of which says what it is. The old stamp
 * spent four lines explaining that describing a meal logs a meal.
 *
 * **Manual entry stays inline**, expanding its field group in place below the
 * row that opened it, because it is the one path with nowhere to go: there is
 * no manual-entry screen, and inventing one to hold six inputs would be the
 * pushed-screen grammar this sheet exists to remove.
 *
 * ## Conformed Set
 *
 * The rows are a **ruled plate** (a list of destinations is a record of them);
 * the manual form carries **no device**, because each input already wears the
 * well's own tokens — form (b) of the capture-surface rule in
 * src/components/ui/block.tsx. Nothing here is pine: the accent was already
 * spent on the button that opened this sheet, and a chooser has no one action.
 */

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Called after a meal is written from the inline form, so the tab re-reads. */
  onSaved: () => void;
};

/** "" is fine (stored as NULL); anything typed must be a non-negative number. */
function validNumber(text: string): boolean {
  const t = text.trim();
  if (t === '') return true;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0;
}

function toNumber(text: string): number | null {
  const t = text.trim();
  return t === '' ? null : Number(t);
}

/** "8:05" / "08:05" → "08:05"; null if it isn't a real clock time. */
function normalizeTime(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${m[2]}`;
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  mono?: boolean;
  maxLength?: number;
};

/**
 * One labelled field of the manual meal form. The input wears the well's own
 * tokens — `border-paper-deep bg-paper-dim` — because it *is* the well. An
 * input is never `bg-paper-hi`.
 */
function FormField({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
  mono,
  maxLength,
}: FieldProps) {
  return (
    <View className="flex-1">
      <Text className="mb-1 font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.inkMuted}
        keyboardType={keyboardType}
        maxLength={maxLength}
        accessibilityLabel={label}
        className={
          mono
            ? 'border border-paper-deep bg-paper-dim px-3 py-3 font-mono text-[16px] text-ink'
            : 'border border-paper-deep bg-paper-dim px-3 py-3 font-serif text-[16px] text-ink'
        }
      />
    </View>
  );
}

/**
 * The manual "Add a meal" form. A group of labelled fields, so it carries no
 * device. Mounted fresh each time it opens, so the time defaults to now and a
 * saved form comes back empty. Numbers are optional — blank stores NULL ("not
 * recorded"), never 0, which is why the tab's remainder is guarded against
 * exactly this (src/lib/nutrition/remaining.ts).
 */
function AddMealForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [time, setTime] = useState(() => clockFromISO(new Date().toISOString()));
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');

  const numbersValid = [kcal, protein, carbs, fat].every(validNumber);
  const timeValid = normalizeTime(time) !== null;
  const canSave = name.trim() !== '' && timeValid && numbersValid;

  const problem = !timeValid
    ? 'Time reads as HH:MM, e.g. 12:30.'
    : !numbersValid
      ? 'Numbers only — leave a field blank if you didn’t track it.'
      : null;

  const save = () => {
    const normalized = normalizeTime(time);
    if (!canSave || normalized === null) return;
    try {
      logMeal(getDb(), {
        date: todayISODate(),
        time: normalized,
        name: name.trim(),
        kcal: toNumber(kcal),
        protein_g: toNumber(protein),
        carbs_g: toNumber(carbs),
        fat_g: toNumber(fat),
      });
      onSaved();
    } catch (error) {
      // canSave gates the known cases; this is a backstop so a write failure
      // never crashes the tap handler or loses the typed meal.
      console.warn('[nutrition] meal save failed', error);
    }
  };

  return (
    <View className="mt-3">
      <FormField label="Meal" value={name} onChange={setName} placeholder="e.g. Salmon + lentils" />
      <View className="mt-3 flex-row gap-3">
        <FormField
          label="Time"
          value={time}
          onChange={setTime}
          placeholder="12:30"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          mono
        />
        <FormField
          label="kcal"
          value={kcal}
          onChange={setKcal}
          placeholder="—"
          keyboardType="decimal-pad"
          mono
        />
      </View>
      <View className="mt-3 flex-row gap-3">
        <FormField
          label="Protein g"
          value={protein}
          onChange={setProtein}
          placeholder="—"
          keyboardType="decimal-pad"
          mono
        />
        <FormField
          label="Carbs g"
          value={carbs}
          onChange={setCarbs}
          placeholder="—"
          keyboardType="decimal-pad"
          mono
        />
        <FormField
          label="Fat g"
          value={fat}
          onChange={setFat}
          placeholder="—"
          keyboardType="decimal-pad"
          mono
        />
      </View>

      {problem ? (
        <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">{problem}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save meal"
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={
          canSave
            ? 'mt-4 min-h-[46px] items-center justify-center rounded-btn border border-ink bg-paper-hi py-3 active:opacity-70'
            : 'mt-4 min-h-[46px] items-center justify-center rounded-btn border border-paper-deep py-3'
        }>
        <Text
          className={
            canSave
              ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink'
              : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
          }>
          Save meal
        </Text>
      </Pressable>
    </View>
  );
}

/** One row of the sheet: icon, label, affordance chevron. No descriptions. */
function LogRow({
  icon,
  label,
  chevron,
  first,
  expanded,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  chevron: keyof typeof Ionicons.glyphMap;
  first: boolean;
  expanded?: boolean;
  onPress: () => void;
}) {
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={expanded === undefined ? undefined : { expanded }}
        onPress={onPress}
        className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
        <Ionicons name={icon} size={19} color={palette.inkSecondary} />
        <View className="flex-1">
          <Text className="font-serif text-[16px] text-ink">{label}</Text>
        </View>
        <Ionicons name={chevron} size={16} color={palette.inkSecondary} />
      </Pressable>
    </View>
  );
}

/** The five rows that leave this sheet for a screen of their own. */
type LogRoute =
  '/meal-estimate' | '/food-search' | '/barcode-scan' | '/meal-templates' | '/recipes';

export function LogSheet({ visible, onClose, onSaved }: Props) {
  const router = useRouter();
  const [manualOpen, setManualOpen] = useState(false);
  // Set when a row asks for a screen; consumed by onDismiss below.
  const [pending, setPending] = useState<LogRoute | null>(null);

  /**
   * A navigating row PARKS its route and closes the sheet — it does not push.
   *
   * Pushing in the same tick as the close races the dismissal animation: the
   * modal is still on screen while the new route mounts underneath it, and on
   * iOS the sheet can end up sitting over the screen you just asked for. The
   * exercise picker hit this first and solved it the same way
   * (src/components/exercise/exercise-picker.tsx) — the push happens in
   * `onDismiss`, which fires once the sheet is genuinely gone. `onDismiss` is
   * iOS-only, and ARC is iOS-only (CLAUDE.md §3).
   */
  const go = (path: LogRoute) => {
    setPending(path);
    onClose();
  };

  const afterDismiss = () => {
    if (pending === null) return;
    const path = pending;
    setPending(null);
    router.push(path);
  };

  const saved = () => {
    setManualOpen(false);
    onClose();
    onSaved();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={afterDismiss}
      transparent={false}>
      {/* A native Modal builds its own root, so it never passes through
          `Screen` — it prints the sheet and the paper grid itself. */}
      <View className="flex-1 bg-paper">
        <PaperGrid />
        <SafeAreaView edges={['top', 'bottom']} className="flex-1">
          <View className="flex-row items-center justify-between px-5 pt-2">
            <Text className="font-serif text-[19px] font-semibold text-ink">Log</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              hitSlop={8}
              className="min-h-[44px] min-w-[44px] items-center justify-center rounded-btn active:bg-paper-deep">
              <Ionicons name="close" size={22} color={palette.inkSecondary} />
            </Pressable>
          </View>

          <ScrollView
            className="flex-1"
            contentContainerClassName="grow px-5 pb-10"
            keyboardShouldPersistTaps="handled"
            // Without this the manual form's lower fields and Save sit under the
            // keyboard: the sheet's content is short, so there is nothing to
            // scroll and contentInset never grows. Same prop, same reason, as
            // app/workout-log.tsx and app/appointment-form.tsx.
            automaticallyAdjustKeyboardInsets>
            <View className="mt-5">
              <Block device="plate">
                <LogRow
                  icon="camera-outline"
                  label="Describe or photograph"
                  chevron="chevron-forward"
                  first
                  onPress={() => go('/meal-estimate')}
                />
                <LogRow
                  icon="search-outline"
                  label="Add food"
                  chevron="chevron-forward"
                  first={false}
                  onPress={() => go('/food-search')}
                />
                <LogRow
                  icon="barcode-outline"
                  label="Scan a barcode"
                  chevron="chevron-forward"
                  first={false}
                  onPress={() => go('/barcode-scan')}
                />
                <LogRow
                  icon="albums-outline"
                  label="From a template"
                  chevron="chevron-forward"
                  first={false}
                  onPress={() => go('/meal-templates')}
                />
                <LogRow
                  icon="restaurant-outline"
                  label="Cook a recipe"
                  chevron="chevron-forward"
                  first={false}
                  onPress={() => go('/recipes')}
                />
                <LogRow
                  icon="create-outline"
                  label="Enter it manually"
                  chevron={manualOpen ? 'chevron-up' : 'chevron-down'}
                  first={false}
                  expanded={manualOpen}
                  onPress={() => setManualOpen((open) => !open)}
                />
              </Block>
            </View>

            {manualOpen ? (
              <View className="mt-5">
                <SectionLabel label="The meal" />
                <AddMealForm onSaved={saved} />
              </View>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
