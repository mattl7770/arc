import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found', headerShown: true }} />
      <View className="flex-1 items-center justify-center gap-3 bg-paper px-6">
        <Text className="font-serif text-lg font-medium text-ink">This route does not exist.</Text>
        <Link href="/">
          <Text className="text-base text-pine">Back to Home</Text>
        </Link>
      </View>
    </>
  );
}
