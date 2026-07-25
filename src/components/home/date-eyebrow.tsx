import { Text, View } from 'react-native';

/**
 * The only thing above the hero: today, quietly, over a hairline rule — the
 * Porcelain Ledger "folio line". The readiness block lives below the hero as
 * ReadinessStrip (owner call, 2026-07-24): the screen answers "what do I do"
 * before "how am I doing".
 */
export function DateEyebrow() {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <View className="border-b border-hairline pb-2">
      <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">{today}</Text>
    </View>
  );
}
