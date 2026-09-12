import importlib.util
import sys
import unittest
from datetime import date
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "update_nav_feeds.py"
SPEC = importlib.util.spec_from_file_location("update_nav_feeds", SCRIPT)
UPDATER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = UPDATER
SPEC.loader.exec_module(UPDATER)


class NavUpdaterTests(unittest.TestCase):
    def test_parses_official_assf(self):
        html = """
        <div class="fund-sec1-2col-2">
          <div class="offer-price"><span>Offer Price</span>483.7300</div>
          <div class="sell-price"><span>Selling Price</span>470.2100</div>
          <div class="date"><span>As on:</span> 11-Sep-2026</div>
        </div>
        """
        result = UPDATER.parse_assf(html)
        self.assertEqual(result.published, date(2026, 9, 11))
        self.assertEqual(result.nav, 470.21)
        self.assertEqual(result.offer, 483.73)

    def test_parses_official_alhamra(self):
        html = """
        <table><tr><th>Fund Name</th><th>Date</th><th>NAV</th></tr>
        <tr><td>Alhamra Islamic Stock Fund</td><td>11-Sep-2026</td><td>29.41</td></tr></table>
        """
        result = UPDATER.parse_alhamra(html)
        self.assertEqual(result.published, date(2026, 9, 11))
        self.assertEqual(result.nav, 29.41)

    def test_rejects_weekend_publication(self):
        observation = UPDATER.Observation(UPDATER.ALHAMRA, date(2026, 9, 12), 29.41, "test")
        with self.assertRaisesRegex(ValueError, "weekend"):
            UPDATER.validate(observation, date(2026, 9, 12))


if __name__ == "__main__":
    unittest.main()
