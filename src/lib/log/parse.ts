/**
 * The command-field parser — the *offline* fast path for the "Log anything…"
 * field. It handles the common one-line structured logs deterministically
 * ("weight 178", "hrv 48", "16 oz water", "180 lb") and treats everything else
 * as a free note for the Coach.
 *
 * The core rule is ADJACENCY: a number only becomes a metric if it sits right
 * next to that metric's keyword or unit. Scanning "a keyword somewhere + the
 * first number somewhere" silently mis-logged notes ("took 2 pills, weight 181"
 * → 2 lb; "ran 5k then hrv 48" → HRV 5), which broke the module's own premise —
 * a note is always a valid interpretation, so the parser must never turn one
 * into a wrong measurement. Anything not matched adjacently is saved verbatim.
 *
 * This is intentionally narrow. Rich natural language ("ate eggs + oats, 45g
 * protein" → a meal with macros) needs the on-device model and lands with the
 * Coach (Phase 3, docs/architecture-migration.md).
 */
import { METRICS, type MetricDescriptor, type MetricKey } from './metrics';

export type ParseResult =
  | {
      kind: 'metric';
      metric: MetricKey;
      /** Value in the metric's stored (canonical) unit. */
      canonical: number;
      /** Value as the user effectively typed it, in `displayUnit`. */
      display: number;
      displayUnit: string;
    }
  | { kind: 'note'; text: string };

/** A number: digits with an optional single decimal. No sign — a leading "-"
 * isn't consumed, so "weight -5" falls through to a note rather than logging 5. */
const NUM = '(\\d+(?:\\.\\d+)?)';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Alternation of tokens, longest first so "lbs" is tried before "lb". */
function alt(tokens: string[]): string {
  return tokens
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
}

type Hit = { value: number; unit?: string };

/**
 * Find a number *bound to* this metric: adjacent to one of its keywords, or (for
 * the few unambiguous `inferUnits`) adjacent to that unit. Returns the number
 * and the matched unit, if any. Undefined if the metric isn't referenced.
 */
function matchMetric(text: string, metric: MetricDescriptor): Hit | undefined {
  const unitKeys = metric.units ? Object.keys(metric.units) : [];
  // Optional unit immediately after the number ("178 lb", "16oz").
  const unitGroup = unitKeys.length ? `(?:\\s*(${alt(unitKeys)})\\b)?` : '';

  if (metric.keywords.length) {
    const kw = alt(metric.keywords);
    // keyword then number (+ optional unit): "weight 178", "hrv: 48 ms".
    // Separator excludes "-" so a stray minus doesn't get eaten as spacing.
    const kwFirst = new RegExp(`\\b(?:${kw})\\b[\\s:=]*${NUM}${unitGroup}`, 'i');
    const a = kwFirst.exec(text);
    if (a) return { value: Number(a[1]), unit: a[2]?.toLowerCase() };
    // number (+ optional unit) then keyword: "16 oz water", "48 resting".
    const numFirst = new RegExp(`${NUM}${unitGroup}\\s*\\b(?:${kw})\\b`, 'i');
    const b = numFirst.exec(text);
    if (b) return { value: Number(b[1]), unit: b[2]?.toLowerCase() };
  }

  if (metric.inferUnits?.length) {
    // number then an unambiguous unit, no keyword needed: "180 lb", "48 bpm".
    const infer = new RegExp(`${NUM}\\s*(${alt(metric.inferUnits)})\\b`, 'i');
    const m = infer.exec(text);
    if (m) return { value: Number(m[1]), unit: m[2]!.toLowerCase() };
  }

  return undefined;
}

/**
 * Parse a raw command-field string into a structured metric or a note. The first
 * metric (in registry order) that a number is adjacently bound to wins;
 * otherwise the whole string is a note.
 */
export function parseCommand(input: string): ParseResult {
  const text = input.trim();

  for (const metric of METRICS) {
    const hit = matchMetric(text, metric);
    if (!hit) continue;
    const convert = hit.unit ? metric.units?.[hit.unit] : undefined;
    const canonical = convert ? convert(hit.value) : metric.toCanonical(hit.value);
    return {
      kind: 'metric',
      metric: metric.key,
      canonical,
      display: hit.value,
      displayUnit: hit.unit ?? metric.displayUnit,
    };
  }

  return { kind: 'note', text };
}
