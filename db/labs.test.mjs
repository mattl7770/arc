/**
 * Headless test of the labs pipeline against real SQLite via node:sqlite — the
 * pure parse/map logic over a CAPTURED model reply (never a live model call),
 * the import repository, and migration 0024's parent-table rebuild.
 *
 * The fixture is a hand-written stand-in for a Function Health / Quest report,
 * built to carry the failure modes the research found in real ones: names that
 * are substrings of each other, a unit that needs converting, a unit that must
 * NOT be converted, a marker ARC doesn't ship, a repeated marker, censored
 * "<" results, word-valued urinalysis rows, and a flag letter stuck to a value.
 *
 * Mirrors db/barcode.test.mjs. Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import { applyConnectionPragmas } from '../src/lib/db/pragmas.ts';
import { listBiomarkerRanges } from '../src/lib/db/repositories/biomarkers.ts';
import { seedReferenceData } from '../src/lib/db/seed.ts';
import {
  biomarkerSeries,
  deleteLabReport,
  listLabReportDates,
  importLabReport,
  listLabReports,
} from '../src/lib/db/repositories/labs.ts';
import { BIOMARKER_ALIASES, BIOMARKER_SEED } from '../src/lib/labs/catalog.ts';
import {
  buildLabParseRequest,
  LAB_EXTRACTION_SYSTEM_PROMPT,
  isolateJsonObject,
  parseLabExtraction,
  validCollectedOn,
} from '../src/lib/labs/parse.ts';
import {
  convertUnit,
  defaultIncluded,
  isImportable,
  mapExtraction,
  normalizeBiomarkerName,
  normalizeUnit,
  slugifyBiomarker,
} from '../src/lib/labs/map.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};
const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) < eps;

function makeDb(raw) {
  return {
    run: (sql, params = []) => {
      raw.prepare(sql).run(...params);
    },
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function freshDb({ seed = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  // Same helper the app connection uses, so FK enforcement here mirrors device.
  applyConnectionPragmas((sql) => raw.exec(sql));
  const db = makeDb(raw);
  migrate(
    {
      exec: (sql) => raw.exec(sql),
      getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
      transaction: db.transaction,
    },
    MIGRATIONS
  );
  if (seed) seedReferenceData(db);
  return { raw, db };
}

const TODAY = '2026-07-29';

/** A captured model reply, as text — exactly what runCoachTurn would stream. */
const CAPTURED_REPLY = `Here are the results:
\`\`\`json
{
  "collected_on": "2026-07-14",
  "lab_name": "Quest Diagnostics",
  "results": [
    {"name": "Apolipoprotein B", "value": 72, "value_text": null, "unit": "mg/dL",
     "qualifier": null, "ref_low": null, "ref_high": 90, "category": "cardiovascular"},
    {"name": "Hemoglobin A1c", "value": 5.2, "value_text": null, "unit": "%",
     "qualifier": null, "ref_low": null, "ref_high": 5.7, "category": "metabolic"},
    {"name": "Glucose", "value": 88, "value_text": null, "unit": "mg/dL",
     "qualifier": null, "ref_low": 65, "ref_high": 99, "category": "metabolic"},
    {"name": "Vitamin D, 25-Hydroxy", "value": 120, "value_text": null, "unit": "nmol/L",
     "qualifier": null, "ref_low": 75, "ref_high": 250, "category": "nutrient"},
    {"name": "Lipoprotein (a)", "value": 14, "value_text": null, "unit": "mg/dL",
     "qualifier": null, "ref_low": null, "ref_high": 30, "category": "cardiovascular"},
    {"name": "Testosterone, Free", "value": 18.2, "value_text": null, "unit": "pg/mL",
     "qualifier": null, "ref_low": 6.8, "ref_high": 21.5, "category": "hormone"},
    {"name": "Testosterone, Total", "value": 620, "value_text": null, "unit": "ng/dL",
     "qualifier": null, "ref_low": 264, "ref_high": 916, "category": "hormone"},
    {"name": "hs-CRP", "value": 0.4, "value_text": null, "unit": "mg/L",
     "qualifier": "<", "ref_low": null, "ref_high": 3, "category": "inflammation"},
    {"name": "Selenium", "value": 132, "value_text": null, "unit": "ug/L",
     "qualifier": null, "ref_low": 63, "ref_high": 160, "category": "nutrient"},
    {"name": "DHEA-Sulfate", "value": 310, "value_text": null, "unit": "ug/dL",
     "qualifier": null, "ref_low": 106, "ref_high": 464, "category": "hormone"},
    {"name": "DHEA-Sulfate", "value": 310, "value_text": null, "unit": "ug/dL",
     "qualifier": null, "ref_low": 106, "ref_high": 464, "category": "hormone"},
    {"name": "Urine Color", "value": null, "value_text": "Yellow", "unit": null,
     "qualifier": null, "ref_low": null, "ref_high": null, "category": "organ"},
    {"name": "Urine Protein", "value": null, "value_text": "Negative", "unit": null,
     "qualifier": null, "ref_low": null, "ref_high": null, "category": "organ"},
    {"name": "Pending Marker", "value": null, "value_text": null, "unit": "mg/dL",
     "qualifier": null, "ref_low": null, "ref_high": null, "category": "other"}
  ],
  "notes": "Page 7 was faint; two markers were skipped."
}
\`\`\``;

