# Reports — the self-review and the doctor-visit pack

**Status: BUILT — 2026-08-12.** Both report types ship, behind one screen, over one assembly layer, on migration **0039** (authored as 0036, renumbered at merge). The Data tab's row is now `Reports` with live state and a route; the "Later" chip is gone.

**What shipped:** `src/lib/reports/` (types · period · sections · two assemblers · `render-html` · `report-file` · `coach-read`) · `src/lib/db/repositories/reports.ts` · `src/components/reports/` (the native preview) · `app/reports.tsx` + `app/report-view.tsx` · `src/lib/files/share-file.ts` (the outcome ledger, now shared with export) · `db/migrations/0039_reports.sql`.

**Gate:** `db/reports.test.mjs` **136 assertions**, `db/screens-render.test.mjs` grew to **156** (the reports screens joined it), `npm run db:test` **2,430 assertions / 47 suites, 0 failed**, `db:validate` 20/20, `tsc` 0, `eslint app src` 0 errors, `npx expo export --platform ios` clean.

⚠️ **Headless-verified only — none of this has been seen on a device.** Two things ride the pending EAS build: the **share sheet** (`expo-sharing`; until then the file is written and the outcome is `saved` with its full path) and **PDF** (`expo-print`, added to `package.json` on the owner's call — ⚑ #1 below). The manual path is stated in the UI: open the HTML in Safari → Print → Save as PDF.

**Owner decisions (2026-08-12):** all six ⚑ questions in §11 were asked in one round at the start of the build and answered — every recommendation taken, plus `expo-print` on the next build. The table in §11 records each one and where it landed in the code.
**What this is NOT:** the whole-database JSON **export**, which already ships (2026-07-29, Settings › Security & data, `src/lib/export/serializer.ts`, 42 headless tests). A report is a *document assembled for a reader*; the export is *the data, all of it, for a machine or a migration*. They stay on different screens (§7).
**Read first:** `docs/labs-subapp.md` (spec-depth model) · `src/lib/export/serializer.ts` + `export-file.ts` (the file-outcome pattern reports clone) · `src/lib/ai/insights.ts` + `series.ts` + `stats.ts` (the deterministic seams the assembly composes).

---

## 1. What a report is — the doctrine applied to documents

ARC's standing rule — *deterministic code detects and grounds; the model decides; tools enact; the user confirms* — lands on paper as: **every number in a report is computed by deterministic, headless-tested code. The model may write prose, opt-in, clearly attributed, in exactly one place (§6a) — and never in the doctor pack.**

The honesty rules print too: **no data, no number** (an absent metric is an em-dash or an authored sentence, never a plausible figure); **empty is authored** (a section with nothing to say says why, or is absent by rule); **ledgers must sum** (the adherence table reconciles visibly and is asserted in tests).

**As built, the "fields in, marks out" rule is what carries all of this**, and it is worth stating as a rule you can check a diff against: the assembly layer is the ONLY arithmetic in the feature. Both renderers — `render-html.ts` and the native `src/components/reports/` — consume the same `ReportData` and neither contains an arithmetic operator, a `toFixed`, a `Math.`, or a date split. `null` is the only absence, and both renderers draw it as an em-dash. That is what makes "the preview and the file cannot disagree" structural rather than a promise two implementations both have to keep.

---

## 2. Formats — HTML file, native preview, PDF as a rider

**v1 ships one file format: a styled, fully self-contained HTML document** — inline CSS, no external assets, no scripts, an `@media print` stylesheet so Safari/Files → Print → Save-as-PDF produces a clean paged document. Filenames follow the export convention: `arc-report-self-review-20260812-143308.html`, `arc-report-doctor-20260812-143308.html`.

**The in-app preview is NOT a WebView — it is a native render of the same typed `ReportData`, drawn in Conformed Set blocks.** This is the load-bearing architectural move:

- `react-native-webview` never enters the build ledger — the preview is native. The one new native dep is **`expo-print`**, added on the owner's explicit call (⚑ #1, decided 2026-08-12) and recorded in the Known-caveats build ledger; it ships no config plugin, so it is deliberately absent from `app.json`. *(An earlier revision of this line claimed expo-print was not installed while §11 recorded adding it — the 2026-08-13 review caught the contradiction.)*
- The preview is first-class UI — folds, accessibility, the paper — not a browser embed.
- **The honesty guarantee "preview and file cannot disagree" is enforced structurally:** both renderers consume the same `ReportData` object, and **neither computes a number**. The HTML template contains formatting only; every figure is a field. ("Fields in, marks out" — the rule to check any render diff against.)

**PDF** rides a later EAS build via `expo-print`: `printToFileAsync({ html })` consumes the exact string `render-html.ts` already emits, so PDF is a one-function rider, not a rewrite (⚑ MATT #1 on whether it joins the next build). Until then, the share flow states the manual path plainly ("Open in Safari → Print → Save as PDF"). **What the doctor receives in v1:** an `.html` attachment — opens in any browser on any machine, prints correctly.

**Rejected:** Markdown/plain text (tables collapse in mail clients; a doctor pack that looks like source code) · PDF-first (blocks the feature on a build) · WebView preview (a dep purchased to display something the app draws natively) · CSV-as-report (that is an export shape — §7).

---

## 3. The two reports, section by section

### 3a. Periodic self-review (`self_review`)

**Period picker:** **Last week** (the previous *complete* Monday–Sunday — the same Monday-start rule as `weekSummary`) · **Last month** (previous calendar month) · **Custom range** (⚑ MATT #6 on capping at ~1 year). Defaulting to complete periods is itself an honesty device: the "accumulating metrics exclude today" rule goes moot because the period closes before today; a custom range including today excludes today from accumulating totals and says so in an authored note.

Every section has a specified absent-data state; a section with nothing to say prints its authored empty, never a zero.

| # | Section | Content · seams · absence behavior |
| --- | --- | --- |
| 1 | Header | Period, generated date, app version, and the coverage preamble: *"N of M days in this period carry at least one log."* |
| 2 | **Adherence ledger** | Per protocol active in the period (via `log_entries.protocol_id`): planned / completed / partial / skipped / **excused** / **unmarked** — excusal per-day via `accountForDay` against that day's `day_modes` row. **The ledger must sum** (`completed + partial + skipped + excused + unmarked = planned`), asserted in tests and visibly reconciled in the table; completion % over *accountable* items (planned − excused). Mode days named beneath: *"3 Travel days, 1 Sick day — skips on those days are excused, not missed."* Empty: "No protocol was active this period." |
| | ↳ **`unmarked` is a sixth column the spec's first draft did not have, and the schema forced it (built 2026-08-12).** `log_entries.status` is `pending \| completed \| skipped \| partial` (0001_init.sql), so a generated mission item the user never touched sits at `pending` forever, and the four-way split had nowhere to put it. Both ways of forcing it into four are fabrications: folding it into `completed` invents adherence, and folding it into `skipped` invents a decision the user never made — which would then be silently **excused** on a Travel day, inventing an excuse for it too. So it is its own column, it is in the denominator, and the report says what it is. Deciding not to record something is not the same as deciding not to do it. |
| | ↳ **The ledger clips to complete days.** Adherence ACCUMULATES through a day — items start `pending` and are answered as the day runs — so a custom range reaching today excludes today, exactly as training minutes and food logged do. Otherwise today's untouched 21:00 magnesium scores as an unmarked miss at 10am, worst on the range someone is most likely to generate. `todayNote` states the exclusion. |
| 3 | Training | Sessions, minutes, sets (`trainingDailyTotals`, `weekSummary` bounds); weekly muscle-group set volume vs the prior equal-length window (`weeklyMuscleSets`); e1RM per movement with ≥2 sessions in-period (`e1rmSeries`); PRs set in-period (`personalRecords`). Empty: "No sessions logged." |
| 4 | Nutrition vs targets | Days-logged vs days-in-period stated **first**; averages (kcal, protein) over *fully-logged days only* (the `remaining.ts` guard transplanted — a day with unpriced meals is excluded and the exclusion counted in prose); compared against `activeNutritionTargets` **of that era** — your target then, not today's. No targets → intake stated without judgment; no meals → authored empty. |
| 5 | Sleep & recovery | HRV, RHR, sleep, steps: period average vs prior equal-length window (`wearableArbitratedSeries` + `compareWindows`). A delta prints with a direction word **only when it clears the same significance bar `insights.ts` uses**; otherwise "within your normal variation." The report must not manufacture trends the Coach's own engine wouldn't fire. |
| 6 | Body composition | Weight: first-3-day average vs last-3-day average of the period (single-reading endpoints are noise), delta in display units; body-fat % and waist when present. Per-metric em-dash + authored line when absent. |
| 7 | Symptoms | Count, grouped by type with severity range and dates. Empty: "None logged" — phrased as the good news it genuinely is. |
| 8 | Experiments | Started / concluded / became-ready in the period: intervention, watched metrics, verdict where concluded. |
| 9 | New labs | **Only if** a `lab_reports.collected_at` falls in-period: markers measured, counts outside standard and outside optimal. Otherwise the section is absent entirely — labs are episodic, and a monthly "no labs" line is noise. |
| 10 | **What changed** | Protocol revisions (`protocol_versions` created in-period, with `change_notes`), target changes, the period's mode ledger. The section that makes this a *review* rather than a dashboard printout. |
| 11 | Coach's read | Optional, opt-in, key-gated, attributed — §6a. |

### 3b. Doctor-visit pack (`doctor_pack`)

**Point-in-time, as of today — not period-based.**

| # | Section | Content · absence behavior |
| --- | --- | --- |
| 1 | Patient header | Full name, DOB, biological sex, report date, "prepared from ARC personal health records." Missing profile fields print as authored blanks ("Not recorded — Settings › Profile") and the preview warns **before** generating. |
| 2 | **Current regimen** | Active protocols expanded through `getCurrentVersion`: supplements / medications / therapies with dose and schedule, grouped by type; per protocol, started + last-revised dates. The section a physician reads first, and the one ARC is uniquely positioned to print accurately. |
| 3 | Laboratory results | Grouped by biomarker category, **only markers with ≥1 result** — the doctor does not receive sixty em-dashes; the coverage line (*"23 of 65 tracked markers measured"*) carries the absence honestly. Per row: marker, latest value + unit, collected date, **standard reference range**, **ARC optimal range explicitly labeled "personal target — longevity-oriented, not a clinical range"** (⚑ MATT #2), trend arrow vs previous draw (≥2 results, both dates), flag when outside the standard range. |
| 4 | Vitals & recovery | Latest + 30-day average RHR, HRV, sleep duration, with source-device labels. **No blood pressure — ARC stores none** (verified: no column, no metric type). **No BMI — no height field exists.** The pack does not pretend otherwise. |
| 5 | Body composition | Weight, body-fat %, waist: latest + 90-day delta. |
| 6 | Preventive screenings | The ledger: each with last-done, next-due, overdue flag; upcoming appointments. |
| 7 | Symptom log | Last 90 days, grouped, dated, severity. |
| 8 | Provenance & disclaimer | Per section: data source(s) and date range. The standing disclaimer: personal records maintained by the patient, not a medical record; optimal ranges are personal reference lines, not diagnosis. |

**No model narrative in the doctor pack, ever.** The one document read by a clinician contains only numbers deterministic code produced — the surface where a hallucinated clause has the highest cost and zero upside.

---

## 4. Architecture

**As built:**

```
src/lib/reports/
  types.ts                  ReportMeta, SelfReviewData, DoctorPackData, Figure,
                            SectionProvenance — the single typed contract both
                            renderers and the persistence row consume
  period.ts                 pure period math: lastCompleteWeek (Mon-start),
                            lastCalendarMonth, custom-range validation + the
                            366-day cap, prior-equal-window, periodFromBounds
                            (route params → Period), accumulatingEnd, todayNote
  format.ts                 the ONLY formatting layer — em-dash, signed deltas,
                            one-sided ranges, minutes, thousands. Total by
                            construction: NaN/null/Infinity all read em-dash
  sections.ts               body composition + the symptom log, shared by both
                            reports over different windows, plus the disclaimer
  assemble-self-review.ts   assembleSelfReview(db, period, opts): SelfReviewData
  assemble-doctor-pack.ts   assembleDoctorPack(db, opts): DoctorPackData
  render-html.ts            renderReportHtml(data, read?): string — template
                            literals, inline CSS + @media print, Hermes-safe
                            (no Intl), ZERO computation, everything escaped
  report-file.ts            writeReportFile(...) → shared | saved | unavailable
                            | failed, into a reports/ subdirectory
  coach-read.ts             the one model surface: prompt, one no-tools turn,
                            the attribution rubric, and a doctor-pack refusal
src/lib/files/share-file.ts the outcome ledger, lifted out of export-file.ts
                            and now consumed by export AND reports
src/lib/db/repositories/reports.ts   insert · list · snapshot · narrative · delete
src/components/reports/     blocks.tsx (the drawing vocabulary) + preview.tsx
src/hooks/use-reports.ts    history + stored-report view models
app/reports.tsx             the screen (generate + history + the export pointer)
app/report-view.tsx         draft/persisted preview, the one accent, the footer
db/migrations/0039_reports.sql
db/reports.test.mjs         136 assertions
```

Three seams were **generalised in place** rather than copied into this module, which is what "composes, never re-derives" costs in practice: `weeklyMuscleSets` gained a range form (`muscleSetsInRange`) and now calls it; `listBiomarkerRanges` gained `standardLow`/`standardHigh` so the doctor pack can print the clinical range beside the personal one; and `insights.ts` exported `TREND_GATES`, which its own specs now read, so the report's significance bar IS the Coach's rather than a copy of it.

- **Assembly is pure over the `Database` interface** — headless-testable exactly like `db/export.test.mjs`. Every number traces to a seam that already has its own suite (`series.ts`, `stats.ts`, `weekSummary`, `training-stats.ts`, `dailyIntakeSeries` / `activeNutritionTargets`, `labs.ts`, `screenings.ts`, `protocols.ts`, `accountForDay`, `experiments.ts`); the assembly layer **composes, never re-derives**.
- **Named refactor, small:** lift `export-file.ts`'s guarded-require + write + share-attempt body into a shared `src/lib/files/share-file.ts`, consumed by export and reports both, so the outcome-ledger semantics are defined once. Export's public API and its 42 tests unchanged.
- **Testing the render: fixtures, not golden files.** Byte-golden HTML churns on every copy edit and says nothing when it fails. Instead: fixture `ReportData` objects (full / sparse / empty); key figures asserted **verbatim** in the output; authored empties asserted present; the cheap tripwires — no `undefined`, `NaN`, or `[object` anywhere in the rendered string; one determinism assertion (same input → identical bytes); and the adherence ledger-sums assertion on assembly output.

---

## 5. Persistence — a `reports` ledger, decided

A doctor pack you handed over is a record: *"what did the doctor see"* must be answerable forever, and deterministic regeneration drifts the moment a data correction lands (a re-imported lab, an edited meal). Reports follow the `lab_reports` precedent — **file + row**.

> ✅ **Shipped as `db/migrations/0039_reports.sql` — the file's third number.** Written as 0035 (main's head was 0034 at branch time), re-measured mid-build to 0036 when `0035_recipe_folders.sql` landed — and main outran that too, taking 0036 (progress photos), 0037 (freshness anchors) and 0038 (knowledge) before this merged, so it moved again at the 2026-08-13 integration. The lesson sharpened by repetition: the re-measure belongs at **merge** time, every time — a migration numbered at or below a device's `PRAGMA user_version` is skipped **silently**. `npm run db:bundle` after.

```sql
CREATE TABLE reports (
  id text PRIMARY KEY NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('self_review', 'doctor_pack')),
  period_start text,   -- NULL for doctor_pack
  period_end text,     -- NULL for doctor_pack
  generated_at text NOT NULL,
  file_name text NOT NULL,
  file_path text NOT NULL,          -- relative, Documents-based (export precedent)
  -- The full serialized ReportData — the reproducible snapshot (the
  -- raw_extracted_json role). History re-renders FROM THIS, never re-assembles.
  data_json text NOT NULL CHECK (json_valid(data_json)),
  -- The attributed model prose, when the user added it. Stored apart from
  -- data_json — the deterministic snapshot never carries model text.
  narrative_text text,
  app_version text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX reports_generated_idx ON reports (generated_at DESC);
-- + the standard updated_at trigger.
```

- History rows re-render preview **from `data_json`** — the stored report shows what was shared; "Share again" re-renders the HTML from the snapshot, re-creating the file even if the Documents copy is gone.
- All columns are scalars → the table **rides the existing whole-DB export automatically** (sqlite_master enumeration; `assertScalar` satisfied). Reports are themselves owned data.
- Delete removes the **row** (arm/confirm on the persisted report view). The file is deliberately left: `deleteReport`'s header argues it — a leftover HTML is a few regenerable kilobytes referenced by nothing, while touching disk would cost the repository its headless testability. *(This sentence promised a "best-effort file delete" no code implemented; re-trued 2026-08-13 when the delete UI landed.)* No history cap — rows are tens of KB.

---

## 6. The screen

**Data-tab change:** the row at `app/(tabs)/data.tsx` (`export` key) becomes `{ key: 'reports', label: 'Reports', chip: 'setup', onPress: → '/reports' }`. **The label drops "& export"** (⚑ MATT #4): the IA already places export in Settings; a row promising both would either duplicate the action or lie. The reports screen instead carries a **margin-annotation footer** pointing at export's real home — *"Raw data export — everything, as one JSON file — lives in Settings › Security & data"* — tappable, pushing Settings. A pointer, not a duplicate: the Data tab's standing critique is that nothing on it is a reading, and a persisted-report history **is** a reading (the row body carries live state: `2 reports · last 12 Aug`); a second export button is just another index entry.

**Layout (Conformed Set, top to bottom):** `StackHeader` "Reports" → **Generate** (one ruled plate, two rows: *Self-review — adherence, training, trends over a period* / *Doctor visit pack — labs, regimen, vitals, screenings, as of today*; neutral ink — the accent is spent inside the flow) → **Generated reports** (ruled plate, newest first: type, period/as-of, date; chevron → `report-view`; authored empty: *"Nothing generated yet. A report is a document — assembled from your data, previewed here, shared as a file."*) → the margin footer to Settings export.

**Generate flow:**

1. Tap a type. Self-review → period sheet (Last week / Last month / Custom, each choice printing its actual dates). Doctor pack → straight on (with the profile-blanks warning when applicable).
2. Assembly runs synchronously (op-sqlite reads, same-thread like export) → `report-view` in **draft** state: the full native render, foldable per section.
3. Draft footer: **"Save & share"** (the screen's one accent) · **"Add Coach's read"** (self-review only; key-gated — no key: disabled with "Add a key in Settings › Coach"). Adding it runs §6a and the prose appears **in the preview, attributed, before anything is saved**.
4. Save & share → persist the row + write the HTML via `report-file.ts` → the outcome ledger exactly like Settings export: `shared` (next build) / `saved` + full path (today) / `failed` loud.

### 6a. The Coach's read — the one model surface

Opt-in per report (⚑ MATT #5), self-review only. One **no-tools, key-gated** model turn whose entire context is the serialized deterministic `ReportData`; output stored in `narrative_text`; rendered under an explicit rubric: *"Coach's read — written by the model over the numbers above. Everything numeric in this report was computed by ARC, not the model."* Opt-in rather than default-on because a report must be complete and shareable with no key and no network — and because an auto-inserted model section blurs the deterministic document's boundary by default.

---

## 7. Reports vs export vs backup — the boundary, stated once

| Thing | What it is | Where it lives |
| --- | --- | --- |
| **Report** | A document assembled for a reader (you, or a physician) | Data › Reports (this spec) |
| **Export** | The entire database as one JSON file, machine-shaped, types intact | Settings › Security & data (shipped 2026-07-29) |
| **Backup** | The encrypted iCloud snapshot + restore | Settings, Phase 4 (unbuilt) |
| **"CSV later"** | Not a Reports concern: a `serializeTableCsv` over the same `readAllRows` output + a zip step, layered on the existing export serializer in Settings — `serializer.ts`'s own header reserves exactly this. The report's HTML tables satisfy the human-readable ask; CSV satisfies the machine-readable one; different screens. | Settings, later build |

---

## 8. Coach integration — a named blind spot, no tool in v1

`UNCOVERED_DOMAINS` (`src/lib/ai/tools/index.ts`) gains: **"generated reports and doctor-visit packs (Data › Reports)"** — the model routes the user to the screen instead of hallucinating the capability or denying the feature exists. Why no tool: the registry is billed every turn (~66–72% of the cached prefix); generation ends in a share sheet the model cannot drive and a preview-confirm the doctrine requires anyway; and every number a report contains is already reachable through existing read tools. Revisit (`get_report_history`, cheap, read-only) only if transcripts show the user asking the Coach about past reports — batched with the next registry change.

---

## 9. Degradation ledger

| Axis | Today's binary | Next EAS build | Later |
| --- | --- | --- | --- |
| File handoff | Written to Documents, `saved` + path shown | `expo-sharing` live → share sheet, `shared` | — |
| Format | Self-contained HTML (print CSS included; manual Safari→PDF path stated in UI) | ⚑ if `expo-print` joins: native "Save as PDF" from the same HTML string | PDF default for the doctor pack |
| Coach's read | Key present → available, attributed; no key → affordance disabled, report unaffected | same | — |
| Preview | Native, full-fidelity — no WebView, ever | same | — |
| No labs / incomplete profile | Doctor pack generates with authored empties + pre-generate warning | same | — |

---

## 10. Tests — `db/reports.test.mjs`

**Built: 136 assertions in eight sections, all green.** Migration applies over head; four CHECKs reject (unknown type, invalid JSON, half a period, a doctor pack carrying a period). `period.ts`: Monday-start last-complete-week — including on a Monday, where the naive answer is the two-hours-old one — calendar month across a leap February and a year boundary, prior-equal-window, and every custom-range rejection (reversed, future, past the cap, a date that does not exist), plus the range that ends *today* being allowed and MARKED. Assembly over full / sparse / empty databases: the adherence ledger **sums** on every row and in the totals; excused counts match the day's own mode, and Deload does not excuse; **today's `pending` items are not counted as unmarked**; nutrition averages exclude un-priced days per metric and count the exclusion; significance-gate parity asserted against `TREND_GATES` itself, with a flat window silent, a real move firing, and a halved average below the minimum staying silent; the labs section absent when no in-period draw and back when there is one; the self-review never carrying `full_name`; the doctor pack showing only measured markers plus the coverage line, and stating the no-BP/no-BMI absence. Render: key figures verbatim, authored empties present, no `undefined` / `NaN` / `[object` across all three fixtures, same input → identical bytes, and **markup in a protocol name escaped rather than injected**. Two independent assertions that no model prose reaches the doctor pack — one that a read passed in is *still* not rendered. Persistence: re-render from `data_json` is byte-identical to the original; `narrative_text` never appears in the blob; the table rides the whole-DB export with no new code. The screens joined `db/screens-render.test.mjs` (now 156), which renders both of them against the real migrations — including the Data tab, to pin the relabel.

---

## 11. ⚑ MATT — owner calls, all six DECIDED 2026-08-12

Asked as one batched round at the start of the build session; every recommendation was taken, and #1 was answered yes.

| # | The call | **Decided** | Where it lands in the code |
| --- | --- | --- | --- |
| 1 | `expo-print` on the next build? | **Yes — joins the next EAS build.** v1 still ships HTML either way; PDF becomes the one-function rider. | `package.json` (`expo-print ~57.0.1`) + the two-build ledger in `docs/project-status.md` Known caveats. **No `app.json` plugin entry** — `expo-print` ships no config plugin and needs no purpose string; naming it in `plugins` would fail prebuild. |
| 2 | Optimal ranges in the doctor pack? | **Include**, beside the clinical reference range, explicitly labeled *"personal target — longevity-oriented, not a clinical range"*. | `assemble-doctor-pack.ts` → `LabMarkerRow.optimalLow/High`; the label is authored once in `render-html.ts` and the native row. |
| 3 | The self-review and your name? | **Omit `full_name` by default.** The self-review is the report most casually shared; the doctor pack is unaffected and always carries the patient header. | `assembleSelfReview` never reads `users.full_name`. Asserted in `db/reports.test.mjs`. |
| 4 | The Data-row relabel? | **Relabel to "Reports"; export stays Settings-only**, with a margin footer pointing at its real home. | `app/(tabs)/data.tsx` (`reports` key, live state in the row body) + the footer on `app/reports.tsx`. |
| 5 | Coach's read: opt-in or default-on? | **Opt-in per report.** A report must be complete and shareable with no key and no network. | `app/report-view.tsx` draft footer; `narrative_text` stays NULL until asked for. |
| 6 | Custom range cap? | **Cap at ~1 year (366 days)**, so the prior-equal-window comparison stays meaningful. | `period.ts` → `validateCustomRange`, `MAX_CUSTOM_RANGE_DAYS`. |

---

## Related documents

- `docs/labs-subapp.md` — the spec-depth model; the lab data shapes §3b prints
- `src/lib/export/serializer.ts` + `src/lib/export/export-file.ts` — the export this feature is *not*, and the file-outcome pattern it clones
- `docs/information-architecture.md` — the reports-in-Data / export-in-Settings split
- `docs/ai-coach.md` — the coverage manifest and the deterministic-vs-model doctrine
- `docs/architecture-migration.md` §Phase 4 — the backup this feature is also not
