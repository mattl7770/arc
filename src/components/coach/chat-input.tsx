import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Platform, Pressable, TextInput, useColorScheme, View } from 'react-native';

import { palette } from '@/constants/theme';

type Props = {
  onSend: (text: string) => void;
  disabled?: boolean;
};

/**
 * The message composer, pinned above the keyboard.
 *
 * Owns its own draft text so a keystroke doesn't re-render the whole thread.
 * The send button is the only accent affordance down here — it is the primary
 * action, and nothing else competes with it.
 */
export function ChatInput({ onSend, disabled = false }: Props) {
  const [text, setText] = useState('');
  const isDark = useColorScheme() === 'dark';
  const canSend = text.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
  };

  return (
    <View className="flex-row items-end gap-2 border-t border-ink-100 bg-white px-4 pb-2 pt-2.5 dark:border-ink-800 dark:bg-ink-950">
      <View className="max-h-32 flex-1 justify-center rounded-3xl bg-ink-100 px-4 py-1 dark:bg-ink-900">
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message the Coach"
          placeholderTextColor={isDark ? palette.ink[500] : palette.ink[400]}
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
          className="py-2 text-[15px] leading-5 text-ink-900 dark:text-ink-50"
          accessibilityLabel="Message the Coach"
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        accessibilityState={{ disabled: !canSend }}
        disabled={!canSend}
        onPress={submit}
        className={`h-11 w-11 items-center justify-center rounded-full ${
          canSend ? 'bg-accent active:opacity-70' : 'bg-ink-200 dark:bg-ink-800'
        }`}>
        <Ionicons
          name="arrow-up"
          size={20}
          color={canSend ? '#FFFFFF' : isDark ? palette.ink[600] : palette.ink[400]}
        />
      </Pressable>
    </View>
  );
}
