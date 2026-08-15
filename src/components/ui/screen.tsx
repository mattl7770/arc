import { memo, type ReactNode, useMemo } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { type Edge, SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { paperGrid, palette } from '@/constants/theme';

/**
 * One rule of the drafting grid. Ink at FULL alpha — the strength is
 * `paperGrid.opacity` on the group above, which keeps the dial in one place. Do
 * not name the percentage here; it has moved once already (0.06 → 0.20,
 * 2026-08-10) and a second copy of it just goes stale.
 *
 * 1pt wide, not `StyleSheet.hairlineWidth`. The mockup's rule is 1 CSS px and
 * the retired PNG baked 1pt at every density; a hairline would be a third of
 * that on an @3x phone and would land the texture back under threshold, which
 * is the exact failure this layer has already had twice.
 */
const rule = {
  position: 'absolute',
  backgroundColor: palette.ink,
} as const;

const styles = StyleSheet.create({
  vertical: { ...rule, top: 0, bottom: 0, width: 1 },
  horizontal: { ...rule, left: 0, right: 0, height: 1 },
});

/**
 * The printed sheet, on its own — the grid layer lifted out of {@link Screen} so
 * that a root which *cannot* use `Screen` can still print it.
 *
 * Six full-screen surfaces build their own root and so bypass `Screen`
 * entirely: the Coach tab (it needs a `KeyboardAvoidingView` wrapping a docked
 * composer, which `Screen`'s scroll/gutter contract cannot express), the three
 * native `Modal`s (mode picker, exercise picker, routine picker), the app-lock
 * screen and the error boundary. Before this existed the grid lived inline in
 * `Screen`, so five of six tabs had the texture and Coach did not — a whole tab
 * on visibly different stock.
 *
 * **One implementation, one dial.** Both `Screen` and every bypassing root
 * render this, so `paperGrid.opacity` in `src/constants/theme.ts` stays the only
 * place the texture is tuned.
 *
 * **How to place it:** first child of a root `View` that carries `bg-paper` and
 * NO padding, sitting *outside* the SafeAreaView so the grid runs edge to edge
 * with no seam at the status-bar inset, and outside any ScrollView so the paper
 * stays fixed while content moves over it.
 *
 * (This used to justify the no-padding rule by claiming "Yoga insets
 * absolutely-positioned children by the parent's padding, unlike CSS". **That
 * is false in this RN version whenever an inset is defined.**
 * `ReactCommon/yoga/yoga/algorithm/AbsoluteLayout.cpp` offsets by
 * `position + border + margin`; padding enters only through the static-position
 * helpers, which are reached when NO inset is given at all. `absoluteFill`
 * defines all four, so this layer fills a padded parent edge to edge anyway.
 * The no-padding rule stands on the two reasons above — the status-bar seam and
 * the scroll — not on that one. Recorded rather than deleted because
 * `HatchCap` and `CornerTicks` in ./block.tsx both rely on the TRUE behaviour to
 * land on the edges they bracket, and "correcting" them to match the false claim
 * would push both marks inside those edges.)
 *
 * **Why plain Views and not an image.** This shipped twice as
 * `<Image resizeMode="repeat">` over a 9pt tile and **never once rendered on the
 * owner's device** — through an opacity recalibration and a Metro cache clear
 * alike. `repeat` is the least-exercised resize mode on iOS and the diagnosis
 * never converged, so the layer was rewritten as something that cannot fail:
 * absolutely-positioned 1pt `View`s, one per rule. Certainty beats elegance for
 * a texture that has already cost three rounds.
 *
 * **The node count is the price.** At `paperGrid.pitch` = 9 that is 42v + 75h =
 * 117 Views on a 375 × 667 SE, 44 + 95 = **139** on a 393 × 852 iPhone 16, and
 * 49 + 107 = 156 on a 440 × 956 Pro Max. Affordable *because this layer is
 * inert*: it derives from nothing but the window size, so it mounts once per
 * root and never re-renders, never measures, never animates, and never
 * scrolls — Core Animation caches the group and each frame costs a composite of
 * flat sublayers. If it ever needs to be cheaper the pitch is now a live
 * constant rather than PNG geometry, so doubling it to 18 halves the count with
 * a one-number edit.
 *
 * Group `opacity` on the wrapper (rather than a translucent ink per rule) is
 * also what keeps the crossings honest: verticals and horizontals overlap at
 * every intersection, and two translucent rules stacked would darken to ~0.36
 * and print a dot lattice. iOS composites the group once, so every rule and
 * every crossing lands at the same weight the tile used to have.
 *
 * `pointerEvents="none"` + `accessibilityElementsHidden` keep it inert to touch
 * and invisible to VoiceOver — it is stock, not content.
 */
export const PaperGrid = memo(function PaperGrid() {
  const { width, height } = useWindowDimensions();

  // Offsets, not counts — the map below needs the coordinate anyway, and a
  // stable `x`/`y` key beats an index when a rotation changes the array length.
  const { columns, rows } = useMemo(() => {
    const next = { columns: [] as number[], rows: [] as number[] };
    for (let x = 0; x < width; x += paperGrid.pitch) next.columns.push(x);
    for (let y = 0; y < height; y += paperGrid.pitch) next.rows.push(y);
    return next;
  }, [width, height]);

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      style={[StyleSheet.absoluteFill, { opacity: paperGrid.opacity }]}>
      {columns.map((x) => (
        <View key={`v${x}`} style={[styles.vertical, { left: x }]} />
      ))}
      {rows.map((y) => (
        <View key={`h${y}`} style={[styles.horizontal, { top: y }]} />
      ))}
    </View>
  );
});

