"""Live tuning: reading the ECU definition, and the session relay between the car page and tuners."""
import os
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
    for blocked in ("boostPwmFrequency", "injector_flow", "rpmHardLimit"):
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
