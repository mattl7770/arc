import { Text, View } from 'react-native';

type Props = {
  /** The section's name, in product nouns. "Today's Mission", never "Issue Schedule". */
  label: string;
  /**
   * An optional measured note, right-aligned and set in mono — a tally, a
   * count, a date. It is a *measurement*, so it never carries an invented
   * reference code: no sheet numbers, no tile keys, nothing that keys no user
   * action (00-design-spec.md §5).
   */
  note?: string;
};

/**
 * The label voice — the mockup's `.cf-sec` / `.cf-sec-t` / `.cf-sec-note`.
 *
 * Uppercase, tracked, quiet: it names a block without competing with it. The
 * optional `note` is the mono counterpart ("serif speaks, mono measures"), so
 * a section can carry its own tally on the same baseline.
 *
 * Set in `font-label` — the third of the design's three voices (00-design-spec
 * §3), and the one the app had been shipping without. Uppercase section labels,
 * eyebrows, buttons and chips all belong to it; a tracked-caps label left in the
 * default face is the same bug as a measurement left out of mono.
 *
 * Sits at 10px — the metadata layer is specified at 9.5–10px so the 9px render
 * floor is never load-bearing (00-design-spec.md §4).
 *
 * Several screens still define their own local `SectionLabel` helper. This is
 * the shared one for the Conformed Set surface system; sweeping the rest onto
 * it is a separate pass, not something to do opportunistically.
 */
export function SectionLabel({ label, note }: Props) {
  return (
    <View className="flex-row items-baseline gap-2">
      <Text className="flex-1 font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      {note ? <Text className="font-mono text-[10px] text-ink-muted">{note}</Text> : null}
    </View>
  );
}
