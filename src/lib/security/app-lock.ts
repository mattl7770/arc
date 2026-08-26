/**
 * Face ID / passcode app lock — the auth half of ARC's security boundary.
 *
 * ARC has no accounts (single-user, local-first), so the OS plus this lock ARE
 * the boundary (CLAUDE.md §2). The gate itself lives in app/_layout.tsx via
 * src/hooks/use-app-lock.ts; this module is the only place that talks to
 * `expo-local-authentication`, following the api-key-store pattern: the native
 * module is required in a try/catch and every consumer gets an honest answer
 * when it is absent (the web logic-check preview, or a JS bundle that shipped
 * ahead of its native build).
 *
 * FAIL-OPEN RULES (deliberate, narrow):
 *  - Module genuinely absent → 'unavailable'. There is nothing to authenticate
 *    with; blocking would brick the app on every surface that can't rebuild.
 *  - Device has no passcode/biometrics to check against → 'no_credentials'.
 *    Also open: enabling the lock requires a successful auth (so credentials
 *    existed then), and iOS demands the current passcode to remove a passcode —
 *    whoever removed it already crossed a stronger boundary than ours.
 *  - Anything else — cancelled, failed, lockout, or a throwing native call —
 *    is 'failed' and MUST keep content hidden.
 */

/** An `expo-local-authentication` result (LocalAuthenticationResult). */
type NativeAuthResult = { success: true } | { success: false; error: string };

/** The slice of expo-local-authentication this module uses. */
type LocalAuthModule = {
  authenticateAsync(options?: {
    promptMessage?: string;
    cancelLabel?: string;
    disableDeviceFallback?: boolean;
  }): Promise<NativeAuthResult>;
};

// Required in a try/catch so a missing native module or a throwing web shim
// never takes down the bundle — the lock degrades to "unavailable".
let localAuth: LocalAuthModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  localAuth = require('expo-local-authentication') as LocalAuthModule;
} catch {
  localAuth = null;
}

/**
 * How long ARC may sit in the background before returning requires a fresh
 * unlock. Short enough that a phone left on a table re-locks, long enough that
 * flicking to Messages and back doesn't prompt every time.
 */
export const APP_LOCK_RELOCK_MS = 30_000;

export type AppLockAuthOutcome =
  /** The user proved presence — reveal. */
  | 'success'
  /** Cancelled, failed, or indeterminate — MUST stay hidden. */
  | 'failed'
  /** No device passcode set — open by the rationale in the module docblock. */
  | 'no_credentials'
  /** Native module absent (web preview, or a build predating the module) —
   * nothing to ask. */
  | 'unavailable';

/** Whether the native module is present, i.e. the lock can actually gate. */
export function isAppLockSupported(): boolean {
  return typeof localAuth?.authenticateAsync === 'function';
}

/**
 * Run one Face ID / passcode prompt and fold the result into the four
 * outcomes the gate and the Settings toggle act on. Device-passcode fallback
 * stays enabled (the default LAPolicyDeviceOwnerAuthentication), so a failed
 * Face ID read still offers the passcode sheet before this reports 'failed'.
 */
export async function authenticateForAppLock(): Promise<AppLockAuthOutcome> {
  const mod = localAuth;
  if (!mod || typeof mod.authenticateAsync !== 'function') return 'unavailable';
  try {
    const result = await mod.authenticateAsync({
      promptMessage: 'Unlock ARC',
      cancelLabel: 'Cancel',
    });
    if (result.success) return 'success';
    return result.error === 'passcode_not_set' ? 'no_credentials' : 'failed';
  } catch {
    // The module exists but the call blew up: an indeterminate result reads as
    // a failure — never as an unlock.
    return 'failed';
  }
}
