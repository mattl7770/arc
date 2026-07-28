/**
 * Open Food Facts barcode lookup — the one online-except-AI path in nutrition
 * (docs/nutrition-subapp.md §5). A scanned barcode resolves locally first
 * (findFoodByBarcode over the grown catalog); only a miss reaches the network,
 * and every hit is cached back into `foods` (source='openfoodfacts') so the
 * pantry converges to fully-offline scanning.
 *
 * Pure + fetch-injected, so the mapping is headless-testable (db/barcode.test.mjs)
 * and never imports op-sqlite or expo. OFF's ODbL private-use carve-out covers a
 * single-user, never-redistributed cache; the required custom User-Agent
 * identifies the app per OFF etiquette (well under 15 req/min by construction).
 *
 * Unit handling is conservative on purpose (research §1: branded/label data is
 * unreliable for magnesium, omega-3, and most vitamins): only the values OFF
 * reliably normalizes are mapped — macros/fiber in grams, and sodium /
 * potassium / calcium / iron converted from OFF's grams to milligrams. Every
 * value is range-checked — macros/kcal to the schema's bounds, micros to a
 * physical ceiling (a contributor who types 500 into the grams field of a
 * per-100 g sodium would otherwise cache 500,000 mg and blow up the day's
 * rollup) — so a garbage entry is dropped rather than stored or thrown on.
 */
import { serializeMicros } from './micros';
import type { NewFood } from './types';

const OFF_BASE = 'https://world.openfoodfacts.org/api/v2/product';
const OFF_FIELDS = 'product_name,product_name_en,brands,nutriments,serving_size,serving_quantity';

/** OFF etiquette: identify the app. Not a secret; safe to ship. */
export const OFF_USER_AGENT = 'ARC/0.1 (matt.lawrence2@gmail.com)';

