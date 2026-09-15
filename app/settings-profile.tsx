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
import { DEFAULT_DAY_STARTS_AT, setDayStartsAt } from '@/lib/db/date';
import {
  getDayStartsAtPreference,
  getOrCreateUser,
  setDayStartsAtPreference,
  updateProfile,
} from '@/lib/db/repositories/user';
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
 * **Day starts at** lives here rather than in Units because Units is explicitly
 * display-only ("never what's stored") and this is not: it decides which day
 * every future entry is filed under. It sits beside Timezone because that is the
 * adjacent fact — the boundary is a wall-clock rule and says nothing about the
 * zone the clock is in (the D4 seam, documented on src/lib/db/date.ts). It is a
 * preference, not a `users` column, so it saves through its own repo call
 * alongside `updateProfile` and then installs itself for the running app.
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

/** A measured value: mono, and the width the appointment form gives a clock. */
const CLOCK_FIELD =
  'mt-2 w-24 min-h-[44px] border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[15px] text-ink';

/** 24-hour `HH:MM` — the same shape app/appointment-form.tsx accepts. */
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

export default function SettingsProfileScreen() {
  const router = useRouter();
  const [user] = useState(() => getOrCreateUser(getDb()));

  const [fullName, setFullName] = useState(user.full_name ?? '');
  const [dob, setDob] = useState(user.date_of_birth ?? '');
  const [sex, setSex] = useState<BiologicalSex | null>(user.biological_sex);
  const [timezone, setTimezone] = useState(user.timezone);
  const [dayStart, setDayStart] = useState(() => getDayStartsAtPreference(getDb()));
  const [error, setError] = useState<string | null>(null);

  // A cleared field means the default, not a rejection.
  const dayStartEntry = dayStart.trim() || DEFAULT_DAY_STARTS_AT;
  const dayStartOk = TIME_SHAPE.test(dayStartEntry);

  const save = () => {
    if (!dayStartOk) {
      setError('That day start isn’t a 24-hour clock time — use HH:MM, e.g. 04:00.');
      return;
    }
    try {
      updateProfile(getDb(), {
        fullName: fullName.trim() || null,
        dateOfBirth: dob.trim() || null,
        biologicalSex: sex,
        // Never blank a NOT NULL column — fall back to what was stored.
        timezone: timezone.trim() || user.timezone,
      });
      // Persist, then install for the running app so the very next screen reads
      // the new boundary without a relaunch (src/lib/db/date.ts).
      setDayStartsAt(setDayStartsAtPreference(getDb(), dayStartEntry));
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

      {/* Day starts at — a measured value, so mono, and the same HH:MM field the
          appointment form uses. `numbers-and-punctuation` is a full keyboard
          with its own return key, so it takes no KEYPAD_DONE
          (src/components/ui/keyboard.ts names the four pads that do). */}
      <View className="mt-8">
        <SectionLabel label="Day starts at" />
        <TextInput
          value={dayStart}
          onChangeText={(t) => {
            setDayStart(t);
            if (error) setError(null);
          }}
          placeholder={DEFAULT_DAY_STARTS_AT}
          placeholderTextColor={palette.inkMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          className={CLOCK_FIELD}
          accessibilityLabel="Day starts at, 24-hour"
        />
        <Text className="mt-1.5 font-serif text-[11px] leading-4 text-ink-muted">
          {dayStartOk && dayStartEntry !== DEFAULT_DAY_STARTS_AT
            ? `Anything logged before ${dayStartEntry} counts as the previous day.`
            : 'Days run midnight to midnight.'}{' '}
          Days already logged keep the date they were filed under.
        </Text>
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

      {/* Cut on 2026-08-11 as a restatement of four other screens. The sweep
          took those four as well, so after it the app asserted local-first data
          ownership — CLAUDE.md §2's FIRST non-negotiable — nowhere. The one
          survivor, coach/session-key-panel.tsx, is about the API key and says
          the key *does* leave on model calls. Back here, in the shortest form
          that carries the fact; the "one user, one device, no account"
          preamble, which was the restatement, is not. */}
      <View className="mt-4">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            This record never leaves the phone.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
