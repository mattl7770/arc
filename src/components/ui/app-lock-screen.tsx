import { Pressable, Text, View } from 'react-native';

/**
 * The locked surface — everything ARC shows until Face ID / passcode passes.
 *
 * Porcelain Ledger, quietest possible: bone paper, serif wordmark, a mono
 * status line, and one pine action (the single thing that matters here).
 * Deliberately no data, no previews, no last-screen blur — content simply
 * does not render behind this (see useAppLock).
 *
 * Rendered two ways by app/_layout.tsx: as the whole tree at cold start, and
 * as an opaque absolute-fill overlay on re-lock. It fills whatever it's given
 * (`flex-1`), so both work.
 */
export function AppLockScreen({
  unlocking,
  onUnlock,
}: {
  unlocking: boolean;
  onUnlock: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center bg-paper px-8">
      <Text className="font-serif text-[28px] font-semibold text-ink">ARC</Text>
      <Text className="mt-2 font-mono text-[11px] uppercase tracking-[2px] text-ink-muted">
        Locked
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Unlock"
        accessibilityState={{ disabled: unlocking }}
        disabled={unlocking}
        onPress={onUnlock}
        className="mt-8 min-w-[160px] items-center rounded-btn bg-pine px-6 py-3 active:opacity-70">
        <Text className="text-[15px] font-medium text-pine-on">
          {unlocking ? 'Unlocking…' : 'Unlock'}
        </Text>
      </Pressable>
      <Text className="mt-4 text-[12px] text-ink-secondary">Face ID or device passcode</Text>
    </View>
  );
}
