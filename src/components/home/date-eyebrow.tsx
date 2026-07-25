import { Text, View } from 'react-native';

/**
 * The only thing above the hero: today, quietly — the Porcelain Ledger "folio
 * line". The readiness block lives below the hero as ReadinessStrip (owner
 * call, 2026-07-24): the screen answers "what do I do" before "how am I doing".
 *
 * Deliberately unruled (owner call, 2026-07-24): a hairline under a single
 * short line closes a box around it. Separation here is whitespace's job.
 */
export function DateEyebrow() {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <View>
      <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">{today}</Text>
    </View>
  );
}
