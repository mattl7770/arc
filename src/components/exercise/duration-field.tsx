import { useRef } from 'react';
import { TextInput } from 'react-native';

import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { selectAllOnFocus } from '@/components/ui/select-on-focus';
import { palette } from '@/constants/theme';
import {
  clockFieldShows,
  clockToDigits,
  commitClock,
  digitsToClock,
  pressClockKey,
} from '@/lib/exercise/clock-entry';

/**
 * **A set's duration, typed like a microwave.** Owner, on device, 2026-09-23:
 * *"plank time should not require me to put in a colon, should automatically
 * fill right to left"*. Every set grid that takes a time uses this field — the
 * live logger and the session editor (app/workout-live.tsx) and the free-form
 * logger (app/workout-log.tsx) — so the rule cannot differ between them.
 *
 * A plain number pad with the app's Done bar (`KEYPAD_DONE`, ../ui/keyboard.ts);
 * the digits shift in from the right and the colons are drawn, never typed. The
 * rules — digits, normalisation, the maximum, legacy text — are pure and live in
 * src/lib/exercise/clock-entry.ts; this component only wires them to a
 * `TextInput`, and holds nothing the screen does not.
 *
 * ## The value it holds is the one the screen always held
 *
 * `value` is an `m:ss` / `h:mm:ss` string, and the screen still reads the stored
 * seconds from it with `parseClock`, exactly as before. Nothing downstream moved:
 * not the over-limit guards, not the draft payload (`DRAFT_VERSION` stays), not
 * `duration_sec`.
 *
 * ## Keystrokes, not text
 *
 * The field is driven by `onKeyPress` and takes no `onChangeText`. A shifting
 * clock cannot be read back off the native text: tap `1:30` to the left of the
 * `1` and the pad inserts the next digit THERE, and Backspace beside a drawn
 * colon deletes the colon. What the user pressed is the only thing that means
 * the same wherever UIKit put the caret, and RN 0.86 reports it on iOS for every
 * edit except a paste (`textInputShouldChangeText` in
 * RCTTextInputComponentView.mm) — so the key is applied to the buffer, and the
 * native text is simply overwritten with the result. `contextMenuHidden` takes
 * paste away, since a paste would arrive with no key and be overwritten too.
 *
 * Two keys can land before the screen re-renders with the first (the value
 * arrives through the screen's state), so the buffer the last key produced is
 * kept and the next key builds on it for as long as the screen's value is still
 * the one it was produced from, or the one it produced. Anything else means the
 * value changed underneath the field, and it is read afresh.
 *
 * ## A3 still applies, and meets the microwave on the first key only
 *
 * Focusing a filled field selects it (`selectAllOnFocus`, the owner's A3), so
 * the first DIGIT starts a new number instead of shifting into the old one — the
 * rule the manual logger most needs, because its time field keeps the last set
 * after Add. The first BACKSPACE does not clear it: it shifts the last digit
 * out, because an existing value opens as its digits and Backspace is how one
 * of them is corrected (`1:30` → `0:13`). The replacement is decided here, in
 * JavaScript, so it holds even if the native selection does not survive the
 * caret UIKit places at the tap point — which A3 itself still lists as a device
 * question. After the first key the field is an ordinary stopwatch entry.
 *
 * ## Commit is when the spelling settles
 *
 * On blur — the Done bar, or a tap on another field — the text is normalised
 * (`1:90` → `2:30`). The seconds do not change, so a Finish tapped while the
 * field is still focused saves exactly what a blur would have.
 *
 * ## 44pt, without moving the grid
 *
 * The input is 44pt tall and gives back 5pt of margin on each side, so it lays
 * out in a 34pt content box: in the free-form logger's 44pt `Field` it fills the
 * well exactly; in the set grid's 36pt well it overhangs it by 4pt above and
 * below — inside the row's own 6pt padding — so the touch target is 44pt while
 * the well draws at the height of the weight, reps and distance wells beside
 * it. The overhang is also what lets the touch reach it: Fabric's hit test does
 * not clip a view whose children overflow it.
 */
export function DurationField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  centered = false,
}: {
  /** The field's text as the screen holds it — an `m:ss` / `h:mm:ss` string `parseClock` reads. */
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  /** The set grid centres its values under their column headers; the free-form row reads left to right. */
  centered?: boolean;
}) {
  const shown = clockFieldShows(value);
  // Set on focus when the field holds a value: the first digit replaces (A3).
  const replaceNext = useRef(false);
  // The buffer the last keystroke produced, the screen value it was produced
  // from, and the text it was emitted as — see "Keystrokes, not text".
  const typed = useRef<{ from: string; to: string; digits: string } | null>(null);

  /** The text the field most recently holds, and its digits. */
  const latest = (): { text: string; digits: string } => {
    const last = typed.current;
    return last !== null && (value === last.from || value === last.to)
      ? { text: last.to, digits: last.digits }
      : { text: value, digits: clockToDigits(value) };
  };

  // Composed by hand in `onFocus` below rather than through selectAllOnFocus's
  // `then` argument: that callback would mutate refs, and the compiler's refs
  // rule cannot see that `then` only ever runs inside the focus event. Both
  // halves still run, selection first, exactly as `then` would order them.
  const select = selectAllOnFocus(shown);

  return (
    <TextInput
      value={shown}
      onKeyPress={(event) => {
        const { key } = event.nativeEvent;
        if (key !== 'Backspace' && !/^[0-9]+$/.test(key)) return;
        const now = latest();
        const next = pressClockKey(now.digits, key, replaceNext.current);
        replaceNext.current = false;
        const text = digitsToClock(next);
        if (text === now.text) return;
        typed.current = { from: value, to: text, digits: next };
        onChangeText(text);
      }}
      selectTextOnFocus={select.selectTextOnFocus}
      onFocus={(event) => {
        select.onFocus?.(event);
        replaceNext.current = shown !== '';
        typed.current = null;
      }}
      onBlur={() => {
        const now = latest();
        replaceNext.current = false;
        typed.current = null;
        const settled = commitClock(now.text);
        if (settled !== now.text) onChangeText(settled);
      }}
      placeholder={placeholder}
      placeholderTextColor={palette.inkMuted}
      keyboardType="number-pad"
      returnKeyType={KEYPAD_DONE}
      contextMenuHidden
      className={
        centered
          ? '-my-[5px] min-h-[44px] py-0 text-center font-mono text-[15px] text-ink'
          : '-my-[5px] min-h-[44px] py-0 font-mono text-[15px] text-ink'
      }
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Type the digits; they fill from the right."
    />
  );
}
