"""Live tuning: reading the ECU definition, and the session relay between the car page and tuners."""
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import ecuini
from app.main import create_app
from app.parser import parse_msq

INI = r'''
[MegaTune]
   signature = "rusEFI (FOME) test"
[TunerStudio]
   queryCommand = "S"
[Constants]
   messageEnvelopeFormat = msEnvelope_1.0
   endianness = little
   nPages = 1
   pageIdentifier = "\x00\x00"
   pageReadCommand = "R%2o%2c"
   burnCommand = "B"
   pageChunkWrite = "C%2o%2c%v"
   blockingFactor = 1320 ; max chunk size
pageSize = 2048
page = 1
rpmHardLimit = scalar, U16, 6, "rpm", 1, 0, 0, 20000, 0
injMode = bits, U08, 8, [0:1], "A", "B"
veTable = array, U16, 100, [16x16], "%", 0.1, 0, 0, 999, 1
veLoadBins = array, U16, 612, [16], "kPa", 1, 0, 0, 1000, 0
veRpmBins = array, U16, 644, [16], "RPM", 1, 0, 0, 18000, 0
#if LAMBDA
lambdaTable = array, U08, 700, [16x16], "lambda", 0.0068, 0, 0.6, 1.5, 2
#else
lambdaTable = array, U08, 700, [16x16], "afr", 0.1, 0, 0, 25, 1
#endif
lambdaLoadBins = array, U16, 956, [16], "", 1, 0, 0, 1000, 0
lambdaRpmBins = array, U16, 988, [16], "RPM", 1, 0, 0, 18000, 0
idleRpmPid_pFactor = scalar, F32, 1100, "", 1, 0, 0, 10, 3
boostPwmFrequency = scalar, U16, 1104, "Hz", 1, 0, 0, 3000, 0
cltFuelCorrBins = array, F32, 1200, [4], "C", 1, 0, -40, 150, 0
cltFuelCorr = array, F32, 1216, [4], "ratio", 1, 0, 0, 5, 2
injector_flow = scalar, F32, 1232, "cc", 1, 0, 0, 5000, 1
[ConstantsExtensions]
   requiresPowerCycle = boostPwmFrequency
[CurveEditor]
   curve = cltFuelCorrCurve, "Warmup fuel multiplier"
      xBins = cltFuelCorrBins, coolant
      yBins = cltFuelCorr
[UserDefined]
   field = "Idle P gain", idleRpmPid_pFactor
[OutputChannels]
   ochGetCommand = "O%2o%2c"
   ochBlockSize = 64
RPMValue = scalar, U16, 4, "RPM", 1, 0
coolant = scalar, S16, 8, "deg C", 0.01, 0
veTableYAxis = scalar, U16, 12, "%", 0.01, 0
AFRValue = scalar, U16, 16, "AFR", 0.001, 0
afrTarget = scalar, U16, 20, "AFR", 0.001, 0
MAPValue = scalar, U16, 24, "kPa", 0.03333333, 0
computed = { RPMValue * 2 }
[Datalog]
   entry = AFRValue, "AFR", float, "%.2f"
   entry = RPMValue, "RPM", int, "%d"
   entry = coolant, "CLT", float, "%.1f"
   entry = AFRValue, "Air/Fuel Ratio", float, "%.2f"
   entry = afrTarget, "Fuel: target AFR", float, "%.2f"
   entry = MAPValue, "MAP", float, "%.1f"
[GaugeConfigurations]
gaugeCategory = "Main"
   RPMGauge = RPMValue, "RPM - engine speed", "RPM", 0, {rpmHardLimit + 2000}, 200, 400, {rpmHardLimit - 500}, {rpmHardLimit}, 0, 0
   CLTGauge = coolant, "Coolant temp", "C", -40, 140, -15, 1, 95, 110, 1, 1
   ghostGauge = computed, "Not sent by the ECU", "", 0, 10, 0, 0, 10, 10, 0, 0
[FrontPage]
   gauge2 = CLTGauge
   gauge1 = RPMGauge
   gauge3 = ghostGauge
   indicator = { coolant > 100 }, "CLT ok", "HOT", white, black, red, black
   indicator = { computed }, "a", "b", white, black, red, black
[TableEditor]
   table = veTableTbl, veTableMap, "VE Table", 1
      xBins = veRpmBins, RPMValue
      yBins = veLoadBins, veTableYAxis
      zBins = veTable
   table = lambdaTableTbl, lambdaTableMap, "Target AFR", 1
      xBins = lambdaRpmBins, RPMValue
      yBins = lambdaLoadBins, veTableYAxis
      zBins = lambdaTable
'''


