"""Prepping a tune for boost: what the plan allows, what it writes, and what it refuses."""
import re

import pytest
from fastapi.testclient import TestClient

from app import boost
from app.main import create_app
from app.parser import parse_msq
from app.tablemaps import all_tables, resolve_map

RPM = [500 + 500 * i for i in range(16)]
LOAD_NA = [25 + 5 * i for i in range(16)]  # 25–100 kPa: a naturally aspirated basemap
TPS_BINS = [0, 10, 20, 30, 50, 70, 90, 100]
BOOST_RPM = [1000 + 1000 * i for i in range(8)]


def _ve(load, c):
    return round(30 + 50 * load / 100 + 8 * (1 - abs(c - 9) / 9), 1)


def _adv(load, c):
    return round(14 + 20 * c / 15 - 10 * load / 100, 1)


def _afr(load, c):
    return round(14.7 - 1.9 * max(0.0, (load - 60) / 40), 1)


def _table(name, loads, cols, fn, units, digits=1, rows_attr=None):
    vals = " ".join(str(fn(load, c)) for load in loads for c in range(len(cols)))
    return (f'<constant cols="{len(cols)}" digits="{digits}" name="{name}" rows="{rows_attr or len(loads)}" '
            f'units="{units}">{vals}</constant>')


def _array(name, vals, units, digits=0):
    return (f'<constant cols="1" digits="{digits}" name="{name}" rows="{len(vals)}" units="{units}">'
            + " ".join(str(v) for v in vals) + "</constant>")


def _scalar(name, value, units="", digits=0, tag="constant"):
    q = f'"{value}"' if isinstance(value, str) else value
    return f'<{tag} digits="{digits}" name="{name}" units="{units}">{q}</{tag}>'


def sp(**over) -> bytes:
    """A Speeduino tune with a sound naturally aspirated fuel/spark/AFR setup and a boost controller that's off."""
    v = {"load": LOAD_NA, "mapMax": 250, "mapMin": 10, "algorithm": "Speed Density", "boostLimit": 0,
         "boostCutEnabled": "Off", "engineProtectType": "Off", "boostEnabled": "Off", "boostType": "Closed Loop",
         "boost_units": "kPa", "boost_values": None, "boostMaxDuty": 100, "hardRevLim": 7000,
         "boostByGearEnabled": "Multiplied %", "gear_units": "%", "nCylinders": 4}
    v.update(over)
    load = v["load"]
    boost_vals = v["boost_values"] or [0] * (len(TPS_BINS) * len(BOOST_RPM))
    parts = [
        _scalar("reqFuel", 11.2, "ms", 1), _scalar("injOpen", 0.8, "ms", 1), _scalar("stoich", 14.7, ":1", 1),
        _scalar("nCylinders", v["nCylinders"]), _scalar("hardRevLim", v["hardRevLim"], "rpm"),
        _scalar("SoftRevLim", 6800, "rpm"), _scalar("mapMin", v["mapMin"], "kpa"), _scalar("mapMax", v["mapMax"], "kpa"),
        _scalar("algorithm", v["algorithm"]), _scalar("boostEnabled", v["boostEnabled"]),
        _scalar("boostType", v["boostType"]), _scalar("boostCutEnabled", v["boostCutEnabled"]),
        _scalar("engineProtectType", v["engineProtectType"]), _scalar("boostLimit", v["boostLimit"], "kPa"),
        _scalar("boostMaxDuty", v["boostMaxDuty"], "%"), _scalar("boostByGearEnabled", v["boostByGearEnabled"]),
        _table("veTable", load, RPM, _ve, "%"), _array("rpmBins", RPM, "RPM"), _array("fuelLoadBins", load, "kPa"),
        _table("advTable1", load, RPM, _adv, "deg"), _array("rpmBins2", RPM, "RPM"), _array("mapBins1", load, "kPa"),
        _table("afrTable", load, RPM, _afr, "AFR"), _array("rpmBinsAFR", RPM, "RPM"), _array("loadBinsAFR", load, "kPa"),
        (f'<constant cols="{len(BOOST_RPM)}" digits="0" name="boostTable" rows="{len(TPS_BINS)}" '
         f'units="{v["boost_units"]}">' + " ".join(str(x) for x in boost_vals) + "</constant>"),
        _array("rpmBinsBoost", BOOST_RPM, "RPM"), _array("tpsBinsBoost", TPS_BINS, "%"),
    ]
    parts += [_scalar(f"boostByGear{i}", 100, v["gear_units"]) for i in range(1, 7)]
    parts += [_scalar(n, x, u, tag="pcVariable") for n, x, u in
              (("rpmhigh", 8000, "rpm"), ("rpmwarn", 6500, "rpm"), ("rpmdang", 7000, "rpm"),
               ("maphigh", 250, "kPa"), ("mapwarn", 150, "kPa"), ("mapdang", 180, "kPa"))]
    return ('<?xml version="1.0" encoding="ISO-8859-1"?><msq xmlns="http://www.msefi.com/:msq">'
            '<versionInfo signature="speeduino 202501"/><page>' + "".join(parts) + "</page></msq>").encode()


