/**
 * The doctor-visit pack, assembled (docs/reports-subapp.md §3b).
 *
 * Point-in-time, as of today — a pack has no period. Pure over the
 * {@link Database} interface for the same reason the self-review is:
 * db/reports.test.mjs runs the whole thing against node:sqlite.
 *
 * ## The one rule this file exists to keep
 *
 * **No model prose reaches this document, ever.** The self-review has exactly
 * one opt-in model surface (§6a); this one has none, and `DoctorPackData` has
 * no field a narrative could be written into. The surface where a hallucinated
 * clause has the highest cost is the one where it has zero upside — a physician
 * reading a sentence ARC generated, believing it came from the patient's own
 * records, is the worst outcome this feature can produce. Everything below is
 * arithmetic over stored rows.
 *
 * ## Two absences are STATED, not left blank
 *
 * ARC stores **no blood pressure** (no column, no `wearable_data.metric_type`)
 * and **no height**, therefore no BMI. Both are the first things a clinician
 * looks for and does not find, and a document that simply omits them invites
 * the reading "the patient does not track this" or, worse, a hunt through the
 * page. {@link assembleVitals} prints the absence as a sentence.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import { isoDatePlusDays, wearableArbitratedSeries } from '@/lib/ai/series';
import { listBiomarkerRanges } from '@/lib/db/repositories/biomarkers';
import { biomarkerSeries } from '@/lib/db/repositories/labs';
import { listProtocols, getCurrentVersion } from '@/lib/db/repositories/protocols';
import { listScreenings, upcomingAppointments } from '@/lib/db/repositories/screenings';
import { getOrCreateUser, getPreferences } from '@/lib/db/repositories/user';
import { deviceLabel, latestMetric } from '@/lib/db/repositories/wearables';
import { metricByKey, resolveDisplay } from '@/lib/log/metrics';
import type { ProtocolType } from '@/lib/db/types';
import { parseProtocolContent } from '@/lib/protocols/content';
import { cadenceLabel } from '@/lib/protocols/format';
import { phaseOn } from '@/lib/protocols/phase';

import {
  EM_DASH,
  average,
  count,
  minutes as fmtMinutes,
  namedThenCounted,
  num,
  plural,
  range as fmtRange,
  outsideRange,
} from './format';
import { formatDate, formatDateLong, formatRange } from './period';
import { REPORT_DISCLAIMER, assembleBodyOver, assembleSymptoms } from './sections';
import type {
  DoctorPackData,
  Figure,
  LabMarkerRow,
  LabsSection,
  PatientHeader,
  RegimenItem,
  RegimenProtocol,
  RegimenSection,
  ScreeningRow,
  ScreeningsSection,
  VitalsRow,
  VitalsSection,
  AssembleOptions,
} from './types';

/** The window the pack's rolling averages read. */
const VITALS_WINDOW_DAYS = 30;
/** The window body composition and the symptom log read. */
const HISTORY_WINDOW_DAYS = 90;

/**
 * ⚑ MATT #2, decided 2026-08-12: ARC's optimal ranges DO print beside the
 * clinical reference interval — labeled, once, here. Authored in one place so
 * the HTML and the native preview cannot word the caveat differently, and so
 * the label can never drift from the column it qualifies.
 */
export const OPTIMAL_RANGE_LABEL =
  'Personal target — longevity-oriented, set in ARC. Not a clinical reference range and not a diagnostic threshold.';

/** Sex as a clinician reads it, from the schema's own vocabulary. */
const SEX_LABELS: Record<string, string> = {
  male: 'Male',
  female: 'Female',
  intersex: 'Intersex',
  prefer_not_to_say: 'Not stated',
};

/** Protocol types in the order a physician reads them: what you take, then what you do. */
const REGIMEN_ORDER: { type: ProtocolType; label: string }[] = [
  { type: 'supplement_stack', label: 'Supplements' },
  { type: 'therapy_protocol', label: 'Therapies' },
  { type: 'daily_routine', label: 'Daily routines' },
  { type: 'training_block', label: 'Training' },
  { type: 'sleep_protocol', label: 'Sleep' },
  { type: 'meal_template', label: 'Nutrition' },
  { type: 'other', label: 'Other' },
];

