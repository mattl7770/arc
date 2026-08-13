/**
 * `expo-constants` stub for the headless screen-render suite.
 *
 * The real package re-exports `expo-modules-core`, whose ESM entry reaches for
 * a native `.fx` side-effect module that does not exist off-device — so a
 * screen doing `import Constants from 'expo-constants'` (app/report-view.tsx,
 * app/settings.tsx) fails to RESOLVE under node, before any of its own code
 * runs. Stubbing the module is the same trade the suite already makes for
 * expo-router and Ionicons.
 *
 * `expoConfig.version` is the one field the screens read (it is stamped onto a
 * generated report as `app_version`). A fixed value keeps renders
 * deterministic; the app.json version is not what the suite is testing.
 */
export default { expoConfig: { version: '0.2.0' } };