def rus(**over) -> bytes:
    """A rusEFI tune: closed-loop boost, a blend table by vehicle speed, and load bins that don't say "kPa"."""
    v = {"load": LOAD_NA, "boostType": "Open + Closed Loop", "axis": "Vehicle Speed", "param": "Zero",
         "map_sensor": "MPX4250"}
    v.update(over)
    load = v["load"]
    blend = [
        f'<constant cols="8" digits="1" name="boostClosedLoopBlends1_table" rows="8" units="">'
        + " ".join(["0"] * 64) + "</constant>",
        _array("boostClosedLoopBlends1_loadBins", [10 * (i + 1) for i in range(8)], "Load"),
        _array("boostClosedLoopBlends1_rpmBins", BOOST_RPM, "RPM"),
        _array("boostClosedLoopBlends1_blendValues", [0] * 8, "%"),
        _scalar("boostClosedLoopBlends1_yAxisOverride", v["axis"]),
        _scalar("boostClosedLoopBlends1_blendParameter", v["param"]),
    ]
    parts = [
        _scalar("cylindersCount", 4), _scalar("rpmHardLimit", 7200, "rpm"),
        _scalar("injector_flow", 550.0, "cc/min", 2), _scalar("displacement", 2.0, "L", 3),
        _scalar("fuelAlgorithm", "Speed Density"), _scalar("map_sensor_type", v["map_sensor"]),
        _scalar("isBoostControlEnabled", "true"), _scalar("boostType", v["boostType"]),
        _scalar("lambdaProtectionEnable", "false"),
        _scalar("boostCutPressure", 0, "kPa (absolute)"), _scalar("boostControlSafeDutyCycle", 30, "%"),
        _table("veTable", load, RPM, _ve, "%"), _array("veRpmBins", RPM, "RPM"), _array("veLoadBins", load, "kPa"),
        _table("ignitionTable", load, RPM, _adv, "deg"), _array("ignitionRpmBins", RPM, "RPM"),
        _array("ignitionLoadBins", load, "Load"),
        _table("lambdaTable", load, RPM, lambda l, c: round(_afr(l, c) / 14.7, 2), "lambda", digits=2),
        _array("lambdaRpmBins", RPM, "RPM"), _array("lambdaLoadBins", load, ""),
        f'<constant cols="8" digits="0" name="boostTableClosedLoop" rows="8" units="">' + " ".join(["0"] * 64)
        + "</constant>",
        _array("boostClosedLoopXAxisBins", BOOST_RPM, "RPM"), _array("boostClosedLoopYAxisBins", TPS_BINS, ""),
        f'<constant cols="8" digits="1" name="boostTableOpenLoop" rows="8" units="%">' + " ".join(["20"] * 64)
        + "</constant>",
        _array("boostRpmBins", BOOST_RPM, "RPM"), _array("boostTpsBins", TPS_BINS, "%"),
        _array("gearBasedOpenLoopBoostAdder", [5] * 8, "", 2),
    ] + blend
    return ('<?xml version="1.0" encoding="ISO-8859-1"?><msq xmlns="http://www.msefi.com/:msq">'
            '<versionInfo signature="rusEFI master.2026.02.01.proteus_f4.1234567890"/><page>'
            + "".join(parts) + "</page></msq>").encode()


