import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { palette } from '@/constants/theme';
import { useAppLockPreference } from '@/hooks/use-app-lock-preference';
import { useSessionKeySet } from '@/hooks/use-session-key';
import { getDb } from '@/lib/db/client';
import { getOrCreateUser, isHealthSyncEnabled } from '@/lib/db/repositories/user';
import { exportDataToFile } from '@/lib/export/export-file';
import { isHealthKitSupported } from '@/lib/health/healthkit';

/**
 * Settings — a calm index into the profile, unit preferences, security & data,
 * and the surfaces still to be built. This is an action-light tab, so it stays
 * at the pine ceiling's floor: exactly ONE pine accent — the app-lock switch's
 * on-track — while the three nav rows (Profile / Units / Coach) and the export
 * action are neutral, and every not-yet-built row is visibly muted with a
 * neutral "not ready" chip. No signal colour — those stay reserved for
 * biological states (docs/project-status.md).
 *
 * Profile + Units + Coach push to their own screens; App lock and Export act
 * in place. The name subtitle re-reads on focus (the use-log-feed.ts
 * useFocusEffect pattern) so an edit shows up on return.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

/** The neutral "not ready" chip — same chrome as the Data tab, never a hue. */
function Chip({ children }: { children: string }) {
  return (
    <View className="rounded-btn bg-paper-deep px-2 py-0.5">
      <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
        {children}
      </Text>
    </View>
  );
}

type SoonRow = {
  key: string;
  label: string;
  sub: string;
  icon: keyof typeof Ionicons.glyphMap;
  chip: string;
};

// Visible, non-tappable, muted. Each says honestly why it's not here yet.
const SOON: SoonRow[] = [
  {
    key: 'backup',
    label: 'Backup & restore',
    sub: 'Encrypted iCloud snapshot · Phase 4',
    icon: 'cloud-upload-outline',
    chip: 'Soon',
  },
];

const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';

