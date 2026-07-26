import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

/**
 * Header for a stack-pushed screen (Nutrition, Exercise, the metric keypad…):
 * a back chevron and a serif title. The tab screens don't use this — they own
 * their own headers — but pushed screens have no native header (headerShown is
 * off globally), so this is how you get back.
 */
export function StackHeader({ title }: { title: string }) {
  const router = useRouter();
  return (
    <View className="flex-row items-center gap-1 pb-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        className="-ml-2 h-9 w-9 items-center justify-center rounded-btn active:opacity-60">
        <Ionicons name="chevron-back" size={22} color={palette.ink} />
      </Pressable>
      <Text className="font-serif text-lg font-semibold text-ink">{title}</Text>
    </View>
  );
}
