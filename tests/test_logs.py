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


def mlg(channels, rows, version=2, marker_at=None) -> bytes:
    """A binary log written to EFI Analytics' published MLVLG layout, for the reader to be checked against.

    v1 has a 2-byte info offset (22-byte header, 55-byte fields); v2 a 4-byte one (24 and 89). The record
    length is the field data alone; each block adds a 4-byte header and a checksum byte. RPM is stored as a
    scaled U16 and the rest as F32, so both the type table and (raw + transform) * scale are exercised."""
    entry, head = (55, 22) if version == 1 else (89, 24)
    kinds = [(2, ">H", 0.5, 10.0) if name == "RPM" else (7, ">f", 1.0, 0.0) for name, _ in channels]
    record_len = sum(struct.calcsize(fmt) for _, fmt, _, _ in kinds)
    begin = head + entry * len(channels)
    out = bytearray(b"MLVLG\0" + struct.pack(">HI", version, 0))
    out += struct.pack(">HIHH" if version == 1 else ">IIHH", 0, begin, record_len, len(channels))
    for (name, units), (kind, _, scale, transform) in zip(channels, kinds):
        field = bytearray(entry)
        field[0] = kind
        field[1:1 + len(name)] = name.encode()
        field[35:35 + len(units)] = units.encode()
        struct.pack_into(">ff", field, 46, scale, transform)
        field[54] = 2
        out += field
    for i, r in enumerate(rows):
        if i == marker_at:
            out += bytes([1, i % 256]) + struct.pack(">H", i) + b"launch".ljust(50, b"\0")
        out += bytes([0, i % 256]) + struct.pack(">H", i)  # block type, counter, timestamp
        for v, (_, fmt, scale, transform) in zip(r, kinds):
            out += struct.pack(fmt, round(v / scale - transform) if fmt == ">H" else float(v))
        out += b"\0"                                       # checksum byte
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
    struct.pack_into(">H", data, 20, 999)  # a record length its channels can't fill
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


# ------------------------------------------------------------------ the log viewer

def test_an_mlg_marker_between_records_is_skipped():
    rows = drive()
    log = logs.parse_log(mlg(CHANNELS, rows, marker_at=50), "drive.mlg")
    assert log.rows == len(rows)
    assert log.by_name("RPM").values[49:52] == pytest.approx([r[1] for r in rows[49:52]], abs=0.5)


def test_an_mlg_channel_is_scaled_the_way_the_format_says():
    rows = drive()
    log = logs.parse_log(mlg(CHANNELS, rows), "drive.mlg")
    rpm = log.by_name("RPM")  # stored as U16 with scale 0.5 and transform 10: (raw + 10) * 0.5
    assert rpm.values[0] == pytest.approx(850, abs=0.5) and rpm.digits == 2
    assert max(rpm.nums) == pytest.approx(7000, abs=0.5)


def test_fome_channel_names_are_recognised():
    names = ["Time", "RPM", "MAP", "Lambda", "Fuel: target lambda", "Ign: Timing Cyl 1", "Knock: Retard",
             "Fuel: injector duty cycle", "Fuel: Last inj pulse width", "Boost: Output"]
    log = logs.LogDoc([logs.Channel(n, "", [1.0, 2.0]) for n in names], 2)
    got = {role: c.name for role, c in logs.resolve(log).items()}
    assert got["lambda_target"] == "Fuel: target lambda" and got["advance"] == "Ign: Timing Cyl 1"
    assert got["knock"] == "Knock: Retard" and got["inj_duty"] == "Fuel: injector duty cycle"
    assert got["pw"] == "Fuel: Last inj pulse width" and got["duty"] == "Boost: Output"


def test_a_log_is_stored_as_columns_the_viewer_can_load(tmp_path):
    import zlib
    import numpy as np
    rows = drive()
    log = logs.parse_log(msl(rows))
    index = logs.build_columns(log, tmp_path / "x.col")
    assert index["rows"] == len(rows) and index["roles"]["rpm"] == 1 and index["roles"]["map"] == 2
    again, base = logs.read_index(tmp_path / "x.col")
    assert again == index
    rpm = again["channels"][1]
    assert rpm["n"] == "RPM" and rpm["u"] == "rpm" and rpm["lo"] == 850 and rpm["hi"] == 7000
    block = logs.read_block(tmp_path / "x.col", base, rpm)
    values = np.frombuffer(zlib.decompress(block), dtype="<f4")
    assert len(values) == len(rows) and values[0] == 850
    t = np.frombuffer(zlib.decompress(logs.read_block(tmp_path / "x.col", base, again["time"])), dtype="<f4")
    assert t[0] == 0 and t[-1] == pytest.approx(rows[-1][0], abs=0.01)