/**
 * The root of a full-screen native `Modal` — the sheet, the grid, **its own
 * safe-area provider**, and the inset itself.
 *
 * ## The bug this exists to fix (owner, on device: *"the back button is not
 * accessible because it is too high up on the screen"*)
 *
 * `SafeAreaView` from react-native-safe-area-context v5 is a NATIVE view, not a
 * JS component reading React context. `RNCSafeAreaViewComponentView.findNearestProvider`
 * walks **`self.superview`** — the UIKit hierarchy — looking for an
 * `RNCSafeAreaProviderComponentView`, and falls back to `self` when it finds
 * none. An RN `Modal` on iOS presents its own `UIViewController`, so the React
 * children mount into a view tree that is **not a descendant of the app root**:
 * the provider react-navigation installs around the Stack is in the React tree
 * and unreachable in the native one. The walk therefore ends at `self`.
 *
 * That fallback has no update path. The insets are read in `didMoveToWindow` and
 * in `finalizeUpdates`, and refreshed only on the `RNCSafeAreaDidChange`
 * notification — which is posted by a *provider* and never by `self`. Unlike the
 * provider, the safe-area VIEW does not implement `safeAreaInsetsDidChange` and
 * has no "wait until the frame is non-zero" retry (the provider has both:
 * `RNCSafeAreaProvider.invalidateSafeAreaInsets`, and its comment says exactly
 * why). So a `SafeAreaView` inside a Modal latches whatever UIKit had for it at
 * attach time — zero, since the presentation has not laid it out yet — and never
 * corrects. The top padding is 0, `pt-2` is the whole offset, and the close
 * control sits eight points from the physical top of the screen: under the
 * status bar, behind the Dynamic Island, unreachable.
 *
 * **The fix is a provider inside the Modal, not a hand-tuned padding.** A real
 * `RNCSafeAreaProvider` in the modal's own native hierarchy gives the view below
 * it a live source that measures, retries and posts. `SafeAreaProvider` also
 * seeds itself from the parent context, so the first frame already carries the
 * app's insets rather than flashing at zero. Nothing here is a magic number, and
 * the value stays correct across rotation and a keyboard.
 *
 * All three of ARC's chooser modals had this — the Log sheet the owner reported,
 * Home's mode picker, and the exercise picker — so it lives here once. The app
 * lock's Modal is immune only by accident: it centres its content and asks for
 * no inset at all.
 *
 * **What it does NOT supply:** the `px-5` gutter. A modal's header and its
 * scroll body take the gutter separately (the paper must run edge to edge behind
 * both), so imposing one here would double it at every call site.
 */
export function ModalScreen({
  children,
  edges = ['top', 'bottom'],
}: {
  children: ReactNode;
  edges?: readonly Edge[];
}) {
  return (
    <View className="flex-1 bg-paper">
      {/* Outside the SafeAreaView so the stock runs edge to edge with no seam at
          the inset, and outside every ScrollView below: the paper is fixed and
          the content moves over it. Same placement rule as `Screen`. */}
      <PaperGrid />
      <SafeAreaProvider>
        <SafeAreaView edges={edges} className="flex-1">
          {children}
        </SafeAreaView>
      </SafeAreaProvider>
    </View>
  );
}

type ScreenProps = {
  children: ReactNode;
  /**
   * Wrap the content in a ScrollView. Leave off for screens that own their own
   * virtualised list — nesting a FlatList inside a ScrollView breaks recycling.
   */
  scroll?: boolean;
  /**
   * Safe-area edges to inset. Defaults to top only — tab screens let the tab bar
   * own the bottom. Stack-pushed screens with a bottom action (e.g. the metric
   * keypad) have no tab bar, so they pass `['top', 'bottom']` to keep the action
   * clear of the home indicator.
   */
  edges?: readonly Edge[];
};

/**
 * The one container every screen sits in: safe-area aware, the Conformed Set
 * sheet as its background, and one consistent horizontal gutter.
 *
 * **The contract:** Screen supplies `bg-paper` (#E7E4DA — the sheet), the paper
 * grid printed on it, and the `px-5` gutter. Screens must never re-declare any
 * of the three; a second `px-5` inside doubles the gutter, a `bg-paper`
 * re-declaration is the kind of thing that survives the next palette change and
 * quietly goes stale, and a `bg-paper` laid over this container hides the grid.
 * Blocks that want to sit ON the sheet just render — the sheet is already there
 * (docs/design-research/implementation/00-design-spec.md §2, §4).
 *
 * **The grid is the sheet, not a section.** It is drawn under everything, and it
 * does NOT scroll: the paper is the fixed thing and the content moves over it,
 * exactly as in the mockup where `--paper-grid` lives on the screen and not on
 * the content. It sits outside the SafeAreaView so it runs edge to edge with no
 * seam at the status-bar inset, and it is inert to touch. The layer itself is
 * {@link PaperGrid} above — exported because six full-screen surfaces build
 * their own root and would otherwise be the only bare stock in the app.
 * Calibration and how to change it: `paperGrid` in `src/constants/theme.ts`.
 *
 * Sections are separated by whitespace, not by rules: in this design rules
 * enclose objects (a plate edge, the rows of one list), never the page. That is
 * why this container draws nothing else at all.
 */
export function Screen({ children, scroll = false, edges = ['top'] }: ScreenProps) {
  return (
    <View className="flex-1 bg-paper">
      <PaperGrid />
      <SafeAreaView edges={edges} className="flex-1">
        {scroll ? (
          <ScrollView
            className="flex-1"
            contentContainerClassName="grow px-5 pb-10"
            keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        ) : (
          <View className="flex-1 px-5">{children}</View>
        )}
      </SafeAreaView>
    </View>
  );
}
