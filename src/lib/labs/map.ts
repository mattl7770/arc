/**
 * Mapping: extracted lab rows → the on-device biomarker catalog.
 *
 * This is the layer that decides what a printed name MEANS, and it is written
 * to fail loudly rather than guess. The failure mode it exists to prevent is
 * silent and permanent: a value filed under the wrong marker, or stored in the
 * wrong unit, looks completely plausible on a trend line and is never noticed.
 *
 * Three rules follow from that (docs/labs-subapp.md §3):
 *
 *   1. **Exact matching only — fuzzy matching is banned.** A lab panel is dense
 *      with names that are substrings of each other: "Testosterone" inside
 *      "Testosterone, Free"; "CRP" inside "hs-CRP"; "Iron" inside "Total Iron
 *      Binding Capacity"; "T3" inside free/total/reverse T3. Substring or
 *      edit-distance matching turns every one of those into a coin flip, and
 *      the wrong side of the flip stores free testosterone (a ~10 pg/mL number)
 *      as total testosterone (a ~600 ng/dL number). A name either matches a
 *      known alias exactly, after normalization, or it doesn't match at all.
 *   2. **An unmatched marker is a first-class outcome**, not an error — it
 *      becomes a new catalog entry, so a panel ARC doesn't ship reference
 *      ranges for still lands its values instead of being dropped.
 *   3. **A unit mismatch blocks the row** unless a conversion is *known*. See
 *      {@link convertUnit} — the conversion table is an allowlist, so an
 *      unlisted pair is refused rather than approximated.
 *
 * Pure over the {@link Database} interface, so it is fully headless-testable
 * (db/labs.test.mjs).
 */
import type { Database } from '@/lib/db/database';
import type { BiomarkerCategory } from '@/lib/db/types';

import { BIOMARKER_ALIASES, UNIT_CONVERSIONS, UNIVERSAL_UNIT_CONVERSIONS } from './catalog';
import type { ExtractedResult, LabExtraction, MappedResult } from './types';

/**
 * Specimen words that make a marker a DIFFERENT analyte from its serum
 * namesake. "Urine Protein" is not serum "Protein, Total"; "Salivary Cortisol"
 * is not serum cortisol. A name carrying one of these never matches a catalog
 * slug — it gets its own entry instead.
 */
const FOREIGN_SPECIMENS = [
  'urine',
  'urinary',
  'saliva',
  'salivary',
  'stool',
  'fecal',
  'csf',
  'hair',
  'dried blood',
];

/**
 * End-anchored suffixes that carry no analyte identity and are safe to drop.
 * Deliberately an ALLOWLIST: the tokens that DO carry identity — free, total,
 * direct, indirect, ionized, bioavailable, absolute — must never be stripped,
 * and an open-ended "strip the last comma clause" rule would eat them.
 */
const SAFE_SUFFIXES = [
  ', serum',
  ', plasma',
  ', serum or plasma',
  ', serum/plasma',
  ', blood',
  ', whole blood',
  ' (serum)',
  ' (plasma)',
  ' (blood)',
];

/**
 * The name key used for every comparison. Order matters:
 * NFKC first (so ligatures and compatibility forms collapse), then the
 * micro-sign fix, then zero-width removal, then the safe-suffix strip, and only
 * then punctuation → SPACE.
 *
 * Punctuation becomes a space rather than nothing on purpose: deleting it
 * merges adjacent tokens and manufactures false matches. And `µ` (U+00B5 MICRO
 * SIGN) vs `μ` (U+03BC GREEK SMALL MU) vs `u` is a real trap — a PDF text layer
 * emits any of the three, so all three normalize to `u`.
 */