console.log('1. parseLabExtraction over a captured reply');
{
  const x = parseLabExtraction(CAPTURED_REPLY, TODAY);
  x.collectedOn === '2026-07-14' && x.labName === 'Quest Diagnostics'
    ? ok('draw date + lab name parsed out of a fenced reply')
    : bad('header', JSON.stringify({ d: x.collectedOn, l: x.labName }));
  x.results.length === 11
    ? ok('11 numeric results (word-valued and value-less rows excluded)')
    : bad('result count', String(x.results.length));
  x.qualitative.length === 2 && x.qualitative[0].text === 'Yellow'
    ? ok('word-valued rows land in `qualitative`, not dropped silently')
    : bad('qualitative', JSON.stringify(x.qualitative));
  !x.results.some((r) => r.name === 'Pending Marker')
    ? ok('a row with neither a number nor words is dropped')
    : bad('pending row kept');
  x.results.find((r) => r.name === 'hs-CRP')?.qualifier === '<'
    ? ok('a censored "<" result keeps its qualifier for review')
    : bad('qualifier');
  x.notes === 'Page 7 was faint; two markers were skipped.'
    ? ok('model notes carried through to review')
    : bad('notes', x.notes);
}

console.log('2. parseLabExtraction refuses what it cannot trust');
{
  const throws = (label, text) => {
    try {
      parseLabExtraction(text, TODAY);
      bad(label + ' should throw');
    } catch {
      ok(label);
    }
  };
  throws('no JSON object → throws', 'I could not read that document.');
  throws('malformed JSON → throws', '{"results": [');
  throws('zero usable results → throws (never commits an empty report)', '{"results": []}');

  // A truncated/garbled date must not reach a NOT NULL date column.
  const noDate = parseLabExtraction(
    '{"collected_on":"2026-02-30","results":[{"name":"ApoB","value":72,"category":"cardiovascular"}]}',
    TODAY
  );
  noDate.collectedOn === null
    ? ok('an impossible calendar date (Feb 30) becomes null, not a stored date')
    : bad('bad date accepted', noDate.collectedOn);
  validCollectedOn('2027-01-01', TODAY) === null
    ? ok('a future draw date is rejected')
    : bad('future date accepted');
  validCollectedOn('1899-12-31', TODAY) === null
    ? ok('a pre-1900 date is rejected (misread year)')
    : bad('ancient date accepted');
  validCollectedOn('2026-07-14', TODAY) === '2026-07-14'
    ? ok('a real past date is kept')
    : bad('good date rejected');

  // A transposed reference range would trip the schema's low <= high CHECK.
  const flipped = parseLabExtraction(
    '{"results":[{"name":"X","value":1,"ref_low":10,"ref_high":2,"category":"other"}]}',
    TODAY
  );
  flipped.results[0].refLow === null && flipped.results[0].refHigh === null
    ? ok('a transposed ref range is dropped, not stored (schema CHECK would reject)')
    : bad('flipped range kept');
}

console.log('2b. What gets PERSISTED is valid JSON, not the reply text');
{
  // lab_reports.raw_extracted_json is CHECK (json_valid(...)). Storing the reply
  // verbatim would abort the whole import the moment the model wrapped its
  // answer in a ```json fence or a sentence — which is most of the time.
  const isolated = isolateJsonObject(CAPTURED_REPLY);
  let parses = false;
  try {
    JSON.parse(isolated);
    parses = true;
  } catch {
    /* parses stays false */
  }
  parses && isolated.startsWith('{') && isolated.endsWith('}')
    ? ok('isolateJsonObject strips the fence and prose, leaving parseable JSON')
    : bad('isolate', isolated.slice(0, 60));

  // Prove it against the real column, not just JSON.parse.
  const { db, raw } = freshDb();
  const outcome = importLabReport(db, {
    collectedOn: '2026-07-14',
    labName: null,
    filePath: null,
    rawJson: isolated,
    notes: null,
    results: [
      {
        slug: 'apob',
        name: 'ApoB',
        category: 'cardiovascular',
        unit: 'mg/dL',
        value: 72,
        standardLow: null,
        standardHigh: null,
      },
    ],
  });
  raw
    .prepare('SELECT json_valid(raw_extracted_json) v FROM lab_reports WHERE id = ?')
    .get(outcome.reportId).v === 1
    ? ok('...and SQLite’s json_valid CHECK accepts it')
    : bad('json_valid rejected the stored extraction');

  // The regression itself: the raw reply must NOT be storable.
  let rejected = false;
  try {
    importLabReport(db, {
      collectedOn: '2026-07-15',
      labName: null,
      filePath: null,
      rawJson: CAPTURED_REPLY,
      notes: null,
      results: [
        {
          slug: 'apob',
          name: 'ApoB',
          category: 'cardiovascular',
          unit: 'mg/dL',
          value: 72,
          standardLow: null,
          standardHigh: null,
        },
      ],
    });
  } catch {
    rejected = true;
  }
  rejected
    ? ok('storing the fenced reply verbatim is rejected — which is why we isolate')
    : bad('a non-JSON raw_extracted_json was accepted');
}

