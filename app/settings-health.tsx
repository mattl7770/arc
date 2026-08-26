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
import { getHealthSyncState } from '@/lib/db/repositories/wearables';
import {
  healthWriteAccess,
  isHealthKitAvailable,
  isHealthKitSupported,
  requestHealthPermissions,
  type HealthWriteAccess,
} from '@/lib/health/healthkit';
import {
  GARMIN_ONLY_METRICS,
  METRIC_COVERAGE,
  type SourceVerdict,
} from '@/lib/health/coverage';
import { BODY_INGEST_METRICS } from '@/lib/health/mapping';
import { syncHealthData } from '@/lib/health/sync';

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
 * and a two-list layout could only have shown that by printing them twice.
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
 * actually wired; the read-only rows are grouped by hand because twelve
 * identifiers read as six ideas.
 */
const SYNC_SCOPES: readonly { label: string; direction: SyncDirection }[] = [
  ...BODY_INGEST_METRICS.map((m) => ({ label: m.label, direction: 'both' as const })),
  { label: 'Sleep (duration and stages)', direction: 'in' },
  { label: 'Heart-rate variability and resting heart rate', direction: 'in' },
  { label: 'Steps and active / resting energy', direction: 'in' },
  { label: 'Respiratory rate and blood oxygen', direction: 'in' },
  { label: 'Body and sleeping-wrist temperature', direction: 'in' },
  { label: 'VO₂max and workouts', direction: 'in' },
];

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
      return 'Apple Health is refusing writes from ARC, so nothing is being published. Turn Weight, Body Fat Percentage and Waist Circumference on under Settings → Privacy & Security → Health → ARC.';
    case 'partial':
      return 'Apple Health is accepting only some of what ARC publishes. Check Weight, Body Fat Percentage and Waist Circumference under Settings → Privacy & Security → Health → ARC.';
    default:
      return null;
  }
}

export default function SettingsHealthScreen() {
  const router = useRouter();
  const supported = isHealthKitSupported();

  const [enabled, setEnabled] = useState(() => isHealthSyncEnabled(getDb()));
  const [lastSyncedAt, setLastSyncedAt] = useState(() => getHealthSyncState(getDb()).lastSyncedAt);
  const [busy, setBusy] = useState<'enabling' | 'syncing' | 'allowing' | null>(null);
  const [lastRows, setLastRows] = useState<number | null>(null);
  const [lastPublished, setLastPublished] = useState<number | null>(null);
  const [writeAccess, setWriteAccess] = useState<HealthWriteAccess>(() => healthWriteAccess());

  const refresh = useCallback(() => {
    const db = getDb();
    setEnabled(isHealthSyncEnabled(db));
    setLastSyncedAt(getHealthSyncState(db).lastSyncedAt);
    setWriteAccess(healthWriteAccess());
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
      await requestHealthPermissions();
      const result = await syncHealthData(db);
      if (result.status === 'synced') {
        setLastRows(result.rowsWritten);
        setLastPublished(result.samplesPublished);
      }
    } finally {
      setBusy(null);
      refresh();
    }
  }, [busy, refresh]);

  /**
   * Ask for the WRITE scopes on their own. Needed because read access can
   * predate them: anyone who connected Apple Health before publishing shipped
   * has answered the read sheet and will never be asked again by `enable`,
   * leaving sharing permanently undetermined and every publish refused. Only
   * rendered while that is actually the state, so it can't be a no-op control —
   * iOS won't re-present a sheet the user has already answered.
   */
  const allowPublishing = useCallback(async () => {
    if (busy) return;
    setBusy('allowing');
    try {
      await requestHealthPermissions();
      const result = await syncHealthData(getDb());
      if (result.status === 'synced') {
        setLastRows(result.rowsWritten);
        setLastPublished(result.samplesPublished);
      }
    } finally {
      setBusy(null);
      refresh();
    }
  }, [busy, refresh]);

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
      const result = await syncHealthData(getDb());
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
                The HealthKit module is installed but not in this dev build yet. Run the next EAS
                build (docs/dev-build.md) and this screen goes live — nothing else to set up.
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

              {writeAccess === 'undetermined' ? (
                <>
                  <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                    ARC hasn&rsquo;t been given permission to publish your weight, body fat and
                    waist to Apple Health yet.
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
              fat and waist from the moment you connect; measurements recorded before that stay in
              ARC only. Editing or deleting one here does not change the copy already in Apple
              Health — remove that in the Health app. A measurement that arrived from Apple Health
              is marked as such and is never sent back.
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
              in Garmin Connect, and no amount of waiting will change that. Unverified — Garmin
              publishes no answer either way and this has not been checked against a device.
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
