import { Text } from 'react-native';

/**
 * The one notable micro on an item row — `145 mg caffeine` on a latte (owner,
 * 2026-09-23: *"Important micro should show on key items; i.e., displaying
 * caffeine on a latte"*). Which figure, if any, is decided by `keyMicro`
 * (src/lib/nutrition/key-micro.ts); this only draws it.
 *
 * A NESTED Text at the end of the row's own mono sub-line, so it inherits the
 * measuring voice and size and wraps with the line rather than claiming a line
 * of its own. It takes `ink-secondary` against the sub-line's `ink-muted` — one
 * step up the ink ladder, so it reads as the figure worth noticing without
 * spending the accent or any signal colour (a micro in a portion is not a
 * biological state). One figure per row at most, by construction: `keyMicro`
 * returns one or none.
 *
 * `lead` puts the sub-line's own ` · ` separator before it when something
 * precedes it on the line.
 */
export function KeyMicroTail({ label, lead }: { label: string | null; lead: boolean }) {
  if (label === null) return null;
  return (
    <Text className="text-ink-secondary">
      {lead ? ' · ' : ''}
      {label}
    </Text>
  );
}