console.log('3. buildLabParseRequest puts the PDF before the instruction');
{
  const req = buildLabParseRequest('JVBERi0xLjQ=');
  const blocks = req.messages[0].content;
  blocks[0].type === 'document' &&
  blocks[0].source.media_type === 'application/pdf' &&
  blocks[0].source.data === 'JVBERi0xLjQ=' &&
  blocks[1].type === 'text'
    ? ok('document block first, then text (per the document-understanding docs)')
    : bad('request shape', JSON.stringify(blocks.map((b) => b.type)));
  req.system === LAB_EXTRACTION_SYSTEM_PROMPT
    ? ok('carries the extraction system prompt')
    : bad('system prompt');
  /ONLY from result rows/.test(req.system)
    ? ok('prompt forbids extracting from narrative prose')
    : bad('prompt missing the narrative guard');
  /COLLECTED date/.test(req.system)
    ? ok('prompt pins the draw date over the report date')
    : bad('prompt missing the date guard');
}

console.log('4. Name normalization survives what PDF text layers emit');
{
  normalizeBiomarkerName('Apolipoprotein B') === 'apolipoprotein b'
    ? ok('lowercases and collapses')
    : bad('basic normalize');
  normalizeBiomarkerName('Vitamin D, 25-Hydroxy') === 'vitamin d 25 hydroxy'
    ? ok('punctuation becomes SPACE (never empty — that would merge tokens)')
    : bad('punct', normalizeBiomarkerName('Vitamin D, 25-Hydroxy'));
  normalizeBiomarkerName('Hemo­globin') === 'hemoglobin'
    ? ok('soft hyphen injected mid-word is stripped')
    : bad('soft hyphen', normalizeBiomarkerName('Hemo­globin'));
  // U+00B5 MICRO SIGN and U+03BC GREEK SMALL MU must land on the same key.
  normalizeBiomarkerName('µmol test') === normalizeBiomarkerName('μmol test') &&
  normalizeBiomarkerName('µmol test') === 'umol test'
    ? ok('both micro codepoints normalize to "u"')
    : bad('micro sign', normalizeBiomarkerName('µmol test'));
  normalizeBiomarkerName('Ferritin, Serum') === 'ferritin'
    ? ok('a safe trailing qualifier (", Serum") is stripped')
    : bad('suffix strip', normalizeBiomarkerName('Ferritin, Serum'));
  normalizeBiomarkerName('Testosterone, Free') === 'testosterone free'
    ? ok('an identity-carrying qualifier ("Free") is NEVER stripped')
    : bad('free stripped!', normalizeBiomarkerName('Testosterone, Free'));
  normalizeBiomarkerName('Neutrophils %') !== normalizeBiomarkerName('Neutrophils #')
    ? ok('% and # are kept — they are all that separates percent from absolute')
    : bad('pct/abs collapsed');
  slugifyBiomarker('Neutrophils #') === 'neutrophils_abs'
    ? ok('"Neutrophils #" slugifies onto the canonical neutrophils_abs')
    : bad('slugify abs', slugifyBiomarker('Neutrophils #'));
  slugifyBiomarker('Urine Color') === 'urine_color'
    ? ok('an unknown marker gets a stable snake_case slug')
    : bad('slugify', slugifyBiomarker('Urine Color'));
  slugifyBiomarker('!!!') === 'unnamed_marker'
    ? ok('a nameless row still yields a valid slug')
    : bad('slug fallback', slugifyBiomarker('!!!'));
}

console.log('5. convertUnit is an allowlist — it refuses what it does not know');
{
  near(convertUnit('vitamin_d', 120, 'nmol/L', 'ng/mL'), 48.0768, 1e-3)
    ? ok('vitamin D 120 nmol/L → 48.1 ng/mL (analyte-specific molar factor)')
    : bad('vitD convert', String(convertUnit('vitamin_d', 120, 'nmol/L', 'ng/mL')));
  near(convertUnit('anything', 5, 'mg/dL', 'mg/L'), 50)
    ? ok('mg/dL → mg/L applies to any analyte (pure prefix change)')
    : bad('universal convert');
  near(convertUnit('selenium', 132, 'ug/L', 'ng/mL'), 132)
    ? ok('ug/L ≡ ng/mL is an identity, not an approximation')
    : bad('identity convert');
  convertUnit('lp_a', 14, 'mg/dL', 'nmol/L') === null
    ? ok('Lp(a) mg/dL → nmol/L REFUSED (mass vs particle count — no valid factor)')
    : bad('lp(a) converted!', String(convertUnit('lp_a', 14, 'mg/dL', 'nmol/L')));
  convertUnit('fasting_insulin', 10, 'uIU/mL', 'pmol/L') === null
    ? ok('insulin uIU/mL → pmol/L REFUSED (standard-dependent, ~16% divergence)')
    : bad('insulin converted!');
  convertUnit('albumin', 4.5, 'g/dL', 'mg/dL') === null
    ? ok('albumin g/dL → mg/dL REFUSED (mg/dL albumin is urine microalbumin)')
    : bad('albumin converted!');
  near(convertUnit('x', 7, 'mg/dL', 'mg/dL'), 7)
    ? ok('identical units pass through untouched')
    : bad('same-unit');
  normalizeUnit('µIU/mL') === 'uiu/ml' && normalizeUnit('uIU/mL') === 'uiu/ml'
    ? ok('unit comparison is micro-sign and case insensitive')
    : bad('unit normalize', normalizeUnit('µIU/mL'));
}

