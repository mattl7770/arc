#!/usr/bin/env python3
"""
CIRQA BLE probe — Step 1: passive scan + read-only GATT enumeration.

WHAT THIS IS
    A throwaway test harness for docs/spikes/garmin-direct-from-band.md. It answers
    one question: does the Garmin CIRQA advertise its own sync service to a non-Garmin
    client, and what does its Bluetooth attribute table look like? It is NOT part of
    the ARC app and never touches it or your iPhone.

SAFETY INVARIANT (enforced by omission — read the code, there are no writes)
    This script ONLY scans, connects, and lists the GATT table. It never writes a
    characteristic, never reads a characteristic *value*, never downloads or marks a
    file, never sets the clock, never sends a sign-in. It cannot change anything on
    the band. Disconnecting is the only side effect.

REQUIREMENTS
    Windows 10/11 (built-in BLE) or a USB BLE dongle.  Python 3.10+.
    pip install "bleak>=0.21"

RUN
    python scan.py                # scan for a device named "CIRQA…", then enumerate it
    python scan.py --no-connect   # advertisement scan only (does not connect at all)
    python scan.py --address <BLE-ADDRESS>   # skip the name match, use a known address
    python scan.py --name Forerunner         # match a different device name

NOTE: the band allows ONE BLE connection at a time. If it won't connect, it is
    probably still connected to your iPhone — turn the iPhone's Bluetooth OFF (or put
    the band in pairing mode: 3 taps or a 6-second button hold), run this, then turn
    the iPhone's Bluetooth back on afterwards. Your data is safe either way: the band
    keeps recording to its own memory, and Garmin Connect fills the gap on reconnect.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

try:
    from bleak import BleakClient, BleakScanner
except ModuleNotFoundError:
    sys.exit('bleak is not installed. Run:  pip install "bleak>=0.21"')

# Garmin's "Multi-Link" sync service and its characteristic-pair short ids
# (see docs/spikes/garmin-direct-from-band.md §4 and gadgetbridge.org garmin-protocol).
GARMIN_ML_SERVICE = "6a4e2800-667b-11e3-949a-0800200c9a66"
GARMIN_PAIR_IDS = ("2810", "2820", "2811", "2821", "2812", "2822",
                   "2813", "2823", "2814", "2824")
STANDARD_HR_SERVICE = "0000180d"  # Bluetooth SIG Heart Rate Service (broadcast mode)


async def find_device(name: str, address: str | None, timeout: float):
    """Return (BLEDevice, adv_service_uuids) for the target, or (None, []) if not seen."""
    print(f"Scanning {timeout:.0f}s for BLE devices…")
    try:
        found = await BleakScanner.discover(timeout=timeout, return_adv=True)
        items = list(found.values())  # {addr: (device, adv)}
    except TypeError:
        # Older bleak without return_adv: returns a bare list of BLEDevice.
        devices = await BleakScanner.discover(timeout=timeout)
        items = [(d, None) for d in devices]

    hits = []
    for device, adv in items:
        dev_name = (getattr(adv, "local_name", None) or device.name or "").strip()
        label = dev_name or "(no name)"
        adv_uuids = list(getattr(adv, "service_uuids", []) or [])
        garmin = any(GARMIN_ML_SERVICE in u.lower() for u in adv_uuids)
        flag = "  <-- advertises Garmin sync service" if garmin else ""
        print(f"  {device.address}  {label}{flag}")
        if address and device.address.lower() == address.lower():
            hits.append((device, adv_uuids))
        elif not address and name.lower() in label.lower():
            hits.append((device, adv_uuids))

    if not hits:
        return None, []
    if len(hits) > 1:
        print(f"\nMultiple matches for '{address or name}'. Re-run with --address <one above>.")
        return None, []
    return hits[0]


def _iter_services(client: BleakClient):
    services = client.services
    if not services:  # very old bleak needs an explicit fetch
        services = None
    return services


async def enumerate_gatt(device):
    print(f"\nConnecting to {device.address} …")
    async with BleakClient(device) as client:
        print("Connected. Reading the GATT table (metadata only, no value reads)…\n")

        services = _iter_services(client)
        if services is None:
            services = await client.get_services()  # deprecated but works on old bleak

        garmin_pairs = set()
        saw_garmin_service = False
        saw_standard_hr = False

        for service in services:
            uuid = service.uuid.lower()
            if GARMIN_ML_SERVICE in uuid:
                saw_garmin_service = True
            if uuid.startswith(STANDARD_HR_SERVICE):
                saw_standard_hr = True
            print(f"[service] {service.uuid}  {service.description or ''}")
            for char in service.characteristics:
                cu = char.uuid.lower()
                props = ",".join(char.properties)
                print(f"    ├─ char {char.uuid}  ({props})  {char.description or ''}")
                for pid in GARMIN_PAIR_IDS:
                    if pid in cu:
                        garmin_pairs.add(pid)

        print("\n" + "=" * 64)
        print("VERDICT")
        print("=" * 64)
        print(f"Garmin Multi-Link sync service present: {'YES' if saw_garmin_service else 'no'}")
        # pairs come as write/notify twos; count the write ids 281x we saw
        write_ids = sorted(p for p in garmin_pairs if p.startswith("281"))
        print(f"Sync characteristic pairs seen (281x): {len(write_ids)} "
              f"{write_ids if write_ids else ''}")
        print("  (2 pairs ~ a simple band like the vivosmart 5; 3+ ~ newer/watch-class)")
        print(f"Standard Heart Rate Service (0x180D) present: "
              f"{'YES — Broadcast HR is on' if saw_standard_hr else 'no (Broadcast HR likely off)'}")
        print("\nIf the Garmin sync service is present, the band talks to a non-Garmin")
        print("client and Step 2 (live telemetry via garmin-ble) is worth running.")


async def main() -> None:
    ap = argparse.ArgumentParser(description="Passive, read-only BLE probe for the Garmin CIRQA.")
    ap.add_argument("--name", default="CIRQA", help="substring of the device name to match")
    ap.add_argument("--address", default=None, help="known BLE address (skips name match)")
    ap.add_argument("--timeout", type=float, default=12.0, help="scan seconds")
    ap.add_argument("--no-connect", action="store_true",
                    help="advertisement scan only; never connect")
    args = ap.parse_args()

    device, adv_uuids = await find_device(args.name, args.address, args.timeout)
    if device is None:
        print(f"\nNo device matching '{args.address or args.name}' was found.")
        print("Is the band awake and NOT connected to your iPhone? (turn iPhone BT off,")
        print("or put the band in pairing mode) then re-run.")
        return

    print(f"\nTarget: {device.address}")
    if adv_uuids:
        print("Advertised service UUIDs:")
        for u in adv_uuids:
            mark = "  <-- Garmin sync service" if GARMIN_ML_SERVICE in u.lower() else ""
            print(f"  {u}{mark}")

    if args.no_connect:
        print("\n--no-connect set; stopping after the advertisement scan.")
        return

    try:
        await enumerate_gatt(device)
    except Exception as exc:  # noqa: BLE001 - a test tool; show the user everything
        print(f"\nCould not enumerate the GATT table: {exc!r}")
        print("Most common cause: the band is still bonded to the iPhone. Turn the")
        print("iPhone's Bluetooth off (or put the band in pairing mode) and re-run.")


if __name__ == "__main__":
    asyncio.run(main())
