/**
 * The **Eat** tab — the nutrition sub-app, promoted from a pushed screen to a
 * first-class surface (owner call on hardware, 2026-08-09; see
 * app/(tabs)/_layout.tsx for the six-tab reasoning and the label measurement).
 *
 * This file is deliberately a re-export, not a copy. `app/nutrition.tsx` is the
 * nutrition hub and stays the canonical screen: it is still stack-pushed from
 * the Log tab's Nutrition tile and from Data's Nutrition trend row, and it is
 * still where the sub-app family (`/food-search`, `/meal-detail`,
 * `/nutrition-targets`, …) returns to. Duplicating it here to get a tab would
 * fork the hub into two files that drift; re-exporting means the tab and the
 * pushed route are the same screen by construction.
 *
 * Two affordances landing on one destination is fine and deliberate — the tab
 * is the ambient path ("I'm about to eat"), the Log tile is the in-flow path
 * ("I'm capturing my day and food is part of it").
 *
 * The header is chosen by POSITION, not by a prop the caller passes:
 * `app/nutrition.tsx` (~:493) branches on `useSegments()[0] === '(tabs)'` — the
 * tab root gets a plain serif title like every other tab, the pushed route keeps
 * `StackHeader` and its back chevron. `router.canGoBack()` is deliberately NOT
 * the test: this navigator runs `backBehavior="history"`, so a tab root reached
 * after any navigation reports true and would draw a chevron that walks you to a
 * different tab.
 */
export { default } from '../nutrition';
