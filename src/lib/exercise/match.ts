/**
 * Matching a typed exercise name against the catalog — the one place in ARC
 * that decides what "lat pulldowns", "pull-downs", "bnech press" or
 * "skullcrusher" are.
 *
 * Owner ask, 2026-09-14: *"more intelligent search for exercises, i.e. common
 * misspellings, alternative names."* The catalog search was exact/prefix and
 * the resolver was exact/leading-phrase, so a typo found nothing and the user
 * was left scrolling sixty-nine movements or creating a duplicate custom one.
 *
 * This module is pure — it takes names, not a database — so it is shared by
 * both callers rather than forked into two matchers that drift:
 *
 *   - `resolveExerciseByName` (src/lib/db/repositories/exercise-catalog.ts),
 *     which must answer with ONE id or null, because its answer becomes a row's
 *     `exercise_id` and a wrong one silently attributes a set to the wrong
 *     muscles;
 *   - the picker's search field (src/components/exercise/exercise-picker.tsx),
 *     which can happily show a ranked list and let a human choose.
 *
 * The two use the same tiers and the same folding; they differ only in what
 * they do with an ambiguous result. That difference is the whole safety story,
 * so it is stated once here and enforced at each call site.
 *
 * ## The tiers
 *
 *   0 EXACT       the folded catalog name is the folded query
 *   1 ALIAS       a folded alias is the folded query
 *   2 PREFIX      a name or alias begins with the query, at a word boundary
 *   3 CONTAINS    a name or alias contains the query anywhere
 *   4 FUZZY       within {@link fuzzyTolerance} edits of a whole name or alias
 *   5 FUZZY WORD  every typed word is within tolerance of a word of the name
 *
 * Ranked exact > alias > prefix > fuzzy. CONTAINS sits between prefix and fuzzy
 * — it is what makes typing "curl" list every curl, the behaviour the picker
 * had and must keep — and FUZZY WORD is the weakest tier, last, which is what
 * makes a half-typed misspelling ("bnech") find the bench presses instead of
 * answering with an empty list.
 *
 * **The resolver uses neither CONTAINS nor FUZZY WORD**, and that is
 * deliberate: "press" is contained in nine movements, and a resolver that
 * ranked them would pick one. db/coach-tools.test.mjs §27 and
 * db/exercise-catalog.test.mjs pin that a bare "Press", "Bench" or "row"
 * resolves to nothing at all.
 *
 * ## Two foldings, because gym English is written two ways
 *
 * {@link normalizeExerciseName} lowercases, turns punctuation into spaces and
 * de-pluralises each token — "Lat Pulldowns" and "lat pulldown" meet there.
 * {@link squashExerciseName} goes further and removes the spaces, which is what
 * catches the compound words people write as one: "pull-downs" / "pulldown",
 * "skullcrusher" / "skull crusher", "chinups" / "chin ups", "situps". Equality
 * under the squash counts as an EXACT match, not a fuzzy one, because it is not
 * a guess — the letters are identical.
 *
 * Neither folding uses `Intl`: Hermes does not ship it.
 */

/**
 * De-pluralise one token. Three rules, in order, on tokens longer than three
 * characters: an `-es` after a sibilant comes off whole (`presses` → `press`,
 * `crunches` → `crunch`); a word already ending `-ss` is left alone (`press`);
 * otherwise a lone trailing `s` comes off (`rows`, `raises`, `dips`,
 * `pulldowns`, `triceps` → `tricep`). `abs` is short enough to be exempt. It is
 * a stemmer for gym English, not for English.
 */
const singular = (t: string): string => {
  if (t.length <= 3) return t;
  if (/(?:ss|ch|sh|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('ss')) return t;
  return t.endsWith('s') ? t.slice(0, -1) : t;
};

/**
 * Fold a typed exercise name to the form the matcher compares on: lowercase,
 * punctuation to single spaces, and each token de-pluralised.
 *
 * The de-pluralisation is the part that earns its keep. Nobody writes their log
 * in the catalog's singular voice — it is "lat pulldowns", "barbell rows",
 * "bench presses" — and a matcher that only knows "Lat Pulldown" resolves none
 * of them.
 */
export function normalizeExerciseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map(singular)
    .join(' ');
}

/** The normalised form with its spaces removed — "skull crusher" → "skullcrusher". */
export function squashExerciseName(s: string): string {
  return normalizeExerciseName(s).replace(/ /g, '');
}