def test_a_log_can_be_uploaded_on_its_own_and_shared(client):
    import numpy as np
    page = client.get("/logs")
    assert page.status_code == 200 and "Choose a log file" in page.text
    assert 'href="/logs"' in client.get("/").text
    rows = drive()
    r = client.post("/logs", files={"file": ("drive.msl", msl(rows), "text/plain")})
    assert r.status_code == 303 and re.fullmatch(r"/l/[A-Za-z0-9]{10}", r.headers["location"])
    url = r.headers["location"]
    viewer = client.get(url)
    assert viewer.status_code == 200 and "drive.msl" in viewer.text and 'id="dkey"' in viewer.text
    assert "viewer.js" in viewer.text and viewer.headers["x-robots-tag"] == "noindex"
    assert 'id="dkey"' not in client.get(url).text  # the key is shown once

    index = client.get(f"{url}/index.json").json()
    assert index["rows"] == len(rows) and index["tables"] == []
    assert [c["n"] for c in index["channels"]][:3] == ["Time", "RPM", "MAP"]
    ch = client.get(f"{url}/ch/{index['roles']['rpm']}")
    assert ch.status_code == 200 and "immutable" in ch.headers["cache-control"]
    values = np.frombuffer(ch.content, dtype="<f4")  # the client undoes the deflate encoding
    assert len(values) == len(rows) and values.max() == 7000
    assert len(client.get(f"{url}/ch/t").content) == 4 * len(rows)
    assert client.get(f"{url}/ch/999").status_code == 404 and client.get(f"{url}/ch/x").status_code == 404
    assert client.get(f"{url}/download").content.startswith(b'"speeduino')

    key = re.search(r'<code id="dkey"[^>]*>([^<]+)</code>', viewer.text).group(1)
    assert client.post(f"{url}/delete", data={"key": "wrong"}).status_code == 403
    assert client.post(f"{url}/delete", data={"key": key}).status_code == 303
    assert client.get(url).status_code == 404 and client.get(f"{url}/index.json").status_code == 404


def test_a_log_uploaded_with_a_tune_link_gets_the_report_and_the_tunes_tables(client):
    slug = upload_tune(client, sp(load=LOAD_BOOST, boostLimit=170))
    r = client.post("/logs", data={"tune": f"https://example.test/t/{slug}"},
                    files={"file": ("drive.msl", msl(drive(lean=True)), "text/plain")})
    assert r.status_code == 303
    url = r.headers["location"]
    assert f'href="/t/{slug}/log/{url[3:]}"' in client.get(url).text  # the viewer links to the report
    assert "Lean in boost" in client.get(f"/t/{slug}/log/{url[3:]}").text
    index = client.get(f"{url}/index.json").json()
    ve = next(t for t in index["tables"] if t["id"] == "ve")
    assert ve["xc"] == index["roles"]["rpm"] and ve["yc"] == index["roles"]["map"]
    assert len(ve["z"]) == ve["rows"] * ve["cols"] and len(ve["x"]) == ve["cols"]

    bad = client.post("/logs", data={"tune": "nope"}, files={"file": ("d.msl", msl(drive()), "text/plain")})
    assert bad.status_code == 400 and "tune link" in bad.text


def test_the_page_uploader_gets_json_back(client):
    r = client.post("/logs", headers={"X-Upload": "1"}, files={"file": ("drive.msl", msl(drive()), "text/plain")})
    assert r.status_code == 200 and re.fullmatch(r"/l/[A-Za-z0-9]{10}", r.json()["url"])
    r = client.post("/logs", headers={"X-Upload": "1"}, files={"file": ("notes.txt", b"hello there", "text/plain")})
    assert r.status_code == 400 and "datalog" in r.json()["error"]


