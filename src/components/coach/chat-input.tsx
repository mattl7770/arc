import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';

import { palette } from '@/constants/theme';

type Props = {
  onSend: (text: string) => void;
  /**
   * A reply is streaming: sending is blocked, but the field stays open so the
   * owner can draft the next message while the Coach talks. Unchanged behaviour.
   */
  disabled?: boolean;
  /**
   * Set only when the composer must genuinely close — today, while a pending
   * write is awaiting a decision (00-design-spec.md §5: "the composer
   * disabled"). The string is shown above the field, because a control that
   * stops responding without saying why reads as a bug.
   */
  blockedReason?: string;
};

/**
 * The message composer, pinned above the keyboard.
 *
 * Conformed Set treatment — the **recessed stock** of the `well` device: the
 * field is `paper-dim` inside a `paper-deep` edge, square, on a sheet-coloured
 * bar closed by a hairline. It is drawn with the well's own tokens rather than
 * wrapped in `<Block device="well">` because the Block carries fixed padding and
 * this field has to flex beside a fixed 44pt button — same surface, same
 * reading, sized to the job.
 *
 * The send button is the screen's **one accent action**, and it holds the accent
 * only while it can actually be pressed. That is what keeps the budget honest
 * when the pending-write stamp is up: the stamp becomes the accent action and
 * this one drops to neutral, so the screen never shows two.
 *
 * "Neutral" is a **bordered recess** (`border-hairline` + `bg-paper-dim`), not a
 * `hairline` fill: muted ink on `hairline` is 2.98:1 and fails AA outright,
 * while on `paper-dim` it is the documented 5.17:1. Disabled is not exempt from
 * contrast — it still has to be readable to explain why it can't be pressed.
 * This is the same recess the rest of the app uses for a disabled control.
 *
 * Owns its own draft text so a keystroke doesn't re-render the whole thread.
 */
export function ChatInput({ onSend, disabled = false, blockedReason }: Props) {
  const [text, setText] = useState('');
  const blocked = blockedReason !== undefined;
  const canSend = text.trim().length > 0 && !disabled && !blocked;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
  };

  return (
    <View className="border-t border-hairline bg-paper px-5 pb-2 pt-2.5">
      {blocked ? (
        <Text className="mb-2 font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
          {blockedReason}
        </Text>
      ) : null}

      <View className="flex-row items-end gap-2">
        <View
          className={
            blocked
              ? 'max-h-32 flex-1 justify-center border border-paper-deep bg-paper-dim px-3.5 opacity-60'
              : 'max-h-32 flex-1 justify-center border border-paper-deep bg-paper-dim px-3.5'
          }>
          <TextInput
            value={text}
            onChangeText={setText}
            editable={!blocked}
            placeholder="Message the Coach"
            placeholderTextColor={palette.inkMuted}
            multiline
            // Enter sends on web; Shift+Enter (and native return) still add a line.
            onKeyPress={
              Platform.OS === 'web'
                ? (event) => {
                    const native = event.nativeEvent as { key?: string; shiftKey?: boolean };
                    if (native.key === 'Enter' && !native.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }
                : undefined
            }
            className="py-2.5 font-serif text-[15px] leading-5 text-ink"
            accessibilityLabel="Message the Coach"
          />
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={submit}
          className={
            canSend
              ? 'h-11 w-11 items-center justify-center bg-pine active:opacity-70'
              : 'h-11 w-11 items-center justify-center border border-hairline bg-paper-dim'
          }>
          <Ionicons name="arrow-up" size={20} color={canSend ? palette.pineOn : palette.inkMuted} />
        </Pressable>
      </View>
    </View>
  );
}