/**
 * How many edits a query of this length may be wrong by and still match.
 *
 * Short queries get NO tolerance at three characters or fewer and one at five
 * or fewer, which is the guard that keeps "row" from reaching "raise" and
 * "dip" from reaching "hip". The allowance grows with length because a long
 * name has more room to be mistyped without becoming a different movement:
 * "dumbell bench pres" is nobody's idea of anything but the bench press.
 */
export function fuzzyTolerance(length: number): number {
  if (length <= 3) return 0;
  if (length <= 5) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transposition),
 * bounded: anything worse than `max` returns `max + 1` rather than the true
 * figure, so the common case exits early.
 *
 * Transposition is included because it is the single most common typing error —
 * "bnech", "sqaut", "duebmbell" — and under plain Levenshtein each swap costs
 * two edits, which is exactly enough to push a real typo past the tolerance.
 *
 * Hand-rolled: no dependency may be added to this app, and the catalog is ~70
 * rows, so an O(n·m) table over two short strings is not worth optimising.
 */
export function editDistance(a: string, b: string, max: number = Number.MAX_SAFE_INTEGER): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // A length gap alone already costs that many edits — bail before the table.
  if (Math.abs(a.length - b.length) > max) return max + 1;

  // Three rows: the previous-previous row is what transposition reads.
  let twoBack: number[] = [];
  let oneBack: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current: number[] = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowBest = current[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        current[j - 1]! + 1, // insertion
        oneBack[j]! + 1, // deletion
        oneBack[j - 1]! + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, twoBack[j - 2]! + 1); // transposition
      }
      current[j] = value;
      if (value < rowBest) rowBest = value;
    }
    // Every later row is >= this row's minimum, so a row that is already worse
    // than the cap can never recover.
    if (rowBest > max) return max + 1;
    twoBack = oneBack;
    oneBack = current;
    current = new Array<number>(b.length + 1);
  }
  const distance = oneBack[b.length]!;
  return distance > max ? max + 1 : distance;
}

/** One catalog row reduced to the names it answers to. */
export type NameSource = { id: string; name: string; aliases: string[] };

/** Ranked tiers — lower is a better match. See the module docblock. */
export const TIER = {
  exact: 0,
  alias: 1,
  prefix: 2,
  contains: 3,
  fuzzy: 4,
  fuzzyToken: 5,
} as const;

export type Tier = (typeof TIER)[keyof typeof TIER];

export type ExerciseMatch = {
  id: string;
  tier: Tier;
  /** Edits away from the query — always 0 except in the two fuzzy tiers. */
  distance: number;
  /** The name or alias that matched, unfolded — what the UI can cite. */
  matchedOn: string;
  /** Matched through an alias rather than the movement's own name. */
  viaAlias: boolean;
};

type Folded = { raw: string; normal: string; squashed: string; isAlias: boolean };

function foldedForms(entry: NameSource): Folded[] {
  const forms: Folded[] = [
    {
      raw: entry.name,
      normal: normalizeExerciseName(entry.name),
      squashed: squashExerciseName(entry.name),
      isAlias: false,
    },
  ];
  for (const alias of entry.aliases) {
    forms.push({
      raw: alias,
      normal: normalizeExerciseName(alias),
      squashed: squashExerciseName(alias),
      isAlias: true,
    });
  }
  return forms;
}

/**
 * The best match for one catalog row, or null. Tiers are tried in order and the
 * first hit wins — a row that matches exactly is never also reported as a fuzzy
 * match, so a result carries the strongest true statement about itself.
 */
