import { useSyncExternalStore } from 'react';

import { apiKeyStore } from '@/lib/ai/api-key-store';

/**
 * Whether an API key is set, as reactive state — re-renders when the user
 * connects, disconnects, or the Keychain hydrates at boot. The key VALUE never
 * crosses this hook; UI only ever needs the boolean.
 */
export function useSessionKeySet(): boolean {
  return useSyncExternalStore(apiKeyStore.subscribe, apiKeyStore.has);
}
