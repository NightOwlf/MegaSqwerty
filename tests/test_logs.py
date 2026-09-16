"""Reading a datalog: parsing it, what it says about the tune, and the corrections it suggests."""
import re
import struct

import pytest
from fastapi.testclient import TestClient

from app import logs
from app.main import create_app
from app.parser import parse_msq
from app.tablemaps import all_tables, resolve_map
from test_boost import sp

# A tune that already has boost rows, so a boosted log has somewhere to land.
LOAD_BOOST = [25, 30, 40, 45, 50, 60, 65, 75, 80, 85, 95, 100, 120, 140, 160, 180]
CHANNELS = [("Time", "s"), ("RPM", "rpm"), ("MAP", "kPa"), ("TPS", "%"), ("AFR", "afr"), ("AFR Target", "afr"),
            ("Advance", "deg"), ("Knock Retard", "deg"), ("CLT", "C"), ("IAT", "C"), ("Batt V", "V"),
            ("Inj Duty", "%")]


def msl(rows, channels=CHANNELS, header=True) -> bytes:
    lines = ['"speeduino 202501"', '"Capture Date: Tue Sep 15 12:00:00 2026"'] if header else []
    lines += ["\t".join(n for n, _ in channels), "\t".join(u for _, u in channels)]
    lines += ["\t".join(f"{v:g}" for v in r) for r in rows]
    return ("\n".join(lines) + "\n").encode()


def drive(lean=False, knock=False, peak_kpa=170.0, afr_ratio=1.0, hot=False, duty=60.0, pulls=1,
          knock_idle=False):
    """Idle, cruise, then full-throttle pulls, at 20 samples a second."""
    rows, t = [], 0.0
    stoich = 14.7

    def row(rpm, kpa, tps, lam, target, adv, knk=0.0, clt=85.0):
        nonlocal t
        rows.append([round(t, 2), rpm, kpa, tps, round(lam * afr_ratio * stoich, 2), round(target * stoich, 2),
                     adv, knk, clt, 45.0 if not hot else 70.0, 13.8, duty])
        t += 0.05

    for _ in range(100):
        row(850, 35, 0, 1.0, 1.0, 12, 2.0 if knock_idle and len(rows) < 10 else 0.0)
    for _ in range(100):
        row(2500, 60, 20, 1.0, 1.0, 28)
    for _ in range(pulls):
        for k in range(120):
            f = k / 119
            rpm = 2500 + 4500 * f
            kpa = 100 + (peak_kpa - 100) * min(1.0, f * 2)
            lam = 0.95 if lean and kpa > 110 else 0.78
            row(rpm, round(kpa, 1), 92, lam, 0.78, round(8 - 2 * f, 1),
                3.0 if knock and 0.5 < f < 0.6 else 0.0)
        for _ in range(40):
            row(3000, 40, 0, 1.0, 1.0, 25)
    return rows


def tune_bits(**over):
    raw = sp(load=LOAD_BOOST, boostLimit=170, **over)
    doc = parse_msq(raw)
    tmap = resolve_map(doc)
    featured, other = all_tables(doc, tmap)
    return raw, doc, tmap, featured + other


def report(data=None, rows=None, **over):
    raw, doc, tmap, views = tune_bits(**over)
    log = logs.parse_log(data if data is not None else msl(rows if rows is not None else drive()))
    return logs.analyze(log, doc, views, cut_kpa=180.0, map_max=250.0, rev=7000.0)


def texts(r, level):
    return [f.text for f in r.findings if f.level == level]


# ------------------------------------------------------------------ parsing

def test_a_text_log_is_read_with_its_channels_and_units():
    log = logs.parse_log(msl(drive()), "drive.msl")
    assert log.rows == len(drive()) and log.source == "text"
    assert [c.name for c in log.channels][:3] == ["Time", "RPM", "MAP"]
    assert log.by_name("MAP").units == "kPa" and max(log.by_name("MAP").nums) == 170
    assert log.title.startswith("speeduino")


