import { Pressable, Text, View } from 'react-native';

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
 * useUnitPreferences hook. No pine needed — this is pure preference, not action.
 *
 * Selected = neutral pressed state (border-hairline-strong bg-paper-deep);
 * unselected is a plain hairline. Same vocabulary as the Log metric chips.
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
            className={`min-w-[52px] items-center rounded-btn border px-3 py-2 active:bg-paper-deep ${
              on ? 'border-hairline-strong bg-paper-deep' : 'border-hairline'
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
    <View
      className={`flex-row items-center justify-between gap-3 px-4 py-3 ${
        first ? '' : 'border-t border-hairline-soft'
      }`}>
      <Text className="text-[15px] text-ink">{label}</Text>
      {children}
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

      <View className="mt-2 rounded-card border border-hairline bg-porcelain">
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
      </View>

      <Text className="mt-4 px-1 text-[11px] leading-4 text-ink-muted">
        Storage stays metric; this only changes how numbers display. Weight, volume, and length
        apply now; distance and temperature take effect as workouts and environment tracking land.
      </Text>
    </Screen>
  );
}
