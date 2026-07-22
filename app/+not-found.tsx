import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found', headerShown: true }} />
      <View className="flex-1 items-center justify-center gap-3 bg-white px-6 dark:bg-ink-950">
        <Text className="text-lg font-medium text-ink-900 dark:text-ink-50">
          This route does not exist.
        </Text>
        <Link href="/">
          <Text className="text-base text-accent-muted dark:text-accent">Back to Home</Text>
        </Link>
      </View>
    </>
  );
}
