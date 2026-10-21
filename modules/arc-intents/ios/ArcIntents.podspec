# Local Expo module, iOS only: the JS half of the Action Button's "Log in ARC"
# App Intent (docs/decisions.md, 2026-10-21). It hands the intent's request to
# JavaScript; the intent itself is NOT in this pod — it is compiled into the
# app target by ../app.plugin.js, because App Shortcuts are read from the app's
# own bundle (see ../app-target/ArcQuickLogIntent.swift). Shape copied from
# modules/arc-backup/ios/ArcBackup.podspec.
Pod::Spec.new do |s|
  s.name           = 'ArcIntents'
  s.version        = '1.0.0'
  s.summary        = 'Hands the Log in ARC App Intent request to JavaScript.'
  s.description    = 'Reads and clears the quick-log request the App Intent leaves in UserDefaults, and emits an event when one arrives while the app is running.'
  s.license        = 'MIT'
  s.author         = 'ARC'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Relative to this file, so ../app-target/ (the intent) is never compiled here
  # — a second copy of the AppShortcutsProvider would be a duplicate.
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