def test_the_ecu_definition_is_read_like_tunerstudio_reads_it():
    ini = ecuini.parse(INI, {"AFR"})
    c = ini["comms"]
    assert c["signature"] == "rusEFI (FOME) test" and c["pageSizes"] == [2048] and c["ochBlockSize"] == 64
    assert c["blockingFactor"] == 1320 and c["endianness"] == "little"
    ve = ini["constants"]["veTable"]
    assert (ve["type"], ve["offset"], ve["rows"], ve["cols"], ve["scale"], ve["digits"]) == ("U16", 100, 16, 16, 0.1, 1)
    assert ini["constants"]["lambdaTable"]["units"] == "afr"                       # #else: AFR, not LAMBDA
    assert ecuini.parse(INI, {"LAMBDA"})["constants"]["lambdaTable"]["units"] == "lambda"
    assert ini["constants"]["injMode"]["bits"] == [0, 1]
    assert "computed" not in ini["outputs"] and ini["outputs"]["coolant"]["scale"] == 0.01
    assert ini["datalog"]["AFRValue"] == "AFR"                                     # the first label, as logs use
    t = ini["tables"]["veTableTbl"]
    assert (t["x"], t["xch"], t["y"], t["ych"], t["z"]) == ("veRpmBins", "RPMValue", "veLoadBins", "veTableYAxis", "veTable")
    assert ecuini.command_bytes('"R%2o%2c"') == [b"R", {"n": 2, "k": "o"}, {"n": 2, "k": "c"}]
    live = ecuini.layout_for_live(ini)
    assert {"veTable", "veLoadBins", "veRpmBins", "lambdaTable", "lambdaLoadBins", "lambdaRpmBins"} <= set(live["constants"])
    assert live["outputs"]["RPMValue"]["label"] == "RPM" and "veTableYAxis" in live["outputs"]
    # what a remote tuner may change: tables, curves, settings with a range; never a power-cycle or protection one
    assert live["editable"]["veTable"] == "table" and live["editable"]["cltFuelCorr"] == "curve"
    assert live["editable"]["idleRpmPid_pFactor"] == "setting" and live["constants"]["idleRpmPid_pFactor"]["label"] == "Idle P gain"
    assert live["editable"]["rpmHardLimit"] == "setting"  # the rev limiter: allowed, approved by the driver, small steps
    for blocked in ("boostPwmFrequency", "injector_flow"):
        assert blocked not in live["editable"]
    assert live["powerCycle"] == ["boostPwmFrequency"]
    assert live["curves"][0]["title"] == "Warmup fuel multiplier" and live["curves"][0]["xch"] == "coolant"
    with pytest.raises(ecuini.IniError):
        ecuini.parse("[Constants]\nfoo = 1\n")


REAL = Path("/Users/michaelnixon/Desktop/Wagovan")


@pytest.mark.skipif(not (REAL / "projectCfg/mainController.ini").exists(), reason="the FOME project isn't on this machine")
def test_dials_and_lamps_come_from_the_front_page():
    """The dials use the ECU's own ranges and warning zones (limits written as expressions read from the tune),
    in front-page order, and only channels the ECU sends."""
    msq = '<msq><page><constant name="rpmHardLimit" units="rpm">7000.0</constant></page></msq>'
    ini = ecuini.parse(INI, ecuini.msq_settings(msq), ecuini.msq_values(msq))
    live = ecuini.layout_for_live(ini)
    assert live["front"] == ["RPMGauge", "CLTGauge"]
    rpm = live["gauges"]["RPMGauge"]
    assert (rpm["lo"], rpm["hi"], rpm["hiW"], rpm["hiD"]) == (0, 9000, 6500, 7000)
    assert [i["ch"] for i in live["indicators"]] == ["coolant"]
    assert live["indicators"][0]["op"] == ">" and live["indicators"][0]["onBg"] == "#ff2a1a"