// --- 1. Patient header --------------------------------------------------------

/**
 * Whole years between a date of birth and today — the one derivation a clinical
 * header genuinely needs, and one a reader would otherwise do by hand. Null for
 * an absent or unparseable DOB; never a guess.
 */
function ageInYears(dob: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  if (by == null || ty == null) return null;
  let years = ty - by;
  // Not yet had this year's birthday.
  if (tm! < bm! || (tm === bm && td! < bd!)) years -= 1;
  return years >= 0 && years < 150 ? years : null;
}

/**
 * The patient header, and what is missing from it.
 *
 * Exported so the generate screen can warn BEFORE assembling (spec §3b.1)
 * rather than after — a pack with three authored blanks in its header is a pack
 * you would rather have filled the profile in for first, and finding that out
 * on the preview is finding it out too late to be useful.
 */
export function assemblePatientHeader(db: Database, today: string): PatientHeader {
  const user = getOrCreateUser(db);
  const missing: string[] = [];
  const blank = (what: string) => {
    missing.push(what);
    return null;
  };

  const age = user.date_of_birth ? ageInYears(user.date_of_birth, today) : null;
  const fields: Figure[] = [
    {
      label: 'Name',
      value: user.full_name?.trim() ? user.full_name.trim() : blank('full name'),
      unit: null,
      note: user.full_name?.trim() ? null : 'Not recorded — Settings › Profile',
    },
    {
      label: 'Date of birth',
      value: user.date_of_birth ? formatDate(user.date_of_birth) : blank('date of birth'),
      unit: null,
      note: user.date_of_birth
        ? age == null
          ? null
          : `${plural(age, 'year')} old`
        : 'Not recorded — Settings › Profile',
    },
    {
      label: 'Biological sex',
      value: user.biological_sex ? (SEX_LABELS[user.biological_sex] ?? user.biological_sex) : blank('biological sex'),
      unit: null,
      note: user.biological_sex ? null : 'Not recorded — Settings › Profile',
    },
    { label: 'Report date', value: formatDateLong(today), unit: null, note: null },
    {
      label: 'Source',
      value: 'ARC personal health records',
      unit: null,
      note: 'Maintained by the patient on their own device.',
    },
  ];

  return {
    fields,
    incomplete: missing.length > 0,
    missing: missing.length > 0 ? namedThenCounted(missing, 3) : null,
  };
}

// --- 2. Current regimen -------------------------------------------------------

/**
 * What the protocol asks for TODAY, for a clinician's list.
 *
 * It reads the phase that is live on `today`, not the whole document: a
 * titration's loading phase is not what the patient is taking in week six, and
 * printing every phase's items together would hand a doctor two doses of the
 * same compound with nothing saying which one is current.
 *
 * `schedule` carries the CADENCE as well as the clock time, because "how often"
 * is the clinically load-bearing half — "400 mg" three times a week is a
 * different prescription from "400 mg" daily, and the old field could not say
 * which. Everything before content schema 2 normalises to `daily`, which is
 * what those items always were.
 *
 * `parseProtocolContent` is deliberately forgiving and never throws (see its
 * header), which is the property this needed from the hand-rolled reader it
 * replaces: a version written by an older build, by the Coach, or by a
 * hand-edited export can hold anything, and no shape of it may put `undefined`
 * into a clinician's medication list.
 */
function regimenItems(content: string, startedOn: string | null, today: string): RegimenItem[] {
  const parsed = parseProtocolContent(content);
  const state = phaseOn(parsed, startedOn ?? today, today);
  if (state.kind !== 'running') return [];
  return state.window.phase.items.map((item) => ({
    title: item.title.trim() === '' ? EM_DASH : item.title,
    dose: item.dose,
    schedule:
      item.scheduled_time === null
        ? cadenceLabel(item.cadence)
        : `${item.scheduled_time} · ${cadenceLabel(item.cadence)}`,
  }));
}