export default function SettingsScreen() {
  const router = useRouter();
  const keySet = useSessionKeySet();
  const [profile, setProfile] = useState(() => getOrCreateUser(getDb()));
  const appLock = useAppLockPreference();
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  // Re-read on focus so a name edited on the Profile screen shows up on return.
  const reload = useCallback(() => setProfile(getOrCreateUser(getDb())), []);
  useFocusEffect(reload);

  const name = profile.full_name?.trim();
  const profileSub = name && name.length > 0 ? name : 'Name, date of birth, and biological sex';
  // Live row even pre-build — the screen itself explains "rides the next build"
  // (same posture as Coach with no key). Sub reflects the honest state.
  const healthSub = !isHealthKitSupported()
    ? 'Wearables hub · rides the next build'
    : isHealthSyncEnabled(getDb())
      ? 'Connected'
      : 'Wearables via Apple Health';

  const setAppLock = appLock.setEnabled;
  const handleLockToggle = useCallback(
    async (next: boolean) => {
      const result = await setAppLock(next);
      if (result === 'auth-failed') {
        Alert.alert('Not enabled', 'The Face ID / passcode check didn’t pass. Try again.');
      } else if (result === 'no-credentials') {
        Alert.alert(
          'Set a device passcode first',
          'App lock needs Face ID or a device passcode to check against.'
        );
      }
      // 'unsupported' can't happen from the UI — the switch only renders when
      // the module is present.
    },
    [setAppLock]
  );

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportNote(null);
    try {
      const outcome = await exportDataToFile(getDb());
      if (outcome.status === 'shared') {
        setExportNote(`Exported · ${outcome.fileName}`);
      } else if (outcome.status === 'saved') {
        setExportNote(`Saved · ${outcome.fileName}`);
        Alert.alert(
          'Export saved',
          `Written to the app’s Documents folder:\n\n${outcome.uri}\n\nThe share sheet arrives with the next build.`
        );
      } else if (outcome.status === 'failed') {
        setExportNote('Export failed');
        Alert.alert('Export failed', outcome.message);
      } else {
        setExportNote('Needs the app build');
      }
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  return (
    <Screen scroll>
      {/* Header — this tab owns its own header (not StackHeader). */}
      <View className="pt-2">
        <Text className="font-serif text-[26px] font-semibold text-ink">Settings</Text>
        <Text className="mt-1 text-[13px] leading-5 text-ink-secondary">
          Your profile, how numbers read, and what&rsquo;s still to come.
        </Text>
      </View>

      {/* You — the two live, editable destinations. */}
      <View className="mt-6">
        <View className="rounded-card border border-hairline bg-porcelain">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Profile"
            onPress={() => router.push('/settings-profile')}
            className="flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep">
            <Ionicons name="person-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">Profile</Text>
              <Text className="mt-0.5 text-[12px] text-ink-muted" numberOfLines={1}>
                {profileSub}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Units"
            onPress={() => router.push('/settings-units')}
            className="flex-row items-center gap-3 border-t border-hairline-soft px-4 py-3 active:bg-paper-deep">
            <Ionicons name="swap-horizontal-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">Units</Text>
              <Text className="mt-0.5 text-[12px] text-ink-muted">Weight, distance, and more</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Coach"
            onPress={() => router.push('/settings-coach')}
            className="flex-row items-center gap-3 border-t border-hairline-soft px-4 py-3 active:bg-paper-deep">
            <Ionicons name="sparkles-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">Coach</Text>
              <Text className="mt-0.5 text-[12px] text-ink-muted">
                {keySet ? 'Model connected' : 'API key and model'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Apple Health"
            onPress={() => router.push('/settings-health')}
            className="flex-row items-center gap-3 border-t border-hairline-soft px-4 py-3 active:bg-paper-deep">
            <Ionicons name="heart-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">Apple Health</Text>
              <Text className="mt-0.5 text-[12px] text-ink-muted">{healthSub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
          </Pressable>
        </View>
      </View>

      {/* Security & data — the lock on the front door and the way out with
          everything. The switch's on-state is this screen's one pine accent. */}
      <View className="mt-8">
        <SectionLabel>Security &amp; data</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
          {/* Not an `accessible` container — the Switch must stay individually
              focusable/toggleable for VoiceOver (unlike the static SOON rows). */}
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Ionicons name="lock-closed-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">App lock</Text>
              <Text className="mt-0.5 text-[12px] text-ink-muted">
                Face ID or passcode when ARC opens
              </Text>
            </View>
            {appLock.supported ? (
              <Switch
                accessibilityLabel="App lock"
                value={appLock.enabled}
                onValueChange={(next) => void handleLockToggle(next)}
                trackColor={{ true: palette.pine, false: palette.hairlineStrong }}
                ios_backgroundColor={palette.hairlineStrong}
              />
            ) : (
              <Chip>Needs a build</Chip>
            )}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Export data"
            accessibilityState={{ disabled: exporting }}
            disabled={exporting}
            onPress={() => void handleExport()}
            className="flex-row items-center gap-3 border-t border-hairline-soft px-4 py-3 active:bg-paper-deep">
            <Ionicons name="download-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="text-[15px] text-ink">Export data</Text>
              <Text className="mt-0.5 text-[12px] text-ink-muted" numberOfLines={1}>
                {exporting ? 'Writing…' : (exportNote ?? 'Everything, offline, as one JSON file')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
          </Pressable>
        </View>
      </View>

      {/* Not yet built — visible so the shape is honest, muted so it stays quiet. */}
      <View className="mt-8">
        <SectionLabel>Not yet built</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
          {SOON.map((row, index) => (
            <View
              key={row.key}
              accessible
              accessibilityLabel={`${row.label}. ${row.sub}. ${row.chip}.`}
              className={`flex-row items-center gap-3 px-4 py-3 ${
                index === 0 ? '' : 'border-t border-hairline-soft'
              }`}>
              <Ionicons name={row.icon} size={18} color={palette.inkMuted} />
              <View className="flex-1">
                <Text className="text-[15px] text-ink-muted">{row.label}</Text>
                <Text className="mt-0.5 text-[12px] text-ink-muted">{row.sub}</Text>
              </View>
              <Chip>{row.chip}</Chip>
            </View>
          ))}
        </View>
      </View>

      {/* About — app name + a mono version line. */}
      <View className="mt-8">
        <SectionLabel>About</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain px-4 py-4">
          <Text className="font-serif text-[16px] text-ink">ARC</Text>
          <Text className="mt-1 text-[12px] leading-5 text-ink-secondary">
            Architecture for Resilience &amp; Continuity
          </Text>
          <Text className="mt-2 font-mono text-[11px] text-ink-muted">v{APP_VERSION}</Text>
        </View>
      </View>
    </Screen>
  );
}
