/**
 * The sections BOTH reports draw, and the small shared vocabulary they need.
 *
 * Body composition and the symptom log appear on the self-review (over its
 * period) and on the doctor pack (over the last 90 days). They live here rather
 * than in either assembler so neither imports the other — the dependency
 * direction "the doctor pack reaches into the self-review for a body table" is
 * the kind of thing that reads as an accident six months later, and it would
 * put the self-review's module-level constants on the doctor pack's import
 * graph for no reason.
 *
 * One method, two windows. A second implementation of "how a body change is
 * stated" is how the two documents would start disagreeing about the same
 * scale.
 */
import type { Database } from '@/lib/db/database';
import { bodyDailySeries, type SeriesPoint } from '@/lib/ai/series';
import { getPreferences } from '@/lib/db/repositories/user';
import { metricByKey, resolveDisplay, type DisplaySpec } from '@/lib/log/metrics';
import type { UnitPreferences } from '@/lib/user/types';

import { EM_DASH, average, count, namedThenCounted, num, plural, signed } from './format';
import { formatDate } from './period';
import type { BodySection, Figure, SymptomRow, SymptomsSection } from './types';

/**
 * The standing disclaimer, authored once. Printed on both report types so a
 * file that leaves the device always says what it is and what it is not.
 */
export const REPORT_DISCLAIMER =
  'Personal health records maintained by the individual named or implied here, ' +
  'assembled by ARC from data entered on their own device. This is not a medical ' +
  'record and not a diagnosis. Every figure was computed by deterministic code ' +
  'from stored values; nothing in it was written or estimated by a language model.';

/** How many endpoint days a body-composition average is taken over (spec §3a.6). */
export const BODY_ENDPOINT_DAYS = 3;

/** How many dates a symptom row names before it starts counting instead. */
const SYMPTOM_DATES_NAMED = 6;

/** The last local instant of `date`, as the exclusive UTC bound `bodyDailySeries` wants. */
export function endOfDayUtc(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d! + 1, 0, 0, 0, 0).toISOString();
}

/** A display spec for one registry metric under the user's chosen units. */
export function displayFor(
  key: 'weight' | 'body_fat' | 'waist' | 'hrv' | 'rhr',
  units: UnitPreferences
): DisplaySpec | null {
  const metric = metricByKey(key);
  return metric ? resolveDisplay(metric, units) : null;
}

/** A canonical value rendered under a display spec, or null when there is none. */
export function toDisplay(spec: DisplaySpec | null, canonical: number | null): string | null {
  if (spec == null || canonical == null || !Number.isFinite(canonical)) return null;
  return num(spec.fromCanonical(canonical), spec.decimals);
}

type BodyColumn = 'weight_kg' | 'body_fat_pct' | 'waist_cm';

const BODY_SPECS: { column: BodyColumn; key: 'weight' | 'body_fat' | 'waist'; label: string }[] = [
  { column: 'weight_kg', key: 'weight', label: 'Weight' },
  { column: 'body_fat_pct', key: 'body_fat', label: 'Body fat' },
  { column: 'waist_cm', key: 'waist', label: 'Waist' },
];

/**
 * The window's endpoints as {@link BODY_ENDPOINT_DAYS}-day averages.
 *
 * A single reading at each end is noise — day-to-day weight swings on water and
 * gut content by more than a month of real change — so a "delta" built from two
 * lone readings reports the noise as the signal. Below twice the endpoint width
 * the two windows would OVERLAP and the delta would be partly a number minus
 * itself, so it is withheld and the latest reading stands on its own with the
 * reason stated.
 */
export function endpointDelta(series: SeriesPoint[]): {
  first: number | null;
  last: number | null;
  delta: number | null;
  latest: number | null;
} {
  if (series.length === 0) return { first: null, last: null, delta: null, latest: null };
  const latest = series[series.length - 1]!.value;
  if (series.length < BODY_ENDPOINT_DAYS * 2) {
    return { first: null, last: null, delta: null, latest };
  }
  const first = average(series.slice(0, BODY_ENDPOINT_DAYS).map((p) => p.value));
  const last = average(series.slice(-BODY_ENDPOINT_DAYS).map((p) => p.value));
  return {
    first,
    last,
    delta: first == null || last == null ? null : last - first,
    latest,
  };
}

