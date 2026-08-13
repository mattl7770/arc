/**
 * The single typed contract a report is — consumed by BOTH renderers (the
 * native preview in src/components/reports/ and `render-html.ts`) and stored
 * verbatim as `reports.data_json`.
 *
 * ## The load-bearing rule: fields in, marks out
 *
 * **Neither renderer computes a number.** Every figure that reaches a reader is
 * a field on this object, already rounded, already unit-converted, already
 * worded. A renderer places strings and draws rules; it never adds, divides,
 * rounds, compares or formats a date. That is what makes the honesty guarantee
 * "the preview and the file cannot disagree" STRUCTURAL rather than a promise
 * two implementations both have to keep — there is exactly one arithmetic
 * layer (`assemble-*.ts`) and it has one headless test suite
 * (db/reports.test.mjs).
 *
 * Check any diff against it: if a `.tsx` under src/components/reports/ or a
 * template literal in render-html.ts contains an arithmetic operator, a
 * `.toFixed`, a `Math.`, or a date split, the rule has been broken.
 *
 * The corollary is that **`null` is the only absence**. A missing figure is
 * `null`, never `0`, never `''`, never a placeholder string — the renderers
 * turn `null` into an em-dash, and a section with nothing to say carries an
 * authored `empty` sentence instead of rows (docs/reports-subapp.md §1).
 */

export type ReportType = 'self_review' | 'doctor_pack';

// --- Period -------------------------------------------------------------------

export type PeriodKind = 'last_week' | 'last_month' | 'custom';

/** A closed, inclusive `[start, end]` span of local calendar days. */
export type Period = {
  kind: PeriodKind;
  /** Inclusive first day, `YYYY-MM-DD`. */
  start: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  end: string;
  /** How the user picked it: "Last week", "Last month", "Custom range". */
  label: string;
  /** The actual dates, spelled out: "3 – 9 Aug 2026". */
  rangeLabel: string;
  /** Whole days in `[start, end]`, inclusive of both ends. */
  days: number;
  /**
   * True when the period runs up to (or past) today, which only a custom range
   * can do. Accumulating totals then exclude today and the report says so —
   * the "no data, no number" rule from the other direction (insights.ts's
   * `accNow`): a day still being written is not a day.
   */
  includesToday: boolean;
  /** The equal-length window immediately before `start` — the comparison base. */
  prior: { start: string; end: string; rangeLabel: string };
};

// --- Shared shapes ------------------------------------------------------------

/**
 * One measured line. `value` is ALREADY formatted for display (rounded, in the
 * user's units, with no unit suffix — that lives in `unit`); `null` means the
 * data does not exist and both renderers draw an em-dash.
 */
export type Figure = {
  label: string;
  value: string | null;
  /** Unit suffix, resolved against Settings › Units. Null when the value is unitless. */
  unit: string | null;
  /** One short line under the figure — a comparison, a count, a caveat. */
  note: string | null;
};

/**
 * Where a section's numbers came from and over what span — printed under the
 * doctor pack's sections, and carried on every self-review section so a reader
 * can always trace a figure back to a table.
 */
export type SectionProvenance = {
  /** The tables read: "log_entries + day_modes". */
  sources: string;
  /** The span actually read: "3 – 9 Aug 2026", "last 90 days". */
  range: string;
};

/** Every section carries the same two: an authored empty, or content. */
type SectionBase = {
  title: string;
  /**
   * The authored sentence to print INSTEAD of content when there is nothing to
   * say. Null when the section has content. Never both, never neither.
   */
  empty: string | null;
  provenance: SectionProvenance;
};

// --- Self-review sections -----------------------------------------------------

/**
 * One protocol's execution ledger for the period.
 *
 * **The invariant, asserted in db/reports.test.mjs:**
 * `completed + partial + skipped + excused + unmarked === planned`.
 *
 * `unmarked` is the column docs/reports-subapp.md's first draft did not have,
 * and the schema forced it: `log_entries.status` is
 * `pending | completed | skipped | partial` (0001_init.sql), so a generated
 * mission item the user never touched sits at `pending` forever. The spec's
 * four-way split had nowhere to put it, and both ways of forcing it into four
 * columns are fabrications — folding it into `completed` invents adherence,
 * folding it into `skipped` invents a decision the user never made (and would
 * then be silently EXCUSED on a Travel day, inventing an excuse for it too).
 * So it is its own column, it is in the denominator, and the report says what
 * it is. Deciding not to record something is not the same as deciding not to
 * do it, and a ledger that reconciles visibly has to show both.
 */
