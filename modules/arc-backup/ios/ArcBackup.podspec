# Local Expo module, iOS only. It exists so ARC can set
# NSURLIsExcludedFromBackupKey on the database and the photo directories —
# CLAUDE.md §2 and the 2026-08-23 ADR. Shape follows the Expo SDK 57 modules in
# node_modules (see expo-secure-store/ios/ExpoSecureStore.podspec); the values
# are literal because a local module has no package.json of its own.
Pod::Spec.new do |s|
  s.name           = 'ArcBackup'
  s.version        = '1.0.0'
  s.summary        = 'Excludes ARC files and directories from the iOS device backup.'
  s.description    = 'Sets NSURLIsExcludedFromBackupKey so the health database and photo directories never ride the iCloud device backup.'
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

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
