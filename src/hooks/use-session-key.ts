import { useSyncExternalStore } from 'react';

import { sessionKeyStore } from '@/lib/ai/session-key-store';

/**
 * Whether a session API key is set, as reactive state — re-renders when the
 * user connects or disconnects. The key VALUE never crosses this hook; UI only
 * ever needs the boolean.
 */
export function useSessionKeySet(): boolean {
  return useSyncExternalStore(sessionKeyStore.subscribe, sessionKeyStore.has);
}