export function normalizeBiomarkerName(raw: string): string {
  let s = raw.normalize('NFKC').toLowerCase();
  // Zero-width and soft-hyphen characters; PDF text layers inject them mid-word.
  s = s.replace(/[​-‍﻿­]/g, '');
  s = s.replace(/[µμ]/g, 'u');
  // Dash-likes to a plain hyphen before punctuation handling.
  s = s.replace(/[‐-―−]/g, '-');
  s = s.replace(/\s+/g, ' ').trim();
  for (const suffix of SAFE_SUFFIXES) {
    if (s.endsWith(suffix)) {
      s = s.slice(0, -suffix.length).trim();
      break;
    }
  }
  // Everything that isn't a letter, digit, % or # becomes a space. % and # are
  // kept because on a CBC differential they are the ONLY thing separating
  // "Neutrophils %" from "Neutrophils #" — two different results, one name.
  s = s.replace(/[^a-z0-9%#]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** A stable `lower_snake_case` slug for a marker ARC has never seen. */
export function slugifyBiomarker(raw: string): string {
  const slug = normalizeBiomarkerName(raw)
    .replace(/%/g, ' pct ')
    .replace(/#/g, ' abs ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
  return slug === '' ? 'unnamed_marker' : slug;
}

/**
 * Alternative spellings US labs use for units that are the SAME unit. Folding
 * these is NOT a conversion — both sides mean an identical quantity — but
 * without it an identical unit reads as a conflict and the row can't be
 * imported at all. `K/uL`, `10*3/uL`, `x10E3/uL` and `thousand/uL` are all
 * `10^3/uL`, which is how five seeded CBC markers are stored.
 */
const UNIT_SPELLINGS: Record<string, string> = {
  'k/ul': '10^3/ul',
  '10*3/ul': '10^3/ul',
  'x10e3/ul': '10^3/ul',
  '10e3/ul': '10^3/ul',
  'thousand/ul': '10^3/ul',
  'm/ul': '10^6/ul',
  '10*6/ul': '10^6/ul',
  'x10e6/ul': '10^6/ul',
  '10e6/ul': '10^6/ul',
  'million/ul': '10^6/ul',
};

/**
 * Units compare case-, spacing- and spelling-insensitively; storage keeps the
 * catalog's own string. Micro folds to `u` across all three codepoints (`µ`
 * U+00B5, `μ` U+03BC, plain `u`) because a PDF text layer emits any of them —
 * and `mcg` folds there too, since US labs print it constantly where the
 * catalog says `ug`.
 */
export function normalizeUnit(raw: string | null): string | null {
  if (raw === null) return null;
  const u = raw
    .normalize('NFKC')
    .replace(/[µμ]/g, 'u')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/mcg/g, 'ug');
  if (u === '') return null;
  return UNIT_SPELLINGS[u] ?? u;
}

/**
 * Convert `value` from one unit to another for a given biomarker, or null when
 * no conversion is KNOWN — an allowlist, never an inference.
 *
 * Two tiers, because unit conversion in chemistry is not one problem:
 *  * {@link UNIVERSAL_UNIT_CONVERSIONS} are pure decimal-prefix or volume
 *    changes (mg/dL→mg/L, ng/mL→ug/L). They hold for any analyte because no
 *    molar mass is involved.
 *  * {@link UNIT_CONVERSIONS} are mass↔molar factors, which depend on the
 *    analyte's molecular weight and are therefore keyed by slug.
 *
 * Anything else is refused. That deliberately includes pairs that look
 * convertible but measure different things — Lp(a) in nmol/L counts apo(a)
 * particles while mg/dL measures Lp(a) mass, and no constant relates them
 * because the apo(a) protein varies in size between people. A refused row
 * surfaces in review as a unit conflict; an approximated one would silently
 * corrupt the series.
 */
export function convertUnit(slug: string, value: number, from: string, to: string): number | null {
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (f === null || t === null) return null;
  if (f === t) return value;

  const specific = UNIT_CONVERSIONS[`${slug}|${f}|${t}`];
  if (specific !== undefined) return value * specific;

  const universal = UNIVERSAL_UNIT_CONVERSIONS[`${f}|${t}`];
  if (universal !== undefined) return value * universal;

  return null;
}

/** One catalog row, as the mapper needs it. */
type CatalogRow = {
  id: string;
  slug: string;
  name: string;
  category: BiomarkerCategory;
  unit: string | null;
  optimal_range_low: number | null;
  optimal_range_high: number | null;
};

/**
 * Resolve a printed name to a catalog slug, or null. Exact matches only, in
 * order of authority: the catalog's own names, then the catalog's slugs, then
 * the curated alias table. No substring, prefix, or edit-distance step exists
 * here by design — see the module comment.
 */
function resolveSlug(printedName: string, byName: Map<string, string>): string | null {
  const key = normalizeBiomarkerName(printedName);
  if (key === '') return null;
  // A different specimen is a different analyte; never fold it into the serum
  // catalog marker of the same name. But a marker whose canonical identity IS a
  // foreign specimen — urine ACR, folded onto slug 'uacr' — is canonicalized by
  // the curated alias table on purpose. Consult that table before the guard so
  // those aliases aren't dead code; the guard then only blocks a specimen name
  // from reaching the serum catalog lookup below.
  if (FOREIGN_SPECIMENS.some((word) => key.split(' ').includes(word) || key.includes(word))) {
    return BIOMARKER_ALIASES[key] ?? null;
  }
  return byName.get(key) ?? BIOMARKER_ALIASES[key] ?? null;
}

/**
 * Map a whole extraction against the catalog, in report order. Every row comes
 * back — including the ones that can't be imported — because the review screen
 * must be able to show the user what was skipped and why. Nothing here writes
 * to the database.
 */
export function mapExtraction(db: Database, extraction: LabExtraction): MappedResult[] {
  const catalog = db.all<CatalogRow>(
    `SELECT id, slug, name, category, unit, optimal_range_low, optimal_range_high
     FROM biomarkers`
  );
  const bySlug = new Map(catalog.map((row) => [row.slug, row]));
  const byName = new Map<string, string>();
  for (const row of catalog) {
    byName.set(normalizeBiomarkerName(row.name), row.slug);
    byName.set(normalizeBiomarkerName(row.slug), row.slug);
  }

  const claimed = new Set<string>();

  return extraction.results.map((result, index) => mapOne(result, index, bySlug, byName, claimed));
}

function mapOne(
  result: ExtractedResult,
  index: number,
  bySlug: Map<string, CatalogRow>,
  byName: Map<string, string>,
  claimed: Set<string>
): MappedResult {
  const matchedSlug = resolveSlug(result.name, byName);
  const slug = matchedSlug ?? slugifyBiomarker(result.name);
  // Look the FINAL slug up, not just a name match. A generated slug can land on
  // an existing catalog row that the name lookup missed — "Neutrophils #"
  // slugifies to `neutrophils_abs`, which is a seeded marker. Treating that as
  // "new" would skip unit checking here and then file the value against the
  // existing biomarker anyway at import (ensureBiomarker resolves by slug),
  // storing an unconverted number under the catalog's unit.
  const catalogRow = bySlug.get(slug);

  const base = {
    key: `${index}-${slug}`,
    printedName: result.name,
    displayName: catalogRow?.name ?? result.name,
    biomarkerId: catalogRow?.id ?? null,
    slug,
    reportedValue: result.value,
    reportedUnit: result.unit,
    qualifier: result.qualifier,
    refLow: result.refLow,
    refHigh: result.refHigh,
    optimalLow: catalogRow?.optimal_range_low ?? null,
    optimalHigh: catalogRow?.optimal_range_high ?? null,
  };

  // Resolve the value and unit FIRST, so a row is never labelled with the
  // catalog's unit while carrying the printed (unconverted) number — whatever
  // status it ends up with.
  let value = result.value;
  let unit = result.unit;
  let status: MappedResult['status'];

  if (!catalogRow) {
    // Unmatched: the row becomes a new catalog entry, keeping its own printed
    // unit and the lab's printed range as its standard range.
    status = 'new';
  } else {
    unit = catalogRow.unit;
    const catalogUnit = normalizeUnit(catalogRow.unit);
    const reportedUnit = normalizeUnit(result.unit);
    if (catalogUnit === null || reportedUnit === null || catalogUnit === reportedUnit) {
      // Nothing to disagree about (ratios, indexes, catalog entries with no unit).
      status = 'matched';
    } else {
      const converted = convertUnit(slug, result.value, reportedUnit, catalogUnit);
      if (converted === null) {
        // Blocked. The printed number is kept verbatim — a blocked row must
        // never show an invented conversion.
        status = 'unit_conflict';
      } else {
        value = converted;
        status = 'converted';
      }
    }
  }

  const category = catalogRow?.category ?? result.category ?? 'other';

  // A slug already claimed by an earlier IMPORTABLE row in this report.
  // Legitimate causes exist — these reports repeat a marker across health areas
  // — but so does a genuine mis-map, and `lab_results` allows one value per
  // biomarker per report. Flag it rather than silently keeping the first.
  if (claimed.has(slug)) {
    return { ...base, category, value, unit, status: 'duplicate' };
  }
  // Only an importable row claims the slug. A blocked unit_conflict must not
  // demote a later, perfectly good copy of the same marker to a duplicate.
  if (status !== 'unit_conflict') claimed.add(slug);

  return { ...base, category, value, unit, status };
}

/** Whether a mapped row can be committed at all — a unit conflict cannot. */
export function isImportable(row: MappedResult): boolean {
  return row.status !== 'unit_conflict';
}

/** The rows the review screen ticks by default: everything importable and
 * unambiguous. A duplicate stays off until the user decides which one is real. */
export function defaultIncluded(row: MappedResult): boolean {
  return row.status === 'matched' || row.status === 'converted' || row.status === 'new';
}
