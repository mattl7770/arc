/**
 * Ingredient-line parsing and scaling for the recipe book — pure and DB-free,
 * so the same code runs in the UI, the repositories, and the headless tests
 * (db/recipes.test.mjs).
 *
 * The philosophy (docs/recipes-grocery.md §2a): `raw_text` is the source of
 * truth and is never destroyed; qty/unit/name are a BEST-EFFORT overlay used
 * for scaling and grocery consolidation. When a line doesn't parse, the
 * overlay stays null and every consumer falls back to the raw line — the
 * Paprika constraint ("quantity unit ingredient" parses; prose degrades
 * gracefully, never corrupts).
 *
 * No cross-unit conversion lives here or anywhere: "2 cups" + "100 g" are
 * grouped side by side, never summed (density data nobody has).
 */

/** The parsed overlay of one ingredient line. */
export type ParsedIngredient = {
  qty: number | null;
  unit: string | null;
  name: string | null;
};

/** Unicode vulgar fractions → numeric value. */
const VULGAR: Record<string, number> = {
  '¼': 0.25,
  '½': 0.5,
  '¾': 0.75,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅕': 0.2,
  '⅖': 0.4,
  '⅗': 0.6,
  '⅘': 0.8,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅛': 0.125,
  '⅜': 0.375,
  '⅝': 0.625,
  '⅞': 0.875,
};

/** unit token (any accepted spelling, lowercase) → canonical display form. */
const UNIT_CANON: Record<string, string> = {
  cup: 'cup',
  cups: 'cup',
  tbsp: 'tbsp',
  tbs: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  tsp: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  ml: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  clove: 'clove',
  cloves: 'clove',
  can: 'can',
  cans: 'can',
  slice: 'slice',
  slices: 'slice',
  piece: 'piece',
  pieces: 'piece',
  pinch: 'pinch',
  pinches: 'pinch',
  bunch: 'bunch',
  bunches: 'bunch',
  stick: 'stick',
  sticks: 'stick',
  stalk: 'stalk',
  stalks: 'stalk',
  sprig: 'sprig',
  sprigs: 'sprig',
  head: 'head',
  heads: 'head',
  handful: 'handful',
  handfuls: 'handful',
  dash: 'dash',
  packet: 'packet',
  packets: 'packet',
  package: 'package',
  packages: 'package',
  bag: 'bag',
  bags: 'bag',
  jar: 'jar',
  jars: 'jar',
  bottle: 'bottle',
  bottles: 'bottle',
  scoop: 'scoop',
  scoops: 'scoop',
  fillet: 'fillet',
  fillets: 'fillet',
};

/** Canonical display form for a unit token, or null when it isn't one we know.
 * Display/merge-key normalization ONLY — never a conversion. */
export function normalizeUnit(token: string | null | undefined): string | null {
  if (!token) return null;
  return UNIT_CANON[token.toLowerCase().replace(/\.$/, '')] ?? null;
}

/** Leading list furniture ("- ", "• ", "* ", "2. ") stripped before parsing. */
function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-–—•*·]|\d+[.)])\s+/, '').trim();
}

/**
 * Pull a leading quantity off `s`. Handles: "1", "1.5", "1/2", "1 1/2", "½",
 * "1½", and ranges ("2-3", "2 – 3" — the FIRST number wins, matching how the
 * shopper reads "2-3 cloves"). Returns null when the line doesn't start with a
 * number — prose lines keep a null overlay.
 */