BASE = {"spring_psi": "7", "fuel": "93", "internals": "stock", "pump": "upgraded", "wideband": "yes",
        "injector_cc": "440", "na_hp": "140", "goal": "stage1"}


def plan_for(raw: bytes, **form):
    doc = parse_msq(raw)
    tmap = resolve_map(doc)
    featured, other = all_tables(doc, tmap)
    views = featured + other
    ans, errors = boost.parse_answers({**BASE, **form})
    return doc, tmap, views, boost.build_plan(doc, views, tmap, ans, errors)


def built(raw: bytes, **form):
    """Build the plan, write it, and hand back the parsed result."""
    doc, tmap, views, plan = plan_for(raw, **form)
    assert plan.ok, (plan.errors, plan.blockers)
    new_raw, changed = boost.create(raw, doc, tmap, plan)
    return plan, parse_msq(new_raw), changed


def items(plan):
    return " ".join(f"{i.label} {i.name} {i.detail}" for i in plan.items)


# ------------------------------------------------------------------ stage 1

def test_stage_one_rescales_load_bins_and_fills_boost_rows():
    plan, new, changed = built(sp())
    assert plan.target_psi == 7.0 and plan.cut_kpa == 170.0  # spring pressure, cut 3 psi above
    bins = new.get("fuelLoadBins").values
    assert bins == [25, 30, 40, 45, 50, 60, 65, 75, 80, 85, 95, 100, 120, 140, 160, 180]
    assert bins[-1] >= plan.cut_kpa  # the tables cover everything up to the cut
    ve, adv, afr = (new.get(n) for n in ("veTable", "advTable1", "afrTable"))
    for z, old_fn in ((ve, _ve), (adv, _adv), (afr, _afr)):
        for c in range(16):  # rows at or below atmospheric keep the tune's own numbers
            assert z.values[11 * 16 + c] == pytest.approx(old_fn(100, c), abs=0.05)
    atm_ve, atm_adv, atm_afr = (z.row(11) for z in (ve, adv, afr))
    for r in range(12, 16):
        psi = boost.psi_of(bins[r])
        for c in range(16):
            assert ve.row(r)[c] > atm_ve[c]                       # more fuel in boost, never less
            want = max(0.0, atm_adv[c] - 1.2 * psi - 2)  # 1.2°/psi on 93, 2° more for the first drive
            assert adv.row(r)[c] <= want + 0.05          # timing comes out as boost climbs
            assert adv.row(r)[c] <= 20                            # and never exceeds the fuel's ceiling
            assert afr.row(r)[c] <= atm_afr[c]                    # targets only get richer
    assert afr.row(15)[8] == pytest.approx(0.76 * 14.7, abs=0.1)
    assert changed > 100 and "boost rows" in items(plan)


def test_stage_one_is_the_spring_alone():
    plan, new, _ = built(sp())
    assert set(new.get("boostTable").values) == {boost._even(boost.kpa_of(7))}  # target = spring everywhere
    assert new.get("boostMaxDuty").value == 0  # the solenoid can't add boost
    assert new.get("boostLimit").value == 170
    assert new.get("hardRevLim").value == 7000  # never touched
    assert any("above the spring" in f for f in plan.failsafes)
    assert any("boostCutEnabled" in r for r in plan.required)      # options can only be flipped in TunerStudio
    assert any("engineProtectType" in r for r in plan.required)
    assert any("boost cut works" in r for r in plan.required)


def test_a_tune_that_already_has_boost_rows_keeps_its_bins():
    loads = [30 + 15 * i for i in range(16)]  # 30–255 kPa
    plan, new, _ = built(sp(load=loads))
    assert new.get("fuelLoadBins").values == loads
    assert "Load bins" not in items(plan)


