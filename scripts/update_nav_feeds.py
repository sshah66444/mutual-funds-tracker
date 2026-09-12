#!/usr/bin/env python3
"""Update the two PSX Live fund NAVs from official sources.

The script intentionally updates only verified observations. A source failure,
weekend date, older publication, or implausible value makes the run fail before
any file is written.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from bs4 import BeautifulSoup
from curl_cffi import requests


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
FUNDS_PATH = DATA_DIR / "mufap_data.json"
ARCHIVE_PATH = DATA_DIR / "nav_archive.json"

ASSF = "Al Ameen Shariah Stock Fund"
ALHAMRA = "Alhamra Islamic Stock Fund"

UBL_URL = "https://www.ublfunds.com.pk/products-services/al-ameen-shariah-stock-fund/"
ALHAMRA_URL = "https://alhamra.mcbfunds.com/fund-prices-mob/"
MUFAP_URL = "https://mufap.com.pk/Industry/IndustryStatDaily?tab=3"


@dataclass(frozen=True)
class Observation:
    fund_name: str
    published: date
    nav: float
    source: str
    offer: float | None = None


def fetch(url: str) -> str:
    try:
        response = requests.get(
            url,
            impersonate="chrome",
            timeout=45,
            headers={"Accept-Language": "en-GB,en;q=0.9"},
        )
        response.raise_for_status()
        if len(response.content) < 5_000:
            raise RuntimeError(f"Unexpectedly short response from {url}")
        return response.text
    except Exception as http_error:
        print(f"HTTP client failed for {url}; trying verified browser TLS: {http_error}")
        try:
            return fetch_browser(url)
        except Exception as browser_error:
            raise RuntimeError(f"HTTP: {http_error}; browser: {browser_error}") from browser_error


def fetch_browser(url: str) -> str:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            # Never ignore certificate errors. Chromium can retrieve missing
            # certificate intermediates using its normal verified TLS stack.
            context = browser.new_context(locale="en-GB", ignore_https_errors=False)
            page = context.new_page()
            response = page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_function(
                "document.querySelector('.sell-price') || "
                "Array.from(document.querySelectorAll('table')).some(t => "
                "t.innerText.includes('Alhamra Islamic Stock Fund'))",
                timeout=30_000,
            )
            html = page.content()
            if len(html) < 5_000:
                raise RuntimeError("Browser returned an incomplete page")
            return html
        finally:
            browser.close()


def parse_date(value: str) -> date:
    cleaned = " ".join(value.replace(",", " ").split())
    for fmt in ("%d-%b-%Y", "%b %d %Y", "%Y-%m-%d", "%d %b %Y"):
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"Unrecognised NAV date: {value!r}")


def parse_assf(html: str) -> Observation:
    soup = BeautifulSoup(html, "html.parser")
    section = soup.select_one(".fund-sec1-2col-2")
    if not section:
        raise RuntimeError("ASSF price section was not found")
    selling = section.select_one(".sell-price")
    offer = section.select_one(".offer-price")
    date_row = section.select_one(".date")
    if not selling or not date_row:
        raise RuntimeError("ASSF NAV or publication date was not found")
    nav_match = re.search(r"([0-9][0-9,]*\.[0-9]+)", selling.get_text(" ", strip=True))
    date_match = re.search(r"(\d{1,2}-[A-Za-z]{3}-\d{4})", date_row.get_text(" ", strip=True))
    offer_match = re.search(r"([0-9][0-9,]*\.[0-9]+)", offer.get_text(" ", strip=True)) if offer else None
    if not nav_match or not date_match:
        raise RuntimeError("ASSF page format changed")
    return Observation(
        ASSF,
        parse_date(date_match.group(1)),
        float(nav_match.group(1).replace(",", "")),
        UBL_URL,
        float(offer_match.group(1).replace(",", "")) if offer_match else None,
    )


def table_rows(html: str) -> Iterable[list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    for row in soup.select("table tr"):
        cells = [" ".join(cell.get_text(" ", strip=True).split()) for cell in row.select("th,td")]
        if cells:
            yield cells


def parse_alhamra(html: str) -> Observation:
    for cells in table_rows(html):
        if len(cells) >= 3 and cells[0].casefold() == ALHAMRA.casefold():
            return Observation(ALHAMRA, parse_date(cells[1]), float(cells[2].replace(",", "")), ALHAMRA_URL)
    raise RuntimeError("Alhamra Islamic Stock Fund was not found on its official price page")


def parse_mufap(html: str, target: str) -> Observation:
    for cells in table_rows(html):
        if len(cells) >= 9 and cells[2].casefold() == target.casefold():
            return Observation(
                target,
                parse_date(cells[8]),
                float(cells[7].replace(",", "")),
                MUFAP_URL,
                float(cells[5].replace(",", "")) if cells[5] not in {"", "N/A", "-"} else None,
            )
    raise RuntimeError(f"{target} was not found in MUFAP NAV data")


def validate(obs: Observation, today: date) -> None:
    limits = {ASSF: (50.0, 2_000.0), ALHAMRA: (5.0, 200.0)}
    low, high = limits[obs.fund_name]
    if not low <= obs.nav <= high:
        raise ValueError(f"{obs.fund_name}: implausible NAV {obs.nav}")
    if obs.published.weekday() >= 5:
        raise ValueError(f"{obs.fund_name}: publication date {obs.published} is a weekend")
    if obs.published > today + timedelta(days=1):
        raise ValueError(f"{obs.fund_name}: publication date {obs.published} is in the future")
    if obs.published < today - timedelta(days=10):
        raise ValueError(f"{obs.fund_name}: source is stale at {obs.published}")


def newest_archive_date(entries: list[dict]) -> date | None:
    dates = []
    for entry in entries:
        try:
            dates.append(parse_date(str(entry.get("date", ""))))
        except ValueError:
            continue
    return max(dates) if dates else None


def update_files(observations: list[Observation], dry_run: bool) -> bool:
    funds = json.loads(FUNDS_PATH.read_text(encoding="utf-8"))
    archive = json.loads(ARCHIVE_PATH.read_text(encoding="utf-8"))
    new_funds = copy.deepcopy(funds)
    new_archive = copy.deepcopy(archive)
    by_name = {item.get("fund_name"): item for item in new_funds}
    changed = False

    for obs in observations:
        fund = by_name.get(obs.fund_name)
        if fund is None:
            raise RuntimeError(f"Existing fund record is missing: {obs.fund_name}")
        entries = new_archive.setdefault(obs.fund_name, [])
        latest_date = newest_archive_date(entries)
        existing_for_date = next((item for item in entries if item.get("date") == obs.published.isoformat()), None)

        if existing_for_date:
            existing_value = float(str(existing_for_date["nav"]).replace(",", ""))
            if abs(existing_value - obs.nav) > 0.0001:
                raise ValueError(
                    f"{obs.fund_name}: refusing to replace {obs.published} NAV "
                    f"{existing_value} with {obs.nav}"
                )
        elif latest_date is None or obs.published > latest_date:
            entries.append({"date": obs.published.isoformat(), "nav": f"{obs.nav:.4f}"})
            entries.sort(key=lambda item: item.get("date", ""))
            changed = True

        current_date = parse_date(fund["validity_date"])
        if obs.published > current_date:
            fund["validity_date"] = obs.published.strftime("%b %d, %Y")
            fund["nav"] = f"{obs.nav:.4f}"
            fund["repurchase"] = f"{obs.nav:.4f}"
            if obs.offer is not None:
                fund["offer"] = f"{obs.offer:.4f}"
            changed = True

        print(f"{obs.fund_name}: {obs.published} NAV {obs.nav:.4f} ({obs.source})")

    # Serialize first so malformed data can never partially replace one file.
    funds_text = json.dumps(new_funds, indent=2, ensure_ascii=False) + "\n"
    archive_text = json.dumps(new_archive, indent=2, ensure_ascii=False) + "\n"
    json.loads(funds_text)
    json.loads(archive_text)

    if changed and not dry_run:
        FUNDS_PATH.write_text(funds_text, encoding="utf-8")
        ARCHIVE_PATH.write_text(archive_text, encoding="utf-8")
    return changed


def collect(today: date) -> list[Observation]:
    observations = []
    mufap_html: str | None = None
    errors: list[str] = []

    try:
        observation = parse_assf(fetch(UBL_URL))
        validate(observation, today)
        observations.append(observation)
    except Exception as exc:
        errors.append(f"UBL: {exc}")

    try:
        observation = parse_alhamra(fetch(ALHAMRA_URL))
        validate(observation, today)
        observations.append(observation)
    except Exception as exc:
        errors.append(f"Alhamra: {exc}")

    missing = {ASSF, ALHAMRA} - {item.fund_name for item in observations}
    if missing:
        try:
            mufap_html = fetch(MUFAP_URL)
            for name in sorted(missing):
                observation = parse_mufap(mufap_html, name)
                validate(observation, today)
                observations.append(observation)
        except Exception as exc:
            errors.append(f"MUFAP fallback: {exc}")

    still_missing = {ASSF, ALHAMRA} - {item.fund_name for item in observations}
    if still_missing and not observations:
        raise RuntimeError(f"No verified NAV for {', '.join(sorted(still_missing))}. {'; '.join(errors)}")
    if still_missing:
        print(f"::warning::Retained previous NAV for {', '.join(sorted(still_missing))}; sources blocked. {'; '.join(errors)}")
    return observations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="validate without writing data files")
    args = parser.parse_args()

    try:
        pakistan_today = datetime.now(timezone(timedelta(hours=5))).date()
        observations = collect(pakistan_today)
        for observation in observations:
            validate(observation, pakistan_today)
        changed = update_files(observations, args.dry_run)
        print("Validated successfully; data changed." if changed else "Validated successfully; already current.")
        return 0
    except Exception as exc:
        print(f"NAV update failed safely: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