console.log('6. mapExtraction against the seeded catalog');
{
  const { db } = freshDb();
  const extraction = parseLabExtraction(CAPTURED_REPLY, TODAY);
  const rows = mapExtraction(db, extraction);
  const by = (name) => rows.find((r) => r.printedName === name);

  rows.length === extraction.results.length
    ? ok('every extracted row comes back mapped (nothing silently vanishes)')
    : bad('row count', String(rows.length));

  by('Apolipoprotein B')?.status === 'matched' && by('Apolipoprotein B')?.slug === 'apob'
    ? ok('"Apolipoprotein B" → apob via the alias table')
    : bad('apob map', JSON.stringify(by('Apolipoprotein B')));

  by('Hemoglobin A1c')?.slug === 'hba1c'
    ? ok('"Hemoglobin A1c" → hba1c')
    : bad('hba1c map', by('Hemoglobin A1c')?.slug);

  const vitD = by('Vitamin D, 25-Hydroxy');
  vitD?.status === 'converted' && near(vitD.value, 48.0768, 1e-3) && vitD.unit === 'ng/mL'
    ? ok('vitamin D converted into the catalog unit and stored canonical')
    : bad('vitD map', JSON.stringify(vitD));
  near(vitD.reportedValue, 120) && vitD.reportedUnit === 'nmol/L'
    ? ok('...while the printed value/unit stay visible for review')
    : bad('vitD provenance');

  const lpa = by('Lipoprotein (a)');
  lpa?.status === 'unit_conflict' && !isImportable(lpa) && !defaultIncluded(lpa)
    ? ok('Lp(a) in mg/dL is a UNIT CONFLICT — blocked, and off by default')
    : bad('lp(a) not blocked', JSON.stringify(lpa));
  near(lpa.value, 14)
    ? ok('...and the blocked row keeps the printed number (never a fake conversion)')
    : bad('lp(a) value mangled');

  // The single most dangerous confusion on the panel.
  by('Testosterone, Free')?.slug === 'testosterone_free' &&
  by('Testosterone, Total')?.slug === 'testosterone_total'
    ? ok('free vs total testosterone resolve to DIFFERENT markers')
    : bad(
        'testosterone collision',
        JSON.stringify([by('Testosterone, Free')?.slug, by('Testosterone, Total')?.slug])
      );

  const sel = by('Selenium');
  sel?.status === 'new' && sel.slug === 'selenium' && sel.biomarkerId === null
    ? ok('an unseeded marker (Selenium) becomes a NEW catalog entry, not a dropped value')
    : bad('new marker', JSON.stringify(sel));

  const dupes = rows.filter((r) => r.slug === 'dhea_s');
  dupes.length === 2 && dupes[1].status === 'duplicate' && !defaultIncluded(dupes[1])
    ? ok('a marker repeated across sections is flagged duplicate and excluded by default')
    : bad('duplicate handling', JSON.stringify(dupes.map((d) => d.status)));
  defaultIncluded(dupes[0])
    ? ok('...while its first occurrence still imports')
    : bad('first dupe excluded');

  by('Glucose')?.slug === 'fasting_glucose'
    ? ok('"Glucose" on a fasting panel → fasting_glucose')
    : bad('glucose map', by('Glucose')?.slug);
}

console.log('6b. Units the same in fact but spelled differently still import');
{
  const { db } = freshDb();
  const rows = mapExtraction(db, {
    collectedOn: TODAY,
    labName: null,
    qualitative: [],
    notes: null,
    results: [
      // US labs print mcg constantly where the catalog says ug.
      {
        name: 'Zinc',
        value: 95,
        qualifier: null,
        unit: 'mcg/dL',
        refLow: null,
        refHigh: null,
        category: 'nutrient',
      },
      // ...and the CBC counts have at least four spellings of one unit.
      {
        name: 'Platelets',
        value: 240,
        qualifier: null,
        unit: 'K/uL',
        refLow: null,
        refHigh: null,
        category: 'hematology',
      },
      {
        name: 'RBC',
        value: 5.1,
        qualifier: null,
        unit: 'x10E6/uL',
        refLow: null,
        refHigh: null,
        category: 'hematology',
      },
    ],
  });
  rows.every((r) => r.status === 'matched')
    ? ok('mcg/dL, K/uL and x10E6/uL are recognized as the catalog’s own units')
    : bad('spelling fold', JSON.stringify(rows.map((r) => `${r.slug}:${r.status}`)));
  rows.every((r) => r.value === r.reportedValue)
    ? ok('...and the value is untouched (a spelling is not a conversion)')
    : bad('value changed by a spelling fold');
}

console.log('6c. A generated slug that hits the catalog is treated as a match');
{
  // "Neutrophils #" resolves by NAME to nothing, but slugifies onto the seeded
  // `neutrophils_abs`. Calling that "new" would skip unit checking here and then
  // file the value against the existing marker anyway at import time.
  const { db } = freshDb();
  const rows = mapExtraction(db, {
    collectedOn: TODAY,
    labName: null,
    qualitative: [],
    notes: null,
    results: [
      {
        name: 'Neutrophils #',
        value: 3.2,
        qualifier: null,
        unit: '10^3/uL',
        refLow: null,
        refHigh: null,
        category: 'immune',
      },
    ],
  });
  rows[0].slug === 'neutrophils_abs' && rows[0].status === 'matched' && rows[0].biomarkerId !== null
    ? ok('a slug-only hit is `matched`, not a phantom `new` marker')
    : bad('slug-only hit', JSON.stringify(rows[0]));
}

