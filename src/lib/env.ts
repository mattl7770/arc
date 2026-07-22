/**
 * Typed, validated access to the app's environment.
 *
 * Only `EXPO_PUBLIC_*` variables reach the client bundle. Everything else in
 * `.env` (AI provider keys, service-role key) is server-side only and is read
 * by Supabase Edge Functions, never from here.
 */

export type AppEnv = 'development' | 'preview' | 'production';

/*
 * Metro inlines `process.env.EXPO_PUBLIC_*` at build time, but only when it is
 * written as a complete static member expression. Destructuring `process.env`
 * or indexing it dynamically silently yields `undefined` in a release build —
 * so keep these as literal property reads.
 */
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const appEnv = (process.env.EXPO_PUBLIC_APP_ENV ?? 'development') as AppEnv;

export const env = {
  supabaseUrl,
  supabaseAnonKey,
  appEnv,
} as const;

/**
 * Whether the Supabase credentials are present. The app is deliberately built
 * to boot without them so the shell can be run and developed before a project
 * is provisioned — screens that need data should branch on this.
 */
export const isSupabaseConfigured = supabaseUrl.length > 0 && supabaseAnonKey.length > 0;

export const MISSING_SUPABASE_ENV_MESSAGE =
  'Supabase is not configured. Copy .env.example to .env, set ' +
  'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, then restart ' +
  'the dev server (env vars are inlined at build time, so a reload is not ' +
  'enough).';
