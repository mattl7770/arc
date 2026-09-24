import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO } from '@/lib/db/date';
import { isHealthSyncEnabled, setHealthSyncEnabled } from '@/lib/db/repositories/user';
import {
  getHealthScopeStamp,
  getHealthSyncLog,
  getHealthSyncState,
  stampHealthScopes,
} from '@/lib/db/repositories/wearables';
import { metricNote, publishNote, WORKOUT_HR_METRIC, type HealthSyncLog } from '@/lib/health/log';
import {
  healthWriteAccess,
  isHealthKitAvailable,
  isHealthKitSupported,
  requestHealthPermissions,
  unaskedWriteIdentifiers,
  type HealthWriteAccess,
} from '@/lib/health/healthkit';
import { GARMIN_ONLY_METRICS, METRIC_COVERAGE, type SourceVerdict } from '@/lib/health/coverage';
import {
  BODY_INGEST_METRICS,
  BODY_PUBLISH_METRICS,
  HEALTH_READ_IDENTIFIERS,
  unaskedReadScopes,
  WATER_PUBLISH_METRIC,
} from '@/lib/health/mapping';
import { FIRST_SYNC_DAYS, requestFreshHealthSync, startHealthSync } from '@/lib/health/sync';

/**
 * Settings › Apple Health — the wearables hub toggle (docs/wearables-subapp.md §7).
 *
 * Honesty rules this screen lives by:
 *   - The screen is honest about whether the native module is in this binary —
 *     on web/node, or a build predating the module, it says so plainly (same
 *     posture as the Coach key screen's memory-only state).
 *   - iOS never reveals whether READ access was granted — after enabling we say
 *     "connected" but point at Settings → Privacy → Health when data looks
 *     missing, and never render a granted/denied matrix (it's unknowable).
 *   - WRITE access is the exception: iOS reports sharing authorization
 *     truthfully, so this screen states it rather than assuming success. A
 *     refused publish gets said out loud; an unanswered one gets a button.
 *   - Permission is requested LAZILY — only on enable, never at boot.
 *
 * The read-only claim this screen used to make ("ARC never writes to Apple
 * Health") became false on 2026-08-12, when ARC started PUBLISHING the three
 * body measurements it owns, and the same day those three started coming back
 * INBOUND too (docs/wearables-subapp.md §10–11). Both replacements are at least
 * as specific as the promise they retire: every scope is named with its
 * direction, publishing is said to start from the moment you connect, and it is
 * said plainly that corrections don't follow and that ingested measurements are
 * never sent back.
 *
 * Water joined them on 2026-09-21 (§20) and is the exception to "corrections
 * don't follow": a capture's own id is the tag on its sample, so the Undo and
 * the water screen's edit and delete reach Apple Health too — and the screen
 * says that about water specifically rather than letting the body sentence
 * speak for it.
 *
 * Conformed Set treatment: the connection state is a **ruled plate** carrying
 * its own action, the scope list is a **ruled plate** (a list of things is a
 * record), and the explanatory passages are **margin annotations**.
 *
 * **Zero accent.** This is a Settings screen, and Settings carries no accent at
 * all (00-design-spec.md §2) — so Enable is a solid *ink* action, not pine, and
 * the connected check is ink too. Connection is chrome, not biology, so no
 * signal colour either.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtSyncedAt(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()} · ${clockFromISO(iso)}`;
}

/**
 * Which way each thing moves. The user's actual question about a health
 * integration is not "what does it touch" but "who is writing my record", so the
 * two old lists (What ARC reads / What ARC writes) are one record with a
 * direction per row — the three body measurements are now genuinely both ways,
 * and a two-list layout could only have shown that by printing them twice. Water
 * is the fourth two-way row since 2026-09-21.
 */
type SyncDirection = 'both' | 'in' | 'out';

const DIRECTION_LABEL: Record<SyncDirection, string> = {
  both: 'Both',
  in: 'In',
  out: 'Out',
};

