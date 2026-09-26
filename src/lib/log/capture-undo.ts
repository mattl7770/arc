/**
 * A capture deleted from the Log tab, done WITH its Undo (owner, 2026-09-25:
 * *"Add a delete with an Undo to each capture on the Log tab; the Coach then
 * gets it too, behind the card."*).
 *
 * The pairing lives here rather than in the screen's handler for the reason
 * src/lib/nutrition/undo-offers.ts gives: the headless suite drives the same
 * path the tap drives (db/log.test.mjs), so a removal whose Undo was wired to
 * the wrong restore, or to none, fails a test.
 *
 * The write is `removeLogCapture` (src/lib/health/publish.ts) — the one
 * function the Coach's `captures` removal calls too, record and Apple Health
 * together. The Coach's removal offers no Undo: its card says there is none,
 * and the approval is the gate. The offer shares the app's one Undo slot
 * (src/lib/nutrition/undo-store.ts) under the Log tab's day, so it closes when
 * the tab is left and is replaced by the next removal anywhere.
 */
import type { Database } from '@/lib/db/database';
import type { CaptureRecord } from '@/lib/db/repositories/logs';
import { metricByWearableType } from '@/lib/log/metrics';
import { removeLogCapture, restoreLogCapture, type RemovedCapture } from '@/lib/health/publish';
import { offerUndo, type UndoOffer, type UndoWords } from '@/lib/nutrition/undo-store';
import { excerpt } from '@/lib/utils/excerpt';

/** "weight", "body-fat", but "HRV" — a label as it reads inside a sentence. */
function inSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
}

/** The glyph a capture's own door tile or row draws. */
function iconFor(capture: CaptureRecord): UndoOffer['icon'] {
  if (capture.kind === 'body') return 'scale-outline';
  if (capture.kind === 'wearable') {
    return metricByWearableType(capture.metricType ?? '')?.key === 'water'
      ? 'water-outline'
      : 'pulse-outline';
  }
  if (capture.kind === 'symptom') return 'pulse-outline';
  if (capture.category === 'Therapies') return 'thermometer-outline';
  if (capture.category === 'Supplements' || capture.category === 'Medications') {
    return 'medkit-outline';
  }
  return 'reader-outline';
}

/**
 * What the Undo row says for one capture, PURE. A measurement names its kind
 * in the sentence and puts its figure in mono after it — "Removed weight ·
 * 178.4 lb" — because serif speaks and mono measures (00-design-spec.md §3). A
 * line of words is named by the line itself: "Removed Creatine · 5 g",
 * "Removed the note “Slept badly, 3am wake”".
 */
export function captureUndoWords(capture: CaptureRecord): UndoWords & { refusal: string } {
  const icon = iconFor(capture);
  if (capture.note) {
    const text = `the note “${excerpt(capture.title, 40)}”`;
    return {
      icon,
      said: `Removed ${text}`,
      figure: null,
      spoken: `Undo removing ${text}`,
      refusal: 'Could not put the note back.',
    };
  }
  if (capture.measure) {
    const noun = inSentence(capture.category);
    return {
      icon,
      said: `Removed ${noun}`,
      figure: capture.title,
      spoken: `Undo removing ${noun}, ${capture.title}`,
      refusal: `Could not put ${noun} ${capture.title} back.`,
    };
  }
  return {
    icon,
    said: `Removed ${capture.title}`,
    figure: null,
    spoken: `Undo removing ${capture.title}`,
    refusal: `Could not put ${capture.title} back.`,
  };
}

/**
 * Delete one capture — its × on the Log tab — and offer it back under the day
 * it was filed on. Null when the feed lists no such capture; nothing is
 * offered then.
 */
export function removeCaptureWithUndo(db: Database, feedId: string): RemovedCapture | null {
  const removed = removeLogCapture(db, feedId);
  if (!removed) return null;
  const { capture } = removed.taken;
  offerUndo({
    scope: { on: 'log', date: capture.date },
    ...captureUndoWords(capture),
    // Throws when the row cannot come back (the store marks the offer refused);
    // the Apple Health half runs after and never throws.
    undo: () => {
      void restoreLogCapture(db, removed);
    },
    // A capture owns no files.
    settle: () => {},
  });
  return removed;
}
