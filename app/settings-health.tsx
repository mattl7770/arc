import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
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
 * Pine: the Enable button is the screen's single CTA. Everything else is
 * neutral chrome.
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

      {/* Status / action card */}
      <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
        {!supported ? (
          <>
            <Text className="font-serif text-[16px] font-semibold text-ink">
              Rides the next build
            </Text>
            <Text className="mt-1 text-[12.5px] leading-5 text-ink-secondary">
              The HealthKit module is installed but not in this dev build yet. Run the next EAS
              build (docs/dev-build.md) and this screen goes live — nothing else to set up.
            </Text>
          </>
        ) : !enabled ? (
          <>
            <Text className="font-serif text-[16px] font-semibold text-ink">
              Connect Apple Health
            </Text>
            <Text className="mt-1 text-[12.5px] leading-5 text-ink-secondary">
              ARC reads your wearable data on-device — your ring or watch syncs to Apple Health
              through its own app, and nothing leaves this phone. First sync pulls 90 days.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Enable Apple Health"
              disabled={busy !== null || !available}
              onPress={() => void enable()}
              className="mt-4 flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5 active:opacity-70">
              {busy === 'enabling' ? (
                <ActivityIndicator size="small" color={palette.pineOn} />
              ) : (
                <Ionicons name="heart-outline" size={18} color={palette.pineOn} />
              )}
              <Text className="text-[15px] font-semibold text-pine-on">
                {busy === 'enabling' ? 'Syncing 90 days…' : 'Enable Apple Health'}
              </Text>
            </Pressable>
            {!available ? (
              <Text className="mt-2 text-[11px] leading-4 text-ink-muted">
                Health data isn&rsquo;t available on this device.
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <View className="flex-row items-center gap-2">
              <Ionicons name="checkmark-circle" size={18} color={palette.pine} />
              <Text className="font-serif text-[16px] font-semibold text-ink">Connected</Text>
            </View>
            <Text className="mt-1 font-mono text-[11px] text-ink-muted">
              {lastSyncedAt
                ? `Last synced ${fmtSyncedAt(lastSyncedAt)}${lastRows !== null ? ` · ${lastRows} rows` : ''}`
                : 'Not synced yet'}
            </Text>
            <Text className="mt-2 text-[11px] leading-4 text-ink-muted">
              iOS doesn&rsquo;t tell apps whether read access was granted — if data looks missing,
              check Settings → Privacy &amp; Security → Health → ARC.
            </Text>

            <View className="mt-4 flex-row gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sync now"
                disabled={busy !== null}
                onPress={() => void syncNow()}
                className="flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline-strong py-3 active:bg-paper-deep">
                {busy === 'syncing' ? (
                  <ActivityIndicator size="small" color={palette.ink} />
                ) : (
                  <Ionicons name="refresh-outline" size={16} color={palette.ink} />
                )}
                <Text className="text-[14px] font-medium text-ink">
                  {busy === 'syncing' ? 'Syncing…' : 'Sync now'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Turn off Apple Health sync"
                disabled={busy !== null}
                onPress={disable}
                className="flex-1 items-center justify-center rounded-btn border border-hairline py-3 active:bg-paper-deep">
                <Text className="text-[14px] text-ink-secondary">Turn off</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>

      {/* What ARC reads */}
      <View className="mt-8">
        <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
          What ARC reads
        </Text>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
          {READ_SCOPES.map((scope, index) => (
            <View
              key={scope}
              className={`flex-row items-center gap-3 px-4 py-3 ${
                index === 0 ? '' : 'border-t border-hairline-soft'
              }`}>
              <Ionicons name="pulse-outline" size={16} color={palette.inkMuted} />
              <Text className="flex-1 text-[13.5px] text-ink-secondary">{scope}</Text>
            </View>
          ))}
        </View>
        <Text className="mt-3 px-1 text-[11px] leading-4 text-ink-muted">
          Read-only — ARC never writes to Apple Health. Data lands in the on-device database and
          shows up in Data → Wearables and Home&rsquo;s readiness.
        </Text>
      </View>

      {/* Jump to the history view */}
      <View className="mt-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open wearable history"
          onPress={() => router.push('/wearables')}
          className="flex-row items-center gap-3 rounded-card border border-hairline bg-porcelain px-4 py-3 active:bg-paper-deep">
          <Ionicons name="analytics-outline" size={18} color={palette.inkSecondary} />
          <Text className="flex-1 text-[15px] text-ink">Wearable history</Text>
          <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
        </Pressable>
      </View>
    </Screen>
  );
}