def test_junk_lines_and_commas_dont_stop_it():
    rows = drive()
    body = msl(rows).decode().split("\n")
    body.insert(8, "MARK 3")          # TunerStudio writes markers into logs
    body.insert(20, "1\t2\t3")        # a torn line
    log = logs.parse_log("\n".join(body).encode())
    assert log.rows == len(rows)
    csv = msl(rows).decode().replace("\t", ",").encode()
    assert logs.parse_log(csv, "drive.csv").rows == len(rows)


@pytest.mark.parametrize("data,expect", [
    (b"", "empty"),
    (b"nothing here at all\n", "no row of channel names"),
    (b"a\tb\tc\nx\ty\tz\n", "no data rows"),
    (b"MLVLG\x00\x00\x09rest", "CSV or MSL"),
])
def test_files_that_arent_logs_are_refused(data, expect):
    with pytest.raises(logs.LogError, match=expect):
        logs.parse_log(data, "x.mlg" if data.startswith(b"MLVLG") else "x.msl")


def mlg(channels, rows, version=2) -> bytes:
    """A binary log written to the documented MLVLG layout, for the reader to be checked against."""
    entry = 55 if version == 1 else 89
    size = 4 * len(channels)
    record_len = size + 5
    out = bytearray(b"MLVLG\0" + struct.pack(">HI", version, 0))
    out += struct.pack(">HIHH", 22, 22 + entry * len(channels), record_len, len(channels))
    for name, units in channels:
        field = bytearray(entry)
        field[0] = 6  # F32
        field[1:1 + len(name)] = name.encode()
        field[35:35 + len(units)] = units.encode()
        struct.pack_into(">ff", field, 46, 1.0, 0.0)
        out += field
    for i, r in enumerate(rows):
        out += bytes([0, i % 256]) + struct.pack(">H", i)  # block type, counter, timestamp
        for v in r:
            out += struct.pack(">f", float(v))
        out += b"\0"                                       # trailing checksum byte
    return bytes(out)


@pytest.mark.parametrize("version", [1, 2])
def test_a_binary_mlg_log_is_read(version):
    rows = drive()
    log = logs.parse_log(mlg(CHANNELS, rows, version), "drive.mlg")
    assert log.source == "mlg" and log.rows == len(rows)
    assert log.by_name("RPM").units == "rpm"
    assert max(log.by_name("MAP").nums) == pytest.approx(170, abs=0.01)


def test_an_mlg_that_doesnt_add_up_says_to_export_text():
    data = bytearray(mlg(CHANNELS, drive()))
    struct.pack_into(">H", data, 18, 999)  # a record length its channels can't fill
    with pytest.raises(logs.LogError, match="CSV or MSL"):
        logs.parse_log(bytes(data), "drive.mlg")


@pytest.mark.parametrize("name,role", [("AFR1", "lambda"), ("Lambda", "lambda"), ("O2", "lambda"),
                                       ("AFR Target", "lambda_target"), ("Target Lambda", "lambda_target"),
                                       ("Engine Speed", "rpm"), ("Coolant", "clt"), ("Knock Count", "knock")])
def test_channels_are_found_whatever_the_firmware_calls_them(name, role):
    channels = [("Time", "s"), (name, ""), ("Other", "")]
    log = logs.parse_log(msl([[i * 0.1, 1.0, 2.0] for i in range(10)], channels))
    assert logs.resolve(log).get(role) is not None and logs.resolve(log)[role].name == name


# ------------------------------------------------------------------ what the log says

def test_a_clean_log_says_what_looks_good():
    r = report()
    assert r.summary["tone"] == "ok" and not texts(r, "error")
    good = " ".join(texts(r, "ok"))
    assert "matched the AFR target" in good and "No knock" in good
    assert any("Peak boost was 10 psi" in f.text for f in r.findings)
    assert {s["label"] for s in r.stats} >= {"Peak RPM", "Peak boost", "Leanest in boost"}


