> **BUILT 2026-10-21** on branch `claude/cos-garmin` — route P below. Spec: `docs/wearables-subapp.md`
> §26. ADR: `docs/decisions.md` "Garmin via the official Personal API". This file records the routes
> weighed and why one won; it supersedes the recommendations in `garmin-hrv-routes.md`,
> `garmin-all-data.md` and `garmin-risk.md`, which stay as the record of how the question looked
> before 2026-10-21.

# Garmin into ARC, directly: the routes, and the one taken

**Date:** 2026-10-21 · **Question (carried from 2026-09-23):** *"new method for HRV + other data
from garmin?"* The owner's HRV cell has been blank since the band arrived, because Garmin never
writes HRV to Apple Health.

## What changed on 2026-10-21

Garmin launched a **Personal API**. The account owner creates a key on Garmin Connect Web
(Settings › personalApiToken), chooses how long it lasts (30, 90 or 180 days, or a year), sees it
once, and can revoke it. The key is exchanged for a 24-hour bearer token
(`POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token`,
`Authorization: ApiKey <key>`; no refresh token), and the token reads the owner's data with
`GET`s on the same host. Garmin published an OpenAPI 3.0.1 spec and an Apache-2.0 Python reference
client (`github.com/garmin/connect-personal-api-python`), which re-mints the token when under an
hour remains. Rate limits are not documented.

The research pass quoted the key's terms second-hand: it *"may be used only by you in connection
with applications, services, or tools that you develop or operate for your own use"*, and may not
be shared with third parties.

## What it serves, against what ARC wanted

| Figure | Personal API | Endpoint |
|---|---|---|
| Overnight HRV, weekly average, status, balanced range | **Yes** | `/hrv-service/hrv/daily/{from}/{to}` |
| Sleep stages and sleep score | **Yes** | `/sleep-service/sleep/dailySleepSummariesByDate` (≤ 31 days) |
| SpO2 (average, lowest) and respiration, overnight | **Yes** | the same sleep record |
| Resting HR, stress, Body Battery high/low | **Yes** | `/usersummary-service/v2/dailysummaries` (≤ 1 year) |
| Body Battery at wake | **Yes**, derived | `/wellness-service/wellness/bodyBattery/reports/daily` (≤ 31 days) |
| VO₂max | **Yes**, per activity | `/activitylist-service/activities/search/activities` |
| Training Readiness, Training Status | No | — |
| Skin temperature, RR intervals | No | — |

That is roughly 80% of the "all data" list in `garmin-all-data.md` §2, and every figure that
changes what Home or the Coach can say except Training Readiness.

## The routes

| | Route | Data | Terms | Egress | Data at rest elsewhere | Breaks | Verdict |
|---|---|---|---|---|---|---|---|
| **P** | **Personal API, from the phone** | ~80% | **Within them**, as quoted | `personal.connectapi.garmin.com`, automatic, reads only | Nothing new (it is already in Garmin's cloud) | Whatever Garmin changes in an official API — expected rare | **Taken** |
| H | Unofficial Connect API, from the phone (`garmin-all-data.md`) | ~94% | Breaks the scraping clause; arguably the identifiers clause | `sso.garmin.com`, `connectapi.garmin.com` | Nothing new | 1–4 a year, each an EAS build | Now unnecessary for everything but Training Readiness |
| I | Unofficial API on a computer → encrypted file in iCloud | ~94% | As H | None from ARC | Ciphertext | As H, plus a computer that must be on | As H |
| F | intervals.icu, pulled by ARC | ~50% | Clean when written; now against Garmin's October 2026 restriction on partners sharing data onward (reported, not read) | `intervals.icu` | **The owner's wellness data on their servers** | Rare | Out |
| C | Health Sync → Apple Health | 25–50% | Official partner | None from ARC | Relayed through their server | 1–2 | No longer needed; Apple Health still feeds the `hk:` rows |
| B | Garmin export files imported by hand (`garmin-hrv-routes.md`) | ~75% history | Clean | None | Nothing new | 0 | Not needed day to day; still the owner's insurance |
| A | Typing HRV | HRV, RHR | Clean | None | Nothing | 0 | Retired by P |

## Why P

1. **It is the vendor's own door, for exactly this use.** A personal key, created by the owner, for
   a tool he operates for himself. No header copying, no client ID that is not ARC's, no sign-in
   ticket caught inside Garmin's login page.
2. **It changes nothing at rest.** The data is already in Garmin's cloud; ARC reads it into the
   on-device database and sends nothing back. The key sits in the Keychain and nowhere else.
3. **It covers what moves the needle.** HRV for Recovery, and the figures the Coach was missing.
4. **It needs no native code and no migration.** Plain `fetch`, `wearable_data` as it is, the
   Keychain module already in the binary. It still ships in the next EAS build, because ARC has no
   OTA.

## What P costs

- **A new automatic egress** — the first besides the model call. The ADR names it and CLAUDE.md §3
  lists it.
- **The key expires** (at most a year) and the owner makes a new one. Garmin emails before it does;
  ARC says so when Garmin refuses the key.
- **Training Readiness stays out of reach.** Accepted: Recovery is ARC's own derivation.
- **The terms are known second-hand.** The owner should save the text Garmin shows with the key.

## What would reopen this

- Garmin narrowing the Personal API's terms or endpoints, or adding rate limits ARC's 8 requests a
  pass would not fit.
- The owner deciding Training Readiness matters enough to revisit H, eyes open, for that one figure.
