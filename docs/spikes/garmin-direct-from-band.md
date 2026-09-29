> **See also, and read first:** `docs/spikes/garmin-all-data.md` (2026-09-25) and `garmin-risk.md` (2026-09-26) cover the routes that go through **Garmin's cloud** — the official partner APIs and the unofficial Connect web API (route H/I). This document answers a *different* question you asked: **can we make our own method that reads the band directly, with Garmin's cloud entirely out of the loop?** It is about USB and Bluetooth off the CIRQA itself, not about `connectapi.garmin.com`.
>
> **FEASIBILITY STUDY — nothing built (written 2026-09-28).** ARC code facts read from this worktree at head migration `0065`. Web facts carry a source and a confidence tag ([G] Garmin confirms · [R] named reviewer/vendor/user reported · [I] inferred · [?] unknown). Two facts that decide the payoff are **unverified and cheaply testable this week** with hardware you already own — see §6. Nothing here is committed to; §7 is the decision. The research draws on two dedicated CIRQA passes done 2026-09-28 (device facts, and the BLE/GFDI protocol); the load-bearing claims (Gadgetbridge CIRQA support, the Health SDK's no-servers capability) were re-verified against primary sources before being asserted here. The coexistence and data-deletion findings (§1, §4) are drawn from Gadgetbridge's code and are **untested for the CIRQA** — flagged as such, and placed in Stage 0b (§6) to settle before any BLE build.

# Garmin CIRQA: reading the band directly, with Garmin's cloud out of the loop

**Date:** 2026-09-28 · **Status:** research and feasibility. Nothing built.
**Your ask:** *"creating our own method for getting data directly from my Garmin CIRQA band, bypassing Garmin entirely."*
**The honest headline:** it is technically real, an open-source client already drives your exact band, and it is the *most* on-brand route ARC has — but "bypassing Garmin entirely" has one asterisk (§1), and whether it yields the *polished* scores or only the raw-and-mid signals turns on a fact a 30-minute test settles (§2, §6).

---

## The answer in six lines

1. **Three ways read the band directly, none through Garmin's servers:** USB file copy off the band; a reverse-engineered Bluetooth sync (which already works — Gadgetbridge names the CIRQA); and Garmin's own Health SDK, which Garmin says needs no Garmin servers. A fourth, Broadcast HR, is live heart rate only and near-useless for recovery.
2. **This is the only family of routes that keeps ARC's charter intact.** No egress to Garmin, nothing personal at rest in any cloud, full ownership (CLAUDE.md §2). The cloud API (route H) *adds* a network call to Garmin; a direct link does not. For "bypass Garmin," the direct routes are not a compromise — they are the ideal.
3. **On terms and detectability, the direct routes are cleaner than route H,** not dirtier. Reading your own device over its own Bluetooth/USB is not "scraping the Site." Garmin's servers never see it, so the ~0.1% account risk and the breakage exposure from `garmin-risk.md` **do not apply here at all** (§5).
4. **The USB route is low technical risk and reuses plumbing ARC has already planned.** Same FIT parser as the file-import routes; the same encrypt→iCloud→import leg as route I. Its ceiling is set by what files the band exposes — **unverified, testable in 30 minutes on your Windows PC.**
5. **The Bluetooth route is the elegant end-state — wireless, no computer — and it is less of a leap than it looks:** Gadgetbridge (open source) already has *experimental support for the CIRQA*, so a known-good reference implementation for your exact device exists. The cost is still the largest build ARC has scoped — ARC has *zero* Bluetooth code today, and this would be a from-scratch iOS native module — but "port a working client" is a very different risk from "reverse-engineer blind." Two BLE-only wrinkles to respect: whether ARC can read the band **without disrupting Garmin Connect** is untested, and a naive client can make the band **delete files Garmin hasn't synced** — both have known mitigations and both are settled by the on-device probe (§1, §6).
6. **The one fact that governs the payoff:** the band near-certainly stores the raw and mid-tier signals on-device (HR, the overnight RMSSD *values*/beat-intervals, SpO2, respiration, stress, Body Battery, skin temperature). What is genuinely uncertain is whether the **top-tier scores** — sleep staging/score, HRV *Status*, Training Readiness — are computed on the band or only in Garmin's app/cloud. **Settle that before building anything** (§2, §6).

---

## 1. What "bypass Garmin entirely" can and cannot mean

You cannot bypass Garmin for **setup**. A screen-free band is activated, paired, configured and firmware-updated through the Garmin Connect app and a Garmin account [G]. Turning Pulse Ox on, and even turning **USB File Access on**, are toggles inside the Garmin Connect app (§3) [G]. There is no first-run that never touches Garmin.

What you *can* bypass is Garmin's **cloud and app for ongoing data collection**. Set the band up once with Garmin, then have ARC read it directly from that point on, and Garmin's servers never see your data again. That is the achievable and worthwhile goal, and the rest of this document is about it. Everywhere below, "bypass Garmin" means this, not the literal absolute.

Two consequences to note now, and a hazard:
- **Coexistence with Garmin Connect is uncertain for the BLE route, not settled.** iOS actually lets several apps hold a connection to the same peripheral at once (CoreBluetooth's `retrieveConnectedPeripherals` "can include those that other apps have connected") [G-Apple], and Garmin's protocol tags each app with its own 8-byte client id (Garmin Connect uses `0x01`) [R]. So a second client is conceivable — but the band may answer a second data-channel registration with `ALREADY_IN_USE`, and the reverse-engineered client (Gadgetbridge) **assumes it is the band's only client and never handles that reply** [R]. Garmin's *Standard* SDK is explicitly "not compatible with Garmin Connect"; its *Companion* SDK is "compatible" [G] — so Garmin ships both a coexisting and a non-coexisting variant. Net: whether ARC can read the band over BLE while Garmin Connect keeps syncing is **untested for the CIRQA** (§4, §5). Firmware updates would still route through Garmin Connect periodically [G].
- The **USB route has no such tension** — the Garmin app and ARC's file reads coexist fine, because USB is just a file copy.
- ⚠️ **The data-deletion hazard (BLE route only).** Garmin's sync marks each file synced/archived after download, and **the band then removes it from its own memory** [R]. Your ARC data has only one copy and you rely on Garmin Connect too, so an ARC BLE client that naively downloads-and-marks would **consume files Garmin Connect hasn't ingested yet.** The mitigation is known and mandatory: request the file list **without** the synced-exclusion flag (already-synced files stay readable for months) and **never mark a file synced or archived**, never set the band clock, never send setup-complete or fake-sign-in events [R]. This must be proven on-device before any BLE build (§6). The USB route does not have this hazard — copying a file doesn't delete it.

---

## 2. The fact that decides the payoff: on-band scoring vs. app scoring

Wearables split into two camps:
- **Compute-on-device** (classic Garmin watches): the device derives sleep stages, Body Battery, HRV status and stores them. Read the device, get finished scores.
- **Compute-in-app** (WHOOP-style): the band stores raw streams and ships them to a phone/cloud that scores them. Read the device, get **raw signals only**.

Gadgetbridge documents the split plainly: *"Sleep stages are only supported on devices that are able to display them without a phone connection"*, and on devices that cannot, it *"might display sleep almost all day, since the watches are not able to compute sleep without a connection to the official app."* *(gadgetbridge.org/basics/topics/garmin, read 2026-09-28)* [R] A **screen-free** band is the class most likely to leave scoring to the app.

**But the CIRQA is better-placed than that caveat implies, for the lower tiers.** Strong evidence the band stores the raw and mid-tier metrics itself:
- Garmin's **Standard Health SDK "does not require use of any Garmin servers"** and yet delivers Body Battery, stress, Sleep, **Advanced Sleep Data**, Respiration and Pulse Ox, plus real-time **Enhanced Beat-To-Beat Intervals** *(developer.garmin.com/health-sdk/overview, read 2026-09-28)* [G]. If those arrive with no server in the loop, the band is supplying them.
- Fitrockr, a research vendor, lists Body Battery, stress, sleep, skin temperature and **raw and enhanced beat-to-beat intervals** among CIRQA data it imports *"directly from the band"* [R].
- Gadgetbridge parses only files the device itself produces, and confirms CIRQA **sleep sync** works [R].

**My verdict per metric (from the 2026-09-28 pass):**
- **Probably on-band** [I]: heart-rate series, overnight RMSSD *values* and beat-intervals, SpO2, respiration, stress, resting HR, Body Battery, skin temperature.
- **Genuinely unknown** [?]: sleep *stages* and sleep *score*, Sleep Coach, **HRV Status** (which needs a ~19-night baseline [R]), Training Readiness. These are the app/cloud-computed candidates.
- **Probably app/cloud** [I]: activity *classification* (Gadgetbridge receives auto-detected activities as a generic type — the band records, the cloud labels [R]), and "Health Status".

**A correction to the sibling docs while we're here:** `garmin-hrv-routes.md §3.2` and `garmin-all-data.md` called **Body Battery and Training Readiness "unreachable"/"not in the public file format."** That's true of Garmin's *published* FIT profile, but Gadgetbridge's reverse-engineered profile locates them as undocumented fields in the device's own files: **Body Battery** as field 3 (`body_energy`) of message 227, **Training Readiness** as message 369 [R]. So on watches they *are* in the files; whether the CIRQA writes them is unverified (Stage-0 settles it). This slightly raises the ceiling of both direct routes.

**Why this still gates the build, but less severely than a binary would suggest:** even the pessimistic outcome (top scores are app-only) leaves a rich, useful, fully-offline dataset — everything Home's Recovery actually consumes today is HRV and resting HR, and the RMSSD values are near-certainly on-band. The optimistic outcome hands you the polished sleep/readiness numbers too. Either way, **decode one real file first** (§6) so you know which world you're in before committing native effort. Confidence: the general split is **confirmed**; where the CIRQA's top tier sits is **unknown**.

---

## 3. Route A — USB File Access (band → your PC → ARC)

**Confirmed real for the CIRQA** *(www8.garmin.com CIRQA manual, "Connecting the Device to Your Computer" + software page, read 2026-09-28)* [G]:

- **Enable it once in the Garmin app:** Menu → Garmin Devices → CIRQA → System → **USB File Access** → enable **File Access Over USB**. It is **off by default** — Garmin's software page says the computer only recognises the band with it on, Garmin Express included [G]. Index Sleep Monitor owners (the closest sibling) report the same [R]. This is the screen-free asterisk from §1: the band has no menu, so the toggle lives in the app.
- **The included cable is a USB-C charging/data cable** [G] — it carries data, not just power.
- **The computer sees it** "as a portable device, a removable drive, or a removable volume." On **Windows it mounts natively** (a "portable device" is MTP, which Windows supports out of the box) [G/I] — which suits you (you're on Windows). On **Mac it does not**: "Mac operating systems do not detect the device by default… use Garmin Express to interact with files" [G] (matters only if you switch to the Mac laptop).
- **MTP vs. mass storage is genuinely muddy:** the manual's System Settings table describes a "USB Mode" choice between MTP and a "Garmin mode" [G], while the Mac note implies MTP and one Index-Sleep-Monitor user reported a drive mount [R]. Treat it as **[?]** until you look (§6).

**What's still unverified:** the manual says only that you can "transfer activity files or data," and does **not** name the folders. On Garmin watches the tree is `GARMIN/Activity`, `GARMIN/Monitor` (all-day wellness), `GARMIN/Sleep`, `GARMIN/Metrics` (HRV status, VO₂max) [R]. **Whether the CIRQA exposes the wellness folders over USB — and whether those files carry the computed scores (§2) — is the open question.** The best evidence they *are* exposed: an Index Sleep Monitor user says that band exposes **sleep and monitoring FIT files over USB** [R]. Confidence: USB-as-a-drive **confirmed**; the wellness-file contents **unknown**.

**How it wires into ARC.** Not new architecture — it is the **route I** design from `garmin-all-data.md §4`, with the file *source* changed from the cloud export to the USB mount:
- A small **PC-side job** copies the day's new FIT files, encrypts them with XChaCha20-Poly1305 (`@noble/ciphers`, already a dep) under a key paired once from ARC, and drops the ciphertext into an iCloud Drive folder.
- ARC's **importer** (on app-active) decrypts, decodes each FIT with `@garmin/fitsdk` (pure JS, not yet a dep), writes `wearable_data` rows as `source_device 'garmin'` (already allowed by the 0021 CHECK; `source_raw_id 'fitusb:<metric>:<date>'`), and deletes the processed file.
- **No migration** for daily metrics (`metric_type` is free text, `garmin` already permitted). Minute-level series would need a new table → a migration (next free `0066`).
- **Or, dead-simple manual variant:** skip the PC job and iCloud — copy a night's files to the phone (AirDrop/Files) and pick them with ARC's existing file picker. That's the **route B** import from the sibling doc. Zero automation, works the day the parser lands.

**Effort:** the parser is the bulk, pure JS, testable headless against one real file. The PC job is a short script. **Ongoing:** plug the band into the PC when it charges (~weekly). **Latency:** whenever you next plug in.

**Terms / detection:** copying files off a device you own is not the "scraping the Site" clause, and there is **no network to Garmin at all** — nothing to detect, no account exposure (§5).

**Verdict:** the pragmatic direct route. Low technical risk, reuses planned plumbing, cleanest on principles. **Its whole value rides on §6's file test.**

---

## 4. Route B — Bluetooth, directly off the band

Two flavours: the reverse-engineered client (free, community, already supports the CIRQA) and Garmin's sanctioned SDK (capable, no servers, but enterprise-gated).

### B1 — Reverse-engineered GFDI sync (the "our own method")

ARC connects over BLE, speaks the protocol the Garmin app speaks, and pulls the stored FIT files — no cable, no cloud, no Garmin app in the loop for data.

- **It already works on the CIRQA.** Gadgetbridge added *"Garmin CIRQA: Experimental support"* on **2026-08-03** (commit `5b73602`), shipped in **0.93.0** *(gadgetbridge.org/blog/release-0_93_00, verified 2026-09-28)* [R]. The coordinator matches the Bluetooth name `^CIRQA Smart Band$`, defaults the **newer sync protocol** on (which forces MLR — "new sync protocol without MLR fails to sync large workouts"), and drives the band **as a standard Garmin watch** [R]. The CIRQA's FIT product id is **5019 (cirqaSmartBand)**, added to Garmin's FIT SDK 21.212.0 on 2026-08-04 [G]. Its device page: **sleep sync confirmed**; known issues are that you can't manually record an activity, alarms don't save, and timed activities sync as a generic type; the coordinator's own comment is *"Largely untested, workout sync does not seem to work properly"* [R]. Factory firmware 2.20 was flaky; activity sync worked from 2.32 [R]. Nothing public covers behaviour on your 2.50/3.20 firmware — a reason the on-device probe (§6) matters.
- **The protocol is public** *(gadgetbridge.org/internals/specifics/garmin-protocol, read 2026-09-28)* [R]: GATT service `6A4E2800-667B-11E3-949A-0800200C9A66`, Multi-Link / Multi-Link Reliable framing, GFDI messages (COBS + CRC-16), a registration handshake, and FIT file download via directory listing.
- **Crucially for a screen-free band: no cryptographic pairing / passkey is required** for the data connection — the obvious "no screen to show a code" blocker does not apply [R]. (A Garmin OAuth credential is needed only to *push* weather/AGPS *to* the band, not to read from it.)

**What ARC would have to build — the big one:**
- ARC has **no Bluetooth anywhere today** (deps checked at head `0065`: no `react-native-ble-*`, no Bluetooth native code; the only native module is `arc-backup`). This is a **new Swift/CoreBluetooth native module** implementing ML/MLR framing, GFDI, COBS, CRC-16, the registration handshake and the FIT-download state machine, then the same FIT parser as route A on top. The reliable transport acknowledges within ~10–20 ms, which argues for a **native Swift transport** rather than a React Native BLE library.
- **Register under ARC's own client id and handle the answers.** Each app tags itself with an 8-byte client id; ARC must not impersonate Garmin Connect's `0x01` or Gadgetbridge's `2`. A data-channel registration can return success, `PENDING_AUTH`, or `ALREADY_IN_USE` (Garmin Connect holds it) — and ARC must handle `ALREADY_IN_USE` gracefully, which Gadgetbridge does not. Garmin's app-level auth (message 5101) does not appear enforced today (Gadgetbridge answers it with all-zero flags and still syncs) [R].
- **Obey the data-safety rules from §1** — read with the synced-exclusion flag off, never mark files synced/archived, never set the clock or send setup/sign-in events. Also drop and never log any `oauth_token`/`oauth_*` seen in the BLE traffic [R].
- **Gadgetbridge is AGPL-3.0** (app code *and* the protocol docs) — the CIRQA coordinator is a *reference to reimplement from*, not code you can lift into a shipped app without AGPL obligations. Still, a working client that names your device turns this from "reverse-engineer blind" into "port a known-good implementation," the single biggest de-risker here.
- **iOS BLE background is constrained** (~10 s per wake under `bluetooth-central`; iOS 26's AccessorySetupKit changes relaunch-after-force-quit) → ARC would sync **on app-open** (already how it fetches), not continuously overnight. TestFlight internal-tester builds don't need extra review for this.

**Effort:** the largest single build ARC has scoped — weeks of specialist native work, plus device-specific validation (likely BLE-sniffing your own band to confirm the coordinator's behaviour on your firmware). **Ongoing once built: the lowest of any route** — open ARC, it syncs wirelessly, no PC, no cloud.

### B2 — Garmin Health Standard SDK (sanctioned, direct, no Garmin servers)

Garmin's own on-device SDK is the legitimate version of the same idea *(developer.garmin.com/health-sdk/overview, read 2026-09-28)* [G]:
- **"Does not require use of any Garmin servers"** — a genuinely offline, direct BLE link.
- Delivers **Body Battery, stress, Sleep, Advanced Sleep Data, Respiration, Pulse Ox** all-day, plus real-time **Accelerometer and Enhanced Beat-To-Beat Intervals** (the beat intervals you'd need to compute HRV yourself). HRV is not explicitly listed.
- **Enterprise only.** "Evaluation: Free"; commercial use is a "License Fee or Minimum Device Order Quantity" (prices unpublished), via a request form. **Not compatible with Garmin Connect** on the same connection.
- The published device families **do not list screen-free bands** — but research vendors **Fitrockr and Fitabase document using it with the CIRQA** [R], so CIRQA eligibility is plausible-but-unconfirmed [?].

**Why it's in scope even if likely unavailable:** it proves the band delivers the mid-tier computed scores over a direct, server-free link (reinforcing §2), and the free evaluation is a cheap way to see the real data. As a *shipped* route for a personal app it's the weakest — enterprise licensing and a native iOS SDK integration — but it's the honest "sanctioned" option and worth a request-form email if you want to know what the band truly exposes without any reverse engineering.

**Verdict for §4 overall:** B is the elegant destination and a real "our own method." **Don't start here**, but it's meaningfully de-risked by Gadgetbridge already supporting the CIRQA. Justify the native build after §6 proves the data is worth it — ideally after route A is already delivering value, so B is a wireless convenience upgrade rather than a leap.

---

## 5. Route C — Broadcast Heart Rate, and the dead ends (for completeness)

- **Broadcast HR** (app toggle: Health & Wellness → Broadcast Heart Rate; or a 3-second button hold) streams over **ANT+ or BLE** [G]; in broadcast mode the band advertises Garmin's member UUID `0xFE1F`, and the standard Heart Rate Service is in its attribute table once connected [R]. **Live HR only** — not the stored overnight HRV/sleep/recovery data Home needs. It **probably omits RR/beat intervals** (a third-party app reports Garmin optical broadcasts send BPM only [R]; Garmin's separate real-time HRV service (12) *does* carry RR on watches, CIRQA unverified [R]), and left on permanently it drains the battery in ~1.5 days [R]. iPhone has no ANT+, so only BLE matters [I]. **Trivial to build, near-zero value for recovery**; worth it only for a real-time HR readout during a logged workout.
- **ANT+:** iPhones have no ANT+ radio. Out.
- **Connect IQ:** the CIRQA isn't a Connect IQ device, and CIQ can't read HRV Status even on watches. Out *(established in `garmin-hrv-routes.md §3.4`)*.

*(The Garmin Health SDK, previously listed here as a dead end, has been promoted to §4-B2 — it is a real direct route, just enterprise-gated.)*

---

## 6. Stage 0 — the 30-minute test that unblocks the whole decision (do this first, no code)

The unknowns that gate the payoff are answered by one session with hardware you own and your Windows PC. Do this before building anything:

1. **Enable USB File Access** in the Garmin Connect app (Menu → Garmin Devices → CIRQA → System → USB File Access).
2. **Plug the band into the Windows PC.** In **Device Manager**, "Portable Devices" ⇒ MTP, "Disk drives" ⇒ mass storage — note which. Open the mount and **screenshot the `GARMIN` folder tree**: is there only `Activity`, or also `Monitor` / `Sleep` / `Metrics`? → *answers whether route A reaches the overnight data at all.*
3. **Copy one night's wellness/sleep FIT file** and decode it headless with `@garmin/fitsdk` (a ~20-line Node script; the sibling docs vetted the decoder runs under Hermes). Look for these message numbers — if present, the band computed them: `sleep_level 275`, `sleep_assessment 346`, `hrv_status_summary 370`, `hrv_value 371`, `stress_level 227`, `respiration_rate 297`, `spo2_data 269`, `skin_temp_overnight 398`, `beat_intervals 290`. → *answers §2 — on-device vs. app scoring — for every direct route at once.*
4. **Cross-check against the app:** note any score that appears in Garmin Connect but is **absent** from the on-band file. Those are the app-computed metrics you would *not* get by bypassing Garmin.

**Stage 0b — only if you decide to scope route B (needs a small native harness, not no-code).** In order, on the real band with 3.20 firmware and Garmin Connect installed:
1. With `retrieveConnectedPeripherals` + service `6A4E2800…`, does ARC see the band, and how many characteristic pairs does it expose?
2. Ask the registration service (4) which services the band supports — **read-only.**
3. Register the GFDI data channel under a **new** client id and record the reply: success / `ALREADY_IN_USE` (and which characteristic it points to) / `PENDING_AUTH` — and whether **Garmin Connect keeps syncing** meanwhile. *(This is the coexistence answer.)*
4. List files with the synced-exclusion flag **off**, download one sleep and one HRV-status file, and **never mark anything synced or archived** (§1 hazard).
5. Decode with the FIT Swift SDK plus the community definitions for messages 227/369 — this shows what the CIRQA actually writes.
For the cheap live-HR check: with **nRF Connect** on the iPhone, turn on Broadcast HR and subscribe to `0x2A37`; **flags bit 4 set ⇒ RR intervals present**.

Outcomes:
- **Wellness files present + scores present** → route A is a straightforward build and the recommended target; route B is a later wireless upgrade.
- **Files present + only raw signals** → bypassing Garmin gets the raw/mid-tier series (still valuable — it's what Recovery uses), and cloud route H stays the way to get Garmin's *finished* sleep/readiness numbers. This is the most important thing to learn, and it's cheap.
- **Wellness files absent over USB** → route A is activities-only; route B (BLE) becomes the only direct path to overnight data, and Gadgetbridge already supporting the CIRQA is what makes that viable.

There is no reason to write a line of code before this test.

---

## 7. Recommendation

**For "bypass Garmin, simplicity, maximum data," in order:**

1. **Stage 0 first (this week, no code).** The USB inspection above. 30 minutes; it converts the biggest unknowns into facts. Everything else waits on it.

2. **If Stage 0 is favorable → build route A (USB → PC → ARC).** Lowest technical risk, reuses the route-I plumbing and the FIT parser already scoped, cleanest on ARC's no-cloud charter, no account risk, no detectability. Ship the **manual file-picker variant first** (works the day the parser lands), then automate the PC→iCloud leg if the manual step annoys you.

3. **Treat route B1 (reverse-engineered BLE) as the end-state, now meaningfully de-risked.** Gadgetbridge already has experimental CIRQA support, so this is a *port*, not a blind reverse-engineer — but it's still the heaviest native build ARC has considered, and ARC has no Bluetooth code today. Justify it after (a) §6 proves the band holds data worth having, and ideally (b) route A is already delivering, so BLE is a convenience upgrade. Track Gadgetbridge's CIRQA coordinator as it matures (workout sync is noted as not-yet-right).

4. **Route B2 (Health SDK):** worth a **free-evaluation request** if you want to see exactly what the band exposes over a sanctioned, server-free link without any reverse engineering — but enterprise licensing makes it a poor fit as ARC's shipped mechanism. Best used as a *probe*, not a dependency.

5. **Broadcast HR:** only if you later want live workout HR. Not part of the recovery story.

**Regardless of route:** the direct-from-band family is strictly *safer* than cloud route H on terms, detectability and account risk (§5) — so if you were weighing route H's ~0.1% ban exposure from `garmin-risk.md`, a direct link carries none of it. The price you pay instead is engineering effort and the §2 uncertainty, both of which the Stage-0 test lets you price before committing.

---

## 8. Questions for you

**Q1.** Will you run the Stage-0 USB test on the Windows PC this week? It's the gate for everything and needs nothing built. *(Recommended: yes.)*

**Q2.** If the band stores only **raw/mid-tier signals** (not the top scores), how far do you want to go — accept the raw series into ARC and let the Coach reason over them, or keep route H (cloud) as the source of Garmin's *computed* sleep/readiness numbers and use the direct link only for the raw series? *(Recommended: decide after seeing one real file.)*

**Q3.** Is the **wireless, no-PC** end-state (route B1) worth a multi-week native BLE build, or is "plug in weekly" (route A) good enough for a personal system? *(Recommended: build A; keep B1 as a documented upgrade, de-risked by the Gadgetbridge port.)*

**Q4.** Want me to send the **Health SDK free-evaluation request** (or draft it for you) to settle exactly what the CIRQA exposes over a sanctioned direct link? *(Recommended: optional; it's a probe, not a build dependency — and I'd only draft it; you'd send it.)*

---

## 9. Unverified — and the cheapest way to settle each

1. **Whether the CIRQA exposes wellness folders (Monitor/Sleep/Metrics) over USB, or only activities.** → *Stage 0, step 2.*
2. **Whether the on-band FIT files carry computed top-tier scores or only raw/mid signals (§2).** The pivotal one. → *Stage 0, step 3.*
3. **MTP vs. mass storage on Windows, and which "USB Mode" the app exposes.** → *Stage 0: Device Manager.*
4. **The CIRQA's Gadgetbridge maturity** — sleep sync is confirmed [R]; workout sync is noted as not-yet-right, and behaviour may vary by firmware. → *Watch the coordinator on Codeberg; validate against your own band.*
5. **Whether the Health SDK's free evaluation actually admits the CIRQA** (screen-free bands aren't on the published list, but Fitrockr/Fitabase use it). → *Submit the request form.*
6. **Whether Broadcast HR carries RR/beat intervals.** → *nRF Connect on `0x2A37`, flags bit 4.*
7. **How many days the band retains before overwriting** (128 MB storage; not published). → *Keep Bluetooth off several days, then check oldest file dates over USB.*
8. **Whether the band grants a second GFDI data session while Garmin Connect holds one** (the coexistence question) — and whether reading the band pauses Garmin Connect's own sync. → *Stage 0b, step 3.*
9. **Whether "read without marking synced" actually preserves files for Garmin Connect on the CIRQA** (the §1 data-deletion mitigation). → *Stage 0b, step 4, watching what Garmin Connect syncs afterward.*
10. **The legal position of a local device read.** Garmin's Terms of Use bind only "the Site" and are not touched by Bluetooth [G]; but Garmin's device **software licence** forbids reverse engineering (standard Garmin wording; the CIRQA's manual has no such page — 404 on 2026-09-28) [G/?]. US law has an interoperability carve-out (17 U.S.C. §1201(f)) for someone who lawfully owns the device — *not legal advice*. No record of Garmin taking action against Gadgetbridge was found. Reusing Gadgetbridge code/docs adds **AGPL-3.0** obligations if ARC is distributed. → *Your call; there's no detection surface either way.*

---

## Sources

**Garmin (read/verified 2026-09-28)**
- CIRQA Owner's Manual — Connecting to a Computer, System settings, Broadcast HR, reset, pairing, activity, Body Battery, VO₂max, charging, LED, update: under https://www8.garmin.com/manuals/webhelp/GUID-D3BE589F-1A6C-4B6F-9ABC-07DB9AA6C739/EN-US/
- CIRQA product page (specs, 128 MB storage, ANT+/BLE, USB-C charging/data cable): https://www.garmin.com/en-US/p/1989182/
- CIRQA FAQ: https://support.garmin.com/en-US/?faq=0aPZYBMrrC38wtLAPuniP9 · software/firmware (v3.20): https://support.garmin.com/en-US/?partNumber=010-04675-13&tab=software
- **Health SDK overview** ("does not require use of any Garmin servers"; metric list; enterprise-only; not compatible with Garmin Connect): https://developer.garmin.com/health-sdk/overview/
- FIT JS SDK profile (product id 5019 cirqaSmartBand, added 21.212.0 on 2026-08-04; message numbers): https://github.com/garmin/fit-javascript-sdk/blob/main/src/profile.js
- Index Sleep Monitor (2025, Garmin's first screen-free band; shares the CIRQA's manual topics incl. USB File Access): https://www.garmin.com/en-US/p/1650098/

**Gadgetbridge — the reverse-engineered Garmin BLE stack (read/verified 2026-09-28)**
- **0.93.0 release, "Experimental support for Garmin CIRQA" (2026-08-13):** https://gadgetbridge.org/blog/release-0_93_00/
- Garmin device support & the on-device-vs-app scoring caveat: https://gadgetbridge.org/basics/topics/garmin/
- Garmin BLE/GFDI protocol internals (service UUID, ML/MLR, COBS/CRC, registration, FIT download, "no explicit authentication handshake"): https://gadgetbridge.org/internals/specifics/garmin-protocol/
- CIRQA coordinator added 2026-08-03, commit `5b73602` (name match `^CIRQA Smart Band$`, new-sync-protocol default, "workout sync does not seem to work properly"); maintainer "Already supported as of 0.93.0" on issue #6696. *(Codeberg serves scrapers garbage — these were read from the repo at commit `03ee088f`; the release blog above is the citable confirmation.)*
- On-device sync behaviour (client ids, `ALREADY_IN_USE`, message-5101 auth, mark-synced-then-device-deletes, oauth tokens in traffic): Gadgetbridge `CommunicatorV2.java`, `FileSyncServiceHandler.kt`, `FitImporter.java`, and https://gadgetbridge.org/basics/topics/multiple/
- Existence proofs, direct BLE without the phone app: https://github.com/gwerneckp/garmin-ble (Python, live metrics; file transfer planned) · https://github.com/wh1le/garmin-bridge (Linux) · https://github.com/seofernando25/garmin-proto-lab (auth msgs 5101–5112, unverified)

**Apple / iOS & legal (read 2026-09-28)**
- CoreBluetooth multi-app connection: `retrieveConnectedPeripherals(withServices:)` ("can include those that other apps have connected") and `cancelPeripheralConnection` (physical link may persist), developer.apple.com/documentation/corebluetooth
- Background BLE (~10 s/wake) archived guide; TN3115 + forums.apple.com/thread/806013 (iOS 26 AccessorySetupKit relaunch); TestFlight review applies to external testers only
- DC Rainmaker CIRQA comments: Ray Maker #369 (3 BT HR channels + phone; simultaneous Connect + TrainerRoad), Peter N #368 (advertises `0xFE1F`; standard HR service present)
- Garmin device software licence, standard "not… reverse engineer" wording (e.g. Index BPM manual); 17 U.S.C. §1201(f) interoperability exception; Gadgetbridge DMCA post-mortem (no Garmin action on record)
- Fitrockr direct-from-band via "Garmin Health API and SDK" (Garmin PH newsroom): https://www.garmin.com/en-PH/newsroom/press-release/news-2026-mar-fitrockr/

**Reviewers / vendors (read 2026-09-28)**
- DC Rainmaker CIRQA hands-on (2026-07-21) & one-month review (2026-08-23): https://www.dcrainmaker.com/2026/07/garmin-cirqa-everything-you-need-to-know.html · https://www.dcrainmaker.com/2026/08/garmin-cirqa-in-depth-review-one-month-later-expectations-reality.html
- the5krunner CIRQA specs & review: https://the5krunner.com/specs/garmin/cirqa/ · https://the5krunner.com/2026/08/19/garmin-cirqa-band-review/
- Fitrockr CIRQA (SDK-based, "directly from the band", USB sync): https://www.fitrockr.com/garmin-cirqa-smart-band-compatibility/ · Fitabase: https://www.fitabase.com/blog/post/garmin-cirqa-screenless-device-for-research/
- Index Sleep Monitor USB/FIT-over-USB user report: https://forums.garmin.com/sports-fitness/healthandwellness/f/index-sleep-monitor/441344/

**ARC code (read at head `0065`, nothing edited)**
- `package.json` — no Bluetooth/BLE/webview/FIT deps present; only native module is `modules/arc-backup`
- `db/migrations/0021_wearables_health.sql` — `source_device` CHECK already permits `garmin`; `health_sync_state` free-JSON KV
- `src/lib/db/repositories/wearables.ts` — `SOURCE_PRIORITY` (garmin ranked); `src/lib/health/mapping.ts` — `VENDOR_BUNDLES`, `sourceDeviceFor`
- The route-I / FIT-parser plumbing this reuses: `docs/spikes/garmin-all-data.md §4`, `garmin-hrv-routes.md §3.2/§4`
