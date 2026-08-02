# Labs sub-app — Function Health PDF → structured biomarkers

**Status:** Built. Pick → parse → editable review → confirm is real end to end; the parse needs a model key, everything else is offline. Migration **0024** (biomarker categories) + a 12 → **65** marker catalog. `npm run db:test` labs **107**.
**Last updated:** 2026-07-29
**Mission:** turn the PDF Function Health hands back after a draw into trustworthy rows on ARC's own trend lines — without ever storing a number the user hasn't looked at.

> **Why this is the first data domain.** CLAUDE.md §4 ranks Labs #1, and the Data tab has shipped its reference ranges since 2026-07-26 with nothing to grade against them. This is the pipeline that fills them in.

---

## 1. What the research established (Phase 0)

Web-backed sweep, July 2026, plus an adversarial pass over every number before it shipped. Full sources at the end of §1. The conclusions that actually changed the design:

### The document

- **Function's lab partner is Quest Diagnostics, exclusively.** Function is not a lab; it coordinates draws at Quest sites.
- **A membership year is ~160 tests, but a single report is not.** ~100–110 markers at the annual draw plus ~60 re-tested at the 3–6 month follow-up. Real reviewer dashboards read 109, 114, 130. **So a valid follow-up report may carry only ~60 rows** — the pipeline must never validate "success" against an expected count.
- **~21 of those are urinalysis**, and many are **not numeric**: `Urine Color: Yellow`, `Appearance: Clear`, `Protein: Negative`. Around a sixth of a full panel is words, not numbers. A schema typed `value: number` either fails on them or coerces `Negative` to 0.
- **Units are US conventional** (mg/dL, ng/mL, %, U/L), not SI.
- **⚠️ The single largest unknown: nobody could confirm what the PDF actually looks like.** Every source describing the rich, health-area-grouped, optimal-range presentation is describing the **web dashboard**. The only sources touching the *file* describe it minimally, and one importer pointedly demands "the raw PDF from Function's documents portal, not a screenshot" — which reads like a **Quest-issued CLIA report**: no health-area grouping, no Function optimal tier, no biological age, Quest's own ALL-CAPS nomenclature. functionhealth.com returns 403 to automated fetchers and no sample PDF is public.
  **Design consequence:** the extraction prompt is written to be **layout-agnostic** — semantic instructions ("find every row with a marker name and a result"), never positional ones. It should work on either document. **The single highest-value next step is running it against one of Matt's real PDFs**; one real document settles more than any further research.

### The parsing hazards that shaped the code

| Hazard | What it would do | How this pipeline answers it |
| --- | --- | --- |
| **Prior-result columns** printed beside the current draw | Ingests a two-year-old value as today's. Looks completely plausible; never caught by a range check. | Prompt: "Use the CURRENT draw only… if you cannot tell which column is current, omit that marker and say so." |
| **AI-written clinician narrative** quoting markers inline ("Your ApoB of 92 is above optimal") | Phantom result rows with plausible numbers | Prompt: "Extract ONLY from result rows and tables… that prose is never a result." |
| **Names that are substrings of each other** — Testosterone / Testosterone, Free; CRP / hs-CRP; Iron / Total Iron Binding Capacity; T3 / Free T3 / Reverse T3 | Free testosterone (~18 pg/mL) stored as total (~620 ng/dL) | **Exact matching only. Fuzzy matching is banned** (§3) |
| **Same marker in several health areas** (DHEA-S appears under Male Hormones *and* Stress & Aging) | Duplicate rows; `UNIQUE(report_id, biomarker_id)` aborts the whole import | Mapper flags `duplicate`, review excludes it by default (§3) |
| **CBC differential**: every cell type reports a **percentage and an absolute** — two rows, one name | One of the two silently dropped as a dupe | `%` and `#` survive normalization; `"Neutrophils #"` slugifies to `neutrophils_abs` |
| **Censored results** — `<5`, `>150` | `null` (data loss) or `5` (silently wrong). An Lp(a) of `<10` is an excellent result that must not vanish. | Bound stored as the value, `qualifier` carried to review so it renders `< 5` |
| **Flag letters merged into values** — `92H`, `4.1L` | A value that won't parse, or 921 | Prompt strips them explicitly |
| **Three dates** — collected / received / reported, weeks apart | Trend smeared by up to three weeks against wearables and daily logs | Prompt pins the **collected** date; `validCollectedOn` rejects impossible and future dates |
| **US MM/DD/YYYY** source format | 07/08 vs 08/07 — silent, unrecoverable | Prompt states the source format and demands ISO output |
| **Layout drift between releases** | A prompt tuned to one layout rots | Semantic instructions only |
| **Micro sign**: `µ` (U+00B5) vs `μ` (U+03BC) vs `u` | Unit comparison fails at random depending on the PDF's text layer | All three normalize to `u`, in names and units (§3) |

