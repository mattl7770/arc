import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { useAppLockPreference } from '@/hooks/use-app-lock-preference';
import { useSessionKeySet } from '@/hooks/use-session-key';
import { getDb } from '@/lib/db/client';
import { getOrCreateUser, isHealthSyncEnabled } from '@/lib/db/repositories/user';
import { exportDataToFile } from '@/lib/export/export-file';
import { isHealthKitSupported } from '@/lib/health/healthkit';

/**
 * Settings — a calm index into the profile, unit preferences, security & data,
 * and the surfaces still to be built.
 *
 * Conformed Set treatment — every group is a **ruled plate**: a settings list is
 * a record of what is set, and a record is a table (00-design-spec.md §1). The
 * About block is the exception, and takes the **margin annotation** device
 * because it is prose about the app rather than a list of settings.
 *
 * ## Zero accent, deliberately
 *
 * "Settings carries no accent at all" is explicit in the spec (§2, accent
 * budget). The app-lock switch used to burn the screen's one pine on its
 * on-track; it is now ink. An accent here would compete with the one place the
 * accent is supposed to mean something — the single directive action on a
 * screen — and settings has no such action. No signal colour either: those mark
 * biological state only, never chrome.
 *
 * Profile + Units + Coach + Apple Health push to their own screens; App lock and
 * Export act in place. The name subtitle re-reads on focus (the use-log-feed.ts
 * useFocusEffect pattern) so an edit shows up on return.
 */

/** The neutral "not ready" chip — a status word, so the label voice, never mono. */
function Chip({ children }: { children: string }) {
  return (
    <View className="border border-paper-deep bg-paper-dim px-2 py-0.5">
      <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
        {children}
      </Text>
    </View>
  );
}

/**
 * One ruled line of a settings plate. No horizontal padding: the plate supplies
 * the gutter and the rule runs between rows, not around them. `first` skips the
 * top rule because the plate edge already closes that side.
 */
function NavRow({
  icon,
  label,
  sub,
  first,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sub: string;
  first?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={`min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60 ${
        first ? '' : 'border-t border-hairline'
      }`}>
      <Ionicons name={icon} size={18} color={palette.inkSecondary} />
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{label}</Text>
        <Text className="mt-0.5 font-serif text-[12px] text-ink-muted" numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
    </Pressable>
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

// The single source of truth is app.json's `expo.version`, delivered at runtime
// through the manifest. There is deliberately NO hardcoded fallback: a literal
// here has to be hand-synced with app.json and silently rots the moment it
// isn't (it still read '0.1.0' after app.json moved to 0.2.0, so the About card
// was reporting a version that had not existed for a while). Importing app.json
// wouldn't fix it either — that reports the JS bundle's declared version, which
// can differ from the installed binary's after an OTA update. If the manifest
// is unavailable we print nothing: no version line is honest, a wrong one is not.
const APP_VERSION = Constants.expoConfig?.version ?? null;

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
        <Text className="mt-1 font-serif text-[13px] leading-5 text-ink-secondary">
          Your profile, how numbers read, and what&rsquo;s still to come.
        </Text>
      </View>

      {/* You — the live, editable destinations. */}
      <View className="mt-7">
        <SectionLabel label="You" />
        <View className="mt-3">
          <Block device="plate">
            <NavRow
              first
              icon="person-outline"
              label="Profile"
              sub={profileSub}
              onPress={() => router.push('/settings-profile')}
            />
            <NavRow
              icon="swap-horizontal-outline"
              label="Units"
              sub="Weight, distance, and more"
              onPress={() => router.push('/settings-units')}
            />
            <NavRow
              icon="sparkles-outline"
              label="Coach"
              sub={keySet ? 'Model connected' : 'API key and model'}
              onPress={() => router.push('/settings-coach')}
            />
            <NavRow
              icon="heart-outline"
              label="Apple Health"
              sub={healthSub}
              onPress={() => router.push('/settings-health')}
            />
          </Block>
        </View>
      </View>

      {/* Security & data — the lock on the front door and the way out with
          everything. Both are neutral ink: settings spends no accent. */}
      <View className="mt-8">
        <SectionLabel label="Security & data" />
        <View className="mt-3">
          <Block device="plate">
            {/* Not an `accessible` container — the Switch must stay individually
                focusable/toggleable for VoiceOver (unlike the static SOON rows). */}
            <View className="min-h-[44px] flex-row items-center gap-3 py-3">
              <Ionicons name="lock-closed-outline" size={18} color={palette.inkSecondary} />
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">App lock</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  Face ID or passcode when ARC opens
                </Text>
              </View>
              {appLock.supported ? (
                <Switch
                  accessibilityLabel="App lock"
                  value={appLock.enabled}
                  onValueChange={(next) => void handleLockToggle(next)}
                  trackColor={{ true: palette.ink, false: palette.hairlineStrong }}
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
              className="min-h-[44px] flex-row items-center gap-3 border-t border-hairline py-3 active:opacity-60">
              <Ionicons name="download-outline" size={18} color={palette.inkSecondary} />
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Export data</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted" numberOfLines={1}>
                  {exporting ? 'Writing…' : (exportNote ?? 'Everything, offline, as one JSON file')}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
            </Pressable>
          </Block>
        </View>
      </View>

      {/* Not yet built — visible so the shape is honest, muted so it stays quiet. */}
      <View className="mt-8">
        <SectionLabel label="Not yet built" />
        <View className="mt-3">
          <Block device="plate">
            {SOON.map((row, index) => (
              <View
                key={row.key}
                accessible
                accessibilityLabel={`${row.label}. ${row.sub}. ${row.chip}.`}
                className={`min-h-[44px] flex-row items-center gap-3 py-3 ${
                  index === 0 ? '' : 'border-t border-hairline'
                }`}>
                <Ionicons name={row.icon} size={18} color={palette.inkMuted} />
                <View className="flex-1">
                  <Text className="font-serif text-[15px] text-ink-muted">{row.label}</Text>
                  <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">{row.sub}</Text>
                </View>
                <Chip>{row.chip}</Chip>
              </View>
            ))}
          </Block>
        </View>
      </View>

      {/* About — prose plus one measured value, so the margin annotation device
          rather than a plate. The version is the only mono on this screen. */}
      <View className="mt-8">
        <SectionLabel label="About" />
        <View className="mt-3">
          <Block device="margin">
            <Text className="font-serif text-[16px] text-ink">ARC</Text>
            <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
              Architecture for Resilience &amp; Continuity
            </Text>
            {APP_VERSION ? (
              <Text className="mt-2 font-mono text-[11px] text-ink-muted">v{APP_VERSION}</Text>
            ) : null}
          </Block>
        </View>
      </View>
    </Screen>
  );
}
