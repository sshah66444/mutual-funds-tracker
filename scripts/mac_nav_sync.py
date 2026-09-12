#!/usr/bin/env python3
"""LaunchAgent entry point: verified data-only sync in Pakistan evening hours."""
import argparse
import fcntl
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".mac-sync"
DATA = ["data/mufap_data.json", "data/nav_archive.json"]


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="run now outside scheduled hours")
    args = parser.parse_args()
    now = datetime.now(ZoneInfo("Asia/Karachi"))
    if not args.force and (now.weekday() >= 5 or not 19 <= now.hour <= 23):
        return 0
    STATE.mkdir(exist_ok=True)
    with (STATE / "lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        slot = f"{now.date()}-{'early' if now.hour < 21 else 'late'}"
        marker = STATE / slot
        if marker.exists() and not args.force:
            return 0
        print(f"Starting verified NAV sync at {now.isoformat()}", flush=True)
        # Avoid overwriting unrelated local work or publishing code by accident.
        dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, text=True)
        if dirty.strip():
            raise RuntimeError("Tracked local changes exist; refusing unattended publication")
        run("git", "pull", "--ff-only", "origin", "main")
        run(sys.executable, "scripts/update_nav_feeds.py")
        changed = subprocess.run(["git", "diff", "--quiet", "--", *DATA], cwd=ROOT).returncode
        if changed == 1:
            run("git", "add", "--", *DATA)
            run("git", "-c", "user.name=PSX NAV Sync", "-c", "user.email=psx-nav-sync@localhost", "commit", "-m", "data: verified NAV sync from Mac")
        elif changed != 0:
            raise RuntimeError("Could not check data changes")
        # Also retries an earlier commit whose push was interrupted.
        run("git", "push", "origin", "main")
        funds = json.loads((ROOT / DATA[0]).read_text())
        target = {"Al Ameen Shariah Stock Fund", "Alhamra Islamic Stock Fund"}
        dates = [datetime.strptime(f["validity_date"], "%b %d, %Y").date() for f in funds if f.get("fund_name") in target]
        if len(dates) == 2 and all(d == now.date() for d in dates):
            marker.touch()
        else:
            print("Today's NAV is not yet published for both funds; later hourly checks will retry.", flush=True)
        print("Data-only sync finished. No APK rebuilt.", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Mac NAV sync failed safely: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
