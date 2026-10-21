/**
 * A capture corrected on the Log tab (owner, 2026-09-26: *"Yes, an edit on the
 * Log tab, and the Coach too."*).
 *
 * The editor's words and numbers live here rather than in the screen, for the
 * reason src/lib/log/capture-undo.ts gives: the headless suite drives the same
 * path the Save tap drives (db/log.test.mjs), so a correction written in the
 * wrong unit, or one that rewrites a reading nobody changed, fails a test.
 *
 * The write is `editLogCapture` (src/lib/health/publish.ts) — the one function
 * the Coach's `captures` edit calls too, record and Apple Health together.
 *
 * ## A number the user did not change is not rewritten
 *
 * The editor opens to the figure the row PRINTS ("176.4 lb"), which is the
 * stored kilogram value rounded. Saving that figure back unchanged must leave
 * the stored value alone: converting 176.4 lb back gives 80.0136 kg, not the
 * 80 kg on record, and writing it would move the reading and re-send it to
 * Apple Health for a correction nobody made. So the draft is compared as
 * printed, and only a figure that differs from the printed one is converted.
 *
 * ## The figure is read in the units the editor opened in
 *
 * The draft is a figure in the unit printed beside it, so Save reads it in
 * THAT unit, not in whatever the preference says by the time Save is tapped.
 * The weight, volume or length unit can change while an editor is open — in
 * Settings › Units, or by the Coach — and "176.4" typed as pounds but read as
 * kilograms is a reading of 176.4 kg, stored and sent to Apple Health. So a
 * row is opened together with its units ({@link openCaptureEdit}) and saved
 * with those same units ({@link saveCaptureEdit}); nothing re-reads them
 * between the two.
 */
import type { Database } from '@/lib/db/database';
import {
  getCapture,
  planCaptureCorrection,
  type CaptureEdit,
  type CapturePatch,
  type CaptureRecord,
} from '@/lib/db/repositories/logs';
import { getPreferences } from '@/lib/db/repositories/user';
import { editLogCapture, type EditedCapture, type WaterPublishDeps } from '@/lib/health/publish';
import { metricByKey, resolveDisplay, roundForDisplay, type DisplaySpec } from '@/lib/log/metrics';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * A row opened for correction: the capture as it was read, and the units its
 * editor prints it in. Held together from the tap that opens the editor to
 * the Save that closes it, so a figure is converted in the unit it was typed
 * in (see the header).
 */
export type OpenCapture = { capture: CaptureRecord; units: UnitPreferences };

/**
 * The tap on a row: the capture read whole, with the units in force now — or
 * null for a row with nothing to correct (screen time, or a row since removed).
 */
export function openCaptureEdit(db: Database, id: string): OpenCapture | null {
  const units = getPreferences(db).units;
  const capture = getCapture(db, id, units);
  return capture?.edit ? { capture, units } : null;
}

/** What the editor's fields hold — always strings, as typed. */
export type CaptureDraft = {
  /** A note, a supplement / medication / therapy line, or a symptom's name. */
  text: string;
  /** A measurement as the row prints it, in the user's units. */
  value: string;
  /** A symptom's 1–10; empty for unrated. */
  severity: string;
};

/** The display spec a measurement is edited in, or null for a capture of words. */
export function captureSpec(edit: CaptureEdit | null, units: UnitPreferences): DisplaySpec | null {
  if (edit?.kind !== 'measure') return null;
  const metric = metricByKey(edit.metric);
  return metric ? resolveDisplay(metric, units) : null;
}

/** What the editor opens to: the row's own words, or its figure as the row prints it. */
export function captureDraft(capture: CaptureRecord, units: UnitPreferences): CaptureDraft {
  const edit = capture.edit;
  if (!edit) return { text: '', value: '', severity: '' };
  if (edit.kind === 'text') return { text: edit.text, value: '', severity: '' };
  if (edit.kind === 'symptom') {
    return {
      text: edit.name,
      value: '',
      severity: edit.severity === null ? '' : String(edit.severity),
    };
  }
  const spec = captureSpec(edit, units);
  return {
    text: '',
    value: spec ? String(roundForDisplay(spec, edit.canonical)) : String(edit.canonical),
    severity: '',
  };
}

/** A correction in the user's own units — what a person types, and what the Coach sends. */
export type CaptureFields = {
  text?: string;
  /** A measurement as its line prints it: lb or kg, oz or ml, in or cm, and so on. */
  value?: number;
  severity?: number | null;
};

