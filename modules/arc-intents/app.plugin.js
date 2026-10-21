/**
 * Config plugin: put the "Log in ARC" App Intent into the APP target at
 * prebuild (docs/decisions.md, "Action Button via a native App Intent",
 * 2026-10-21).
 *
 * The intent cannot ride the ArcIntents pod beside it: App Shortcuts are read
 * from the metadata Xcode extracts from the app's own bundle, and an app has one
 * AppShortcutsProvider. So this copies `app-target/ArcQuickLogIntent.swift` into
 * `ios/<Project>/` and links it into the app target's Sources build phase,
 * through Expo's own helper for exactly that (`withBuildSourceFile`, which
 * writes the file and adds it to the project's main group; it skips a file the
 * project already has, so a second prebuild is a no-op).
 *
 * `ios/` is gitignored and EAS runs prebuild on every build, so the file is
 * regenerated from this source each time — edit the Swift here, never in ios/.
 */
const fs = require('fs');
const path = require('path');
const { IOSConfig } = require('expo/config-plugins');

const INTENT_FILE = 'ArcQuickLogIntent.swift';

function withArcQuickLogIntent(config) {
  return IOSConfig.XcodeProjectFile.withBuildSourceFile(config, {
    filePath: INTENT_FILE,
    contents: fs.readFileSync(path.join(__dirname, 'app-target', INTENT_FILE), 'utf8'),
    overwrite: true,
  });
}

module.exports = withArcQuickLogIntent;
