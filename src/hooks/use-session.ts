import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

export type SessionState = {
  session: Session | null;
  /** True until the persisted session has been read back from storage. */
  isLoading: boolean;
};

/**
 * Tracks the current Supabase auth session.
 *
 * Resolves to `{ session: null, isLoading: false }` when Supabase is not yet
 * configured, so the shell stays usable before a project is provisioned.
 */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null>(null);
  // `isSupabaseConfigured` is a build-time constant, so the "nothing to load"
  // case is derived here rather than corrected by a setState in the effect.
  const [isLoading, setIsLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    const supabase = getSupabase();
    let cancelled = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setIsLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, isLoading };
}
