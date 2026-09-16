"""Tune health checks: what blocks starting, what looks off, what's worth a note."""
import html
import json
import re

import pytest

from fastapi.testclient import TestClient

from app import checks
from app.main import create_app
from app.parser import parse_msq
from app.tablemaps import all_tables, resolve_map


def speeduino(**over) -> bytes:
    """A small Speeduino tune that passes everything unless a value is overridden."""
    v = {"reqFuel": 11.2, "injOpen": 0.8, "stoich": 14.7, "hardRevLim": 7500, "SoftRevLim": 7300,
         "mapMin": -4, "mapMax": 179, "rpmhigh": 8000, "rpmwarn": 7000, "rpmdang": 7400,
         "rpm": [1000, 4000, 8000], "load": [30, 65, 100],
         "ve": [40, 45, 50, 55, 60, 65, 70, 75, 80],
         "adv": [20, 26, 30, 24, 30, 34, 14, 22, 28],
         "afr": [14.7, 14.7, 14.7, 14.2, 14.0, 13.8, 13.2, 13.0, 12.8],
         "boostCutEnabled": "Off"}
    v.update(over)

    def scalar(name, units="", digits=1):
        return f'<constant digits="{digits}" name="{name}" units="{units}">{v[name]}</constant>'

    def array(name, key, units):
        return (f'<constant cols="1" digits="0" name="{name}" rows="{len(v[key])}" units="{units}">'
                + " ".join(map(str, v[key])) + "</constant>")

    def table(name, key, units):
        return (f'<constant cols="3" digits="1" name="{name}" rows="3" units="{units}">'
                + " ".join(map(str, v[key])) + "</constant>")

    parts = [scalar("reqFuel", "ms"), scalar("injOpen", "ms"), scalar("stoich", ":1"),
             scalar("hardRevLim", "rpm", 0), scalar("SoftRevLim", "rpm", 0),
             scalar("mapMin", "kpa", 0), scalar("mapMax", "kpa", 0),
             f'<pcVariable digits="0" name="rpmhigh" units="rpm">{v["rpmhigh"]}</pcVariable>',
             f'<pcVariable digits="0" name="rpmwarn" units="rpm">{v["rpmwarn"]}</pcVariable>',
             f'<pcVariable digits="0" name="rpmdang" units="rpm">{v["rpmdang"]}</pcVariable>',
             f'<constant name="boostCutEnabled">"{v["boostCutEnabled"]}"</constant>',
             table("veTable", "ve", "%"), array("rpmBins", "rpm", "RPM"), array("fuelLoadBins", "load", "kPa"),
             table("advTable1", "adv", "deg"), array("rpmBins2", "rpm", "RPM"), array("mapBins1", "load", "kPa"),
             table("afrTable", "afr", "AFR"), array("rpmBinsAFR", "rpm", "RPM"), array("loadBinsAFR", "load", "kPa")]
    return ('<?xml version="1.0" encoding="ISO-8859-1"?><msq xmlns="http://www.msefi.com/:msq">'
            '<versionInfo signature="speeduino 202501"/><page>' + "".join(parts) + "</page></msq>").encode()


def health(data: bytes):
    doc = parse_msq(data)
    featured, other = all_tables(doc, resolve_map(doc))
    results = checks.run(doc, featured + other)
    return results, checks.summary(results)


def texts(results, status):
    return [r["text"] for r in results if r["status"] == status]


def test_a_sound_tune_has_no_problems():
    results, s = health(speeduino())
    assert s["tone"] == "ok" and s["verdict"] == "No problems found" and s["short"] == "All good"
    assert not texts(results, "error") and not texts(results, "warn")
    ok = texts(results, "ok")
    assert "Required fuel is 11.2 ms." in ok and "Rev limit is 7500 rpm." in ok
    assert "Full-load targets are λ 0.95 or richer." in ok


