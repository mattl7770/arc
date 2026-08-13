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
import { BODY_PUBLISH_METRICS } from '@/lib/health/mapping';
import { syncHealthData } from '@/lib/health/sync';

/**
 * Settings › Apple Health — the wearables hub toggle (docs/wearables-subapp.md §7).
 *
 * Honesty rules this screen lives by:
 *   - The native module rides the NEXT EAS build; until then the screen says so
 *     plainly (same posture as the Coach key screen's memory-only state).
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
 * body measurements it owns (docs/wearables-subapp.md §10). It is replaced, not
 * deleted — the replacement has to be at least as specific as the promise it
 * retires, so "What ARC writes" names all three types, says publishing starts
 * from the moment you connect, and says plainly that corrections don't follow.
 *
 * Conformed Set treatment: the connection state is a **ruled plate** carrying
 * its own action, the read and write scopes are **ruled plates** (a list of
 * things is a record), and the explanatory passages are **margin annotations**.
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

/** What ARC asks to read, in human words (mirrors HEALTH_READ_IDENTIFIERS). */
const READ_SCOPES = [
  'Sleep (duration and stages)',
  'Heart-rate variability and resting heart rate',
  'Steps and active / resting energy',
  'Respiratory rate and blood oxygen',
  'Body and sleeping-wrist temperature',
  'VO₂max and workouts',
];

/** What ARC publishes, in human words (mirrors BODY_PUBLISH_METRICS). */
const WRITE_SCOPES = BODY_PUBLISH_METRICS.map((m) => m.label);

/**
 * The one line to show about write access, or null when there is nothing
 * honest and useful to say (unsupported / unknown / granted — in the granted
 * case the "What ARC writes" plate below already covers it, and repeating it
 * here would be noise).
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

      {/* What ARC reads — a list of things, so a ruled plate. */}
      <View className="mt-8">
        <SectionLabel label="What ARC reads" />
        <View className="mt-3">
          <Block device="plate">
            {READ_SCOPES.map((scope, index) => (
              <View key={scope}>
                <Divider first={index === 0} />
                <View className="min-h-[44px] flex-row items-center gap-3 py-3">
                  <Ionicons name="pulse-outline" size={16} color={palette.inkMuted} />
                  <Text className="flex-1 font-serif text-[13.5px] text-ink-secondary">
                    {scope}
                  </Text>
                </View>
              </View>
            ))}
          </Block>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              Data lands in the on-device database and shows up in Data → Wearables and Home&rsquo;s
              readiness.
            </Text>
          </Block>
        </View>
      </View>

      {/* What ARC writes — the counterpart record. Three items, named exactly. */}
      <View className="mt-8">
        <SectionLabel label="What ARC writes" />
        <View className="mt-3">
          <Block device="plate">
            {WRITE_SCOPES.map((scope, index) => (
              <View key={scope}>
                <Divider first={index === 0} />
                <View className="min-h-[44px] flex-row items-center gap-3 py-3">
                  <Ionicons name="arrow-up-outline" size={16} color={palette.inkMuted} />
                  <Text className="flex-1 font-serif text-[13.5px] text-ink-secondary">
                    {scope}
                  </Text>
                </View>
              </View>
            ))}
          </Block>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              Nothing else is written — no workouts, no meals, no sleep. ARC publishes these three
              from the moment you connect; measurements recorded before that stay in ARC only.
              Editing or deleting one here does not change the copy already in Apple Health — remove
              that in the Health app.
            </Text>
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
