import type { ComponentType } from 'react';
import { Platform } from 'react-native';

/**
 * The iOS date/time wheel, behind a guarded seam —
 * `@react-native-community/datetimepicker` resolved once, at first use, never
 * at module scope of a route file.
 *
 * **Why this file exists at all.** It is the app's rule for every native
 * module: Expo Router eagerly requires every file under `app/` to build its
 * route manifest, so a native import that throws at module scope, in a screen
 * nobody has opened, is a hard error at app **LAUNCH** — the failure that
 * shipped twice (`expo-image-picker`, `expo-keep-awake`; docs/project-status.md
 * › Device / builds). `app/protocol-edit.tsx` and `app/protocol-item.tsx` are
 * both on that manifest, and both draw this control through
 * `src/components/protocols/time-wheel.tsx`, which they import statically.
 *
 * For THIS package the launch half is the rule rather than a proven failure
 * — its iOS view binds lazily and does not throw at import (see *What it
 * cannot see*, below). The failure that IS proven is the other one the camera
 * seam names: the headless render suite (`db/screens-render.test.mjs`) walks a
 * screen's import graph for real, and Node cannot load this package at all,
 * so one static import would take both protocol editors off the walk. With
 * the require guarded they render the absent branch — the typed field — and
 * stay on it.
 *
 * Reference implementation for this pattern: `src/lib/media/camera.ts`.
 *
 * ## It is gated on iOS, not only on the require
 *
 * The camera seam gates on the require alone. This one gates on
 * `Platform.OS === 'ios'` FIRST, for three reasons that are all specific to
 * this package:
 *
 * 1. **ARC is iOS only** (owner, 2026-07-25). The package's config plugin
 *    (`app.plugin.js` -> `withDateTimePickerStyles`) writes Android dialog
 *    styles and nothing else, so it is deliberately NOT in `app.json` —
 *    `npx expo install` adds it by default, and it was taken back out.
 * 2. The package's platform-neutral build (`src/datetimepicker.js`, the one
 *    Metro picks for web) is a component that renders `null` and
 *    `console.warn`s *"DateTimePicker is not supported on: web"*. A seam that
 *    reported that as "available" would draw nothing at all in the web
 *    logic-check preview — a blank where a control should be, which is the one
 *    outcome this seam exists to prevent.
 * 3. The package ships untranspiled, Flow-typed source whose imports are
 *    extensionless, so under Node the require throws *"Cannot find module
 *    …/src/datetimepicker"*. The catch would swallow that and arrive at the
 *    right answer by accident. Deciding it on the platform makes the render
 *    suite's branch a decision rather than a caught resolution error.
 *
 * ## What it cannot see
 *
 * The check below proves the JS module loaded — not that its native view is
 * registered. The iOS half binds through `codegenNativeComponent`, which does
 * not look for the view at import, so a build that failed to link the pod
 * would pass this check and draw an unimplemented view where the wheel
 * should be. On the phone that cannot arise by drift: ARC has no OTA
 * (`expo-updates` was removed 2026-08-23), so this JS and the native pod
 * always ship in one binary. It would take a broken EAS build, and the first
 * look at the editor on that build is the test for it.
 *
 * The module's shape is declared HERE rather than imported from the package,
 * for the reason it is in `camera.ts`: a type import from a native package is
 * free at runtime, but declaring the surface ARC actually uses documents it and
 * keeps the shape check below honest about what "loaded" means.
 */

/** What the wheel hands back. `timestamp` is epoch ms; ARC reads the `Date`. */
export type TimePickerChangeEvent = {
  nativeEvent: { timestamp: number; utcOffset: number };
};

/**
 * The props ARC passes, and only those.
 *
 * `is24Hour` is deliberately absent: it is an **Android** prop, and on iOS the
 * wheel follows the device's own 12/24-hour setting. `locale` is absent for the
 * same reason — passing one would override that setting, which is the owner's
 * to make and not ARC's.
 *
 * `onValueChange` rather than `onChange`: 9.1.0 deprecated `onChange` and warns
 * at runtime when it is used (`utils.js` › `warnIfOnChangeIsUsed`).
 */
export type ArcTimePickerProps = {
  value: Date;
  mode: 'time';
  display: 'spinner';
  minuteInterval?: 1 | 2 | 3 | 4 | 5 | 6 | 10 | 12 | 15 | 20 | 30;
  themeVariant?: 'light' | 'dark';
  onValueChange?: (event: TimePickerChangeEvent, date: Date) => void;
  accessibilityLabel?: string;
};

function loadPicker(): ComponentType<ArcTimePickerProps> | null {
  if (Platform.OS !== 'ios') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-community/datetimepicker') as {
      default?: unknown;
    };
    // Babel's ESM interop puts the default export on `.default`; the raw module
    // object is the fallback for a CommonJS build of the same package.
    const Picker: unknown = mod?.default ?? mod;
    return typeof Picker === 'function' ? (Picker as ComponentType<ArcTimePickerProps>) : null;
  } catch {
    return null;
  }
}

/**
 * Resolved once per process. The module cannot appear or disappear while the
 * app runs, so every consumer below reads a constant — which is what keeps the
 * component's branch stable across renders instead of swapping a native view
 * in and out of the tree.
 */
const picker = loadPicker();

/**
 * The live wheel, or `null` on web, under Node, and in any dev client built
 * before the dependency landed.
 *
 * Null is a **branch the caller must draw**, never a crash and never a blank:
 * `src/components/protocols/time-wheel.tsx` falls back to the typed `HH:MM`
 * field C9 shipped, so the time is always settable by some means.
 */
export const ArcTimePicker: ComponentType<ArcTimePickerProps> | null = picker;

/** Whether this binary can draw the wheel at all. */
export function isTimeWheelAvailable(): boolean {
  return picker !== null;
}