### Microbiome: not a thing here

Function is **blood and urine only** — no stool/microbiome assay, standard or add-on. The trap: Function *does* have a "Gut" health area whose marketing copy discusses the microbiome at length, attached to blood-based markers. A model reading that could hallucinate taxa results. **No microbiome branch exists in this parser.** (The enum value still lands in 0024 — see §2.)

### Biological age: real, but maybe not in the file

Function computes a **Phenotypic-Age-style composite from standard lab chemistry** (albumin, creatinine, glucose, MCV…), explicitly *not* an epigenetic clock, reported in years with a decimal (e.g. 37.3). Verified in the dashboard; **unverified in the PDF**, and certainly absent if the PDF is Quest-issued. Treated as optional — its absence is never an error.

**Sources:** functionhealth.com (faq, what-we-test, how-it-works, biomarker-categories/{biological-age,heart,gut,metabolic,brain-health}, lab-locations); en.wikipedia.org/wiki/Function_Health; help.empirical.health; health3.app/import/function-health; tailored-health.com; bloodtestcomparison.com/function-health{,/biomarkers}; healnourishgrow.com; dannb.org/blog/2025/function-health; mygenefood.com; optimizebiomarkers.com; seebeyondmedicine.com; time.com/7176591.

---

## 2. Data model — the 0001 tables suffice

**Confirmed: `biomarkers`, `lab_reports`, and `lab_results` (all from 0001) carry this pipeline with no new tables.** They were designed for it — `lab_reports.raw_extracted_json` exists precisely "so a parser improvement can be replayed without re-uploading," and `file_path` for "a local / iCloud file, referenced." Both are used exactly that way.

**One migration: `0024_biomarker_categories.sql`** — widens `biomarkers.category` by two values.

| Added | Why |
| --- | --- |
| `biological_age` | Function prints a composite biological age; today's 11-value enum has nowhere to put a years-valued marker. |
| `microbiome` | **Not** from Function (§1). It lands now because `docs/project-status.md` tracks it as the "Lab breadth" gap, and because widening this enum is expensive: it is a **parent-table rebuild** (below). Doing both in one rebuild means never paying that cost again for it. |

Everything else on a comprehensive US panel maps onto the existing vocabulary: liver/kidney/urinalysis → `organ`, thyroid and sex hormones → `hormone`, heavy metals → `toxin`, electrolytes → `metabolic`. Splitting `organ` into liver/kidney would be a UX call, not a data gap — deliberately not done.

### Why the migration shuttles child rows (and why the obvious approaches don't work)

SQLite cannot `ALTER` a `CHECK`, so the table must be rebuilt. The textbook recipe — "turn `PRAGMA foreign_keys` off, rebuild, turn it back on" — **is unavailable here**: the migration runner wraps each migration in a transaction, and `PRAGMA foreign_keys` is a documented no-op inside one. `biomarkers` is a parent (`lab_results.biomarker_id … ON DELETE RESTRICT`), and with enforcement stuck on, `DROP TABLE` fires an implicit `DELETE` of every parent row that RESTRICT rejects the moment one child row exists.

Three approaches were tried against real SQLite 3.51 before the shipped one:

1. **`PRAGMA legacy_alter_table = ON`, rename the old table aside.** ❌ The pragma takes effect, but SQLite rewrites a child's `REFERENCES` clause on rename whenever `foreign_keys` is ON, *regardless* of `legacy_alter_table`. `lab_results` ends up pointing at `biomarkers_old`, and dropping that fails exactly as before.
2. **`PRAGMA defer_foreign_keys = ON`** — which, unlike `foreign_keys`, *is* honored inside a transaction. ❌ **and it is a trap**: every statement succeeds, including the DROP, and then **COMMIT** fails with `FOREIGN KEY constraint failed`. The deferred-violation counter incremented by the implicit DELETE is never decremented by inserting the same ids into a *different* table. A subsequent `PRAGMA foreign_key_check` reports clean, so the failure looks inexplicable. The runner's ROLLBACK is what saves the database.
3. **Shuttle the children out and back.** ✅ With `lab_results` momentarily empty, `biomarkers` has no children and the implicit DELETE violates nothing.

Verified end to end in `db/labs.test.mjs` §11–12, including the real upgrade path — migrate to 0020, plant a report and results, *then* apply 0024 — asserting rows, ids, original `created_at`, the FK, RESTRICT, the `updated_at` trigger, the recreated index, and a clean `PRAGMA foreign_key_check`.

> **If you ever rebuild `biomarkers` again:** as of 0023 `lab_results` is its only child. Adding another child table means shuttling that one too.

### What is deliberately *not* stored

- **The reported unit**, when it differs from the catalog's. Values are stored canonical; the verbatim extraction in `raw_extracted_json` is the provenance record. (0001's own design intent.)
- **Qualitative results.** `lab_results.value` is `real NOT NULL`. The ~20 word-valued urinalysis rows are extracted, surfaced in review ("N results were reported in words…"), and kept in `raw_extracted_json` — but not charted. Making them first-class is a future migration, tracked in §7.
- **A `lab_report_import` table.** Considered and rejected: `raw_extracted_json` + `parsed_at` + `file_path` already carry provenance, and mapping decisions are reproducible from the raw extraction.

---

## 3. Mapping — the layer that refuses to guess

`src/lib/labs/map.ts` decides what a printed name *means*. Its whole design follows from one observation: **the dangerous failure is not a visibly wrong number, it's a plausible one filed under the wrong marker.** Nobody audits a trend line that looks fine.

**Rule 1 — exact matching only; fuzzy matching is banned.** A name matches a known alias exactly, after normalization, or it does not match at all. No substring, prefix, or edit-distance step exists. On a panel where `Testosterone` is a substring of `Testosterone, Free` and `CRP` of `hs-CRP`, similarity scoring is a coin flip, and the losing side stores an ~18 pg/mL number against a marker graded in ng/dL.

Matching order: the catalog's own names → the catalog's slugs → the curated alias table (610 entries). A name two markers both claim is **dropped**, not arbitrated.

Three alias decisions worth knowing, each verified by test:

- A bare **`CRP` → its own `crp` slug, never `hs_crp`.** Panels that ran the high-sensitivity assay sometimes print only "CRP". Unmatched-and-visible beats matched-and-wrong.
- A bare **`T3`/`T4` → total, never free.** The two differ ~400× in molar terms — a wrong guess is not a near miss.
- **Slugs with no catalog row are kept.** Canonicalizing an unknown marker means `Reverse T3` and `rT3` create *one* new biomarker, and a later seed addition adopts values already imported.

**Rule 2 — a specimen word makes it a different analyte.** `urine`, `urinary`, `saliva`, `stool`, `csf`, `hair` in the name blocks any catalog match. Urine creatinine (mg/dL, ~145) and serum creatinine (mg/dL, ~1.0) share a unit string and differ ~100×. *Accepted cost:* the guard runs before the alias lookup, so a genuinely urine-specific alias (urine albumin/creatinine ratio) is bypassed too and becomes its own slugified marker rather than a canonical one. Values still land; only the slug is less tidy.

**Rule 2b — a spelling is not a conversion.** `mcg` ≡ `ug`, and `K/uL` ≡ `10*3/uL` ≡ `x10E3/uL` ≡ `10^3/uL`. These fold in `normalizeUnit` because they name an *identical* quantity — without it, US labs' ordinary spellings would read as unit conflicts and five seeded CBC markers could never import at all.

