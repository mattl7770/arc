import type { TextInputProps } from 'react-native';

/**
 * **The way out of a number pad.** One prop, spelled once here, because on its
 * own at a call site it looks like dead code and the next reader deletes it.
 *
 * ## The bug (owner, on device, about the water goal): *"you cant close the
 * keyboard so its impossible to actually put a number in"*
 *
 * iOS number pads have **no return key**. `UIKeyboardTypeNumberPad`,
 * `DecimalPad`, `PhonePad` and `ASCIICapableNumberPad` are grids of digits with
 * a backspace and nothing else — no blue key in the corner, so nothing on the
 * keyboard itself ends editing. A field whose only confirm control sits under
 * the keyboard is then genuinely unfinishable: you can type, you cannot commit,
 * and you cannot see what you typed.
 *
 * ## React Native already ships the fix, and it is opt-in by accident
 *
 * `RCTTextInputComponentView.setDefaultInputAccessoryView` (RN 0.86,
 * React/Fabric/Mounting/ComponentViews/TextInput) builds a real `UIToolbar`
 * with a Done button above exactly those four keyboards — but only when
 *
 * ```objc
 * shouldHaveInputAccessoryView = (keyboardType is one of the four number pads)
 *   && (containsKeyType || containsInputAccessoryViewButtonLabel);
 * ```
 *
 * and `containsKeyType` tests `returnKeyType` against a set that holds Done, Go,
 * Next, Search, Send and friends **but not `UIReturnKeyDefault`**. Leave
 * `returnKeyType` unset — as every numeric field in ARC did — and the toolbar is
 * never built. Set it, and iOS draws its own standard accessory bar for free.
 *
 * Tapping that Done runs `handleInputAccessoryDoneButton`: it fires
 * `onSubmitEditing` and then `endEditing:YES`. A single-line `TextInput` with no
 * explicit `submitBehavior` resolves to `blurAndSubmit` (TextInput.js), so Done
 * both **commits and dismisses** — which is why a field that wants Done to mean
 * "save this" only has to add `onSubmitEditing`.
 *
 * ## Why not a hand-rolled `InputAccessoryView`
 *
 * RN's own `<InputAccessoryView>` would also work — it is core RN, it is
 * registered for Fabric on iOS (`RCTInputAccessoryComponentView`), and
 * `inputAccessoryViewID` is wired through. It was rejected on three counts:
 *
 * 1. It has to be **mounted per screen** and its `nativeID` matched by hand on
 *    every field, so the rule can be half-applied in a way this constant cannot.
 * 2. RN's built-in toolbar is the **native control** — system tint, system
 *    metrics, the bar every other iOS app puts over a number pad. A hand-drawn
 *    bar would be ARC re-implementing UIKit at a place the user reads as the OS.
 * 3. `react-native-web` **does not export `InputAccessoryView` at all**, so a
 *    hand-rolled bar would need a `Platform.OS` gate and would be invisible to
 *    the headless render suite. `returnKeyType` survives that translation as
 *    `enterKeyHint="done"` in the rendered markup, which is what lets
 *    `db/screens-render.test.mjs` assert the rule on every screen it walks.
 *
 * ## The other half of the bug lives in `Screen`
 *
 * Being able to dismiss the keyboard is not the same as being able to see the
 * field under it. That half is `automaticallyAdjustKeyboardInsets` on the scroll
 * container — see the note on {@link Screen} in ./screen.tsx.
 */
export const KEYPAD_DONE = 'done' as const;

/**
 * The keyboards with no return key — the ones {@link KEYPAD_DONE} exists for.
 * `numeric` is on the list because iOS resolves it to `UIKeyboardTypeDecimalPad`
 * (`RCTUIKeyboardTypeFromKeyboardType`), so it is a number pad under a name that
 * does not say so. `numbers-and-punctuation` and `url` are NOT: both are full
 * keyboards and both already carry a return key.
 *
 * `ascii-capable-number-pad` is the fifth pad RN's toolbar check covers and is
 * deliberately absent: RN's own `KeyboardTypeOptions` union does not include it,
 * so it cannot be typed here and cannot be passed anywhere in this app either.
 */
const KEYPADS: readonly TextInputProps['keyboardType'][] = [
  'number-pad',
  'decimal-pad',
  'numeric',
  'phone-pad',
];

/**
 * {@link KEYPAD_DONE}, but derived — for the shared `FormField` wrappers that
 * take `keyboardType` as a prop and cannot know at author time whether the field
 * they are drawing is a number pad or a name. Returns `undefined` for keyboards
 * that already have a return key, so a text field keeps its own "return" label
 * instead of being relabelled for a problem it does not have.
 */
export function keypadDoneKey(
  keyboardType: TextInputProps['keyboardType']
): typeof KEYPAD_DONE | undefined {
  return keyboardType !== undefined && KEYPADS.includes(keyboardType) ? KEYPAD_DONE : undefined;
}