/** The minimal fetch surface — global fetch and expo/fetch both satisfy it. */
export type OffFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Strip a scanned barcode to digits; '' when it isn't a usable code. */
export function normalizeBarcode(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** The product-lookup URL for a (digits-only) barcode. */
export function offProductUrl(barcode: string): string {
  return `${OFF_BASE}/${barcode}?fields=${OFF_FIELDS}`;
}

type OffNutriments = Record<string, unknown>;

function offNum(nutriments: OffNutriments, key: string): number | null {
  const v = nutriments[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Keep a per-100 g macro only when it's within the schema's 0–100 range. */
function per100(nutriments: OffNutriments, key: string): number | null {
  const v = offNum(nutriments, key);
  return v != null && v <= 100 ? v : null;
}

/**
 * Nothing physical exceeds its own mass: even pure salt is ~39,000 mg sodium
 * per 100 g. A value past this is a contributor unit-entry error — drop it
 * rather than cache an absurd milligram figure that would swamp the day's total.
 */
const MG_CEILING_PER_100G = 50000;

/** OFF stores sodium/potassium/calcium/iron per-100 g in GRAMS → milligrams,
 * dropping anything past the physical ceiling. */
function mgFromGrams(nutriments: OffNutriments, key: string): number | undefined {
  const g = offNum(nutriments, key);
  if (g == null) return undefined;
  const mg = g * 1000;
  return mg <= MG_CEILING_PER_100G ? mg : undefined;
}

/**
 * Map an OFF v2 product response to a NewFood, or null when it's unusable
 * (product not found, or no name). Validates every numeric against the schema's
 * bounds so the result is always safe to createFood.
 */
export function parseOffProduct(response: unknown, barcode: string): NewFood | null {
  if (typeof response !== 'object' || response === null) return null;
  const root = response as Record<string, unknown>;
  if (root.status !== 1 || typeof root.product !== 'object' || root.product === null) return null;
  const product = root.product as Record<string, unknown>;

  const name =
    (typeof product.product_name === 'string' && product.product_name.trim()) ||
    (typeof product.product_name_en === 'string' && product.product_name_en.trim()) ||
    '';
  if (name === '') return null; // a nameless product is useless to log

  const brand =
    typeof product.brands === 'string' && product.brands.trim() !== ''
      ? product.brands.split(',')[0]!.trim()
      : null;

  const nutriments: OffNutriments =
    typeof product.nutriments === 'object' && product.nutriments !== null
      ? (product.nutriments as OffNutriments)
      : {};

  const kcalRaw = offNum(nutriments, 'energy-kcal_100g');
  const kcal_100g = kcalRaw != null && kcalRaw <= 950 ? kcalRaw : null;

  // Sodium: prefer the direct sodium field, else derive from salt (÷2.5),
  // subject to the same physical ceiling.
  const saltG = offNum(nutriments, 'salt_100g');
  const fromSalt = saltG != null ? (saltG / 2.5) * 1000 : undefined;
  const sodiumRaw = mgFromGrams(nutriments, 'sodium_100g') ?? fromSalt;
  const sodium_mg = sodiumRaw != null && sodiumRaw <= MG_CEILING_PER_100G ? sodiumRaw : undefined;

  const micros = serializeMicros({
    ...(sodium_mg != null ? { sodium_mg } : {}),
    ...(mgFromGrams(nutriments, 'potassium_100g') != null
      ? { potassium_mg: mgFromGrams(nutriments, 'potassium_100g') }
      : {}),
    ...(mgFromGrams(nutriments, 'calcium_100g') != null
      ? { calcium_mg: mgFromGrams(nutriments, 'calcium_100g') }
      : {}),
    ...(mgFromGrams(nutriments, 'iron_100g') != null
      ? { iron_mg: mgFromGrams(nutriments, 'iron_100g') }
      : {}),
  });

  // Serving: pair-or-none — only set both when the gram quantity is usable.
  const servingQty =
    typeof product.serving_quantity === 'number'
      ? product.serving_quantity
      : Number(product.serving_quantity);
  const hasServing = Number.isFinite(servingQty) && servingQty > 0;
  const servingName =
    typeof product.serving_size === 'string' && product.serving_size.trim() !== ''
      ? product.serving_size.trim()
      : '1 serving';

  return {
    name,
    brand,
    barcode,
    serving_name: hasServing ? servingName : null,
    serving_grams: hasServing ? servingQty : null,
    kcal_100g,
    protein_g_100g: per100(nutriments, 'proteins_100g'),
    carbs_g_100g: per100(nutriments, 'carbohydrates_100g'),
    fat_g_100g: per100(nutriments, 'fat_100g'),
    fiber_g_100g: per100(nutriments, 'fiber_100g'),
    micros,
    source: 'openfoodfacts',
  };
}

/** Distinguishes a "not found" from a network/parse failure for the UI. */
export class OffLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffLookupError';
  }
}

/**
 * Look a barcode up on Open Food Facts. Returns the mapped NewFood, or null
 * when the product isn't in OFF. Throws {@link OffLookupError} on a network or
 * non-2xx failure so the caller can tell "not found" (fall back to manual) from
 * "you're offline" (fall back to manual, differently worded). The fetch is
 * injected so this is testable and provider-agnostic.
 */
export async function lookupOffProduct(
  barcode: string,
  fetchImpl: OffFetch,
  signal?: AbortSignal
): Promise<NewFood | null> {
  const code = normalizeBarcode(barcode);
  if (code === '') return null;
  let response: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    response = await fetchImpl(offProductUrl(code), {
      method: 'GET',
      headers: { 'User-Agent': OFF_USER_AGENT, Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    throw new OffLookupError(error instanceof Error ? error.message : 'Network request failed.');
  }
  if (!response.ok) {
    // A 404 from OFF means "no such product" — a clean miss, not an error.
    if (response.status === 404) return null;
    throw new OffLookupError(`Open Food Facts returned HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OffLookupError('Open Food Facts sent an unreadable response.');
  }
  return parseOffProduct(body, code);
}
