import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import type { Database } from '@/types/database';

import { env, isSupabaseConfigured, MISSING_SUPABASE_ENV_MESSAGE } from './env';

export { isSupabaseConfigured };

export type ArcSupabaseClient = SupabaseClient<Database>;

let client: ArcSupabaseClient | null = null;

/**
 * Returns the shared Supabase client, creating it on first use.
 *
 * This is a function rather than a module-level `export const supabase` so
 * that importing anything from this file has no side effects and the app can
 * still boot with no `.env` present. Call it only from code paths that have
 * checked `isSupabaseConfigured`, or be ready to handle the throw.
 */
export function getSupabase(): ArcSupabaseClient {
  if (client) return client;

  if (!isSupabaseConfigured) {
    throw new Error(MISSING_SUPABASE_ENV_MESSAGE);
  }

  const instance = createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      // Sessions persist in AsyncStorage so a cold start stays signed in.
      storage: AsyncStorage,
      persistSession: true,
      autoRefreshToken: true,
      // There is no callback URL to read a session out of in a native app.
      detectSessionInUrl: false,
    },
  });

  /*
   * Supabase only refreshes tokens while its timer is running. On native we
   * tie that timer to the app's foreground state, otherwise a backgrounded app
   * resumes with an expired session. On web the browser tab handles this.
   */
  if (Platform.OS !== 'web') {
    AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void instance.auth.startAutoRefresh();
      } else {
        void instance.auth.stopAutoRefresh();
      }
    });
  }

  client = instance;
  return client;
}
