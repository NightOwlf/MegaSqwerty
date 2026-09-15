"""The Dash follows the tune's settings: dial scale from gauge settings, consistency checks, live bindings."""
import html
import json
import re

from fastapi.testclient import TestClient

from app import views
from app.main import create_app
from app.parser import parse_msq


def tune(rpmhigh=7000, soft=7300, map_max=179, load_top=250, rpm_top=6000) -> bytes:
    def pc(name, value, units):
        return f'<pcVariable digits="0" name="{name}" units="{units}">{value}</pcVariable>'

    def const(name, value, units, digits=0):
        return f'<constant digits="{digits}" name="{name}" units="{units}">{value}</constant>'

    def arr(name, values, units):
        return f'<constant cols="1" digits="0" name="{name}" rows="{len(values)}" units="{units}">{" ".join(map(str, values))}</constant>'

    parts = [
        pc("rpmhigh", rpmhigh, "rpm"), pc("rpmwarn", 6500, "rpm"), pc("rpmdang", 7200, "rpm"),
        const("hardRevLim", 7500, "rpm"), const("SoftRevLim", soft, "rpm"), const("mapMax", map_max, "kpa"),
        const("reqFuel", 11.2, "ms", 1),
        '<constant cols="2" digits="0" name="veTable" rows="2" units="%">40 50 60 70</constant>',
        arr("rpmBins", [1000, rpm_top], "RPM"), arr("fuelLoadBins", [30, load_top], "kPa"),
    ]
    return ('<?xml version="1.0" encoding="ISO-8859-1"?><msq xmlns="http://www.msefi.com/:msq">'
            '<versionInfo signature="speeduino 202501"/><page>' + "".join(parts) + "</page></msq>").encode()


def test_dial_scale_comes_from_the_tunes_tach_settings():
    doc = parse_msq(tune(rpmhigh=9000))
    d = views.build_dial("Rev limit", "7500", "rpm", "hardRevLim", doc)
    assert d.scale_names == ("rpmhigh", "rpmwarn", "rpmdang")
    assert [t.label for t in d.ticks if t.major][-1] == "9"  # tach runs to rpmhigh = 9000
    assert d.red == views._arc(7200.0, 9000.0, 9000.0)  # red from rpmdang
    assert d.warn == views._arc(6500.0, 7200.0, 9000.0)  # yellow from rpmwarn
    assert d.angle == round(135 + 270 * 7500 / 9000, 2)  # needle at the rev limit


def test_a_tach_max_below_the_rev_limit_still_fits():
    doc = parse_msq(tune(rpmhigh=7000))
    d = views.build_dial("Rev limit", "7500", "rpm", "hardRevLim", doc)
    assert [t.label for t in d.ticks if t.major][-1] == "9" and d.angle < 405  # scale grows to fit the limit


def test_tune_page_carries_what_edits_need(tmp_path):
    with TestClient(create_app(tmp_path), follow_redirects=False) as c:
        slug = c.post("/upload", files={"file": ("t.msq", tune())}).headers["location"].rsplit("/", 1)[1]
        page = c.get(f"/t/{slug}").text
        values = json.loads(html.unescape(re.search(r"data-tune-values='([^']*)'", page).group(1)))
        assert values["hardRevLim"] == 7500 and values["rpmhigh"] == 7000 and values["fuelLoadBins"] == [30, 250]
        rules = json.loads(html.unescape(re.search(r"data-checks='([^']*)'", page).group(1)))
        assert any(r.get("a") == ["hardRevLim", "value"] and r.get("b") == ["rpmhigh", "value"] for r in rules)
        assert 'data-dial data-name="hardRevLim"' in page and 'data-scale-names="rpmhigh,rpmwarn,rpmdang"' in page
        assert 'data-bind="reqFuel" data-digits="1"' in page
        assert "VE Table load bins go up to 250 kPa, past what the MAP sensor is calibrated to read (179 kPa)." in page
        assert "The tach gauge tops out at 7000 rpm, below the rev limit 7500 rpm. Raise rpmhigh." in page
        assert "Tach gauge maximum (a TunerStudio gauge setting, not the rev limiter)" in page
        assert 'data-bin="rpmBins" data-bin-i="1"' in page and 'data-bin="fuelLoadBins" data-bin-i="0"' in page
        ve = c.get(f"/t/{slug}/c/veTable").text
        assert 'data-stats-for="veTable"' in ve and 'data-stat="lo"' in ve
        assert "Required fuel" in c.get(f"/t/{slug}/c/reqFuel").text
