"""Speeduino 2025-era tunes: every table gets its axes, never-configured tables are flagged."""
from fastapi.testclient import TestClient

from app.main import create_app
from app.parser import parse_msq
from app.render import build_grid
from app.tablemaps import all_tables, resolve_map, summary_fields
from app.views import tune_model


def const(name, rows, cols, vals, units=""):
    body = " ".join(f"{v:g}" for v in vals)
    return f'<constant cols="{cols}" digits="0" name="{name}" rows="{rows}" units="{units}">{body}</constant>'


def tune() -> bytes:
    parts = [
        const("veTable", 2, 2, [40, 50, 60, 70], "%"),
        const("rpmBins", 2, 1, [1000, 6000], "RPM"), const("fuelLoadBins", 2, 1, [30, 100], "kPa"),
        const("veTable2", 2, 2, [50, 60, 70, 80], "%"),
        const("fuelRPM2Bins", 2, 1, [1000, 2000], "RPM"), const("fuelLoad2Bins", 2, 1, [50, 150], "kPa"),
        # boost control as it looks when it has never been configured
        const("boostTable", 8, 8, [510] * 64, "kPa"),
        const("rpmBinsBoost", 8, 1, [25500] * 8, "RPM"), const("tpsBinsBoost", 8, 1, [127] * 8, "TPS"),
        const("vvtTable", 2, 2, [0, 0, 0, 0], "%"),
        const("rpmBinsVVT", 2, 1, [1000, 3000], "RPM"), const("loadBinsVVT", 2, 1, [0, 100], "% TPS"),
        '<constant name="algorithm">"MAP"</constant>', '<constant name="fuel2Algorithm">"MAP"</constant>',
        '<constant name="vvtLoadSource">"TPS"</constant>',
        '<constant digits="0" name="hardRevLim" units="rpm">7500</constant>',
    ]
    return ('<?xml version="1.0" encoding="ISO-8859-1"?><msq xmlns="http://www.msefi.com/:msq">'
            '<versionInfo signature="speeduino 202501"/><page number="0">' + "".join(parts) + "</page></msq>").encode()


def test_tables_get_their_axes_and_load():
    doc = parse_msq(tune())
    tmap = resolve_map(doc)
    assert tmap["family"] == "Speeduino"
    featured, other = all_tables(doc, tmap)
    views = {v.z.name: v for v in featured + other}
    ve2, boost, vvt = views["veTable2"], views["boostTable"], views["vvtTable"]
    assert (ve2.x.name, ve2.y.name, ve2.load.measure) == ("fuelRPM2Bins", "fuelLoad2Bins", "MAP")
    assert (boost.x.name, boost.y.name, boost.x_label, boost.y_label, boost.y_units) == (
        "rpmBinsBoost", "tpsBinsBoost", "RPM", "TPS", "%")
    assert vvt.load.measure == "TPS" and (vvt.y_label, vvt.y_units) == ("Load", "% TPS")
    assert ("Rev limit", 7500.0) in [(label, c.value) for label, c in summary_fields(doc, tmap)]


def test_never_configured_tables_are_flagged_and_not_main():
    doc = parse_msq(tune())
    tmap = resolve_map(doc)
    featured, other = all_tables(doc, tmap)
    assert [v.z.name for v in featured] == ["veTable", "veTable2"]
    cards = {c.name: c for c in tune_model("abcdefghij", doc, tmap).tables}
    assert cards["boostTable"].setup and not cards["veTable"].setup and not cards["vvtTable"].setup
    boost = next(v for v in other if v.z.name == "boostTable")
    g = build_grid(boost.id, boost.label, boost.z, boost.x, boost.y, x_label=boost.x_label, y_label=boost.y_label)
    assert g.setup_note.startswith(
        "Not set up yet: every RPM bin is 25500, every TPS bin is 127 and every cell is 510.")


def test_pages(tmp_path):
    with TestClient(create_app(tmp_path), follow_redirects=False) as c:
        slug = c.post("/upload", files={"file": ("t.msq", tune())}).headers["location"].rsplit("/", 1)[1]
        home = c.get(f"/t/{slug}").text
        assert "not set up</span>" in home and 'data-switch="ve2"' in home and "Rev limit" in home
        boost = c.get(f"/t/{slug}/c/boostTable").text
        assert "Not set up yet" in boost and "<span>TPS (%) ↑</span>" in boost and "No boost rows" not in boost
        ve2 = c.get(f"/t/{slug}/c/veTable2").text
        assert "Rows above the orange line are boost." in ve2 and "Load is <b>MAP (kPa)</b>" in ve2
