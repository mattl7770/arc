> **BUILT 2026-09-25 as routes (a) and (e) — see `docs/screen-time.md`.** The owner answered: Coach input and a line on the daily record; the daily total only; typed, with no screenshot to the model (so not (d)); no Family Controls. The Shortcuts check below (§3, and the added note under §5) has not been run yet, so (e) is built as a link that works whenever a Shortcut opens it. It departs from (e)'s "confirm and write" only for the automation's own case: today's or yesterday's number is written without a tap, and an older date or a day holding a typed number gets the confirm card. (a)'s "Screen time tile in Log" is a Quick add door. What follows is the research and plan as written and fact-checked on 2026-09-23, unchanged.

# Screen time in ARC: what Apple allows, and what it would cost

**Written:** 2026-09-23, in answer to the owner's device note *"screen time data?"*
**Status:** research only. Nothing is built, and nothing should be until §5 is answered.
**Where it sits today:** `docs/project-status.md:478`, the parked "Environment & lifestyle" item ("screen time, social connection, substances").

---

## The short answer

- **ARC cannot read your Screen Time numbers into its database.** Apple lets an app *display* them, inside a locked-down view whose data cannot get out. There is one exception, which does not apply to you (see §1.4). *(checked 2026-09-23: that holds for a TestFlight or App Store install. A **development-signed** build does get the full export API outside the EU, per Apple's docs and forum replies. §1.4 explains why that still isn't a foundation.)*
- **ARC can record rough buckets going forward.** You register marks ("total use passed 1 h, 1 h 15, 1 h 30…"), and iOS wakes a small ARC extension as each one is crossed. That gives you "at least 2 h 30 m today, crossed at 21:40". It cannot give exact minutes, pickups, notifications, or any history from before it was switched on.
- **Every Screen Time API sits behind an Apple approval.** It is granted per bundle id, it takes days to weeks, and TestFlight needs it. Your phone runs TestFlight, so nothing Screen-Time-based can be tried on it before Apple says yes. *(checked 2026-09-23: this is true of the TestFlight install only. A development build made in Xcode on your Mac, under a separate bundle id so it sits beside the TestFlight app, uses the development entitlement and needs no approval. See §2.2.)*
- **(added by the checker, 2026-09-23) Apple's licence limits the Screen Time APIs more tightly than the approval does.** Apple Developer Program License Agreement §3.3.3(P) says an app using Family Controls must have, as its *primary purpose*, parental controls or an individual's own "personal device usage management". The data "may only be used for providing family controls, or individual device management". It may not be shared "beyond … the individual and their device." A longevity app whose Coach sends context to a model provider fails both the purpose test and the sharing rule. So the approval-gated routes (b) and (c) cannot feed the Coach, whatever Apple's reviewer decides.
- **Two cheaper routes need no approval and no build:** typing the number in by hand, or sharing a screenshot of Settings › Screen Time for the model to read, the way workout import already works. Neither Apple Health nor Shortcuts carries Screen Time data. *(checked 2026-09-23: two corrections. **They still need a build.** ARC removed `expo-updates` on 2026-08-23 and has no OTA, so even a JS-only change reaches your phone only in the next EAS/TestFlight build. What these routes avoid is native code, a new capability, profile regeneration and Apple's approval. **Shortcuts:** iOS 26 added a built-in Screen Time action, "Get App & Website Data" (Apple Support 125148). What it returns has not been checked; see §3.)*

---

## 1. What a third-party app can actually get (iOS 26)

### 1.1 The report extension: it can show everything and export nothing

- `DeviceActivityReport` is a SwiftUI view. iOS asks your **Device Activity Report extension** to draw it, and hands that extension the real data: total time, time per app, category and website, the first pickup, the longest session, pickups and notifications per app. [Apple: ActivitySegment, ApplicationActivity]
- Apple's own words: *"your extension runs in a sandbox. This sandbox prevents your extension from making network requests or moving sensitive content outside the extension's address space."* [Apple: DeviceActivityReport]
- Developers tested every way out in March 2026 on iOS 18.3. Writes to App Group UserDefaults are silently dropped (reads work). App Group file writes fail. Network is blocked. Local notifications fail. The pasteboard and iCloud key-value store fail too. Apple DTS answered *"by design"*: the extension runs in a **read-only** sandbox so it cannot hand the data to less-restricted code. [Forums 818297, 817516]
- **So:** ARC can place Apple's numbers on a screen. ARC's JavaScript, its SQLite database and the Coach can never see them.

### 1.2 The monitor extension: it can write, but only learns that a mark was crossed

- `DeviceActivityMonitor` receives six callbacks: `intervalDidStart`, `intervalDidEnd`, `intervalWillStartWarning`, `intervalWillEndWarning`, `eventDidReachThreshold` and `eventWillReachThresholdWarning`. [Apple: DeviceActivityMonitor]
- Each callback carries **only the event's name and the activity's name**. It carries no minutes, no app names, no pickups and no notifications.
- It **can write to an App Group**. That is the standard pattern, and the whole data model of `react-native-device-activity` is App Group UserDefaults, event history included. [RNDA README, "Data model"]
- The network is **not** blocked here: that library can send web requests from the monitor. Keeping ARC's extension offline would be ARC's own rule, and it can be checked in review.
- Limits: at most **20 monitored activities** per app, and each schedule must run at least 15 minutes (`intervalTooShort` / `intervalTooLong` errors). Developers report a **6 MB memory ceiling**. [Apple: MonitoringError; Forums 710915, 735454]

### 1.3 So bucketed recording works, with these conditions

- **Total screen time needs no picker.** *"If your app didn't specify any applications, categories, or webDomains, the event includes all applications, categories, and web domains."* A ladder of empty events at 15, 30, 45 … minutes therefore measures total use and never touches an app identity. [Apple: DeviceActivityEvent init]
- **A category ladder (for example "Social") needs `FamilyActivityPicker`.** You pick, and ARC gets back **opaque tokens** it can store and hand to iOS but cannot read as names. [Apple: FamilyActivityPicker, Token]
- `includesPastActivity: true` (iOS 17.4+) lets a ladder registered at 13:30 count the morning's use as well. [Apple: includesPastActivity]
- Each event fires **once per interval**. With a daily schedule, every rung fires at most once a day.
- **What it cannot do:** give exact minutes, show anything from before you switch it on, or see pickups and notifications.
- **Reliability on iOS 26 is poor, and the plan has to allow for it:**
  - From iOS 26.0 to 26.4, thresholds sometimes fired immediately, or while Screen Time showed 0 minutes. Apple reportedly fixed this in the **26.5 beta 1**, after 10 months, and new reports followed in June 2026. [Forums 811305, 812472, 819997]
  - Separately, thresholds sometimes do not fire at all, and app tokens sometimes change without warning. [Forum 819997]
  - Screen Time's "Share Across Devices" setting is known to inflate totals. [Jomo help centre]
- **Consequence:** ARC can only ever say "at least", and a missing rung means "unknown", never zero.

### 1.4 The real export API exists, but only in the EU

- iOS 26.4 added `DeviceActivityData.activityData(filteredBy:using:)` and `FamilyActivityData`, a new authorization status `approvedWithDataAccess`, and a new entitlement `com.apple.developer.family-controls.app-and-website-usage`. Apple describes the method as *"Use this method to export family activity data."* That is exactly what you want. [Apple: activityData, approvedWithDataAccess, entitlement page]
- The catch: *"Customer installations of your app can only use the method on devices located in the EU that are signed in with an Apple Account with an EU country or region."* Also, only one app per device can hold this status at a time. *(checked 2026-09-23: there is a second cost. A developer reports that once a third-party app holds data access, Settings › Screen Time **stops showing new usage** until that app is switched off under "Apps with Screen Time Access" (forum 844661, Sept 2026, no Apple reply). If that is right, the EU route would also blank the screen that route (d) reads.)*
- ARC's labs come from Function Health, drawn at Quest, which are US services, so I assume you are in the US. **On that assumption this route is closed.**
- Apple does allow development and testing in any region "by using an Apple-provided provisioning profile". Running ARC's daily record on a test-only allowance is not a foundation, so I have ruled it out. *(checked 2026-09-23: the ruling stands, but the reasons were missing, so here they are. Forum threads 844541 and 844623 (Sept 2026) show a development-signed build returning `approvedWithDataAccess` and real data, while TestFlight and App Store builds of the same binary get only `.approved`. An Apple forum responder adds that it "works on dev devices everywhere". So exact minutes, pickups and notifications are technically reachable outside the EU. Five things make it unfit for ARC's daily record:*
  *1. It needs a development-signed install built in Xcode on your Mac. EAS internal builds are ad hoc, and TestFlight counts as a customer install.*
  *2. That install would replace the TestFlight app, and the TestFlight app holds your only copy of the data.*
  *3. Apple's own Screen Time reportedly stops recording while the grant is held.*
  *4. Development profiles expire after a year.*
  *5. §3.3.3(P) still bars sending the data to the Coach's model.)*

### 1.5 iOS 27

- The iOS 27 Screen Time changes reported so far are all for parents and users: a redesign, time allowances, schedules. Nothing new has been reported for developers. [9to5Mac, 2026-09-14]
- Apple's DeviceActivity and FamilyControls pages list no iOS 27 symbols as of today.
- I have not checked whether the iOS 26 threshold bugs survive into iOS 27.

---

## 2. The entitlement, the approval and the build

### 2.1 Apple's side

- **Entitlement:** `com.apple.developer.family-controls`.
- **Authorization:** `requestAuthorization(for: .individual)` (iOS 16+) lets an adult authorize an app on their own phone. iOS shows an alert, then asks for Face ID or Touch ID. [Apple: requestAuthorization(for:)]
- **Development vs distribution:**
  - The development version comes with the developer account.
  - Distribution needs Apple's approval, through the Family Controls distribution form or the Capability Requests tab. Approval covers development, Ad Hoc and App Store profiles.
  - Apple's page on configuring Family Controls says to request it *"when you submit your app to TestFlight and the App Store"*. **TestFlight needs it**, because TestFlight builds use a distribution profile. [Apple: Configuring / Requesting the Family Controls entitlement]
- **Every extension is a separate request with its own bundle id.** Apple's words: *"If your app includes a Screen Time API app extension… submit the same request for the extension."* After approval, "Family Controls (Distribution)" has to be switched on for each id in the developer portal. [Apple; RNDA README]
- **How long approval takes:**
  - Reported times range from 1 day to 4.5 weeks.
  - Extensions are often slower. Several were still pending after 2 weeks in November 2025 and February 2026, and DTS's only advice was to open a code-level support ticket. [Forums 815612, 812332, 725036; Newly, May 2026]
  - A one-line use case tends to be sent back.
  - *Unknown:* how Apple treats an app that has one user and is never on the App Store. Plan for the chance of a "no".
- **(added by the checker, 2026-09-23) The licence terms, which this plan did not cover.** Apple Developer Program License Agreement §3.3.3(P) (the version current on 2026-09-23, read at developer.apple.com/support/terms):
  - *"Your Application must have a primary purpose of (1) offering family controls for parents and guardians … and/or (2) offering individuals the ability to manage their devices to enable focus and productivity through focus controls, timers and task management, or personal device usage management."*
  - *"Device or usage data received through the Family Controls Framework may only be used for providing family controls, or individual device management. You and Your Application may not share device or usage data received through the Family Controls Framework or otherwise, beyond the family controls You provide, or the individual and their device, respectively."*
  - What this means for ARC:
    - ARC's primary purpose is longevity, not device management.
    - Correlating evening use with sleep is not "device management".
    - The Coach sends its context to the model provider, which is sharing beyond "the individual and their device".
    - The newly.app guide warns that Apple may decide the capability is not needed if Screen Time is not central to the app.
  - This binds development builds too, because it is the program licence and not the distribution review. The **(d)** and **(a)** routes are outside it, because ARC never calls the framework. Its "or otherwise" wording is one more reason not to mix the two routes in one app.

### 2.2 ARC's side

- **No way to try it early.**
  - Your phone runs the TestFlight build, and installing a dev client over it would delete the only copy of your data (see the memory note "ARC data has one copy").
  - The Simulator produces no real Screen Time data.
  - So nothing here can be tested until approval arrives *and* an EAS production build reaches TestFlight. *(checked 2026-09-23: overstated. Apple's page says the entitlement is available "through the Apple Developer Program during development", with no request needed. The react-native-device-activity README says the same: before approval "you are stuck with local development builds in Xcode". You have a Mac. A development build made in Xcode under a **separate bundle id** (say `com.arcresilience.app.stspike`) installs beside the TestFlight app without touching its container, and could test whether rungs fire on your iOS version. It cannot go through EAS, whose internal builds are ad hoc and need the distribution approval (eas-cli #2715 shows exactly that failure), and it would hold no ARC data. It answers "does the ladder work on my phone", not "does ARC have the feature".)*
  - A TestFlight update installs in place and keeps your data. Take an encrypted snapshot first anyway.
- **The App Group already exists.** `group.com.arcresilience.app` was added by the `expo-sharing` share extension and is in your installed build (`node_modules/expo-sharing/plugin/build/withShareExtension.js:29`).
- **A new capability means regenerating the provisioning profile.** This is the recorded trap at `docs/project-status.md:730`. A related EAS issue about the family-controls entitlement has been open since November 2024. [eas-cli #2715] *(checked 2026-09-23: the issue is **closed**. It was opened 2024-11-22 and closed 2024-11-27 as completed; Expo's answer was that the ad hoc profile lacked the entitlement and had to be regenerated. Users added comments in Dec 2025 and Feb 2026 reporting the same failure for an **extension's** profile (the ActivityMonitor extension missing Family Controls while the app had it), so the trap is real, but the issue is not open.)*
- **Library options:**
  - **`react-native-device-activity`** (0.6.1, Feb 2026, from Kingstinct, the same author as ARC's HealthKit library).
    - Declares `expo >=52`, and its example app is on Expo 52. It predates SDK 55, so **it has not been tested on SDK 57**.
    - By default it adds a monitor plus two shield extensions, which means **four bundle ids to get approved**.
    - It has **no report view**: pull request #94 was closed without merging, and in November 2025 the maintainer said the report was "not currently implemented".
  - **`@bacons/apple-targets`** (5.0.0, 2026-07-17; declares expo ≥52, SDK 53+).
    - Supports `device-activity-monitor`, `shield-action` and `shield-config` targets, but **has no report-extension type**.
  - **The report extension is a different kind of extension (ExtensionKit)**, embedded in a different folder. App Store Connect rejects it when it is embedded the ordinary way; two public fixes show the change needed. Option (b) would need a **hand-written config plugin**. [GitHub PRs: Smart-Routine #17, safini_mobile #88] *(checked 2026-09-23: probably less than that. `@bacons/apple-targets` 5.0.0 already builds ExtensionKit targets: its `app-intent` type uses `com.apple.product-type.extensionkit-extension`, and its `@bacons/xcode` dependency places those in an "Embed ExtensionKit Extensions" phase at `$(EXTENSIONS_FOLDER_PATH)`. A report type could therefore be a one-entry patch to its target registry (extension point `com.apple.deviceactivityui.report-extension`) rather than a plugin from scratch. Untested. It does not change the ranking, since (b) stores nothing.)*
- **Recommended shape if (c) is built:**
  - Write ARC's own Swift monitor through `@bacons/apple-targets`, plus a small local Expo module for authorization, starting monitoring and reading the App Group. The existing `modules/arc-backup` is the pattern.
  - That is **two bundle ids to approve**: `com.arcresilience.app` and one monitor id.
  - ARC writes every line, so the no-network rule can be checked in review.
  - *(checked 2026-09-23: one more rule is needed. Under §3.3.3(P) the rows must never reach the Coach's model call. The Coach's read tools discover every `metric_type` automatically (`src/lib/ai/tools/read-tools.ts`, "discovered, so a new metric_type needs no code change"), so a (c) table would need an explicit exclusion from the Coach's reads, RAG and turn context.)*

---

## 3. Apple Health and Shortcuts: no

- **Apple Health (HealthKit) has no Screen Time data.**
  - Apple's reference lists 133 quantity types and 45 category types, and none of them is screen or app usage.
  - The nearest things are `timeInDaylight` and `headphoneAudioExposure`. [Apple: HKQuantityTypeIdentifier, HKCategoryTypeIdentifier]
  - ARC's HealthKit pipeline therefore cannot pick it up.
- **Shortcuts has no built-in action that returns Screen Time.** *(checked 2026-09-23: **wrong as written.** Apple's "What's new in Shortcuts … 26" page (support.apple.com/en-us/125148) lists a new **Screen Time** action, **"Get App & Website Data"** (iOS, iPadOS and macOS 26), and 9to5Mac's list of iOS 26 actions (2025-12-09) confirms it. I could find no description of its output: minutes per app, a total, or only app and website names. Weak evidence against it being usable: the Beeminder users below were still using Jomo and Opal in Oct–Nov 2025, after iOS 26 shipped. It takes about five minutes to settle on your phone: add the action in Shortcuts and look at its output.)*
  - The actions people use come from third-party apps such as Jomo and Opal. Those apps measure the number themselves: Jomo's "estimated screen time" is off by 5–10 minutes on average and refreshes every 5–15 minutes, which is the same threshold method as 1.3.
  - Users report readings that disagree across devices. [Beeminder forum, Oct–Nov 2025; Jomo help centre]
  - ARC also has no way to receive data from Shortcuts, so this is not a path. *(checked 2026-09-23: **wrong.** ARC registers the `arc` URL scheme (`app.json`), and `app/+native-intent.ts` passes every system path except the share extension's straight to expo-router. A Shortcut ending in "Open URL `arc://…?minutes=…`" could therefore reach a small JS screen that shows a confirm card. The share extension also accepts text. Receiving is not the obstacle; the only open question is whether the built-in action returns a number.)*
- On the Apple forums, the answer to "how do I get total screen time" is the report extension, with no way to extract the data. [Forum 797162, Aug 2025]

---

## 4. What ARC could honestly do, cheapest first

Report view (b) comes last on purpose. It looks cheap because it stores nothing, but it is the most native work of the four.

| | You see | Lands in ARC's SQLite | Build cost | Apple approval | Privacy |
|---|---|---|---|---|---|
| **(a) Type it in** | A "Screen time" tile in Log, filled from Settings › Screen Time | `wearable_data` row: `metric_type 'screen_time_min'`, `source_device 'manual'` (both already allowed, **no migration**); pickups optional as a second metric | One descriptor in `src/lib/log/metrics.ts`. JS only, **no build** *(checked 2026-09-23: **JS only, but it still needs a build**, because there is no OTA (see the short answer). "One descriptor" also undercounts. The `MetricKey` union needs the new key. The descriptor alone yields a chip on `app/metric-entry.tsx`, but a Log **tile** means editing `src/components/log/quick-add-grid.tsx`. For the Coach to *log* it, the key has to go into `METRIC_KEYS` in `src/lib/ai/tools/write-tools.ts`, which adds a few tokens to the cached prefix. **Reads** need nothing: the Coach discovers any `metric_type`.)* | None | Nothing leaves the phone |
| **(d) Screenshot read** | Share or pick a screenshot of Settings › Screen Time; the model reads total, pickups, notifications and top apps; you confirm on a review card | The same rows as (a), written only after you confirm | A small JS slice on the `app/workout-import.tsx` pattern; the image picker and share extension are **already in your build** *(checked 2026-09-23: they are in the installed build, but a **share** currently lands in the recipe importer. `app/+native-intent.ts` sends every `expo-sharing` link to `/recipe-import`, so the redirect needs a second destination or a chooser. Picking from the library avoids that. Like (a), it ships in the next EAS build, not without one.)* | None | The screenshot goes to the AI provider (the one allowed exception to the offline rule), **with app names on it**. Cropping to the totals avoids that *(checked 2026-09-23, from the pre-iOS-27 layout, not yet seen on your iOS version: total, pickups and notifications are separate sections of one long scrolling page, and each count sits above a list of apps. A single screenshot will not hold all three, and a crop that removes app names also removes pickups and notifications. Realistically the choice is total only (one crop), or two or three screenshots with app names.)* |
| **(c) Threshold ladder** | "Screen time today: at least 2 h 30 m (crossed ~21:40)"; optionally "Social at least 60 m" or "after 9 pm at least 45 m" | One row per rung crossed: date, scope, rung minutes, time crossed. **New table**, next free migration number | Swift monitor + local module + App Group drain + migration + EAS build + profile regeneration. About a week of work plus the build | **Yes, blocking**: 2 bundle ids, days to weeks, may be refused *(checked 2026-09-23: and bound by the licence, §2.1. ARC's primary purpose fails §3.3.3(P)'s test, and the rows may not reach the Coach's model call.)* | Total needs no picker and involves no app identity; categories are opaque tokens. The extension must make no network call (ARC's rule). Drain the App Group into SQLite and delete it on each app open |
| **(b) Apple's report, embedded** | Apple's full numbers (total, apps, pickups, notifications, week chart) on an ARC screen, drawn in SwiftUI rather than ARC's own components | **Nothing.** The Coach cannot see it; the daily record cannot hold it | Hand-written ExtensionKit plugin + SwiftUI report extension + a native view hosting it in React Native. **Highest native cost** | **Yes**: app + report extension | Best possible: the system sandbox guarantees nothing leaves |

**Other real options, briefly:**
- **A limit.** Apple's own App Limits and Downtime already do this for free. Having ARC block apps itself means two more extensions to get approved (shield action and shield configuration) and a product ARC is not. Do not build it.
- **The EU export API** (1.4): closed unless you are in the EU. *(checked 2026-09-23: even in the EU, §3.3.3(P) would bar handing its data to the Coach.)*
- **(added by the checker, 2026-09-23) (e) The built-in Shortcuts action** (§3): "Get App & Website Data", new in iOS 26, output unchecked. If it returns a day's total, a personal automation (for example, daily at 23:50) could open `arc://…?minutes=…`, and a small JS screen would confirm and write the same `wearable_data` row as (a). That would be automatic, exact, involve no model call, put no app names in front of a provider, and need no approval. ARC never touches Family Controls on this route, so §3.3.3(P) does not apply. It rides the next EAS build like (a) and (d).
- **(added by the checker, 2026-09-23) (f) A development-signed ARC with the 26.4 export API** (§1.4): exact data, but it is not an option for a TestFlight phone and the licence still bars Coach use. Listed only so it is not rediscovered as a shortcut.

**My recommendation:**
1. Ship **(d)** now, with (a) as its fallback: no approval, no build, and it is the only route that gets pickups and notifications.
2. **File the Apple request now anyway.** It costs a form, and the waiting is the slow part.
3. Build **(c)** only if a few weeks of (d) show that the Coach actually uses the number.
4. Skip **(b)**. It mostly repeats the Settings screen at the highest cost.

**(checked 2026-09-23) Recommendation, corrected.** Steps 2 and 3 above assumed ARC may use the Screen Time APIs to feed the Coach. The licence says it may not (§2.1), and step 1 claimed "no build". The corrected order:
1. **First, spend five minutes on the phone** checking what "Get App & Website Data" returns in Shortcuts. If it gives a daily total, build **(e)**: it is the cheapest honest automatic route.
2. **Otherwise ship (d), with (a) as its fallback.** Neither needs approval or native code; both ride the next EAS/TestFlight build. (d) is the only approval-free route that can supply pickups and notifications to a TestFlight build outside the EU, at the price of app names going to the provider (see the table's privacy note).
3. **Do not file the Family Controls request with the use case in §5.5.** It describes a primary purpose that §3.3.3(P) excludes, and it asks for data to go where the licence forbids. File only if you want an on-device-only feature the Coach never sees, and expect a "no" even then.
4. **Drop (c) as a Coach input.** It survives only as an on-device display, and then it competes with Apple's own Settings screen, which is free.
5. Skip **(b)**, as before.

**If (c) is built:**
- Record **two ladders**: total use in 15-minute rungs up to 8 h (32 events), and **evening use** from 21:00 to midnight in 15-minute rungs (12 events).
- Evening use is the version most plausibly tied to health, because it sits next to the sleep data ARC already takes from Apple Health. The Coach can test that against your own sleep as an n-of-1, as a judgment rather than a rule. *(checked 2026-09-23: not with (c)'s data. §3.3.3(P) limits it to "individual device management" and forbids sharing it beyond you and your device, and the Coach's analysis runs through the model provider. An evening figure for the Coach has to come from (d), (a) or (e).)*
- Apple documents no per-activity event limit, so 44 events still has to be tested on the device.

---

## 5. Questions for the owner before anything is built

1. **What is the number for?** It could feed the Coach, sit on the daily record, act as a limit, or just satisfy curiosity.
   *Recommend:* Coach input and a line on the daily record. Not a limit, because Apple's App Limits exist. Curiosity alone does not justify a build.
2. **Which number?** Total, evening use, or one category such as social apps.
   *Recommend:* total plus evening use. Categories can wait, since they bring the picker, tokens that can change without warning, and more rungs. *(checked 2026-09-23: evening use came from (c)'s second ladder, which cannot feed the Coach. From a screenshot, (d) can only estimate it from the Day view's hourly bars. So for the Coach, plan on total alone unless the Shortcuts action (e) turns out to take a time range.)*
3. **Is "at least X, to the nearest 15 minutes, from today onward" good enough, or do you need exact minutes, pickups and notifications?**
   *Recommend:* the floor is enough for the Coach. If you want exact numbers and pickups, the screenshot route (d) is the only way to get them outside the EU. *(checked 2026-09-23: the floor comes only from (c), and (c)'s data may not reach the Coach (§2.1), so the question is really "exact via (d)/(a)/(e), or nothing for the Coach". The built-in Shortcuts action (e) may also give exact minutes; check it first.)*
4. **May a Screen Time screenshot go to the AI model?** The model provider would see app names.
   *Recommend:* yes, cropped to the totals card. If not, use (a) and type it in. *(checked 2026-09-23: a crop to the totals keeps the total only. Pickups and notifications each sit above their own list of apps (see the table), so getting them means sending app names.)*
5. **Will you file the Family Controls distribution request (2 forms, possibly weeks), knowing Apple may say no to a one-user app?**
   *Recommend:* yes, now, whatever you decide on 1–4. It commits you to nothing. The use case to give: *"personal longevity app; records the user's own daily and evening screen-time floors on-device for sleep and habit correlation; no network, no shielding."* *(checked 2026-09-23: **recommendation reversed: no, not for this purpose.** That use case states a primary purpose (longevity, sleep correlation) outside the two that DPLA §3.3.3(P) allows, and the intended use, Coach input sent to a model provider, is sharing the licence forbids. An approval would not change the licence. File only if you want an on-device-only screen-time display that the Coach never reads, and even then the purpose test makes a "no" likely.)*

*One fact to confirm rather than decide:* are you in the EU with an EU Apple Account? This plan assumes not, because Function Health and Quest are US services. If you are, §1.4 changes everything. *(checked 2026-09-23: less than "everything". Even in the EU, §3.3.3(P) bars sending the data to the Coach, and granting data access reportedly blanks Apple's own Screen Time pane. The repo is consistent with the US assumption but does not prove it: the timezone tests are built around US zones such as Phoenix and Los Angeles.)*

*(added by the checker, 2026-09-23) A second fact to check, which costs five minutes and comes before question 1:* on your phone, add Shortcuts › Screen Time › "Get App & Website Data" to a blank shortcut, run it, and note what comes out (a total? per-app minutes? only names?). The answer decides between (e) and (d).

---

## Sources

**Apple documentation** (read 2026-09-23 through the documentation's JSON feed)
- DeviceActivityReport (sandbox paragraph): https://developer.apple.com/documentation/deviceactivity/deviceactivityreport
- DeviceActivityReportExtension: https://developer.apple.com/documentation/deviceactivity/deviceactivityreportextension
- DeviceActivityMonitor (callbacks): https://developer.apple.com/documentation/deviceactivity/deviceactivitymonitor
- DeviceActivityEvent and init with includesPastActivity ("empty means all activity"): https://developer.apple.com/documentation/deviceactivity/deviceactivityevent
- includesPastActivity (iOS 17.4): https://developer.apple.com/documentation/deviceactivity/deviceactivityevent/includespastactivity
- DeviceActivityCenter / startMonitoring / MonitoringError: https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter
- DeviceActivityData.ActivitySegment / ApplicationActivity (pickups, notifications): https://developer.apple.com/documentation/deviceactivity/deviceactivitydata
- activityData(filteredBy:using:) (iOS 26.4, EU-only): https://developer.apple.com/documentation/deviceactivity/deviceactivitydata/activitydata(filteredby:using:)
- AuthorizationStatus.approvedWithDataAccess: https://developer.apple.com/documentation/familycontrols/authorizationstatus/approvedwithdataaccess
- Family Controls App and Website Usage entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.family-controls.app-and-website-usage
- FamilyActivityData: https://developer.apple.com/documentation/familycontrols/familyactivitydata
- AuthorizationCenter / requestAuthorization(for:): https://developer.apple.com/documentation/familycontrols/authorizationcenter
- Family Controls entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.family-controls
- Configuring Family Controls (TestFlight, per-extension request): https://developer.apple.com/documentation/xcode/configuring-family-controls
- Requesting the Family Controls entitlement: https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement
- FamilyActivityPicker (opaque selections): https://developer.apple.com/documentation/familycontrols/familyactivitypicker
- ManagedSettings Token / ApplicationToken: https://developer.apple.com/documentation/managedsettings/token
- HKQuantityTypeIdentifier: https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
- HKCategoryTypeIdentifier: https://developer.apple.com/documentation/healthkit/hkcategorytypeidentifier

**WWDC**
- WWDC21 "Meet the Screen Time API": https://developer.apple.com/videos/play/wwdc2021/10123/
- WWDC22 "What's new in Screen Time API" (individual authorization, report extension): https://developer.apple.com/videos/play/wwdc2022/110336/

**Apple Developer Forums and developer reports**
- Report extension blocks every output channel (Mar 2026, Apple staff reply): https://developer.apple.com/forums/thread/818297
- "Is Screen Time trapped inside DeviceActivityReport on purpose?" (DTS: yes, read-only sandbox): https://developer.apple.com/forums/thread/817516
- Total screen time question (DTS points to the report extension, Aug 2025): https://developer.apple.com/forums/thread/797162
- iOS 26.2 thresholds fire at 0 minutes: https://developer.apple.com/forums/thread/811305
- iOS 26.2/26.3 false positives: https://developer.apple.com/forums/thread/812472
- one sec's list of iOS 26 regressions (immediate firing fixed in 26.5 beta 1; not firing; corrupt data; token churn): https://developer.apple.com/forums/thread/819997
- 20-activity limit: https://developer.apple.com/forums/thread/710915
- Monitor memory limit: https://developer.apple.com/forums/thread/735454
- Entitlement pending 2+ weeks (Feb 2026): https://developer.apple.com/forums/thread/815612
- Entitlement taking longer than expected: https://developer.apple.com/forums/thread/812332
- 3+ weeks waiting: https://developer.apple.com/forums/thread/725036
- iOS 26.4: all-or-nothing prompt once data access is added: https://developer.apple.com/forums/thread/820283
- Newly, "How to get the Family Controls entitlement" (May 2026): https://newly.app/how-to/family-controls-entitlement
- 9to5Mac, iOS 27 parental controls (2026-09-14): https://9to5mac.com/2026/09/14/heres-whats-new-with-parental-control-features-in-ios-27-ipados-27-and-macos-27/

**Libraries and tooling**
- react-native-device-activity (README: 4 bundle ids, App Group data model, troubleshooting): https://github.com/kingstinct/react-native-device-activity
- Its "Track total screen time" issue (#77, maintainer Nov 2025): https://github.com/kingstinct/react-native-device-activity/issues/77
- @bacons/apple-targets (supported target types; no report type): https://github.com/EvanBacon/expo-apple-targets
- Report extension must be ExtensionKit-embedded: https://github.com/developers704/Smart-Routine/pull/17 and https://github.com/safini-team/safini_mobile/pull/88
- eas-cli #2715, Family Controls provisioning mismatch: https://github.com/expo/eas-cli/issues/2715
- npm registry, read 2026-09-23: react-native-device-activity 0.6.1 (2026-02-19); @bacons/apple-targets 5.0.0 (2026-07-17); expo 57.0.0 (2026-06-30)

**Shortcuts and third-party numbers**
- Beeminder forum, tracking iOS screen time through Jomo/Opal Shortcuts actions: https://forum.beeminder.com/t/how-i-track-ios-screentime-automatically/12555
- Jomo, "Estimated Screen Time is incorrect" (±5–10 min, 5–15 min refresh): https://help.jomo.so/en/article/estimated-screen-time-is-incorrect-mhgq52/

**This repository** (read only)
- `app.json` (no Family Controls entitlement; `expo-sharing` extension on), `node_modules/expo-sharing/plugin/build/withShareExtension.js:29` (App Group id)
- `db/migrations/0001_init.sql:263` (`wearable_data`: free-text `metric_type`, `'manual'` source allowed)
- `src/lib/log/metrics.ts` (metric registry), `app/workout-import.tsx` (screenshot-to-model pattern), `modules/arc-backup` (local native module pattern)
- `docs/project-status.md:478` (parked item), `:730` (provisioning trap)

**Added by the checker (read 2026-09-23)**
- Apple Developer Program License Agreement §3.3.3(P), Family Controls Framework (current version, schedules dated Aug 2026): https://developer.apple.com/support/terms/apple-developer-program-license-agreement/
- Apple Support, "What's new in Shortcuts for iOS … 26" (Screen Time: "Get App & Website Data"): https://support.apple.com/en-us/125148 ; 9to5Mac's list of iOS 26 Shortcuts actions (2025-12-09): https://9to5mac.com/2025/12/09/ios-26s-shortcuts-app-adds-25-new-actions-heres-everything-new/
- Development builds get `approvedWithDataAccess` outside the EU while TestFlight and App Store builds get `.approved`: https://developer.apple.com/forums/thread/844541 and https://developer.apple.com/forums/thread/844623
- Third-party data access reportedly stops Apple's own Screen Time recording: https://developer.apple.com/forums/thread/844661
- iOS 26.2 threshold regression thread (FB21267341; DTS "known issue", Jan 2026): https://developer.apple.com/forums/thread/809410
- Apple doc text for the limits: `MonitoringError.excessiveActivities` ("twenty"), `.intervalTooShort` ("fifteen minutes"), `.intervalTooLong` ("one week")
- A crawl of 169 DeviceActivity and FamilyControls doc pages found no symbol newer than iOS 26.4
- `@bacons/apple-targets` 5.0.0 tarball `build/target.js` (the `app-intent` ExtensionKit type; no report type) and `@bacons/xcode` 1.0.0-alpha.32 (`Embed ExtensionKit Extensions`)
- Repo: `package.json` and `docs/decisions.md` (no `expo-updates`, so no OTA); `app/+native-intent.ts` (every share goes to `/recipe-import`; other paths pass through); `src/lib/ai/tools/write-tools.ts:171` (`METRIC_KEYS`); `src/lib/ai/tools/read-tools.ts:912` (wearable metrics discovered); `src/components/log/quick-add-grid.tsx`
