/**
 * What the quick-log box does with a line (item 63: *"Action button brings up
 * log anything box + this works for foods"*). Pure; db/log.test.mjs §25.
 *
 * The Log tab's command field reads a line as a metric or keeps it as a note.
 * The quick box is the same field with food as its default: a line that is a
 * metric files exactly as the Log tab files it (the same parser, the same
 * screen-time filing, the same range check), and anything else is a food
 * description for the describe-estimate screen.
 *
 * ## One rule the Log tab does not need
 *
 * The parser binds a number to WEIGHT by its unit alone — "180 lb" is a weigh-in
 * with no keyword (src/lib/log/parse.ts, `inferUnits`). On the Log tab that is
 * right, because nobody types groceries there. In a box whose default is food it
 * is a hazard: "1 lb ground beef" parses as a body weight of one pound, and
 * `logMetricCapture` would file it to the record AND to Apple Health. So here a
 * metric found by its UNIT alone counts only when the unit and its number are
 * the whole line ("180 lb", "48 ms").
 *
 * ## The rule both fields share
 *
 * Found by its KEYWORD, a metric counts only when the measurement is the whole
 * line: the keyword, the number, its unit and a little filler ("hrv 48 this
 * morning", "log weight 178"), and nothing else (`isWholeMetricLine`,
 * src/lib/log/parse.ts). Before 2026-10-21 any keyword next to any number
 * counted, so "oatmeal with 8 oz water" filed 236 ml of water and dropped the
 * oatmeal, "chicken thighs resting 10 min then 200g rice" filed a resting
 * heart rate of 10, and "bw 1 banana" sent a weight of one pound to Apple
 * Health. Here such a line is food; on the Log tab, where it had the same bug,
 * it is now a note.
 *
 * A keyword line the range check refuses ("weight 0", "bf 150") is a note, as
 * on the Log tab: it was meant as a measurement, so estimating it as a meal
 * would be wrong, and a note never loses the input.
 */
import { metricByKey, isLoggableCanonical, type MetricDescriptor, type MetricKey } from './metrics';
import { isWholeMetricLine, parseCommand } from './parse';
import { screenTimeFiling } from '@/lib/screen-time/entry';
import type { UnitPreferences } from '@/lib/user/types';

export type QuickLineAction =
  | { kind: 'empty' }
  /** Filed by the noon rule (or the named day), never to today blindly. */
  | { kind: 'screen_time'; date: string; minutes: number }
  | { kind: 'metric'; metric: MetricKey; canonical: number }
  /** A measurement the range check refused — kept verbatim, as the Log tab keeps it. */
  | { kind: 'note'; text: string }
  /** Everything else: handed to the describe-estimate screen. */
  | { kind: 'food'; description: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does the line name this metric by one of its keywords? */
function namesMetric(text: string, metric: MetricDescriptor): boolean {
  if (metric.keywords.length === 0) return false;
  const kw = metric.keywords.map(escapeRegExp).join('|');
  return new RegExp(`\\b(?:${kw})\\b`, 'i').test(text);
}

/** Is the line nothing but a number and one of this metric's units ("180 lb")? */
function isBareMeasurement(text: string, metric: MetricDescriptor): boolean {
  const units = metric.units ? Object.keys(metric.units) : [];
  if (units.length === 0) return false;
  const alt = units
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return new RegExp(`^\\d+(?:\\.\\d+)?\\s*(?:${alt})$`, 'i').test(text);
}

export function quickLineAction(
  line: string,
  units: UnitPreferences | undefined,
  now: Date,
  dayStartsAt?: string
): QuickLineAction {
  // The words are kept as typed; only the matching reads a collapsed copy.
  const raw = line.trim();
  if (raw === '') return { kind: 'empty' };
  const text = raw.replace(/\s+/g, ' ');
  const result = parseCommand(text, units);

  // Screen time has a whole-line grammar of its own already (parse.ts), so it
  // cannot swallow a meal; it files where the command field files it.
  const filing = screenTimeFiling(result, now, dayStartsAt);
  if (filing) return { kind: 'screen_time', date: filing.date, minutes: filing.minutes };

  if (result.kind !== 'metric') return { kind: 'food', description: raw };
  const metric = metricByKey(result.metric);
  // An out-of-range screen-time line ("screen 30h") is a measurement, not food.
  if (!metric || result.metric === 'screen_time') return { kind: 'note', text: raw };

  const whole = namesMetric(text, metric)
    ? isWholeMetricLine(text, result.metric)
    : isBareMeasurement(text, metric);
  if (!whole) return { kind: 'food', description: raw };
  if (!isLoggableCanonical(metric, result.canonical)) return { kind: 'note', text: raw };
  return { kind: 'metric', metric: result.metric, canonical: result.canonical };
}