console.log('6d. A blocked row never carries the catalog unit with the printed number');
{
  const { db } = freshDb();
  const rows = mapExtraction(db, {
    collectedOn: TODAY,
    labName: null,
    qualitative: [],
    notes: null,
    results: [
      // Lp(a) mg/dL can't convert to the catalog's nmol/L...
      {
        name: 'Lipoprotein (a)',
        value: 14,
        qualifier: null,
        unit: 'mg/dL',
        refLow: null,
        refHigh: null,
        category: 'cardiovascular',
      },
      // ...and a second, convertible copy must still be importable, not demoted
      // to a duplicate by the blocked row having claimed the slug.
      {
        name: 'Lp(a)',
        value: 40,
        qualifier: null,
        unit: 'nmol/L',
        refLow: null,
        refHigh: null,
        category: 'cardiovascular',
      },
    ],
  });
  rows[0].status === 'unit_conflict' && rows[0].value === 14
    ? ok('the blocked row keeps the printed number')
    : bad('blocked row', JSON.stringify(rows[0]));
  rows[1].status === 'matched' && defaultIncluded(rows[1])
    ? ok('a blocked row does not demote a later importable copy to a duplicate')
    : bad('slug claimed by a blocked row', JSON.stringify(rows[1]));
}

console.log('7. A urine marker never folds into its serum namesake');
{
  const { db } = freshDb();
  const rows = mapExtraction(db, {
    collectedOn: TODAY,
    labName: null,
    qualitative: [],
    notes: null,
    results: [
      {
        name: 'Creatinine',
        value: 1.0,
        qualifier: null,
        unit: 'mg/dL',
        refLow: null,
        refHigh: null,
        category: 'organ',
      },
      {
        name: 'Urine Creatinine',
        value: 145,
        qualifier: null,
        unit: 'mg/dL',
        refLow: null,
        refHigh: null,
        category: 'organ',
      },
    ],
  });
  rows[0].slug === 'creatinine' && rows[0].status === 'matched'
    ? ok('serum creatinine matches the catalog')
    : bad('serum creatinine', JSON.stringify(rows[0]));
  rows[1].slug === 'urine_creatinine' && rows[1].status === 'new'
    ? ok('urine creatinine (same unit, ~100x the value) gets its OWN marker')
    : bad('urine creatinine folded in!', JSON.stringify(rows[1]));
}

console.log('8. importLabReport writes one report transactionally');
{
  const { db, raw } = freshDb();
  const extraction = parseLabExtraction(CAPTURED_REPLY, TODAY);
  const rows = mapExtraction(db, extraction).filter(defaultIncluded);

  const outcome = importLabReport(db, {
    collectedOn: '2026-07-14',
    labName: 'Quest Diagnostics',
    filePath: 'file:///docs/function-2026-07.pdf',
    rawJson: JSON.stringify({ results: extraction.results }),
    notes: extraction.notes,
    results: rows.map((r) => ({
      slug: r.slug,
      name: r.displayName,
      category: r.category,
      unit: r.unit,
      value: r.value,
      standardLow: r.refLow,
      standardHigh: r.refHigh,
    })),
  });

  outcome.inserted === rows.length
    ? ok(`${outcome.inserted} results inserted`)
    : bad('inserted', String(outcome.inserted));
  // Only Selenium is new — DHEA-Sulfate ships in the seed catalog.
  outcome.createdBiomarkers === 1
    ? ok('1 marker added to the catalog (Selenium); seeded ones are reused')
    : bad('created biomarkers', String(outcome.createdBiomarkers));

  const stored = raw
    .prepare(
      `SELECT b.slug AS slug, lr.value AS value FROM lab_results lr
       JOIN biomarkers b ON b.id = lr.biomarker_id WHERE lr.report_id = ?`
    )
    .all(outcome.reportId);
  const vitD = stored.find((s) => s.slug === 'vitamin_d');
  near(vitD.value, 48.0768, 1e-3)
    ? ok('the CONVERTED value is what landed in the database')
    : bad('stored value', JSON.stringify(vitD));
  !stored.some((s) => s.slug === 'lp_a')
    ? ok('the unit-conflict row was never written')
    : bad('conflict row written!');

  const report = raw.prepare('SELECT * FROM lab_reports WHERE id = ?').get(outcome.reportId);
  report.source === 'function_pdf' && report.collected_at === '2026-07-14'
    ? ok("report stored source='function_pdf' on the draw date")
    : bad('report row', JSON.stringify(report));
  report.parsed_at !== null && report.raw_extracted_json !== null
    ? ok('parsed_at stamped and the raw extraction kept for replay')
    : bad('provenance columns');
  report.file_path === 'file:///docs/function-2026-07.pdf'
    ? ok('the original PDF is referenced, not copied into the DB')
    : bad('file_path');

  listLabReports(db).length === 1 && listLabReports(db)[0].resultCount === outcome.inserted
    ? ok('listLabReports summarises it with a result count')
    : bad('list', JSON.stringify(listLabReports(db)));
  const dates = listLabReportDates(db);
  dates.length === 1 && dates[0] === '2026-07-14'
    ? ok('listLabReportDates surfaces the draw date (the re-import warning)')
    : bad('same-date lookup', JSON.stringify(dates));

  const series = biomarkerSeries(db, 'apob');
  series.length === 1 && near(series[0].value, 72)
    ? ok('biomarkerSeries reads the value back for the trend')
    : bad('series', JSON.stringify(series));
}

