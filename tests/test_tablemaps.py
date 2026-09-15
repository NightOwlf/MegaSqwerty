import json

import pytest

from app.parser import Constant, parse_msq
from app.render import axis_labels, build_grid, fuel_mode
from app.tablemaps import GENERIC, all_tables, curves, load_maps, resolve_map, summary_fields
from ini_to_tablemap import validate_tablemap


def test_unknown_signature_falls_back_to_generic(fx):
    doc = parse_msq(fx("unknown_firmware.msq"))
    tmap = resolve_map(doc)
    assert tmap is GENERIC
    featured, other = all_tables(doc, tmap)
    assert featured == []
    assert [v.label for v in other] == ["fooMap"]  # 1D barCurve isn't a table
    g = build_grid(other[0].id, other[0].label, other[0].z)
    assert g.x_labels == [str(i) for i in range(8)]  # unlabeled axes
    assert len(g.rows) == 8


def test_family_map_features_and_other_tables(fx):
    doc = parse_msq(fx("fome_vthpnp.msq"))
    tmap = resolve_map(doc)
    assert tmap["family"] == "FOME"
    featured, other = all_tables(doc, tmap)
    assert [v.id for v in featured] == ["ve", "spark", "afr"]
    names = {v.z.name: v for v in other}
    # Mapped non-featured table gets its ini title; unmapped keeps the raw name.
    assert names["vvtTable1"].label == "Intake VVT closed loop Target" and names["vvtTable1"].mapped
    assert names["luaScratchTable"].label == "luaScratchTable" and not names["luaScratchTable"].mapped
    # Every 2D constant appears exactly once across featured + other.
    all_2d = {n for n, c in doc.constants.items() if c.is_table}
    assert {v.z.name for v in featured + other} == all_2d
    assert any(c.y.name == "cltFuelCorr" for c in curves(doc, tmap))
    labels = dict((label, c.name) for label, c in summary_fields(doc, tmap))
    assert labels["Cylinders"] == "cylindersCount" and labels["Rev limit"] == "rpmHardLimit"


def test_rusefi_family_resolves(fx):
    doc = parse_msq(fx("rusefi_basic.msq"))
    assert resolve_map(doc)["family"] == "rusEFI"


def test_ms3_hand_map(fx):
    doc = parse_msq(fx("ms3_basic.msq"))
    tmap = resolve_map(doc)
    assert tmap["family"] == "MS3"
    featured, other = all_tables(doc, tmap)
    assert [v.id for v in featured] == ["ve", "spark", "afr"]
    assert featured[0].x.name == "frpm_table1"
    assert [v.z.name for v in other] == ["mysteryTable"]


def test_exact_signature_beats_family():
    doc = parse_msq(b'<msq><versionInfo signature="MS3 Format 9.9 special"/></msq>')
    maps = (
        {"family": "MS3", "name": "family", "tables": []},
        {"family": "MS3", "name": "exact", "signatures": ["MS3 Format 9.9 special"], "tables": []},
    )
    assert resolve_map(doc, maps)["name"] == "exact"


def test_new_firmware_needs_only_a_json_file(tmp_path):
    (tmp_path / "Acme.json").write_text(json.dumps({
        "family": "AcmeECU", "signature_patterns": ["^AcmeECU"],
        "tables": [{"id": "fuel", "label": "Fuel", "z": "fooMap", "palette": "ve"}],
    }))
    doc = parse_msq((tmp_path / "x.msq").write_bytes(b"") or
                    b'<msq><versionInfo signature="AcmeECU build 7"/><page>'
                    b'<constant name="fooMap" rows="2" cols="2">1 2 3 4</constant></page></msq>')
    tmap = resolve_map(doc, load_maps(str(tmp_path)))
    assert tmap["family"] == "AcmeECU"
    assert [v.label for v in all_tables(doc, tmap)[0]] == ["Fuel"]


@pytest.mark.parametrize("path", sorted(__import__("app.tablemaps", fromlist=["x"]).TABLEMAP_DIR.glob("*.json")))
def test_committed_tablemaps_are_valid(path):
    assert validate_tablemap(json.loads(path.read_text())) == []


def test_axis_label_precision():
    assert axis_labels([500.0, 950.0, 1400.0], 3, 0) == ["500", "950", "1400"]
    assert axis_labels([12.5, 28.0, 43.5], 3) == ["12.5", "28.0", "43.5"]
    assert axis_labels([0.30000001192, 0.5, 1.0], 3) == ["0.3", "0.5", "1.0"]
    assert axis_labels([100.0, 200.0], 3) == ["0", "1", "2"]  # wrong length -> indexes
    assert axis_labels(None, 2) == ["0", "1"]


def test_fuel_mode_detection():
    lam = Constant("t", "table", [0.8, 0.9, 1.0, 1.05], 2, 2)
    afr = Constant("t", "table", [12.0, 13.0, 14.7, 15.0], 2, 2)
    assert fuel_mode(lam, "lambda", "default") == "lambda"
    assert fuel_mode(lam, "", "afr") == "lambda"  # unitless target table in lambda range
    assert fuel_mode(afr, "AFR", "afr") == "afr"
    assert fuel_mode(afr, "", "ve") is None
    assert build_grid("x", "x", lam, palette_name="afr").fuel == "lambda"


def test_views_model_and_thumbs(fx):
    from app import views
    doc = parse_msq(fx("fome_vthpnp.msq"))
    m = views.tune_model("abcdefghij", doc, resolve_map(doc))
    cards = {t.name: t for t in m.tables}
    assert cards["veTable"].cat == "fuel" and cards["ignitionTable"].cat == "spark"
    assert cards["lambdaTable"].cat == "afr" and cards["vvtTable1"].cat == "vvt"
    assert cards["boostTableOpenLoop"].cat == "boost"
    assert len(cards["veTable"].thumb) == 256 and set(cards["veTable"].thumb) <= set(views.THUMB_ALPHABET)
    assert [c.name for c in m.curves] == ["cltFuelCorr"] and m.curves[0].line
    # every setting is filed under exactly one category, and every table/curve is in exactly one menu
    assert sum(n for _, _, n in m.setting_cats) == len(m.settings) == len(doc.constants)
    menu_urls = [it["url"] for *_, items in m.menus for it in items if not it.get("chip")]
    assert sorted(menu_urls) == sorted([t.url for t in m.tables] + [c.url for c in m.curves])
    chart = views.build_chart(doc.get("cltFuelCorr").values, doc.get("cltFuelCorrBins").values, "Coolant")
    assert len(chart.points) == 16 and chart.xticks[0][1] == "-40.0"
