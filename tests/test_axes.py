"""Axis names/units, what load measures, and axis bins guessed by name."""
import pytest

from app.axes import axis_info, axis_text, gauge_text, guess_axes, load_source
from app.parser import Constant, TuneDoc, parse_msq
from app.tablemaps import all_tables, resolve_map


def bins(name, units=None, n=4):
    return Constant(name, "array", [float(i) for i in range(n)], n, 1, units)


@pytest.mark.parametrize("label,name,units,expected", [
    # generic label, real units: keep both
    ("Load", "fmap_table1", "kPa", ("Load", "kPa")),
    ("load", "veLoadBins", "kPa", ("Load", "kPa")),
    # a name sitting in the units slot is not a unit
    ("Load", "ignitionLoadBins", "Load", ("Load", "")),
    ("L", "vvtTable1LoadBins", "L", ("Load", "")),
    ("TPS", "alsIgnRetardLoadBins", "TPS", ("TPS", "%")),
    # a unit sitting in the label slot moves to the units, and the bins name supplies the name
    ("%", "maxKnockRetardLoadBins", "%", ("Load", "%")),
    ("%", "pedalToTpsPedalBins", "%", ("Pedal", "%")),
    ("%", "throttle2TrimTpsBins", "%", ("TPS", "%")),
    ("cc/lobe", "hpfpCompensationLoadBins", "cc/lobe", ("Load", "cc/lobe")),
    # blank label: named from the bins
    ("", "lambdaLoadBins", None, ("Load", "")),
    ("", "fuelTrimRpmBins", "rpm", ("RPM", "")),
    ("", "boostClosedLoopXAxisBins", None, ("", "")),
    # spellings
    ("rpm", "ignTrimRpmBins", "rpm", ("RPM", "")),
    ("Coolant", "cltFuelCorrBins", "C", ("Coolant", "°C")),
    ("CLT", "x", "deg C", ("Coolant", "°C")),
    ("RPM", "veRpmBins", "RPM", ("RPM", "")),
    ("X", "scriptCurve1Bins", "", ("", "")),
    ("% TPS", "x", "% TPS", ("% TPS", "")),
])
def test_axis_info(label, name, units, expected):
    assert axis_info(label, bins(name, units), units or "") == expected


def test_gauge_text():
    assert gauge_text(150) == "7.1 psi boost" and gauge_text(390) == "41.9 psi boost"
    assert gauge_text(80) == "6.3 inHg vacuum" and gauge_text(40) == "18.1 inHg vacuum"
    assert gauge_text(102) == "atmospheric" and gauge_text(100) == "atmospheric"


def _ve_grid(load_bins, y_label="Load", y_units="kPa"):
    from app.render import build_grid

    n = len(load_bins)
    z = Constant("veTable", "table", [50.0] * (n * 4), n, 4, "%")
    x = Constant("rpmBins", "array", [1000.0, 2000.0, 3000.0, 4000.0], 4, 1, "RPM")
    y = Constant("fuelLoadBins", "array", [float(v) for v in load_bins], n, 1, y_units)
    return build_grid("ve", "VE", z, x, y, "ve", "%", "RPM", y_label, y_units=y_units)


def test_boost_rows_are_marked():
    g = _ve_grid([40, 100, 150, 200])
    rows = {r.label: r for r in g.rows}
    assert rows["150"].boost_edge and not rows["200"].boost_edge and not rows["100"].boost_edge
    assert rows["40"].gauge == "18.1 inHg vacuum" and rows["100"].gauge == "atmospheric"
    assert g.boost_line and g.pressure_note.startswith("Rows above the orange line are boost.")
    assert "200 kPa, is about 14.3 psi boost" in g.pressure_note


def test_tables_without_boost_rows_say_so():
    g = _ve_grid([12, 52, 98, 102])  # the shape of a Speeduino tune that tops out at atmospheric
    assert not g.boost_line and g.pressure_note.startswith("No boost rows: the top load bin is 102 kPa")
    tps = _ve_grid([0, 30, 60, 100], y_label="TPS", y_units="%")
    assert tps.pressure_note == "" and not any(r.gauge for r in tps.rows)


def test_axis_text():
    assert axis_text("Load", "kPa") == "Load (kPa)"
    assert axis_text("RPM", "") == "RPM" and axis_text("", "kPa") == "kPa" and axis_text("", "", "Y") == "Y"


def doc_with(**settings):
    return TuneDoc(constants={k: Constant(k, "string", [v]) for k, v in settings.items()})