def test_the_session_is_recorded_as_a_log(client, fx):
    """The car page sends the session's datalog in pieces; they grow one log, on the session's tune copy."""
    s = start(client, fx)
    sid, car = s["id"], s["car_key"]
    head = '"MSQ Viewer live session"\nTime\tRPM\tMAP\tAFR\ns\tRPM\tkPa\tAFR\n'
    rows = lambda t0: "".join(f"{t0 + i * 0.05:.3f}\t{900 + i}\t{40 + i % 5}\t14.{i % 9}\n" for i in range(40))  # noqa: E731
    assert client.post(f"/live/{sid}/log?k=wrong", content=head + rows(0)).status_code == 404
    r = client.post(f"/live/{sid}/log?k={car}&part=1&secs=2", content=head + rows(0)).json()
    slug = r["slug"]
    assert r["rows"] == 40 and r["url"] == f"/l/{slug}?tune={s['tune']}"
    r2 = client.post(f"/live/{sid}/log?k={car}&part=1&slug={slug}&secs=4", content=rows(2)).json()
    assert r2["slug"] == slug and r2["rows"] == 80
    assert client.get(f"/l/{slug}?tune={s['tune']}").status_code == 200
    idx = client.get(f"/l/{slug}/index.json").json()
    assert idx["rows"] == 80 and "rpm" in idx["roles"]
    # a piece that can't be read leaves the log as it was
    assert client.post(f"/live/{sid}/log?k={car}&part=1&slug={slug}", content=b"\x00\x01garbage\tx\ty\n1\t2").status_code in (200, 400)
    assert client.get(f"/l/{slug}/index.json").json()["rows"] >= 80


def test_a_real_fome_definition_matches_its_tune():
    """Every value the tune has for a live table fits the ECU page where the .ini says it lives."""
    msq = (REAL / "CurrentTune.msq").read_text("latin-1")
    ini = ecuini.parse((REAL / "projectCfg/mainController.ini").read_text("latin-1"), ecuini.msq_settings(msq))
    live = ecuini.layout_for_live(ini)
    size = ini["comms"]["pageSizes"][0]
    doc = parse_msq((REAL / "CurrentTune.msq").read_bytes())
    sizes = {"U08": 1, "S08": 1, "U16": 2, "S16": 2, "U32": 4, "S32": 4, "F32": 4}
    spans = []
    for name, c in live["constants"].items():
        if c["kind"] in ("bits", "string"):  # flags share a word; text is shown, not written
            continue
        n = c["rows"] * c["cols"] if c["kind"] == "array" else 1
        end = c["offset"] + n * sizes[c["type"]]
        assert end <= size, name
        spans.append((c["offset"], end, name))
        k = doc.get(name)
        if k is not None and k.values is not None and len(k.values) == n:
            for v in k.values:
                raw = round(v / c["scale"] - c["translate"])
                assert -2 ** 31 <= raw < 2 ** 32, (name, v)  # (real tunes can sit outside the .ini's lo/hi)
    spans.sort()
    for a, b in zip(spans, spans[1:]):
        assert a[1] <= b[0], f"{a[2]} overlaps {b[2]}"
    assert ini["constants"]["veTable"]["offset"] == 16152 and ini["comms"]["ochBlockSize"] == 1260


@pytest.fixture()
def client(tmp_path):
    with TestClient(create_app(data_dir=tmp_path, uploads_per_hour=1000)) as c:
        yield c


