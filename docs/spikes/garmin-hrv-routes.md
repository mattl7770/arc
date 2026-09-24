> **PLAN — not built (written and fact-checked 2026-09-23).** Round-2 note "new method for HRV + other data from garmin?". Checked by an independent agent; its corrections are marked "(checked 2026-09-23: …)". Nothing built beyond the one-tap sync on a blank HRV. The owner's answers are collected on the round-two decisions page; this file is the plan of record until they arrive.

# Garmin HRV and the other missing metrics: every route into ARC

**Date:** 2026-09-23 · **Status:** research and plan. Nothing is built.
**Owner's message (from the phone, 2026-09-23):** *"new method for HRV + other data from garmin?"* His HRV cell is blank.
**Read with:** CLAUDE.md §2, §3 and §8 · `docs/wearables-subapp.md` §2, §3, §12 and §18 · `src/lib/health/coverage.ts`.
**Out of scope:** the one-tap Apple Health sync being built on another branch. That sync cannot fill HRV either (see §1).
**Independently checked 2026-09-23.** Corrections are inline, each marked "(checked 2026-09-23: …)". The recommendation stands; two details of the import design and the coverage fix list were amended.

---

## Bottom line

1. **Garmin still writes no HRV to Apple Health.** SpO2, respiration, VO2 max, skin temperature, stress, Body Battery and Training Readiness are also not written. Garmin's own support list, fetched today, confirms this. So does a Garmin forum post from about 2026-09-07. No change in Apple Health will fill the cell.
2. **iOS 27 (September 2026) added an RMSSD heart-rate-variability type to HealthKit.** RMSSD is the kind of HRV Garmin measures, so the technical excuse is gone. Garmin has not started writing it yet.
3. **Only one route follows all of ARC's rules and gets real Garmin HRV:** Garmin's own export files (FIT format), imported through the iOS file picker and decoded on the phone. Garmin publishes a pure-JS FIT decoder, and ARC already has a file picker in the build. It is not automatic.
4. **Manual entry works today with nothing built.** Each morning the owner types last night's HRV average into ARC, which takes about 10 seconds. Recovery starts grading on day 6. (checked 2026-09-23: there is no "HRV" tile on the Log tab. The keypad `app/metric-entry.tsx` opens from Log → Weight (or Water → Other…) or Data → Weight, and HRV is one of its metric chips. The quicker door is typing `hrv 48` in the Log tab's command field, which `src/lib/log/parse.ts` binds to the `hrv` descriptor.)
5. **Every automatic route breaks at least one rule.** The Health API needs a server and a business account. The unofficial API needs a password and is against Garmin's terms. Health Sync and FitnessSyncer put a server in the loop. HRV Sync keeps data on the phone, but the owner must give his Garmin password to a small third-party app that uses the unofficial login.

---

## 0. What this is judged against