def test_a_log_uploaded_on_its_own_survives_the_purge_and_a_tunes_log_opens_in_the_viewer(client):
    r = client.post("/logs", files={"file": ("drive.msl", msl(drive()), "text/plain")})
    client.app.state.store.purge_stale()
    assert client.get(r.headers["location"]).status_code == 200
    slug = upload_tune(client, sp(load=LOAD_BOOST))
    log_slug = upload_log(client, slug, msl(drive()))
    assert f'href="/l/{log_slug}"' in client.get(f"/t/{slug}/log/{log_slug}").text
    assert client.get(f"/l/{log_slug}").status_code == 200


def test_a_log_bigger_than_a_tune_is_accepted_and_one_over_the_limit_is_not(client, monkeypatch):
    from app import main
    big = msl(drive(pulls=40)) + b"\n" * (main.MAX_BYTES + 1024)  # larger than any tune may be
    r = client.post("/logs", files={"file": ("drive.msl", big, "text/plain")})
    assert r.status_code == 303
    monkeypatch.setattr(main, "LOG_BODY_LIMIT", 1024)
    r = client.post("/logs", files={"file": ("drive.msl", msl(drive()), "text/plain")})
    assert r.status_code == 413 and "too large" in r.text


def test_several_logs_upload_together_and_open_ready_for_ve_analyze(client):
    files = [("file", ("a.msl", msl(drive()), "text/plain")), ("file", ("b.msl", msl(drive(pulls=2)), "text/plain"))]
    r = client.post("/logs", files=files)
    assert r.status_code == 303
    first, also = re.fullmatch(r"/l/([A-Za-z0-9]{10})\?also=([A-Za-z0-9]{10})", r.headers["location"]).groups()
    page = client.get(r.headers["location"]).text
    assert f'data-also="{also}"' in page and page.count('class="mono" data-key-for=') == 2  # both delete keys, once
    assert client.get(f"/l/{also}").status_code == 200
    bad = client.post("/logs", files=[("file", ("a.msl", msl(drive()), "text/plain")),
                                      ("file", ("notes.txt", b"hello there", "text/plain"))])
    assert bad.status_code == 400 and "notes.txt" in bad.text and "uploaded fine" in bad.text and "/l/" in bad.text
    j = client.post("/logs", headers={"X-Upload": "1"}, files=[("file", ("a.msl", msl(drive()), "text/plain")),
                                                               ("file", ("x.txt", b"nope nope", "text/plain"))]).json()
    assert j["partial"] and j["url"].startswith("/l/") and "x.txt" in j["error"]


def test_any_tune_can_be_chosen_for_a_log_in_the_viewer(client):
    slug = upload_tune(client, sp(load=LOAD_BOOST, boostLimit=170))
    r = client.post("/logs", files={"file": ("drive.msl", msl(drive()), "text/plain")})
    url = r.headers["location"]
    assert client.get(f"{url}/index.json").json()["tune"] is None
    index = client.get(f"{url}/index.json?tune={slug}").json()
    assert index["tune"]["slug"] == slug and index["tune"]["stoich"] == pytest.approx(14.7)
    ve = next(t for t in index["tables"] if t["id"] == "ve")
    assert ve["name"] == "veTable" and ve["xc"] == index["roles"]["rpm"]
    assert index["lam"] == {"lambda": 14.7, "lambda_target": 14.7}  # this log's mixture is in AFR
    page = client.get(f"{url}?tune=https://example.test/t/{slug}").text
    assert f'data-tune="{slug}"' in page and "Change tune" in page
    assert 'data-tune=""' in client.get(f"{url}?tune=nonexistent").text
    # a log uploaded with a tune can still be read with none
    own = client.post("/logs", data={"tune": slug}, files={"file": ("d.msl", msl(drive()), "text/plain")})
    assert client.get(f"{own.headers['location']}/index.json?tune=none").json()["tune"] is None