console.log('9. A failed import leaves nothing behind');
{
  const { db, raw } = freshDb();
  const before = raw.prepare('SELECT count(*) c FROM biomarkers').get().c;
  let threw = false;
  try {
    importLabReport(db, {
      collectedOn: '2026-07-14',
      labName: null,
      filePath: null,
      rawJson: null,
      notes: null,
      results: [
        {
          slug: 'apob',
          name: 'ApoB',
          category: 'cardiovascular',
          unit: 'mg/dL',
          value: 72,
          standardLow: null,
          standardHigh: null,
        },
        // Same biomarker twice in one report — UNIQUE(report_id, biomarker_id).
        {
          slug: 'apob',
          name: 'ApoB',
          category: 'cardiovascular',
          unit: 'mg/dL',
          value: 73,
          standardLow: null,
          standardHigh: null,
        },
      ],
    });
  } catch {
    threw = true;
  }
  threw ? ok('a duplicate biomarker in one report aborts the import') : bad('should have thrown');
  raw.prepare('SELECT count(*) c FROM lab_reports').get().c === 0
    ? ok('the report row rolled back (no half-imported panel)')
    : bad('report survived');
  raw.prepare('SELECT count(*) c FROM lab_results').get().c === 0
    ? ok('no orphan results')
    : bad('results survived');
  raw.prepare('SELECT count(*) c FROM biomarkers').get().c === before
    ? ok('no biomarker created by the failed transaction')
    : bad('biomarker leaked');
}