def test_lean_in_boost_is_the_first_thing_reported():
    r = report(rows=drive(lean=True))
    assert r.summary["tone"] == "error"
    assert r.findings[0].level == "error" and "Lean in boost" in r.findings[0].text
    assert "λ 0.95" in r.findings[0].text and "rpm" in r.findings[0].where


def test_knock_is_an_error_in_boost_and_suggests_pulling_timing():
    r = report(rows=drive(knock=True))
    assert any("Knock detected" in t for t in texts(r, "error"))
    assert r.timing and r.timing["kind"] == "timing" and r.timing["count"] >= 1
    cell = r.timing["cells"][0]
    assert float(cell["new"]) <= float(cell["old"]) - 2


def test_hitting_the_boost_cut_and_maxing_the_sensor_are_reported():
    r = report(rows=drive(peak_kpa=185.0))
    assert any("hit the cut" in t for t in texts(r, "error"))
    r2 = report(rows=drive(peak_kpa=246.0))
    assert any("top of what the sensor reads" in t for t in texts(r2, "error"))


def test_overheating_and_injector_duty_are_reported():
    rows = [r[:8] + [110.0, 75.0, 13.8, 93.0] for r in drive()]
    r = report(rows=rows)
    assert any("Coolant reached 110" in t for t in texts(r, "error"))
    assert any("Injectors reached 93" in t for t in texts(r, "error"))


def test_units_the_log_used_are_converted_and_said_so():
    channels = [(n, {"MAP": "psi", "CLT": "F", "IAT": "F"}.get(n, u)) for n, u in CHANNELS]
    rows = []
    for r in drive():
        r = list(r)
        r[2] = round((r[2] - 101.325) / 6.894757, 2)  # MAP as gauge psi
        r[8], r[9] = r[8] * 1.8 + 32, r[9] * 1.8 + 32
        rows.append(r)
    r = report(data=msl(rows, channels))
    assert any("logged in psi" in n for n in r.notes) and any("logged in °F" in n for n in r.notes)
    assert any("Peak boost was 10 psi" in f.text for f in r.findings)  # same conclusion as the kPa log


def test_pulls_are_picked_out_of_the_drive():
    r = report(rows=drive(pulls=3, knock=True, lean=True))
    assert len(r.pulls) == 3
    assert r.pulls[0].peak_psi == pytest.approx(10.0, abs=0.2) and r.pulls[0].knock and r.pulls[0].lean
    assert r.pulls[0].rpm_to > r.pulls[0].rpm_from
    # the lean end of the pull is what matters, so it's the leanest (highest) lambda that's reported
    assert r.pulls[0].leanest_lambda == pytest.approx(0.95, abs=0.01)


def test_a_log_with_no_boost_says_so_and_a_missing_channel_is_listed():
    channels = [c for c in CHANNELS if c[0] != "Knock Retard"]
    rows = [r[:7] + r[8:] for r in drive(peak_kpa=100.0)]
    r = report(data=msl(rows, channels))
    assert any("no boost in this log" in t for t in texts(r, "info"))
    assert "knock" in r.missing


def test_the_report_charts_the_drive():
    r = report()
    assert r.charts and r.charts[0]["series"]
    first = r.charts[0]["series"][0]
    assert first["label"] == "RPM" and len(first["points"].split()) > 10


# ------------------------------------------------------------------ corrections

def lean_by(ratio):
    """A drive where the wideband reads `ratio` leaner than target everywhere."""
    return drive(afr_ratio=ratio)


def test_ve_cells_are_corrected_from_the_wideband():
    r = report(rows=lean_by(1.08))
    assert r.ve and r.ve["name"] == "veTable"
    cruise = next(c for c in r.ve["cells"] if c["rpm"] == "2500" and c["kpa"] == "60")
    assert cruise["pct"] == pytest.approx(8.0, abs=1.5)  # 8% lean -> 8% more VE
    assert float(cruise["new"]) > float(cruise["old"]) and cruise["samples"] >= 8
    assert "VE cells can be corrected" in r.ve["text"]