**Rule 3 — normalization is ordered and conservative.** NFKC → micro-sign fold → zero-width/soft-hyphen strip → a **small end-anchored allowlist** of safe suffixes (`, Serum`, `, Plasma`) → punctuation to **space** (never to nothing — deleting it merges tokens and manufactures false matches). The tokens that carry identity — *free, total, direct, indirect, ionized, bioavailable* — are **never** stripped. `%` and `#` survive, because on a CBC differential they are the only thing separating percent from absolute.

**Rule 4 — unit conversion is an allowlist, and refusing is a valid outcome.** Two tiers: *universal* pairs (pure decimal-prefix and volume changes, plus true identities like ng/mL ≡ ug/L) that hold for any analyte, and *analyte-specific* mass↔molar factors keyed by slug, each recomputed from molecular weight and independently re-verified. Anything unlisted is **refused** — the row reaches review as a `unit_conflict`, blocked from import, with the printed number intact.

Deliberate refusals:

| Pair | Why no factor exists |
| --- | --- |
| **Lp(a) nmol/L ↔ mg/dL** | nmol/L counts apo(a) particles; mg/dL measures mass. The apo(a) protein varies in size between individuals — no constant relates them. |
| **Insulin uIU/mL ↔ pmol/L** | Standard-dependent (6.0 vs 6.945, ~16% apart). Picking one silently biases every converted insulin value. |
| **HbA1c % ↔ mmol/mol** | Affine, not multiplicative: `(NGSP − 2.15) × 10.929`. Cannot be expressed as a factor at all. |
| **g/dL ↔ mg/dL** (removed from the universal tier) | A lab reporting "albumin" in mg/dL is reporting **urine microalbumin** — different specimen, ~1000× lower. A working conversion would invite ingesting it as serum albumin. |
| **mEq/L → mmol/L** (kept out of the universal tier) | Valence-dependent: 0.5 for calcium and magnesium, 1:1 for sodium and potassium. There is no universal factor. |

**Five mapped statuses**, which drive both the review UI and the default include state:

| Status | Meaning | Default |
| --- | --- | --- |
| `matched` | Catalog hit, units agree | ☑ on |
| `converted` | Catalog hit, value converted into the catalog's unit | ☑ on |
| `new` | No catalog hit — import creates the biomarker | ☑ on |
| `unit_conflict` | Catalog hit, but the value can't be trusted into the catalog's unit — either the printed unit differs with no known conversion, **or the report printed no unit at all** (assuming the catalog's is the one guess nothing downstream would ever show) | ☐ **blocked** |
| `duplicate` | An earlier **importable** row already claimed this slug | ☐ off |

Three subtleties that took an adversarial pass to surface, all now regression-tested:

- **The value and unit are resolved before the status is.** A `duplicate` or `unit_conflict` row used to carry the *printed* number labelled with the *catalog's* unit — importable, and wrong.
- **Only an importable row claims a slug.** A blocked `unit_conflict` used to claim it anyway, demoting a later perfectly good copy of the same marker to a `duplicate` that was off by default.
- **The final slug is looked up, not just the matched name.** `Neutrophils #` matches no name but slugifies onto the seeded `neutrophils_abs`. Calling that `new` skipped unit checking here — and then `ensureBiomarker` resolves by slug at import, so the value landed against the existing marker anyway, unconverted.

Because the repository cannot dedupe for the caller (`UNIQUE(report_id, biomarker_id)` aborts the whole import instead), the review screen keeps **at most one included row per biomarker**: switching a repeat on switches its sibling off.

---

## 4. The flow

```
app/labs.tsx  ── "Import a report" ──▶  app/lab-import.tsx
                                          │
   pick PDF (offline) ────────────────────┤  File.pickFileAsync → file.base64()
   parse  (ONLINE — the only step) ───────┤  runCoachTurn, document block, no tools
   map    (offline) ──────────────────────┤  mapExtraction against the catalog
   REVIEW (offline) ──────────────────────┤  every row, editable, nothing committed
   commit (offline) ──────────────────────┘  importLabReport, one transaction
```

**Nothing is stored until Save.** Same discipline as `app/meal-estimate.tsx`, for the same reason — and here the stakes are higher, because a lab value is a permanent point on a decades-long series.

The review shows, per row: the catalog name, the printed name when it differs, the status, the value (editable), the unit, and — for a converted row — what was actually printed. A `unit_conflict` explains itself in one of two ways — units that don't convert, or *no unit printed at all* (which names the catalog's unit and says plainly that assuming it would be a guess) — and can't be switched on either way. Because a blocked row keeps the **printed** unit, `MappedResult` carries `catalogUnit` alongside `unit` so that sentence can name both without contradicting itself; the unit column falls back to an em dash rather than rendering blank. The draw date is editable and validated (`YYYY-MM-DD`, not in the future); when the report didn't yield one, the screen says so and blocks saving until it's supplied. A second report on the same draw date raises a warning rather than a block — sometimes there genuinely are two.

