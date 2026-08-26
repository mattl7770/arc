import { useCallback, useState } from 'react';

import { getDb } from '@/lib/db/client';
import { getPreferences, setAppLockEnabled } from '@/lib/db/repositories/user';
import { authenticateForAppLock, isAppLockSupported } from '@/lib/security/app-lock';

export type AppLockToggleResult =
  | 'ok'
  /** The verification prompt failed or was cancelled — preference unchanged. */
  | 'auth-failed'
  /** No device passcode/biometrics to lock against — preference unchanged. */
  | 'no-credentials'
  /** Native module absent (web preview, or a build predating the module) —
   * preference unchanged. */
  | 'unsupported';

/**
 * Read/write the app-lock preference for the Settings toggle (the
 * use-unit-preferences pattern: sync first read in the initializer, persist
 * through the user repository).
 *
 * Enabling authenticates FIRST and only persists on success, so the lock can
 * never trap its owner: a device with nothing to check against, or a prompt
 * the user can't pass right now, refuses to arm. Disabling needs no prompt —
 * the user is already inside the unlocked app, so the boundary was crossed.
 */
export function useAppLockPreference(): {
  enabled: boolean;
  /** False when the native module is absent — the UI shows "needs a build". */
  supported: boolean;
  setEnabled: (next: boolean) => Promise<AppLockToggleResult>;
} {
  const [enabled, setEnabledState] = useState(() => getPreferences(getDb()).appLock.enabled);

  const setEnabled = useCallback(async (next: boolean): Promise<AppLockToggleResult> => {
    if (!next) {
      setEnabledState(setAppLockEnabled(getDb(), false).appLock.enabled);
      return 'ok';
    }
    if (!isAppLockSupported()) return 'unsupported';
    const outcome = await authenticateForAppLock();
    if (outcome === 'success') {
      setEnabledState(setAppLockEnabled(getDb(), true).appLock.enabled);
      return 'ok';
    }
    if (outcome === 'no_credentials') return 'no-credentials';
    return outcome === 'unavailable' ? 'unsupported' : 'auth-failed';
  }, []);

  return { enabled, supported: isAppLockSupported(), setEnabled };
}