def test_edits_shared_from_the_viewer_reach_whoever_opens_the_link(client):
    """Remote tuning: edit in the viewer, send the link back, the other person sees exactly what changed."""
    slug = upload_tune(client, sp(load=LOAD_BOOST, boostLimit=170))
    url = client.post("/logs", files={"file": ("drive.msl", msl(drive()), "text/plain")}).headers["location"]
    ve = next(t for t in client.get(f"{url}/index.json?tune={slug}").json()["tables"] if t["id"] == "ve")
    first = client.post(f"/t/{slug}/save", json={"changes": {"veTable": {"3": ve["z"][3] + 5}}}).json()
    copy, key = first["slug"], first["key"]
    assert copy != slug and key and first["updated"] is False and first["file"].endswith(f"{copy}.msq")

    # the person who made it saves again: same link, now with both edits
    again = client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"7": ve["z"][7] - 4}}, "key": key}).json()
    assert again["slug"] == copy and again["updated"] is True
    index = client.get(f"{url}/index.json?tune={copy}").json()
    assert index["tune"]["parent"]["slug"] == slug and index["tune"]["changed"] == 2
    t = next(t for t in index["tables"] if t["id"] == "ve")
    assert t["p"] == ve["z"] and t["z"][3] == pytest.approx(ve["z"][3] + 5) and t["z"][7] == pytest.approx(ve["z"][7] - 4)
    assert not any("p" in x for x in index["tables"] if x["id"] != "ve")

    # anyone with the link edits the shared copy (no key needed); "fork" makes a separate one on purpose;
    # the original upload is never overwritten
    theirs = client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"0": 50}}}).json()
    assert theirs["slug"] == copy and theirs["updated"] is True
    sep = client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"1": 52}}, "fork": True}).json()
    assert sep["slug"] not in (copy, slug) and sep["updated"] is False
    assert parse_msq(client.get(f"/t/{copy}.msq").content).get("veTable").values[1] != 52  # the fork didn't touch it
    orig_key = client.post(f"/t/{slug}/save", json={"changes": {"veTable": {"0": 51}}, "key": key}).json()
    assert orig_key["slug"] != slug
    assert client.get(f"{url}/index.json?tune={slug}").json()["tune"]["parent"] is None

    dl = client.get(f"/t/{copy}.msq")
    assert dl.headers["content-type"] == "application/octet-stream" and f'{copy}.msq"' in dl.headers["content-disposition"]


def test_a_tune_can_be_uploaded_from_the_viewer_without_leaving_it(client, fx):
    r = client.post("/upload", headers={"X-Upload": "1"}, files={"file": ("t.msq", fx("ms3_basic.msq"), "application/xml")})
    assert r.status_code == 200 and re.fullmatch(r"[A-Za-z0-9]{10}", r.json()["slug"])
    bad = client.post("/upload", headers={"X-Upload": "1"}, files={"file": ("t.msq", b"nope", "application/xml")})
    assert bad.status_code == 400 and bad.json()["error"]


def test_mlg_markers_are_kept_for_the_viewer(tmp_path):
    rows = drive()
    log = logs.parse_log(mlg(CHANNELS, rows, marker_at=120), "drive.mlg")
    assert log.markers == [(120, "launch")]
    index = logs.build_columns(log, tmp_path / "x.col")
    assert index["markers"] == [[120, "launch"]]


def test_the_report_gives_mixture_as_afr():
    r = report(rows=drive(lean=True))
    lean = next(f for f in r.findings if f.text.startswith("Lean in boost"))
    assert "AFR 14.0 against a target of 11.5" in lean.text
    assert any(s["units"] == "AFR" for s in r.stats)


def test_friends_can_edit_one_tune_together(client):
    """An edit-together link: a second person edits the same copy in place, and both pages see each change."""
    slug = upload_tune(client, sp(load=LOAD_BOOST, boostLimit=170))
    fork = client.post(f"/t/{slug}/save", json={"fork": True}).json()
    copy, owner, ek = fork["slug"], fork["key"], fork["edit_key"]
    assert copy != slug and fork["changed"] == 0 and ek and ek != owner
    rev0 = client.get(f"/t/{copy}/rev").json()["rev"]

    friend = client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"3": 77.7}}, "key": ek}).json()
    assert friend["slug"] == copy and friend["updated"] is True        # the edit key edits in place...
    rev1 = client.get(f"/t/{copy}/rev").json()["rev"]
    assert rev1 != rev0                                                # ...and open pages see the change
    me = client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"4": 66.6}}, "key": owner}).json()
    assert me["slug"] == copy                                          # both edits are on the one tune
    z = parse_msq(client.get(f"/t/{copy}.msq").content).get("veTable").values
    assert z[3] == pytest.approx(77.7) and z[4] == pytest.approx(66.6)

    # notes: anyone on the shared copy's link, never on an original without its key; carried into copies
    assert client.post(f"/t/{slug}/notes", json={"notes": "nope"}).status_code == 403
    assert client.post(f"/t/{copy}/notes", json={"notes": "pulled 2% at 100 kPa"}).json()["ok"]
    assert client.get(f"/t/{copy}/rev").json()["rev"] != client.get(f"/t/{slug}/rev").json()["rev"]
    url = client.post("/logs", files={"file": ("d.msl", msl(drive()), "text/plain")}).headers["location"]
    assert client.get(f"{url}/index.json?tune={copy}").json()["tune"]["notes"] == "pulled 2% at 100 kPa"
    other = client.post(f"/t/{copy}/save", json={"fork": True}).json()
    assert other["slug"] != copy                                       # "make my own copy"
    assert client.get(f"{url}/index.json?tune={other['slug']}").json()["tune"]["notes"] == "pulled 2% at 100 kPa"

    # only the owner can hand out a (new) edit key; the original upload never becomes editable in place
    assert client.post(f"/t/{copy}/editkey", json={"key": ek}).status_code == 403
    assert client.post(f"/t/{copy}/editkey", json={"key": owner}).json()["edit_key"]
    assert client.post(f"/t/{slug}/save", json={"changes": {"veTable": {"6": 44.4}}, "key": ek}).json()["slug"] != slug
    assert client.get("/t/aaaaaaaaaa/rev").status_code == 404