def test_corrections_are_clamped_and_boost_cells_are_barely_leaned_out():
    up = report(rows=lean_by(1.40))
    assert max(c["pct"] for c in up.ve["cells"]) <= 15.01  # never more than 15% in one pass
    down = report(rows=lean_by(0.85))
    boost_cells = [c for c in down.ve["cells"] if c["boost"]]
    assert boost_cells and min(c["pct"] for c in boost_cells) >= -5.01
    assert min(c["pct"] for c in down.ve["cells"]) >= -15.01


def test_transient_and_cold_samples_are_left_out():
    rows = [r[:8] + [50.0] + r[9:] for r in lean_by(1.08)]  # coolant 50 °C: not warmed up
    assert report(rows=rows).ve is None


def test_applying_corrections_writes_a_new_tune():
    raw, doc, tmap, views = tune_bits()
    r = report(rows=lean_by(1.08))
    new_raw, n = logs.apply_suggestion(raw, doc, tmap, r.ve)
    assert n == len(r.ve["changes"])
    new = parse_msq(new_raw)
    for key, want in r.ve["changes"].items():
        assert new.get("veTable").values[int(key)] == pytest.approx(want, abs=0.05)
    for name, c in doc.constants.items():  # nothing else moved
        if name != "veTable":
            assert new.get(name).values == c.values


def test_corrections_that_move_a_cell_too_far_are_refused():
    raw, doc, tmap, views = tune_bits()
    r = report(rows=lean_by(1.08))
    key = next(iter(r.ve["changes"]))
    r.ve["changes"][key] = 250.0
    with pytest.raises(logs.LogError, match="further than a single pass allows"):
        logs.apply_suggestion(raw, doc, tmap, r.ve)


# ------------------------------------------------------------------ the pages

@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path, uploads_per_hour=10)
    with TestClient(app, follow_redirects=False) as c:
        yield c


def upload_tune(client, data):
    r = client.post("/upload", files={"file": ("tune.msq", data, "application/octet-stream")})
    return re.fullmatch(r"/t/([A-Za-z0-9]{10})", r.headers["location"]).group(1)


def upload_log(client, slug, data, name="drive.msl"):
    r = client.post(f"/t/{slug}/log", files={"file": (name, data, "text/plain")})
    assert r.status_code == 303, r.text
    return r.headers["location"].rsplit("/", 1)[1]


def test_upload_a_log_and_read_the_report(client):
    slug = upload_tune(client, sp(load=LOAD_BOOST, boostLimit=170))
    page = client.get(f"/t/{slug}/log")
    assert page.status_code == 200 and "Choose a log file" in page.text
    assert f'href="/t/{slug}/log"' in client.get(f"/t/{slug}").text  # the Dash links to it

    log_slug = upload_log(client, slug, msl(drive(lean=True, knock=True)))
    report_page = client.get(f"/t/{slug}/log/{log_slug}")
    assert report_page.status_code == 200
    assert "Lean in boost" in report_page.text and "Knock detected" in report_page.text
    assert "Full-throttle pulls" in report_page.text and "id=\"dkey\"" in report_page.text
    assert client.get(f"/t/{slug}/log").text.count("srow") >= 1  # listed against the tune
    assert client.get(f"/t/{slug}/log/{log_slug}/download").content.startswith(b'"speeduino')