/**
 * Fields in the user's units → the canonical patch `editLogCapture` takes,
 * with every key that says what the row already says left out — an empty
 * patch is no correction. One rule for the Log tab's editor and the Coach's
 * `captures` edit, so the two convert a figure the same way:
 *
 *   - a `value` equal to the figure the row PRINTS is no change (see the
 *     header); any other is converted from the row's display unit;
 *   - words are compared trimmed.
 *
 * Whether the keys fit the row, and whether a figure can be stored, is
 * `planCaptureCorrection`'s to say — `editLogCapture` runs it, and so does the
 * Coach's card. A `value` sent for a row of words passes through unconverted
 * so that it is refused there, in its words.
 */
export function capturePatchFrom(
  capture: CaptureRecord,
  fields: CaptureFields,
  units: UnitPreferences
): CapturePatch {
  const edit = capture.edit;
  const patch: CapturePatch = {};
  if (fields.text !== undefined) {
    const was = edit?.kind === 'text' ? edit.text : edit?.kind === 'symptom' ? edit.name : null;
    if (typeof fields.text !== 'string' || fields.text.trim() !== was) patch.text = fields.text;
  }
  if (fields.value !== undefined) {
    const spec = captureSpec(edit, units);
    if (edit?.kind !== 'measure' || !spec) {
      patch.canonical = fields.value;
    } else if (fields.value !== roundForDisplay(spec, edit.canonical)) {
      patch.canonical = spec.toCanonical(fields.value);
    }
  }
  if (fields.severity !== undefined) {
    if (edit?.kind !== 'symptom' || fields.severity !== edit.severity) {
      patch.severity = fields.severity;
    }
  }
  return patch;
}

/**
 * The draft as a patch for `editLogCapture` — null when it says what the row
 * already says — or the one plain line saying why it cannot be saved.
 */
export function captureDraftPatch(
  capture: CaptureRecord,
  draft: CaptureDraft,
  units: UnitPreferences
): { patch: CapturePatch | null } | { error: string } {
  const edit = capture.edit;
  if (!edit) return { error: 'This entry cannot be corrected here.' };

  const fields: CaptureFields = {};
  if (edit.kind === 'text' || edit.kind === 'symptom') {
    if (draft.text.trim().length === 0) {
      return {
        error:
          edit.kind === 'symptom' ? 'Name the symptom.' : 'Type the words, or remove the entry.',
      };
    }
    fields.text = draft.text;
  }
  if (edit.kind === 'symptom') {
    const typed = draft.severity.trim();
    const severity = typed === '' ? null : Number(typed);
    if (severity !== null && (!Number.isInteger(severity) || severity < 1 || severity > 10)) {
      return { error: 'Severity is a whole number from 1 to 10, or blank.' };
    }
    fields.severity = severity;
  }
  if (edit.kind === 'measure') {
    const typed = Number(draft.value.trim());
    if (draft.value.trim() === '' || !Number.isFinite(typed)) return { error: 'Type a number.' };
    fields.value = typed;
  }

  const patch = capturePatchFrom(capture, fields, units);
  if (Object.keys(patch).length === 0) return { patch: null };
  try {
    planCaptureCorrection(capture, patch);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { patch };
}

/** What a Save tap did. */
export type CaptureSaveResult =
  { saved: true; edited: EditedCapture | null } | { saved: false; error: string };

/**
 * The Save tap: the draft checked, then written through `editLogCapture`. A
 * draft that changes nothing writes nothing and closes the editor all the same
 * (`saved: true`, `edited: null`). A capture removed meanwhile, or a draft that
 * does not fit, is not saved, and the line says why.
 *
 * The draft is read in the units the row was opened in (`open.units`), never
 * in the preference as it stands at Save — see the header.
 */
export function saveCaptureEdit(
  db: Database,
  open: OpenCapture,
  draft: CaptureDraft,
  /** The Apple Health seam; the native one unless a test hands in a recorder. */
  deps?: WaterPublishDeps
): CaptureSaveResult {
  const { capture, units } = open;
  const planned = captureDraftPatch(capture, draft, units);
  if ('error' in planned) return { saved: false, error: planned.error };
  if (planned.patch === null) return { saved: true, edited: null };
  try {
    const edited = editLogCapture(db, capture.id, planned.patch, deps);
    if (!edited) return { saved: false, error: 'This entry is no longer on the Log tab.' };
    return { saved: true, edited };
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) };
  }
}