@pytest.mark.parametrize("settings,table,expected", [
    ({"algorithm": "Speed Density"}, "ve", ("MAP", "kPa", "algorithm")),
    ({"algorithm": "MAP"}, "ve", ("MAP", "kPa", "algorithm")),          # newer Speeduino
    ({"algorithm": "TPS"}, "ve", ("TPS", "%", "algorithm")),
    ({"algorithm": "Alpha-N"}, "ve", ("TPS", "%", "algorithm")),
    ({"algorithm": "Percent Baro"}, "ve", ("MAP ÷ baro", "%", "algorithm")),
    ({"algorithm": "IMAP/EMAP"}, "ve", ("IMAP/EMAP", "", "algorithm")),
    ({"fuelAlgorithm": "MAF Air Charge"}, "ve", ("MAF", "", "fuelAlgorithm")),
    ({"IgnAlgorithm": "Alpha-N"}, "spark", ("TPS", "%", "IgnAlgorithm")),
    ({"algorithm": "Speed Density"}, "spark", None),  # the fuel setting doesn't decide ignition load
    ({"algorithm": "Speed Density"}, "afr", None),
])
def test_load_source(settings, table, expected):
    src = load_source(doc_with(**settings), None, table)
    assert (src and (src.measure, src.units, src.setting)) == expected
    # recognised even when the option text is the measure itself ("MAP", "TPS")
    assert src is None or (src.known and src.text.startswith("Load is "))


def test_unrecognised_load_setting_is_shown_as_is():
    src = load_source(doc_with(algorithm="Blended Future Mode"), None, "ve")
    assert not src.known and src.measure == "Blended Future Mode" and "algorithm" in src.text


def test_tablemap_can_name_the_load_setting():
    src = load_source(doc_with(myLoad="Alpha-N"), ["missing", "myLoad"], "boost")
    assert src.measure == "TPS"


def test_fixture_tables_get_names_units_and_load(fx):
    doc = parse_msq(fx("fome_vthpnp.msq"))
    views = {v.z.name: v for v in sum(all_tables(doc, resolve_map(doc)), [])}
    ve, lam, vvt = views["veTable"], views["lambdaTable"], views["vvtTable1"]
    assert (ve.y_label, ve.y_units) == ("Load", "kPa") and ve.load.measure == "MAP"
    assert (lam.y_label, lam.y_units) == ("Load", "") and lam.load is None
    assert (vvt.y_label, vvt.y_units) == ("Load", "")
    ms3 = parse_msq(fx("ms3_basic.msq"))
    v = all_tables(ms3, resolve_map(ms3))[0][0]
    assert (v.y_label, v.y_units, v.load.setting) == ("Load", "kPa", "algorithm")


GUESS = b"""<?xml version="1.0" encoding="ISO-8859-1"?>
<msq xmlns="http://www.msefi.com/:msq"><versionInfo signature="AcmeECU build 9"/><page number="0">
<constant cols="3" name="sparkMap" rows="2">1 2 3 4 5 6</constant>
<constant cols="1" name="sparkMapRpmBins" rows="3" units="rpm">1000 2000 3000</constant>
<constant cols="1" name="sparkMapLoadBins" rows="2" units="kPa">50 100</constant>
<constant cols="1" name="sparkMapTrim" rows="2">1 2</constant>
<constant cols="2" name="otherTable" rows="2">1 2 3 4</constant>
<constant cols="1" name="unrelatedRpmBins" rows="2">1 2</constant>
</page></msq>"""


def test_axes_are_guessed_by_name_only_when_unambiguous():
    doc = parse_msq(GUESS)
    x, y = guess_axes(doc, doc.get("sparkMap"))
    assert (x.name, y.name) == ("sparkMapRpmBins", "sparkMapLoadBins")
    assert guess_axes(doc, doc.get("otherTable")) == (None, None)  # bins must share the table's name
    v = next(v for v in all_tables(doc, resolve_map(doc))[1] if v.z.name == "sparkMap")
    assert v.guessed and (v.x_label, v.y_label, v.y_units) == ("RPM", "Load", "kPa")


def test_guessed_axes_show_on_the_page(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(tmp_path), follow_redirects=False) as c:
        slug = c.post("/upload", files={"file": ("t.msq", GUESS)}).headers["location"].rsplit("/", 1)[1]
        html = c.get(f"/t/{slug}/c/sparkMap").text
        assert "<span>Load (kPa) ↑</span>" in html and "<span>RPM →</span>" in html
        assert "matched by name: sparkMapRpmBins × sparkMapLoadBins" in html
