/**
 * When one protocol item happens, and whether it nudges (C9 + C10).
 *
 * Extracted verbatim from app/protocol-edit.tsx on 2026-09-19 so the per-item
 * editor could use the same control. That editor folded back into
 * app/protocol-edit.tsx on 2026-09-25, where this now draws inside the one
 * item that is open.
 *
 * **2026-09-21 — the chips became a wheel.** Six anchor presets and a typed
 * `HH:MM` field were what C9 shipped, and the backlog line called the choice
 * out loud: *"deliberately not a native wheel"*. The owner's first round on
 * hardware answered it — *"needs a real wheel like a calendar app"* — so the
 * presets and the field are gone and {@link TimeWheel} draws the iOS spinner in
 * their place. Everything around them is untouched: the collapsed line, the
 * clear, the reminder toggle, and the `HH:MM` that gets written.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

import { Chip } from '@/components/ui/chip';
import { NO_TIME, normalizeTime } from '@/lib/protocols/clock-time';
import { TimeWheel } from './time-wheel';

/**
 * Collapsed to a single line that STATES the time, exactly like
 * `CadenceControl` one row below it — the two lines under an item read "when"
 * then "how often", which is the order the questions come in. A stack of eight
 * items would otherwise carry eight open wheels, and the common case (no time
 * at all) would cost as much room as the rare one.
 *
 * `defaultOpen` is for a caller that draws ONE item and has the room. The
 * protocol editor opens it collapsed even inside an open item, because the
 * wheel is tall and the item's other fields should stay on screen; the render
 * suite opens it to see the fallback field.
 *
 * **Clearing is a first-class action**, and now more than ever: a wheel has no
 * empty state — a `UIDatePicker` always shows *some* time — so "no time" can
 * only ever be said by a control beside it, never by the control itself. An
 * untimed item is a normal thing to want, and it sorts to the end of the day
 * exactly as it always has (src/lib/home/derive-mission.ts). Clearing also
 * turns the reminder off, because a notification with no moment to fire at is
 * an intent the scheduler can never honour — `normalizeItem` enforces the same
 * thing at the storage boundary, so the two cannot disagree.
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
          <TimeWheel
            value={time}
            itemLabel={itemLabel}
            onChange={(next) => onChange({ time: next, remind })}
          />

          {/* The two things the wheel cannot say: "no time at all", and
              "nudge me". They share a row because the second one is replaced
              by a sentence when there is no time to nudge at. */}
          <View className="mt-2 flex-row items-center gap-2">
            <Chip
              label="Clear"
              compact
              on={false}
              accessibilityLabel="Clear the time"
              onPress={() => onChange({ time: NO_TIME, remind: false })}
            />
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