**Key gating.** The parse is the one online step, so the screen is gated on `useSessionKeySet()` and shows an honest "add a key in Settings › Coach" state — the same key and the same model picker the Coach uses, via the same `runCoachTurn`. No second model stack exists.

**Model-call specifics.** The PDF rides as a base64 `document` content block (the Messages API reads PDFs natively — no client-side PDF library, no OCR), placed before the instruction text. `max_tokens` is **32000**, far above the Coach's chat-sized 8192: a full panel is 100+ markers and, on the default model, thinking shares that same budget. The client always streams, which is what makes a cap that large safe from HTTP timeouts. A `max_tokens` stop is treated as a **failure**, not a partial success — a truncated reply would parse into a partial panel that looks complete.

**Privacy.** The PDF leaves the device, and it carries the user's name and DOB. This is stated plainly on the screen before the pick. It is consistent with the 2026-07-24 ADR — offline-except-AI — and with the Coach, which already sends health context; the file is sent in-flight to the user's own model provider under the user's own key, and nothing personal is left at rest in any cloud.

### Native dependency: none added

The brief anticipated `expo-document-picker`. **It isn't needed.** `expo-file-system@57` provides both halves — `File.pickFileAsync` opens the iOS document picker and `file.base64()` reads the bytes — and it is a dependency of **`expo` itself**, so it is already autolinked into the existing dev build. This slice therefore needs **no new native module and no extra EAS rebuild**; it was added to `package.json` explicitly (`~57.0.1`, the already-resolved version) only because the code imports it directly rather than relying on a transitive dep.

It is still native, so it is reached through a guarded `require` — the same pattern as `api-key-store` and the nutrition estimator's streaming fetch. On the web logic-check preview, `isPdfPickerAvailable()` returns false and the button disables with an honest note instead of crashing.

---

## 5. Storage

`importLabReport` (`src/lib/db/repositories/labs.ts`) writes the whole confirmed panel in **one transaction**: the `lab_reports` row (`source='function_pdf'`, `parsed_at` stamped, `raw_extracted_json` and `file_path` kept), any biomarkers the report introduced, then every value as `lab_results` (`source='function_pdf'`). A partial import is worse than none — half a panel is a trend with an invisible hole — so anything that throws rolls all of it back.

`ensureBiomarker` uses `INSERT OR IGNORE` then `SELECT`, arbitrated by the unique slug. **An existing biomarker is never modified**: its unit and optimal range are ARC's curated reference data, and a lab's printed range must not overwrite them. New markers are created with the lab's printed range as `standard_range_*` and no optimal range.

Deleting a report CASCADEs to the values parsed out of it, leaves manual entries (`report_id` NULL) untouched, and **keeps** any biomarkers it introduced — they're catalog data now.

---

## 6. The catalog: 12 → 65

`src/lib/labs/catalog.ts` holds the seeded biomarkers, the alias table, and the conversion tables. Ranges are longevity-oriented — deliberately tighter than a lab's population "normal" — and were adversarially reviewed for unit errors, inverted direction, and false precision before shipping. They are reference lines in a personal tool, **not diagnosis or treatment**.

Two load-bearing conventions:

