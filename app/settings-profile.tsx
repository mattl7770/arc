import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { getOrCreateUser, updateProfile } from '@/lib/db/repositories/user';
import type { BiologicalSex } from '@/lib/db/types';

/**
 * Profile — the single-row `users` record (CLAUDE.md §9: one user, no auth).
 * Loaded once in a useState initializer (op-sqlite is synchronous), edited in
 * place, saved with updateProfile then back to Settings.
 *
 * Date of birth is guarded by a DB CHECK (YYYY-MM-DD shape, year > 1900), so the
 * save is wrapped in try/catch and surfaces an inline note rather than crashing
 * the tap handler. The one pine accent on the screen is the Save action.
 */
const SEX_OPTIONS: { value: BiologicalSex; label: string }[] = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'intersex', label: 'Intersex' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

export default function SettingsProfileScreen() {
  const router = useRouter();
  const [user] = useState(() => getOrCreateUser(getDb()));

  const [fullName, setFullName] = useState(user.full_name ?? '');
  const [dob, setDob] = useState(user.date_of_birth ?? '');
  const [sex, setSex] = useState<BiologicalSex | null>(user.biological_sex);
  const [timezone, setTimezone] = useState(user.timezone);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    try {
      updateProfile(getDb(), {
        fullName: fullName.trim() || null,
        dateOfBirth: dob.trim() || null,
        biologicalSex: sex,
        // Never blank a NOT NULL column — fall back to what was stored.
        timezone: timezone.trim() || user.timezone,
      });
      router.back();
    } catch {
      // The DB CHECK on date_of_birth is the realistic failure here.
      setError('That date of birth isn’t valid — use YYYY-MM-DD, e.g. 1990-04-15.');
    }
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Profile" />
      </View>

      {/* Full name */}
      <View className="mt-2">
        <SectionLabel>Full name</SectionLabel>
        <TextInput
          value={fullName}
          onChangeText={setFullName}
          placeholder="Your name"
          placeholderTextColor={palette.inkMuted}
          autoCapitalize="words"
          className="mt-2 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink"
          accessibilityLabel="Full name"
        />
      </View>

      {/* Date of birth */}
      <View className="mt-8">
        <SectionLabel>Date of birth</SectionLabel>
        <TextInput
          value={dob}
          onChangeText={(t) => {
            setDob(t);
            if (error) setError(null);
          }}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={palette.inkMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          className="mt-2 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 font-mono text-[15px] text-ink"
          accessibilityLabel="Date of birth"
        />
        {error ? (
          <View className="mt-1.5 flex-row items-center gap-1.5">
            <Ionicons name="alert-circle-outline" size={14} color={palette.inkSecondary} />
            <Text className="flex-1 text-[11px] text-ink-secondary">{error}</Text>
          </View>
        ) : (
          <Text className="mt-1.5 text-[11px] text-ink-muted">
            Four-digit year first, e.g. 1990-04-15.
          </Text>
        )}
      </View>

      {/* Biological sex */}
      <View className="mt-8">
        <SectionLabel>Biological sex</SectionLabel>
        <View className="mt-2 flex-row flex-wrap gap-2">
          {SEX_OPTIONS.map((opt) => {
            const on = sex === opt.value;
            return (
              <Pressable
                key={opt.value}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setSex(opt.value)}
                className={`rounded-btn border px-3 py-2 active:bg-paper-deep ${
                  on ? 'border-hairline-strong bg-paper-deep' : 'border-hairline bg-porcelain'
                }`}>
                <Text
                  className={`text-[13px] ${on ? 'font-medium text-ink' : 'text-ink-secondary'}`}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Timezone */}
      <View className="mt-8">
        <SectionLabel>Timezone</SectionLabel>
        <TextInput
          value={timezone}
          onChangeText={setTimezone}
          placeholder="e.g. America/New_York"
          placeholderTextColor={palette.inkMuted}
          autoCapitalize="none"
          autoCorrect={false}
          className="mt-2 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink"
          accessibilityLabel="Timezone"
        />
      </View>

      {/* The one pine action on this screen. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save profile"
        onPress={save}
        className="mt-8 flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5 active:opacity-70">
        <Ionicons name="checkmark" size={18} color={palette.pineOn} />
        <Text className="text-[15px] font-semibold text-pine-on">Save</Text>
      </Pressable>
    </Screen>
  );
}
