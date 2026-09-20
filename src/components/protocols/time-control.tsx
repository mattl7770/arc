/**
 * When one protocol item happens, and whether it nudges (C9 + C10).
 *
 * Extracted verbatim from app/protocol-edit.tsx on 2026-09-19 so the per-item
 * editor and the mission item sheet's *Move to …* can use the same control.
 * Nothing about it changed in the move.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

import { Chip } from '@/components/ui/chip';
import { FormField, normalizeTime } from './form-controls';

/**
 * Anchor times offered as one tap each (C9).
 *
 * Six, three hours apart across the waking day. They are deliberately round and
 * evenly spaced rather than tuned to any routine: a preset that guesses at the
 * user's morning would be wrong for most items and would read as advice. These
 * are a coarse jump to the right part of the day; the field beside them is how
 * you say 07:45.
 */
export const TIME_PRESETS = ['07:00', '09:00', '12:00', '15:00', '18:00', '21:00'] as const;

/**
 * Collapsed to a single line that STATES the time, exactly like
 * `CadenceControl` one row below it — the two lines under an item read "when"
 * then "how often", which is the order the questions come in. A stack of eight
 * items would otherwise carry eight open time fields, and the common case (no
 * time at all) would cost as much room as the rare one.
 *
 * `defaultOpen` is for the per-item editor, which draws ONE item and has the
 * room: there the two controls open on arrival, because collapsing a form with
 * three fields in it hides half the screen to save nothing.
 *
 * **Reused, not invented.** The typed field is the app's existing time entry —
 * mono, `numbers-and-punctuation`, five characters — as on the appointment form
 * and in the meal editor. That keyboard is a FULL keyboard and already carries
 * a return key, which is why it does not take `KEYPAD_DONE`; `FormField` derives
 * that from `keyboardType` so a field cannot get the rule half-right
 * (src/components/ui/keyboard.ts).
 *
 * **Clearing is a first-class action**, not a matter of selecting five
 * characters and deleting them on a phone: an untimed item is a normal thing to
 * want, and it sorts to the end of the day exactly as it always has
 * (src/lib/home/derive-mission.ts). Clearing also turns the reminder off,
 * because a notification with no moment to fire at is an intent the scheduler
 * can never honour — `normalizeItem` enforces the same thing at the storage
 * boundary, so the two cannot disagree.
 */
export function TimeControl({
  time,
  remind,
  onChange,
  itemLabel,
  defaultOpen,
}: {
  time: string;
  remind: boolean;
  onChange: (next: { time: string; remind: boolean }) => void;
  itemLabel: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen === true);
  const normalized = normalizeTime(time);
  const timed = normalized !== null;
  const spoken = time.trim() === '' ? 'any time' : time;

  return (
    <View className="mt-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Time for ${itemLabel}: ${spoken}${
          remind ? ', reminder on' : ''
        }. ${open ? 'Hide options' : 'Change'}`}
        onPress={() => setOpen((shown) => !shown)}
        className="min-h-[44px] flex-row items-center gap-2 py-2 active:opacity-60">
        <Ionicons name="time-outline" size={15} color={palette.inkMuted} />
        <Text className="flex-1 text-[12px] text-ink-secondary">
          {/* A clock time is a measured value, so it is set in mono; "Any time"
              is a label, so it is not. */}
          {time.trim() === '' ? (
            <Text className="font-label">Any time</Text>
          ) : (
            <Text className="font-mono">{time}</Text>
          )}
          {remind ? <Text className="font-label">{'  ·  Reminder'}</Text> : null}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={palette.inkMuted} />
      </Pressable>

      {open ? (
        <View className="mt-1">
          <View className="flex-row flex-wrap gap-1.5">
            {TIME_PRESETS.map((preset) => (
              <Chip
                key={preset}
                label={preset}
                compact
                on={normalized === preset}
                onPress={() => onChange({ time: preset, remind })}
              />
            ))}
            <Chip
              label="Clear"
              compact
              on={false}
              accessibilityLabel="Clear the time"
              onPress={() => onChange({ time: '', remind: false })}
            />
          </View>

          <View className="mt-2 flex-row items-center gap-2">
            <View className="w-24">
              <FormField
                value={time}
                onChange={(next) => onChange({ time: next, remind })}
                placeholder="07:30"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                mono
                accessibilityLabel="Item time"
              />
            </View>
            {timed ? (
              <Chip
                label={remind ? 'Reminder on' : 'Remind me'}
                on={remind}
                accessibilityLabel={`Reminder at ${normalized} for ${itemLabel}${
                  remind ? ', on' : ', off'
                }`}
                onPress={() => onChange({ time, remind: !remind })}
              />
            ) : (
              /* Authored, never blank: the slot says why the control it would
                 otherwise hold is not here. */
              <Text className="flex-1 font-serif text-[12px] leading-4 text-ink-muted">
                Give it a time to set a reminder.
              </Text>
            )}
          </View>

          {remind ? (
            /* The same one-line device the quota control uses, and for the same
               reason: the control cannot state its own limits. Whether a phone
               alert actually fires is a runtime fact (the module in the build,
               permission granted, a moment still ahead) — see
               src/lib/notifications/reminders.ts — so this says what ARC will
               ASK for and promises nothing. */
            <Text className="mt-1.5 font-serif text-[11.5px] leading-4 text-ink-muted">
              iOS alerts at {normalized} on the days this lands, unless you have already ticked it.
              Notifications must be allowed for ARC.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
