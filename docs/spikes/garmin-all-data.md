> **PLAN — not built (written and fact-checked 2026-09-25).** The owner asked for "all data but minimal involvement"; this supersedes the recommendation in `garmin-hrv-routes.md` (file import) with a staged path: Pulse Ox on, a full export and a Health Sync test today; an in-app Garmin link (unofficial API) in the next EAS build, once he accepts the trade. Nothing is built until he answers §6.

# Garmin CIRQA: all the data, with as little of your time as possible

*Decision document, 2026-09-25. It follows up `docs/spikes/garmin-hrv-routes.md` (2026-09-23). That spike ruled out every automatic route under a strict reading of ARC's rules. This document rules nothing out: each route states which rule it bends, and you choose. The evidence comes from four research passes done 2026-09-25 (Garmin's partners, the direct unofficial API, automation off the phone, and device coverage). This pass also re-checked Garmin's developer overview page and the Health Sync and Vitals Sync App Store pages. ARC code facts were read from `main` at `2270f01`, where the latest migration is 0063.*

*Independently checked 2026-09-25. Corrections are inline, each marked "(checked 2026-09-25: …)". The recommendation (export first, then the in-app link after an on-device spike, with a bridge as fallback) stands. What changed is how the link would most likely catch Garmin's sign-in ticket (an injected script, not a caught navigation), that HRV status and baseline would not reach the Coach as row metadata, and a few dates, lifetimes and matrix cells.*

---

## The answer in five lines

1. **Nearly everything can arrive with no daily effort.** ARC can read Garmin Connect directly. You sign in once on Garmin's own page inside ARC. After that, every time you open ARC it collects HRV (with its status and baseline), sleep score, SpO2, respiration, stress, Body Battery, Training Readiness and VO2 max.
2. **The cost is that this uses Garmin's unofficial API.**
   - It breaks Garmin's Terms of Use. The stated penalty is account suspension. We found no case of that happening for personal use.
   - ARC gains a network call to Garmin, and a Garmin token is kept in the Keychain.
   - We estimate it will break 1–3 times a year, and each fix needs a new EAS build.
   - (checked 2026-09-25: two more costs.
     - Catching Garmin's sign-in ticket most likely needs a small ARC script **inside Garmin's login page**, because the ticket arrives in a background reply, not a page change (§4).
     - Garmin support told a developer in March 2026 that its terms "prohibit using an unauthorized third-party service to retrieve data from Garmin Connect", and it blocks such tools on purpose. It has blocked tools, not suspended accounts (§5).)
3. **No official route gets everything.** Garmin's own API is for businesses only, and it has taken no new applicants since spring 2026. The best partner, intervals.icu (free), gets HRV, resting HR, sleep score and Body Battery. It stores your data on its own servers, and it gets no SpO2, respiration or Training Readiness.
4. **You can start tomorrow with no build.** A bridge app can write Garmin data into Apple Health, which ARC already reads. The HRV part is not yet proven for either candidate:
   - **Health Sync** uses Garmin's official link and routes the data through its own server. Its current store page does not confirm HRV.
   - **Vitals Sync** uses the unofficial login, and you type your Garmin password into it. It does claim HRV, SpO2, respiration and VO2 max.
5. **Recommended path:**
   - **Today:** turn Pulse Ox on, request the full export, and test Health Sync.
   - **Next EAS build:** the in-app Garmin link.
   - **After that:** keep the bridge as the automatic HRV fallback for the days the link is broken.

---

## Codes used below

| Code | The CLAUDE.md principle it bends |
|---|---|
| **E** | A new network call **from ARC** beyond the AI call (CLAUDE.md §3 says the only sanctioned egress is the AI call plus user-started lookups) |
| **T** | Personal data passes through or is stored on **a third party's server** (§2: nothing personal at rest in any cloud) |
| **U** | **An unofficial API**, against Garmin's Terms of Use |
| **K** | **A Garmin credential or token stored on the phone** in the Keychain, as the AI key already is |

Every change in any route ships in a new EAS build, because ARC has no over-the-air updates (`expo-updates` was removed on 2026-08-23).

---

## 1. The options

Setup is shown as *your time · ARC build work*. Latency is how long after the band syncs to Garmin's cloud the data appears in ARC.