def test_blocking_problems_mean_not_ready():
    results, s = health(speeduino(reqFuel=0, hardRevLim=25500, mapMin=200, rpm=[1000, 8000, 4000]))
    errors = texts(results, "error")
    assert s["tone"] == "error" and s["verdict"] == f"Not ready to start: {len(errors)} problems to fix"
    assert "Required fuel is 0 ms, so the injectors never open." in errors[0] or any(
        e.startswith("Required fuel is 0 ms, so the injectors never open.") for e in errors)
    assert "Rev limit is 25500 rpm, which can't be right: it looks unset or a placeholder." in errors
    assert "MAP sensor calibration is wrong: the 0 V value (200 kPa) isn't below the 5 V value (179 kPa)." in errors
    assert any(e.startswith("VE Table RPM bins aren't in increasing order (8000 rpm then 4000 rpm)") for e in errors)
    assert results[0]["status"] == "error"  # problems first


def test_things_that_look_off_are_warnings():
    lean_wot = [14.7, 14.7, 14.7, 14.2, 14.0, 13.8, 14.7, 14.9, 15.0]
    results, s = health(speeduino(afr=lean_wot, adv=[20, 26, 30, 24, 60, 34, 14, 22, 28], injOpen=0,
                                  ve=[40, 45, 50, 55, 95, 65, 70, 75, 80]))
    warns = texts(results, "warn")
    assert s["tone"] == "warn" and s["verdict"].startswith("No blocking problems, but")
    assert "Injector open time 0 ms is outside the usual 0.2–3 ms, so small pulses (idle and cruise) will be off." in warns
    assert "Full-load targets (95 kPa and up, from 2000 rpm) reach λ 1.02 (15 at 8000 rpm / 100 kPa)." in " ".join(warns)
    assert "Advance is outside −20° to 55° in 1 cell (first 60° at 4000 rpm / 65 kPa)." in warns
    assert any(w.startswith("VE jumps sharply at 4000 rpm / 65 kPa: 95%") for w in warns)


def test_notes_for_boost_capable_sensor_and_unset_tables():
    results, _ = health(speeduino(mapMax=250))
    notes = texts(results, "info")
    assert any(n.startswith("The MAP sensor reads up to 250 kPa, but VE Table load bins stop at 100 kPa.") for n in notes)
    rich_boost = [14.7, 14.7, 14.7, 13.2, 13.0, 12.8, 11.5, 11.2, 11.0]
    boosted, s = health(speeduino(load=[30, 100, 150], mapMax=250, afr=rich_boost))
    assert "Boost cut is off while the VE table has boost rows up to 150 kPa, so nothing cuts power on an overboost." \
        in texts(boosted, "info")
    assert s["tone"] == "ok"  # notes aren't problems


def test_full_load_checks_ignore_idle_rpm():
    # λ 1.0 at 1000 rpm / 100 kPa is an idle-speed corner an engine barely reaches; from 4000 rpm it's rich.
    results, s = health(speeduino(afr=[14.7, 14.7, 14.7, 14.2, 14.0, 13.8, 14.7, 13.2, 13.0]))
    assert s["tone"] == "ok" and "Full-load targets are λ 0.95 or richer." in texts(results, "ok")


def test_gauge_settings_are_notes_not_problems():
    results, s = health(speeduino(rpmhigh=7000))
    assert "The tach gauge tops out at 7000 rpm, below the rev limit 7500 rpm. Raise rpmhigh." in texts(results, "info")
    assert s["tone"] == "ok"


def test_page_hands_edit_js_the_rules_and_values(tmp_path):
    with TestClient(create_app(tmp_path), follow_redirects=False) as c:
        slug = c.post("/upload", files={"file": ("t.msq", speeduino(injOpen=0))}).headers["location"].rsplit("/", 1)[1]
        page = c.get(f"/t/{slug}").text
        rules = json.loads(html.unescape(re.search(r"data-checks='([^']*)'", page).group(1)))
        kinds = {r["kind"] for r in rules}
        assert {"range", "cmp", "ascending", "placeholder", "cells", "spike", "rows"} <= kinds
        values = json.loads(html.unescape(re.search(r"data-tune-values='([^']*)'", page).group(1)))
        assert len(values["veTable"]) == 9 and values["loadBinsAFR"] == [30, 65, 100] and values["stoich"] == 14.7
        assert "No blocking problems, but 1 thing looks off" in page and "Tune Health" in page
        assert 'data-health-status' in page and "1 to check" in page
        # health panel variables must not leak into the table editor (it once printed rule dicts as axis notes)
        assert "'kind':" not in page and "&#39;kind&#39;" not in page
        # the health panel sits above the table editor, in the main column
        assert page.index("win-checks") < page.index("win-editor") and page.index("dash-main") < page.index("win-checks")


