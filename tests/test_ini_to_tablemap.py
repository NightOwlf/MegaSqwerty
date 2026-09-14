import json

from app.parser import parse_msq
from app.tablemaps import all_tables, curves, load_maps, resolve_map
from conftest import FIXTURES
from ini_to_tablemap import build_tablemap, main, parse_ini, validate_tablemap

INI = (FIXTURES / "sample_fome.ini").read_text("latin-1")


def test_generates_valid_map():
    tmap = build_tablemap(parse_ini(INI), "FOME")
    assert validate_tablemap(tmap) == []
    assert tmap["signatures"] == ["rusEFI (FOME) Testboard.2026.01.01.testboard.123456"]
    by_id = {t["id"]: t for t in tmap["tables"]}
    assert [t["id"] for t in tmap["tables"][:3]] == ["ve", "spark", "afr"]

    ve = by_id["ve"]
    assert (ve["z"], ve["x"], ve["y"]) == ("veTable", "veRpmBins", "veLoadBins")
    assert (ve["x_label"], ve["y_label"], ve["units"], ve["palette"]) == ("RPM", "load", "%", "ve")
    assert "featured" not in ve

    afr = by_id["afr"]
    assert afr["label"] == "Target Lambda Table" and afr["units"] == "lambda" and afr["palette"] == "afr"

    vvt = by_id["vvtTable1Tbl"]
    assert vvt["featured"] is False
    assert vvt["x_label"] == "RPM"  # expression label replaced by the bins' units
    assert vvt["y_label"] == "Load"

    (curve,) = tmap["curves"]
    assert curve == {"id": "cltFuelCorrCurve", "label": "Warmup fuel manual Multiplier", "x": "cltFuelCorrBins",
                     "y": "cltFuelCorr", "x_label": "Coolant", "y_label": "Multiplier"}

    summary = {s["label"]: s["name"] for s in tmap["summary_fields"]}
    assert summary == {"Injector flow": "injector_flow", "Cylinders": "cylindersCount",
                       "Fuel algorithm": "fuelAlgorithm", "Rev limit": "rpmHardLimit"}
    assert tmap["constant_meta"]["ignitionTable"] == {"units": "deg", "digits": 1}


def test_else_branch_switches_to_afr():
    tmap = build_tablemap(parse_ini(INI, {"LAMBDA"}), "FOME")
    afr = next(t for t in tmap["tables"] if t["id"] == "afr")
    assert afr["label"] == "Target AFR Table" and afr["units"] == "afr"


def test_cli_writes_a_map_the_viewer_uses(tmp_path, fx):
    out = tmp_path / "Testboard.json"
    assert main([str(FIXTURES / "sample_fome.ini"), "--family", "FOME", "-o", str(out)]) == 0
    tmap_file = json.loads(out.read_text())
    assert validate_tablemap(tmap_file) == []

    doc = parse_msq(fx("fome_vthpnp.msq"))
    tmap = resolve_map(doc, load_maps(str(tmp_path)))
    assert tmap["family"] == "FOME"
    featured, other = all_tables(doc, tmap)
    assert [v.label for v in featured] == ["VE Table", "Ignition Table", "Target Lambda Table"]
    assert any(v.label == "Intake VVT closed loop Target" for v in other)
    assert [c.label for c in curves(doc, tmap)] == ["Warmup fuel manual Multiplier"]


def test_validate_catches_bad_maps():
    assert validate_tablemap({"family": "", "tables": [{"id": "a"}]})
    assert validate_tablemap({"family": "X", "tables": [], "signature_patterns": ["("]})
