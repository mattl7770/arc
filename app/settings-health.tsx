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
  isHealthKitAvailable,
  isHealthKitSupported,
  requestHealthPermissions,
} from '@/lib/health/healthkit';
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
 *   - Permission is requested LAZILY — only on enable, never at boot.
 *
 * Conformed Set treatment: the connection state is a **ruled plate** carrying
 * its own action, the read scopes are a **ruled plate** (a list of things is a
 * record), and the two explanatory passages are **margin annotations**.
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

export default function SettingsHealthScreen() {
  const router = useRouter();
  const supported = isHealthKitSupported();

  const [enabled, setEnabled] = useState(() => isHealthSyncEnabled(getDb()));
  const [lastSyncedAt, setLastSyncedAt] = useState(() => getHealthSyncState(getDb()).lastSyncedAt);
  const [busy, setBusy] = useState<'enabling' | 'syncing' | null>(null);
  const [lastRows, setLastRows] = useState<number | null>(null);

  const refresh = useCallback(() => {
    const db = getDb();
    setEnabled(isHealthSyncEnabled(db));
    setLastSyncedAt(getHealthSyncState(db).lastSyncedAt);
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
      if (result.status === 'synced') setLastRows(result.rowsWritten);
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
      if (result.status === 'synced') setLastRows(result.rowsWritten);
    } finally {
      setBusy(null);
      refresh();
    }
  }, [busy, refresh]);

  const available = supported && isHealthKitAvailable();

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Apple Health" />
      </View>

      {/* Status / action plate. Demoted to a `field` (which draws nothing) by
          the sweep of 2026-08-10; restored the same day at the owner's
          instruction — the connection state carries its own action, and a block
          that holds a heading, a paragraph and a button is a record. */}
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
              <Text className="mt-1 font-serif text-[12.5px] leading-5 text-ink-secondary">
                ARC reads your wearable data on-device — your ring or watch syncs to Apple Health
                through its own app, and nothing leaves this phone. First sync pulls 90 days.
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
                  ? `Last synced ${fmtSyncedAt(lastSyncedAt)}${lastRows !== null ? ` · ${lastRows} rows` : ''}`
                  : 'Not synced yet'}
              </Text>
              <Text className="mt-2 font-serif text-[11px] leading-4 text-ink-muted">
                iOS doesn&rsquo;t tell apps whether read access was granted — if data looks missing,
                check Settings → Privacy &amp; Security → Health → ARC.
              </Text>

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
              Read-only — ARC never writes to Apple Health. Data lands in the on-device database and
              shows up in Data → Wearables and Home&rsquo;s readiness.
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