def test_restore_puts_links_back_where_they_were(client, fx):
    """After moving to persistent storage, old links come back under the same slugs (token only, no overwrite)."""
    raw = fx("ms3_basic.msq")
    for path in ("/admin/restore/tune", "/admin/restore/log"):
        no = client.post(path, files={"file": ("t.msq", raw, "application/xml")}, data={"slug": "AbCdEfGhIj"},
                         headers={"Authorization": "Bearer wrong"})
        assert no.status_code == 404  # without the real token it doesn't exist
    assert client.get("/t/AbCdEfGhIj.json").status_code == 404


def test_live_checks_are_cheap(client):
    """What an open page polls is answered from memory and stays current; live updates fetch only the tables."""
    slug = upload_tune(client, sp(load=LOAD_BOOST, boostLimit=170))
    copy = client.post(f"/t/{slug}/save", json={"fork": True}).json()["slug"]
    url = client.post("/logs", files={"file": ("d.msl", msl(drive()), "text/plain")}).headers["location"]
    r0 = client.get(f"/t/{copy}/rev").json()["rev"]
    assert client.get(f"/t/{copy}/rev").json()["rev"] == r0               # cached, unchanged
    client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"2": 61.1}}})
    r1 = client.get(f"/t/{copy}/rev").json()["rev"]
    client.post(f"/t/{copy}/notes", json={"notes": "x"})
    r2 = client.get(f"/t/{copy}/rev").json()["rev"]
    assert len({r0, r1, r2}) == 3                                         # every change shows at once
    lite = client.get(f"{url}/index.json?tune={copy}&lite=1").json()
    assert set(lite) == {"tables", "tune"} and lite["tune"]["rev"] == r2
    full = client.get(f"{url}/index.json?tune={copy}").json()
    assert "channels" in full and len(client.get(f"{url}/index.json?tune={copy}&lite=1").content) < len(
        client.get(f"{url}/index.json?tune={copy}").content)


