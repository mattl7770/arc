# CIRQA BLE probe — a throwaway test harness

**This is not part of ARC.** It is a self-contained experiment that runs on the
**Windows PC**, talks to the Garmin CIRQA band directly over Bluetooth, and answers one
question before we commit to any real build:

> Does the band serve its recovery data — especially **HRV, Body Battery and stress** —
> to a **non-Garmin** BLE client? If it streams the *computed* metrics (Body Battery,
> stress) to us, they are computed **on the band**, and the direct-BLE route in
> `docs/spikes/garmin-direct-from-band.md` clears the bar over our HealthKit setup.

It exists because there is no Android phone here to run Gadgetbridge (which already
supports the CIRQA). This is the equivalent test, on hardware you already own.

---

## Why this shape (and not an ARC feature)

An in-app bridge would need an EAS build, a native BLE module, and would land on the
**iPhone whose TestFlight container is the only copy of your health data** — heavy, slow,
and not "easily revertible." This probe touches **none of that**:

- it runs on the **PC**, never on the iPhone;
- it changes **nothing** in the ARC codebase (it's an isolated folder);
- reverting it is one command (below), and there is nothing else to undo.

---

## Safety — what this probe will NEVER do

The whole point is to learn without risk. By construction:

- **`scan.py` only lists the Bluetooth attribute table.** No characteristic writes, no
  value reads, no file access. It literally cannot change the band.
- **Step 2 (`garmin-ble`) is live-telemetry only.** That project's file transfer is
  unbuilt ("planned for 0.6.0"), so it **cannot download or mark files** — which means it
  cannot trigger the *"band deletes a file after it's marked synced"* hazard described in
  the spike (§1). It reads current values and nothing more.
- Neither step sets the band's clock, completes setup, or sends any sign-in.

**One operational fact:** the band accepts **one BLE connection at a time**. While the PC
is connected, the iPhone can't be. So for the connect steps: **turn the iPhone's
Bluetooth off** (or put the band in pairing mode — 3 taps, or hold the button ~6 s), run
the probe, then turn the iPhone's Bluetooth back on. **No data is lost** — the band keeps
recording to its own memory and Garmin Connect backfills the gap on reconnect.

---

## Prerequisites

- Windows 10/11 with Bluetooth LE (most laptops; a desktop may need a ~$10 USB BLE dongle).
- **Python 3.10+ — not currently installed on this PC.** Get it from
  [python.org/downloads](https://www.python.org/downloads/) and **tick "Add python.exe to
  PATH"** in the installer. Verify with `python --version`. (Avoid the Microsoft Store
  stub — the plain python.org build is simplest here.)
- The band, awake, and **not** actively connected to the iPhone (see above).

```bash
cd experiments/garmin-cirqa-probe
python -m pip install -r requirements.txt
```

---

## Step 1 — passive scan + GATT enumeration (zero risk, ~1 min)

```bash
python scan.py
```

Read the **VERDICT** block it prints. What you're looking for:

- **"Garmin Multi-Link sync service present: YES"** — the band exposes its own sync
  service to us. This is the green light for Step 2.
- **"Sync characteristic pairs seen"** — 2 pairs means a simple band (like the vivosmart
  5); 3+ means watch-class framing. Either is fine; it tells us which protocol variant to
  expect.
- **"Standard Heart Rate Service (0x180D) present"** — only if Broadcast HR is on; not
  required for this test.

If it can't find or connect to the band, it prints the fix (iPhone Bluetooth off /
pairing mode). Advertisement-only, no connection at all:

```bash
python scan.py --no-connect
```

## Step 2 — live telemetry (the actual answer, ~10 min)

This uses **garmin-ble**, the maintained Python client that already speaks the protocol,
run from its own clone so you get its tested examples:

```bash
git clone https://github.com/gwerneckp/garmin-ble
cd garmin-ble
python -m pip install -e .
python examples/telemetry_basic.py     # or:  python -m examples.scan  to list devices first
```

Watch what streams in. The decisive observations:

| You see live values for… | It means |
|---|---|
| **Body Battery** and **Stress** | **On-device computation confirmed** — these are *derived* scores, so the band computes them itself. This is the answer we came for. |
| **HRV** (and Resting HR) | The exact signal our HealthKit path is missing. Clears the "beat HealthKit" bar on its own. |
| SpO2, Respiration, HR | Raw signals the band holds; nice-to-have confirmation. |

If Body Battery / stress / HRV appear here, the direct-BLE route is viable and the odds in
the spike (§2) resolve to the optimistic end. If **only** raw HR appears and the derived
scores never do, that's the WHOOP-style outcome — capture the output and we'll re-read the
recommendation.

> Note: garmin-ble reads **live/current** values (what the band holds right now). The
> **overnight** HRV summary and sleep files are a stored-file sync, which garmin-ble
> doesn't do yet; Step 2 proving on-device computation is enough to green-light the ARC
> build, and the stored-file read is then part of that build (with the §1 safety rules).

---

## What to send back

Paste the **VERDICT** block from Step 1 and the telemetry lines from Step 2 (or a
screenshot). That's everything needed to turn the ~90% estimate in the spike into a
yes/no and size the ARC build.

---

## Reverting (one command)

```bash
git rm -rf experiments/garmin-cirqa-probe
```

It never touched the ARC app or the iPhone, so there is nothing else to undo. To also
remove the Python packages: `python -m pip uninstall bleak garmin-ble`. If you'd rather
EAS never even uploads this folder, add `experiments/` to `.easignore` — but it's inert
either way (no `.py` is bundled by Metro or seen by tsc/eslint).
