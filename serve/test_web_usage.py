"""The usage page's pure date, chart and export behavior; no GPU required."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class UsagePage(unittest.TestCase):
    def test_dates_charts_and_csv(self):
        result = subprocess.run([shutil.which("node"), str(Path(__file__).with_suffix(".js"))],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