console.log('9b. One included row per biomarker is the review screen’s obligation');
{
  // The repository cannot dedupe for the caller — UNIQUE(report_id, biomarker_id)
  // aborts the whole import instead (proved in 9). So the mapper has to make the
  // collision VISIBLE, which is what app/lab-import.tsx's toggle relies on:
  // switching a repeat on switches its sibling off.
  const { db } = freshDb();
  const extraction = parseLabExtraction(CAPTURED_REPLY, TODAY);
  const rows = mapExtraction(db, extraction);
  const bySlug = new Map();
  for (const r of rows) bySlug.set(r.slug, (bySlug.get(r.slug) ?? 0) + 1);
  const repeated = [...bySlug.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  repeated.length === 1 && repeated[0] === 'dhea_s'
    ? ok('the mapper reports the repeated slug rather than hiding it')
    : bad('repeat detection', JSON.stringify(repeated));

  const defaults = rows.filter(defaultIncluded);
  const defaultSlugs = new Set(defaults.map((r) => r.slug));
  defaultSlugs.size === defaults.length
    ? ok('the DEFAULT selection never contains two rows for one biomarker')
    : bad('default selection would abort the import');
}

console.log('10. Deleting a report keeps history honest');
{
  const { db, raw } = freshDb();
  const outcome = importLabReport(db, {
    collectedOn: '2026-07-14',
    labName: null,
    filePath: null,
    rawJson: null,
    notes: null,
    results: [
      {
        slug: 'apob',
        name: 'ApoB',
        category: 'cardiovascular',
        unit: 'mg/dL',
        value: 72,
        standardLow: null,
        standardHigh: null,
      },
      {
        slug: 'selenium',
        name: 'Selenium',
        category: 'nutrient',
        unit: 'ug/L',
        value: 132,
        standardLow: 63,
        standardHigh: 160,
      },
    ],
  });
  // A manual entry, unattached to any report.
  const manualId = raw.prepare('SELECT id FROM biomarkers WHERE slug = ?').get('apob').id;
  db.run(
    `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at, source)
     VALUES ('manual-1', ?, NULL, 68, '2026-01-02', 'manual')`,
    [manualId]
  );

  deleteLabReport(db, outcome.reportId);
  raw.prepare('SELECT count(*) c FROM lab_results WHERE report_id IS NOT NULL').get().c === 0
    ? ok('deleting a report CASCADEs to the values parsed out of it')
    : bad('cascade');
  raw.prepare("SELECT count(*) c FROM lab_results WHERE id = 'manual-1'").get().c === 1
    ? ok('a manual entry (report_id NULL) survives untouched')
    : bad('manual entry lost');
  raw.prepare("SELECT count(*) c FROM biomarkers WHERE slug = 'selenium'").get().c === 1
    ? ok('the biomarker the report introduced stays — it is catalog data now')
    : bad('biomarker deleted');
}

console.log('11. Migration 0024 rebuilt `biomarkers` without losing anything');
{
  const { db, raw } = freshDb();
  raw.prepare('PRAGMA user_version').get().user_version ===
  Math.max(...MIGRATIONS.map((m) => m.version))
    ? ok('user_version reached the current migration head')
    : bad('version', String(raw.prepare('PRAGMA user_version').get().user_version));

  raw
    .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name LIKE '%rebuild%'")
    .get().c === 0
    ? ok('the shuttle table was dropped')
    : bad('shuttle table left behind');
  raw.prepare("SELECT count(*) c FROM sqlite_master WHERE name='biomarkers_category_idx'").get()
    .c === 1
    ? ok('biomarkers_category_idx recreated after the swap')
    : bad('index missing');
  raw.prepare("SELECT count(*) c FROM sqlite_master WHERE name='biomarkers_set_updated_at'").get()
    .c === 1
    ? ok('the updated_at trigger recreated after the swap')
    : bad('trigger missing');

  // The child's FK clause must still name `biomarkers`, not a rebuild alias.
  const childSql = raw.prepare("SELECT sql FROM sqlite_master WHERE name='lab_results'").get().sql;
  /REFERENCES biomarkers\s*\(/.test(childSql)
    ? ok('lab_results still references `biomarkers` (clause not rewritten)')
    : bad('child FK rewritten', childSql.replace(/\s+/g, ' ').slice(0, 160));

  // The widened vocabulary works; the old one still rejects garbage.
  db.run(
    "INSERT INTO biomarkers (id, slug, name, category) VALUES ('bio-1','test_bio_age','T','biological_age')"
  );
  ok("category 'biological_age' accepted");
  db.run(
    "INSERT INTO biomarkers (id, slug, name, category) VALUES ('bio-2','test_micro','M','microbiome')"
  );
  ok("category 'microbiome' accepted");
  let rejected = false;
  try {
    db.run("INSERT INTO biomarkers (id, slug, name, category) VALUES ('bio-3','x','X','nonsense')");
  } catch {
    rejected = true;
  }
  rejected ? ok('an unknown category is still rejected') : bad('CHECK lost');

  // The trigger still fires, and FK/RESTRICT semantics survived the rebuild.
  // Write a stale updated_at in the UPDATE itself: a live AFTER UPDATE trigger
  // overwrites it with now, so `after !== sentinel` fails a trigger that exists
  // in sqlite_master (line 782 passed) but was recreated with a dead body — a
  // bare `>= before` would admit equality and pass. Same probe as
  // wearables.test.mjs section 0.
  const before = raw.prepare("SELECT updated_at FROM biomarkers WHERE id='bio-1'").get().updated_at;
  db.run(
    "UPDATE biomarkers SET name = 'T2', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'bio-1'"
  );
  const after = raw.prepare("SELECT updated_at FROM biomarkers WHERE id='bio-1'").get().updated_at;
  typeof after === 'string' && after !== '2000-01-01T00:00:00.000Z' && after >= before
    ? ok('updated_at trigger stamps on UPDATE (no recursion)')
    : bad('trigger', `${before} → ${after}`);

  let fkEnforced = false;
  try {
    db.run(
      `INSERT INTO lab_results (id, biomarker_id, value, collected_at)
       VALUES ('x', 'ghost', 1, '2026-07-14')`
    );
  } catch {
    fkEnforced = true;
  }
  fkEnforced ? ok('FK from lab_results is still enforced') : bad('FK lost');

  db.run(
    `INSERT INTO lab_results (id, biomarker_id, value, collected_at)
     VALUES ('r1', 'bio-1', 1, '2026-07-14')`
  );
  let restrict = false;
  try {
    db.run("DELETE FROM biomarkers WHERE id = 'bio-1'");
  } catch {
    restrict = true;
  }
  restrict ? ok('ON DELETE RESTRICT survived the rebuild') : bad('RESTRICT lost');

  raw.prepare('PRAGMA foreign_key_check').all().length === 0
    ? ok('PRAGMA foreign_key_check is clean')
    : bad('fk check dirty');
}

console.log('12. The rebuild carries EXISTING lab data across (the real upgrade path)');
{
  // Migrate only as far as 0020, plant a report + values, THEN apply 0024 —
  // this is what happens on Matt's phone, and the case a naive rebuild breaks.
  const raw = new DatabaseSync(':memory:');
  applyConnectionPragmas((sql) => raw.exec(sql));
  const db = makeDb(raw);
  const exec = {
    exec: (sql) => raw.exec(sql),
    getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
    setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
    transaction: db.transaction,
  };
  migrate(
    exec,
    MIGRATIONS.filter((m) => m.version <= 20)
  );

  db.run(
    `INSERT INTO biomarkers (id, slug, name, category, unit, optimal_range_high)
     VALUES ('b-old', 'apob', 'ApoB', 'cardiovascular', 'mg/dL', 80)`
  );
  db.run("INSERT INTO lab_reports (id, collected_at) VALUES ('rep-old', '2026-01-15')");
  db.run(
    `INSERT INTO lab_results (id, biomarker_id, report_id, value, collected_at, lab_name, notes)
     VALUES ('res-old', 'b-old', 'rep-old', 91, '2026-01-15', 'Quest', 'pre-migration')`
  );
  const stampBefore = raw
    .prepare("SELECT created_at FROM lab_results WHERE id='res-old'")
    .get().created_at;

  migrate(exec, MIGRATIONS);

  raw.prepare('PRAGMA user_version').get().user_version ===
  Math.max(...MIGRATIONS.map((m) => m.version))
    ? ok('upgrade from 0020 → head applies with data present')
    : bad('upgrade version');
  const kept = raw.prepare("SELECT * FROM lab_results WHERE id='res-old'").get();
  kept && near(kept.value, 91) && kept.biomarker_id === 'b-old' && kept.lab_name === 'Quest'
    ? ok('the pre-existing lab result survived the parent rebuild intact')
    : bad('child row lost', JSON.stringify(kept));
  kept.created_at === stampBefore
    ? ok('...with its original created_at (shuttled, not re-defaulted)')
    : bad('timestamp reset', `${stampBefore} → ${kept.created_at}`);
  raw.prepare("SELECT count(*) c FROM biomarkers WHERE id='b-old'").get().c === 1
    ? ok('the pre-existing biomarker survived with its id')
    : bad('parent row lost');
  raw.prepare('PRAGMA foreign_key_check').all().length === 0
    ? ok('foreign_key_check clean after a data-carrying rebuild')
    : bad('fk check dirty after upgrade');
  raw.close();
}

console.log('13. The seeded catalog is internally consistent');
{
  const { db, raw } = freshDb();
  const slugs = new Set(BIOMARKER_SEED.map((b) => b.slug));
  slugs.size === BIOMARKER_SEED.length
    ? ok(`${BIOMARKER_SEED.length} seeded biomarkers, no duplicate slugs`)
    : bad('duplicate slug in seed');

  const count = raw.prepare('SELECT count(*) c FROM biomarkers').get().c;
  count === BIOMARKER_SEED.length
    ? ok('every seed row was accepted by the schema (categories, ranges, bounds)')
    : bad('seed rejected rows', `${count} of ${BIOMARKER_SEED.length}`);

  // Re-seeding must never duplicate or mutate.
  seedReferenceData(db);
  raw.prepare('SELECT count(*) c FROM biomarkers').get().c === BIOMARKER_SEED.length
    ? ok('re-seeding is idempotent')
    : bad('re-seed duplicated rows');

  // The 12 that shipped before this catalog existed must be byte-identical, or
  // a fresh install would disagree with an already-seeded device forever.
  const apob = raw.prepare("SELECT * FROM biomarkers WHERE slug='apob'").get();
  apob.optimal_range_high === 80 && apob.higher_is_better === 0 && apob.unit === 'mg/dL'
    ? ok('originally seeded ApoB values preserved exactly')
    : bad('apob drifted', JSON.stringify(apob));
  const ferritin = raw.prepare("SELECT * FROM biomarkers WHERE slug='ferritin'").get();
  ferritin.optimal_range_low === 30 && ferritin.category === 'hematology'
    ? ok('originally seeded Ferritin values preserved exactly')
    : bad('ferritin drifted', JSON.stringify(ferritin));

  // The invariant that matters: a marker harmful at BOTH extremes must not
  // claim a direction, or the app tells the user "more is better" about
  // something that hurts them when high. These are the classic U-shaped ones.
  const U_SHAPED = [
    'ferritin',
    'vitamin_d',
    'tsh',
    'sodium',
    'potassium',
    'calcium',
    'testosterone_total',
    'igf_1',
    'free_t3',
    'free_t4',
    'uric_acid',
    'hemoglobin',
  ];
  const misdirected = BIOMARKER_SEED.filter(
    (b) => U_SHAPED.includes(b.slug) && b.higherIsBetter !== null
  ).map((b) => `${b.slug}=${b.higherIsBetter}`);
  misdirected.length === 0
    ? ok('every U-shaped marker leaves higherIsBetter null (no false "more is better")')
    : bad('U-shaped marker claims a direction', misdirected.join(', '));

  // A stated direction only means something against an open-ended band.
  const oneSided = BIOMARKER_SEED.filter(
    (b) => b.higherIsBetter === 1 && b.optimalLow === null
  ).map((b) => b.slug);
  oneSided.length === 0
    ? ok('no "higher is better" marker is missing the floor that defines it')
    : bad('higher-is-better without a floor', oneSided.join(', '));

  // Every seeded category must have its own sort rank, or the Labs screen's
  // contiguous-run grouping repeats a section header down the page.
  const ordered = listBiomarkerRanges(db);
  const seenCategories = new Set();
  let repeated = null;
  let prev = null;
  for (const r of ordered) {
    if (r.category !== prev) {
      if (seenCategories.has(r.category)) repeated = r.category;
      seenCategories.add(r.category);
      prev = r.category;
    }
  }
  repeated === null
    ? ok('every category forms ONE contiguous run (no repeated section headers)')
    : bad('category interleaved', repeated);

  // Aliases must never point a printed name at a different measurand.
  const BANNED_ALIASES = [
    'zinc rbc',
    '% free psa',
    'percent free psa',
    'insulin random',
    'small dense ldl cholesterol',
  ];
  const survived = BANNED_ALIASES.filter((a) => BIOMARKER_ALIASES[a] !== undefined);
  survived.length === 0
    ? ok('no alias maps a name onto a different measurand')
    : bad('dangerous alias present', survived.join(', '));

  // The two hardest name collisions, asserted directly.
  BIOMARKER_ALIASES['crp'] !== 'hs_crp'
    ? ok('a bare "CRP" is never filed as hs-CRP')
    : bad('crp → hs_crp');
  BIOMARKER_ALIASES['t3'] !== 'free_t3' && BIOMARKER_ALIASES['t4'] !== 'free_t4'
    ? ok('a bare "T3"/"T4" is never filed as the free fraction')
    : bad('t3/t4 → free');

  const unitless = BIOMARKER_SEED.filter((b) => !b.unit || b.unit.trim() === '');
  unitless.length === 0 ? ok('every seeded marker carries a unit') : bad('missing units');
  const nonAscii = BIOMARKER_SEED.filter((b) => /[^\x20-\x7E]/.test(b.unit));
  nonAscii.length === 0
    ? ok('units are ASCII (no micro-sign codepoint drift)')
    : bad('non-ascii unit', nonAscii.map((b) => `${b.slug}=${b.unit}`).join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