export type AdherenceRow = {
  protocolName: string;
  planned: number;
  completed: number;
  partial: number;
  skipped: number;
  /** Skips on a day whose mode excuses them (`accountForDay`). */
  excused: number;
  /** Items on a past day that were never marked either way. */
  unmarked: number;
  /** Completion over ACCOUNTABLE items (planned − excused), pre-formatted. */
  completionLabel: string | null;
};

export type AdherenceSection = SectionBase & {
  rows: AdherenceRow[];
  /** The all-protocols row. Present whenever `rows` is non-empty. */
  totals: AdherenceRow | null;
  /** "3 Travel days, 1 Sick day — skips on those days are excused, not missed." */
  modeNote: string | null;
  /** Names the reconciliation in words, so the table is readable as a ledger. */
  reconciliation: string | null;
};

export type MuscleVolumeRow = {
  muscle: string;
  /** Fractional weekly sets, pre-formatted ("18.5"). */
  sets: string;
  priorSets: string;
  /** "+4.0", "−2.5", or "—" when there is no prior figure to compare. */
  delta: string;
};

export type MovementRow = {
  exercise: string;
  sessions: number;
  /** Estimated 1RM at the period's first and last in-period session. */
  first: string;
  last: string;
  delta: string;
  unit: string;
};

export type TrainingSection = SectionBase & {
  headline: Figure[];
  muscles: MuscleVolumeRow[];
  /** Authored line when volume has no prior window to compare against. */
  musclesNote: string | null;
  movements: MovementRow[];
  /** "Deadlift — 182.5 kg estimated 1RM (3 Aug)". */
  personalRecords: string[];
};

export type NutritionSection = SectionBase & {
  /** Stated FIRST, before any average: "18 of 31 days logged." */
  coverageLine: string;
  figures: Figure[];
  /**
   * The exclusion, counted and named — the `remaining.ts` guard as prose. Null
   * when every logged day was fully priced.
   */
  exclusionNote: string | null;
  /** "Measured against your targets as of 31 Jul 2026." Null when none were set. */
  targetNote: string | null;
};

export type RecoveryRow = {
  metric: string;
  periodAvg: string | null;
  priorAvg: string | null;
  unit: string;
  /** Days with a reading in each window. */
  observations: string;
  /**
   * The verdict, and the ONLY place a direction word may appear. It carries a
   * signed change only when the comparison clears the same bar `insights.ts`
   * fires on (`TREND_GATES` + `compareWindows`); otherwise it reads "within
   * your normal variation". The report must not manufacture a trend the
   * Coach's own engine would stay silent about.
   */
  verdict: string;
  /** True only when the gate fired — lets a renderer weight the row. */
  significant: boolean;
};

export type RecoverySection = SectionBase & {
  rows: RecoveryRow[];
};

export type BodySection = SectionBase & {
  figures: Figure[];
  /** How the endpoints were taken, so a delta is never mistaken for two readings. */
  method: string;
};

export type SymptomRow = {
  name: string;
  count: number;
  /** "4–7", or "—" when no severity was ever recorded for this symptom. */
  severityRange: string;
  /** "3, 5, 9 Aug", truncated with a count past six days. */
  dates: string;
};

export type SymptomsSection = SectionBase & {
  headline: string | null;
  rows: SymptomRow[];
};

export type ExperimentRow = {
  title: string;
  /** 'Started' | 'Concluded' | 'Ready to read out' | 'Ran through'. */
  state: string;
  intervention: string;
  /** The watched metrics, joined. */
  metrics: string;
  window: string;
  /** The verdict where one exists. */
  conclusion: string | null;
};

export type ExperimentsSection = SectionBase & {
  rows: ExperimentRow[];
};

export type LabsInPeriodSection = SectionBase & {
  /** One line per draw: "12 Aug 2026 — 104 markers". */
  draws: string[];
  figures: Figure[];
  /** Markers outside their standard range, named. */
  outsideStandard: string[];
  /** Markers outside ARC's optimal range but inside the standard one. */
  outsideOptimal: string[];
};

export type ChangeRow = {
  /** 'Protocol' | 'Nutrition targets' | 'Mode'. */
  kind: string;
  what: string;
  when: string;
  /** The author's own note, where one was written. */
  note: string | null;
};

export type WhatChangedSection = SectionBase & {
  rows: ChangeRow[];
};

/**
 * The model's prose, when the user asked for it. Stored in `reports.narrative_text`
 * — deliberately APART from `data_json`, so the deterministic snapshot never
 * carries model text and a re-render of history cannot silently absorb it.
 */
export type CoachRead = {
  text: string;
  /** The attribution rubric, authored once (spec §6a) and rendered verbatim. */
  attribution: string;
  /** The model that wrote it, for the record. */
  model: string | null;
};