def test_applying_a_suggestion_from_the_report_makes_a_new_tune(client):
    slug = upload_tune(client, sp(load=LOAD_BOOST, boostLimit=170))
    log_slug = upload_log(client, slug, msl(lean_by(1.08)))
    no_ack = client.post(f"/t/{slug}/log/{log_slug}/apply", data={"kind": "ve"})
    assert no_ack.status_code == 400 and "Tick the box" in no_ack.text
    made = client.post(f"/t/{slug}/log/{log_slug}/apply", data={"kind": "ve", "acknowledge": "yes"})
    assert made.status_code == 303
    new_slug = made.headers["location"].rsplit("/", 1)[1]
    assert client.get(f"/t/{new_slug}.json").json()["parent"] == slug
    before = parse_msq(client.get(f"/t/{slug}.msq").content).get("veTable").values
    after = parse_msq(client.get(f"/t/{new_slug}.msq").content).get("veTable").values
    assert before != after and len(before) == len(after)


def test_a_file_that_isnt_a_log_is_refused(client):
    slug = upload_tune(client, sp())
    r = client.post(f"/t/{slug}/log", files={"file": ("notes.txt", b"hello there", "text/plain")})
    assert r.status_code == 400 and "datalog" in r.text
    for bad in ("Traceback", "/Users/", "site-packages"):
        assert bad not in r.text


def test_a_log_can_be_deleted_with_its_key(client):
    slug = upload_tune(client, sp(load=LOAD_BOOST))
    log_slug = upload_log(client, slug, msl(drive()))
    page = client.get(f"/t/{slug}/log/{log_slug}").text
    key = re.search(r'<code id="dkey" class="mono">([^<]+)</code>', page).group(1)
    assert client.post(f"/t/{slug}/log/{log_slug}/delete", data={"key": "wrong"}).status_code == 403
    assert client.post(f"/t/{slug}/log/{log_slug}/delete", data={"key": key}).status_code == 303
    assert client.get(f"/t/{slug}/log/{log_slug}").status_code == 404


def test_deleting_a_tune_takes_its_logs_with_it(client, tmp_path):
    slug = upload_tune(client, sp(load=LOAD_BOOST))
    log_slug = upload_log(client, slug, msl(drive()))
    key = re.search(r'<code id="dkey" class="mono">([^<]+)</code>', client.get(f"/t/{slug}").text)
    client.request("DELETE", f"/t/{slug}", params={"key": key.group(1)})
    assert client.get(f"/t/{slug}/log/{log_slug}").status_code == 404


def test_knock_lands_in_the_cell_it_happened_in():
    r = report(rows=drive(knock=True))
    cells = r.timing["cells"]
    assert cells and {c["rpm"] for c in cells} <= {"4500", "5000"}  # knock ran 4750-5200 rpm
    assert {c["kpa"] for c in cells} == {"160"}                     # at 170 kPa, nearest bin


def test_knock_early_in_a_log_is_not_dropped():
    """The cell was once located with the sample number instead of the load, which lost early samples."""
    r = report(rows=drive(knock_idle=True))
    assert r.timing and r.timing["cells"]
    cell = r.timing["cells"][0]
    assert cell["rpm"] == "1000" and cell["kpa"] in ("30", "40")  # idle: 850 rpm, 35 kPa
    assert float(cell["new"]) <= float(cell["old"]) - 2


def test_exhaust_temperature_in_fahrenheit_is_read_as_fahrenheit():
    channels = CHANNELS + [("EGT", "F")]
    warm = [r + [1500.0] for r in drive()]    # 1500 °F = 816 °C: hot, not damaging
    r = report(data=msl(warm, channels))
    assert any("logged in °F" in n for n in r.notes)
    assert not any("Exhaust gas" in t for t in texts(r, "error") + texts(r, "warn"))
    hot = [r[:-1] + [1800.0] for r in warm]   # 1800 °F = 982 °C
    r2 = report(data=msl(hot, channels))
    assert any("Exhaust gas temperature reached 982" in t for t in texts(r2, "error"))


def test_a_table_is_only_compared_against_a_log_when_its_load_is_map():
    _, _, _, views = tune_bits()
    spark = next(v for v in views if v.id == "spark")
    assert logs._load_is_map(spark)
    spark.y_units, spark.y_label, spark.load = "%", "TPS", None  # an Alpha-N spark table
    assert not logs._load_is_map(spark)
