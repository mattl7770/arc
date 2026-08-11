import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';

import { palette } from '@/constants/theme';

/**
 * The six surfaces of ARC. Home is the only one that gets to be directive —
 * everything else is exploration or capture. See docs/home-screen.md and
 * docs/information-architecture.md.
 *
 * ## Why six, and why these six (owner call on hardware, 2026-08-09)
 *
 * First device review: *"the workout and nutrition sections are hard to access
 * and should be easier, possibly along the bottom bar? We could move settings to
 * be at the bottom of data and have 6 on the bottom bar."* Both halves are
 * implemented here:
 *
 *   - **Eat** and **Train** join the bar. They were pushed screens reached only
 *     through two of the Log tab's six quick-add tiles — a two-tap, one-guess
 *     path to the two domains a longevity app touches most days.
 *   - **Settings** leaves the bar, for a row at the bottom of Data
 *     (app/(tabs)/data.tsx). It is the one surface here you visit a handful of
 *     times a year, so it was paying rent on the most expensive real estate in
 *     the app. Its screen moved out of this group to app/settings.tsx and is now
 *     stack-pushed like Labs or Protocols — so it arrives with a back chevron
 *     and returns you to Data.
 *
 * ## Six fits — but only because the labels are short
 *
 * This was the real question, and it is a measurement, not a preference. Labels
 * render at 10px in Avenir Next Condensed Demi Bold with 0.6 letter-spacing.
 * That face runs roughly 0.5em per uppercase glyph, so a character costs about
 * 5.0pt of advance + 0.6pt of tracking ≈ 5.6pt drawn.
 *
 *   HOME 4ch ≈ 23pt · COACH 5ch ≈ 29pt · LOG 3ch ≈ 17pt
 *   EAT  3ch ≈ 17pt · TRAIN 5ch ≈ 29pt · DATA 4ch ≈ 23pt      widest ≈ 29pt
 *
 * Six slots on the narrowest iPhone this app targets (375pt) are 62.5pt each,
 * ~54pt after the tab item's own horizontal padding. The widest label uses just
 * over half of that, so nothing truncates and nothing crowds. It still clears at
 * 320pt (53.3pt slots, ~45pt usable).
 *
 * **The obvious labels do not fit.** NUTRITION (9ch ≈ 52pt) and EXERCISE (8ch
 * ≈ 46pt) both overrun the usable width at 320pt and leave no air at 375pt —
 * React Native would shrink or clip them, and a cramped bar is worse than a
 * pushed screen. So the tabs are named for what you do rather than for the
 * domain: **Eat** and **Train**. (SETTINGS, 8ch ≈ 46pt, had the same problem —
 * a small extra argument for the move.) The rule to keep: **a tab label on this
 * bar is at most five characters.** A sixth character is the point at which six
 * tabs stops working.
 *
 * ## Chrome
 *
 * Chrome follows the Conformed Set: the bar is the sheet itself (`paper`), it
 * closes on a full 1px hairline rather than iOS's sub-pixel default so the rule
 * actually reads as drawn, and the active tab is stamped in the one accent
 * (`palette.pine` — petrol #12454E, 8.31:1 on paper). The active tab is on the
 * sanctioned accent budget by name (00-design-spec.md §2); the inactive tabs
 * are muted ink, and no signal colour appears here at all — the tab bar is
 * chrome, and signal colours mark biology only.
 *
 * Labels are the **label voice**: tracked caps at 10px in the label family. That
 * is the metadata layer the spec puts at 9.5–10px, so the 9px render floor is
 * never load-bearing. Caps and tracking alone do not make the voice — without a
 * family the tab labels render in the system face, which is the one place in the
 * app where the label voice was silently dropped.
 *
 * ⚠️ **DEVICE CHECK REQUIRED — this line has no fallback.** Tailwind's `label`
 * token is a CSS stack ('Avenir Next Condensed' → 'Helvetica Neue' → system-ui),
 * and native walks it until something resolves. `fontFamily` here is a single
 * string: React Native takes no fallback list, so if iOS does not have this
 * exact family the labels drop to the system default rather than falling
 * through to Helvetica Neue, and they do it silently. 'Avenir Next Condensed'
 * is the value most likely to resolve — it ships with iOS and is the head of
 * the same stack `font-label` uses, so the tab bar matches every other label in
 * the app when it lands. Confirm on hardware; if it renders as plain system
 * sans, fall back to 'Helvetica Neue' (also iOS-native, next in the stack)
 * rather than leaving it unset. **The width budget above assumes the condensed
 * face.** Helvetica Neue is wider (~0.62em per cap), which puts TRAIN/COACH at
 * ~35pt — still comfortable in a 54pt slot, so the fallback does not break six
 * tabs either.
 *
 * These options are styled imperatively from `palette`, so they do NOT follow a
 * Tailwind change — this file and app/_layout.tsx must both be re-checked
 * whenever the palette moves (01-rn-port-guide.md §2).
 */
export default function TabsLayout() {
  return (
    <Tabs
      // `router.back()` from a tab root returns to the tab you came from rather
      // than always to Home. The default ('firstRoute') made the back chevron
      // that app/nutrition.tsx and app/exercise.tsx draw — now tab roots via
      // app/(tabs)/eat.tsx and app/(tabs)/train.tsx — always dump you on Home
      // regardless of where you'd been. Nothing else in the app calls back()
      // from a tab root, so this changes only that case.
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.pine,
        tabBarInactiveTintColor: palette.inkMuted,
        tabBarStyle: {
          backgroundColor: palette.paper,
          borderTopColor: palette.hairline,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: {
          // Single string, no fallback list — see the device-check note above.
          fontFamily: 'Avenir Next Condensed',
          fontSize: 10,
          fontWeight: '600',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        },
      }}>
      {/* Order reads left to right as the day does: what to do now (Home), who
          to ask (Coach), then the three doing surfaces (Log, Eat, Train), then
          the standing record (Data). */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="coach"
        options={{
          title: 'Coach',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'sparkles' : 'sparkles-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="log"
        options={{
          title: 'Log',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'add-circle' : 'add-circle-outline'}
              size={size}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="eat"
        options={{
          title: 'Eat',
          // The label is short for width; the accessibility label is not, so
          // VoiceOver announces the domain rather than a three-letter verb.
          tabBarAccessibilityLabel: 'Eat, nutrition',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'restaurant' : 'restaurant-outline'}
              size={size}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="train"
        options={{
          title: 'Train',
          tabBarAccessibilityLabel: 'Train, exercise',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'barbell' : 'barbell-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="data"
        options={{
          title: 'Data',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'stats-chart' : 'stats-chart-outline'}
              size={size}
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
