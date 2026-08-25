import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { ReportPreview } from '@/components/reports/preview';
import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useStoredReport } from '@/hooks/use-reports';
// The key store directly, NOT `isCoachKeyConfigured` from coach-service: that
// module pulls the whole 40-tool registry and the system prompt in behind it,
// and this screen needs one boolean. Same answer, a fraction of the graph.
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { getDb } from '@/lib/db/client';
import { deleteReport, insertReport } from '@/lib/db/repositories/reports';
import { assembleDoctorPack } from '@/lib/reports/assemble-doctor-pack';
import { assembleSelfReview } from '@/lib/reports/assemble-self-review';
import { CoachReadUnavailableError, generateCoachRead } from '@/lib/reports/coach-read';
import { periodFromBounds } from '@/lib/reports/period';
import { fileWritingAvailable, writeReportFile } from '@/lib/reports/report-file';
import type { CoachRead, PeriodKind, ReportData } from '@/lib/reports/types';

/**
 * The report preview — a draft on its way to being saved, or a persisted one
 * re-read from its snapshot (docs/reports-subapp.md §6).
 *
 * ## Two states, one renderer
 *
 * A DRAFT is assembled here, synchronously, from route params (the period's
 * bounds, or nothing at all for a doctor pack). A PERSISTED report is
 * re-rendered FROM `data_json` and never re-assembled — a correction landing
 * tomorrow must not change what you handed your doctor last week. Both feed the
 * same `ReportPreview`, which is the same `ReportData` the HTML file is written
 * from.
 *
 * ## The accent
 *
 * **"Save & share" is the one accent in this whole flow.** It is the only
 * action that puts a file on disk and offers it to the world; everything else
 * on both screens is neutral ink. "Add Coach's read" deliberately is not
 * accented — it is optional, reversible-by-not-saving, and giving the model
 * surface the loudest mark on the sheet would misstate what the document is.
 *
 * ## Degraded states, all four enumerated
 *
 *   - **No sharing** (`expo-sharing` rides the next EAS build): the file is
 *     still written and the outcome is `saved` with the full path in an alert.
 *   - **No file system at all** (web logic-check preview): the action is
 *     disabled up front and says so, rather than offering a tap that can only
 *     report `unavailable`.
 *   - **No API key**: "Add Coach's read" is disabled and names where the key
 *     goes. The report is unaffected — it is complete and shareable without one.
 *   - **Incomplete profile** on a doctor pack: the header prints authored
 *     blanks, and a margin note above the preview names what is missing. The
 *     generate screen cannot warn earlier than this without assembling, and
 *     assembling IS this screen.
 */

