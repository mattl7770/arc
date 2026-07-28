import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { palette } from '@/constants/theme';
import { useSessionKeySet } from '@/hooks/use-session-key';
import { getDb } from '@/lib/db/client';
import { getOrCreateUser } from '@/lib/db/repositories/user';

/**
 * Settings — a calm index into the profile, unit preferences, and the surfaces
 * still to be built. This is an action-light tab, so it carries no pine at all
 * (pine is a ceiling, not a quota): the two live rows are neutral nav, and every
 * not-yet-built row is visibly muted with a neutral "not ready" chip. No signal
 * colour — those stay reserved for biological states (docs/project-status.md).
 *
 * Profile + Units push to their own screens. The name subtitle re-reads on focus
 * (the use-log-feed.ts useFocusEffect pattern) so an edit shows up on return.
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
    key: 'lock',
    label: 'App lock — Face ID',
    sub: 'Face ID or passcode',
    icon: 'lock-closed-outline',
    chip: 'Needs a build',
  },
  {
    key: 'health',
    label: 'Apple Health',
    sub: 'Wearables via Apple Health',
    icon: 'heart-outline',
    chip: 'Needs a build',
  },
  {
    key: 'backup',
    label: 'Backup & restore',
    sub: 'Encrypted iCloud snapshot · Phase 4',
    icon: 'cloud-upload-outline',
    chip: 'Soon',
  },
  {
    key: 'export',
    label: 'Data export',
    sub: 'Take everything with you',
    icon: 'download-outline',
    chip: 'Soon',
  },
];

const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';

export default function SettingsScreen() {
  const router = useRouter();
  const keySet = useSessionKeySet();
  const [profile, setProfile] = useState(() => getOrCreateUser(getDb()));

  // Re-read on focus so a name edited on the Profile screen shows up on return.
  const reload = useCallback(() => setProfile(getOrCreateUser(getDb())), []);
  useFocusEffect(reload);

  const name = profile.full_name?.trim();
  const profileSub = name && name.length > 0 ? name : 'Name, date of birth, and biological sex';

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