# ------------------------------------------------------------------ limits

def test_going_up_needs_the_previous_stage_logged():
    _, _, _, plan = plan_for(sp(), goal="stage2")
    assert not plan.ok and any("logged" in b for b in plan.blockers)
    _, _, _, ok = plan_for(sp(), goal="stage2", logged="yes")
    assert ok.ok and ok.target_psi == 8.0  # asked 10, capped by stock internals on 93


def test_the_smallest_limit_wins_and_says_why():
    _, _, _, plan = plan_for(sp(), goal="custom", target_psi="25", logged="yes", fuel="e85",
                             internals="built", injector_cc="1000")
    binding = [lim.label for lim in plan.limits if lim.binding]
    assert plan.target_psi == 11.0 and binding == ["Step size"]  # 7 psi spring + 4 psi per step
    assert any("Step size" in lim.label and "at a time" in lim.reason for lim in plan.limits)
    labels = [lim.label for lim in plan.limits]
    assert {"Engine and fuel", "Injectors", "MAP sensor", "Step size"} <= set(labels)


def test_unverified_fuel_capacity_and_a_stock_pump_hold_boost_down():
    _, _, _, plan = plan_for(sp(), injector_cc="", na_hp="", pump="stock", goal="custom", target_psi="12",
                             logged="yes", internals="built")
    assert plan.target_psi == 7.0
    assert {"Fuel capacity unverified", "Fuel pump"} <= {lim.label for lim in plan.limits if lim.binding}


def test_a_small_map_sensor_caps_the_target():
    _, _, _, plan = plan_for(sp(mapMax=200), goal="custom", target_psi="14", logged="yes", internals="built",
                             fuel="e85", injector_cc="1000")
    assert plan.target_psi < 11 and plan.cut_kpa <= 200 * boost.SENSOR_USABLE
    assert any(lim.label == "MAP sensor" and lim.binding for lim in plan.limits)


def test_open_loop_only_cant_go_above_the_spring():
    _, _, _, plan = plan_for(sp(boostType="Open Loop", boost_units="%"), goal="stage2", logged="yes")
    assert plan.target_psi == 7.0
    assert any(lim.label == "Boost control" and lim.binding for lim in plan.limits)
    _, new, _ = built(sp(boostType="Open Loop", boost_units="%"))
    assert set(new.get("boostTable").values) == {0}  # duty table, zeroed


@pytest.mark.parametrize("form,expect", [
    ({"wideband": ""}, "wideband"),
    ({"spring_psi": "18", "fuel": "91"}, "softer spring"),
    ({"spring_psi": ""}, "Enter the wastegate"),
    ({"goal": "custom", "target_psi": "", "logged": "yes"}, "custom boost target"),
])
def test_setups_that_cant_have_boost_are_refused(form, expect):
    _, _, _, plan = plan_for(sp(), **form)
    assert not plan.ok and any(expect in m for m in plan.blockers + plan.errors)


@pytest.mark.parametrize("tune,expect", [
    (sp(algorithm="Alpha-N"), "MAP (speed density)"),
    (sp(mapMax=105), "can't read boost"),
    (sp(hardRevLim=25500), "Tune Health"),
])
def test_tunes_that_cant_have_boost_are_refused(tune, expect):
    _, _, _, plan = plan_for(tune)
    assert not plan.ok and any(expect in b for b in plan.blockers)


def test_the_map_sensor_range_can_be_answered_when_the_tune_doesnt_say(fx):
    doc = parse_msq(fx("ms3_basic.msq"))
    tmap = resolve_map(doc)
    featured, other = all_tables(doc, tmap)
    ans, _ = boost.parse_answers({**BASE, "map_kpa": ""})
    plan = boost.build_plan(doc, featured + other, tmap, ans)
    assert not plan.ok and any("MAP sensor" in b for b in plan.blockers)
    ans2, _ = boost.parse_answers({**BASE, "map_kpa": "250"})
    assert boost.build_plan(doc, featured + other, tmap, ans2).ok