function parseLeadingQty(s: string): { qty: number; rest: string } | null {
  // "1 1/2" / "1/2" — explicit fractions (mixed first, so "1 1/2" isn't read as 1).
  let m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)\s*/.exec(s);
  if (m) {
    const den = Number(m[3]);
    if (den > 0) return { qty: Number(m[1]) + Number(m[2]) / den, rest: s.slice(m[0].length) };
  }
  m = /^(\d+)\s*\/\s*(\d+)\s*/.exec(s);
  if (m) {
    const den = Number(m[2]);
    if (den > 0) return { qty: Number(m[1]) / den, rest: s.slice(m[0].length) };
  }
  // "1½" / "½" — vulgar glyphs, with an optional whole part.
  m = /^(\d+)?\s*([¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\s*/.exec(s);
  if (m) {
    return { qty: (m[1] ? Number(m[1]) : 0) + VULGAR[m[2]!]!, rest: s.slice(m[0].length) };
  }
  // "2" / "1.5", optionally a range whose first number wins ("2-3", "2 to 3").
  m = /^(\d+(?:\.\d+)?)(?:\s*(?:[-–—~]|to)\s*\d+(?:\.\d+)?)?\s*/.exec(s);
  if (m) {
    const qty = Number(m[1]);
    if (qty > 0) return { qty, rest: s.slice(m[0].length) };
  }
  return null;
}

/** Tidy the name remainder: drop a leading "of", one leading "(...)" group,
 * and collapsed whitespace. Empty → null. */
function cleanName(rest: string): string | null {
  const cleaned = rest
    .replace(/^\([^)]*\)\s*/, '')
    .replace(/^of\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * Parse one ingredient line into its qty/unit/name overlay. Never throws;
 * a line that doesn't parse returns `{ qty: null, unit: null, name: <cleaned
 * raw or null> }` so the raw text still works everywhere.
 */
export function parseIngredientLine(raw: string): ParsedIngredient {
  const line = stripBullet(raw);
  if (line === '') return { qty: null, unit: null, name: null };

  const lead = parseLeadingQty(line);
  if (!lead) return { qty: null, unit: null, name: cleanName(line) };

  // A known unit token directly after the quantity ("cups", "g" — including
  // the attached "100g" case, whose 'g' lands at the start of rest).
  const unitMatch = /^([a-zA-Z]+)\.?\s*/.exec(lead.rest);
  const unit = unitMatch ? normalizeUnit(unitMatch[1]) : null;
  const afterUnit = unit ? lead.rest.slice(unitMatch![0].length) : lead.rest;

  return { qty: lead.qty, unit, name: cleanName(afterUnit) };
}

/** Scale a parsed quantity. Trivial on purpose — it exists so scaling always
 * routes through one place the tests pin. */
export function scaleQty(qty: number, factor: number): number {
  return qty * factor;
}

/** Nearest-glyph fraction display: 1.5 → "1½", 0.25 → "¼", 2 → "2", else a
 * trimmed decimal ("1.33" when no glyph is close). */
export function formatQty(qty: number): string {
  const whole = Math.floor(qty);
  const frac = qty - whole;
  if (frac < 0.02) return String(whole === 0 ? qty : whole);
  if (frac > 0.98) return String(whole + 1);
  const glyphs: [number, string][] = [
    [0.25, '¼'],
    [1 / 3, '⅓'],
    [0.375, '⅜'],
    [0.5, '½'],
    [0.625, '⅝'],
    [2 / 3, '⅔'],
    [0.75, '¾'],
    [0.125, '⅛'],
    [0.875, '⅞'],
  ];
  for (const [value, glyph] of glyphs) {
    if (Math.abs(frac - value) < 0.02) return whole > 0 ? `${whole}${glyph}` : glyph;
  }
  const rounded = Math.round(qty * 100) / 100;
  return String(rounded);
}

/**
 * The display string for an ingredient line at `factor` × the batch. A line
 * with no parsed qty returns its raw text unchanged — scaling never rewrites
 * what it can't understand (the Paprika constraint).
 */
export function scaleIngredientLine(
  line: { raw_text: string; qty: number | null; unit: string | null; name: string | null },
  factor: number
): string {
  if (line.qty === null) return line.raw_text;
  const qty = formatQty(scaleQty(line.qty, factor));
  const unit = line.unit ? `${line.unit} ` : '';
  const name = line.name ?? '';
  return `${qty} ${unit}${name}`.trim();
}