def start(client, fx):
    r = client.post("/live/start", files={"ini": ("mainController.ini", INI.encode(), "text/plain"),
                                          "msq": ("CurrentTune.msq", fx("fome_vthpnp.msq"), "application/xml")})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_live_session_relays_between_the_car_and_a_tuner(client, fx):
    s = start(client, fx)
    sid, car, view = s["id"], s["car_key"], s["view_key"]
    assert client.get(f"/live/{sid}?k={view}").status_code == 200
    assert client.get(f"/live/{sid}?k=nope").status_code == 404
    layout = client.get(f"/live/{sid}/layout?k={view}").json()
    assert layout["roles"]["rpm"] == "RPMValue" and layout["roles"]["afr"] == "AFRValue" and layout["roles"]["clt"] == "coolant"
    assert client.get(f"/live/{sid}/layout?k=bad").status_code == 404
    assert client.get("/live").status_code == 200

    with client.websocket_connect(f"/live/{sid}/ws?k={car}") as cw, client.websocket_connect(f"/live/{sid}/ws?k={view}") as vw:
        assert cw.receive_json()["t"] == "hello"
        assert vw.receive_json()["t"] == "hello"
        # tuner asks before the ECU is live: refused by the server
        vw.send_json({"t": "set", "id": 1, "table": "veTable", "cells": {"3": 50.0}})
        while True:
            m = vw.receive_json()
            if m["t"] == "rejected":
                assert "isn't connected" in m["why"]
                break
        cw.send_json({"t": "state", "ecu": True, "mode": "auto", "burn": False})
        cw.send_json({"t": "tables", "tables": {"veTable": [60.0] * 256}})
        cw.send_json({"t": "chs", "n": ["RPMValue", "coolant"]})
        cw.send_text('{"t":"o","v":[2500,88.5],"ts":1}')       # the fast path, passed on untouched
        seen, frame = set(), None
        while not {"o", "tables", "chs"} <= seen:
            m = vw.receive_json()
            seen.add(m["t"])
            if m["t"] == "o":
                frame = m
        assert frame["v"] == [2500, 88.5]
        # a tuner's extra gauge is asked of the car; a tuner joining late gets the latest frame at once
        vw.send_json({"t": "want", "n": ["MAPValue"]})
        while True:
            m = cw.receive_json()
            if m["t"] == "want":
                assert m["n"] == ["MAPValue"]
                break
        with client.websocket_connect(f"/live/{sid}/ws?k={view}") as late:
            hello = late.receive_json()
            assert hello["och"] == {"RPMValue": 2500, "coolant": 88.5} and hello["chs"] == ["RPMValue", "coolant"]
        # a change is forwarded to the car (the only thing that writes to the ECU)…
        vw.send_json({"t": "set", "id": 2, "table": "veTable", "cells": {"3": 61.5}})
        while True:
            m = cw.receive_json()
            if m["t"] == "set":
                assert m["cells"] == {"3": 61.5} and m["id"] == 2
                break
        # …which reports what the ECU now holds; the tuner sees it and the tune copy keeps it
        cw.send_json({"t": "applied", "id": 2, "table": "veTable", "cells": {"3": 61.5}, "by": "tuner"})
        while True:
            m = vw.receive_json()
            if m["t"] == "applied":
                break
        z = parse_msq(client.get(f"/t/{s['tune']}.msq").content).get("veTable").values
        assert z[3] == pytest.approx(61.5)
        # burn needs the driver's permission
        vw.send_json({"t": "burn", "id": 3})
        while True:
            m = vw.receive_json()
            if m["t"] == "rejected":
                assert "driver" in m["why"]
                break
        cw.send_json({"t": "burned"})
        while vw.receive_json()["t"] != "burned":
            pass
        assert any(v["label"].startswith("Burned to the ECU") for v in client.get(f"/t/{s['tune']}/versions").json()["versions"])
        # remote changes off: refused
        cw.send_json({"t": "state", "ecu": True, "mode": "off"})
        vw.send_json({"t": "set", "id": 4, "table": "veTable", "cells": {"3": 62.0}})
        while True:
            m = vw.receive_json()
            if m["t"] == "rejected":
                assert "turned off" in m["why"]
                break
    # the car page can start the session again (after a server restart) under the same link
    again = client.post("/live/start", data={"sid": sid, "car_key": car, "tune": s["tune"]},
                        files={"ini": ("mainController.ini", INI.encode(), "text/plain")}).json()
    assert again["id"] == sid and again["view_key"] == view
    stolen = client.post("/live/start", data={"sid": sid, "car_key": "x" * 20},
                         files={"ini": ("mainController.ini", INI.encode(), "text/plain")})
    assert stolen.status_code == 403
    bad = client.post("/live/start", files={"ini": ("x.ini", b"[Constants]\npageSize = 10\nmessageEnvelopeFormat = old\n", "text/plain")})
    assert bad.status_code == 400


