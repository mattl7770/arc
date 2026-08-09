/**
 * The grocery list's static keyword→category table — ARC's own ~12-category
 * taxonomy (docs/recipes-grocery.md §2b), assigned at insert time, fully
 * offline, zero latency. The user re-filing an item teaches it
 * (grocery_name_prefs.category wins over this table forever after); anything
 * unrecognized lands in 'other', exactly like Apple Reminders' behaviour for
 * unknown items. Free-text category column + TS table (the wearable
 * metric_type precedent): a new category is code, never a migration.
 *
 * Matching: longest keyword wins; keywords match as whole words or leading
 * phrases of the normalized name ("chicken breast" hits 'chicken'; "buttermilk"
 * does NOT hit 'butter' — substring matches are banned for the same reason
 * fuzzy biomarker matching is).
 */

export type GroceryCategoryKey =
  | 'produce'
  | 'meat_seafood'
  | 'dairy_eggs'
  | 'bakery'
  | 'pantry'
  | 'frozen'
  | 'beverages'
  | 'snacks'
  | 'spices_sauces'
  | 'supplements'
  | 'household'
  | 'other';

export type GroceryCategory = { key: GroceryCategoryKey; label: string };

/** Display order — roughly a store's walking order, Other last. */
export const GROCERY_CATEGORIES: GroceryCategory[] = [
  { key: 'produce', label: 'Produce' },
  { key: 'meat_seafood', label: 'Meat & Seafood' },
  { key: 'dairy_eggs', label: 'Dairy & Eggs' },
  { key: 'bakery', label: 'Bakery' },
  { key: 'pantry', label: 'Pantry' },
  { key: 'frozen', label: 'Frozen' },
  { key: 'beverages', label: 'Beverages' },
  { key: 'snacks', label: 'Snacks' },
  { key: 'spices_sauces', label: 'Spices & Sauces' },
  { key: 'supplements', label: 'Supplements' },
  { key: 'household', label: 'Household' },
  { key: 'other', label: 'Other' },
];

export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  GROCERY_CATEGORIES.map((c) => [c.key, c.label])
);

