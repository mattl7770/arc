import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';

/**
 * The locked surface — everything ARC shows until Face ID / passcode passes.
 *
 * This is the first thing seen on a cold start, so it has to read as an
 * authored drafting surface rather than a blank gate. Conformed Set treatment:
 * the wordmark in serif, the lock state in the **measured field** device
 * (corner ticks, no enclosure — it is a verdict about the app, not a record of
 * anything), a short authored line saying *why* the sheet is empty, and one
 * action.
 *
 * All three voices, used correctly: serif speaks (the wordmark, the line of
 * prose), label marks (LOCKED, the caption). Nothing here is a measurement, so
 * nothing here is mono — the old `font-mono` on the word "Locked" was the same
 * category error as a metric set in serif ("Locked" is a state, not a value).
 *
 * **Accent budget: exactly one** — the Unlock action, which is genuinely the
 * only thing that can be done on this screen. The field's ticks are ink, the
 * caption is ink, the paper is paper.
 *
 * Deliberately no data, no previews, no last-screen blur — content simply does
 * not render behind this (see useAppLock), and the copy says so rather than
 * leaving the emptiness looking like a failure to load.
 *
 * Rendered two ways by app/_layout.tsx: as the whole tree at cold start, and as
 * an opaque full-screen Modal on re-lock. It fills whatever it's given
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
      <Text className="font-serif text-[30px] font-semibold text-ink">ARC</Text>

      {/* The measured field: a status readout, bracketed rather than boxed. */}
      <View className="mt-5">
        <Block device="field">
          <Text className="font-label text-[11px] font-semibold uppercase tracking-[2px] text-ink">
            Locked
          </Text>
        </Block>
      </View>

      <Text className="mt-5 text-center font-serif text-[14px] leading-6 text-ink-secondary">
        Nothing is drawn behind this screen. ARC opens once this device confirms it is you.
      </Text>

      {/* The one accent on this surface, and the only thing to do on it. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Unlock"
        accessibilityState={{ disabled: unlocking }}
        disabled={unlocking}
        onPress={onUnlock}
        className="mt-7 min-h-[44px] min-w-[184px] items-center justify-center rounded-btn bg-pine px-6 py-3 active:opacity-70">
        <Text className="font-label text-[15px] font-semibold text-pine-on">
          {unlocking ? 'Unlocking…' : 'Unlock'}
        </Text>
      </Pressable>

      <Text className="mt-3.5 font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
        Face ID or device passcode
      </Text>
    </View>
  );
}