/**
 * Body composition over any window — the self-review passes its period, the
 * doctor pack the last 90 days.
 */
export function assembleBodyOver(
  db: Database,
  start: string,
  end: string,
  rangeLabel: string
): BodySection {
  const units = getPreferences(db).units;
  const figures: Figure[] = [];
  for (const spec of BODY_SPECS) {
    const display = displayFor(spec.key, units);
    const decimals = display?.decimals ?? 1;
    const series = bodyDailySeries(db, spec.column, start, endOfDayUtc(end));
    const { first, last, latest } = endpointDelta(series);

    if (latest == null) {
      figures.push({
        label: spec.label,
        value: null,
        unit: display?.unit ?? null,
        note: 'Not recorded over this window.',
      });
      continue;
    }
    if (first == null || last == null) {
      figures.push({
        label: spec.label,
        value: toDisplay(display, latest),
        unit: display?.unit ?? null,
        note: `Latest of ${plural(series.length, 'reading')} — too few to state a change over this window.`,
      });
      continue;
    }
    const firstDisplay = display ? display.fromCanonical(first) : first;
    const lastDisplay = display ? display.fromCanonical(last) : last;
    figures.push({
      label: spec.label,
      value: num(lastDisplay, decimals),
      unit: display?.unit ?? null,
      note:
        `${signed(lastDisplay - firstDisplay, decimals)} on ` +
        `${num(firstDisplay, decimals)} at the start · ${plural(series.length, 'reading')}`,
    });
  }

  const anything = figures.some((f) => f.value !== null);
  return {
    title: 'Body composition',
    empty: anything ? null : 'Nothing weighed or measured over this window.',
    provenance: { sources: 'body_metrics', range: rangeLabel },
    figures,
    method:
      `Each figure is the average of the last ${count(BODY_ENDPOINT_DAYS)} recorded days of the ` +
      `window against the average of the first ${count(BODY_ENDPOINT_DAYS)} — single readings at ` +
      'each end are noise, not a trend.',
  };
}

/**
 * The symptom log over any window — grouped by name, with a severity range and
 * the dates it happened on.
 */
export function assembleSymptoms(
  db: Database,
  start: string,
  end: string,
  rangeLabel: string
): SymptomsSection {
  const rows = db.all<{ name: string; severity: number | null; date: string }>(
    `SELECT name, severity, date FROM symptoms
     WHERE date >= ? AND date <= ?
     ORDER BY name COLLATE NOCASE, date`,
    [start, end]
  );
  const provenance = { sources: 'symptoms', range: rangeLabel };
  if (rows.length === 0) {
    return {
      title: 'Symptoms',
      // Phrased as the good news it genuinely is (spec §3a.7) — not as a gap.
      empty: 'None logged.',
      provenance,
      headline: null,
      rows: [],
    };
  }

  const grouped = new Map<string, { severities: number[]; dates: string[] }>();
  for (const row of rows) {
    let entry = grouped.get(row.name);
    if (!entry) {
      entry = { severities: [], dates: [] };
      grouped.set(row.name, entry);
    }
    if (row.severity != null) entry.severities.push(row.severity);
    if (!entry.dates.includes(row.date)) entry.dates.push(row.date);
  }

  const out: SymptomRow[] = [...grouped.entries()]
    .sort((a, b) => b[1].dates.length - a[1].dates.length || (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => {
      const low = entry.severities.length > 0 ? Math.min(...entry.severities) : null;
      const high = entry.severities.length > 0 ? Math.max(...entry.severities) : null;
      return {
        name,
        count: entry.dates.length,
        severityRange:
          low == null || high == null
            ? EM_DASH
            : low === high
              ? `${count(low)}/10`
              : `${count(low)}–${count(high)}/10`,
        dates: namedThenCounted(entry.dates.map(formatDate), SYMPTOM_DATES_NAMED),
      };
    });

  return {
    title: 'Symptoms',
    empty: null,
    provenance,
    headline: `${plural(rows.length, 'entry', 'entries')} across ${plural(grouped.size, 'kind')}.`,
    rows: out,
  };
}
