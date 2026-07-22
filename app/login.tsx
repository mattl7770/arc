import { Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { isSupabaseConfigured } from '@/lib/supabase';

/**
 * Auth entry point. Not wired up yet — nothing redirects here (see app/_layout.tsx).
 *
 * It reports the Supabase configuration state so the first thing you learn on
 * this route is whether your `.env` was picked up.
 */
export default function LoginScreen() {
  return (
    <Screen>
      <View className="flex-1 justify-center">
        <Text className="text-3xl font-semibold tracking-tight text-ink-900 dark:text-ink-50">
          Sign in
        </Text>
        <Text className="mt-2 text-base leading-6 text-ink-500 dark:text-ink-400">
          Supabase auth is not implemented yet.
        </Text>

        <View className="mt-8 rounded-xl border border-ink-200 p-4 dark:border-ink-800">
          <Text className="text-xs uppercase tracking-widest text-ink-400 dark:text-ink-600">
            Supabase
          </Text>
          <Text
            className={
              isSupabaseConfigured
                ? 'mt-1 text-base text-signal-optimal'
                : 'mt-1 text-base text-signal-caution'
            }>
            {isSupabaseConfigured ? 'Configured' : 'Not configured'}
          </Text>
          {!isSupabaseConfigured ? (
            <Text className="mt-2 text-sm leading-5 text-ink-500 dark:text-ink-400">
              Copy .env.example to .env, fill in the URL and anon key, then restart the dev server.
            </Text>
          ) : null}
        </View>
      </View>
    </Screen>
  );
}
