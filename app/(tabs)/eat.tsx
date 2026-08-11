import NutritionScreen from '../nutrition';

/**
 * The **Eat** tab — the nutrition sub-app, promoted from a pushed screen to a
 * first-class surface (owner call on hardware, 2026-08-09; see
 * app/(tabs)/_layout.tsx for the six-tab reasoning and the label measurement),
 * and redrawn as a real tab root on 2026-08-11 (docs/information-architecture.md
 * › *The Eat tab, redrawn*).
 *
 * This file is deliberately a thin wrapper, not a copy. `app/nutrition.tsx` is
 * the hub and stays the canonical screen: it is still stack-pushed from the Log
 * tab's Nutrition tile and from Data's Nutrition trend row, and it is still
 * where the sub-app family (`/food-search`, `/meal-detail`,
 * `/nutrition-targets`, …) returns to. Duplicating it here to get a tab would
 * fork the hub into two files that drift.
 *
 * The wrapper exists to state ONE fact the hub cannot know about itself: which
 * of its two routes is rendering. It arrives as the `asTab` prop.
 *
 * **Why a prop and not `useSegments()`.** The hub used to infer it —
 * `useSegments()[0] === '(tabs)'` — and that reads GLOBAL navigation state.
 * Push `/food-search` off this very tab and the segments change under the
 * still-mounted tab root, which re-renders itself as the pushed variant: a back
 * chevron appearing in the header behind the screen you just opened, and again
 * on the way back. `router.canGoBack()` is wrong for the older reason — this
 * navigator runs `backBehavior="history"`, so a tab root very often can go back.
 * A prop is a fact about the render and cannot drift.
 *
 * Two affordances landing on one destination is fine and deliberate — the tab
 * is the ambient path ("I'm about to eat"), the Log tile is the in-flow path
 * ("I'm capturing my day and food is part of it").
 */
export default function EatTab() {
  return <NutritionScreen asTab />;
}
