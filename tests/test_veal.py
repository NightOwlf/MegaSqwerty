"""VE Analyze runs in the browser (app/static/veal.js); its tests are in tests/js and run under node."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="node isn't installed")
def test_ve_analyze():
    run = subprocess.run(["node", str(ROOT / "tests/js/veal.test.js")], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout + run.stderr
    assert "all VE Analyze tests passed" in run.stdout