- **The device is a Garmin CIRQA,** per `docs/wearables-subapp.md` §12. It is a screen-free band announced 2026-07-21. It measures overnight HRV, SpO2, respiration, skin temperature, stress, Body Battery and Training Readiness ([DC Rainmaker, 2026-07-21](https://www.dcrainmaker.com/2026/07/garmin-cirqa-everything-you-need-to-know.html)). It syncs only through the Garmin Connect app over Bluetooth, or through Garmin Express on a computer. It does not run Connect IQ apps.
- **ARC's rules:**
  - no server;
  - ARC never handles a password;
  - the only network traffic allowed is the AI call and lookups the user starts;
  - iOS only, built with Expo and EAS;
  - no over-the-air updates. `expo-updates` was removed on 2026-08-23, so **every change here ships in a new EAS build.**

---

## 1. What Garmin Connect writes to Apple Health today

The main source is Garmin's own page, [Sharing Your Garmin Connect Data With Apple Health](https://support.garmin.com/en-US/?faq=lK5FPB9iPF5PXFkIpFlFPA). The page shows no date; I read it on 2026-09-23. In August, ARC's audit could not load this page (§12 says so), so it relied on forum posts. This time it loaded in a real browser. The page lists these types: Active Energy, Body Fat Percentage, Body Mass Index, Flights Climbed, Heart Rate, Resting Energy, Sleep Analysis, Steps, Walking + Running Distance, Water, Weight and Workouts.

| Metric | Garmin → Apple Health | HealthKit type | Evidence (date) |
|---|---|---|---|
| Overnight HRV / HRV status | **No** | — | Not on Garmin's list (read 2026-09-23). [Athlytic help, updated 2026-08-30](https://athlyticapp.helpscoutdocs.com/article/14--third-party-wearables): "Garmin does not sync HRV to Apple Health". [Garmin Forums, about 2026-09-07](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/443646/had-to-get-an-apple-ultra-because-of-limited-ios-data-sharing): a buyer chose an Apple Watch over a Garmin because of VO2 max and HRV. [sensai.fit, rechecked September 2026](https://www.sensai.fit/blog/7-best-hrv-fitness-apps-oura-whoop-2025): Garmin has not adopted the new iOS 27 RMSSD type. |
| Resting HR | **Probably yes, not confirmed** | RestingHeartRate | **Not on Garmin's list.** Garmin Forums threads (about 2019, e.g. [171905](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/171905/resting-heart-rate-overwriting-in-apple-health)) say Connect writes it and overwrites it as the day goes on. ARC keeps the **last** value of the day (§3), which suits that behaviour. |
| Sleep stages | **Yes** | SleepAnalysis | "Sleep Analysis" is on Garmin's list. Stages have been sent since Connect iOS 4.71 ([Notebookcheck, 2023-09-20](https://www.notebookcheck.net/Garmin-Connect-begins-sharing-more-sleep-data-with-Apple-Health-after-new-iOS-app-update.753484.0.html)). |
| Respiration | **No** | RespiratoryRate | Not on Garmin's list. Garmin staff logged it as a feature request in a [forum thread](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/254977/request-for-spo2-vo2-max-and-respiration-data-to-be-shared-to-apple-health-app) in 2019–2020, and it has never shipped. |
| SpO2 / Pulse Ox | **No** | OxygenSaturation | Same thread and same status as respiration. |
| Stress | **No** | — (HealthKit has no stress type) | Not on the list. It has nowhere to go. |
| Body Battery | **No** | — (no HealthKit type) | Not on the list. It has nowhere to go. |
| VO2 max | **No** | VO2Max | Not on the list. Named in the 2019–2020 request and in the forum post from about 2026-09-07. |
| Training Readiness | **No** | — (no HealthKit type) | Not on the list. |
| Skin temperature | **No** | — | Not on the list. Garmin records a nightly *difference* from baseline, and HealthKit's temperature types hold absolute readings. |
| Hydration | **Yes** | DietaryWater | "Water" is on Garmin's list. |
| Weight | **Yes** | BodyMass (+ BodyFatPercentage, BodyMassIndex) | "Weight", "Body Fat Percentage" and "Body Mass Index" are on Garmin's list. |
| Workouts with HR samples | **Partial** | Workout + HeartRate | Workouts are written without the GPS track. Garmin's page: "Garmin syncs all-day heart rate to Apple Health, but only sends high/low HR values for timed activities." So during a workout there are **two HR values (the high and the low), not a heart-rate stream.** |

**Also written, though not asked about:** Active Energy, Resting Energy, Steps, Walking + Running Distance, Flights Climbed and all-day Heart Rate (all on Garmin's list). Blood Pressure is written when a Garmin Index BPM is used ([the5krunner, 2025-06-20](https://the5krunner.com/2025/06/20/garmin-to-add-health-connect-support-to-apple/)). (checked 2026-09-23: Blood Pressure is **not on Garmin's list** as read today. the5krunner lists it among the types sent to Health, and a Notebookcheck headline reports a Connect update that added blood-pressure sharing. But this document's own rule is to trust Garmin's list over third parties, which is how it discounted rallynomics. So blood pressure has the same standing as resting HR: reported, not confirmed by Garmin. Nothing here depends on it, since ARC does not read blood pressure.)

**Two facts that matter for the one-tap-sync branch.** Both are from Garmin's page:
- "Garmin Connect must be open in the foreground to send data to Apple Health." A tap inside ARC cannot make Garmin push. The owner must open Garmin Connect first.
- After sharing is switched on, the Health app back-fills only about two weeks of Garmin data.

**Sources I discounted.** [rallynomics (2026-08-24)](https://rallynomics.com/en/garmin-cirqa-and-apple-health-what-actually-syncs/) says the CIRQA writes SpO2 and respiration, and that Flights Climbed does not sync. Garmin's own list says the opposite on all three, so I trust Garmin. Several other "2026 guides" found by search are SEO pages that contradict each other. I did not use them.

---

## 2. What ARC reads, and what it ignores

ARC's read scopes are in `src/lib/health/mapping.ts`: `SAMPLE_METRICS`, `STATISTIC_METRICS`, sleep, workouts, the workout-only `HEART_RATE_IDENTIFIER`, and the three body types.

| Garmin writes | ARC reads it? |
|---|---|
| Sleep Analysis (with stages) | Yes: `sleep_*` rows, feeds the Sleep pillar |
| Resting HR (probably) | Yes: `rhr`. Recovery falls back to it when HRV is missing |
| Steps, Active Energy, Resting Energy | Yes: `steps`, `active_energy_kcal`, `resting_energy_kcal` |
| Water | Yes: `water_ml` (read only, §15) |
| Weight, Body Fat % | Yes: into `body_metrics` (two-way, §11) |
| Workouts | Yes: `workout` rows, joined to ARC's own sessions (§17) |
| Heart Rate | Only inside a workout's time span (§18). Never as a daily figure, by design |
| **Flights Climbed** | **No** |
| **Walking + Running Distance (daily)** | **No** (workout distance is read) |
| **Body Mass Index** | **No** |
| **Blood Pressure** | **No** |

**Gaps ARC could close without a new route:** Flights Climbed, daily distance, BMI and blood pressure. **None of them is HRV, and none fills a blank on Home.** Only one derivation from existing data would help Recovery: "sleeping heart rate", computed from the all-day heart rate inside the sleep window. That is still not HRV, and §18.2 currently forbids any daily figure built from HeartRate. Parked.

**What ARC asks for that a Garmin never supplies** (stays blank forever on a Garmin-only setup): HeartRateVariabilitySDNN, OxygenSaturation, RespiratoryRate, VO2Max, BodyTemperature, AppleSleepingWristTemperature and WaistCircumference.

### Fixes to `coverage.ts` (no new route needed, only a truer screen)

The August audit could not read Garmin's page. Now it can, and five rows change: (checked 2026-09-23: the list below changes **six** verdicts: water, resting energy, workout heart rate, body temperature, wrist temperature and waist. It also rewrites the resting-HR note. The module header in `coverage.ts` says Garmin's page "could not be retrieved", so that comment must change too. The blood-oxygen, respiration and VO₂max notes can now cite Garmin's own list instead of forum posts.)

- `DietaryWater`: unverified → **yes** ("Water" is on the list).
- `BasalEnergyBurned`: unverified → **yes** ("Resting Energy").
- `HeartRate` (workouts): unverified → **partial, high and low only.** (checked 2026-09-23: `SourceVerdict` in `coverage.ts` is `'yes' | 'no' | 'unverified'`, so there is no "partial" value. Either widen the union, which touches the Settings list and `db/health-coverage.test.mjs`, or record `yes` and put the high/low caveat in `garminNote`.) ⚠️ Check this. Door 1 (§18.1) is not floored. If Garmin attaches its two values to the session, ARC's "avg" is the **midpoint of the high and the low**, not a real average. (checked 2026-09-23: HealthKit averages heart rate with time weighting (`discreteTemporallyWeighted`, WWDC19 session 218), so a two-sample "avg" is a **time-weighted blend** of the high and the low. It is not necessarily their midpoint, and either way it is not a real average. Door 2 cannot produce the same fault from two samples, because its floor needs 6 of the span's first 48 samples to come from the writer (`HR_MIN_SAMPLES`, `healthkit.ts`). Door 2 would pass only if Garmin's all-day heart-rate samples also fall inside the workout's span, and then it would be a real average of those samples.) To check: compare one Garmin session's avg in ARC with the avg Garmin Connect shows. If they differ, floor door 1 as well, or show only the max for Garmin-written sessions.
- `BodyTemperature`, `AppleSleepingWristTemperature`, `WaistCircumference`: unverified → **no** (not on Garmin's list).
- `RestingHeartRate`: keep **yes**, but the evidence is forum posts, not Garmin.

### New since the audit: iOS 27's RMSSD type

- Apple added `HKQuantityTypeIdentifierHeartRateVariabilityRMSSD` in iOS 27.0. [Apple docs](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartratevariabilityrmssd) show it introduced in 27.0. [Gadgets & Wearables, 2026-09-14](https://gadgetsandwearables.com/2026/09/11/apple-watch-recovery-hrv-overall-hrv-rmssd/) covers it. On the Apple Watch it backs the new "Recovery HRV" figure.
- ARC reads only the SDNN type. Nobody writes the RMSSD type for a Garmin today. If Garmin, or a bridge app (§3.5), starts writing it, ARC will not see it.
- Reading it needs `@kingstinct/react-native-healthkit` **16.0.0**, released 2026-09-18 and carrying [PR #388](https://github.com/kingstinct/react-native-healthkit/pull/388). ARC pins `^14.0.2`, so that is two major versions up. It also needs an EAS build made with the iOS 27 SDK, and its own `metric_type`, because RMSSD and SDNN cannot be converted into each other.
- A late scope asks nobody on an existing install (§2's corollary), so it also needs the `unaskedReadScopes` control.
- **Not now.** Do it when someone actually writes the type.

---

## 3. Routes to what Garmin does not write

### 3.1 Garmin Health API / Connect Developer Program: ruled out

- **Eligibility:** "available for enterprise use" and "only for business use" ([Program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/)). Requests for personal use are turned down ([ghurt, updated 2026-07-15](https://ghurt.org/garmin-api-for-personal-use)).
- **Delivery:** "Ping/Pull or Push" from Garmin's cloud to the partner's endpoint ([Health API](https://developer.garmin.com/gc-developer-program/health-api/)). It does carry nightly HRV summaries (`lastNightAvg`, `lastNight5MinHigh`, `hrvValues`; format shown by [MyDataHelps](https://support.mydatahelps.org/garmin-heart-rate-variability-summary-export-format)).
- **No on-device path** exists in this program. Its on-device relative is the [Health SDK](https://developer.garmin.com/health-sdk/overview/): a Bluetooth link straight from the device to your app, and the Companion version keeps working alongside Garmin Connect. But it is enterprise-only, with "a license fee or device minimum order quantity" ([Q&A](https://developer.garmin.com/health-sdk/questions-answers/)). Its device list does not include the CIRQA, and it would need a native module.
- **Verdict:** needs a server and a business account. Out.

### 3.2 Garmin's own data exports: fits every rule, but manual

There are two exports, both on Garmin's page [How Do I Export Data Out of Garmin Connect?](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8) (read 2026-09-23).

**a) Full account export.** Path: garmin.com/account/datamanagement → Export Your Data → Request Data Export.
- **Delivery:** "a download link will be emailed to you. Links typically are sent in 48 hours but can take up to 30 days."
- **Format:** a zip of JSON and original FIT files.
- **Where HRV is:** per a [Garmin Forums reply from about October 2025](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-web/423807/hrv-in-garmin-data-export), overnight HRV is in **FIT** files with generic names (`your@email_1234567890.fit`). They sit in nested zips under `DI_CONNECT/DI-Connect-Uploaded-Files/`. The data is in the "HRV Status Summary" message, and some files also carry "HRV Value" records.
- One 2026 guide says the wellness JSON also holds HRV. That is unverified, so the design should rely on the FIT files and not on the JSON layout.
- **How often:** Garmin documents no limit. Realistically this is a **one-time backfill of all history**, plus the occasional catch-up. It is too slow to use daily. (checked 2026-09-23: "all history" means the HRV nights the account actually holds. The CIRQA was first orderable on 2026-07-24 (Garmin press release), so unless an earlier Garmin fed this account, that is **at most about two months**, roughly 60 nights. The full export is still the cheaper way to get them than 60 per-day exports, but it is a small backfill.)

**b) Per-day wellness export.** Garmin's instructions:

> Export a day's worth of wellness FIT files. This includes data such as steps, sleep, stress, HRV and more.

- **Path:** Garmin Connect website → profile → Account Settings → Account information → pick a date → Export. You get a zip of that day's original FIT files. The HRV file ends in `_HRV_STATUS.fit` (same forum thread).
- **Effort:** about 1–2 minutes of browser taps, and only one day per export.
- **Unverified:** whether it works in Safari on an iPhone.

**What the FIT files hold.** I checked this against Garmin's own decoder, [`@garmin/fitsdk`](https://www.npmjs.com/package/@garmin/fitsdk) v21.217.0, published 2026-09-22 (royalty-free FIT licence):

| FIT message (number) | Holds | ARC slot |
|---|---|---|
| `hrvStatusSummary` (370) | `lastNightAverage`, `weeklyAverage`, `lastNight5MinHigh`, baseline bands, `status` (none / poor / low / unbalanced / balanced), all RMSSD in ms | `hrv` |
| `hrvValue` (371) | 5-minute overnight values | metadata only |
| `spo2Data` (269) | SpO2 | `spo2_pct` |
| `respirationRate` (297) | breaths per minute | `respiratory_rate` |
| `skinTempOvernight` (398) | nightly skin temperature | new: a *difference from baseline*, not absolute (checked 2026-09-23: the message holds `averageDeviation` and `average7DayDeviation`, which are differences in °C, and also `nightlyValue`, "Final overnight temperature value", with no unit given. Whether `nightlyValue` is an absolute reading is unverified. One real file settles it.) |
| `maxMetData` (229) | VO2 max | `vo2max` |
| `sleepAssessment` (346), `stressLevel` (227), `monitoringHrData` (211) | sleep score, stress, resting HR | optional |

- **Body Battery and Training Readiness are not in the public wellness format.** Body Battery appears only as a Health-SDK message (`hsaBodyBatteryData`). Treat both as unreachable.
- **Unverified:** which of these messages a CIRQA file actually contains. One real export will settle it.

**Import path on the phone:**
- `File.pickFileAsync` from `expo-file-system` is already in the build. `src/lib/labs/pick-pdf.ts` uses it.
- Unzipping needs `fflate` (pure JS, MIT, 0.8.3).
- Decoding needs `@garmin/fitsdk` (pure JS, no runtime dependencies). It uses `TextDecoder`, `BigInt` and private class fields. ARC's `model-client.ts` already uses `TextDecoder`, but **run it under Hermes before committing.** (checked 2026-09-23: fitsdk's `Stream` creates `new TextDecoder("utf-8", …)` in a class field, so without that global **every** decode throws, not just the string fields. The global exists: Expo SDK 57 installs a UTF-8-only `TextDecoder` in `node_modules/expo/src/winter/runtime.native.ts`, and fitsdk asks only for UTF-8. ARC's own backups decision in `docs/decisions.md` says `TextDecoder` is "not to be relied on", and that is more cautious than the installed Expo code requires. fitsdk is ESM (`"type": "module"`), and its licence is Garmin's royalty-free FIT Protocol License. Running it under Hermes remains the right gate.)
- No new native module and no network. Still a new EAS build, because there are no OTA updates.

**Verdict:** the only route that brings real Garmin HRV into ARC under all the rules. It costs the owner some effort.

### 3.3 FIT files straight from the device: ruled out as a separate route

- **Activity FIT:** the per-activity "Export File" on the Garmin Connect website (same Garmin page). It has the full heart-rate stream, which would fix the high/low gap in workouts, but no overnight HRV. The CIRQA records overnight HRV only during sleep.
- **Monitoring and HRV FIT over USB:** the CIRQA syncs to a computer through Garmin Express (DC Rainmaker, 2026-07-21). An iPhone cannot mount the band. The same files come out of the per-day export (3.2b) with no cable. This is 3.2b with a Mac added, so it is not worth doing.
- (checked 2026-09-23: the author does not cover one route, **Broadcast Heart Rate**. Garmin's CIRQA FAQ names it as a band setting. It is a live Bluetooth heart-rate stream that works only while broadcasting is switched on. It is not Garmin's overnight HRV Status. Using it would need a native Bluetooth module, and ARC would have to compute HRV itself, which is possible only if the stream carries beat-to-beat intervals. Nobody has checked whether it does. It is ruled out on the native-module and overnight grounds alone.)

### 3.4 Connect IQ: ruled out for this owner

- The CIRQA is **not on Garmin's [Connect IQ compatible-devices list](https://developer.garmin.com/connect-iq/compatible-devices/)**, which I checked on 2026-09-23.
- Even on a Garmin watch, a Connect IQ app cannot read Garmin's HRV Status. It would have to capture beat-to-beat intervals itself, and that only works while the app is open in the foreground. Background services run at most 30 seconds every 5 minutes ([Garmin FAQ](https://developer.garmin.com/connect-iq/connect-iq-faq/how-do-i-create-a-connect-iq-background-service/)).
- Getting the data to ARC would also need the [Connect IQ Mobile SDK for iOS](https://github.com/garmin/connectiq-companion-app-sdk-ios), which relays through the Garmin Connect app. That means a native module plus a Monkey C app to maintain.

### 3.5 Third-party apps that bridge Garmin into Apple Health

| App | What it moves | How | What it means for ARC's privacy stance |
|---|---|---|---|
| **HRV Sync** (Nglx / Marcin Naglik; [App Store](https://apps.apple.com/us/app/hrv-sync/id6756378219), [site](https://hrvsync.nglx.io/)). v1.0 2025-12-12 · v1.1 2025-12-26 (2FA) · v1.2 2026-08-14 (Apple Shortcuts) · v1.2.1 2026-09-13 (sign-in reliability). Free. 3 ratings. | **Garmin nightly HRV only**, into Apple Health's HRV type. It puts the **RMSSD value into the SDNN type**. Its site says "HealthKit has no separate RMSSD type", which iOS 27 has made out of date. | Signs into **your Garmin account directly**; no official API is mentioned. Its site says the credentials sit in the Keychain; the App Store says "credentials are never stored — only secure tokens". It claims all processing happens on the phone and there is no server. Syncs by tapping, or on a schedule through Shortcuts. | Data goes Garmin cloud → phone → Health, with no third party in between. But the **Garmin password goes into a small indie app** that uses the **unofficial login Garmin broke in March 2026** (3.6). (checked 2026-09-23: the use of the unofficial login is **inferred, not stated**. The App Store listing says "Secure OAuth login — your password is never stored", while the site says the login credentials are kept in the Keychain. Neither names Garmin's official API. That API is business-only and delivers to a server (3.1), which a free, server-less app cannot use, so an unofficial login remains the likely mechanism. v1.2.1 (2026-09-13) "improved sign-in reliability". The App Store also lists a v1.1.1 (May 15) that the version list above omits.) ARC never sees the password. **ARC would need no code:** it already reads SDNN. The rows would land as `other` and would be RMSSD under an SDNN label. |
| **Health Sync** (appyhapps.nl B.V.; [App Store](https://apps.apple.com/us/app/health-sync-by-appyhapps/id6480174471), iOS 8.5.9, September 2026, $3.99 one-off) | Garmin steps, sleep, heart rate and activities. Its settings include RHR, HRV and VO2 max. | Garmin's **official** API. Per its [privacy policy (2026-06-14)](https://healthsync.app/privacy-policy/), a server at appyhapps.nl receives Garmin's notifications, **stores your OAuth refresh tokens**, and may relay data "via our server" without storing it. | **A third-party server holds a token to your Garmin account.** That breaks "no server" in spirit. |
| **FitnessSyncer** ([App Store](https://apps.apple.com/us/app/fitnesssyncer/id1159207899)) | Reported to push Garmin sleep HRV to Health (Athlytic, 2026-08-30) | A cloud aggregator at FitnessSyncer.com plus an iOS app that writes to Health | **Your data sits in their cloud.** That breaks "nothing personal at rest in any cloud". |
| **RunGap / HealthFit** | Garmin workouts, with full detail, into Health | Garmin account link, or FIT files | Workouts only, **no overnight HRV.** Could fix the workout heart-rate gap, but does nothing for HRV. |

### 3.6 Unofficial Garmin Connect web API with the user's credentials: ruled out

Included only to rule it out:
1. **ARC must never handle a password.** That rule alone is enough.
2. **It is against Garmin's terms.** The [Terms of Use](https://www.garmin.com/en-US/legal/terms-of-use/) (effective 2026-04-01) forbid "Using any process, whether automated or manual, that accesses, copies, or scrapes content from the Site through any means not purposely made available through the Site".
3. **It keeps breaking.** Garmin changed its login flow in March 2026. [garth](https://github.com/matin/garth), the standard library for this, is now deprecated: "Garmin changed their auth flow, breaking the mobile auth approach that Garth depends on", and new logins no longer work. [python-garminconnect](https://github.com/cyberjunky/python-garminconnect/issues/439) was rewritten as 0.3.x and still had broken logins reported on 2026-09-22. (checked 2026-09-23: this overstates issue #439. It reports that **upgrading from a garth-based install silently breaks token resume**, which is a migration fault, not a failing login. The maintainer's reply the same day confirms that Garmin's whole auth mechanism changed and that he rewrote login from scratch. Releases 0.3.13–0.3.16 shipped between 2026-09-09 and 2026-09-18. So the unofficial route has been rebuilt, not left broken. The point that stands is that it broke once in March and needed a full rewrite, and the owner cannot rely on it not breaking again. The garth deprecation commit is dated 2026-03-28.)
4. **It would be network traffic ARC does not allow.** It is neither the AI call nor a lookup the user starts.

### 3.7 Manual entry: works today, nothing to build

- **How:** Log → HRV opens a keypad (`app/metric-entry.tsx`; metric `hrv`, in ms). Typing "hrv 48" in the command bar also works. (checked 2026-09-23: the Log tab has no HRV door. The quick-add grid's keypad doors are Weight and Water → Other…, and Data → Weight also opens the keypad. From any of them, tap the **HRV** chip. `hrv 48` in the Log tab's command field is the one-step route, and `SOURCE_PRIORITY` in `src/lib/db/repositories/wearables.ts` confirms that a `manual` row counts when nothing else reports that day.)
- **What it writes:** a `wearable_data.hrv` row with source `manual`. Readiness uses manual values when there is nothing else. Recovery grades on the **6th day** of readings (§6, §12). The keypad also covers resting HR, but not SpO2, respiration or VO2 max.
- **The owner's side:** open Garmin Connect's HRV Status card and read "last night's average". About 10 seconds a day.
- **Cost:** it takes daily discipline, and the number is RMSSD. That is fine as long as every HRV row comes from the same Garmin, because Recovery compares today with the owner's own baseline.

---

## 4. Recommendation

### The smallest thing ARC should build: an "Import from Garmin" file import, HRV only

**What it does:**
- One screen reached from Data › Wearables.
- The owner picks a `.zip` or `.fit` file with the iOS file picker ARC already has.
- ARC unzips it with `fflate` (nested zips included) and decodes every FIT file with `@garmin/fitsdk`.
- It keeps only the `hrvStatusSummary` messages and writes one `wearable_data` row per night:
  - `metric_type 'hrv'`, `source_device 'garmin'`;
  - `source_raw_id 'fit:hrv:<wake-date>'`, so re-importing overwrites instead of duplicating;
  - `metadata { method: 'rmssd', status, weekly_avg, baseline, via: 'garmin_fit' }`.
- The night is dated by the file's own local time, **not the phone's current timezone** (§19). (checked 2026-09-23: this assumes the file contains a local time, which is unverified. `hrvStatusSummary` has only a UTC `timestamp` (field 253). Unlike `skinTempOvernight`, it has no `localTimestamp`, and nothing shows what instant that timestamp marks, whether wake, end of sleep or upload. **Amended rule:** use a local-time field if the HRV file carries one. Otherwise date the night from the UTC instant through ARC's own offset history, the same `OffsetLookup` (migration 0060) that `quantityDailyRows` in `src/lib/health/mapping.ts` already uses. Pin the rule against the owner's real file before building. It is still never the phone's current zone.)
- A `garmin` row outranks a typed `manual` row on the same day, so an import replaces the typed number. (checked 2026-09-23: confirmed by `SOURCE_PRIORITY`, which ranks `garmin` above `other`, `apple_health` and `manual`. The import does not delete the typed row, it outranks it when the day is read. Two more points were checked. The `fit:` raw-id prefix keeps these rows out of §16's re-window prune, which deletes only `GLOB 'hk:*'` rows. And `apple_watch` outranks `garmin`, which is consistent with Q2's "split the series when a Watch arrives".)

**Why this one:**
- **One job serves both needs:** a full account export backfills every night of history once, and a per-day export fills gaps.
- **No rule is bent:** no network, no password, no server, no new native module. It is pure JS, and it can be tested headless against a real exported FIT file.
- **Other metrics come later** from the same files, once one real CIRQA export shows which messages it carries: VO2 max first, then SpO2 and respiration.

**Do alongside:**
- Correct the five `coverage.ts` rows in §2. (checked 2026-09-23: six verdicts plus the resting-HR note and the module header. "Partial" needs a decision about the `SourceVerdict` union. See §2.)
- Check the workout "avg" (door 1) against Garmin Connect.
- Tell the one-tap-sync branch that Garmin must be open in the foreground before it can push.

**Do not build:**
- anything that calls Garmin's servers;
- Connect IQ;
- the iOS 27 RMSSD read scope, until something writes it.

### What the owner has to do

1. **From tomorrow, with no build:** each morning, type last night's HRV average into ARC (Log → HRV), about 10 seconds. Recovery starts grading on day 6. (checked 2026-09-23: there is no Log → HRV tile. Type `hrv 48` in the Log tab's command field, or open the keypad from Log → Weight and switch to the HRV chip. See §3.7.)
2. **Once, this week:** request the full export at garmin.com/account/datamanagement and save the emailed zip to Files. Also try one per-day wellness export in Safari on the iPhone, and send both files. They become the test data and settle which messages a CIRQA writes.
3. **Once:** open Health → Sharing → Apps → Connect and read the actual list of Garmin toggles. That settles resting HR and hydration on his phone. (checked 2026-09-23: Garmin's page gives the current path as Health app → Summary → profile picture (top right) → Apps and Services (under Privacy) → Connect → the category toggles. Hydration is already settled by Garmin's own list, which includes "Water", so this check really settles resting HR and blood pressure.)

---

## 5. Questions for the owner

**Q1. Would you give your Garmin password to a third-party app (HRV Sync) to get HRV into ARC automatically every morning?**
- It keeps the data on your phone, and ARC needs no code.
- But your Garmin login sits in a small app with 3 ratings, and the app uses the unofficial login Garmin broke in March 2026.
- **Recommended: no.** Typing the number takes 10 seconds, and file imports cover history. Reconsider only if typing gets skipped more than one day in seven. If the answer is yes, ARC needs one small change: label HRV Sync's rows as Garmin RMSSD, not as generic `other` SDNN.
- (checked 2026-09-23: the question offers only HRV Sync as the automatic option. §3.5 also lists **Health Sync**, whose App Store notes say it syncs HRV, RHR and VO₂max from Garmin Connect. It connects through Garmin's official OAuth, so the password stays with Garmin and the terms are not breached. The cost is different: its server keeps a refresh token for the owner's Garmin account and sometimes passes data through in transit (privacy policy, 2026-06-14). If the owner ever reconsiders, he should choose between the two knowing that. The recommendation stays **no** for both. It does not rest on HRV Sync being the only bridge.)

**Q2. Should Garmin HRV go into the existing `hrv` series, or a separate RMSSD series?**
- **Recommended: the existing `hrv` series, marked `method: rmssd` in its metadata.** Garmin is the only HRV source. The owner's typed values are already Garmin RMSSD. Recovery compares against his own baseline.
- A separate series would mean changes to readiness, the Coach and the Data screens, for no gain until a second HRV device (such as an Apple Watch) arrives. Split the series then.

**Q3. After HRV, which Garmin-only metrics are worth importing from the files?**
- **Recommended: VO2 max next.** It is sparse, and ARC already has a `vo2max` slot the Garmin never fills. SpO2 and respiration can come later.
- Skip Body Battery, Training Readiness and stress. They are either not in Garmin's public file format or have no place in ARC's own Recovery calculation.

---

## Sources

**Garmin**
- [Sharing Your Garmin Connect Data With Apple Health](https://support.garmin.com/en-US/?faq=lK5FPB9iPF5PXFkIpFlFPA), read 2026-09-23 (undated)
- [How Do I Export Data Out of Garmin Connect?](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8), read 2026-09-23 (undated)
- [CIRQA FAQ](https://support.garmin.com/en-US/?faq=0aPZYBMrrC38wtLAPuniP9), read 2026-09-23
- [Terms of Use](https://www.garmin.com/en-US/legal/terms-of-use/), effective 2026-04-01
- [Connect Developer Program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/) · [Health API](https://developer.garmin.com/gc-developer-program/health-api/) · [Health SDK overview](https://developer.garmin.com/health-sdk/overview/) and [Q&A](https://developer.garmin.com/health-sdk/questions-answers/)
- [Connect IQ compatible devices](https://developer.garmin.com/connect-iq/compatible-devices/) · [Connect IQ background services](https://developer.garmin.com/connect-iq/connect-iq-faq/how-do-i-create-a-connect-iq-background-service/) · [Connect IQ iOS companion SDK](https://github.com/garmin/connectiq-companion-app-sdk-ios)
- `@garmin/fitsdk` 21.217.0 on npm (2026-09-22). Its `src/profile.js` was read locally for message numbers 370, 371, 269, 297, 398, 229, 346, 227 and 211.

**Garmin Forums**
- [HRV in Garmin data export](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-web/423807/hrv-in-garmin-data-export), about September–October 2025
- [Request for SpO2, VO2 Max, Respiration to Apple Health](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/254977/request-for-spo2-vo2-max-and-respiration-data-to-be-shared-to-apple-health-app), 2019–2020 with Garmin staff replies
- [Had to get an Apple Ultra because of limited iOS data sharing](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/443646/had-to-get-an-apple-ultra-because-of-limited-ios-data-sharing), about 2026-09-07
- [Resting Heart Rate overwriting in Apple Health](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/171905/resting-heart-rate-overwriting-in-apple-health), about 2019

**Apple and the HealthKit library**
- [heartRateVariabilityRMSSD](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartratevariabilityrmssd), iOS 27.0
- [react-native-healthkit PR #388](https://github.com/kingstinct/react-native-healthkit/pull/388), merged 2026-09-17; released in 16.0.0 on 2026-09-18

**Press**
- [DC Rainmaker CIRQA hands-on, 2026-07-21](https://www.dcrainmaker.com/2026/07/garmin-cirqa-everything-you-need-to-know.html)
- [DC Rainmaker CIRQA review, 2026-08-23](https://www.dcrainmaker.com/2026/08/garmin-cirqa-in-depth-review-one-month-later-expectations-reality.html)
- [Gadgets & Wearables, Recovery HRV vs Overall HRV, 2026-09-14](https://gadgetsandwearables.com/2026/09/11/apple-watch-recovery-hrv-overall-hrv-rmssd/)
- [the5krunner, 2025-06-20](https://the5krunner.com/2025/06/20/garmin-to-add-health-connect-support-to-apple/)
- [Notebookcheck, 2023-09-20](https://www.notebookcheck.net/Garmin-Connect-begins-sharing-more-sleep-data-with-Apple-Health-after-new-iOS-app-update.753484.0.html)
- [sensai.fit, September 2026](https://www.sensai.fit/blog/7-best-hrv-fitness-apps-oura-whoop-2025)
- [Athlytic help, 2026-08-30](https://athlyticapp.helpscoutdocs.com/article/14--third-party-wearables)
- [ghurt, 2026-07-15](https://ghurt.org/garmin-api-for-personal-use)

**Third-party apps**
- [HRV Sync App Store](https://apps.apple.com/us/app/hrv-sync/id6756378219) and [site](https://hrvsync.nglx.io/) (privacy policy 2026-08-31)
- [Health Sync App Store](https://apps.apple.com/us/app/health-sync-by-appyhapps/id6480174471) and [privacy policy](https://healthsync.app/privacy-policy/) (2026-06-14)
- [FitnessSyncer App Store](https://apps.apple.com/us/app/fitnesssyncer/id1159207899)

**Unofficial API**
- [garth deprecation](https://github.com/matin/garth)
- [python-garminconnect #439](https://github.com/cyberjunky/python-garminconnect/issues/439), 2026-09-22

**ARC repository (read only; nothing edited)**
- `src/lib/health/mapping.ts`, `src/lib/health/coverage.ts`, `src/lib/health/healthkit.ts`
- `docs/wearables-subapp.md` §2, §3, §6, §12, §18
- `app/metric-entry.tsx`, `src/lib/log/metrics.ts`, `src/lib/labs/pick-pdf.ts`

**Added by the check (2026-09-23)**
- Re-read in a browser: Garmin's Apple Health page (the list of 12 types, the high/low workout HR sentence, the foreground rule and the two-week backfill all confirmed verbatim); Garmin's export page (48 h / 30 days and the per-day wellness path confirmed); Garmin Terms of Use (effective 2026-04-01, the scraping clause confirmed verbatim)
- GitHub API: react-native-healthkit PR #388 merged 2026-09-17T22:47Z; 16.0.0 published 2026-09-18T00:04Z with the RMSSD type in its notes. garth deprecation commit 2026-03-28. python-garminconnect #439 (opened 2026-09-22) and releases 0.3.13–0.3.16
- npm registry: `@garmin/fitsdk` 21.217.0 published 2026-09-22 with no runtime dependencies; `fflate` 0.8.3, MIT. fitsdk `src/profile.js` and `src/stream.js` read through jsDelivr, which confirmed message numbers 370/371/269/297/398/229/346/227/211, the `hrvStatusSummary` fields and the TextDecoder class field
- ARC code: `src/lib/db/repositories/wearables.ts` (`SOURCE_PRIORITY`), `db/migrations/0021_wearables_health.sql` (the `source_device` CHECK includes `garmin`), `src/components/log/quick-add-grid.tsx`, `src/lib/log/parse.ts`, `node_modules/expo/src/winter/runtime.native.ts`, `docs/decisions.md` (backups ADR), `docs/wearables-subapp.md` §16
- [WWDC19 session 218](https://developer.apple.com/videos/play/wwdc2019/218/): heart rate aggregates with time weighting
- [Health Sync App Store](https://apps.apple.com/us/app/health-sync-by-appyhapps/id6480174471): the notes cover syncing HRV, RHR and VO₂max from Garmin Connect