const DIRECTION_ICON: Record<
  SyncDirection,
  'swap-vertical-outline' | 'arrow-down-outline' | 'arrow-up-outline'
> = {
  both: 'swap-vertical-outline',
  in: 'arrow-down-outline',
  out: 'arrow-up-outline',
};

/**
 * Every scope, in human words, with its direction. The two-way rows come from
 * {@link BODY_INGEST_METRICS} so their labels cannot drift from the types
 * actually wired; the read-only rows are grouped by hand because fourteen
 * identifiers read as eight ideas.
 */
const SYNC_SCOPES: readonly { label: string; direction: SyncDirection }[] = [
  ...BODY_INGEST_METRICS.map((m) => ({ label: m.label, direction: 'both' as const })),
  // Both ways since 2026-09-21, so it moved up among the two-way rows. It was
  // "In only, and it must stay that way" until then; the argument for that was
  // right about the mechanism and wrong about the conclusion — the cumulative
  // read now excludes ARC's own samples (docs/wearables-subapp.md §20).
  { label: 'Water (hydration)', direction: 'both' },
  { label: 'Sleep (duration and stages)', direction: 'in' },
  { label: 'Heart-rate variability and resting heart rate', direction: 'in' },
  // Its own row rather than folded into the line above: this one is read for
  // ONE purpose (the session's own average and maximum) and never becomes a
  // daily figure, which is a different promise from the two resting measures.
  { label: 'Heart rate during workouts', direction: 'in' },
  { label: 'Steps and active / resting energy', direction: 'in' },
  { label: 'Respiratory rate and blood oxygen', direction: 'in' },
  { label: 'Body and sleeping-wrist temperature', direction: 'in' },
  { label: 'VO₂max and workouts', direction: 'in' },
];

/** What each published type is called in a sentence — "weight", "water". */
const WRITE_WORDS: ReadonlyMap<string, string> = new Map(
  [...BODY_PUBLISH_METRICS, WATER_PUBLISH_METRIC].map((m) => [
    m.hkIdentifier,
    m.label.toLowerCase(),
  ])
);

