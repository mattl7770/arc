import type { ReactNode } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { type Edge, SafeAreaView } from 'react-native-safe-area-context';

import { paperGrid } from '@/constants/theme';

/**
 * The drafting grid tile: one 9pt cell with a 1pt rule on its top and left
 * edge, shipped at 1x/2x/3x so the rule lands crisp on every device instead of
 * being smeared by an upscale. Ink is baked at full alpha — the 6% comes from
 * `paperGrid.opacity` below, which keeps the dial in one place.
 */
const gridTile = require<number>('../../../assets/images/paper-grid.png');

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
 * NO padding, sitting *outside* the SafeAreaView so the tile runs edge to edge
 * with no seam at the status-bar inset, and outside any ScrollView so the paper
 * stays fixed while content moves over it. (Padding matters because React
 * Native's Yoga insets absolutely-positioned children by the parent's padding,
 * unlike CSS — a padded parent would leave the sheet's margins bare.)
 *
 * Static `<Image resizeMode="repeat">` on `absoluteFill`: no animation, no
 * measurement, no per-frame cost. `pointerEvents="none"` +
 * `accessibilityElementsHidden` keep it inert to touch and invisible to
 * VoiceOver — it is stock, not content.
 */
export function PaperGrid() {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      style={[StyleSheet.absoluteFill, { opacity: paperGrid.opacity }]}>
      <Image source={gridTile} resizeMode="repeat" style={StyleSheet.absoluteFill} />
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