# ------------------------------------------------------------------ boost by gear and speed

def test_boost_by_gear_writes_a_percentage_per_gear():
    plan, new, _ = built(sp(), goal="stage2", logged="yes", schedule="gear",
                         gear1_psi="4", gear2_psi="7.5", gear3_psi="8", gear4_psi="8", gear5_psi="8", gear6_psi="8")
    gears = [new.get(f"boostByGear{i}").value for i in range(1, 7)]
    assert gears[0] < gears[1] < gears[2] == 100 and max(gears) <= 100
    assert plan.schedule[0]["psi"] == 7.0 and "spring is the least" in plan.schedule[0]["note"]
    assert plan.schedule[1]["psi"] == 7.5 and plan.schedule[2]["psi"] == 8.0


def test_boost_by_gear_with_no_gear_setting_falls_back_to_the_lowest():
    plan, new, _ = built(sp(boostByGearEnabled="Off"), goal="stage2", logged="yes", schedule="gear",
                         gear1_psi="7", gear2_psi="8", gear3_psi="8", gear4_psi="8", gear5_psi="8", gear6_psi="8")
    assert plan.table_psi == 7.0
    assert max(new.get("boostTable").values) == boost._even(boost.kpa_of(7))
    assert any("lowest point" in n for n in plan.notes)


def test_boost_by_speed_writes_a_rusefi_blend_table():
    plan, new, _ = built(rus(), spring_psi="7", goal="custom", target_psi="10", logged="yes", internals="built",
                         fuel="e85", injector_cc="1000", na_hp="150", schedule="speed", speed_unit="mph",
                         speed1="30", speed1_psi="7", speed2="60", speed2_psi="10")
    bins = new.get("boostClosedLoopBlends1_loadBins").values
    assert bins[0] == 48 and bins[1] == 97 and all(a < b for a, b in zip(bins, bins[1:]))  # mph -> km/h, ascending
    adders = new.get("boostClosedLoopBlends1_table")
    base = max(new.get("boostTableClosedLoop").values)
    assert base == boost._even(boost.kpa_of(7))            # the base target is the lowest scheduled boost
    assert min(adders.values) == 0 and max(adders.values) + base <= boost._even(boost.kpa_of(10)) + 1
    assert set(new.get("boostClosedLoopBlends1_blendValues").values) == {100}
    assert any("falls back" in f for f in plan.failsafes)
    assert set(new.get("gearBasedOpenLoopBoostAdder").values) == {0}  # no hidden duty adders
    assert set(new.get("boostTableOpenLoop").values) == {0}
    assert new.get("boostControlSafeDutyCycle").value == 0            # sensor failure = spring pressure


def test_rusefi_load_bins_without_units_are_treated_as_map_and_said_so():
    plan, new, _ = built(rus())
    for name in ("veLoadBins", "ignitionLoadBins", "lambdaLoadBins"):
        assert max(new.get(name).values) >= plan.cut_kpa
    assert any("taken to be MAP" in n for n in plan.notes)
    assert any("lambdaProtectionEnable" in r for r in plan.recommended)


def test_a_blend_by_speed_is_only_used_when_the_tune_says_it_is_by_speed():
    _, _, _, plan = plan_for(rus(axis="Engine Load"), schedule="speed", speed1="30", speed1_psi="7")
    assert plan.ok and plan.checks.get("schedule") is None
    assert any("no speed setting" in n for n in plan.notes)


# ------------------------------------------------------------------ the safety net

def test_new_load_bins_keeps_vacuum_resolution_and_reaches_the_cut():
    bins = boost.new_load_bins(LOAD_NA, cut_kpa=170.0, top=180.0, digits=0)
    assert len(bins) == len(LOAD_NA) and bins == sorted(set(bins))
    assert bins[-1] >= 170 and sum(1 for b in bins if b > boost.ATM_REF_KPA) == 4
    assert boost.new_load_bins([50.0, 100.0], 170.0, 180.0, 0) is None  # too few rows to lay out


