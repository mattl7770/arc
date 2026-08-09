import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
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
 * the tap handler.
 *
 * Conformed Set treatment: each field is **recessed stock** — a capture surface
 * is a well, so the input itself carries the paper-dim fill on a paper-deep
 * edge, square. The date of birth is a measured value and stays in mono.
 *
 * **Zero accent.** Settings carries none (00-design-spec.md §2), so Save is a
 * solid *ink* action rather than the pine it used to be. It is still
 * unmistakably the primary control on the screen — weight, not hue, is what
 * makes it one.
 */
const SEX_OPTIONS: { value: BiologicalSex; label: string }[] = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'intersex', label: 'Intersex' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

/** Shared by every text field here: recessed stock, square, no radius. */
const FIELD =
  'mt-2 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';

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
      <View className="mt-3">
        <SectionLabel label="Full name" />
        <TextInput
          value={fullName}
          onChangeText={setFullName}
          placeholder="Your name"
          placeholderTextColor={palette.inkMuted}
          autoCapitalize="words"
          className={FIELD}
          accessibilityLabel="Full name"
        />
      </View>

      {/* Date of birth — a measured value, so mono. */}
      <View className="mt-8">
        <SectionLabel label="Date of birth" />
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
          className="mt-2 border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[15px] text-ink"
          accessibilityLabel="Date of birth"
        />
        {error ? (
          <View className="mt-1.5 flex-row items-center gap-1.5">
            <Ionicons name="alert-circle-outline" size={14} color={palette.inkSecondary} />
            <Text className="flex-1 font-serif text-[11px] text-ink-secondary">{error}</Text>
          </View>
        ) : (
          <Text className="mt-1.5 font-serif text-[11px] text-ink-muted">
            Four-digit year first, e.g. 1990-04-15.
          </Text>
        )}
      </View>

      {/* Biological sex */}
      <View className="mt-8">
        <SectionLabel label="Biological sex" />
        <View className="mt-2 flex-row flex-wrap gap-2">
          {SEX_OPTIONS.map((opt) => {
            const on = sex === opt.value;
            return (
              <Pressable
                key={opt.value}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setSex(opt.value)}
                className={`min-h-[44px] justify-center rounded-btn border px-3 py-2 active:bg-paper-dim ${
                  on ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'
                }`}>
                <Text
                  className={`font-label text-[13px] ${
                    on ? 'font-semibold text-ink' : 'text-ink-secondary'
                  }`}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Timezone */}
      <View className="mt-8">
        <SectionLabel label="Timezone" />
        <TextInput
          value={timezone}
          onChangeText={setTimezone}
          placeholder="e.g. America/New_York"
          placeholderTextColor={palette.inkMuted}
          autoCapitalize="none"
          autoCorrect={false}
          className={FIELD}
          accessibilityLabel="Timezone"
        />
      </View>

      {/* The primary action — solid ink, because Settings spends no accent. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save profile"
        onPress={save}
        className="mt-8 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-ink py-3.5 active:opacity-70">
        <Ionicons name="checkmark" size={18} color={palette.paperHi} />
        <Text className="font-label text-[15px] font-semibold text-paper-hi">Save</Text>
      </Pressable>

      <View className="mt-4">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            One user, one device, no account — this record never leaves the phone.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
