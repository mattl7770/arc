import { Text, View } from 'react-native';

/**
 * The folio line — the only thing above the hero: the drawing's own mark and
 * today's date, quietly. The readiness block lives below the hero as
 * ReadinessStrip (owner call, 2026-07-24): the screen answers "what do I do"
 * before "how am I doing".
 *
 * Deliberately unruled (owner call, 2026-07-24): a hairline under a single
 * short line closes a box around it. Separation here is whitespace's job — and
 * in this design, rules enclose objects, never pages.
 *
 * ## Why this is mono, and why "ARC" is on it (2026-08-10)
 *
 * The mockup of record draws `.cf-brandrow` as **`ARC · TUE 28 JUL`, in mono** —
 * the wordmark bold in `ink`, the date in `ink-soft` — and the app was shipping
 * the date alone, in the label face, spelled out in full ("SUNDAY 10 AUGUST").
 * Three divergences from the sheet, none of them recorded anywhere but in this
 * file's own comment, which used to argue that "the date is *spoken*, not
 * measured". That reading loses the argument on this line specifically: this is
 * not a sentence naming today, it is the **folio block of a working drawing** —
 * the sheet's identity and its date, which is exactly the thing mono sets in
 * every drawing set there has ever been. The rest of the app still spells dates
 * out in prose where they are read as words.
 *
 * The wordmark is what makes the row a folio rather than a stray timestamp, and
 * it was simply absent: Home carried no brand mark at all.
 *
 * Formatted by hand rather than with `toLocaleDateString`: Hermes ships without
 * Intl, so the options object is silently ignored on device and the string
 * comes back in a different shape than it does in the web preview. The same
 * hand-rolled approach is used in src/lib/ai/tools/write-tools.ts and
 * src/hooks/use-data-overview.ts for the same reason.
 *
 * The printed form abbreviates (the sheet has one line for it); the **spoken**
 * form does not, because "TUE" and "AUG" are read aloud inconsistently. Same
 * split as the em-dash in ./signal.tsx.
 */
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

const WEEKDAYS_SPOKEN = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTHS_SPOKEN = [
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
  const day = now.getDate();
  const printed = `${WEEKDAYS[now.getDay()] ?? ''} ${day} ${MONTHS[now.getMonth()] ?? ''}`;
  const spoken = `${WEEKDAYS_SPOKEN[now.getDay()] ?? ''} ${day} ${MONTHS_SPOKEN[now.getMonth()] ?? ''}`;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`ARC. ${spoken}`}
      className="flex-row items-baseline">
      <Text className="font-mono text-[11px] font-bold tracking-[1.3px] text-ink">ARC</Text>
      <Text className="font-mono text-[11px] tracking-[0.5px] text-ink-secondary">
        {'  ·  '}
        {printed}
      </Text>
    </View>
  );
}