export default function ReportViewScreen() {
  const params = useLocalSearchParams<{
    id?: string;
    kind?: string;
    periodKind?: string;
    start?: string;
    end?: string;
  }>();

  const stored = useStoredReport(params.id);
  const isDraft = params.id == null;
  const router = useRouter();

  // The draft, assembled once. In the `useState` initializer rather than an
  // effect: op-sqlite is synchronous, so there is no spinner state to model,
  // and the headless render suite exercises the real assembly this way.
  const [draft] = useState<ReportData | null>(() => {
    if (params.id != null) return null;
    const db = getDb();
    const appVersion = Constants.expoConfig?.version ?? null;
    if (params.kind === 'doctor_pack') return assembleDoctorPack(db, { appVersion });
    const period = periodFromBounds(
      (params.periodKind ?? 'custom') as PeriodKind,
      params.start ?? '',
      params.end ?? ''
    );
    if (!period) return null;
    return assembleSelfReview(db, period, { appVersion });
  });

  const data = isDraft ? draft : stored.data;
  const [read, setRead] = useState<CoachRead | null>(null);
  const shownRead = isDraft ? read : stored.read;

  const [busy, setBusy] = useState<'saving' | 'reading' | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const canWrite = fileWritingAvailable();
  const keySet = apiKeyStore.has();

  // Both flows below await multi-second work and then touch state or a global
  // Alert. If the user taps back mid-flight the screen unmounts, and Alert.alert
  // — a native surface with no component lifecycle — would otherwise pop over
  // the Reports list about an action on a screen they already left. A mounted
  // flag gates every post-await UI call; the read also carries an AbortController
  // so its streaming request is cancelled on unmount rather than left to finish
  // into the void.
  const mountedRef = useRef(true);
  const readAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readAbortRef.current?.abort();
    };
  }, []);

  const share = useCallback(async () => {
    if (!data || busy) return;
    setBusy('saving');
    setNote(null);
    try {
      const written = await writeReportFile(data, shownRead);
      if (written.outcome.status === 'unavailable') {
        if (mountedRef.current) setNote('No file system on this runtime — nothing was written.');
        return;
      }
      if (written.outcome.status === 'failed') {
        if (mountedRef.current) {
          setNote('Could not write the file.');
          Alert.alert('Report failed', written.outcome.message);
        }
        return;
      }
      // The row lands only once the FILE exists. A ledger entry pointing at a
      // file that was never written is worse than no entry: the history would
      // offer a "share again" that re-renders fine and quietly hides that the
      // original hand-off never happened.
      //
      // The insert is guarded because this runs behind `void share()`: a schema
      // CHECK rejecting the row would otherwise become an unhandled rejection
      // with no user-facing trace, on a tap that DID write the file. The file
      // is the artefact; failing to file it is worth an alert, not a crash.
      // The insert is the real work and lands regardless of mount state — the
      // file exists, so the history row that points at it should too, even if
      // the user has left the screen. Only the UI reactions to it are gated.
      if (isDraft && savedId == null) {
        try {
          const id = insertReport(getDb(), {
            data,
            read: shownRead,
            fileName: written.fileName,
            filePath: written.relativePath,
          });
          if (mountedRef.current) setSavedId(id);
        } catch (error) {
          if (mountedRef.current) {
            Alert.alert(
              'Written, but not filed',
              `The file was written, but this report could not be added to your history:\n\n` +
                `${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
      if (!mountedRef.current) return;
      if (written.outcome.status === 'shared') {
        setNote(`Shared · ${written.fileName}`);
      } else {
        setNote(`Saved · ${written.fileName}`);
        Alert.alert(
          'Report saved',
          `Written to the app’s Documents folder:\n\n${written.outcome.uri}\n\n` +
            'The share sheet arrives with the next build. To turn it into a PDF today: ' +
            'open it in Safari → Print → Save as PDF.'
        );
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [data, busy, shownRead, isDraft, savedId]);

  const addRead = useCallback(async () => {
    if (!data || data.kind !== 'self_review' || busy) return;
    const controller = new AbortController();
    readAbortRef.current = controller;
    setBusy('reading');
    setNote(null);
    try {
      const result = await generateCoachRead(data, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setRead(result);
    } catch (error) {
      // The screen may already be gone — the user tapped back while the
      // multi-second streaming call was in flight, which aborts the request.
      // An alert about a read on a screen they have left is worse than silence.
      if (!mountedRef.current || controller.signal.aborted) return;
      const message =
        error instanceof CoachReadUnavailableError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      setNote(null);
      Alert.alert('No read written', message);
    } finally {
      if (readAbortRef.current === controller) readAbortRef.current = null;
      if (mountedRef.current) setBusy(null);
    }
  }, [data, busy]);

  if (!data) {
    return (
      <Screen scroll edges={['top', 'bottom']}>
        <StackHeader title="Report" parent="Reports" />
        <View className="mt-7">
          <Block device="plate">
            <Text className="font-serif text-[14px] leading-[21px] text-ink-secondary">
              {stored.unreadable
                ? 'This report was written by a different version of ARC and cannot be re-rendered here. The file it produced is unaffected.'
                : 'That report is gone, or the range it was asked for is not a real one.'}
            </Text>
          </Block>
        </View>
      </Screen>
    );
  }

  const profileGap =
    data.kind === 'doctor_pack' && data.patient.incomplete ? data.patient.missing : null;
  const alreadySaved = !isDraft || savedId != null;

  return (
    <Screen scroll edges={['top', 'bottom']}>
      <StackHeader title={isDraft ? 'Draft report' : 'Report'} parent="Reports" />

      {profileGap ? (
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[12.5px] leading-[18px] text-ink-secondary">
              Missing from your profile: {profileGap}. The pack still generates — those lines print
              as recorded blanks rather than guesses. Settings › Profile fills them in.
            </Text>
          </Block>
        </View>
      ) : null}

      <ReportPreview data={data} read={shownRead} />

      {/* The footer. One accent, on the one action that leaves the device. */}
      <View className="mt-8">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            alreadySaved ? 'Share this report again' : 'Save and share this report'
          }
          accessibilityState={{ disabled: !canWrite || busy != null }}
          disabled={!canWrite || busy != null}
          onPress={() => void share()}
          className={`min-h-[48px] flex-row items-center justify-center gap-2 rounded-btn px-4 py-3 ${
            canWrite && busy == null
              ? 'bg-pine active:opacity-70'
              : 'border border-hairline bg-paper-dim'
          }`}>
          <Ionicons
            name="share-outline"
            size={18}
            color={canWrite && busy == null ? palette.pineOn : palette.inkMuted}
          />
          <Text
            className={
              canWrite && busy == null
                ? 'font-label text-[15px] font-semibold text-pine-on'
                : 'font-label text-[15px] font-semibold text-ink-muted'
            }>
            {busy === 'saving' ? 'Writing…' : alreadySaved ? 'Share again' : 'Save & share'}
          </Text>
        </Pressable>

        {/* Only BEFORE saving (spec §6a: the prose appears in the preview,
            attributed, before anything is saved). Once the row exists its
            `narrative_text` is fixed, so adding a read afterwards would put
            prose on screen that the STORED report does not carry — and the next
            time this report is opened from the history it would silently have
            lost it. A report is a record of what was shared; the moment it
            becomes one, its contents stop being editable. */}
        {isDraft && !alreadySaved && data.kind === 'self_review' && shownRead == null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add the Coach's read to this report"
            accessibilityState={{ disabled: !keySet || busy != null }}
            disabled={!keySet || busy != null}
            onPress={() => void addRead()}
            className="mt-3 min-h-[44px] items-center justify-center border border-hairline px-4 py-2.5 active:opacity-60">
            <Text
              className={
                keySet && busy == null
                  ? 'font-label text-[14px] font-semibold text-ink'
                  : 'font-label text-[14px] font-semibold text-ink-muted'
              }>
              {busy === 'reading' ? 'Reading…' : "Add Coach's read"}
            </Text>
            {!keySet ? (
              <Text className="mt-1 font-serif text-[11.5px] text-ink-muted">
                Add a key in Settings › Coach
              </Text>
            ) : null}
          </Pressable>
        ) : null}

        {!canWrite ? (
          <Text className="mt-3 font-serif text-[12px] leading-[17px] text-ink-secondary">
            This runtime has no file system, so nothing can be written. On the device the report
            saves to the app’s Documents folder.
          </Text>
        ) : null}
        {note ? <Text className="mt-3 font-mono text-[11px] text-ink-muted">{note}</Text> : null}

        {/* Persisted reports only. Arm/confirm (the coach-memory idiom), muted
            never-accent. Removes the ROW — the record of what was shared; the
            HTML file is deliberately left, per deleteReport's header.
            (2026-08-13 review fix: the spec promised this and no code called
            deleteReport.) */}
        {!isDraft && params.id != null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete this report"
            onPress={() =>
              Alert.alert(
                'Delete this report?',
                'The record of what was generated and shared is removed for good. Any copy you already shared is unaffected.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                      deleteReport(getDb(), String(params.id));
                      router.back();
                    },
                  },
                ]
              )
            }
            className="mt-6 min-h-[44px] items-center justify-center active:opacity-60">
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Delete report
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}