export type ReportMeta = {
  type: ReportType;
  /** The document's own title. */
  title: string;
  /** ISO-8601 instant the report was assembled. */
  generatedAt: string;
  /** "12 August 2026" — the same instant, pre-formatted. */
  generatedOn: string;
  appVersion: string | null;
  /** The standing disclaimer, authored once and printed on both report types. */
  disclaimer: string;
};

export type SelfReviewData = {
  kind: 'self_review';
  meta: ReportMeta;
  period: Period;
  /** "18 of 31 days in this period carry at least one log." */
  coverageLine: string;
  /** Present only for a custom range that runs up to today (spec §3a). */
  todayNote: string | null;
  adherence: AdherenceSection;
  training: TrainingSection;
  nutrition: NutritionSection;
  recovery: RecoverySection;
  body: BodySection;
  symptoms: SymptomsSection;
  experiments: ExperimentsSection;
  /**
   * Absent ENTIRELY (null, not an empty section) when no `lab_reports.collected_at`
   * falls in-period. Labs are episodic; a monthly "no labs" line is noise.
   */
  labs: LabsInPeriodSection | null;
  changed: WhatChangedSection;
};

// --- Doctor-pack sections -----------------------------------------------------

export type PatientHeader = {
  /** Each is either the recorded value or an authored blank — never invented. */
  fields: Figure[];
  /** True when any field is missing, so the screen can warn BEFORE generating. */
  incomplete: boolean;
  /** What is missing, named: "Full name, date of birth". Null when complete. */
  missing: string | null;
};

export type RegimenItem = {
  title: string;
  dose: string | null;
  schedule: string | null;
};

export type RegimenProtocol = {
  name: string;
  /** 'Supplement stack', 'Daily routine', … */
  type: string;
  started: string;
  lastRevised: string;
  version: string;
  items: RegimenItem[];
  /** Authored line when the protocol is active but has no version content yet. */
  note: string | null;
};

export type RegimenSection = SectionBase & {
  /** Grouped by protocol type, in a fixed clinical reading order. */
  groups: { type: string; protocols: RegimenProtocol[] }[];
};

export type LabMarkerRow = {
  name: string;
  value: string;
  unit: string;
  collected: string;
  /** The lab's own reference interval. "—" when the catalog holds none. */
  standardRange: string;
  /**
   * ARC's longevity-oriented target. Labeled in the render, never here — the
   * label is authored once so the two renderers cannot word it differently.
   * "—" when the catalog holds none.
   */
  optimalRange: string;
  /** '↑' | '↓' | '→' vs the previous draw, or "—" with fewer than two results. */
  trend: string;
  /** "from 92 on 2 Feb 2026", or null with fewer than two results. */
  trendNote: string | null;
  /** True when outside the STANDARD range — the only flag a clinician's eye needs. */
  outsideStandard: boolean;
};

export type LabsSection = SectionBase & {
  /** "23 of 65 tracked markers measured." — carries the absence honestly. */
  coverageLine: string;
  groups: { category: string; rows: LabMarkerRow[] }[];
  /** The authored label for the optimal-range column (⚑ MATT #2). */
  optimalRangeLabel: string;
};

export type VitalsRow = {
  metric: string;
  latest: string | null;
  latestOn: string | null;
  average30: string | null;
  unit: string;
  /** "Apple Health", "Oura" — a clinician needs to know what measured it. */
  source: string | null;
};

export type VitalsSection = SectionBase & {
  rows: VitalsRow[];
  /**
   * The two absences a physician WILL look for, stated rather than left blank.
   * ARC stores no blood pressure (no column, no metric type) and no height, so
   * no BMI. The pack does not pretend otherwise.
   */
  notMeasured: string;
};

export type ScreeningRow = {
  name: string;
  category: string;
  lastDone: string;
  nextDue: string;
  status: string;
  overdue: boolean;
};

export type ScreeningsSection = SectionBase & {
  rows: ScreeningRow[];
  upcoming: string[];
};

export type DoctorPackData = {
  kind: 'doctor_pack';
  meta: ReportMeta;
  /** Point-in-time, as of today — a doctor pack has no period. */
  asOf: string;
  patient: PatientHeader;
  regimen: RegimenSection;
  labs: LabsSection;
  vitals: VitalsSection;
  body: BodySection;
  screenings: ScreeningsSection;
  symptoms: SymptomsSection;
};

/** The union both renderers and the persistence row accept. */
export type ReportData = SelfReviewData | DoctorPackData;

/** Everything the assembly needs that is not in the database. */
export type AssembleOptions = {
  /** The clock. Injected so the headless tests are deterministic. */
  now?: Date;
  /** `Constants.expoConfig?.version` at the call site — keeps assembly pure. */
  appVersion?: string | null;
};