function assembleRegimen(db: Database, today: string): RegimenSection {
  const provenance = { sources: 'protocols · protocol_versions', range: `as of ${formatDate(today)}` };
  const active = listProtocols(db).filter((p) => p.isActive);
  if (active.length === 0) {
    return {
      title: 'Current regimen',
      empty: 'No protocol is currently active — nothing is being taken or followed on a schedule through ARC.',
      provenance,
      groups: [],
    };
  }

  const byType = new Map<ProtocolType, RegimenProtocol[]>();
  for (const protocol of active) {
    const version = getCurrentVersion(db, protocol.id);
    const items = version ? regimenItems(version.content, protocol.startedOn, today) : [];
    const started = db.get<{ createdAt: string }>(
      'SELECT created_at AS createdAt FROM protocols WHERE id = ?',
      [protocol.id]
    );
    // `started_on` is the day the protocol's plan began, which is what a
    // clinician means by "since when"; `created_at` is when the record was
    // typed, and it is the fallback for a protocol never anchored (0043).
    const startedDate = protocol.startedOn ?? started?.createdAt.slice(0, 10) ?? null;
    // "Active but ended" is a real state and a dangerous one to print silently:
    // a protocol past its last phase lists nothing, and a blank list under an
    // active heading reads as "takes nothing" rather than "this has finished".
    const ended =
      version !== undefined &&
      phaseOn(parseProtocolContent(version.content), startedDate ?? today, today).kind === 'ended';
    const entry: RegimenProtocol = {
      name: protocol.name,
      type: REGIMEN_ORDER.find((g) => g.type === protocol.type)?.label ?? 'Other',
      started: startedDate ? formatDate(startedDate) : EM_DASH,
      lastRevised: version ? formatDate(version.created_at.slice(0, 10)) : EM_DASH,
      version: version ? `v${count(version.version_number)}` : EM_DASH,
      items,
      note:
        version == null
          ? 'Active, but no version has been written yet — there is no content to list.'
          : ended
            ? 'Its course has finished — nothing from it is currently scheduled.'
            : items.length === 0
              ? 'Active, and its current phase lists no items.'
              : null,
    };
    const list = byType.get(protocol.type) ?? [];
    list.push(entry);
    byType.set(protocol.type, list);
  }

  const groups = REGIMEN_ORDER.filter((g) => (byType.get(g.type)?.length ?? 0) > 0).map((g) => ({
    type: g.label,
    protocols: byType.get(g.type)!,
  }));

  return { title: 'Current regimen', empty: null, provenance, groups };
}

// --- 3. Laboratory results ----------------------------------------------------

/**
 * Only markers with at least one result — the doctor does not receive sixty
 * em-dashes. The coverage line is what carries the absence honestly, and it is
 * the reason "only measured markers" is not a quiet omission.
 */
