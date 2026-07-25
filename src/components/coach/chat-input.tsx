import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';

import { palette } from '@/constants/theme';

type Props = {
  onSend: (text: string) => void;
  disabled?: boolean;
};

/**
 * The message composer, pinned above the keyboard: a recessed paper field and
 * one pine send button — the only accent affordance down here.
 *
 * Owns its own draft text so a keystroke doesn't re-render the whole thread.
 */
export function ChatInput({ onSend, disabled = false }: Props) {
  const [text, setText] = useState('');
  const canSend = text.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
  };

  return (
    <View className="flex-row items-end gap-2 border-t border-hairline bg-paper px-4 pb-2 pt-2.5">
      <View className="max-h-32 flex-1 justify-center rounded-lg bg-paper-deep px-4 py-1">
        <TextInput
          value={text}
          onChangeText={setText}
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
          className="py-2 text-[15px] leading-5 text-ink"
          accessibilityLabel="Message the Coach"
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        accessibilityState={{ disabled: !canSend }}
        disabled={!canSend}
        onPress={submit}
        className={`h-11 w-11 items-center justify-center rounded-btn ${
          canSend ? 'bg-pine active:opacity-70' : 'bg-hairline'
        }`}>
        <Ionicons name="arrow-up" size={20} color={canSend ? palette.pineOn : palette.inkMuted} />
      </Pressable>
    </View>
  );
}