def test_every_shared_tune_keeps_backups_to_go_back_to(client):
    """Backups before a named change (VE Analyze), on a timer while editing, before a restore; any can be restored."""
    slug = upload_tune(client, sp(load=LOAD_BOOST, boostLimit=170))
    assert client.post(f"/t/{slug}/versions", json={"label": "x"}).status_code == 400  # originals never change
    copy = client.post(f"/t/{slug}/save", json={"changes": {"veTable": {"0": 40.0}}}).json()["slug"]
    ve = lambda: parse_msq(client.get(f"/t/{copy}.msq").content).get("veTable").values

    # the first in-place save backs up (no backup yet), then saves within 10 minutes don't
    client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"0": 41.0}}})
    client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"0": 42.0}}})
    vs = client.get(f"/t/{copy}/versions").json()["versions"]
    assert [v["label"] for v in vs] == ["Auto-save"]
    # applying VE Analyze backs up first, by name
    client.post(f"/t/{copy}/save", json={"changes": {"veTable": {"0": 55.0, "1": 56.0}}, "checkpoint": "Before VE Analyze"})
    vs = client.get(f"/t/{copy}/versions").json()["versions"]
    assert vs[0]["label"] == "Before VE Analyze" and ve()[0] == pytest.approx(55.0)

    # undo VE Analyze: restore that backup; the state just before is backed up too, so this can be undone
    r = client.post(f"/t/{copy}/restore", json={"id": vs[0]["id"]}).json()
    assert r["ok"] and ve()[0] == pytest.approx(42.0)
    assert r["versions"][0]["label"].startswith("Before restoring “Before VE Analyze”")
    client.post(f"/t/{copy}/restore", json={"id": r["versions"][0]["id"]})
    assert ve()[0] == pytest.approx(55.0)
    # all the way back to the tune it was made from
    client.post(f"/t/{copy}/restore", json={"parent": True})
    orig = parse_msq(client.get(f"/t/{slug}.msq").content).get("veTable").values
    assert ve()[0] == pytest.approx(orig[0])
    # a named backup on demand, and any backup downloads as a .msq
    vid = client.post(f"/t/{copy}/versions", json={"label": "Before the 3rd-gear pulls"}).json()["id"]
    dl = client.get(f"/t/{copy}/versions/{vid}.msq")
    assert dl.status_code == 200 and "-backup-" in dl.headers["content-disposition"] and parse_msq(dl.content)
    assert client.post(f"/t/{copy}/restore", json={"id": 999999}).status_code == 404


def _sections(text: str):
    lines = text.strip().split("\n")
    head = [ln for ln in lines if ln.startswith('"')]
    names = lines[len(head)].split("\t")
    units = lines[len(head) + 1].split("\t")
    return head, names, units, lines[len(head) + 2:]


def test_a_downloaded_section_reads_in_tunerstudio_like_the_original(client):
    """TunerStudio picks the ECU's field names (and so VE Analyze's EGO, lambda… channels) from a log's first
    line, the ECU signature: a section downloaded from the viewer keeps the original's header, channel names,
    units and decimals, so it loads back into TunerStudio the same."""
    rows = drive()
    names = [n for n, _ in CHANNELS] + ["Fuel: Trim bank 1"]
    chans = CHANNELS + [("Fuel: Trim bank 1", "%")]
    raw = msl([r + [1.5] for r in rows], chans).replace(b'"speeduino 202501"', b'"rusEFI (FOME) Vthpnp.2026.05.01.vthpnp.2982106365: FOME vthpnp"')
    url = client.post("/logs", files={"file": ("drive.msl", raw, "text/plain")}).headers["location"]
    assert client.get(f"{url}/download").content == raw  # the whole log: byte for byte what was uploaded
    sec = client.get(f"{url}/download?s=2-4").text
    head, n2, u2, body = _sections(sec)
    assert head == ['"rusEFI (FOME) Vthpnp.2026.05.01.vthpnp.2982106365: FOME vthpnp"', '"Capture Date: Tue Sep 15 12:00:00 2026"']
    assert n2 == names and u2 == [u for _, u in chans]
    first = body[0].split("\t")
    assert 2.0 <= float(first[0]) <= 2.06  # the log's own clock, not restarted
    assert first[names.index("Fuel: Trim bank 1")] == "1.5"
    assert "nan" not in sec
    # it reads back exactly as the original does
    a, b = logs.parse_log(raw, "a.msl"), logs.parse_log(sec.encode(), "b.msl")
    assert [c.name for c in a.channels] == [c.name for c in b.channels]
    assert [c.units for c in a.channels] == [c.units for c in b.channels]


def test_a_section_of_an_mlg_keeps_tunerstudios_header():
    data = bytearray(mlg(CHANNELS, drive(), 2))
    info = b'"rusEFI (FOME) Vthpnp.2026: FOME"\n"Capture Date: Mon Oct 05 20:53:35 CDT 2026, File author: TunerStudio"\nNEW_INFO_PROVIDER\n<msq>\0'
    begin = struct.unpack_from(">I", data, 16)[0]
    data[begin:begin] = info  # the info block (TunerStudio puts the tune in it too), just before the records
    data[12:16] = struct.pack(">I", begin)
    data[16:20] = struct.pack(">I", begin + len(info))
    log = logs.parse_log(bytes(data), "x.mlg")
    assert log.rows == len(drive())
    assert log.header == ['"rusEFI (FOME) Vthpnp.2026: FOME"', '"Capture Date: Mon Oct 05 20:53:35 CDT 2026, File author: TunerStudio"']
    assert begin > 0