function matchEntry(
  entry: NameSource,
  needle: string,
  squashedNeedle: string
): ExerciseMatch | null {
  const forms = foldedForms(entry);

  for (const form of forms) {
    if (form.normal === needle || (squashedNeedle !== '' && form.squashed === squashedNeedle)) {
      return {
        id: entry.id,
        tier: form.isAlias ? TIER.alias : TIER.exact,
        distance: 0,
        matchedOn: form.raw,
        viaAlias: form.isAlias,
      };
    }
  }

  // A prefix is a WORD boundary: "lat pull" opens "Lat Pulldown", but "row"
  // does not make "Rowing Machine" a better answer than "Barbell Row". The
  // squashed form is allowed to be a prefix only for a MULTI-WORD query, where
  // the squash is doing its actual job — joining words the user split or the
  // catalog joined ("lat pull" → latpulldown) — rather than letting a single
  // short word claim the inside of a longer one.
  const multiWord = needle.includes(' ');
  for (const form of forms) {
    if (
      form.normal.startsWith(`${needle} `) ||
      (multiWord && form.squashed.startsWith(squashedNeedle))
    ) {
      return {
        id: entry.id,
        tier: TIER.prefix,
        distance: 0,
        matchedOn: form.raw,
        viaAlias: form.isAlias,
      };
    }
  }

  for (const form of forms) {
    // Plain containment, deliberately — this is the picker's existing behaviour
    // (`name.includes(query)`) and it is good: "press" lists every press, "row"
    // lists the rows AND the rowing machine. Narrowing it to a word boundary
    // would have been a regression dressed as a refinement.
    if (form.normal.includes(needle) || form.squashed.includes(squashedNeedle)) {
      return {
        id: entry.id,
        tier: TIER.contains,
        distance: 0,
        matchedOn: form.raw,
        viaAlias: form.isAlias,
      };
    }
  }

  const tolerance = fuzzyTolerance(needle.length);
  if (tolerance > 0) {
    let best: { distance: number; form: Folded } | null = null;
    for (const form of forms) {
      const distance = Math.min(
        editDistance(needle, form.normal, tolerance),
        editDistance(squashedNeedle, form.squashed, tolerance)
      );
      if (distance <= tolerance && (best === null || distance < best.distance)) {
        best = { distance, form };
      }
    }
    if (best) {
      return {
        id: entry.id,
        tier: TIER.fuzzy,
        distance: best.distance,
        matchedOn: best.form.raw,
        viaAlias: best.form.isAlias,
      };
    }
  }

  // Last: every typed WORD is close to some word of the name. This is what
  // makes a half-typed misspelling useful — "bnech" is nowhere near the string
  // "bench press", but it is one transposition from that name's first word, and
  // a search field that answers a typo with an empty list is the complaint this
  // whole round exists to fix. Every query token has to land, so adding a word
  // still narrows; the score is the total error, so the cleanest hit sorts top.
  let tokenBest: { distance: number; form: Folded } | null = null;
  for (const form of forms) {
    const total = tokenMatchDistance(needle, form.normal);
    if (total !== null && (tokenBest === null || total < tokenBest.distance)) {
      tokenBest = { distance: total, form };
    }
  }
  if (tokenBest) {
    return {
      id: entry.id,
      tier: TIER.fuzzyToken,
      distance: tokenBest.distance,
      matchedOn: tokenBest.form.raw,
      viaAlias: tokenBest.form.isAlias,
    };
  }

  return null;
}

/**
 * Total edit distance when every token of `needle` is matched to its closest
 * token in `haystack`, or null if any token has no match within its tolerance.
 * A word of three characters or fewer has to match exactly (tolerance 0), which
 * is what stops "leg" reaching "lat".
 */
function tokenMatchDistance(needle: string, haystack: string): number | null {
  const words = haystack.split(' ');
  let total = 0;
  for (const token of needle.split(' ')) {
    const tolerance = fuzzyTolerance(token.length);
    let best = tolerance + 1;
    for (const word of words) {
      const distance = editDistance(token, word, tolerance);
      if (distance < best) best = distance;
      if (best === 0) break;
    }
    if (best > tolerance) return null;
    total += best;
  }
  return total;
}

/**
 * Rank every catalog row that matches `query`, best first.
 *
 * Order: tier, then edit distance, then a match on the movement's OWN NAME
 * before one through an alias, then the shorter name, then alphabetically.
 *
 * Name-before-alias matters more than it looks: "bnech" reaches Triceps Dip
 * through its "Bench Dip" alias and the bench presses through their names, and
 * the presses are unarguably what was meant. Shorter-first then puts "Lat
 * Pulldown" above "Straight-Arm Pulldown" — the plainer movement is asked for
 * far more often. Every tie-break is deterministic, because a list that
 * reshuffles under the reader's thumb between keystrokes is unusable.
 *
 * An empty or punctuation-only query matches nothing; callers that want "show
 * everything" handle that case themselves rather than having it mean two things
 * here.
 */
