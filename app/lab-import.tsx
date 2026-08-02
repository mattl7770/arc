import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
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

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
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
        <Text className="mt-2 text-[13px] leading-5 text-ink-secondary">
          Reading a lab PDF needs a model key — the same one the Coach uses.
        </Text>
        <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
          Add a key in Settings › Coach, then come back. It’s the only part of this that goes
          online; matching, reviewing and storing all happen on your phone.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Import a lab report" />
      </View>

      {phase.kind === 'input' ? (
        <View className="mt-2">
          <Text className="text-[13px] leading-5 text-ink-secondary">
            Pick the PDF you downloaded from Function Health. It’s read once to pull out your
            biomarker values — then you review every one before anything is saved.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose a PDF"
            accessibilityState={{ disabled: !pickerReady }}
            disabled={!pickerReady}
            onPress={() => void run()}
            className={`mt-4 h-12 flex-row items-center justify-center gap-2 rounded-btn ${
              pickerReady ? 'bg-pine active:opacity-70' : 'bg-hairline'
            }`}>
            <Ionicons
              name="document-text-outline"
              size={18}
              color={pickerReady ? palette.pineOn : palette.inkMuted}
            />
            <Text
              className={`text-[15px] font-semibold ${
                pickerReady ? 'text-pine-on' : 'text-ink-muted'
              }`}>
              Choose a PDF
            </Text>
          </Pressable>
          {!pickerReady ? (
            <Text className="mt-2 text-xs leading-5 text-ink-muted">
              The file picker needs a native build — it won’t open in this preview.
            </Text>
          ) : null}
          <Text className="mt-3 text-xs leading-5 text-ink-muted">
            The PDF is sent to your model provider to be read. Nothing else about your data leaves
            the device, and the original file is never uploaded anywhere else.
          </Text>
        </View>
      ) : null}

      {phase.kind === 'parsing' ? (
        <View className="mt-10 items-center">
          <ActivityIndicator color={palette.pine} />
          <Text className="mt-3 text-[13px] text-ink-muted">Reading the report…</Text>
          <Text className="mt-1 text-xs text-ink-muted">A full panel can take a minute.</Text>
        </View>
      ) : null}

      {phase.kind === 'error' ? (
        <View className="mt-6">
          <Text className="text-[13px] leading-5 text-ink-secondary">{phase.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => setPhase(phase.recoverable ? { kind: 'review' } : { kind: 'input' })}
            className="mt-3 h-12 items-center justify-center rounded-btn border border-hairline-strong active:bg-paper-deep">
            <Text className="text-[14px] font-semibold text-ink">Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {phase.kind === 'review' && extraction ? (
        <View className="mt-2">
          <View className="flex-row items-baseline gap-2">
            <Text className="flex-1 font-serif text-lg font-semibold text-ink">
              {extraction.labName ?? 'Lab report'}
            </Text>
            <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
              {rows.length} rows
            </Text>
          </View>

          <View className="mt-4">
            <SectionLabel>Drawn on</SectionLabel>
            <TextInput
              value={collectedOn}
              onChangeText={setCollectedOn}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={palette.inkMuted}
              accessibilityLabel="Collection date"
              className="mt-2 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 font-mono text-[15px] text-ink"
            />
            {!dateOk ? (
              <Text className="mt-1 text-xs leading-5 text-ink-secondary">
                {collectedOn === ''
                  ? 'No draw date was found in the report — enter the date the blood was taken.'
                  : 'Enter the draw date as YYYY-MM-DD (it can’t be in the future).'}
              </Text>
            ) : null}
            {sameDate ? (
              <Text className="mt-1 text-xs leading-5 text-ink-secondary">
                A report from this date is already imported. Saving adds a second one.
              </Text>
            ) : null}
          </View>

          {extraction.notes ? (
            <Text className="mt-3 text-xs leading-5 text-ink-secondary">{extraction.notes}</Text>
          ) : null}
          {extraction.qualitative.length > 0 ? (
            <Text className="mt-2 text-xs leading-5 text-ink-muted">
              {extraction.qualitative.length} results were reported in words rather than numbers
              (urinalysis descriptors like “Negative”). They’re kept with the report but aren’t
              charted.
            </Text>
          ) : null}

          <View className="mt-5">
            <SectionLabel>Results</SectionLabel>
            <View className="mt-3">
              {rows.map((row, index) => {
                const m = row.mapped;
                const importable = isImportable(m);
                const value = parseValue(row);
                return (
                  <View
                    key={m.key}
                    className={`py-3 ${index === 0 ? '' : 'border-t border-hairline-soft'}`}>
                    <View className="flex-row items-center gap-3">
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: row.include, disabled: !importable }}
                        accessibilityLabel={`Include ${m.displayName}`}
                        disabled={!importable}
                        hitSlop={8}
                        onPress={() => toggle(m.key)}
                        className={`h-5 w-5 items-center justify-center rounded-full border ${
                          row.include
                            ? 'border-pine bg-pine'
                            : 'border-hairline-strong bg-porcelain'
                        }`}>
                        {row.include ? (
                          <Ionicons name="checkmark" size={12} color={palette.pineOn} />
                        ) : null}
                      </Pressable>

                      <View className="flex-1">
                        <Text className="text-[15px] leading-5 text-ink">{m.displayName}</Text>
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
                        className="w-20 rounded-btn border border-hairline-soft bg-paper-deep px-2 py-1.5 text-right font-mono text-[13px] text-ink"
                      />
                      {/* An em dash, never blank: a row whose unit the report
                          omitted would otherwise read as "Lp(a) 75" with
                          nothing to say the unit is unknown. */}
                      <Text className="w-16 font-mono text-[11px] text-ink-muted">
                        {m.unit ?? '—'}
                      </Text>
                    </View>

                    {m.status === 'converted' ? (
                      <Text className="mt-1 font-mono text-[10px] text-ink-muted">
                        printed {m.qualifier ?? ''}
                        {round(m.reportedValue)} {m.reportedUnit}
                      </Text>
                    ) : null}
                    {/* Two ways a row gets blocked, and they need different
                        sentences. `m.unit` is the row's OWN unit — the printed
                        one here — so the catalog's has to come from
                        `m.catalogUnit` or the first sentence contradicts
                        itself ("reported in mg/dL, tracked in mg/dL"). */}
                    {m.status === 'unit_conflict' && m.reportedUnit ? (
                      <Text className="mt-1 text-xs leading-5 text-ink-secondary">
                        Reported in {m.reportedUnit}, but ARC tracks this in {m.catalogUnit}, and
                        these two don’t convert. Left out — add it by hand if you know the
                        conversion.
                      </Text>
                    ) : null}
                    {m.status === 'unit_conflict' && !m.reportedUnit ? (
                      <Text className="mt-1 text-xs leading-5 text-ink-secondary">
                        No unit was printed for this result. ARC tracks this marker in{' '}
                        {m.catalogUnit}, but assuming that would be a guess — plenty of markers are
                        reported in more than one unit, and the two can differ several times over.
                        Left out — check the report and add it by hand.
                      </Text>
                    ) : null}
                    {m.status === 'duplicate' ? (
                      <Text className="mt-1 text-xs leading-5 text-ink-secondary">
                        This marker already appears above. Reports repeat markers across sections —
                        only one value can be stored per report.
                      </Text>
                    ) : null}
                    {m.qualifier && m.status !== 'converted' ? (
                      <Text className="mt-1 font-mono text-[10px] text-ink-muted">
                        {/* The unit is conditional, not a trailing " {unit}": a row whose
                            unit the report never printed would otherwise render a dangling
                            space after the number. */}
                        printed as {m.qualifier}
                        {round(m.reportedValue)}
                        {m.reportedUnit ? ` ${m.reportedUnit}` : ''}
                      </Text>
                    ) : null}
                    {value === null ? (
                      <Text className="mt-1 text-xs leading-5 text-ink-secondary">
                        Not a number — fix it or leave it out.
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save results"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            onPress={save}
            className={`mt-5 h-12 items-center justify-center rounded-btn ${
              canSave ? 'bg-pine active:opacity-70' : 'bg-hairline'
            }`}>
            <Text
              className={`text-[15px] font-semibold ${
                canSave ? 'text-pine-on' : 'text-ink-muted'
              }`}>
              Save {included.length} result{included.length === 1 ? '' : 's'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard"
            onPress={() => router.back()}
            className="mt-2 items-center py-2 active:opacity-60">
            <Text className="text-[13px] text-ink-muted">Discard</Text>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}
