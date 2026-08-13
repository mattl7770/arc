import { useSyncExternalStore } from 'react';

import { apiKeyStore } from '@/lib/ai/api-key-store';

/**
 * Whether an API key is set, as reactive state — re-renders when the user
 * connects, disconnects, or the Keychain hydrates at boot. The key VALUE never
 * crosses this hook; UI only ever needs the boolean.
 */
export function useSessionKeySet(): boolean {
  // The third argument is the SERVER snapshot, and it is deliberately the same
  // reader as the client one: this store is a synchronous in-memory mirror with
  // no client/server distinction to make. Without it React throws "Missing
  // getServerSnapshot" the moment a screen using this hook is rendered by
  // `renderToString` — which is exactly what db/screens-render.test.mjs does to
  // prove a screen cannot crash on import. Omitting it made the hook a hole in
  // that suite's coverage rather than a runtime bug.
  return useSyncExternalStore(apiKeyStore.subscribe, apiKeyStore.has, apiKeyStore.has);
}
