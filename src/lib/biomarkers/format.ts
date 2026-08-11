/**
 * Display formatting for biomarker reference ranges — shared by the Data tab
 * (app/(tabs)/data.tsx) and the pushed Labs screen (app/labs.tsx) so the same
 * marker reads identically on both. Pure and DB-free.
 */
import type { BiomarkerRange } from '@/lib/db/repositories/biomarkers';

/** "5.4" / "80" — a reference number rendered plainly. */
export function fmtNum(n: number): string {
  return String(n);
}

/** "50–60 ng/mL" / "< 80 mg/dL" / "> 50 mg/dL" from a biomarker's optimal bounds. */
export function rangeText(b: BiomarkerRange): string {
  const unit = b.unit ?? '';
  if (b.optimalLow != null && b.optimalHigh != null) {
    return `${fmtNum(b.optimalLow)}–${fmtNum(b.optimalHigh)} ${unit}`.trim();
  }
  if (b.optimalHigh != null) return `< ${fmtNum(b.optimalHigh)} ${unit}`.trim();
  if (b.optimalLow != null) return `> ${fmtNum(b.optimalLow)} ${unit}`.trim();
  return unit || '—';
}

/**
 * The range as the sheet actually prints it — **"optimal < 80 mg/dL"**, qualifier
 * and all (`.cf-brow-range`, arc-conformed-set.html sheet D-01).
 *
 * The qualifier is not decoration. `< 80 mg/dL` alone states a bound and says
 * nothing about whose bound it is, and ARC's bounds are deliberately NOT the
 * lab's "normal" — they are longevity-optimal (CLAUDE.md §7), which is usually
 * the tighter number. A reader who takes an unqualified `< 80` for a reference
 * interval reads a flag where there is none. One word fixes that, and it is the
 * word the design already chose.
 *
 * ## Why this is a second function and not a change to {@link rangeText}
 *
 * When this split was made, `rangeText` had two screen callers —
 * app/(tabs)/data.tsx and app/labs.tsx — and BOTH hand-built the qualifier into
 * their VoiceOver label as `Optimal ${rangeText(b)}`. Folding the word into
 * `rangeText` itself would have made every one of those labels read "Optimal
 * optimal < 80 mg/dL", one of them in a file that was out of scope to fix at the
 * time. Hence a second function rather than a changed one.
 *
 * **That evidence expired within the day; the decision did not.** Both screens
 * were moved onto `optimalRangeText` for the visible range AND the spoken label,
 * so nothing hand-builds the prefix any more, and the biomarker list now lives on
 * app/labs.tsx alone — the Data tab's duplicate was removed 2026-08-11 at the
 * owner's instruction. `rangeText` therefore has **no screen callers left**; only
 * this function calls it.
 *
 * It stays separate for a better reason than the original one: the qualifier is a
 * *claim about* the range, and a caller that frames the number some other way
 * should be able to get the bare interval rather than strip a word back off it.
 * If a second caller never appears, inlining it here is the tidier end — but that
 * is a judgement about one unused export, not the bug the split was avoiding.
 *
 * ## The unbounded case
 *
 * A marker with no bound at all falls through `rangeText` to its unit (or an
 * em-dash), and "optimal mg/dL" is not a sentence. The qualifier is therefore
 * conditioned on a bound existing rather than glued on unconditionally.
 */
export function optimalRangeText(b: BiomarkerRange): string {
  const bounded = b.optimalLow != null || b.optimalHigh != null;
  return bounded ? `optimal ${rangeText(b)}` : rangeText(b);
}
