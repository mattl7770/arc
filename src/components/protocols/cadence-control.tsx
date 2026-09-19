/**
 * How often one protocol item comes round.
 *
 * Extracted verbatim from app/protocol-edit.tsx on 2026-09-19 so the per-item
 * editor can use the same control. Nothing about it changed in the move.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import { WEEKDAY_LABELS } from '@/lib/protocols/cadence';
import { cadenceLabel } from '@/lib/protocols/format';
import type { Cadence, CadenceKind } from '@/lib/protocols/types';

import { Chip, FormField, parseDays } from './form-controls';

/** The cadence kinds, in the order the control presents them. */
const CADENCE_KINDS: { kind: CadenceKind; label: string }[] = [
  { kind: 'daily', label: 'Every day' },
  { kind: 'weekdays', label: 'Certain days' },
  { kind: 'every_n_days', label: 'Every N days' },
  { kind: 'quota', label: 'N a week' },
];

/** Switching kind keeps a sensible default rather than an empty control. */
export function cadenceOfKind(kind: CadenceKind, previous: Cadence): Cadence {
  switch (kind) {
    case 'daily':
      return { kind: 'daily' };
    case 'weekdays':
      return previous.kind === 'weekdays' ? previous : { kind: 'weekdays', days: [1, 3, 5] };
    case 'every_n_days':
      return previous.kind === 'every_n_days' ? previous : { kind: 'every_n_days', n: 2 };
    case 'quota':
      return previous.kind === 'quota' ? previous : { kind: 'quota', per_week: 3 };
  }
}

/**
 * Collapsed to a single label-voice line that STATES the cadence, so nothing is
 * hidden and the default — every day — costs one line rather than a row of
 * chips per item. A supplement stack of eight items would otherwise open on
 * thirty-two chips the user never touches.
 *
 * `defaultOpen` is for the per-item editor, which draws one item and has room
 * for the question to be asked outright.
 */
export function CadenceControl({
  cadence,
  onChange,
  itemLabel,
  defaultOpen,
}: {
  cadence: Cadence;
  onChange: (next: Cadence) => void;
  itemLabel: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen === true);

  return (
    <View className="mt-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Cadence for ${itemLabel}: ${cadenceLabel(cadence)}. ${
          open ? 'Hide options' : 'Change'
        }`}
        onPress={() => setOpen((shown) => !shown)}
        className="min-h-[44px] flex-row items-center gap-2 py-2 active:opacity-60">
        <Ionicons name="repeat-outline" size={15} color={palette.inkMuted} />
        <Text className="flex-1 font-label text-[12px] text-ink-secondary">
          {cadenceLabel(cadence)}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={palette.inkMuted} />
      </Pressable>

      {open ? (
        <View className="mt-1">
          <View className="flex-row flex-wrap gap-2">
            {CADENCE_KINDS.map((k) => (
              <Chip
                key={k.kind}
                label={k.label}
                compact
                on={cadence.kind === k.kind}
                onPress={() => onChange(cadenceOfKind(k.kind, cadence))}
              />
            ))}
          </View>

          {cadence.kind === 'weekdays' ? (
            <View className="mt-2 flex-row flex-wrap gap-1.5">
              {WEEKDAY_LABELS.map((label, index) => {
                const day = index + 1;
                const on = cadence.days.includes(day);
                return (
                  <Chip
                    key={label}
                    label={label}
                    compact
                    on={on}
                    accessibilityLabel={`${label}${on ? ', on' : ', off'}`}
                    onPress={() =>
                      onChange({
                        kind: 'weekdays',
                        days: (on
                          ? cadence.days.filter((d) => d !== day)
                          : [...cadence.days, day]
                        ).sort((a, b) => a - b),
                      })
                    }
                  />
                );
              })}
            </View>
          ) : null}

          {cadence.kind === 'every_n_days' ? (
            <View className="mt-2 flex-row items-center gap-2">
              <View className="w-20">
                <FormField
                  value={String(cadence.n)}
                  onChange={(text) => {
                    const n = parseDays(text);
                    onChange({ kind: 'every_n_days', n: n !== null && n >= 2 ? n : 2 });
                  }}
                  keyboardType="number-pad"
                  maxLength={3}
                  mono
                  accessibilityLabel="Every how many days"
                />
              </View>
              <Text className="font-label text-[12px] text-ink-secondary">days apart</Text>
            </View>
          ) : null}

          {cadence.kind === 'quota' ? (
            <View className="mt-2 flex-row items-center gap-2">
              <View className="w-20">
                <FormField
                  value={String(cadence.per_week)}
                  onChange={(text) => {
                    const n = parseDays(text);
                    onChange({ kind: 'quota', per_week: n !== null && n <= 7 ? n : 3 });
                  }}
                  keyboardType="number-pad"
                  maxLength={1}
                  mono
                  accessibilityLabel="How many times a week"
                />
              </View>
              {/* The whole point of a quota, said once where it is chosen: ARC
                  surfaces it until the week's count is met, and the user picks
                  which days. Without this the control reads like a weekday list
                  with the days left blank. */}
              <Text className="flex-1 font-label text-[12px] text-ink-secondary">
                times a week — any days
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