function assembleLabs(db: Database, today: string): LabsSection {
  const provenance = {
    sources: 'lab_results · biomarkers',
    range: `latest value per marker, as of ${formatDate(today)}`,
  };
  const catalog = listBiomarkerRanges(db);
  const measured = catalog.filter((b) => b.latestValue != null && b.latestAt != null);
  const coverageLine = `${count(measured.length)} of ${plural(catalog.length, 'tracked marker')} measured.`;

  if (measured.length === 0) {
    return {
      title: 'Laboratory results',
      empty:
        'No bloodwork has been imported into ARC yet, so this section has nothing to report. ' +
        `The catalogue tracks ${plural(catalog.length, 'marker')} and is waiting on a first draw.`,
      provenance,
      coverageLine,
      groups: [],
      optimalRangeLabel: OPTIMAL_RANGE_LABEL,
    };
  }

  const byCategory = new Map<string, LabMarkerRow[]>();
  for (const marker of measured) {
    // The full history for this marker, oldest first — the previous draw comes
    // from the same seam the trend chart reads, never from a second query.
    const series = biomarkerSeries(db, marker.slug);
    const latest = series[series.length - 1];
    const previous = series.length >= 2 ? series[series.length - 2] : undefined;
    const value = latest?.value ?? marker.latestValue!;

    let trend = EM_DASH;
    let trendNote: string | null = null;
    if (previous != null && latest != null) {
      // Draw the arrow from the values as they PRINT, not the raw ones. Two
      // draws that differ only below the 2nd decimal round to the same 2-dp
      // string, and "5.00 ↑ from 5.00" reads as a contradiction — an arrow
      // claiming a change beside two identical numbers. Compare the rounded
      // display strings, and quote the same rounded number in the note.
      const latestDisplay = num(latest.value, 2);
      const previousDisplay = num(previous.value, 2);
      trend =
        Number(latestDisplay) > Number(previousDisplay)
          ? '↑'
          : Number(latestDisplay) < Number(previousDisplay)
            ? '↓'
            : '→';
      trendNote = `from ${previousDisplay} on ${formatDate(previous.collectedAt)}`;
    }

    const row: LabMarkerRow = {
      name: marker.name,
      value: num(value, 2),
      unit: marker.unit,
      collected: formatDate(latest?.collectedAt ?? marker.latestAt!),
      standardRange: fmtRange(marker.standardLow, marker.standardHigh, 2),
      optimalRange: fmtRange(marker.optimalLow, marker.optimalHigh, 2),
      trend,
      trendNote,
      // `outsideRange` returns null when the catalogue holds no interval — "we
      // did not check" must never render as "inside the range".
      outsideStandard: outsideRange(value, marker.standardLow, marker.standardHigh) === true,
    };
    const list = byCategory.get(marker.category) ?? [];
    list.push(row);
    byCategory.set(marker.category, list);
  }

  // `listBiomarkerRanges` already returns its fixed clinical category order,
  // so first-seen insertion order IS that order — no second ranking to drift.
  const groups = [...byCategory.entries()].map(([category, rows]) => ({
    category: category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, ' '),
    rows,
  }));

  return {
    title: 'Laboratory results',
    empty: null,
    provenance,
    coverageLine,
    groups,
    optimalRangeLabel: OPTIMAL_RANGE_LABEL,
  };
}

// --- 4. Vitals & recovery -----------------------------------------------------

function assembleVitals(db: Database, today: string): VitalsSection {
  const units = getPreferences(db).units;
  const hrvSpec = metricByKey('hrv');
  const rhrSpec = metricByKey('rhr');
  const specs: {
    metricType: string;
    label: string;
    unit: string;
    format: (value: number) => string;
  }[] = [
    {
      metricType: 'rhr',
      label: 'Resting heart rate',
      unit: rhrSpec ? resolveDisplay(rhrSpec, units).unit : 'bpm',
      format: (v) => num(v, 0),
    },
    {
      metricType: 'hrv',
      label: 'Heart-rate variability',
      unit: hrvSpec ? resolveDisplay(hrvSpec, units).unit : 'ms',
      format: (v) => num(v, 0),
    },
    { metricType: 'sleep_duration_min', label: 'Sleep duration', unit: '', format: fmtMinutes },
  ];

  const since = isoDatePlusDays(today, -(VITALS_WINDOW_DAYS - 1));
  const rows: VitalsRow[] = [];
  for (const spec of specs) {
    // `latestMetric` selects max(date) with NO future-date clamp, while the
    // 30-day average below reads `wearableArbitratedSeries`, which closes its
    // window at `today`. A clock-skewed or mis-backdated row dated after today
    // would otherwise print as the clinician-facing "Latest" and "Taken" — a
    // reading taken in the future, and one the average already omits — so the
    // two columns of the same row would disagree on what counts as data. Drop
    // it here to mirror the average's clamp.
    const latestRaw = latestMetric(db, spec.metricType);
    const latest = latestRaw && latestRaw.date <= today ? latestRaw : null;
    const window = wearableArbitratedSeries(db, spec.metricType, since, today);
    const avg = average(window.map((p) => p.value));
    if (latest == null && avg == null) {
      rows.push({
        metric: spec.label,
        latest: null,
        latestOn: null,
        average30: null,
        unit: spec.unit,
        source: null,
      });
      continue;
    }
    rows.push({
      metric: spec.label,
      latest: latest ? spec.format(latest.value) : null,
      latestOn: latest ? formatDate(latest.date) : null,
      average30: avg == null ? null : spec.format(avg),
      unit: spec.unit,
      source: latest ? deviceLabel(latest.sourceDevice) : null,
    });
  }

  const anyData = rows.some((r) => r.latest != null || r.average30 != null);
  return {
    title: 'Vitals & recovery',
    empty: anyData
      ? null
      : 'No wearable or manually recorded vitals are held on this device.',
    provenance: {
      sources: 'wearable_data (source-arbitrated)',
      range: `latest reading, and the ${count(VITALS_WINDOW_DAYS)}-day average to ${formatDate(today)}`,
    },
    rows,
    // Stated, not left blank — see this file's header.
    notMeasured:
      'ARC does not record blood pressure: there is no field for it and no device writes one, ' +
      'so none is shown here and none should be inferred. It also holds no height, and therefore ' +
      'reports no BMI. Both would need to be taken at the visit.',
  };
}