def test_every_rule_kind_used_is_one_edit_js_knows():
    js = open("app/static/edit.js").read()
    for kind in ("cmp", "range", "ascending", "placeholder", "coverage", "boostcut", "static", "cells", "spike", "rows"):
        assert f'"{kind}"' in js, kind


def fome(units="afr", cells=None, stoich=14.7) -> bytes:
    """A FOME tune whose target table is saved the way the ECU wrote it, with the units it used."""
    rpm, load = [500, 4000, 8000], [10, 55, 100]
    targets = cells if cells is not None else [14.7] * 6 + [12.2, 11.8, 11.5]

    def table(name, vals, u, digits=1):
        return (f'<constant cols="3" digits="{digits}" name="{name}" rows="3" units="{u}">'
                + " ".join(str(v) for v in vals) + "</constant>")

    def array(name, vals, u):
        return (f'<constant cols="1" digits="0" name="{name}" rows="3" units="{u}">'
                + " ".join(str(v) for v in vals) + "</constant>")

    parts = [
        table("veTable", [40, 45, 50, 55, 60, 65, 70, 75, 80], "%"),
        array("veRpmBins", rpm, "RPM"), array("veLoadBins", load, "kPa"),
        table("ignitionTable", [20, 26, 30, 24, 30, 34, 14, 22, 28], "deg"),
        array("ignitionRpmBins", rpm, "RPM"), array("ignitionLoadBins", load, "kPa"),
        table("lambdaTable", targets, units, 2),
        array("lambdaRpmBins", rpm, "RPM"), array("lambdaLoadBins", load, "kPa"),
        f'<constant digits="1" name="stoichRatioPrimary" units=":1">{stoich}</constant>',
        '<constant digits="0" name="rpmHardLimit" units="rpm">7000</constant>',
        '<constant digits="2" name="injector_flow" units="cc/min">440.0</constant>',
        '<constant digits="3" name="displacement" units="L">2.000</constant>',
        '<constant digits="0" name="cylindersCount">4</constant>',
    ]
    return ('<?xml version="1.0" encoding="ISO-8859-1"?><msq xmlns="http://www.msefi.com/:msq">'
            '<versionInfo signature="rusEFI (FOME) Vthpnp.2026.05.01.vthpnp.1"/><page>'
            + "".join(parts) + "</page></msq>").encode()


@pytest.mark.parametrize("units,cells,stoich", [
    ("afr", None, 14.7),                                            # saved as AFR, as this ECU writes it
    ("lambda", [1.0] * 6 + [0.83, 0.80, 0.78], 14.7),               # saved as lambda
    ("afr", [9.0] * 6 + [7.5, 7.3, 7.2], 9.0),                      # saved as AFR on E85
])
def test_a_target_table_is_read_in_the_units_the_file_says(units, cells, stoich):
    """The tablemap's units come from the ini's default display mode; the file knows how it was actually saved."""
    results, summary = health(fome(units, cells, stoich))
    assert not [r["text"] for r in results if r["status"] == "warn" and "λ 0.65" in r["text"]]
    assert "Targets stay between λ 0.65 and 1.20." in texts(results, "ok")
    assert summary["tone"] == "ok"


def test_the_stoich_ratio_is_found_under_the_name_the_firmware_uses():
    from app.axes import stoich_of
    from app.render import fuel_mode

    doc = parse_msq(fome("afr", stoich=9.0))
    assert stoich_of(doc) == 9.0  # FOME calls it stoichRatioPrimary, not stoich
    featured, other = all_tables(doc, resolve_map(doc))
    target = next(v for v in featured + other if v.id == "afr")
    assert target.units == "afr" and fuel_mode(target.z, target.units, target.palette) == "afr"