/** ["weight", "body fat", "water"] → "weight, body fat and water". */
function spokenList(words: readonly string[]): string {
  return words.length < 2
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The coverage tag. Deliberately three words with no colour: a source that does
 * not send a metric is a fact about the vendor, not a biological signal, and
 * `signal-*` marks biology only (00-design-spec.md).
 */
const VERDICT_LABEL: Record<SourceVerdict, string> = {
  yes: 'Sends',
  no: 'Never',
  unverified: 'Unverified',
};

const VERDICT_SPOKEN: Record<SourceVerdict, string> = {
  yes: 'Garmin sends this.',
  no: 'Garmin never sends this.',
  unverified: 'Unverified.',
};

/**
 * The one line to show about write access, or null when there is nothing
 * honest and useful to say (unsupported / unknown / granted — in the granted
 * case the "What syncs" plate below already covers it, and repeating it here
 * would be noise).
 */
function writeAccessNote(access: HealthWriteAccess): string | null {
  switch (access) {
    case 'denied':
      return 'Apple Health is refusing writes from ARC, so nothing is being published. Turn Weight, Body Fat Percentage, Waist Circumference and Water on under Settings → Privacy & Security → Health → ARC.';
    case 'partial':
      return 'Apple Health is accepting only some of what ARC publishes. Check Weight, Body Fat Percentage, Waist Circumference and Water under Settings → Privacy & Security → Health → ARC.';
    // `incomplete` (a type never asked) and `undetermined` get the ask control
    // below instead of a sentence pointing at iOS Settings, where a type ARC has
    // never requested is not even listed.
    default:
      return null;
  }
}

export default function SettingsHealthScreen() {
  const router = useRouter();
  const supported = isHealthKitSupported();

  const [enabled, setEnabled] = useState(() => isHealthSyncEnabled(getDb()));
  const [lastSyncedAt, setLastSyncedAt] = useState(() => getHealthSyncState(getDb()).lastSyncedAt);
  const [busy, setBusy] = useState<'enabling' | 'syncing' | 'allowing' | 'heartRate' | null>(null);
  const [lastRows, setLastRows] = useState<number | null>(null);
  const [lastPublished, setLastPublished] = useState<number | null>(null);
  const [writeAccess, setWriteAccess] = useState<HealthWriteAccess>(() => healthWriteAccess());
  const [unaskedWrites, setUnaskedWrites] = useState<string[]>(() => unaskedWriteIdentifiers());
  const [log, setLog] = useState<HealthSyncLog | null>(() => getHealthSyncLog(getDb()));
  const [unasked, setUnasked] = useState<string[]>(() =>
    unaskedReadScopes(getHealthScopeStamp(getDb()))
  );

  const refresh = useCallback(() => {
    const db = getDb();
    setEnabled(isHealthSyncEnabled(db));
    setLastSyncedAt(getHealthSyncState(db).lastSyncedAt);
    setWriteAccess(healthWriteAccess());
    setUnaskedWrites(unaskedWriteIdentifiers());
    setLog(getHealthSyncLog(db));
    setUnasked(unaskedReadScopes(getHealthScopeStamp(db)));
  }, []);

  /**
   * Ask, and record that ARC asked. The stamp is what makes a LATE read scope
   * recoverable: adding one to `HEALTH_READ_IDENTIFIERS` asks nobody anything
   * on an install that has already answered the sheet, because iOS presents it
   * only for unanswered types. It records the asking, never a grant — read
   * grants are not knowable.
   */
  const askForScopes = useCallback(async () => {
    const processed = await requestHealthPermissions();
    if (processed) stampHealthScopes(getDb(), HEALTH_READ_IDENTIFIERS);
    return processed;
  }, []);

  const enable = useCallback(async () => {
    if (busy) return;
    setBusy('enabling');
    try {
      const db = getDb();
      setHealthSyncEnabled(db, true);
      setEnabled(true);
      // Lazy permission ask — the whole sheet, first time only; iOS shows it
      // only for types the user hasn't answered yet, so repeats are no-ops.
      await askForScopes();
      const result = await startHealthSync(db);
      if (result.status === 'synced') {
        setLastRows(result.rowsWritten);
        setLastPublished(result.samplesPublished);
      }
    } finally {
      setBusy(null);
      refresh();
    }
  }, [askForScopes, busy, refresh]);

  /**
   * Ask for the WRITE scopes on their own. Needed because read access can
   * predate them: anyone who connected Apple Health before publishing shipped
   * has answered the read sheet and will never be asked again by `enable`,
   * leaving sharing permanently undetermined and every publish refused. Only
   * rendered while that is actually the state, so it can't be a no-op control —
   * iOS won't re-present a sheet the user has already answered.
   *
   * Since 2026-09-21 "that state" is keyed on {@link unaskedWriteIdentifiers},
   * not on one access value: water became a write type after the owner had
   * granted the other three, which reads as `incomplete` — and under the old
   * condition (`undetermined` only) this control never appeared, water was
   * never requested, and every water save would have been refused for good.
   */
  const allowPublishing = useCallback(async () => {
    if (busy) return;
    setBusy('allowing');
    try {
      await askForScopes();
      const result = await startHealthSync(getDb());
      if (result.status === 'synced') {
        setLastRows(result.rowsWritten);
        setLastPublished(result.samplesPublished);
      }
    } finally {
      setBusy(null);
      refresh();
    }
  }, [askForScopes, busy, refresh]);

  /**
   * Ask for the heart-rate scope, then re-read 90 days with it.
   *
   * The re-read is the half that is easy to forget: the steady-state window is
   * a fortnight, the 90-day backfill runs only on a first sync, and the Coach's
   * training summary looks back 28 days — so without this, most of the history
   * every heart-rate surface feeds would stay blank however the sheet was
   * answered. It passes a `windowDays` override rather than clearing
   * `firstSyncedAt`, whose re-stamp is deliberately conditional on a pass having
   * written something so a denied permission cannot burn the one-time backfill.
   */
  const readHeartRate = useCallback(async () => {
    if (busy) return;
    setBusy('heartRate');
    try {
      await askForScopes();
      const result = await startHealthSync(getDb(), new Date(), { windowDays: FIRST_SYNC_DAYS });
      if (result.status === 'synced') {
        setLastRows(result.rowsWritten);
        setLastPublished(result.samplesPublished);
      }
    } finally {
      setBusy(null);
      refresh();
    }
  }, [askForScopes, busy, refresh]);

  const disable = useCallback(() => {
    if (busy) return;
    setHealthSyncEnabled(getDb(), false);
    // Ingested rows stay — they're the user's data; only the syncing stops.
    refresh();
  }, [busy, refresh]);

  const syncNow = useCallback(async () => {
    if (busy) return;
    setBusy('syncing');
    try {
      // A pass that reads from THIS tap on: never a second one beside a pass
      // already running (the foreground sync, or a blank cell on Home), and
      // never that pass either, which may have started before whatever the user
      // just pushed into Apple Health — it queues one follow-up behind it. The
      // three setup flows above use `startHealthSync`: their pass has to read
      // AFTER the permission sheet they have just shown, some with a wider window.
      const result = await requestFreshHealthSync(getDb());
      if (result.status === 'synced') {
        setLastRows(result.rowsWritten);
        setLastPublished(result.samplesPublished);
      }
    } finally {
      setBusy(null);
      refresh();
    }
  }, [busy, refresh]);

  const available = supported && isHealthKitAvailable();
  const writeNote = writeAccessNote(writeAccess);

  /**
   * Whether to offer *Read heart rate (90 days)*, and the whole of why it is a
   * control rather than something the sync does by itself.
   *
   * It shows while connected AND either something is unasked, OR the last
   * `workout_hr` row says every session was seen and none produced a figure.
   * Honestly stated: on a FRESH install `enable` stamps every scope and this
   * never appears; on an EXISTING install it appears once, and iOS presents a
   * sheet for Heart Rate alone because the others are already answered.
   *
   * It stays visible after an ask that produced nothing, because that is the one
   * state in which tapping again can change something — if the sheet was
   * declined iOS will not re-present it, and the only recovery is the iOS
   * Settings path the note names, after which the re-read is one tap. It
   * disappears once a figure lands.
   *
   * Not folded into `syncHealthData`: that runs on every foreground, so the
   * sheet would appear over whatever screen the owner had returned to.
   */
  const hrLog = log?.metrics.find((m) => m.metric === WORKOUT_HR_METRIC) ?? null;
  const offerHeartRate =
    enabled && (unasked.length > 0 || (hrLog !== null && hrLog.returned > 0 && hrLog.rows === 0));

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Apple Health" />
      </View>

      {/* Status / action plate. Demoted to a `field` by the sweep of 2026-08-10
          and restored the same day at the owner's instruction — the connection
          state carries its own action, and a block holding a heading, a
          paragraph and a button is a record, not a verdict. (The demotion was
          argued partly on `field` drawing no marks at the time. It draws its
          corner ticks again as of 2026-08-11, so that half of the argument is
          void in both directions; this stays a plate on the content test.) */}
      <View className="mt-3">
        <Block device="plate">
          {!supported ? (
            <>
              <Text className="font-serif text-[16px] font-semibold text-ink">
                Rides the next build
              </Text>
              <Text className="mt-1 font-serif text-[12.5px] leading-5 text-ink-secondary">
                The HealthKit module isn&rsquo;t in this build yet. Run the next EAS build
                (docs/dev-build.md).
              </Text>
            </>
          ) : !enabled ? (
            <>
              <Text className="font-serif text-[16px] font-semibold text-ink">
                Connect Apple Health
              </Text>
              {/* The 2026-08-11 sweep cut this line back to "First sync pulls 90
                  days." on the grounds that the closing annotation under "What
                  ARC reads" said the same thing. It does not: that annotation
                  says ARC never WRITES to Apple Health. The clause cut with it
                  was the setup PRECONDITION — a wearable reaches ARC only via
                  its vendor app's own Health sync — and it was stated nowhere
                  else, so a user with no vendor app installed enabled, got an
                  empty sync, and was aimed by the connected state's
                  troubleshooting line at Privacy → Health — a different failure
                  entirely. The precondition is back; the privacy restatement is
                  not. */}
              <Text className="mt-1 font-serif text-[12.5px] leading-5 text-ink-secondary">
                Your ring or watch must sync to Apple Health through its own app. First sync pulls
                90 days.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Enable Apple Health"
                accessibilityState={{ disabled: busy !== null || !available }}
                disabled={busy !== null || !available}
                onPress={() => void enable()}
                className={`mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn py-3.5 ${
                  available ? 'bg-ink active:opacity-70' : 'border border-hairline bg-paper-dim'
                }`}>
                {busy === 'enabling' ? (
                  <ActivityIndicator size="small" color={palette.paperHi} />
                ) : (
                  <Ionicons
                    name="heart-outline"
                    size={18}
                    color={available ? palette.paperHi : palette.inkMuted}
                  />
                )}
                <Text
                  className={`font-label text-[15px] font-semibold ${
                    available ? 'text-paper-hi' : 'text-ink-muted'
                  }`}>
                  {busy === 'enabling' ? 'Syncing 90 days…' : 'Enable Apple Health'}
                </Text>
              </Pressable>
              {!available ? (
                <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                  Health data isn&rsquo;t available on this device.
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <View className="flex-row items-center gap-2.5">
                {/* A completion mark, stamped square in ink — chrome, not biology,
                    and Settings spends no accent on it either. */}
                <View className="h-[22px] w-[22px] items-center justify-center bg-ink">
                  <Ionicons name="checkmark" size={14} color={palette.paperHi} />
                </View>
                <Text className="font-serif text-[16px] font-semibold text-ink">Connected</Text>
              </View>
              <Text className="mt-2 font-mono text-[11px] text-ink-muted">
                {lastSyncedAt
                  ? `Last synced ${fmtSyncedAt(lastSyncedAt)}${lastRows !== null ? ` · ${lastRows} rows in` : ''}${
                      lastPublished !== null ? ` · ${lastPublished} published` : ''
                    }`
                  : 'Not synced yet'}
              </Text>
              <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                iOS doesn&rsquo;t tell apps whether read access was granted — if data looks missing,
                check Settings → Privacy &amp; Security → Health → ARC.
              </Text>
              {/* Writing IS knowable, so it gets stated rather than guessed. */}
              {writeNote ? (
                <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                  {writeNote}
                </Text>
              ) : null}

              {unaskedWrites.length > 0 ? (
                <>
                  <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                    {`ARC hasn’t been given permission to publish your ${spokenList(
                      unaskedWrites.map((id) => WRITE_WORDS.get(id) ?? id)
                    )} to Apple Health yet.`}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Allow ARC to publish to Apple Health"
                    accessibilityState={{ disabled: busy !== null }}
                    disabled={busy !== null}
                    onPress={() => void allowPublishing()}
                    className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
                    {busy === 'allowing' ? (
                      <ActivityIndicator size="small" color={palette.ink} />
                    ) : (
                      <Ionicons name="arrow-up-circle-outline" size={16} color={palette.ink} />
                    )}
                    <Text className="font-label text-[14px] font-medium text-ink">
                      {busy === 'allowing' ? 'Asking…' : 'Allow publishing'}
                    </Text>
                  </Pressable>
                </>
              ) : null}

              {/* The late-scope control (docs §15). Modelled on "Allow
                  publishing" above, and rendered on the same principle: only
                  while tapping it can actually change something. */}
              {offerHeartRate ? (
                <>
                  <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                    ARC can read the heart rate recorded during a workout and show it on the
                    session. It was added after you connected, so it has to be asked for on its own.
                    If nothing appears, turn Heart Rate on under Settings → Privacy &amp; Security →
                    Health → ARC, then tap this again.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Read heart rate from Apple Health and re-read 90 days"
                    accessibilityState={{ disabled: busy !== null }}
                    disabled={busy !== null}
                    onPress={() => void readHeartRate()}
                    className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
                    {busy === 'heartRate' ? (
                      <ActivityIndicator size="small" color={palette.ink} />
                    ) : (
                      <Ionicons name="pulse-outline" size={16} color={palette.ink} />
                    )}
                    <Text className="font-label text-[14px] font-medium text-ink">
                      {busy === 'heartRate' ? 'Syncing 90 days…' : 'Read heart rate (90 days)'}
                    </Text>
                  </Pressable>
                </>
              ) : null}

              <View className="mt-4 flex-row gap-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sync now"
                  accessibilityState={{ disabled: busy !== null }}
                  disabled={busy !== null}
                  onPress={() => void syncNow()}
                  className="min-h-[44px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
                  {busy === 'syncing' ? (
                    <ActivityIndicator size="small" color={palette.ink} />
                  ) : (
                    <Ionicons name="refresh-outline" size={16} color={palette.ink} />
                  )}
                  <Text className="font-label text-[14px] font-medium text-ink">
                    {busy === 'syncing' ? 'Syncing…' : 'Sync now'}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Turn off Apple Health sync"
                  accessibilityState={{ disabled: busy !== null }}
                  disabled={busy !== null}
                  onPress={disable}
                  className="min-h-[44px] flex-1 items-center justify-center rounded-btn border border-hairline py-3 active:bg-paper-dim">
                  <Text className="font-label text-[14px] text-ink-secondary">Turn off</Text>
                </Pressable>
              </View>
            </>
          )}
        </Block>
      </View>

      {/* The last sync, step by step — the answer to "it's not working".
          A ledger of what each metric did, so a ruled plate.

          This section exists because of 2026-08-25: weight stopped arriving
          from Apple Health and no surface in the app could say which step
          produced zero. Every failure in the pipeline is silent by design — a
          refused query predicate returns nothing, an unattributable sample is
          dropped, one bad day never sinks a window — so an empty read looked
          exactly like a quiet week, and the only bug report the app made
          possible was "not working". Counts, not prose: the number HealthKit
          returned, then the number that reached the database. */}
      {enabled ? (
        <View className="mt-8">
          <SectionLabel label="Last sync" note={log ? `${log.windowDays}d window` : undefined} />
          <View className="mt-3">
            <Block device="plate">
              {log === null ? (
                <View className="py-3">
                  <Text className="font-serif text-[13.5px] text-ink-secondary">
                    No sync has run yet.
                  </Text>
                </View>
              ) : (
                log.metrics.map((entry, index) => {
                  const note = metricNote(entry);
                  return (
                    <View key={entry.metric}>
                      <Divider first={index === 0} />
                      <View
                        accessible
                        accessibilityLabel={`${entry.label}. ${entry.returned} read from Apple Health, ${entry.rows} kept.${note ? ` ${note}` : ''}`}
                        className="py-3">
                        <View className="flex-row items-center gap-3">
                          <Text className="flex-1 font-serif text-[13.5px] text-ink">
                            {entry.label}
                          </Text>
                          {/* One interpolation, not two: adjacent expressions
                              become separate text children, which RN is free to
                              lay out apart and which no substring assertion can
                              see as one measurement. */}
                          <Text className="font-mono text-[11px] text-ink-muted">
                            {`${entry.returned} → ${entry.rows}`}
                          </Text>
                        </View>
                        {note ? (
                          <Text className="mt-1 font-serif text-[11px] leading-4 text-ink-muted">
                            {note}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })
              )}
            </Block>
          </View>

          {log !== null ? (
            <>
              <View className="mt-3">
                <Block device="plate">
                  <Divider first />
                  <View
                    accessible
                    accessibilityLabel={`Published to Apple Health. ${log.publish.succeeded} of ${log.publish.attempted} accepted. ${publishNote(log.publish)}`}
                    className="py-3">
                    <View className="flex-row items-center gap-3">
                      <Text className="flex-1 font-serif text-[13.5px] text-ink">
                        Published out
                      </Text>
                      <Text className="font-mono text-[11px] text-ink-muted">
                        {`${log.publish.succeeded} / ${log.publish.attempted}`}
                      </Text>
                    </View>
                    <Text className="mt-1 font-serif text-[11px] leading-4 text-ink-muted">
                      {publishNote(log.publish)}
                    </Text>
                  </View>
                  {log.publish.types.map((type) => (
                    <View key={type.label}>
                      <Divider />
                      <View
                        accessible
                        accessibilityLabel={`${type.label}. ${type.succeeded} of ${type.attempted} accepted.`}
                        className="flex-row items-center gap-3 py-3">
                        <Text className="flex-1 font-serif text-[13.5px] text-ink-secondary">
                          {type.label}
                        </Text>
                        <Text className="font-mono text-[11px] text-ink-muted">
                          {`${type.succeeded} / ${type.attempted}`}
                        </Text>
                      </View>
                    </View>
                  ))}
                </Block>
              </View>

              <View className="mt-4">
                <Block device="margin">
                  <Text className="font-serif text-[11px] leading-4 text-ink-muted">
                    Each row reads: measurements Apple Health returned → measurements ARC kept.
                  </Text>
                  <Text className="mt-2 font-mono text-[11px] text-ink-muted">
                    {`${log.rowsWritten} rows changed`}
                  </Text>
                </Block>
              </View>
            </>
          ) : null}
        </View>
      ) : null}

      {/* What syncs, and which way — a list of things, so a ruled plate. */}
      <View className="mt-8">
        <SectionLabel label="What syncs" />
        <View className="mt-3">
          <Block device="plate">
            {SYNC_SCOPES.map((scope, index) => (
              <View key={scope.label}>
                <Divider first={index === 0} />
                <View
                  accessible
                  accessibilityLabel={`${scope.label}. ${
                    scope.direction === 'both'
                      ? 'Reads and writes.'
                      : scope.direction === 'in'
                        ? 'Reads only.'
                        : 'Writes only.'
                  }`}
                  className="min-h-[44px] flex-row items-center gap-3 py-3">
                  <Ionicons
                    name={DIRECTION_ICON[scope.direction]}
                    size={16}
                    color={palette.inkMuted}
                  />
                  <Text className="flex-1 font-serif text-[13.5px] text-ink-secondary">
                    {scope.label}
                  </Text>
                  {/* A filled tag, never a bordered one — a one-sided border
                      beside a border colour paints a full rectangle in RN. */}
                  <View className="rounded bg-paper-dim px-1.5 py-0.5">
                    <Text className="font-label text-[10px] text-ink-muted">
                      {DIRECTION_LABEL[scope.direction]}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </Block>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              In — Apple Health to ARC. Out — ARC to Apple Health. Incoming data lands in the
              on-device database and shows up in Data → Wearables, the weight trend and Home&rsquo;s
              readiness.
            </Text>
            <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
              Nothing else is written — no workouts, no meals, no sleep. ARC publishes weight, body
              fat and waist from the moment you connect, and water from the first sync after it was
              added; anything recorded before that stays in ARC only. Editing or deleting a weight,
              body-fat or waist entry here does not change the copy already in Apple Health — remove
              that in the Health app. A measurement that arrived from Apple Health is marked as such
              and is never sent back.
            </Text>
            {/* The double-count sentence. Water has two live doors — the Log
                tab's vessels and anything writing hydration to Apple Health —
                and since 2026-09-21 ARC writes to the second one too. Its own
                glasses are kept out of what comes back (docs §20), so nothing
                ARC wrote is counted twice; what cannot be reconciled is the
                same glass entered twice by hand, one door each. So the rule
                stays behavioural, and it belongs where the doors are named.

                Slop pass 4 (docs/ai-slop-candidates-2026-09.md §11): "Water
                goes both ways." restated the Both tag on the scope row above,
                and the side-by-side clause narrated a screen the route already
                names. The timing, the corrections, the echo, the rule and the
                route all stay. */}
            <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
              A glass you log here is written to Apple Health as soon as you log it, and undoing or
              correcting it here changes it there too. Apple Health sends back one total per day
              with ARC&rsquo;s own glasses left out, so none is counted twice. A glass tapped on the
              watch and typed here is two glasses — log it in one place. A doubled day is fixed in
              Data → Water.
            </Text>
          </Block>
        </View>
      </View>

      {/* Per-metric coverage — the user-facing half of the audit table in
          docs/wearables-subapp.md §12. A list of things, so a ruled plate.

          This section exists because "connected" is not the same as "you will
          get everything": four of the fifteen read scopes are types a Garmin
          never writes to Apple Health, and without this list they read as ARC
          being broken rather than as the source not sending them. */}
      <View className="mt-8">
        <SectionLabel label="Per-metric coverage" note="Garmin" />
        <View className="mt-3">
          <Block device="plate">
            {METRIC_COVERAGE.map((metric, index) => (
              <View key={metric.hkIdentifier}>
                <Divider first={index === 0} />
                <View
                  accessible
                  accessibilityLabel={`${metric.label}. ${VERDICT_SPOKEN[metric.garmin]} ${metric.garminNote}`}
                  className="py-3">
                  <View className="flex-row items-center gap-3">
                    <Text className="flex-1 font-serif text-[13.5px] text-ink">{metric.label}</Text>
                    {/* Filled tag, never a bordered one — a one-sided border
                        beside a border colour paints a full rectangle in RN. */}
                    <View className="rounded bg-paper-dim px-1.5 py-0.5">
                      <Text className="font-label text-[10px] text-ink-muted">
                        {VERDICT_LABEL[metric.garmin]}
                      </Text>
                    </View>
                  </View>
                  <Text className="mt-1 font-serif text-[11px] leading-4 text-ink-muted">
                    {metric.garminNote}
                  </Text>
                  {metric.verdictDays !== null ? (
                    <Text className="mt-1 font-mono text-[10px] text-ink-muted">
                      {metric.verdictDays === 1
                        ? 'Reads from the first night'
                        : `${metric.verdictDays} days of readings before a verdict`}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </Block>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              Sends — Garmin Connect writes it to Apple Health, so ARC can read it. Never — it stays
              in Garmin Connect, and a later sync will not bring it. Unverified — Garmin publishes
              no answer either way and this has not been checked against a device.
            </Text>
            {GARMIN_ONLY_METRICS.map((metric) => (
              <Text
                key={metric.label}
                className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                {metric.label} — {metric.note}
              </Text>
            ))}
          </Block>
        </View>
      </View>

      {/* Jump to the history view */}
      <View className="mt-8">
        <Block device="plate">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open wearable history"
            onPress={() => router.push('/wearables')}
            className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
            <Ionicons name="analytics-outline" size={18} color={palette.inkSecondary} />
            <Text className="flex-1 font-serif text-[15px] text-ink">Wearable history</Text>
            <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
          </Pressable>
        </Block>
      </View>
    </Screen>
  );
}
