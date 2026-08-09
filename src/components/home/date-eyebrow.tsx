import { Text, View } from 'react-native';

/**
 * The only thing above the hero: today, quietly — the folio line. The readiness
 * block lives below the hero as ReadinessStrip (owner call, 2026-07-24): the
 * screen answers "what do I do" before "how am I doing".
 *
 * Deliberately unruled (owner call, 2026-07-24): a hairline under a single
 * short line closes a box around it. Separation here is whitespace's job — and
 * in this design, rules enclose objects, never pages.
 *
 * Set in `font-label` — an eyebrow in tracked caps is the label voice by
 * definition (00-design-spec.md §3). The date is *spoken* here, not measured:
 * "Thursday 8 August" is a name for today, so it is not mono's business.
 *
 * Formatted by hand rather than with `toLocaleDateString`: Hermes ships without
 * Intl, so the options object is silently ignored on device and the string
 * comes back in a different shape than it does in the web preview. The same
 * hand-rolled approach is used in src/lib/ai/tools/write-tools.ts and
 * src/hooks/use-data-overview.ts for the same reason.
 */
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function DateEyebrow() {
  const now = new Date();
  const weekday = WEEKDAYS[now.getDay()] ?? '';
  const month = MONTHS[now.getMonth()] ?? '';

  return (
    <View>
      <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
        {weekday} {now.getDate()} {month}
      </Text>
    </View>
  );
}