- **The 12 originally seeded slugs keep their originally seeded values**, byte-identically. `seedReferenceData` inserts `OR IGNORE`, so an existing row is never updated — changing a value here would only change *fresh installs*, silently making them disagree with a device that has been running since before this file. Correcting one of the 12 is a deliberate migration, not an edit. (Newer research would tighten ApoB to 60 and LDL-C to 80; both were left at 80/100 for exactly this reason.)
- **Sex-specific ranges are male-oriented** — testosterone, estradiol, ferritin, hemoglobin, hematocrit, RBC, creatinine, ALT, AST, GGT, uric acid, SHBG, iron, DHEA-S, PSA. ARC is single-user and its user is male. Per-sex ranges would be a schema change, not a data edit.

`higherIsBetter` is `null` on 46 of 65. Most markers are U-shaped — harmful at *both* extremes (ferritin, vitamin D, TSH, sodium, testosterone, IGF-1) — and marking one `1` would have the app telling the user "more is better" about something that hurts them high. A test asserts this for the known U-shaped set.

Corrections applied from the adversarial review: SHBG/AST/iron flagged sex-specific; free testosterone's ceiling pulled from 25 to 21 pg/mL (it sat *above* the reference ceiling its own rationale cited); TIBC's "optimal" band dropped entirely (it was the reference range minus 50, encoding no signal); eGFR's unit de-Unicode'd to `mL/min/1.73m2`.

---

## 7. Flags, limits, and what's next

**Verify before trusting:**
- ⚠️ **No real Function PDF has been through this.** The prompt is layout-agnostic and defensive, but §1's central unknown stands. Run one of Matt's real reports through it and diff the output by hand — that is the highest-value next action on this pipeline, and it may adjust the prompt.
- ⚠️ **The picker is unexercised on device.** `expo-file-system`'s native module ships with `expo` and should already be in the dev build, but `File.pickFileAsync` has not been run on a phone from this code.

**Deliberate limits:**
- **Qualitative results aren't charted** (~20 rows on a full panel). Extracted, counted in review, preserved in `raw_extracted_json`; a `lab_results.value_text` column would make them first-class.
- **No plausible-range gate.** The alias research suggests a per-marker physiologic band as a third check (a "ferritin" of 300 with unit ug/dL is really serum iron). Exact matching makes mis-matches rare enough that this wasn't worth the curated data; the review screen is the backstop.
- **Same-unit, different-measurand pairs are undetectable** — venous plasma vs capillary/CGM glucose differ ~11% in identical units. Nothing in the file distinguishes them.
- **`file_path` points at a cache copy.** iOS's picker returns a temporary copy; the OS may reclaim it. Best-effort provenance until Phase 4 gives media a durable home — `raw_extracted_json` is the reliable record meanwhile.
- **No re-import dedupe**, only a same-date warning. Deleting the duplicate report is the remedy.

**Follow-ups worth doing:**
- Surface lab values on the Data tab's trend rows and in Home's readiness — the values now exist.
- The Coach's `get_biomarkers` tool already reads `biomarkers ⋈ lab_results`, so it lights up for free; `log_labs` (docs/ai-coach.md §2d) was blocked on "the Function PDF pipeline defines the dedupe rules" — it now does: slug-resolved, one value per biomarker per report.
- Replay: a "re-parse from stored extraction" path, which the raw JSON already makes possible.

**Integrator-merge points:** `app/_layout.tsx` (the `lab-import` route), `package.json` (`db:test` gains `db/labs.test.mjs`; `expo-file-system` declared), `src/lib/db/migrations.generated.ts` (regenerated for 0024), `src/lib/db/types.ts` (`BiomarkerCategory` widened in lockstep with 0024), and `db/data-body-biomarkers.test.mjs` (its 12-row snapshot assertions became catalog-sized invariants).

---

## Related documents

- `CLAUDE.md` — §4 data domains, §7 Function Health, §9 database conventions
- `docs/project-status.md` — the living tracker
- `docs/ai-coach.md` — the model client and `runCoachTurn`, the seam this reuses
- `docs/nutrition-subapp.md` — §6, the estimate → editable review pattern this mirrors
- `docs/data-model.md` · `db/migrations/0001_init.sql` — the three tables this fills
- `docs/decisions.md` — the 2026-07-24 local-first / offline-except-AI ADR