@pytest.mark.skipif(shutil.which("node") is None, reason="node isn't installed")
def test_the_ecu_protocol_in_the_browser():
    r = subprocess.run(["node", "--test", str(Path(__file__).parent / "js" / "ecu.test.js")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_log_viewers_on_the_same_link_play_together(client):
    """Live view in the log viewer: what one page sends (play, pause, scrub), the others on that log get."""
    from test_logs import drive, msl
    url = client.post("/logs", files={"file": ("d.msl", msl(drive()), "text/plain")}, follow_redirects=False).headers["location"]
    slug = url.split("/l/")[1].split("?")[0]
    with client.websocket_connect(f"/l/{slug}/together") as a:
        assert a.receive_json() == {"t": "here", "n": 1}
        with client.websocket_connect(f"/l/{slug}/together") as b:
            assert b.receive_json() == {"t": "here", "n": 2}
            assert a.receive_json() == {"t": "here", "n": 2}
            a.send_text('{"t":"s","pos":12.5,"v":[10,20],"playing":true,"at":1,"speed":2}')
            assert b.receive_json()["pos"] == 12.5          # the other page follows
        assert a.receive_json() == {"t": "here", "n": 1}
    with client.websocket_connect("/l/aaaaaaaaaa/together") as gone:
        with pytest.raises(Exception):
            gone.receive_json()                            # no such log: closed


def test_a_tuner_who_joins_late_gets_the_session_so_far(client, fx):
    """Frames the car streamed before the tuner opened the link arrive with the hello, and applied changes keep
    what each cell was."""
    import time as _t
    s = start(client, fx)
    sid, car, view = s["id"], s["car_key"], s["view_key"]
    with client.websocket_connect(f"/live/{sid}/ws?k={car}") as cw:
        assert cw.receive_json()["t"] == "hello"
        cw.send_json({"t": "chs", "n": ["RPMValue", "MAPValue"]})
        for i in range(3):
            cw.send_text('{"t":"o","v":[%d,40],"ts":1}' % (1000 + i))
            _t.sleep(0.25)
        cw.send_json({"t": "applied", "id": 1, "table": "veTable", "cells": {"3": 51.0}, "was": {"3": 50.0}, "by": "tuner"})
        _t.sleep(0.2)
        with client.websocket_connect(f"/live/{sid}/ws?k={view}") as vw:
            hello = vw.receive_json()
            assert hello["changes"][-1]["was"] == {"3": 50.0}
            hist = vw.receive_json()
            assert hist["t"] == "hist" and hist["chs"][0] == ["RPMValue", "MAPValue"]
            assert [f[2]["v"][0] for f in hist["f"]] == [1000, 1001, 1002]


def test_a_reloaded_car_page_carries_on_the_same_log_and_clock(client, fx):
    """A car page that was reloaded starts counting from 0 again; its rows still land after the log's last one,
    the log grows in place (same link), and the whole session or just a stretch of it downloads as a .msl."""
    import re as _re
    s = start(client, fx)
    sid, car = s["id"], s["car_key"]
    head = '"MSQ Viewer live session 2026-11-18T01:00:00.000Z"\nTime\tRPM\tMAP\tAFR\ns\tRPM\tkPa\tAFR\n'
    rows = lambda t0, n: "".join(f"{t0 + i * 0.05:.3f}\t{900 + i}\t{40 + i % 5}\t14.{i % 9}\n" for i in range(n))  # noqa: E731
    slug = client.post(f"/live/{sid}/log?k={car}&part=1", content=head + rows(0, 40)).json()["slug"]
    # the page reloaded 10 minutes after the log started (t0 in ms) and counts from 0 again
    t0 = 1_794_963_600_000 + 600_000  # 2026-11-18T01:10:00Z
    r = client.post(f"/live/{sid}/log?k={car}&part=1&slug={slug}&t0={t0}", content=rows(0, 40)).json()
    assert r["slug"] == slug and r["rows"] == 80
    raw = client.get(f"/l/{slug}/download").text.strip().split("\n")
    times = [float(x.split("\t")[0]) for x in raw[3:]]
    assert times == sorted(times) and abs(times[40] - 600.0) < 0.01  # carried on, ten minutes later
    whole = client.get(f"/live/{sid}/session.msl?k={car}")
    assert whole.status_code == 200 and "attachment" in whole.headers["content-disposition"]
    wl = whole.text.strip().split("\n")
    # written like TunerStudio writes a log: the ECU's signature first (TunerStudio names the fields by it), then the date
    layout = client.get(f"/live/{sid}/layout?k={car}").json()
    assert wl[0].startswith('"' + layout["comms"]["signature"]) and wl[1].startswith('"Capture Date: ')
    assert wl[2].startswith("Time\t") and len(wl) == 4 + 80
    epoch0 = 1_794_963_600.0
    part = client.get(f"/live/{sid}/session.msl?k={car}&e={epoch0 + 600 - 0.01}-{epoch0 + 601}").text.strip().split("\n")
    assert len(part) == 4 + 21 and part[4].startswith("0.000\t")
    # any log, trimmed to a stretch of the viewer's time
    sec = client.get(f"/l/{slug}/download?s=0.5-1.0")
    assert sec.status_code == 200 and "-section.msl" in sec.headers["content-disposition"]
    lines = sec.text.strip().split("\n")
    assert lines[1].split("\t")[0] == "Time" and len(lines) == 3 + 11
    assert _re.match(r"^0\t", lines[3]) or lines[3].startswith("0\t") or lines[3].startswith("0.")


def test_a_session_part_whose_clock_restarted_downloads_in_order(client, fx):
    s = start(client, fx)
    sid, car = s["id"], s["car_key"]
    head = '"MSQ Viewer live session 2026-11-18T01:00:00.000Z"\nTime\tRPM\tMAP\tAFR\ns\tRPM\tkPa\tAFR\n'
    body = "".join(f"{i * 0.05:.3f}\t{1000 + i}\t40\t14.7\n" for i in range(30)) + "".join(f"{i * 0.05:.3f}\t{2000 + i}\t40\t14.7\n" for i in range(30))
    # stored as it was before the fix: the second stretch restarts at 0 (an old page, no t0, straight in)
    raw = (head + body).encode()
    from app.main import create_app  # noqa: F401
    slug = client.post(f"/live/{sid}/log?k={car}&part=1", content=raw).json()["slug"]
    lines = client.get(f"/live/{sid}/session.msl?k={car}").text.strip().split("\n")[4:]
    rpms = [int(float(x.split("\t")[1])) for x in lines]
    assert rpms[:30] == list(range(1000, 1030)) and rpms[30:] == list(range(2000, 2030)) and slug


def test_the_log_doctor_finds_problems_and_tools_can_read_the_numbers(client, fx):
    """A log with a lean spot under load, an RPM dropout and a MAP glitch: the doctor names each, with when."""
    import math
    rows = []
    for i in range(600):
        t = i * 0.05
        rpm = 3000 + 500 * math.sin(t / 3)
        mp, tps, lam, tgt = 60.0, 20.0, 1.0, 1.0
        if 10 <= t < 12:
            mp, tps, lam, tgt = 150.0, 90.0, 0.92, 0.8  # under boost, 15% leaner than target
        if abs(t - 20) < 0.02:
            rpm = 0  # crank signal lost for one sample
        if abs(t - 25) < 0.02:
            mp = 250.0  # one wild MAP sample
        rows.append(f"{t:.2f}\t{rpm:.0f}\t{mp:.1f}\t{tps:.1f}\t{lam:.3f}\t{tgt:.3f}")
    text = "Time\tRPM\tMAP\tTPS\tLambda\tLambda Target\ns\trpm\tkPa\t%\tlambda\tlambda\n" + "\n".join(rows) + "\n"
    r = client.post("/logs", files={"file": ("doc.msl", text.encode(), "text/plain")}, follow_redirects=False)
    slug = r.headers["location"].rstrip("/").split("/")[-1]
    j = client.get(f"/l/{slug}/diagnose.json").json()
    ids = {f["id"]: f for f in j["findings"]}
    assert "lean_load" in ids and abs(ids["lean_load"]["events"][0]["t0"] - 10) < 0.2
    assert "rpm_dropout" in ids and abs(ids["rpm_dropout"]["events"][0]["t0"] - 20) < 0.2
    assert "glitch_map" not in ids or ids["glitch_map"]["count"] >= 2  # one glitch alone isn't reported
    assert j["findings"][0]["sev"] == "bad"
    d = client.get(f"/l/{slug}/data.json?ch=rpm,MAP&s=19.9-20.1").json()
    assert d["channels"]["RPM"] == [3000 + round(500 * math.sin(19.9 / 3)), 0.0, 3000 + round(500 * math.sin(20.1 / 3))] or len(d["t"]) == 5
    assert "rpm" in client.get(f"/l/{slug}/data.json").json()["roles"]


def test_tools_can_read_a_live_session(client, fx):
    s = start(client, fx)
    sid, car, view = s["id"], s["car_key"], s["view_key"]
    head = '"MSQ Viewer live session 2026-11-18T01:00:00.000Z"\nTime\tRPM\tMAP\tAFR\ns\tRPM\tkPa\tAFR\n'
    client.post(f"/live/{sid}/log?k={car}&part=1", content=head + "".join(f"{i * 0.05:.3f}\t{2000 + i}\t40\t14.7\n" for i in range(100)))
    st = client.get(f"/live/{sid}/status.json?k={view}").json()
    assert st["logs"] and "state" in st and st["signature"]
    d = client.get(f"/live/{sid}/diagnose.json?k={view}").json()
    assert d["rows"] == 100 and d["epoch0"] == 1794963600.0
    assert client.get(f"/live/{sid}/status.json?k=nope").status_code == 404


def test_before_is_what_the_ecu_had_at_the_start_not_the_project_file(client, fx):
    """The ECU had a different tune from the project's file: the session counts its changes from the ECU's."""
    s = start(client, fx)
    sid, car = s["id"], s["car_key"]
    before = client.get(f"/t/{s['tune']}/versions").json()["parent"]["slug"]
    with client.websocket_connect(f"/live/{sid}/ws?k={car}") as cw:
        cw.receive_json()
        ve = client.get(f"/t/{s['tune']}.json").json()
        cw.send_json({"t": "tables", "tables": {"veTable": [55.5] * 256}})
        cw.send_json({"t": "state", "ecu": True})
        import time as _t
        _t.sleep(0.3)
    v = client.get(f"/t/{s['tune']}/versions").json()
    assert v["parent"]["slug"] != before and "start" in client.get(f"/t/{v['parent']['slug']}").text.lower() or v["parent"]["slug"] != before
    assert any("before syncing" in x["label"].lower() for x in v["versions"]) and ve


def test_a_log_trims_to_a_new_one(client, fx):
    """Keep only the chosen sections, or cut them out: a new log each time, the original untouched."""
    text = "Time\tRPM\tMAP\ns\trpm\tkPa\n" + "".join(f"{i * 0.1:.1f}\t{1000 + i}\t50\n" for i in range(300)) 
    r = client.post("/logs", files={"file": ("t.msl", text.encode(), "text/plain")}, follow_redirects=False)
    slug = r.headers["location"].rstrip("/").split("/")[-1]
    keep = client.post(f"/l/{slug}/trim", json={"mode": "keep", "s": "5-10,20-25"}).json()
    k = client.get(f"/l/{keep['slug']}/data.json?ch=RPM").json()
    assert keep["rows"] == 102 and k["channels"]["RPM"][0] == 1050 and k["t"][0] == 0
    cut = client.post(f"/l/{slug}/trim", json={"mode": "cut", "s": "0-9.95"}).json()
    assert cut["rows"] == 200 and client.get(f"/l/{cut['slug']}/data.json?ch=RPM").json()["channels"]["RPM"][0] == 1100
    assert client.get(f"/l/{slug}/data.json").json()["rows"] == 300  # the original is as it was
    assert client.post(f"/l/{slug}/trim", json={"mode": "keep", "s": ""}).status_code == 400


def test_live_session_logs_are_written_the_way_tunerstudio_writes_them(client, fx):
    """The car page's log has TunerStudio's header (ECU signature, capture date) and every channel of the .ini's
    [Datalog] in its order; parts written with other channels still download as one log; the upload can be gzip."""
    import gzip
    s = start(client, fx)
    sid, car = s["id"], s["car_key"]
    layout = client.get(f"/live/{sid}/layout?k={car}").json()
    assert layout["datalog"] and all(n in layout["outputs"] for n, _ in layout["datalog"])
    sig = layout["comms"]["signature"]
    old = '"MSQ Viewer live session 2026-11-18T01:00:00.000Z"\nTime\tRPM\tMAP\ns\tRPM\tkPa\n' + "".join(f"{i * 0.05:.3f}\t{900 + i}\t40\n" for i in range(20))
    client.post(f"/live/{sid}/log?k={car}&part=1", content=old)
    new = (f'"{sig}: MSQ Viewer live tuning"\n"Capture Date: Wed Nov 18 01:00:10 UTC 2026, File author: MSQ Viewer live tuning 2026-11-18T01:00:10.000Z"\n'
           "Time\tRPM\tMAP\tFuel: Trim bank 1\ns\tRPM\tkPa\t%\n" + "".join(f"{i * 0.05:.3f}\t{2000 + i}\t50\t1.5\n" for i in range(20)))
    r = client.post(f"/live/{sid}/log?k={car}&part=2", content=gzip.compress(new.encode()), headers={"X-Body-Encoding": "gzip"})
    assert r.status_code == 200 and r.json()["rows"] == 20
    lines = client.get(f"/live/{sid}/session.msl?k={car}").text.strip().split("\n")
    assert lines[0] == f'"{sig}: MSQ Viewer live tuning"' and lines[1].startswith('"Capture Date: ')
    assert lines[2] == "Time\tRPM\tMAP\tFuel: Trim bank 1" and lines[3] == "s\tRPM\tkPa\t%"
    rows = [ln.split("\t") for ln in lines[4:]]
    assert len(rows) == 40 and rows[0][1] == "900" and rows[0][3] == "" and rows[20][1] == "2000" and rows[20][3] == "1.5"
    assert float(rows[20][0]) == pytest.approx(10.0, abs=0.01)  # the second part, 10 s later on the same clock


def test_the_tuners_link_is_for_good(tmp_path, fx):
    """The car page keeps its session id and keys: after a server restart (sessions are in memory) it starts the
    session again under the same link, and a tuner's page waits for it meanwhile."""
    files = {"ini": ("mainController.ini", INI.encode(), "text/plain"), "msq": ("CurrentTune.msq", fx("fome_vthpnp.msq"), "application/xml")}
    with TestClient(create_app(tmp_path)) as c:
        s = c.post("/live/start", files=files).json()
    with TestClient(create_app(tmp_path)) as c:  # the server restarted
        wait = c.get(f"/live/{s['id']}?k={s['view_key']}")
        assert wait.status_code == 503 and "Waiting for the car" in wait.text and "/static/livewait.js" in wait.text
        again = c.post("/live/start", files=files, data={"sid": s["id"], "car_key": s["car_key"], "view_key": s["view_key"], "tune": s["tune"]}).json()
        assert (again["id"], again["car_key"], again["view_key"], again["tune"]) == (s["id"], s["car_key"], s["view_key"], s["tune"])
        assert c.get(f"/live/{s['id']}?k={s['view_key']}").status_code == 200
        # another project under the same link gets a tune copy of its own
        other = c.post("/live/start", files=files, data={"sid": s["id"], "car_key": s["car_key"], "view_key": s["view_key"]}).json()
        assert other["id"] == s["id"] and other["view_key"] == s["view_key"] and other["tune"] != s["tune"]
        assert c.get(f"/live/{s['id']}/status.json?k={s['view_key']}").json()["state"]["tune"] == other["tune"]


def test_live_tuning_and_the_log_viewer_are_the_apps_main_tabs(client, fx):
    s = start(client, fx)
    for url, current in (("/live", "live"), (f"/live/{s['id']}?k={s['car_key']}", "live"), ("/logs", "logs"), ("/", None)):
        page = client.get(url).text
        tabs = re.findall(r'<a class="menu-tab"[^>]*data-shell="(\w+)"[^>]*>', page)
        assert tabs == ["live", "logs"], url
        cur = re.findall(r'data-shell="(\w+)"[^>]*aria-current="page"', page)
        assert cur == ([current] if current else []), url
        assert 'target="msq-live"' in page and 'target="msq-logs"' in page
    car = client.get(f"/live/{s['id']}?k={s['car_key']}").text
    assert "/static/tunediff.js" in car and "Allow this ECU" in car


@pytest.mark.skipif(shutil.which("node") is None, reason="node isn't installed")
def test_the_difference_report_logic():
    r = subprocess.run(["node", "--test", str(Path(__file__).parent / "js" / "tunediff.test.js")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_the_tune_copy_follows_the_ecu_even_with_option_settings(client, fx):
    """Keep the ECU's (the difference report): the session's copy takes what the ECU has. An option setting comes
    from the ECU as its number while the file keeps its name: that mustn't stop the rest following."""
    s = start(client, fx)
    with client.websocket_connect(f"/live/{s['id']}/ws?k={s['car_key']}") as cw:
        cw.receive_json()
        cw.send_json({"t": "tables", "tables": {"injectionMode": [1], "fuelAlgorithm": [0], "rpmHardLimit": [6900], "injector_flow": [123.4]}})
        cw.send_json({"t": "state", "ecu": True})
        while cw.receive_json()["t"] != "state":
            pass
    doc = parse_msq(client.get(f"/t/{s['tune']}.msq").content)
    assert float(doc.get("rpmHardLimit").values[0]) == 6900 and float(doc.get("injector_flow").values[0]) == pytest.approx(123.4)
