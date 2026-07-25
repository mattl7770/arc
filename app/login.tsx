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
        <Text className="font-serif text-3xl font-semibold tracking-tight text-ink">Sign in</Text>
        <Text className="mt-2 text-base leading-6 text-ink-secondary">
          Supabase auth is not implemented yet.
        </Text>

        <View className="mt-8 rounded-card border border-hairline bg-porcelain p-4">
          <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">Supabase</Text>
          <Text
            className={
              isSupabaseConfigured
                ? 'mt-1 font-mono text-base text-signal-optimal'
                : 'mt-1 font-mono text-base text-signal-caution'
            }>
            {isSupabaseConfigured ? 'Configured' : 'Not configured'}
          </Text>
          {!isSupabaseConfigured ? (
            <Text className="mt-2 text-sm leading-5 text-ink-secondary">
              Copy .env.example to .env, fill in the URL and anon key, then restart the dev server.
            </Text>
          ) : null}
        </View>
      </View>
    </Screen>
  );
}
