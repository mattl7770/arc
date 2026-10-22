import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useGarminView } from '@/hooks/use-garmin';
import { getDb } from '@/lib/db/client';
import { clockFromISO } from '@/lib/db/date';
import {
  disconnectGarmin,
  saveGarminKey,
  syncGarminNow,
  type GarminEndpoint,
  type GarminPassResult,
  type GarminSyncState,
} from '@/lib/garmin/sync';

/**
 * Settings › Garmin — the Garmin Personal API link (docs/wearables-subapp.md
 * §26, docs/decisions.md "Garmin via the official Personal API", 2026-10-21).
 *
 * The owner makes the key on Garmin Connect Web and pastes it here. It goes
 * into the Keychain (src/lib/garmin/key-store.ts) and is never shown back —
 * the field only ever WRITES, like the Coach key's. Disconnect forgets the key
 * and the token and keeps every row already synced.
 *
 * Honesty rules:
 *   - **The key's expiry is shown only when Garmin's token response states
 *     it.** Otherwise the screen says what is actually true: Garmin emails the
 *     owner before the key expires.
 *   - **A refused key is said plainly**, with what fixes it (a new key).
 *   - **What does not come** is listed as plainly as what does: Training
 *     Readiness, Training Status and skin temperature are not served.
 *
 * Conformed Set treatment, as Settings › Coach: the link's state is a
 * **measured field** (a verdict), the key entry is **recessed stock**, the
 * actions and the list of what syncs are **ruled plates**, the instructions and
 * the privacy statement are **margin annotations**. **Zero accent** — Settings
 * spends none; Save is solid ink.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtInstant(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()} · ${clockFromISO(iso)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}, ${d.getFullYear()}`;
}

/** What syncs, in human words. Mirrors src/lib/garmin/mapping.ts's table. */
const SYNCS: readonly string[] = [
  'HRV — the nightly average, its status and your balanced range',
  'Sleep — score, duration and stages',
  'Blood oxygen (average and lowest) and respiration, overnight',
  'Stress, day average',
  'Body Battery — high, low and at wake',
  'Resting heart rate',
  'VO₂max, from activities',
];

/** The status line under the state. */
function statusLine(hasKey: boolean, state: GarminSyncState, now: Date): string {
  if (!hasKey) return 'No key yet. ARC reads nothing from Garmin until you paste one.';
  if (state.status === 'rejected') {
    return 'Garmin refused the key — it has expired or been revoked. Create a new one and paste it below.';
  }
  if (
    state.status === 'backoff' &&
    state.backoffUntil &&
    Date.parse(state.backoffUntil) > now.getTime()
  ) {
    return `Garmin asked ARC to slow down. The next try is after ${clockFromISO(state.backoffUntil)}.`;
  }
  if (state.status === 'offline') {
    return state.lastSyncedAt
      ? `The last try could not reach Garmin. Last synced ${fmtInstant(state.lastSyncedAt)}.`
      : 'The last try could not reach Garmin.';
  }
  if (state.status === 'error') {
    return 'The last pass could not finish. ARC tries again the next time it opens.';
  }
  return state.lastSyncedAt ? `Last synced ${fmtInstant(state.lastSyncedAt)}` : 'Not synced yet';
}

/** What each endpoint is called, for the line naming the ones Garmin would not serve. */
const ENDPOINT_WORDS: Record<GarminEndpoint, string> = {
  hrv: 'HRV',
  summary: 'the daily summary',
  sleep: 'sleep',
  body_battery: 'Body Battery at wake',
  activities: 'VO₂max',
};

/** "Garmin would not serve HRV and sleep on the last pass." — or null. */
function skippedLine(state: GarminSyncState): string | null {
  if (state.skipped.length === 0) return null;
  const words = state.skipped.map((e) => ENDPOINT_WORDS[e]);
  const list =
    words.length === 1
      ? words[0]
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `Garmin would not serve ${list} on the last pass; the rest synced.`;
}

/** One line after a tap on Sync now. */
function resultLine(result: GarminPassResult): string {
  switch (result.outcome) {
    case 'synced':
      return result.rowsWritten === 0
        ? 'Synced · nothing new'
        : `Synced · ${result.rowsWritten} ${result.rowsWritten === 1 ? 'row' : 'rows'} updated`;
    case 'no_key':
      return 'No key set';
    case 'rejected':
      return 'Garmin refused the key';
    case 'backoff':
      return result.backoffUntil
        ? `Garmin asked ARC to wait until ${clockFromISO(result.backoffUntil)}`
        : 'Garmin asked ARC to wait';
    case 'offline':
      return 'Could not reach Garmin';
    case 'error':
      return 'Sync failed';
  }
}