export function rankExerciseMatches(entries: NameSource[], query: string): ExerciseMatch[] {
  const needle = normalizeExerciseName(query);
  if (needle === '') return [];
  const squashedNeedle = squashExerciseName(query);
  const names = new Map(entries.map((e) => [e.id, e.name] as const));
  const matches: ExerciseMatch[] = [];
  for (const entry of entries) {
    const match = matchEntry(entry, needle, squashedNeedle);
    if (match) matches.push(match);
  }
  return matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.viaAlias !== b.viaAlias) return a.viaAlias ? 1 : -1;
    const nameA = names.get(a.id) ?? '';
    const nameB = names.get(b.id) ?? '';
    if (nameA.length !== nameB.length) return nameA.length - nameB.length;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });
}

/**
 * Should the picker offer to have a movement WRITTEN — C12's catalog-first gate
 * (2026-09-14, owner: *"ai add exercise replaces ai search (search catalog
 * first)"*).
 *
 * True when something was typed and the catalog holds nothing that plausibly
 * *is* it. The model is never asked to FIND a movement ARC already has — that
 * is a retrieval problem this module solves offline, deterministically, in a
 * millisecond — only to DEFINE one it does not.
 *
 * The line is drawn under {@link TIER.fuzzy} and above {@link TIER.fuzzyToken},
 * exactly where this module's own docblock already puts it. Tiers 0-4 are all
 * statements about the LETTERS TYPED: an exact fold, an alias, a leading
 * phrase, a containment, or a whole name a few edits away. FUZZY WORD is the
 * one tier that is a reach — it exists so a half-typed misspelling answers with
 * something rather than an empty list, and it is the tier {@link
 * resolveUniqueMatch} refuses outright for the same reason.
 *
 * Worked: "bnech press" is one transposition from "Bench Press" (FUZZY) — the
 * catalog has it, no door. Typing "curl" lists every curl (CONTAINS) and offers
 * no door, which is the point. "landmine press" matches nothing at any tier —
 * the door opens. "jefferson curl" reaches the curls only through FUZZY WORD,
 * because "jefferson" is nowhere near any word in the catalog — a reach, so the
 * door opens there too.
 *
 * The empty-query case lives here rather than at the call site so there is one
 * answer to "is the door drawn": nothing typed is not a question, and a door
 * offering to invent a movement out of no words at all would be the worst
 * possible default on a screen whose job is picking an existing one.
 */
export function offersAiEntry(entries: NameSource[], query: string): boolean {
  if (normalizeExerciseName(query) === '') return false;
  return !rankExerciseMatches(entries, query).some((m) => m.tier <= TIER.fuzzy);
}

/**
 * The single confident match for `query`, or null — the discipline the resolver
 * is built on, and the reason this is a separate function rather than
 * `rankExerciseMatches(...)[0]`.
 *
 * A result is returned only when it is UNAMBIGUOUS at its own tier: exactly one
 * row matched exactly, or exactly one row is the closest fuzzy match. Two rows
 * tied at the best tier resolve to nothing, because there is no evidence to
 * choose between them and a wrong `exercise_id` attributes a set to the wrong
 * muscles for the life of the database.
 *
 * Three tiers are refused outright:
 *
 *   - CONTAINS and FUZZY WORD, always. They are the picker's tiers, where a
 *     human reads the list and chooses. "Press" is contained in nine movements
 *     and must resolve to none of them.
 *   - PREFIX for a single-token query, which is the 2026-08-14 rule kept
 *     verbatim: it is what stops "Bench" claiming "Bench Press" while "Bench
 *     Dip" also exists. Only the shorter-input direction is safe at all —
 *     "deadlift sumo" is not conventional "Deadlift" — and natural word order
 *     ("sumo deadlift") matches exactly anyway.
 */
export function resolveUniqueMatch(entries: NameSource[], query: string): string | null {
  const needle = normalizeExerciseName(query);
  if (needle === '') return null;
  const ranked = rankExerciseMatches(entries, query);
  if (ranked.length === 0) return null;

  const exact = ranked.filter((m) => m.tier === TIER.exact || m.tier === TIER.alias);
  if (exact.length > 0) return exact.length === 1 ? exact[0]!.id : null;

  // Multi-token only, and the leading-phrase direction only.
  if (needle.split(' ').length >= 2) {
    const prefix = ranked.filter((m) => m.tier === TIER.prefix);
    if (prefix.length > 0) return prefix.length === 1 ? prefix[0]!.id : null;
  }

  const fuzzy = ranked.filter((m) => m.tier === TIER.fuzzy);
  if (fuzzy.length === 0) return null;
  const best = fuzzy[0]!.distance;
  const closest = fuzzy.filter((m) => m.distance === best);
  return closest.length === 1 ? closest[0]!.id : null;
}