| # | Route | Data it gets | Setup | Ongoing | Latency | Money | Bends | Where the Garmin password is typed |
|---|---|---|---|---|---|---|---|---|
| A | **Manual entry** (baseline, works today) | HRV and resting HR, typed | none · none | **Daily**, about 10 s (`hrv 48` in Log) | When you type it | $0 | none | Nowhere |
| B | **Garmin export files, imported by hand** (the spike's plan) | History of almost everything. A per-day FIT file has HRV and its status, sleep and sleep score, SpO2, respiration, stress, skin temperature and VO2 max. **It has no Body Battery and no Training Readiness.** | Request the export · FIT importer, pure JS, one build | **Manual each time** (1–2 min for a per-day file) | Full export: 48 h to 30 days. Per-day file: same day | $0 | none | Garmin's website |
| C | **Health Sync → Apple Health** | Confirmed on the store page: steps, sleep and heart rate, 2 years back. HRV, resting HR and VO2 max: claimed earlier, **not on the current store page** | About 10 min · none (a one-line label change is optional) | None | It syncs "a few times per hour", then ARC reads it when opened | $3.99 once (free to install) | **T** | **Garmin's own page** (official OAuth) |
| D | **Vitals Sync → Apple Health** (HRV Sync is similar but HRV only) | HRV, respiration, SpO2 and VO2 max | About 5 min · none | None (background sync is unverified) (checked 2026-09-25: the store page does claim automatic background sync; it is untested, not unclaimed) | Its own background sync, then ARC when opened | Free | **U**, plus a token in *that app's* Keychain | **Into Vitals Sync, a third-party app.** It says the password goes straight to Garmin and is not stored |
| E | **FitnessSyncer**, into Apple Health or through its API | SpO2 ("Oxygen") and sleep; HRV unclear | About 15 min, with an awkward OAuth step · none (Apple Health) or an API client | None | Free tier: overnight. Pro: hourly | Free, or $5.99/month | **T** (and E and K if ARC uses its API) | Garmin's own page |
| F | **intervals.icu, pulled by ARC** | HRV (rMSSD), resting HR, sleep time and score, steps, Body Battery (daily max), weight. **Not** SpO2, respiration or Training Readiness (forum, June 2026) | About 10 min · a small build (a key field and a pull) | None, but visit the site every 90 days or pay $4/month | About 5 min after Garmin's cloud has it, then ARC when opened | Free, or $4/month | **E, T, K** | **Garmin's own page** (official OAuth) |
| G | **Tredict or Runalyze personal API** | Tredict: night RMSSD plus its baseline, sleep, resting HR. Runalyze: resting HR, sleep, HRV | Like F | Runalyze tokens expire, so you rotate them | Not stated | Tredict $49/year; Runalyze €27.50/year | **E, T, K** | Garmin's own page |
| H | **In-app Garmin link** (unofficial API, called from the phone) | **Everything Connect shows:** HRV with status and baseline, sleep stages and score, SpO2, respiration, resting HR, stress, **Body Battery, Training Readiness**, VO2 max, and workouts with the full heart-rate trace. Skin temperature only through the per-day FIT zip | About 1 min sign-in with 2FA · a few days plus one EAS build | **None.** Sign in again only if ARC goes unopened for 30+ days or the password changes. An estimated 1–3 breaks a year (checked 2026-09-25: the sources disagree on whether the ~30-day refresh window slides. garmin-health-data's README says both "valid indefinitely" if used within 30 days and "roughly a monthly step", and peloton-to-garmin #837 says to repeat the login "when the refresh token expires (~30 days)". The worst case is a one-minute Reconnect about once a month. See §5) | Whenever ARC opens | $0 | **E, U, K** | **Garmin's own page, shown inside ARC.** ARC's code promises not to read it, but iOS does not enforce that (checked 2026-09-25: the working capture method found puts an ARC script *inside* that page to read the login response. See §4. That script runs in the same page as the password field, so the promise rests on ARC's own code alone) |
| I | **Computer job** (unofficial API on the Mac or PC, writing an encrypted file to iCloud, which ARC reads) | Same as H | About 1 h · one EAS build (Swift folder access, pairing, importer) plus a script | None, as long as a computer is on each morning. Log in again when the token dies | The next hourly run, plus iCloud, plus opening ARC | $0 | **U**. The token sits on the **computer**. iCloud holds only encrypted data. **No E from ARC** | Into python-garminconnect's prompt on your computer, **or** on Garmin's page in your own browser using a manual-ticket login like the one in garmin-health-data |
| J | **USB from the band to the Windows PC**, then the same iCloud leg as I | Whatever FIT files the band keeps (unverified) | Turn on "File Access Over USB" and set up a job · the same build as I | **About weekly**: you charge the band from the PC | Charging days only | $0 | none | None |
| K | Garmin Health API with your own relay | Everything except Training Readiness and Training Status | **Blocked.** It needs a business entity and Garmin's approval, and Garmin is taking no applications | — | — | About $0 to run a relay | E, T (your own cloud), K, and a server | Garmin's own page |

**Out of the running**, one line each:
- **Aggregators** (Terra, Junction, Sahha): $299–499 a month, and Sahha and Open Wearables need your own Garmin keys.
- **Strava**: activities only, and its API policy forbids feeding the data to an AI. (checked 2026-09-25: the agreement's text forbids using Strava data "for any model training related to artificial intelligence". Whether a one-shot prompt counts is disputed on Strava's own developer forum (May 2026). Strava stays out anyway, because it carries activities only.)
- **TrainingPeaks**: no personal API.
- **Bevel, Welltory and Athlytic**: they display data but have no API or export.
- **AI-chat connectors** (ghurt, AthleteData, Garmin Chat Connector): they feed a chat window, not ARC's database, and hold an unofficial session on their own server.
- **Fitrockr**: a research contract, about €50 a month with a 3-month minimum.

Sources for this table are in §7 and the Sources list.

---

## 2. Coverage matrix: which channel carries which metric

**Y** = carried · **P** = partly · **N** = not carried · **?** = unverified. "Unofficial API" covers both H and I.

| Metric | Apple Health today | Health Sync | Vitals Sync | intervals.icu | Unofficial API | Per-day FIT | Full export | Health API (closed) | Where it lands in ARC |
|---|---|---|---|---|---|---|---|---|---|
| Overnight HRV (RMSSD) | N | ? (claimed, not on the current page) | Y | Y | Y | Y | Y | Y | `hrv`: **Home's Recovery verdict** |
| HRV status and baseline | N | N | N | ? | Y | Y | ? | N (checked 2026-09-25: the Health API's HRV summary, per MyDataHelps' format, has only `lastNightAvg`, `lastNight5MinHigh` and `hrvValues`. It has no status, no baseline and no weekly average) | Metadata on `hrv` (checked 2026-09-25: metadata never reaches the Coach. See the next section) |
| Sleep stages | Y | Y? | N | ? | Y | Y | Y | Y | Existing rows |
| Sleep score | N | N | N | Y | Y | Y | Y | Y | New type; the Coach only |
| Resting HR | P (users report it; not on Garmin's list) | Y? | N | Y | Y | Y | Y? | Y | `rhr` (existing) |
| All-day HR | Y | Y | N | N | Y | Y | ? | Y (every 15 s) | Existing rows |
| SpO2 | N | ? | Y | N? (the field exists; June 2026 forum says Garmin leaves it empty) | Y | Y | ? | Y | `spo2_pct` tile, **blank today** |
| Respiration | N | ? | Y | N? (same) | Y | Y? | ? | Y | `respiratory_rate` tile, **blank today** |
| Stress | N | N | N | N (its "stress" field is self-reported) | Y | Y | P | Y | New type; the Coach only |
| Body Battery | N | N | N | P (daily max) | **Y** | **N** | P? | Y | New type; the Coach only |
| Skin temperature (change from baseline) | N | ? | N | ? | Only via the FIT zip (no JSON endpoint confirmed) | Y | ? | Y | New type. **Not** `wrist_temp_c`, which holds absolute °C |
| VO2 max | N | Y? | Y | P? | Y | P | Y | Y | `vo2max` tile, **blank today** |
| **Training Readiness** | N | N | N | N | **Y (the only channel)** | N | ? | **N** | New type; the Coach only |
| Training Status and load | N | N | N | N (it computes its own) | Y | N | Y | N | The Coach only. ARC already computes strain from your logged sets |
| Workouts with the full HR trace | P (high/low only) | ? | N | Y (FIT) | Y | N | Y | Y | The §18 workout HR, which today's "average" only approximates |
| Steps and energy | Y | Y | N | P (steps) | Y | Y | Y | Y | Existing rows |
| Breathing variations | N | N | N | N | ? | Y | ? | ? | New type |

Two settings matter on **every** route:
- **Pulse Ox is off by default.** Until you set Garmin Connect → CIRQA → Health & Wellness → Pulse Oximeter → *During Sleep*, SpO2 is empty everywhere.
- **Floors are never recorded,** because the band has no barometer.

### What "all data" actually changes inside ARC

- **Only HRV changes Home's verdict.** Recovery divides today's value by the 30-day baseline and starts grading on day 6 (`src/lib/home/readiness.ts`).
- **SpO2, respiration and VO2 max** fill Data › Wearables tiles that already exist and sit blank. The Coach reads them.
- **Sleep score, stress, Body Battery, Training Readiness, HRV status and skin temperature** reach the Coach with no code: `read-tools.ts` picks up any `metric_type` it finds. They appear on no screen until tiles are built (Q3). (checked 2026-09-25: this holds only for values stored as their **own `metric_type`**. The plan in §4 keeps HRV status and baseline as **metadata on the `hrv` row**, and nothing in the Coach or on Home reads wearable metadata. `wearableArbitratedSeries` in `src/lib/ai/series.ts` returns only `{date, value}`, and `grep metadata` over `src/lib/ai` and `src/lib/home` finds no wearable read. So HRV status and baseline would be stored but invisible. The fix needs no migration: write the baseline bounds as their own numeric types (for example `hrv_baseline_low` and `hrv_baseline_high`), and the status as a numeric code under its own type, because `value` is `real NOT NULL`. The alternative is a small metadata read for the Coach. Discovered types also reach the Coach flagged `inferred: true`, with a label made from the type name, so a short entry in `WEARABLE_LABELS` would make them read properly.)
- **Minute-level series** (HR, stress, SpO2) have nowhere to go without a new table, and a new table means a migration (Q4).

---

## 3. Recommendation

**Smallest set:** the in-app link (H) for everything, a bridge (C) for HRV as a fallback, and the full export once for history and insurance. Ranked, with the trade each asks you to accept:

### Stage 0: today, no build, about 15 minutes

1. **Turn Pulse Ox to "During Sleep".** It bends nothing, and without it no route gets SpO2.
2. **Request the full export** at garmin.com/account/datamanagement. It bends nothing. It gives you three things:
   - your history;
   - one real file that settles the open coverage questions;
   - **insurance:** if Garmin ever suspends the account over route H, you already hold your own copy.
3. **Test Health Sync (C).**
   - Install it and connect Garmin on Garmin's own page.
   - Turn on only HRV, resting HR and VO2 max. Leave sleep, steps and heart rate off, because Garmin Connect already writes those to Apple Health.
   - Next morning, check whether ARC's HRV cell filled. If it did, buy the $3.99 licence.
   - **Trade (T):** appyhapps' server relays your Garmin data and keeps a Garmin refresh token.
   - If HRV does not arrive, keep typing `hrv 48` until Stage 1 ships.
   - Vitals Sync (D) would also work, but it means typing your Garmin password into a small third-party app (3 ratings) to get data Stage 1 brings anyway. **Not recommended.**

### Stage 1: next EAS build, the in-app Garmin link (H)

- **Why this one:**
  - It is the only route that gets everything, including Body Battery and Training Readiness. (checked 2026-09-25: the computer job (I) gets the same set, because it uses the same unofficial API. H is the only route that gets everything *without a computer*. Body Battery alone also comes through intervals.icu, as a daily maximum.)
  - It needs no computer and no third party.
  - Data arrives when ARC opens.
- **Trade:**
  - **U:** Garmin's terms. The penalty in the terms is suspension; none has been reported for personal reads.
  - **E:** ARC calls `diauth.garmin.com` and `connectapi.garmin.com`. No new party is involved, because the data already lives in Garmin's cloud.
  - **K:** a Garmin refresh token in the Keychain, device-only.
  - An estimated 1–3 breaks a year. Each one waits for the community to find a fix (2 days to about 3.5 weeks so far), then needs an EAS build. (checked 2026-09-25: none of the breaks in §5's table that hit H was fixed in 2 days. The range there is 3 days to about 3.5 weeks.)
- **Spike on the device first,** before building the rest. Two things carry the whole route, and neither has been proven on iOS 27:
  - that Garmin's sign-in and 2FA complete inside `react-native-webview`;
  - that the `ST-…` ticket can be caught and exchanged for tokens. (checked 2026-09-25: every working capture method found reads the ticket from the page, not from a navigation. On the mobile sign-in page the ticket comes back as `serviceTicketId` in the JSON reply to a `fetch` to `/mobile/api/login`. pirate-garmin reads it with an injected `fetch`/XHR hook, and peloton-to-garmin #837 reads it in DevTools. So the spike should test for a `?ticket=` navigation, and if none comes, fall back to an injected hook that reads only that one response. That hook sits in the same page as the password, which is the privacy cost to put in front of the owner. An iPhone has no DevTools, so an in-app hook is the only in-app fallback.)

  If the spike fails, go to the alternatives below.

### Stage 2: keep the bridge as the fallback (no code)

- Health Sync's rows land as `source_device 'other'`, which ranks **below** `garmin` in `SOURCE_PRIORITY`. So the link's value wins whenever the link has one, and the bridge fills the day automatically when the link is down.
- **Do not relabel the bridge as `garmin` once the link exists.** Two `garmin` rows on the same day tie, and `dailyMetricSeries` in `src/lib/db/repositories/wearables.ts` keeps whichever row SQLite returns first.
- A break costs **delay, not data.** Garmin keeps the history, and the link fills the gap once it is fixed. Minute-level data goes to Garmin's cold storage after about 6 months; daily summaries stay available. (checked 2026-09-25: no source for "about 6 months" was found. python-garminconnect says only that "Garmin offloads older data", and its reload request for an old date is a **POST** (`/wellness-service/wellness/epoch/request/{date}`), which §4's GET-only rule would forbid. Daily summaries are not affected. Treat the 6-month figure as unverified.)

### Do not build the spike's file import now

- The link backfills the band's roughly 63 nights through the API: about 200–270 calls, paced, taking 5–10 minutes.
- The file import only adds skin temperature and breathing variations, which exist only in FIT files.
- If those are wanted later, the same FIT parser can take the per-day zip **from the link** (`/download-service/files/wellness/{date}`), with the file picker as its manual door.

### If Q1 is "no" (no unofficial API)

- **Use intervals.icu (F) plus the bridge.**
- **Trade:** E, T, K. Your wellness data sits on intervals.icu's servers in Germany and Finland (Google, Backblaze and Wasabi).
- **What you lose:** SpO2, respiration, Training Readiness, stress, and the HRV status label.
- **What you keep:** Garmin's official link, with your password only on Garmin's page.

### If you want ARC itself never to call Garmin, but accept U

- **Use the computer job (I).**
- **What it wins:** a fix is `pip install -U` on the computer, not an EAS build, and ARC's own network traffic stays AI-only.
- **What it costs:**
  - a computer that is on every morning (a desktop PC left on is best);
  - the iCloud leg;
  - one-time key pairing;
  - more parts that can fail silently. That is why ARC must show a "last file" staleness line.

**Why H beats I for "minimal involvement":** H has fewer moving parts, works away from home, and has no computer to keep awake. I wins only on how fast a fix arrives.

---

## 4. What ARC would build

### Stage 0 (bridge): nothing required

- **Optional, in any later build:**
  - Add the bridge to `src/lib/health/coverage.ts`.
  - Tag the bridge's `hrv` rows `method: 'rmssd'` by its bundle id, which has to be read from a real sample.
  - **Keep it `other`** (see Stage 2).
- **Catch:** ARC reads HealthKit's SDNN type. If the bridge writes iOS 27's new RMSSD type instead, ARC will not see the data until a build adds that read scope (react-native-healthkit 16.x plus the iOS 27 SDK). The morning test answers this.
- **Migration:** none.

### Stage 1: the in-app Garmin link (H)

**Native:**
- `react-native-webview` 13.16.1, the version Expo SDK 57 bundles. It is not in ARC's `package.json` today, so adding it is what forces the EAS build.

**Screens:**
- `app/garmin-connect.tsx`: a WebView on Garmin's mobile sign-in page (`service=https://mobile.integration.garmin.com/gcm/ios`).
  - It runs `incognito`, so no Garmin cookie is kept.
  - Nothing is injected into Garmin's page.
  - `onShouldStartLoadWithRequest` catches `?ticket=ST-…` and blocks that load.
  - (checked 2026-09-25: these two lines rest on the ticket arriving as a navigation, and no source shows that for this page. `onShouldStartLoadWithRequest` sees navigations only, not `fetch`/XHR replies. The sources that work read it from the page instead:
    - pirate-garmin (Playwright, the mobile sign-in page, April 2026) installs an init script that wraps `fetch` and `XMLHttpRequest` and reads `serviceTicketId` from the `/mobile/api/login` reply;
    - peloton-to-garmin #837 (April 2026) reads the same reply in DevTools;
    - garmin-health-data (September 2026) reads `ST-…` from the HTML of the legacy `/sso/signin` "Success" page.
    - Only garmin-browser-login takes it from a URL, on the old embed-widget page.

    **Amended design:** keep the navigation catch. If the spike shows no navigation, use `injectedJavaScriptBeforeContentLoaded` to install a hook that forwards only the `/mobile/api/login` reply, and only its `serviceTicketId`, over `postMessage`. Pin that script in a test so it cannot touch the request body or any form field. "Nothing is injected" then no longer holds, and the ADR must say so. The ticket is single-use and expires within seconds to a minute, so exchange it at once.)
- **Settings › Garmin:**
  - "Connected as …, last fetched 07:12, 9 metrics";
  - Sync now;
  - Disconnect (deletes the Keychain item);
  - a Reconnect sheet.
- **Data › Wearables:** a staleness line ("Garmin link failing since …") and the new tiles you choose in Q3.
- **Home:** unchanged.

**Storage:**
- **Tokens:** kept in the Keychain as `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, the same treatment as the AI key in `src/lib/ai/api-key-store.ts`. They never enter SQLite, a backup, or the Coach's context. The refresh token changes each time it is used, so:
  - write the new one to the Keychain **before** using the new access token;
  - run only one refresh at a time.
- **Rows:**
  - Stored in `wearable_data` with `source_device 'garmin'` (already allowed by migration 0021's CHECK).
  - `source_raw_id 'gc:<metric>:<calendarDate>'`. Garmin returns `calendarDate`, so there is no timezone guessing.
  - Metadata such as `{via:'garmin_connect', method:'rmssd', status, baseline}`. (checked 2026-09-25: metadata stays out of the Coach's reach, as §2 explains. Store status and baseline as their own `metric_type`s as well if the Coach is to use them.)
  - **Write only the metrics HealthKit never supplies.** Sleep, steps and HR stay on the `hk:` rows, which avoids same-day `garmin` ties. (checked 2026-09-25: **resting HR falls in the grey zone.** Garmin Connect reportedly writes RestingHeartRate to Apple Health. `sourceDeviceFor` in `src/lib/health/mapping.ts` files any `com.garmin.connect` sample as `garmin`, so a link-written `rhr` would tie with it on the same day. The link must skip `rhr` until the Health app's Connect toggles show whether Garmin writes it.)
  - §16's re-window prune removes only `hk:*` rows, so these rows survive it.
- **Sync cursor:** key `garmin_connect` in the existing `health_sync_state` table (0021's free-JSON key-value table).
- **Backup:** the rows ride the ARCB1 encrypted backup; the tokens do not. After a restore to a new phone, you reconnect once.

**Network traffic:**
- `sso.garmin.com`, at sign-in only, inside the WebView.
- After that, only `diauth.garmin.com` and `connectapi.garmin.com`: hosts are pinned and requests are GET only. The token *could* write, so read-only is enforced by the code.
- **When it runs:** on app open, at most every few hours, plus Sync now.
- **Volume:** about 6 calls a day plus 1 per workout. Each sync re-fetches the last 2–3 days, because Garmin revises last night after a late upload.
- **Errors:** on a 401, refresh once and retry. On a 429, stop for the day.
- **First run:** a paced backfill that can resume across app opens.

**Coach:**
- It reads the rows like any other `metric_type`.
- **It gets no tool** to fetch data or touch the tokens. The sync stays deterministic.

**Fallbacks:**
- stale cells that show their date;
- the bridge's `hrv` (`other`);
- typed `hrv`;
- a backfill after the fix.

**Docs:**
- An ADR in `docs/decisions.md` recording that this route adds egress beyond the AI call.
- Updates to CLAUDE.md §3 and §8 and to `docs/wearables-subapp.md`.

**Migration:** **none** for daily metrics, because `metric_type` is free text and `garmin` is already allowed. Minute-level series would need a new table, which means a migration; its number is assigned at merge (the latest is 0063).

**Size:** a few focused days plus one EAS build (researcher's estimate).

### Alternative F: intervals.icu

- A Settings field for the API key and athlete id, stored in the Keychain.
- On app open: `GET https://intervals.icu/api/v1/athlete/{id}/wellness.json?oldest=…&newest=…` with Basic auth `API_KEY:<key>` (limit: 5,000 requests a day).
- Rows: `garmin` with `icu:<metric>:<date>` and `{via:'intervals.icu', method:'rmssd'}`, covering HRV, sleep score and Body Battery.
- **Network traffic:** intervals.icu only.
- No new native dependency, but it still ships in an EAS build.
- **Migration:** none.

### Alternative I: the computer job

- **On the computer:** a script using python-garminconnect 0.3.16 writes one `arc-garmin-day v1` JSON file per day in ARC's own format, not Garmin's raw JSON. It encrypts the file with XChaCha20-Poly1305 using a key paired once from ARC, and saves it to a chosen iCloud Drive folder. It runs hourly from 05:00 to 12:00, and each run overwrites that day's file.
- **In ARC:**
  - a pairing screen (the key is shown once, like the backup recovery code);
  - **new Swift** to remember the picked folder, because `expo-file-system` 57.0.2 has no bookmark code (in `modules/arc-backup` or a new module);
  - an importer that runs when the app becomes active. It reads through `NSFileCoordinator`, decrypts with `@noble/ciphers` (already a dependency), strictly checks the schema version, writes `garmin` rows as `gcx:<metric>:<date>`, and deletes each processed file;
  - a staleness line.
- **ARC's network traffic:** nothing new.
- **Migration:** none.

---

## 5. The unofficial route's risk, concretely

- **Garmin's Terms of Use** ([effective 2026-04-01](https://www.garmin.com/en-US/legal/terms-of-use/)):
  - They forbid accessing or scraping content by any means Garmin did not deliberately provide. **Route H breaks this.**
  - They forbid disguising where a message comes from by manipulating identifiers. **H arguably breaks this,** because it presents Garmin's own app client ID (`GARMIN_CONNECT_MOBILE_*_DI`). (checked 2026-09-25: the clause, read today, is "Forging headers or otherwise manipulating identifiers to disguise the origin of any message". The reference client, python-garminconnect, does more than borrow a client ID. It sends the Garmin Android app's `User-Agent` and `X-Garmin-*` headers on every call. If H copies those headers, it breaks this clause on its plain wording, not "arguably".)
  - They forbid sharing credentials with third parties. **H does not break this,** because you type into Garmin's page. D and HRV Sync do break it.
  - The stated penalty is suspension or termination of the account, including any paid subscriptions.
- **Enforcement seen:** no personal-use suspension was found. The worst reported outcome is a 48–72 h sign-in block after repeated *scripted* logins, during which Garmin's own app kept working ([Garmin Forums, about April 2026](https://forums.garmin.com/developer/fit-sdk/f/discussion/435087/persistent-429-on-api-login-account-blocked-for-48-hours)). (checked 2026-09-25: still no suspension found. Two facts belong beside it:
  - **Garmin's stated position.** On 2026-03-24 a developer in [garth #217](https://github.com/matin/garth/issues/217) posted Garmin support's reply to him: its terms "prohibit using an unauthorized third-party service to retrieve data from Garmin Connect".
  - **Garmin blocks on purpose.** python-garminconnect's maintainer wrote in the same thread in March 2026 that Garmin was "actively trying to block all python scripts", through Cloudflare. So far Garmin has blocked the tools, not punished the accounts.)
- **Breaks from 2024 to 2026** that would hit a design where a person signs in on Garmin's page:

| Opened | What broke | Hits H? | Time to a fix |
|---|---|---|---|
| 2024-11-25 | The profile endpoint changed ([garth #73](https://github.com/matin/garth/issues/73)) | Yes | About 6 days |
| 2026-03-15 | The old OAuth1 path died ([garth #199](https://github.com/matin/garth/issues/199), [#217](https://github.com/matin/garth/issues/217)) | Partly. The DI path H uses *was* the fix | About 3.5 weeks (checked 2026-09-25: #199 was opened 2026-03-17 for a change "~March 15-17". python-garminconnect 0.3.0, the DI rewrite, shipped 2026-04-02, about 2.5 weeks later. 0.3.2, with the multi-strategy login, shipped 2026-04-11, about 3.5 weeks later. #217, the Cloudflare 429s, is still open) |
| 2026-06-01 | Tokens minted through the widget became "not active" ([#369](https://github.com/cyberjunky/python-garminconnect/issues/369)) | Yes (checked 2026-09-25: **unclear.** The reporter's diagnosis on 2026-06-02 was that widget-minted tokens were refused while a portal-minted DI token worked. H's sign-in is a browser login, closer to the portal path than to the widget. The 1–3 a year estimate is not changed) | 3 days (checked 2026-09-25: 0.3.5, "fixes #369", shipped 2026-06-04. One user still failed on 06-10, and 0.3.6 followed on 06-14. The issue closed on 07-09 with no confirmation) |

  Breaks that would *not* hit H are the scripted-login 429s ([#213](https://github.com/cyberjunky/python-garminconnect/issues/213)), the widget 401 ([#278](https://github.com/cyberjunky/python-garminconnect/issues/278)), the MFA-with-OAuth1 break ([#312](https://github.com/cyberjunky/python-garminconnect/issues/312)) and the widget email-code break ([#386](https://github.com/cyberjunky/python-garminconnect/issues/386)).
- **What a break looks like for you:**
  - Garmin cells show their last value and its date, and Settings says the link is failing.
  - Recovery keeps grading from the bridge's HRV or your typed HRV.
  - Once a fix ships in an EAS build, the gap fills itself.
- **Sign-in:** tokens renew themselves as long as ARC fetches at least once every 30 days (reported lifetimes are about 18–27 h for the access token and 30 days, rotating, for the refresh token). Otherwise you see one Reconnect sheet, about a minute with 2FA. ARC never stores your password and never signs in on its own. (checked 2026-09-25:
  - **Rotation is confirmed.** A September 2026 fix in personal-training-mcp PR #1 says Garmin "issues a new refresh token on every refresh and invalidates the previous one". §4's write-before-use rule is right.
  - **The access token's lifetime** is reported as ~18 h (garmin-health-data), ~24 h (peloton-to-garmin #837) and ~30 h (one observed `exp`). The range is about 18–30 h.
  - **Whether the 30 days slide is not settled.** python-garminconnect 0.3.0's notes say sessions "persist indefinitely", and garmin-health-data's README says "valid indefinitely" if used within 30 days. But the same README also calls the login "roughly a monthly step", and peloton-to-garmin #837 says `refresh_token_expires_in` is ~30 d, to be repeated when it expires. Budget for a monthly Reconnect until a month of real use shows otherwise.)

---

## 6. Questions for you

**Q1. Will you accept Garmin's unofficial API to get everything (Body Battery, Training Readiness, SpO2, respiration, stress, HRV status)?**
- **The trade:** Garmin's terms (the stated penalty is suspension; no case found), ARC calling Garmin, a Garmin token in the Keychain, and 1–3 breaks a year that each need an EAS build.
- **Recommended: yes,** through the in-app link, where you sign in on Garmin's page, and **only after the full export has arrived** so you hold your own copy.
- If the answer is no, use intervals.icu: official, fewer metrics, and your data on its servers.

**Q2. Will you let a bridge's server relay your Garmin data (Health Sync) for automatic HRV now and a fallback later?**
- **Recommended: yes, if tomorrow's test shows HRV arriving in ARC.** If it does not, keep typing `hrv` until Stage 1.
- Skip Vitals Sync: your password in a stranger's app, for data Stage 1 brings anyway.
- Once the link has been stable for a few months, you can delete the bridge and drop the T trade.

**Q3. Where should the Garmin-only numbers appear?**
- **Recommended:**
  - **Home unchanged.** Recovery stays ARC's own calculation from HRV and resting HR.
  - **Data › Wearables gets tiles** for sleep score, Body Battery, Training Readiness and stress.
  - **The Coach reads all of them,** treating Garmin's Training Readiness as a second opinion, not the verdict.

**Q4. Daily figures only, or also the minute-level series (HR every 15 s, stress every 3 min, SpO2 every minute)?**
- **Recommended: daily figures only for now.** The series need a new table (a migration), and nothing in ARC reads them yet. Garmin keeps the detail readily available for about 6 months, so this can be added later without losing anything recent. (checked 2026-09-25: the 6-month figure has no source. See Stage 2. The recommendation hardly depends on it: the full export requested in Stage 0 contains the band's original uploaded FIT files, which should carry the detail. That is unverified until one export is opened, so it is item 12 below.)

---

## 7. Unverified

1. **Whether any partner or bridge carries the CIRQA's HRV at all.** The band is two months old and no report mentions it. The Stage 0 test settles this for Health Sync.
2. **Health Sync:**
   - Its Garmin HRV, resting HR and VO2 max. The spike and a search snippet claimed them, but the current App Store page and site FAQ do not show them (checked 2026-09-25). The page confirms only "steps, sleep, heart rate etc.".
   - Which HealthKit HRV type it writes.
   - Its bundle id.
   - Whether it has per-type toggles.
   - Whether its relay really stores nothing.
3. **Vitals Sync:** which HRV type it writes, whether it syncs in the background, and its release year. The store page shows v1.4 dated "Sep 4"; the researcher read 2026.
4. **H's sign-in:**
   - that Garmin's sign-in and 2FA complete in `react-native-webview` on iOS 27;
   - that the ticket arrives as a navigation ARC can catch; (checked 2026-09-25: no source shows this for the mobile sign-in page. The known captures read the `/mobile/api/login` JSON reply, which needs an injected hook. See §4)
   - that `diauth` accepts `GARMIN_CONNECT_MOBILE_IOS_DI` from iOS networking; (checked 2026-09-25: python-garminconnect tries `GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2`, `…_2024Q4` and `…_ANDROID_DI` first, and `…_IOS_DI` **last**. The iOS ID is its least-used fallback, so the spike should try the same order)
   - whether `connectapi` needs Garmin-app headers. (checked 2026-09-25: the reference client always sends Android-app headers: `User-Agent: GCM-Android-5.23`, `X-Garmin-User-Agent`, `X-Garmin-Client-Platform: Android` and `X-App-Ver`. Whether they are *required* is still unknown. Sending them is what hits the "forging headers" clause in §5)
5. **Token lifetimes** (community observations only). Also unknown: whether a password change revokes them, whether there is an absolute cap, whether Garmin's account page can revoke them, and whether client IDs rotate "each quarter".
6. **Enforcement:** "no suspension found" means none turned up in the searches, not that none exists.
7. **The 1–3 breaks a year** is an estimate drawn from the table in §5, not a measurement.
8. **What the CIRQA actually fills:** VO2 max (walk or run, per the manual; running only, per the5krunner), Training Readiness, skin temperature, and whether any JSON endpoint serves skin temperature.
9. **Whether Garmin Connect on iOS syncs the band in the background.** This sets the delay for every cloud route, and the sources conflict:
   - the5krunner (2026-02-02) says yes;
   - Fitrockr says no;
   - Garmin says its Apple Health export needs Connect open in the foreground.
10. **intervals.icu:**
    - the exact list of Garmin fields;
    - SpO2 and respiration, where the sources conflict;
    - the name of the Body Battery field;
    - whether an API call counts as a visit for the 90-day dormancy rule;
    - whether its terms allow feeding its data to ARC's AI Coach (not checked for intervals.icu, Tredict or Runalyze). (checked 2026-09-25, intervals.icu only: its draft API terms of October 2025 contain no AI restriction and allow "any lawful purpose". They require Garmin attribution for Garmin-sourced activity data. Its privacy policy of 2025-12-11 does not mention AI. Whether the terms are final is unverified, and Tredict and Runalyze remain unchecked.)
11. **Other partners:** Tredict's and Runalyze's current tiers, FitnessSyncer's Garmin HRV and where it hosts data, and whether Fitrockr takes individuals.
12. **The full export's contents:** SpO2, respiration, skin temperature and Training Readiness. Two 2026 guides disagree; one real export settles it.
13. **The per-day zip:** whether `/download-service/files/wellness/{date}` returns the same file as the website's per-day export.
14. **USB (J):** which files the band keeps and for how long. Also, per the manual, a Mac needs Garmin Express to see the band.
15. **Resting HR in Apple Health:** users report it, but it is not on Garmin's list.
16. **Garmin's API pause:** the overview page has no application form and says "Stay tuned" (checked 2026-09-25). The reason and timeline come from the5krunner only.
17. **The Garmin backfill-limits post** (2 years for health data, 5 for activities) was read only through a search snippet, because the page returned 403. (checked 2026-09-25: independently corroborated. Health Sync's App Store description says "With Garmin Connect you can sync the last five years of activity data, and the last two years of other data.")
18. **For H:** whether WebKit's cookie store would ride the iCloud backup (moot if `incognito`), and whether iOS Password AutoFill works inside the WebView.
19. **For I:** whether iCloud for Windows shows an app's own iCloud container, and how long an iCloud download takes when ARC opens.
20. **Shortcuts:** that Garmin Connect has no Shortcuts actions. You can check on the phone under Shortcuts → Apps.
21. **Added by the check (2026-09-25):**
    - Garmin's "cold storage after about 6 months" figure has no source (Stage 2, Q4).
    - Whether Garmin's mobile sign-in page ever navigates to `service?ticket=ST-…` in a WebView, or only returns the ticket in a JSON reply (§4).
    - Whether the refresh token's ~30-day window slides with each rotation or is an absolute cap (§5).
    - Whether Garmin Connect writes resting HR to Apple Health (it decides whether the link may write `rhr`; §4).

---

## Sources

**Garmin**
- [Connect Developer Program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/) (business use only) · [Overview](https://developer.garmin.com/gc-developer-program/overview/) ("Stay tuned", no form, re-checked 2026-09-25) · [Health API](https://developer.garmin.com/gc-developer-program/health-api/) · [Backfill limits blog](https://developerportal.garmin.com/blog/new-backfill-history-limits-user) (403; snippet only)
- [Terms of Use, effective 2026-04-01](https://www.garmin.com/en-US/legal/terms-of-use/) · [Forum: login blocked 48 h, about April 2026](https://forums.garmin.com/developer/fit-sdk/f/discussion/435087/persistent-429-on-api-login-account-blocked-for-48-hours) · [Forum: backfill 202, no push](https://forums.garmin.com/developer/connect-iq/f/showcase/431810/backfill-returns-202-but-push-notifications-never-arrive-at-webhook)
- [Sharing Connect data with Apple Health](https://support.garmin.com/en-US/?faq=lK5FPB9iPF5PXFkIpFlFPA) · [Export FAQ](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8) · [CIRQA battery FAQ](https://support.garmin.com/en-US/?faq=ZAioPBMuw33rlJL9L2GbT6)
- [CIRQA Owner's Manual (PDF), July 2026](https://www8.garmin.com/manuals/webhelp/GUID-D3BE589F-1A6C-4B6F-9ABC-07DB9AA6C739/EN-US/CIRQA_Smart_Band_OM_EN-US.pdf) · [Manual: connecting to a computer](https://www8.garmin.com/manuals/webhelp/GUID-D3BE589F-1A6C-4B6F-9ABC-07DB9AA6C739/EN-US/GUID-B93AD969-0B11-4B7E-BFC3-3E1A884991C3.html)
- [Forum: HRV in the data export, about Oct 2025](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-web/423807/hrv-in-garmin-data-export) · [Forum: Shortcuts request](https://forums.garmin.com/sports-fitness/healthandwellness/f/vivosmart-5/432796/allow-ios-shortcuts-to-control-the-garmin-connect-app) · [Forum: Express keeps no local FIT](https://forums.garmin.com/apps-software/mac-windows-software/f/garmin-express-windows/85929/express---uploaded-synched-fit-files-not-available-as-local-backup)
- [`@garmin/fitsdk` 21.217.0 profile.js](https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.217.0/src/profile.js)

**Press and reviews**
- DC Rainmaker: [CIRQA hands-on, 2026-07-21](https://www.dcrainmaker.com/2026/07/garmin-cirqa-everything-you-need-to-know.html) · [one month later, 2026-08-23](https://www.dcrainmaker.com/2026/08/garmin-cirqa-in-depth-review-one-month-later-expectations-reality.html)
- the5krunner: [developer API paused, 2026-09-14](https://the5krunner.com/2026/09/14/garmin-developer-api-access-paused/) · [iOS background sync, 2026-02-02](https://the5krunner.com/2026/02/02/garmin-ios-background-sync/) · [CIRQA specs](https://the5krunner.com/specs/garmin/cirqa/) · [CIRQA review, 2026-08-19](https://the5krunner.com/2026/08/19/garmin-cirqa-band-review/) · [App Intents](https://the5krunner.com/2025/08/11/apple-intents-is-garmin-connect-the-first-sports-app-to-work-with-the-new-siri/)
- [ghurt: Garmin API for personal use, 2026-07-15](https://ghurt.org/garmin-api-for-personal-use) · [ghurt](https://ghurt.org/) · [Gneta, Aug 2026](https://www.gneta.app/blog/connect-garmin-to-chatgpt-claude) · [WeGuide, 2026-07-22](https://www.weguide.health/blog/garmin-cirqa-clinical-research) · [AIFitnessAPI, 2026-07-09](https://aifitnessapi.com/fix/garmin-api-approval)

**Garmin API structure (third-party write-ups)**
- Open Wearables: [developer guide, 2026-05-06](https://openwearables.io/blog/garmin-connect-api-developer-guide-activities-health-metrics) · [push and callback](https://openwearables.io/blog/garmin-api-push-notifications-how-callback-sync-works) · [Garmin integration](https://openwearables.io/integrations/garmin)
- [OAuth2 migration issue](https://github.com/stoufa06/php-garmin-connect-api/issues/23)
- Sahha: [AI restrictions](https://sahha.ai/blog/health-api-ai-restrictions/) · [Garmin](https://sahha.ai/integrations/garmin/) · [Terra alternatives, July 2026](https://sahha.ai/compare/terra-alternatives/)
- [Junction pricing](https://www.junction.com/pricing) · [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- MyDataHelps formats: [HRV](https://support.mydatahelps.org/garmin-heart-rate-variability-summary-export-format) · [overview](https://support.mydatahelps.org/garmin-export-overview) · [daily](https://support.mydatahelps.org/garmin-daily-summary-export-format) · [sleep](https://support.mydatahelps.org/garmin-sleep-summary-export-format) · [stress](https://support.mydatahelps.org/garmin-stress-detail-summary-export-format) · [pulse ox](https://support.mydatahelps.org/garmin-pulse-ox-summary-export-format) · [respiration](https://support.mydatahelps.org/garmin-respiration-summary-export-format) · [skin temp](https://support.mydatahelps.org/garmin-skin-temp-summary-export-format) · [user metrics](https://support.mydatahelps.org/garmin-user-metrics-summary-export-format)

**Partners**
- intervals.icu:
  - [pricing](https://www.intervals.icu/pricing/) · [privacy policy, 2025-12-11](https://intervals.icu/privacy-policy.html) · [Open API](https://www.intervals.icu/features/open-api/)
  - Forum: [API access](https://forum.intervals.icu/t/api-access-to-intervals-icu/609) · [sleep sub-metrics missing, June 2026](https://forum.intervals.icu/t/garmin-sleep-sub-metrics-not-syncing-avg-sleeping-hr-spo2-respiration-readiness-missing/130360) · [respiration, 2026-06-12](https://forum.intervals.icu/t/respiratory-rate-from-garmin-health-snapshot-avg-during-sleep/119477) · [Training Readiness](https://forum.intervals.icu/t/garmin-training-readiness/14534?page=2) · [dormancy](https://forum.intervals.icu/t/solved-suspended-account-no-activity-processed-ans-acc-set-dormant-if-90days-not-visit-intervals-icu-is-not-supporter/112826) · [wellness fields, 2024](https://forum.intervals.icu/t/fill-in-more-wellness-data-read-from-garmin/56055) · [Body Battery](https://forum.intervals.icu/t/garmin-body-battery/19126) · [VO2 max from FIT](https://forum.intervals.icu/t/garmin-vo2-max-from-fit-file/24268) · [API terms draft](https://forum.intervals.icu/t/intervals-icu-api-terms-and-conditions-draft/114087) · [history limits](https://forum.intervals.icu/t/not-getting-historical-data-from-garmin-connect/24412)
  - Third-party guides: [STAS guide](https://stas.run/en/guides/intervals-icu-garmin-sync) · [fz-performance PR #63, 2026-09-18](https://github.com/franna700-creator/fz-performance/pull/63)
- Tredict: [Garmin FAQ](https://www.tredict.com/faq/garmin-connect---how-to-connect-and-synchronize-my-device/) · [API docs, 2026-01-29](https://www.tredict.com/blog/oauth_docs/) · [price](https://www.tredict.com/price/)
- Runalyze: [personal API](https://runalyze.com/help/article/personal-api) · [pricing](https://runalyze.com/pricing) · [import Garmin history, 2026-09-17](https://blog.runalyze.com/allgemein-en/import-your-garmin-history/)
- FitnessSyncer: [supported apps](https://www.fitnesssyncer.com/support/supported-apps-and-services) · [sync FAQ](https://www.fitnesssyncer.com/support/sync-faq) · [API docs](https://www.fitnesssyncer.com/api/documentation.html)
- Fitrockr: [HRV via Connect sync](https://www.fitrockr.com/help-center/hrv-via-garmin-connect-sync/) · [2026-09-18](https://www.fitrockr.com/fitrockr-offers-alternative-to-access-garmin-connect-developer-program-api/) · [pricing](https://www.fitrockr.com/pricing/)
- TrainingPeaks: [HRV blog](https://www.trainingpeaks.com/blog/how-to-track-your-heart-rate-variability-using-trainingpeaks/) · [API](https://help.trainingpeaks.com/hc/en-us/articles/234441128-TrainingPeaks-API)
- Strava: [appsforstrava, 2026](https://appsforstrava.com/blog/strava-developer-program-changes-2026)
- Display-only apps: [Bevel](https://help.bevel.health/en/articles/11680065) · [Athlytic, 2026-08-30](https://athlyticapp.helpscoutdocs.com/article/14--third-party-wearables)

**Bridge apps**
- Health Sync: [App Store](https://apps.apple.com/us/app/health-sync-by-appyhapps/id6480174471) (v8.5.11, re-checked 2026-09-25) · [privacy policy, 2026-06-14](https://healthsync.app/privacy-policy/)
- Vitals Sync: [App Store](https://apps.apple.com/us/app/vitals-sync/id6780623839) (re-checked 2026-09-25) · [privacy policy, 2026-06-15](https://garmin-health-sync.pages.dev/)
- HRV Sync: [App Store](https://apps.apple.com/us/app/hrv-sync/id6756378219) · [site](https://hrvsync.nglx.io/)
- The iOS 27 RMSSD type: [react-native-healthkit PR #388, 2026-09-17](https://github.com/kingstinct/react-native-healthkit/pull/388) · [NOOP #2264, 2026-09-16](https://github.com/ryanbr/noop/issues/2264)

**Unofficial clients**
- python-garminconnect:
  - [repo and README](https://github.com/cyberjunky/python-garminconnect) · [client.py](https://github.com/cyberjunky/python-garminconnect/blob/master/garminconnect/client.py) · [releases, 0.3.16 on 2026-09-18](https://github.com/cyberjunky/python-garminconnect/releases)
  - Issues: [#213](https://github.com/cyberjunky/python-garminconnect/issues/213) · [#278](https://github.com/cyberjunky/python-garminconnect/issues/278) · [#312](https://github.com/cyberjunky/python-garminconnect/issues/312) · [#332](https://github.com/cyberjunky/python-garminconnect/issues/332) · [#337](https://github.com/cyberjunky/python-garminconnect/issues/337) · [#348](https://github.com/cyberjunky/python-garminconnect/issues/348) · [#369](https://github.com/cyberjunky/python-garminconnect/issues/369) · [#386](https://github.com/cyberjunky/python-garminconnect/issues/386) · [#439](https://github.com/cyberjunky/python-garminconnect/issues/439)
  - PRs: [#402](https://github.com/cyberjunky/python-garminconnect/pull/402) · [#415](https://github.com/cyberjunky/python-garminconnect/pull/415)
- garth: [repo, deprecated](https://github.com/matin/garth) · [#73](https://github.com/matin/garth/issues/73) · [#199](https://github.com/matin/garth/issues/199) · [#217](https://github.com/matin/garth/issues/217)
- garmin-health-data: [repo](https://github.com/diegoscarabelli/garmin-health-data) · [auth.py, manual ticket, 2026-09-01](https://github.com/diegoscarabelli/garmin-health-data/blob/main/garmin_health_data/auth.py)
- Other clients:
  - [peloton-to-garmin #837, 2026-04-04](https://github.com/philosowaffle/peloton-to-garmin/issues/837) · [garmin-browser-login](https://github.com/sidequest-scribe/garmin-browser-login) · [garminconnect-js](https://github.com/DynamicsNinja/garminconnect-js) · [garmin-connect on npm](https://www.npmjs.com/package/garmin-connect)
  - GarminDB: [download.py](https://github.com/tcgoetz/GarminDB/blob/master/garmindb/download.py) · [releases](https://github.com/tcgoetz/GarminDB/releases)
  - garmin-grafana: [repo](https://github.com/arpanghosh8453/garmin-grafana) · [releases](https://github.com/arpanghosh8453/garmin-grafana/releases) · [jotterbach PR #4](https://github.com/jotterbach/garmin-grafana/pull/4)
  - garmin-givemydata: [repo](https://github.com/nrvim/garmin-givemydata) · [#86, 2026-09-14](https://github.com/nrvim/garmin-givemydata/issues/86)
  - [HA Garmin #599, 2026-09-24](https://github.com/cyberjunky/home-assistant-garmin_connect/issues/599) · [garmin-csv-parser](https://github.com/roelven/garmin-csv-parser) · [garmin-running-analytics](https://github.com/mgilangjanuar/garmin-running-analytics)

**Automation and transport (route I)**
- Apple:
  - [Providing access to directories](https://developer.apple.com/documentation/uikit/providing-access-to-directories) · [iCloud design guide](https://developer-rno.apple.com/library/archive/documentation/General/Conceptual/iCloudDesignGuide/Chapters/DesigningForDocumentsIniCloud.html)
  - [ADP requirements, 2026-04-17](https://support.apple.com/en-us/108756) · [ADP in the UK](https://support.apple.com/en-us/122234)
  - [launchd thread, Feb 2026](https://developer.apple.com/forums/thread/815034) · [Scheduling Timed Jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html) · [forum 685583](https://developer.apple.com/forums/thread/685583)
- macOS Tahoe Shortcuts: [MacStories](https://www.macstories.net/stories/macos-26-tahoe-the-macstories-review/4/) · [MacMost](https://macmost.com/an-introduction-to-shortcuts-automation-in-macos-tahoe.html)
- Windows: [Microsoft Q&A, Task Scheduler wake](https://learn.microsoft.com/en-us/answers/questions/4140865/task-scheduler-not-waking-home-use-windows-11-from)
- Expo: [EAS iOS capabilities](https://docs.expo.dev/build-reference/ios-capabilities/) · [etude#101, 2026-09-20](https://github.com/benstreich/etude/issues/101)
- Other transports: [Möbius Sync FAQ](https://mobiussync.com/faq/) · [AirDrop Shortcut](https://matthewcassinelli.com/shortcuts/share-with-airdrop/) · [Automators, locked-phone Shortcuts](https://talk.automators.fm/t/why-do-some-time-triggered-shortcuts-run-on-a-locked-iphone-and-others-fail/18608)
- Garmin exports: [takeoutday, 2026-09-03](https://takeoutday.org/guides/how-to-export-garmin-connect-data) · [DLEAPP PR #239](https://github.com/abrignoni/DLEAPP/pull/239)

**ARC code** (read only, `main` at `2270f01`)
- `src/lib/db/repositories/wearables.ts`: `SOURCE_PRIORITY`, and the tie behaviour in `dailyMetricSeries`
- `src/lib/health/mapping.ts`: `VENDOR_BUNDLES`
- `db/migrations/0021_*.sql`: the `source_device` CHECK and `health_sync_state`
- `src/lib/ai/api-key-store.ts`: `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
- `package.json`: no `react-native-webview`; `@noble/ciphers` and `expo-secure-store` are present
- `docs/spikes/garmin-hrv-routes.md`
- `CLAUDE.md` §2, §3 and §8

**Added by the check (2026-09-25)**
- ARC code, re-read at `main` `2270f01`, with nothing edited:
  - `SOURCE_PRIORITY` puts `garmin` above `other`. `dailyMetricSeries` and `latestMetric` keep the first row on a strict `<` tie.
  - `sourceDeviceFor` sends unknown bundles to `other`. `HK_BUCKET_GLOB = 'hk:*'` scopes the prune.
  - The 0021 CHECK includes `garmin`, and `health_sync_state` is a free-JSON key-value table.
  - `api-key-store.ts` uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
  - `use-wearables.ts` has tiles for `respiratory_rate`, `spo2_pct`, `wrist_temp_c` (°C) and `vo2max`.
  - `readiness.ts` sets `BASELINE_WINDOW_DAYS = 30` and `BASELINE_MIN_DAYS = 5`.
  - `read-tools.ts` discovers types with `inferred: true`, and `series.ts` returns `{date, value}` only.
  - `node_modules/expo/bundledNativeModules.json` pins `react-native-webview` 13.16.1. `expo-file-system` 57.0.2 has no bookmark code.
- Auth sources:
  - python-garminconnect `client.py` (master, read 2026-09-25): `DI_CLIENT_IDS` order, `_native_headers`, `_exchange_service_ticket` and `_refresh_di_token`. Its `__init__.py` holds `request_reload` ("Garmin offloads older data").
  - [pirate-garmin `browser_login.py`](https://github.com/jeffton/pirate-garmin), with its `fetch`/XHR hook on `/mobile/api/login`.
  - [peloton-to-garmin #837](https://github.com/philosowaffle/peloton-to-garmin/issues/837), 2026-04-04.
  - [garmin-health-data README](https://github.com/diegoscarabelli/garmin-health-data) and `auth.py`.
  - [garmin-browser-login](https://github.com/sidequest-scribe/garmin-browser-login).
  - [personal-training-mcp PR #1](https://github.com/SigurdBlakkestad/personal-training-mcp/pull/1), refresh-token rotation, September 2026.
- [garth #217 comments](https://github.com/matin/garth/issues/217): Garmin's reply of 2026-03-24, and the maintainer's remarks on deliberate blocking.
- GitHub API: the open and close dates of garth #73, #199 and #217 and python-garminconnect #213, #278, #312, #369 and #386. Release dates 0.3.0–0.3.16.
- Garmin Terms of Use, read in a browser: effective April 1, 2026. The scraping, "Forging headers", credential-sharing and suspension clauses are confirmed verbatim.
- Garmin developer overview ("Stay tuned for more updates on the program", no form) and FAQ ("only for business use").
- [the5krunner, 2026-09-14](https://the5krunner.com/2026/09/14/garmin-developer-api-access-paused/): the pause since "spring 2026". [the5krunner CIRQA battery, 2026-07-22](https://the5krunner.com/2026/07/22/garmin-cirqa-battery-life/): Pulse Ox off by default. CIRQA manual: the Pulse Oximeter path and its modes.
- intervals.icu: [the June 2026 forum thread](https://forum.intervals.icu/t/garmin-sleep-sub-metrics-not-syncing-avg-sleeping-hr-spo2-respiration-readiness-missing/130360), [pricing](https://www.intervals.icu/pricing/), [privacy](https://intervals.icu/privacy-policy.html), [dormancy](https://forum.intervals.icu/t/solved-suspended-account-no-activity-processed-ans-acc-set-dormant-if-90days-not-visit-intervals-icu-is-not-supporter/112826), [API access](https://forum.intervals.icu/t/api-access-to-intervals-icu/609) and [API terms draft](https://forum.intervals.icu/t/intervals-icu-api-terms-and-conditions-draft/114087).
- App Store pages re-read: Health Sync (8.5.11, $3.99, 111 ratings, no Garmin HRV named) and Vitals Sync (1.4 "Sep 4", 3 ratings, background sync claimed). Also [Health Sync privacy policy](https://healthsync.app/privacy-policy/).
- [MyDataHelps HRV summary format](https://support.mydatahelps.org/garmin-heart-rate-variability-summary-export-format). [Sahha Garmin](https://sahha.ai/integrations/garmin/): own Garmin keys required.
