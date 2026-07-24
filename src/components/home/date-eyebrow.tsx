import { Text } from 'react-native';

/**
 * The only thing above the hero: today, quietly. The rest of the old day
 * header (readiness + pillars) lives below the hero as ReadinessStrip —
 * owner call from the 2026-07-24 mock-up round: the screen answers
 * "what do I do" before "how am I doing".
 */
export function DateEyebrow() {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <Text className="text-xs uppercase tracking-widest text-ink-400 dark:text-ink-600">
      {today}
    </Text>
  );
}
