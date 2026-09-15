import type { TextInputProps } from 'react-native';

/**
 * **Tap an amount, type the new one.** The owner's A3: *"auto highlight the
 * value when changing amount for a food for ease of use."*
 *
 * Every amount field in food logging arrives PREFILLED — `100`, the last
 * portion, the estimator's guess — so the first thing the user does is delete
 * what is there. Without a selection that is three taps and a held backspace on
 * a number pad that has no cursor keys; with one it is a single tap and the
 * digits they meant.
 *
 * ## Why the prop alone is not enough on iOS (verified against RN 0.86)
 *
 * `selectTextOnFocus` is the declarative answer and it is set here — but on the
 * New Architecture, which Expo SDK 57 ships, iOS reads that trait in exactly one
 * place:
 *
 * ```objc
 * // React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm
 * - (void)focus {
 *   [_backedTextInputView becomeFirstResponder];
 *   ...
 *   if (props.traits.selectTextOnFocus) { [_backedTextInputView selectAll:nil]; ... }
 * }
 * ```
 *
 * `-focus` is the IMPERATIVE command — what `ref.focus()` dispatches. A user
 * TAP never goes through it: UIKit makes the field first responder itself and
 * the component hears about it in `-textInputDidBeginEditing`, which only emits
 * `onFocus` and selects nothing. (The old architecture handled it in
 * `RCTBaseTextInputView.mm`'s own `textInputDidBeginEditing`, which is why the
 * prop has a reputation for "used to work".) The same file states the omission
 * outright: *"Traits `blurOnSubmit`, `clearTextOnFocus`, and `selectTextOnFocus`
 * were omitted intentionally here because they are being checked on-demand."*
 *
 * So the tap path needs the imperative half, and `onFocus` is where it fits.
 * `TextInput` mutates its own native instance with a `setSelection(start, end)`
 * method (`Object.assign(instance, {... setSelection ...})` in TextInput.js),
 * and that instance is what React hands back as the focus event's
 * `currentTarget` — so no `ref` is needed at the call site and this stays one
 * spreadable object.
 *
 * Both halves are kept, deliberately: the prop is what `react-native-web`
 * honours (the headless render suite and the dev-time logic preview), what an
 * imperative `focus()` would honour, and what a future RN that fixes the tap
 * path would honour; the handler is what the device needs today.
 *
 * ## Scope
 *
 * Amount and quantity fields only. Not names, not notes, not the hour/minute
 * clock pair on app/meal-detail.tsx — selecting a two-digit hour the user is
 * half-way through correcting would destroy the edit they came to make. The
 * rule is "the field holds ONE number that gets replaced wholesale".
 *
 * An empty field selects nothing and returns early: `setSelection(0, 0)` is a
 * no-op that still costs a bridge command.
 *
 * What only a device can judge: whether the selection survives the caret UIKit
 * places at the tap point. It does in every report of this workaround, and the
 * render suite cannot see a selection at all.
 */
type SelectableInput = { setSelection?: (start: number, end: number) => void };

export function selectAllOnFocus(
  value: string
): Pick<TextInputProps, 'selectTextOnFocus' | 'onFocus'> {
  return {
    selectTextOnFocus: true,
    onFocus: (event) => {
      if (value.length === 0) return;
      const input = (event.currentTarget ?? event.target) as unknown as SelectableInput | null;
      if (typeof input?.setSelection === 'function') input.setSelection(0, value.length);
    },
  };
}
