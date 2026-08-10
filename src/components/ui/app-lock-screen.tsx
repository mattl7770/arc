import { Pressable, Text, View } from 'react-native';

import { PaperGrid } from '@/components/ui/screen';

/**
 * The locked surface — everything ARC shows until Face ID / passcode passes.
 *
 * This is the first thing seen on a cold start, so it has to read as an
 * authored drafting surface rather than a blank gate. Conformed Set treatment:
 * the wordmark in serif, the lock state as a **drawn badge**, a short authored
 * line saying *why* the sheet is empty, and one action — all printed on the
 * paper grid, which this screen renders itself because it builds its own root
 * rather than using `<Screen>` (it is handed a full tree by app/_layout.tsx and
 * fills whatever it is given). Being the very first surface of a cold start, it
 * is the worst possible place for the stock to be blank.
 *
 * ## Why "Locked" is a badge and not a `field`
 *
 * It used to be `<Block device="field">`, on the reading that a lock state is a
 * verdict about the app. That reading is still right; the *device* is not. When
 * `field` lost its corner ticks (block.tsx, "Devices that stopped paying rent")
 * it lost its padding with them — correctly, because `field` is a
 * **section-scale** device and an inset would knock a whole unboxed section out
 * of alignment with its neighbours. But this call site is one word, chip scale,
 * and a device that draws nothing and pads nothing rendered it as literally
 * nothing: the wordmark simply sat above the prose with a gap where the status
 * was meant to be.
 *
 * So the treatment is explicit and local rather than borrowed: a hairline badge
 * with its own padding, `self-center` so it shrink-wraps the word instead of
 * spanning the sheet. That is the same badge the app already draws for the
 * "Custom" tag in exercise-picker.tsx and for the mode chip in
 * mode-control.tsx — chip-scale status is chrome, and chrome carries no device.
 * The fix belongs here and not on `field`, whose unmarked, unpadded form is
 * correct everywhere it is actually used at section scale.
 *
 * All three voices, used correctly: serif speaks (the wordmark, the line of
 * prose), label marks (LOCKED, the caption). Nothing here is a measurement, so
 * nothing here is mono — the old `font-mono` on the word "Locked" was the same
 * category error as a metric set in serif ("Locked" is a state, not a value).
 *
 * **Accent budget: exactly one** — the Unlock action, which is genuinely the
 * only thing that can be done on this screen. The badge's rule is ink, the
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
    // The root carries the sheet and NO padding: Yoga insets absolutely
    // positioned children by the parent's padding, so a padded root would leave
    // an 8-unit bare margin all the way round the grid.
    <View className="flex-1 bg-paper">
      <PaperGrid />

      <View className="flex-1 items-center justify-center px-8">
        <Text className="font-serif text-[30px] font-semibold text-ink">ARC</Text>

        {/* The status badge: chip scale, so it is drawn here rather than
            delegated to the section-scale `field` device — see the note above.
            `self-center` shrink-wraps the word; without it the badge would
            stretch to the full width of the column. */}
        <View className="mt-5 self-center border border-hairline px-2.5 py-1">
          <Text className="font-label text-[11px] font-semibold uppercase tracking-[2px] text-ink">
            Locked
          </Text>
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
    </View>
  );
}
