/**
 * The iOS time wheel — the control the owner asked for by name.
 *
 * > *"needs a real wheel like a calendar app"* — Matt, device checklist,
 * > 2026-09-21, about the protocol editor's time control.
 *
 * It replaces what C9 shipped on 2026-09-14: six anchor chips (07:00 … 21:00)
 * and a typed `HH:MM` field beside them — a choice the backlog recorded in as
 * many words, *"deliberately not a native wheel"* (`docs/backlog-2026-09.md`
 * C9). The first round on hardware overruled it. Six anchors are a coarse
 * jump; any other time meant typing digits and a colon on a phone keyboard.
 *
 * ## What it writes is unchanged, and that is the point
 *
 * `HH:MM` text, exactly as the chips wrote it. `scheduled_time` is untouched,
 * the reminder scheduler's string comparison is untouched
 * (`src/lib/notifications/protocol-reminders.ts`), and every existing test
 * contract still holds. The `Date` the picker speaks lives for one render and
 * is converted on both sides by `src/lib/protocols/clock-time.ts`, which is
 * pure and is where the round trip is pinned by test.
 *
 * ## The seam, and what happens without it
 *
 * The picker is a native module, reached through `src/lib/ui/date-time-picker.ts`
 * — never a static import, for the reasons written there (the protocol editor
 * is on Expo Router's eagerly-required route manifest, and Node cannot load the
 * package at all). Where the module is absent — the web logic-check preview,
 * the headless render suite, a dev client built before the dependency landed —
 * this falls back to the **typed field C9 shipped**, so the time is always
 * settable and nothing is ever blank.
 *
 * ## Conformed Set
 *
 * The wheel sits in a **`field`** device: 11px corner ticks, no border, no fill
 * (src/components/ui/block.tsx). That is a deliberate reading of a screen whose
 * own docblock says *"NOTHING on this screen is boxed"* — and `field` boxes
 * nothing: it marks two opposite corners of a measured region, which is what
 * a time being set is, and has no fill for an input to sit recessed on. A
 * `plate` or a `well` here would be the surface inversion that screen was
 * de-plated to stop; this is not that. Whether eight sets of corner ticks
 * read as noise on the full editor, with every item open, is for the phone.
 *
 * The caption is **label voice**, the set time is **mono** beside it (a clock
 * time is a measured value) and *Any time* is label voice (it is a word, not a
 * measurement) — the same split the collapsed line above it already makes.
 * **No accent**: the form spends its whole budget on Save.
 *
 * That mono caption is not decoration. VoiceOver reads the wheel one column
 * at a time, and the render suite cannot see the wheel at all; the caption is
 * where the chosen time is stated whole, once, in ARC's own voice — in both
 * branches.
 */
import { Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { MINUTE_STEP, dateToTime, normalizeTime, timeToDate } from '@/lib/protocols/clock-time';
import { ArcTimePicker } from '@/lib/ui/date-time-picker';

import { FormField } from './form-controls';

export function TimeWheel({
  value,
  onChange,
  itemLabel,
}: {
  /** The item's stored time — `'HH:MM'`, or `''` for an item with no time. */
  value: string;
  /**
   * `'HH:MM'` from the wheel, always. From the typed fallback, whatever has
   * been typed so far — the editors validate and normalise at save, exactly as
   * they did for C9's field. The *clear* is the caller's, one row below.
   */
  onChange: (next: string) => void;
  itemLabel: string;
}) {
  const normalized = normalizeTime(value);
  const timed = normalized !== null;
  // Only the typed fallback can hold a half-typed value ("7:"). That is not a
  // time yet and it is not "any time" either, so the caption says neither.
  const blank = value.trim() === '';

  return (
    <Block device="field">
      <SectionLabel
        label="At"
        note={timed ? normalized : undefined}
        accessory={
          blank ? (
            <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
              Any time
            </Text>
          ) : undefined
        }
      />

      {ArcTimePicker ? (
        <ArcTimePicker
          value={timeToDate(value)}
          mode="time"
          display="spinner"
          minuteInterval={MINUTE_STEP}
          /* ARC is light-only and app.json pins `userInterfaceStyle: light`, so
             this is already true — it is stated because the wheel is a UIKit
             view sitting on ARC's paper, and a dark one there would be the
             single loudest thing on the screen. One prop is cheaper than
             finding out. */
          themeVariant="light"
          accessibilityLabel={`Time for ${itemLabel}`}
          onValueChange={(_event, date) => {
            const next = dateToTime(date);
            /* null is "that was not a clock time" — write nothing rather than
               put a guess in scheduled_time. See clock-time.ts. */
            if (next !== null) onChange(next);
          }}
        />
      ) : (
        /* The fallback is the app's existing time entry, reused rather than
           invented — mono, `numbers-and-punctuation`, five characters, as on
           the appointment form and in the meal editor. That keyboard is a FULL
           keyboard with a return key of its own, which is why it takes no
           `KEYPAD_DONE`: `FormField` derives that from `keyboardType`, so the
           rule cannot be half-applied (src/components/ui/keyboard.ts). */
        <View className="mt-2">
          <View className="w-24">
            <FormField
              value={value}
              onChange={onChange}
              placeholder="07:30"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              mono
              accessibilityLabel="Item time"
            />
          </View>
          {/* Authored, never blank: the slot says why the control it would
              otherwise hold is not here — the same sentence shape the camera
              screens use for their absent branch. The build fact only: the
              field it would have pointed at is directly above (slop pass 4,
              docs/ai-slop-candidates-2026-09.md §11). */}
          <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
            The wheel arrives with the next app build.
          </Text>
        </View>
      )}
    </Block>
  );
}
