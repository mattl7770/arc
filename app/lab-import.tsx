import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useSessionKeySet } from '@/hooks/use-session-key';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { importLabReport, listLabReportDates } from '@/lib/db/repositories/labs';
import { defaultIncluded, isImportable, mapExtraction } from '@/lib/labs/map';
import { extractLabReport, LabParseUnavailableError, LabPdfRejectedError } from '@/lib/labs/parse';
import { isPdfPickerAvailable, pickLabPdf, PdfPickerUnavailableError } from '@/lib/labs/pick-pdf';
import type { LabExtraction, MappedResult } from '@/lib/labs/types';

/**
 * Import a lab PDF → editable review → confirm (docs/labs-subapp.md §4).
 *
 * NOTHING is stored until Save. A parsed panel is a proposal: the model reads a
 * scanned document, and the failure that matters is not a visibly wrong number
 * but a plausible one filed under the wrong marker. So every row is shown with
 * what was printed, what it mapped to, and why — and the rows that can't be
 * trusted (unit conflicts, repeats) arrive switched off. Same discipline as
 * app/meal-estimate.tsx, for the same reason.
 *
 * ONLINE-EXCEPT-AI: the parse is the one step that leaves the device. Picking
 * the file, mapping it to the catalog, editing, and storing are all offline.
 *
 * ## The surface system
 *
 * Three devices, each earning its keep (src/components/ui/block.tsx):
 *   - the advisories about what leaves the device are **margin annotations** —
 *     prose about the sheet, drawn in the margin of the sheet;
 *   - the review rows are a **ruled plate**, because a parsed panel is a record;
 *   - the two editable fields are **recessed stock** — an input well recesses,
 *     which is what tells you it takes your writing rather than reports back.
 *     They are styled inline rather than wrapped in `<Block device="well">` on
 *     purpose: wrapping puts the well's padding *outside* the TextInput, so the
 *     recess would look like a 44pt target while only its ~20pt text line
 *     actually focuses on tap.
 *
 * **The accent budget is one per phase, and it is always the write.** "Choose a
 * PDF" while there is nothing to review, "Save" once there is. The inclusion
 * checkboxes are deliberately *ink*, not accent: fifty accent ticks would spend
 * the whole budget on chrome and leave the one irreversible action indis-
 * tinguishable from the rows above it. (Home stamps completions in the accent
 * because completion is its budget; selection is not completion.)
 *
 * ## The tally reconciles
 *
 * The Results note states exactly what Save will write — `included` counts rows
 * that are both switched on and hold a usable number — so the section header
 * and the button can never disagree, and a row switched on with an unparseable
 * value says so on its own line rather than quietly inflating a count.
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'parsing' }
  | { kind: 'review' }
  // `recoverable` marks an error raised AFTER a panel was already reviewed (a
  // failed save). Dropping back to 'input' there would throw away every
  // inclusion and edit the user just made and demand a whole re-parse — which
  // costs another model call. Those errors go back to the review instead.
  | { kind: 'error'; message: string; recoverable?: boolean };

/** One review row: the mapped result plus the user's edits to it. */
type ReviewRow = {
  mapped: MappedResult;
  include: boolean;
  /**
   * The value field's text, seeded from the mapped value and freely editable
   * thereafter — including empty. Deriving the displayed text from the mapped
   * value whenever this is blank would make the field impossible to clear: the
   * moment you backspaced the last character it would snap back.
   */
  valueText: string;
};

const STATUS_LABEL: Record<MappedResult['status'], string> = {
  matched: 'matched',
  converted: 'converted',
  new: 'new marker',
  unit_conflict: 'unit conflict',
  duplicate: 'repeat',
};

/**
 * The row's value as it would be stored, or null when the field isn't a usable
 * number. Interpreted in the row's CANONICAL unit — which is the unit rendered
 * beside the field, so a converted row's edit means what the label says.
 */
function parseValue(row: ReviewRow): number | null {
  const t = row.valueText.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Lab values carry at most a couple of decimals; conversions produce more. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A YYYY-MM-DD that the schema's GLOB and the CHECK will both accept. */
function validDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const dt = new Date(y!, m! - 1, d!);
  return dt.getFullYear() === y && dt.getMonth() === m! - 1 && dt.getDate() === d;
}