// --- 6. Preventive screenings -------------------------------------------------

function assembleScreenings(db: Database, today: string): ScreeningsSection {
  const provenance = { sources: 'screenings · appointments', range: `as of ${formatDate(today)}` };
  const screenings = listScreenings(db);
  const upcoming = upcomingAppointments(db, `${today}T00:00:00.000Z`).map((a) => {
    const on = formatDate(a.scheduled_at.slice(0, 10));
    const who = a.provider ? ` · ${a.provider}` : '';
    const forWhat = a.screening_name ? ` (${a.screening_name})` : '';
    return `${on} — ${a.title}${forWhat}${who}`;
  });

  if (screenings.length === 0 && upcoming.length === 0) {
    return {
      title: 'Preventive screenings',
      empty: 'No preventive screenings or appointments are tracked in ARC.',
      provenance,
      rows: [],
      upcoming: [],
    };
  }

  const rows: ScreeningRow[] = screenings.map((s) => {
    const overdue = s.next_due != null && s.next_due < today;
    return {
      name: s.name,
      category: s.category.charAt(0).toUpperCase() + s.category.slice(1),
      lastDone: s.last_completed ? formatDate(s.last_completed) : 'Never recorded',
      nextDue: s.next_due ? formatDate(s.next_due) : 'Not scheduled',
      status: overdue ? 'Overdue' : s.next_due ? 'Due' : 'Untracked',
      overdue,
    };
  });

  return { title: 'Preventive screenings', empty: null, provenance, rows, upcoming };
}

// --- The assembly ------------------------------------------------------------

export function assembleDoctorPack(db: Database, options: AssembleOptions = {}): DoctorPackData {
  const now = options.now ?? new Date();
  const today = todayISODate(now);
  const historyStart = isoDatePlusDays(today, -(HISTORY_WINDOW_DAYS - 1));
  const historyLabel = formatRange(historyStart, today);

  return {
    kind: 'doctor_pack',
    meta: {
      type: 'doctor_pack',
      title: 'Doctor visit pack',
      generatedAt: now.toISOString(),
      generatedOn: formatDateLong(today),
      appVersion: options.appVersion ?? null,
      disclaimer: REPORT_DISCLAIMER,
    },
    asOf: formatDateLong(today),
    patient: assemblePatientHeader(db, today),
    regimen: assembleRegimen(db, today),
    labs: assembleLabs(db, today),
    vitals: assembleVitals(db, today),
    body: assembleBodyOver(db, historyStart, today, `last ${count(HISTORY_WINDOW_DAYS)} days · ${historyLabel}`),
    screenings: assembleScreenings(db, today),
    symptoms: assembleSymptoms(
      db,
      historyStart,
      today,
      `last ${count(HISTORY_WINDOW_DAYS)} days · ${historyLabel}`
    ),
  };
}