@pytest.mark.parametrize("name,index,value,expect", [
    ("advTable1", 13 * 16 + 5, 45.0, "advance"),
    ("veTable", 13 * 16 + 5, 1.0, "VE"),
    ("afrTable", 13 * 16 + 5, 15.6, "leaner"),
    ("boostLimit", 0, 400.0, "boost cut"),
    ("boostTable", 3, 260.0, "more than"),
    ("hardRevLim", 0, 8000.0, "rev limit"),
])
def test_verify_refuses_a_tampered_plan(name, index, value, expect):
    raw = sp()
    doc, tmap, _, plan = plan_for(raw)
    plan.changes.setdefault(name, {})[str(index)] = value
    with pytest.raises(boost.BoostError, match=expect):
        boost.create(raw, doc, tmap, plan)


def test_the_written_tune_still_passes_tune_health():
    from app import checks
    _, new, _ = built(sp())
    featured, other = all_tables(new, resolve_map(new))
    results = checks.run(new, featured + other)
    assert not [r for r in results if r["status"] == "error"]


# ------------------------------------------------------------------ the page

@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path, uploads_per_hour=10)
    with TestClient(app, follow_redirects=False) as c:
        yield c


def upload(client, data):
    r = client.post("/upload", files={"file": ("tune.msq", data, "application/octet-stream")})
    return re.fullmatch(r"/t/([A-Za-z0-9]{10})", r.headers["location"]).group(1)


def test_the_dash_links_to_boost_prep(client):
    slug = upload(client, sp())
    page = client.get(f"/t/{slug}").text
    assert f'href="/t/{slug}/boost"' in page and "Prep for boost" in page
    assert "stop at 100 kPa" in page  # the Dash card says what the tune is today


def test_preview_then_create(client):
    slug = upload(client, sp())
    page = client.get(f"/t/{slug}/boost")
    assert page.status_code == 200 and "Wastegate spring" in page.text and "reads up to 250 kPa" in page.text

    form = {**BASE, "action": "preview"}
    preview = client.post(f"/t/{slug}/boost", data=form)
    assert preview.status_code == 200
    assert "7 psi" in preview.text and "Boost cut" in preview.text and "First drive" in preview.text
    sig = re.search(r'name="plan_sig" value="([a-f0-9]+)"', preview.text).group(1)

    no_ack = client.post(f"/t/{slug}/boost", data={**form, "action": "create", "plan_sig": sig})
    assert no_ack.status_code == 400 and "Tick the box" in no_ack.text

    stale = client.post(f"/t/{slug}/boost", data={**form, "action": "create", "plan_sig": "0" * 16,
                                                  "acknowledge": "yes"})
    assert stale.status_code == 409 and "answers changed" in stale.text

    made = client.post(f"/t/{slug}/boost", data={**form, "action": "create", "plan_sig": sig, "acknowledge": "yes"})
    assert made.status_code == 303
    new_slug = made.headers["location"].rsplit("/", 1)[1]
    assert client.get(f"/t/{new_slug}.json").json()["parent"] == slug
    assert client.get(f"/t/{slug}.msq").content == sp()  # the original is untouched
    made_doc = parse_msq(client.get(f"/t/{new_slug}.msq").content)
    assert made_doc.get("boostLimit").value == 170 and max(made_doc.get("fuelLoadBins").values) == 180


def test_a_blocked_setup_cant_be_created(client):
    slug = upload(client, sp())
    form = {**BASE, "wideband": "", "action": "preview"}
    preview = client.post(f"/t/{slug}/boost", data=form)
    assert "wideband" in preview.text and 'name="plan_sig"' not in preview.text
    ans, _ = boost.parse_answers(form)
    refused = client.post(f"/t/{slug}/boost", data={**form, "action": "create", "acknowledge": "yes",
                                                    "plan_sig": ans.signature()})
    assert refused.status_code == 400 and "needs fixing" in refused.text
    assert len(client.get("/compare").text) > 0  # nothing was stored
