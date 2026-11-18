"""TunerStudio's menus and settings dialogs, read from the ECU's .ini for the live page."""
from app import ecuini
from conftest import FIXTURES

INI = (FIXTURES / "sample_fome.ini").read_text("latin-1")


def test_bit_options_keep_their_values_and_drop_placeholders():
    c = ecuini.parse(INI)["constants"]
    assert c["idleMode"]["options"] == [[0, "Open Loop + Closed Loop"], [1, "Open Loop"]]
    assert c["isInjectionEnabled"]["options"] == [[0, "false"], [1, "true"]]
    assert c["isInjectionEnabled"]["bits"] == [0, 0] and c["idleMode"]["bits"] == [1, 1]
    # pins: the sparse value="label" form
    assert c["idle_solenoidPin"]["options"] == [[0, "NONE"], [105, "A1  - INJ 1"], [71, "A10 - IGN 2"]]
    assert c["engineType"]["options"] == [[0, "DEFAULT_FRANKENSO"], [1, "TEST"]]
    assert ecuini._bit_options(['"A"', '"INVALID"', '""', '"B"']) == [[0, "A"], [3, "B"]]
    assert c["engineMake"] == {"kind": "string", "type": "U08", "offset": 1732, "page": 1, "len": 32}


def test_menus_are_read_with_groups_separators_and_conditions():
    menus = ecuini.parse(INI)["menus"]
    assert [m["title"] for m in menus] == ["Base Engine", "Idle"]
    base = menus[0]["items"]
    assert base[0] == {"target": "engineChars", "label": "Base engine", "cond": None}
    assert base[1] == {"sep": True}
    assert base[2] == {"group": "Warmup", "items": [
        {"target": "cltFuelCorrCurve", "label": "Warmup fuel", "cond": "isInjectionEnabled"}]}


def test_dialog_items_fields_panels_sliders_buttons_and_presets():
    d = ecuini.parse(INI)["dialogs"]
    idle = d["idleSettings"]
    assert idle["layout"] == "yAxis" and idle["title"] == ""
    items = idle["items"]
    assert items[0] == {"k": "field", "label": "Idle control mode", "name": "idleMode", "en": None, "vis": None}
    assert items[1]["name"] is None and items[1]["label"].startswith("! Solenoid")  # a red info line
    assert items[2] == {"k": "panel", "name": "idleOpenLoop", "en": None, "vis": None}  # placement isn't a condition
    assert items[3] == {"k": "panel", "name": "idlePid", "en": "1", "vis": "idleMode == 0"}
    assert items[4] == {"k": "cmd", "label": "Reset idle", "cmd": "cmd_reset_idle", "en": "idleMode == 0"}
    assert items[5]["k"] == "preset" and items[5]["en"] == "isInjectionEnabled"
    assert items[5]["options"][0] == {"label": "Valve A", "set": {"manIdlePosition": 30.0, "crankingIACposition": 50.0}}
    pid = d["idlePid"]["items"]
    assert pid[0] == {"k": "field", "label": "P gain", "name": "idleRpmPid_pFactor", "en": "idleMode == 0",
                      "vis": "isInjectionEnabled"}
    # a line missing its comma between the label and the setting, with a literal "enabled" before the condition
    assert pid[1] == {"k": "field", "label": "!!! PLEASE UNSELECT !!!", "name": "idle_solenoidPin", "en": "1",
                      "vis": "idle_solenoidPin != 0"}
    assert d["idleOpenLoop"]["items"][1] == {"k": "slider", "label": "Manual position", "name": "manIdlePosition", "en": None}
    assert d["engineChars"]["items"][2]["label"] == "#These are read from the ECU"


def test_help_text_and_labels():
    ini = ecuini.parse(INI)
    assert ini["help"]["idleMode"] == "Open loop uses only the table.\nClosed loop adds a PID on top."
    assert ini["labels"]["idleRpmPid_pFactor"] == "P gain"


def test_live_layout_carries_reachable_dialogs_and_every_constant_they_use():
    ini = ecuini.parse(INI)
    live = ecuini.layout_for_live(ini)
    ui = live["ui"]
    # std_realtime is TunerStudio's own screen: left out; the separator stays between real entries
    assert [[i.get("target") or i.get("group") or "-" for i in m["items"]] for m in ui["menus"]] == \
        [["engineChars", "-", "Warmup"], ["idleSettings"]]
    assert set(ui["dialogs"]) == {"engineChars", "idleSettings", "idleOpenLoop", "idlePid"}  # not "unreachable"
    for n in ("idleMode", "idle_solenoidPin", "manIdlePosition", "crankingIACposition", "isInjectionEnabled",
              "engineMake", "cylindersCount", "idleRpmPid_pFactor"):
        assert n in live["constants"], n
    assert live["constants"]["idleMode"]["label"] == "Idle control mode"
    assert ui["help"] == {"idleMode": ini["help"]["idleMode"]}
    # what a remote tuner may change doesn't grow: pins and the like stay at the car
    assert "idle_solenoidPin" not in live["editable"] and "idleMode" not in live["editable"]


def test_the_cars_own_ini_opens_every_menu_dialog():
    from pathlib import Path
    import pytest
    p = Path.home() / "Desktop/Wagovan/projectCfg/mainController.ini"
    if not p.exists():
        pytest.skip("the car's project isn't on this machine")
    live = ecuini.layout_for_live(ecuini.parse(p.read_text("latin-1"), {"AFR"}))
    ui, c = live["ui"], live["constants"]
    for name in ("idleSettings", "ignitionSettings", "triggerConfiguration", "engineChars", "mapSettings",
                 "crankingDialog", "AccelEnrich", "injectorConfig"):
        assert name in ui["dialogs"], name
    curves = {cv["id"] for cv in live["curves"]}
    tables = {t["id"] for t in live["tables"]}
    for d in ui["dialogs"].values():
        for it in d["items"]:
            if it["k"] == "field" and it["name"]:
                assert it["name"] in c, it["name"]
            if it["k"] == "panel":
                assert it["name"] in ui["dialogs"] or it["name"] in curves or it["name"] in tables or \
                    it["name"] in ui["indicatorPanels"], it["name"]
    assert "injectorsDeadTime" in curves
