import { Pressable, Text, View } from 'react-native';

import { PaperGrid } from '@/components/ui/screen';

/**
 * The locked surface — everything ARC shows until Face ID / passcode passes.
 *
 * This is the first thing seen on a cold start, so it has to read as an
 * authored drafting surface rather than a blank gate. Conformed Set treatment:
 * the wordmark in serif, the lock state as a **drawn badge**, one action and
 * the caption naming what unlocks it — all printed on the
 * paper grid, which this screen renders itself because it builds its own root
 * rather than using `<Screen>` (it is handed a full tree by app/_layout.tsx and
 * fills whatever it is given). Being the very first surface of a cold start, it
 * is the worst possible place for the stock to be blank.
 *
 * ## Why "Locked" is a badge and not a `field`
 *
 * It used to be `<Block device="field">`, on the reading that a lock state is a
 * verdict about the app. That reading is still right; the *device* is not, and
 * it is worth being precise about why, because the original reason has since
 * been withdrawn.
 *
 * The reason recorded here was that `field` had been stripped of its corner
 * ticks and its padding, so at chip scale it rendered as literally nothing —
 * the wordmark sat above the prose with a gap where the status should be. That
 * stripping is undone: `field` draws its ticks again, and its padding with them
 * (block.tsx — the marks were never a design failure, they were rendering as
 * boxes). So the empty-device argument no longer applies to anything.
 *
 * The treatment stays a badge on the argument that always did the real work:
 * **`field` is a section-scale device and this call site is one word.** Two 11pt
 * corner ticks bracketing a single word would read as a clipped box round it,
 * not as a measured region, and the device's inset would sit a chip out of line
 * with the sheet. So the badge is explicit and local: a hairline box with its
 * own padding, `self-center` to shrink-wrap the word. It is the same badge the
 * app draws for the "Custom" tag in exercise-picker.tsx and the mode chip in
 * mode-control.tsx — chip-scale status is chrome, and chrome carries no device.
 *
 * Both voices in use are used correctly: serif speaks (the wordmark), label
 * marks (LOCKED, the button, the caption). Nothing here is a measurement, so
 * nothing here is mono — the old `font-mono` on the word "Locked" was the same
 * category error as a metric set in serif ("Locked" is a state, not a value).
 *
 * **Accent budget: exactly one** — the Unlock action, which is genuinely the
 * only thing that can be done on this screen. The badge's rule is ink, the
 * caption is ink, the paper is paper.
 *
 * Deliberately no data, no previews, no last-screen blur — content simply does
 * not render behind this (see useAppLock). The line that said so in words was
 * cut by the owner as explanatory copy on 2026-08-11.
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
    // The root carries the sheet and NO padding — but NOT for the reason this
    // comment used to give ("Yoga insets absolutely-positioned children by the
    // parent's padding"), which is false when an inset is defined; the padding
    // lives on the inner view below instead simply because that is where the
    // content wants it. See ./screen.tsx for the citation and for why the true
    // behaviour is load-bearing elsewhere.
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

        {/* The one accent on this surface, and the only thing to do on it. The
            line of prose that stood between it and the badge above was cut by
            the owner as explanatory copy on 2026-08-11. */}
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
