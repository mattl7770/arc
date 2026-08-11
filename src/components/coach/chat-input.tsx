import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';

import { Divider } from '@/components/ui/block';
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
 * ## No mic glyph, and that is a decision — do not "restore" it
 *
 * Every composer in the mockup draws `.cf-composer-mic` at the left of the
 * field, and this one draws nothing there, because **ARC has no voice input to
 * hand it to.** There is no speech capability anywhere in the project: no
 * `expo-speech`, no `@react-native-voice/voice`, no audio module in
 * package.json, and no code that records or transcribes. The other place the
 * sheet draws a mic — the Log tab's command field — is not a counter-example: it
 * is a stub whose entire behaviour is to print "Voice capture arrives with the
 * Coach" (log/command-field.tsx), which is an honest placeholder only because it
 * has a caption underneath in which to say so. A bare glyph sitting inside this
 * field has no such room; it would simply be an affordance that does nothing,
 * which §5 forbids in the same breath as invented reference codes — drafting
 * chrome pays rent or goes. It arrives WITH voice capture, not before it, and
 * adding a speech module means a fresh EAS build regardless.
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
    <View className="bg-paper">
      {/* The composer's top edge, where the docked bar meets the thread. Drawn
          as a rule rather than a `border-t`, which would box the whole bar —
          see Divider. It sits outside the padding so it spans the full width. */}
      <Divider />
      <View className="px-5 pb-2 pt-2.5">
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
            <Ionicons
              name="arrow-up"
              size={20}
              color={canSend ? palette.pineOn : palette.inkMuted}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
