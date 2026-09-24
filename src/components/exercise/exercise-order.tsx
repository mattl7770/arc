import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { blockSegments, type Bindable } from '@/lib/exercise/block-order';

/** What the Order plate needs from a line or a block: a key, its bind, a name. */
export type OrderItem = Bindable & { name: string };

/**
 * Reorder mode: a list of exercises as ONE ruled plate, a row per movable unit,
 * each with an up and a down control (2026-09-23).
 *
 * The same plate as the live logger's reorder mode (the local `ExerciseOrder`
 * in app/workout-live.tsx, which this was lifted from so the saved-workout
 * editor, app/routine-edit.tsx, draws the identical interaction). The logger
 * can switch to this copy and delete its own; the two are the same component.
 *
 * One plate, because it is one record — the order — and a plate per row would
 * nest devices. A superset is one row that names both movements and says what
 * it is, and it moves as one: a single member cannot step past its partner,
 * because that would silently re-bind it to a stranger or split the pair
 * (src/lib/exercise/block-order.ts). The line under the label says so and says
 * how to move one exercise out — split it at the seam — but only when there is
 * a superset for it to be about. A saved workout stores no superset, so on the
 * editor that line never shows.
 *
 * The arrows are chrome and take no accent; an arrow that cannot move is drawn
 * in hairline and announced disabled, never hidden, so the rows keep one shape.
 * `onMove` receives the key of the unit's FIRST member; the caller passes it to
 * `moveBlockSegment`, which moves the whole unit.
 */
export function ExerciseOrder({
  items,
  onMove,
}: {
  items: readonly OrderItem[];
  onMove: (key: number, direction: -1 | 1) => void;
}) {
  const segments = blockSegments(items);
  const hasSuperset = segments.some((s) => s.end > s.start);
  return (
    <Block device="plate">
      <SectionLabel label="Order" />
      {hasSuperset ? (
        <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
          A superset moves as one. To move one of its exercises on its own, split it at the seam
          first.
        </Text>
      ) : null}
      <View className="mt-1">
        {segments.map((segment, i) => {
          const members = items.slice(segment.start, segment.end + 1);
          const lead = members[0]!;
          const names = members.map((b) => b.name);
          const spoken = members.length > 1 ? `the superset ${names.join(' and ')}` : lead.name;
          const moves: {
            direction: -1 | 1;
            icon: 'chevron-up' | 'chevron-down';
            enabled: boolean;
          }[] = [
            { direction: -1, icon: 'chevron-up', enabled: i > 0 },
            { direction: 1, icon: 'chevron-down', enabled: i < segments.length - 1 },
          ];
          return (
            <View key={lead.key}>
              <Divider first={i === 0} />
              <View className="min-h-[52px] flex-row items-center gap-2 py-1.5">
                <Text className="w-5 font-mono text-[11px] text-ink-muted">{i + 1}</Text>
                <View className="flex-1">
                  {members.map((b) => (
                    <Text
                      key={b.key}
                      className="font-serif text-[15px] leading-5 text-ink"
                      numberOfLines={1}>
                      {b.name}
                    </Text>
                  ))}
                  {members.length > 1 ? (
                    <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                      Superset
                    </Text>
                  ) : null}
                </View>
                {moves.map((m) => (
                  <Pressable
                    key={m.direction}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${spoken} ${m.direction < 0 ? 'up' : 'down'}`}
                    accessibilityState={{ disabled: !m.enabled }}
                    disabled={!m.enabled}
                    onPress={() => onMove(lead.key, m.direction)}
                    className="h-11 w-11 items-center justify-center rounded-btn border border-hairline active:bg-paper-dim">
                    <Ionicons
                      name={m.icon}
                      size={18}
                      color={m.enabled ? palette.inkSecondary : palette.hairline}
                    />
                  </Pressable>
                ))}
              </View>
            </View>
          );
        })}
      </View>
    </Block>
  );
}

/**
 * The door into and out of reorder mode — label voice, off the accent budget,
 * right-aligned above the list it changes. The logger draws the same control
 * inline; this is its copy for the saved-workout editor.
 */
export function ReorderToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <View className="flex-row justify-end">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={active ? 'Done reordering exercises' : 'Reorder exercises'}
        onPress={onToggle}
        className="min-h-[44px] flex-row items-center gap-1.5 px-1 active:opacity-60">
        <Ionicons
          name={active ? 'checkmark' : 'swap-vertical'}
          size={14}
          color={palette.inkSecondary}
        />
        <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
          {active ? 'Done' : 'Reorder'}
        </Text>
      </Pressable>
    </View>
  );
}