export default function LabImportScreen() {
  const router = useRouter();
  const keySet = useSessionKeySet();
  // Capability probe, not app state: a module-level require + typeof that can
  // never change while the app runs. Read once so render stays pure.
  const [pickerReady] = useState(isPdfPickerAvailable);

  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [extraction, setExtraction] = useState<LabExtraction | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [collectedOn, setCollectedOn] = useState('');
  const [fileRef, setFileRef] = useState<{ uri: string; name: string } | null>(null);
  const [rawJson, setRawJson] = useState<string | null>(null);
  // Draw dates that already have a report, loaded once when a parse lands so the
  // same-date check below stays a pure in-memory lookup.
  const [existingDates, setExistingDates] = useState<Set<string>>(() => new Set());

  const run = async () => {
    let picked;
    try {
      picked = await pickLabPdf();
    } catch (error) {
      setPhase({
        kind: 'error',
        message:
          error instanceof PdfPickerUnavailableError
            ? error.message
            : 'Couldn’t open the file picker.',
      });
      return;
    }
    // The user backed out of the picker — not an error state.
    if (!picked) return;

    setFileRef({ uri: picked.uri, name: picked.name });
    setPhase({ kind: 'parsing' });
    try {
      const today = todayISODate();
      const { extraction: parsed, rawJson: json } = await extractLabReport(picked.base64, today);
      const mapped = mapExtraction(getDb(), parsed);
      setExtraction(parsed);
      setRawJson(json);
      setRows(
        mapped.map((m) => ({
          mapped: m,
          include: defaultIncluded(m),
          valueText: String(round(m.value)),
        }))
      );
      setExistingDates(new Set(listLabReportDates(getDb())));
      setCollectedOn(parsed.collectedOn ?? '');
      setPhase({ kind: 'review' });
    } catch (error) {
      const message =
        error instanceof LabParseUnavailableError || error instanceof LabPdfRejectedError
          ? error.message
          : error instanceof Error && error.message
            ? error.message
            : 'Couldn’t read that report. Check your connection and try again.';
      setPhase({ kind: 'error', message });
    }
  };

  /**
   * Toggle one row, keeping at most ONE included row per biomarker.
   *
   * `lab_results` allows a single value per biomarker per report, so two
   * included rows resolving to the same slug would abort the entire import at
   * save time. These reports genuinely repeat markers across health areas, so
   * the second occurrence has to stay selectable — switching it on switches its
   * sibling off, rather than the whole panel failing later.
   */
  const toggle = (key: string) => {
    setRows((prev) => {
      const target = prev.find((r) => r.mapped.key === key);
      if (!target || !isImportable(target.mapped)) return prev;
      const turningOn = !target.include;
      return prev.map((r) => {
        if (r.mapped.key === key) return { ...r, include: turningOn };
        if (turningOn && r.include && r.mapped.slug === target.mapped.slug) {
          return { ...r, include: false };
        }
        return r;
      });
    });
  };
  const setValue = (key: string, text: string) => {
    setRows((prev) => prev.map((r) => (r.mapped.key === key ? { ...r, valueText: text } : r)));
  };

  const included = rows.filter((r) => r.include && parseValue(r) !== null);
  const dateOk = validDate(collectedOn) && collectedOn <= todayISODate();
  const canSave = dateOk && included.length > 0;
  // A second report on the same draw date is usually a re-import of the same
  // PDF, which would put two values on one day's trend point. Surfaced as a
  // warning, not a block — occasionally there really are two.
  const sameDate = dateOk && existingDates.has(collectedOn);

  const save = () => {
    if (!canSave) return;
    try {
      importLabReport(getDb(), {
        collectedOn,
        labName: extraction?.labName ?? null,
        filePath: fileRef?.uri ?? null,
        rawJson,
        notes: extraction?.notes ?? null,
        results: included.map((r) => ({
          slug: r.mapped.slug,
          name: r.mapped.displayName,
          category: r.mapped.category,
          unit: r.mapped.unit,
          value: parseValue(r)!,
          standardLow: r.mapped.refLow,
          standardHigh: r.mapped.refHigh,
        })),
      });
      router.back();
    } catch (error) {
      console.warn('[lab-import] save failed', error);
      setPhase({
        kind: 'error',
        message: 'Couldn’t save those results. Your review is still here — try again.',
        recoverable: true,
      });
    }
  };

  // --- No key: the parse is the one step that needs one ----------------------
  if (!keySet) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Import a lab report" />
        </View>
        <Text className="mt-3 font-serif text-[14px] leading-6 text-ink-secondary">
          Reading a lab PDF needs a model key — the same one the Coach uses.
        </Text>
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-muted">
              Add a key in Settings › Coach, then come back. It’s the only part of this that goes
              online; matching, reviewing and storing all happen on your phone.
            </Text>
          </Block>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Import a lab report" />
      </View>

      {phase.kind === 'input' ? (
        <View className="mt-3">
          <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
            Pick the PDF you downloaded from Function Health. It’s read once to pull out your
            biomarker values — then you review every one before anything is saved.
          </Text>

          {/* The one accent in this phase: the only action that does anything. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose a PDF"
            accessibilityState={{ disabled: !pickerReady }}
            disabled={!pickerReady}
            onPress={() => void run()}
            className={`mt-5 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn px-4 py-3 ${
              pickerReady ? 'bg-pine active:opacity-70' : 'border border-hairline bg-paper-dim'
            }`}>
            <Ionicons
              name="document-text-outline"
              size={18}
              color={pickerReady ? palette.pineOn : palette.inkMuted}
            />
            <Text
              className={
                pickerReady
                  ? 'font-label text-[15px] font-semibold text-pine-on'
                  : 'font-label text-[15px] font-semibold text-ink-muted'
              }>
              Choose a PDF
            </Text>
          </Pressable>
          {!pickerReady ? (
            <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
              The file picker needs a native build — it won’t open in this preview.
            </Text>
          ) : null}

          {/* Prose about the sheet → the margin annotation. */}
          <View className="mt-5">
            <Block device="margin">
              <Text className="font-serif text-[12.5px] leading-5 text-ink-muted">
                The PDF is sent to your model provider to be read. Nothing else about your data
                leaves the device, and the original file is never uploaded anywhere else.
              </Text>
            </Block>
          </View>
        </View>
      ) : null}

      {phase.kind === 'parsing' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color={palette.pine} />
          <Text className="mt-4 font-serif text-[14px] text-ink-secondary">
            Reading the report…
          </Text>
          <Text className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
            A full panel can take a minute
          </Text>
        </View>
      ) : null}

      {phase.kind === 'error' ? (
        <View className="mt-6">
          <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
            {phase.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => setPhase(phase.recoverable ? { kind: 'review' } : { kind: 'input' })}
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 py-3 active:opacity-60">
            <Text className="font-label text-[14px] font-semibold text-ink">Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {phase.kind === 'review' && extraction ? (
        <View className="mt-3">
          <Text className="font-serif text-[19px] font-semibold text-ink">
            {extraction.labName ?? 'Lab report'}
          </Text>
          {fileRef ? (
            <Text className="mt-1 font-mono text-[10px] text-ink-muted" numberOfLines={1}>
              {fileRef.name}
            </Text>
          ) : null}

          <View className="mt-5">
            <SectionLabel label="Drawn on" />
            {/* Recessed stock, inline — see the note at the top of this file on
                why this is not wrapped in <Block device="well">. */}
            <TextInput
              value={collectedOn}
              onChangeText={setCollectedOn}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={palette.inkMuted}
              accessibilityLabel="Collection date"
              className="mt-2 h-11 border border-paper-deep bg-paper-dim px-3.5 font-mono text-[15px] text-ink"
            />
            {!dateOk ? (
              <Text className="mt-1.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
                {collectedOn === ''
                  ? 'No draw date was found in the report — enter the date the blood was taken.'
                  : 'Enter the draw date as YYYY-MM-DD (it can’t be in the future).'}
              </Text>
            ) : null}
            {sameDate ? (
              <Text className="mt-1.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
                A report from this date is already imported. Saving adds a second one.
              </Text>
            ) : null}
          </View>

          {extraction.notes || extraction.qualitative.length > 0 ? (
            <View className="mt-4">
              <Block device="margin">
                {extraction.notes ? (
                  <Text className="font-serif text-[12.5px] leading-5 text-ink-secondary">
                    {extraction.notes}
                  </Text>
                ) : null}
                {extraction.qualitative.length > 0 ? (
                  <Text
                    className={
                      extraction.notes
                        ? 'mt-2 font-serif text-[12.5px] leading-5 text-ink-muted'
                        : 'font-serif text-[12.5px] leading-5 text-ink-muted'
                    }>
                    {extraction.qualitative.length} results were reported in words rather than
                    numbers (urinalysis descriptors like “Negative”). They’re kept with the report
                    but aren’t charted.
                  </Text>
                ) : null}
              </Block>
            </View>
          ) : null}

          <View className="mt-6">
            <Block device="plate">
              {/* States exactly what Save will write, so the header and the
                  button can never disagree. */}
              <SectionLabel
                label="Results"
                note={`${included.length} of ${rows.length} to import`}
              />
              <View className="mt-1">
                {rows.map((row, index) => {
                  const m = row.mapped;
                  const importable = isImportable(m);
                  const value = parseValue(row);
                  return (
                    <View key={m.key}>
                      <Divider first={index === 0} />
                      <View className="py-3">
                        <View className="flex-row items-center gap-3">
                          {/* Selection, not completion — so it is drawn in ink.
                            Square, like every other mark in this set. */}
                          <Pressable
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: row.include, disabled: !importable }}
                            accessibilityLabel={`Include ${m.displayName}`}
                            disabled={!importable}
                            hitSlop={12}
                            onPress={() => toggle(m.key)}
                            className={
                              row.include
                                ? 'h-[22px] w-[22px] items-center justify-center bg-ink'
                                : 'h-[22px] w-[22px] items-center justify-center border-[1.5px] border-hairline'
                            }>
                            {row.include ? (
                              <Ionicons name="checkmark" size={14} color={palette.paperHi} />
                            ) : null}
                          </Pressable>

                          <View className="flex-1">
                            <Text className="font-serif text-[15px] leading-5 text-ink">
                              {m.displayName}
                            </Text>
                            <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                              {STATUS_LABEL[m.status]}
                              {m.printedName !== m.displayName ? ` · “${m.printedName}”` : ''}
                            </Text>
                          </View>

                          <TextInput
                            value={row.valueText}
                            onChangeText={(t) => setValue(m.key, t)}
                            keyboardType="decimal-pad"
                            editable={importable}
                            accessibilityLabel={`${m.displayName} value`}
                            className="h-11 w-20 border border-paper-deep bg-paper-dim px-2 text-right font-mono text-[13px] text-ink"
                          />
                          <Text className="w-16 font-mono text-[11px] text-ink-muted">
                            {m.unit ?? ''}
                          </Text>
                        </View>

                        {m.status === 'converted' ? (
                          <Text className="mt-1.5 font-mono text-[10px] text-ink-muted">
                            printed {m.qualifier ?? ''}
                            {round(m.reportedValue)} {m.reportedUnit}
                          </Text>
                        ) : null}
                        {m.status === 'unit_conflict' ? (
                          <Text className="mt-1.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
                            Reported in {m.reportedUnit}, but ARC tracks this in {m.unit}, and these
                            two don’t convert. Left out — add it by hand if you know the conversion.
                          </Text>
                        ) : null}
                        {m.status === 'duplicate' ? (
                          <Text className="mt-1.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
                            This marker already appears above. Reports repeat markers across
                            sections — only one value can be stored per report.
                          </Text>
                        ) : null}
                        {m.qualifier && m.status !== 'converted' ? (
                          <Text className="mt-1.5 font-mono text-[10px] text-ink-muted">
                            printed as {m.qualifier}
                            {round(m.reportedValue)} {m.reportedUnit}
                          </Text>
                        ) : null}
                        {value === null ? (
                          <Text className="mt-1.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
                            Not a number — fix it or leave it out.
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            </Block>
          </View>

          {/* The one accent in this phase: the write. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save results"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            onPress={save}
            className={`mt-6 min-h-[44px] items-center justify-center rounded-btn px-4 py-3 ${
              canSave ? 'bg-pine active:opacity-70' : 'border border-hairline bg-paper-dim'
            }`}>
            <Text
              className={
                canSave
                  ? 'font-label text-[15px] font-semibold text-pine-on'
                  : 'font-label text-[15px] font-semibold text-ink-muted'
              }>
              Save {included.length} result{included.length === 1 ? '' : 's'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard"
            onPress={() => router.back()}
            className="mt-1 min-h-[44px] items-center justify-center px-4 py-3 active:opacity-60">
            <Text className="font-label text-[13px] font-medium text-ink-muted">Discard</Text>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}
