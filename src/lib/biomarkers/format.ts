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
