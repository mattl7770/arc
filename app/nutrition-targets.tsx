import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { keypadDoneKey } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { activeNutritionTargets, setNutritionTargets } from '@/lib/db/repositories/nutrition';

/**
 * Daily targets editor. Saving APPENDS a new immutable version effective today
 * (0009_nutrition_targets.sql — the protocol_versions pattern), so history is
 * judged against the targets of its own era. Any subset of the five values is
 * a valid target set; blank means "no target", never 0. The Coach's future
 * proposals land in the same table with created_by='ai'.
 *
 * Conformed Set treatment: the form is **form (b) of the capture-surface rule**
 * in src/components/ui/block.tsx — a group of labelled fields carries no block,
 * and each field wears the well's own tokens (`border-paper-deep bg-paper-dim`)
 * directly, named by a `SectionLabel` and separated by whitespace, as in
 * app/capture.tsx. A `<Block device="well">` around the group would nest a
 * recess in a recess and force the fields up onto plate stock; an input is never
 * `bg-paper-hi`. The provenance line is a **margin annotation**. Saving is a
 * live decision, so the consequence is stated in future tense and sits directly
 * under the control that performs it, with nothing after it (00-design-spec.md
 * §5).
 *
 * Every value on this screen is a measurement, so every field and every
 * provenance figure is mono. No accent: this is a settings surface, and the
 * save is the only action on it either way.
 */

/**
 * Blank means "no target"; a typed number must be POSITIVE.
 *
 * It used to accept 0 for everything but kcal, and 0 is the one value every
 * reader throws away: `dayFigure` treats a non-positive target as no target
 * (a "0 g carbs" goal is not a frame of reference, and it is what a progress
 * rule divides by). So a saved 0 was stored user intent that the Eat tab then
 * behaved as though it had never been set, with nothing on either screen
 * explaining the disagreement. Leave the field blank instead — that is the same
 * intent, stated in the way the whole app already reads.
 */
function validNumber(text: string): boolean {
  const t = text.trim();
  if (t === '') return true;
  const n = Number(t);
  return Number.isFinite(n) && n > 0;
}

function toNumber(text: string): number | null {
  const t = text.trim();
  return t === '' ? null : Number(t);
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  keyboardType?: TextInputProps['keyboardType'];
  /**
   * Set ONLY when this field shares a `flex-row` with siblings and should take
   * an equal share of the width. See the note on {@link FormField} — in a column
   * it collapses the field to zero height instead.
   */
  fill?: boolean;
};

/**
 * One labelled, recessed field.
 *
 * ## Why the flex is opt-in even though nothing here renders wrong
 *
 * The wrapper used to be `<View className="flex-1">` unconditionally. All five
 * fields on this screen happen to sit in a `flex-row`, so that was correct — by
 * luck of the layout, not by design.
 *
 * The moment someone adds a sixth target and gives it a row of its own, the
 * unconditional flex becomes the bug that made New Protocol and Create-a-food
 * draw boxes over other boxes: in a column the main axis is vertical, `flex-1`
 * resolves to `flexBasis: 0%` **on the height**, the `mt-*` parent has no height
 * of its own (it sizes to content inside a `<Screen scroll>`) so `flexGrow` gets
 * nothing to distribute, and the field lays out at **zero height**. Yoga has no
 * `min-height: auto` floor and views do not clip, so the label and the bordered
 * input still paint at full size — over whatever follows. The failure is silent
 * until it is on a screen.
 *
 * So the flex is opt-in and named for what it is: `fill` belongs to a field
 * sharing a **row**. The wrapper stays (a label stacked over an input needs
 * something to stack in) but it is plain by default, and because the row
 * distributes the wrapper rather than the input, `fill` lands on the wrapper.
 * The reference fix and its full post-mortem are in app/protocol-edit.tsx.
 */
