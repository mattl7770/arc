import ExpoModulesCore
import Foundation

/**
 The JavaScript side's view of the "Log in ARC" App Intent (the Action Button,
 owner's item 63 — docs/decisions.md, 2026-10-21).

 The intent (`modules/arc-intents/app-target/ArcQuickLogIntent.swift`, compiled
 into the APP target by `app.plugin.js`) does two things when it runs: it writes
 the time it ran into `UserDefaults` under `arcQuickLogKey`, and it posts
 `arcQuickLogNotification`. This module is how JavaScript sees either:

 - `takeQuickLogRequest()` reads the stamp and clears it — so a request is
   taken once — and returns the epoch milliseconds, or `nil` when none waits.
   This is the COLD-launch path: the intent ran before the JS bundle existed,
   and the stamp waited for it.
 - `onQuickLogRequested` fires while JavaScript is listening — the WARM path,
   where the app was already running and the intent brought it forward. It
   carries nothing; the listener calls `takeQuickLogRequest()`, so whichever
   path reads first wins and the other finds nothing.

 The three strings below are duplicated in the intent file (a different Swift
 module, so they cannot be shared) and in `src/lib/log/quick-launch.ts`;
 `db/log.test.mjs` §27 pins all three copies against each other.

 Shape copied from `ExpoLinkingModule` (node_modules/expo-linking/ios), which
 observes a NotificationCenter name exactly this way.
 */
let arcQuickLogEvent = "onQuickLogRequested"
let arcQuickLogKey = "arc.quickLog.requestedAt"
let arcQuickLogNotification = Notification.Name("ArcQuickLogRequested")

public class ArcIntentsModule: Module {
  public func definition() -> ModuleDefinition {
    // Must equal the name in requireOptionalNativeModule('ArcIntents').
    Name("ArcIntents")

    Events(arcQuickLogEvent)

    OnStartObserving(arcQuickLogEvent) {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(handleQuickLogRequested),
        name: arcQuickLogNotification,
        object: nil
      )
    }

    OnStopObserving(arcQuickLogEvent) {
      NotificationCenter.default.removeObserver(self, name: arcQuickLogNotification, object: nil)
    }

    // Synchronous: it is one UserDefaults read and remove.
    Function("takeQuickLogRequest") { () -> Double? in
      let defaults = UserDefaults.standard
      guard let stamp = defaults.object(forKey: arcQuickLogKey) as? Double else {
        return nil
      }
      defaults.removeObject(forKey: arcQuickLogKey)
      return stamp
    }
  }

  @objc func handleQuickLogRequested(_ notification: Notification) {
    self.sendEvent(arcQuickLogEvent, [:])
  }
}