/** keyword (normalized) → category. Multi-word keywords are checked first. */
const KEYWORDS: Record<string, GroceryCategoryKey> = {
  // Produce
  apple: 'produce',
  apples: 'produce',
  avocado: 'produce',
  banana: 'produce',
  bananas: 'produce',
  basil: 'produce',
  'bell pepper': 'produce',
  berries: 'produce',
  blueberries: 'produce',
  broccoli: 'produce',
  cabbage: 'produce',
  carrot: 'produce',
  carrots: 'produce',
  cauliflower: 'produce',
  celery: 'produce',
  cilantro: 'produce',
  cucumber: 'produce',
  garlic: 'produce',
  ginger: 'produce',
  grapes: 'produce',
  kale: 'produce',
  lemon: 'produce',
  lemons: 'produce',
  lettuce: 'produce',
  lime: 'produce',
  limes: 'produce',
  mushroom: 'produce',
  mushrooms: 'produce',
  onion: 'produce',
  onions: 'produce',
  orange: 'produce',
  oranges: 'produce',
  parsley: 'produce',
  pepper: 'produce',
  peppers: 'produce',
  potato: 'produce',
  potatoes: 'produce',
  scallion: 'produce',
  scallions: 'produce',
  spinach: 'produce',
  strawberries: 'produce',
  'sweet potato': 'produce',
  'sweet potatoes': 'produce',
  tomato: 'produce',
  tomatoes: 'produce',
  zucchini: 'produce',
  // Meat & Seafood
  bacon: 'meat_seafood',
  beef: 'meat_seafood',
  chicken: 'meat_seafood',
  cod: 'meat_seafood',
  fish: 'meat_seafood',
  'ground beef': 'meat_seafood',
  'ground turkey': 'meat_seafood',
  ham: 'meat_seafood',
  lamb: 'meat_seafood',
  pork: 'meat_seafood',
  salmon: 'meat_seafood',
  sausage: 'meat_seafood',
  shrimp: 'meat_seafood',
  steak: 'meat_seafood',
  tuna: 'meat_seafood',
  turkey: 'meat_seafood',
  // Dairy & Eggs
  butter: 'dairy_eggs',
  cheese: 'dairy_eggs',
  cream: 'dairy_eggs',
  'cream cheese': 'dairy_eggs',
  egg: 'dairy_eggs',
  eggs: 'dairy_eggs',
  'greek yogurt': 'dairy_eggs',
  kefir: 'dairy_eggs',
  milk: 'dairy_eggs',
  mozzarella: 'dairy_eggs',
  parmesan: 'dairy_eggs',
  'sour cream': 'dairy_eggs',
  yogurt: 'dairy_eggs',
  // Bakery
  bagel: 'bakery',
  bagels: 'bakery',
  baguette: 'bakery',
  bread: 'bakery',
  bun: 'bakery',
  buns: 'bakery',
  croissant: 'bakery',
  pita: 'bakery',
  sourdough: 'bakery',
  tortilla: 'bakery',
  tortillas: 'bakery',
  // Pantry
  beans: 'pantry',
  'black beans': 'pantry',
  'chicken broth': 'pantry',
  chickpeas: 'pantry',
  'coconut milk': 'pantry',
  flour: 'pantry',
  honey: 'pantry',
  lentils: 'pantry',
  'maple syrup': 'pantry',
  oats: 'pantry',
  'olive oil': 'pantry',
  oil: 'pantry',
  pasta: 'pantry',
  'peanut butter': 'pantry',
  quinoa: 'pantry',
  rice: 'pantry',
  spaghetti: 'pantry',
  sugar: 'pantry',
  'tomato paste': 'pantry',
  'tomato sauce': 'pantry',
  vinegar: 'pantry',
  // Frozen
  'frozen berries': 'frozen',
  'frozen fruit': 'frozen',
  'frozen peas': 'frozen',
  'frozen vegetables': 'frozen',
  'ice cream': 'frozen',
  // Beverages
  beer: 'beverages',
  coffee: 'beverages',
  juice: 'beverages',
  kombucha: 'beverages',
  'sparkling water': 'beverages',
  tea: 'beverages',
  water: 'beverages',
  wine: 'beverages',
  // Snacks
  chips: 'snacks',
  chocolate: 'snacks',
  crackers: 'snacks',
  granola: 'snacks',
  nuts: 'snacks',
  almonds: 'snacks',
  cashews: 'snacks',
  'protein bar': 'snacks',
  'protein bars': 'snacks',
  walnuts: 'snacks',
  // Spices & Sauces
  cinnamon: 'spices_sauces',
  cumin: 'spices_sauces',
  'hot sauce': 'spices_sauces',
  ketchup: 'spices_sauces',
  mayo: 'spices_sauces',
  mayonnaise: 'spices_sauces',
  mustard: 'spices_sauces',
  oregano: 'spices_sauces',
  paprika: 'spices_sauces',
  salsa: 'spices_sauces',
  salt: 'spices_sauces',
  'soy sauce': 'spices_sauces',
  turmeric: 'spices_sauces',
  // Supplements
  collagen: 'supplements',
  creatine: 'supplements',
  electrolytes: 'supplements',
  magnesium: 'supplements',
  'protein powder': 'supplements',
  'vitamin d': 'supplements',
  // Household
  'aluminum foil': 'household',
  batteries: 'household',
  detergent: 'household',
  'dish soap': 'household',
  'paper towels': 'household',
  shampoo: 'household',
  soap: 'household',
  sponges: 'household',
  'toilet paper': 'household',
  toothpaste: 'household',
  'trash bags': 'household',
};

/** Keywords sorted longest-first so "sweet potato" beats "potato". */
const KEYWORD_ENTRIES = Object.entries(KEYWORDS).sort((a, b) => b[0].length - a[0].length);

/**
 * The category for a (normalized) item name: the learned pref wins, then the
 * longest static keyword appearing as a whole word / leading phrase, then
 * 'other'. Pure — the repository passes the learned value in.
 */
export function categorizeGroceryItem(nameNorm: string, learnedCategory?: string | null): string {
  if (learnedCategory) return learnedCategory;
  // Punctuation is a word boundary too: recipe-derived names arrive as
  // "garlic, minced" and the comma must not glue the keyword shut. Collapsing
  // non-alphanumerics to spaces keeps the substring ban intact ("buttermilk"
  // still has no boundary inside it, so "butter" can't match).
  const collapsed = nameNorm
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [keyword, category] of KEYWORD_ENTRIES) {
    if (collapsed === keyword) return category;
    // Whole-word containment: pad both sides so partial tokens can't hit.
    if (` ${collapsed} `.includes(` ${keyword} `)) return category;
  }
  return 'other';
}