function FormField({ label, value, onChange, keyboardType, fill }: FieldProps) {
  const kind = keyboardType ?? 'decimal-pad';
  return (
    <View className={fill ? 'flex-1' : undefined}>
      <Text className="mb-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="—"
        placeholderTextColor={palette.inkMuted}
        keyboardType={kind}
        returnKeyType={keypadDoneKey(kind)}
        accessibilityLabel={label}
        className="border border-paper-deep bg-paper-dim px-3 py-3 font-mono text-[15px] text-ink"
      />
    </View>
  );
}

export default function NutritionTargetsScreen() {
  const router = useRouter();
  const [active] = useState(() => activeNutritionTargets(getDb(), todayISODate()) ?? null);

  const prefill = (v: number | null | undefined): string => (v == null ? '' : String(v));
  const [kcal, setKcal] = useState(() => prefill(active?.kcal));
  const [protein, setProtein] = useState(() => prefill(active?.protein_g));
  const [carbs, setCarbs] = useState(() => prefill(active?.carbs_g));
  const [fat, setFat] = useState(() => prefill(active?.fat_g));
  const [fiber, setFiber] = useState(() => prefill(active?.fiber_g));

  const numbersValid = [kcal, protein, carbs, fat, fiber].every(validNumber);
  const kcalNum = toNumber(kcal);
  const kcalValid = kcalNum === null || kcalNum > 0;
  const values = [kcalNum, toNumber(protein), toNumber(carbs), toNumber(fat), toNumber(fiber)];
  const anySet = values.some((v) => v !== null);
  const canSave = numbersValid && kcalValid && anySet;

  const problem = !numbersValid
    ? 'Positive numbers only — blank a field to drop that target.'
    : !kcalValid
      ? 'A kcal target has to be above zero — blank it to drop it.'
      : !anySet
        ? 'Set at least one target (any subset works).'
        : null;

  const save = () => {
    if (!canSave) return;
    try {
      setNutritionTargets(getDb(), {
        effective_date: todayISODate(),
        kcal: kcalNum,
        protein_g: values[1] ?? null,
        carbs_g: values[2] ?? null,
        fat_g: values[3] ?? null,
        fiber_g: values[4] ?? null,
      });
      router.back();
    } catch (error) {
      // canSave gates the known cases; backstop so a write failure never
      // crashes the tap handler.
      console.warn('[nutrition-targets] save failed', error);
    }
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Daily targets" />
      </View>

      <View className="mt-2">
        <Block device="margin">
          {active ? (
            <Text className="font-mono text-[11px] text-ink-muted">
              Since {active.effective_date} · set by {active.created_by === 'ai' ? 'Coach' : 'you'}
            </Text>
          ) : (
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              No targets yet — the Today card shows plain totals until you set some.
            </Text>
          )}
        </Block>
      </View>

      <View className="mt-5">
        <SectionLabel label="Targets" note="Any subset" />

        {/* `fill` on every field here because every one of them shares a row.
            A field that ever gets a row to itself must NOT carry it. */}
        <View className="mt-2 flex-row gap-3">
          <FormField label="kcal" value={kcal} onChange={setKcal} fill />
          <FormField label="Protein g" value={protein} onChange={setProtein} fill />
        </View>
        <View className="mt-3 flex-row gap-3">
          <FormField label="Carbs g" value={carbs} onChange={setCarbs} fill />
          <FormField label="Fat g" value={fat} onChange={setFat} fill />
          <FormField label="Fiber g" value={fiber} onChange={setFiber} fill />
        </View>

        {problem ? (
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            {problem}
          </Text>
        ) : null}

        {/* The consequence of the tap, in future tense, immediately above the
            control that performs it — a pending write is a live decision. */}
        <Text className="mt-4 font-serif text-[13px] leading-5 text-ink-muted">
          On save: a new version starts today. Past days keep the targets they were lived under.
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save targets"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={save}
          className={
            canSave
              ? 'mt-3 min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-hi py-3 active:opacity-70'
              : 'mt-3 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep py-3'
          }>
          <Text
            className={
              canSave
                ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink'
                : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
            }>
            Save targets
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
