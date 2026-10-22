import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import {
  DEFAULT_FINDING_THRESHOLDS,
  FINDING_THRESHOLD_SPECS,
  getFindingThresholds,
  resetFindingThresholds,
  saveFindingThresholds,
  type FindingThresholdSpec,
  type FindingThresholds,
} from '@/lib/ai/finding-thresholds';
import { getDb } from '@/lib/db/client';

/**
 * Settings › Coach › Record checks — the thresholds the record-hygiene and
 * medical-attention detectors read (src/lib/ai/findings.ts), every one of them
 * in one plate, each a − / + stepper on its spec's own grid and range.
 *
 * The defaults and why each is what it is live beside the numbers in
 * src/lib/ai/finding-thresholds.ts. A change is written at once and read on
 * the next pass or `get_insights` call; nothing is recomputed here, and a
 * threshold changes only what the Coach is TOLD, never anything in his data.
 *
 * Conformed Set: a ruled plate (settings are a record), the label serif, the
 * value mono (a measure), and no accent — Settings spends none.
 */
function display(spec: FindingThresholdSpec, value: number): string {
  const text = spec.step < 1 ? String(value) : String(Math.round(value));
  return spec.unit ? `${text} ${spec.unit}` : text;
}

function Stepper({
  spec,
  value,
  first,
  onChange,
}: {
  spec: FindingThresholdSpec;
  value: number;
  first: boolean;
  onChange: (next: number) => void;
}) {
  // Whole-step buttons; the coarse step for the fine-grained z so a tap moves
  // it by something you can feel.
  const step = spec.step < 0.1 ? 0.1 : spec.step;
  const button = (sign: -1 | 1) => {
    const disabled = sign < 0 ? value <= spec.min : value >= spec.max;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${sign < 0 ? 'Lower' : 'Raise'} ${spec.label}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={6}
        onPress={() => onChange(value + sign * step)}
        className="h-8 w-8 items-center justify-center rounded-btn border border-hairline active:bg-paper-dim">
        <Text className={`font-label text-[15px] ${disabled ? 'text-ink-muted' : 'text-ink'}`}>
          {sign < 0 ? '−' : '+'}
        </Text>
      </Pressable>
    );
  };
  return (
    <View>
      <Divider first={first} />
      <View className="min-h-[44px] flex-row items-center gap-3 py-2">
        <Text className="flex-1 font-serif text-[14px] text-ink">{spec.label}</Text>
        {button(-1)}
        <Text className="w-16 text-center font-mono text-[13px] text-ink">
          {display(spec, value)}
        </Text>
        {button(1)}
      </View>
    </View>
  );
}

export function FindingThresholdSettings() {
  const [values, setValues] = useState<FindingThresholds>(() => getFindingThresholds(getDb()));
  const save = useCallback((patch: Partial<FindingThresholds>) => {
    setValues(saveFindingThresholds(getDb(), patch));
  }, []);
  const moved = FINDING_THRESHOLD_SPECS.some(
    (spec) => values[spec.key] !== DEFAULT_FINDING_THRESHOLDS[spec.key]
  );

  return (
    <View className="mt-8">
      <SectionLabel label="Record checks" />
      <View className="mt-3">
        <Block device="plate">
          {FINDING_THRESHOLD_SPECS.map((spec, index) => (
            <Stepper
              key={spec.key}
              spec={spec}
              value={values[spec.key]}
              first={index === 0}
              onChange={(next) => save({ [spec.key]: next })}
            />
          ))}
          {moved ? (
            <>
              <Divider />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reset record checks to their defaults"
                onPress={() => setValues(resetFindingThresholds(getDb()))}
                className="min-h-[44px] justify-center py-3 active:opacity-60">
                <Text className="font-label text-[13px] font-semibold text-ink">
                  Reset to defaults
                </Text>
              </Pressable>
            </>
          ) : null}
        </Block>
      </View>
      <View className="mt-4">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            What the Coach is told about gaps, duplicates, unlikely values, lab changes and symptoms
            that keep coming back. They are facts for it to weigh, never changes: nothing in your
            record moves unless you approve it. Days under a status never count as gaps.
          </Text>
        </Block>
      </View>
    </View>
  );
}
