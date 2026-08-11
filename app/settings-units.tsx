import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import type {
  DistanceUnit,
  LengthUnit,
  TemperatureUnit,
  VolumeUnit,
  WeightUnit,
} from '@/lib/user/types';

/**
 * Units — display-only preferences. Storage stays canonical SI (kg, cm, ml);
 * these toggles only change how numbers render (src/lib/user/types.ts). Each
 * category is a two-option segmented control that persists immediately via the
 * useUnitPreferences hook.
 *
 * Conformed Set treatment: one **ruled plate** — a settings list is a record —
 * with the rationale below it as a **margin annotation**.
 *
 * **Zero accent**, which this screen already was: selection is a neutral
 * pressed state (border-ink on paper-dim), never a hue. Unit symbols are
 * measured values, so the segments are set in mono.
 */

type Option<T extends string> = { value: T; label: string };

const WEIGHT: readonly Option<WeightUnit>[] = [
  { value: 'lb', label: 'lb' },
  { value: 'kg', label: 'kg' },
];
const DISTANCE: readonly Option<DistanceUnit>[] = [
  { value: 'mi', label: 'mi' },
  { value: 'km', label: 'km' },
];
const VOLUME: readonly Option<VolumeUnit>[] = [
  { value: 'oz', label: 'oz' },
  { value: 'ml', label: 'ml' },
];
const LENGTH: readonly Option<LengthUnit>[] = [
  { value: 'in', label: 'in' },
  { value: 'cm', label: 'cm' },
];
const TEMPERATURE: readonly Option<TemperatureUnit>[] = [
  { value: 'F', label: '°F' },
  { value: 'C', label: '°C' },
];

/** A two-option segmented control. Generic so onChange stays type-safe per row. */
function Segment<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <View className="flex-row gap-1.5">
      {options.map((opt) => {
        const on = value === opt.value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={opt.label}
            onPress={() => onChange(opt.value)}
            className={`min-h-[44px] min-w-[52px] items-center justify-center rounded-btn border px-3 py-2 active:bg-paper-dim ${
              on ? 'border-ink bg-paper-dim' : 'border-hairline'
            }`}>
            <Text
              className={`font-mono text-[13px] ${
                on ? 'font-medium text-ink' : 'text-ink-secondary'
              }`}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * One ruled line of the plate. No horizontal padding — the plate supplies the
 * gutter, and the rule runs between rows rather than around them.
 */
function Row({
  label,
  first,
  children,
}: {
  label: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View>
      <Divider first={first} />
      <View className="min-h-[44px] flex-row items-center justify-between gap-3 py-2.5">
        <Text className="font-serif text-[15px] text-ink">{label}</Text>
        {children}
      </View>
    </View>
  );
}

export default function SettingsUnitsScreen() {
  const { units, setUnit } = useUnitPreferences();

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Units" />
      </View>

      <View className="mt-3">
        <Block device="plate">
          <Row label="Weight" first>
            <Segment value={units.weight} options={WEIGHT} onChange={(v) => setUnit('weight', v)} />
          </Row>
          <Row label="Distance">
            <Segment
              value={units.distance}
              options={DISTANCE}
              onChange={(v) => setUnit('distance', v)}
            />
          </Row>
          <Row label="Volume">
            <Segment value={units.volume} options={VOLUME} onChange={(v) => setUnit('volume', v)} />
          </Row>
          <Row label="Length">
            <Segment value={units.length} options={LENGTH} onChange={(v) => setUnit('length', v)} />
          </Row>
          <Row label="Temperature">
            <Segment
              value={units.temperature}
              options={TEMPERATURE}
              onChange={(v) => setUnit('temperature', v)}
            />
          </Row>
        </Block>
      </View>

      <View className="mt-5">
        <Block device="margin">
          {/* "Storage stays metric; this only changes how numbers display." was
              cut on 2026-08-11 as explanatory copy — but it was the half that
              carried a fact. It is not obtainable from a screen of toggles, it
              is what makes switching reversible and an export readable
              (CLAUDE.md §2), and without it the survivor's "apply now" had
              nothing to apply TO. Restored as one sentence, the referent
              supplied by the clause it lost. */}
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            Storage stays metric; these toggles only change how numbers display — weight, volume,
            and length already do, distance and temperature once workouts and environment tracking
            land.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
