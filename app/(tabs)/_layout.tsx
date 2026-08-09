import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';

import { palette } from '@/constants/theme';

/**
 * The five surfaces of ARC. Home is the only one that gets to be directive —
 * everything else is exploration or capture. See docs/home-screen.md.
 *
 * Chrome follows the Conformed Set: the bar is the sheet itself (`paper`), it
 * closes on a full 1px hairline rather than iOS's sub-pixel default so the rule
 * actually reads as drawn, and the active tab is stamped in the one accent
 * (`palette.pine` — petrol #12454E, 8.4:1 on paper). The active tab is on the
 * sanctioned accent budget by name (00-design-spec.md §2); the inactive tabs
 * are muted ink, and no signal colour appears here at all — the tab bar is
 * chrome, and signal colours mark biology only.
 *
 * Labels are the **label voice**: tracked caps at 10px in the label family. That
 * is the metadata layer the spec puts at 9.5–10px, so the 9px render floor is
 * never load-bearing. Caps and tracking alone do not make the voice — without a
 * family the five tab labels render in the system face, which is the one place
 * in the app where the label voice was silently dropped.
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
 * rather than leaving it unset.
 *
 * These options are styled imperatively from `palette`, so they do NOT follow a
 * Tailwind change — this file and app/_layout.tsx must both be re-checked
 * whenever the palette moves (01-rn-port-guide.md §2).
 */
export default function TabsLayout() {
  return (
    <Tabs
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
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'settings' : 'settings-outline'} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
