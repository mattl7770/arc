# Running ARC on a device (and why Expo Go broke)

**Platform assumed:** Windows dev machine + iPhone. Android notes at the end.

---

## Why Expo Go says "update / incompatible" (even though it's up to date)

Not a bug in ARC. Since SDK 51, **Expo Go bundles the native runtime for exactly one SDK at a time.** When `npx expo start` serves the manifest, Expo Go compares the project's `sdkVersion` (**57**) against the SDK its own binary supports. If ARC's SDK is newer, it reports "incompatible / update Expo Go."

And "Update" often can't help: when SDK 57 released (2026-06-30) the store build of Expo Go was **still awaiting App Store/Play Store approval**, and 2026 had a chronic approval backlog. So there may be **no SDK-57 Expo Go in the store yet** — tapping Update finds nothing, so the app looks "up to date" while still rejecting a 57 project.

**None of ARC's dependencies are the cause.** Reanimated 4, the New Architecture, React 19, `reactCompiler`, and the config plugins all run fine in a *matching-SDK* Expo Go. The blocker is purely the SDK number. *(This stops being true the day we add Apple Health / Health Connect — see below.)*

> **Zero-cost first check:** open the App Store, look at the Expo Go listing. If it now lists **SDK 57**, a normal update fixes iOS for free and you can skip everything below. This is the one fact that couldn't be verified at time of writing — the live store state changes.

---

## The three options, honestly

| | Cost | On device today? | Survives Apple Health? |
| --- | --- | --- | --- |
| **A. Store update** (if App Store now has SDK 57) | free | yes, if approved | no — Expo Go can't load native modules |
| **B. `eas go` bridge** — SDK-57 Expo Go via TestFlight | free | yes | no — same limit |
| **C. Development build** (recommended) | **$99/yr Apple Developer** | yes | **yes** — this is the permanent path |

**The catch that decides it:** ARC will integrate Apple Health, then wearables (Terra) and more. Those are **custom native modules Expo Go can never run** — the first one you add, Expo Go (any version, including the `eas go` bridge) stops working for good. The development build is the environment you end up in regardless; the only question is whether you set it up now or in a few weeks.

**Recommended plan:** use **B** to see ARC on your phone today for free, and move to **C** when you're ready to pay for the Apple Developer Program (or when Apple Health forces it — whichever comes first).

---

## Option B — free bridge: SDK-57 Expo Go via TestFlight

Gets a matching Expo Go onto your iPhone at no cost. Good for JS/UI work now; dies at the first native module.

```powershell
npm install --global eas-cli
eas login                 # free Expo account
npx eas-cli go            # iOS → delivers an SDK 57 Expo Go through TestFlight
```

Then run the dev server in Expo Go mode (ARC now defaults to dev-client mode because `expo-dev-client` is installed, so pass `--go`):

```powershell
npx expo start --go
```

Scan the QR with the SDK-57 Expo Go you installed from TestFlight.

---

## Option C — development build (the real answer)

The scaffolding is **already done**: `eas.json` has a `development` profile and `expo-dev-client` is installed. You do not need `eas build:configure` or to install the dev client.

> **The Apple requirement, stated plainly:** installing an EAS cloud iOS build on a **physical iPhone requires a paid Apple Developer Program membership — $99/yr.** A free Apple ID does **not** work here; the free path (local Xcode provisioning) only exists on a Mac, which a Windows machine can't use. This is unavoidable for iOS-on-Windows. *(High confidence — Apple/Expo signing docs.)*

Steps (in the project root, PowerShell):

```powershell
# One-time, yours to do: enrol at https://developer.apple.com/programs ($99/yr)
# One-time: a free Expo account

npm install --global eas-cli
eas login

# Register your iPhone for ad-hoc distribution (installs a profile that captures its UDID)
eas device:create

# Build the dev client in the cloud using the existing "development" profile
eas build --profile development --platform ios
```

Then:
1. During the build, sign in with your Apple ID; let EAS create the distribution cert + ad-hoc profile, and **select your registered iPhone**.
2. On a brand-new membership, Apple can take **24–72h** to finish processing a newly registered device before the build will install.
3. Open the finished build in the EAS dashboard → **Install** → scan the QR with the iPhone Camera.
4. iOS 16+: enable **Settings → Privacy & Security → Developer Mode**, reboot if prompted.
5. Connect the dev server:

```powershell
npx expo start --dev-client
```

**Daily loop after the first build:** just `npx expo start`. Your JS reloads instantly over Wi-Fi, exactly like Expo Go. You only rebuild (repeat the `eas build` step) when you **add or change a native dependency** — e.g. when Apple Health lands.

**More test devices later:** `eas device:create` per device, then rebuild (new UDIDs aren't picked up by existing builds). Ad-hoc is capped at **100 iOS devices/year**.

---

## If the phone still can't reach the dev server (a separate "can't connect" failure)

Common on Windows, independent of the SDK issue:

```powershell
npx expo start -c                  # clear Metro cache
netstat -ano | findstr :8081       # find a stale Metro server…
taskkill /PID <pid> /F             # …and kill it
Remove-Item -Recurse -Force .expo  # clear local Expo state
npx expo start --tunnel            # bypass LAN/firewall (slower, via Ngrok)
```

Also: phone and PC on the **same Wi-Fi** (no guest/client-isolation), allow Node through Windows Defender Firewall, and force-quit + reopen the app to drop a cached manifest.

---

## Android (for reference / future test devices)

Windows can build Android locally, but from a clean machine the **cloud EAS APK is faster to first launch** (skips the multi-GB Android Studio + JDK setup) and needs no paid account:

```powershell
eas build --profile development --platform android   # emits an installable APK
```

Scan the QR → download the `.apk` → allow install from unknown sources. Only prefer local `npx expo run:android --device` if you already have Android Studio + SDK Platform 36 + JDK 17 + `adb` working.

---

## Confidence notes (don't over-trust the date-sensitive bits)

- **Whether the store Expo Go supports SDK 57 on any given day — unverified.** Check the live App Store listing; if it shows SDK 57, Option A (a free update) is all you need.
- The **$99 Apple requirement for iOS-on-Windows** and the **single-SDK Expo Go** root cause are high-confidence.
- The local-vs-cloud Android speed claim is a reasoned estimate (no published timings); true from a cold Windows machine, flips if the toolchain is already installed.