export default function SettingsGarminScreen() {
  const view = useGarminView();
  const { hasKey, running, state, persistent } = view;
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const canSave = draft.trim().length > 0;
  const now = new Date();
  const connected = hasKey && state.status !== 'rejected';

  const save = () => {
    if (!saveGarminKey(getDb(), draft)) return;
    setDraft('');
    setNote(null);
    void syncGarminNow(getDb()).then(
      (result) => setNote(resultLine(result)),
      () => setNote('Sync failed')
    );
  };

  const syncNow = () => {
    setNote(null);
    void syncGarminNow(getDb()).then(
      (result) => setNote(resultLine(result)),
      () => setNote('Sync failed')
    );
  };

  const disconnect = () => {
    disconnectGarmin(getDb());
    setDraft('');
    setNote('Disconnected · synced history kept');
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Garmin" />
      </View>

      {/* The link's state — a verdict, so the measured field. */}
      <View className="mt-3">
        <Block device="field">
          <View className="py-2">
            <View className="flex-row items-center gap-2">
              <View className={`h-1.5 w-1.5 ${connected ? 'bg-ink' : 'bg-hairline'}`} />
              <Text className="font-serif text-[15px] text-ink">
                {!hasKey
                  ? 'Not connected'
                  : state.status === 'rejected'
                    ? 'Key refused'
                    : 'Connected'}
              </Text>
            </View>
            <Text className="mt-1.5 font-serif text-[12px] leading-5 text-ink-secondary">
              {statusLine(hasKey, state, now)}
            </Text>
            {hasKey && state.status !== 'rejected' ? (
              <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
                {state.keyExpiresAt
                  ? `Key expires ${fmtDate(state.keyExpiresAt)}.`
                  : 'Garmin emails you before the key expires.'}
              </Text>
            ) : null}
            {hasKey && skippedLine(state) ? (
              <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
                {skippedLine(state)}
              </Text>
            ) : null}
            {hasKey && !persistent ? (
              <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
                Key held for this session only — this build cannot reach the Keychain.
              </Text>
            ) : null}
          </View>
        </Block>
      </View>

      {/* The key — write-only. The stored value is never shown back. */}
      <View className="mt-8">
        <SectionLabel label="Personal API key" />
        <View className="mt-3">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={hasKey ? 'Paste a new key to replace…' : 'Paste your key'}
            placeholderTextColor={palette.inkMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            className="border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[13px] text-ink"
            accessibilityLabel="Garmin Personal API key"
          />
          <View className="mt-3">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              disabled={!canSave}
              onPress={save}
              className={`min-h-[44px] items-center justify-center rounded-btn py-3 ${
                canSave ? 'bg-ink active:opacity-70' : 'border border-hairline bg-paper-dim'
              }`}>
              <Text
                className={`font-label text-[14px] font-semibold ${
                  canSave ? 'text-paper-hi' : 'text-ink-muted'
                }`}>
                {hasKey ? 'Replace key' : 'Save key'}
              </Text>
            </Pressable>
          </View>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              To make a key: on a computer, sign in at connect.garmin.com and go to Settings ›
              personalApiToken. Choose how long it lasts — 30, 90 or 180 days, or a year — create
              it, and copy it straight away: Garmin shows it once. Paste it above. Save the terms
              Garmin shows with the key; they say it is for your own use and must not be shared.
            </Text>
          </Block>
        </View>
      </View>

      {/* Actions — a ruled plate, like every list of things on this screen. */}
      {hasKey ? (
        <View className="mt-8">
          <Block device="plate">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sync Garmin now"
              accessibilityState={{ disabled: running, busy: running }}
              disabled={running}
              onPress={syncNow}
              className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Sync now</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  {running ? 'Reading Garmin…' : (note ?? 'The last few days, then older history')}
                </Text>
              </View>
              {running ? <ActivityIndicator size="small" color={palette.inkMuted} /> : null}
            </Pressable>
            <Divider />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Disconnect Garmin"
              onPress={disconnect}
              className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Disconnect</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  Forgets the key; what has synced stays
                </Text>
              </View>
            </Pressable>
          </Block>
        </View>
      ) : note ? (
        <Text className="mt-4 font-mono text-[11px] text-ink-muted">{note}</Text>
      ) : null}

      {/* What syncs, and what does not. */}
      <View className="mt-8">
        <SectionLabel label="What syncs" />
        <View className="mt-3">
          <Block device="plate">
            {SYNCS.map((line, index) => (
              <View key={line}>
                <Divider first={index === 0} />
                <Text className="py-3 font-serif text-[14px] leading-5 text-ink">{line}</Text>
              </View>
            ))}
          </Block>
        </View>
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              Garmin&rsquo;s Personal API does not serve Training Readiness, Training Status or skin
              temperature. Sleep and resting heart rate that already reach ARC through Apple Health
              are kept from there, so a night is never counted twice. When Garmin has HRV,
              Home&rsquo;s Recovery uses it.
            </Text>
          </Block>
        </View>
      </View>

      {/* Where the key lives, and what ARC sends. */}
      <View className="mt-8">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            The key stays in this phone&rsquo;s Keychain — never in ARC&rsquo;s database, its
            backups or its exports, and it does not move to a new phone. ARC calls only
            personal.connectapi.garmin.com, and only while it is open: a few requests each time,
            reading the last three days and then older history a month at a time.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
