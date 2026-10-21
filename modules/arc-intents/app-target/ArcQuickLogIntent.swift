import AppIntents
import Foundation

// "Log in ARC" — the Action Button's way into the quick-log box (owner's item
// 63; ADR "Action Button via a native App Intent", docs/decisions.md,
// 2026-10-21).
//
// THIS FILE IS COMPILED INTO THE APP TARGET, not into a pod. app.plugin.js (one
// directory up) copies it into ios/<Project>/ at prebuild and adds it to the
// app target's Sources phase. That is deliberate: App Shortcuts are read from
// the metadata Xcode extracts from the APP's own bundle at build time, and an
// app has exactly one AppShortcutsProvider, so it lives where Apple puts it.
//
// It is the only file here that knows about App Intents. It does not route,
// navigate or touch the database: it leaves a stamp and a notification, and
// the ArcIntents module (../ios/ArcIntentsModule.swift) hands them to
// JavaScript, which holds the request behind the app lock
// (src/lib/log/quick-launch.ts). The strings are duplicated there and pinned
// by db/log.test.mjs §27.
//
// iOS 17: the Action Button only exists on iPhones that ship with 17+, and the
// `shortTitle:systemImageName:` initializer is the iOS 17 one.

@available(iOS 17.0, *)
struct ArcQuickLogIntent: AppIntent {
  static let title: LocalizedStringResource = "Log in ARC"

  // The system opens ARC before running perform(), in ARC's own process — the
  // intent is a door, not a background action.
  static let openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    // Cold launch: JavaScript is not running yet, so the stamp waits for it.
    UserDefaults.standard.set(
      Date().timeIntervalSince1970 * 1000,
      forKey: "arc.quickLog.requestedAt"
    )
    // Warm launch: JavaScript is listening, and this wakes it.
    NotificationCenter.default.post(name: Notification.Name("ArcQuickLogRequested"), object: nil)
    return .result()
  }
}

@available(iOS 17.0, *)
struct ArcAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: ArcQuickLogIntent(),
      phrases: [
        "Log in \(.applicationName)",
        "Quick log in \(.applicationName)",
      ],
      shortTitle: "Log in ARC",
      systemImageName: "square.and.pencil"
    )
  }
}
