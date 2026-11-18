"""Read a TunerStudio ECU definition (.ini): how to talk to the ECU, where every setting lives in its memory,
and the layout of its live data. Live tuning uses this the way TunerStudio does, so it works with whatever
ECU the project is for (FOME/rusEFI, MegaSquirt, Speeduino…) as long as it speaks the framed protocol.

Only what live tuning needs is kept: the comms commands, constants (scalars, arrays and bit fields with
their type, offset, shape, scale and translate), output channels with their log labels, and the table
editor's tables (which constants are the axes and which live channels move the cursor)."""
from __future__ import annotations

import re

TYPES = {"U08": ("B", 1), "S08": ("b", 1), "U16": ("H", 2), "S16": ("h", 2), "U32": ("I", 4), "S32": ("i", 4),
         "F32": ("f", 4)}
_ESC = re.compile(r"\\x([0-9a-fA-F]{2})")


class IniError(ValueError):
    pass


def _strip(line: str) -> str:
    """Drop a ; comment that isn't inside quotes."""
    out, q = [], False
    for ch in line:
        if ch == '"':
            q = not q
        if ch == ";" and not q:
            break
        out.append(ch)
    return "".join(out).strip()


def _fields(rhs: str) -> list[str]:
    """Split on commas outside quotes, brackets and braces."""
    out, cur, depth, q = [], [], 0, False
    for ch in rhs:
        if ch == '"':
            q = not q
        elif not q and ch in "[{":
            depth += 1
        elif not q and ch in "]}":
            depth -= 1
        if ch == "," and not q and depth == 0:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if cur or rhs.endswith(","):
        out.append("".join(cur).strip())
    return out


def _unq(s: str) -> str:
    return s[1:-1] if len(s) >= 2 and s[0] == s[-1] == '"' else s


def _num(s: str, default=None):
    s = _unq(s.strip())
    if s.startswith("{") or not s:
        return default
    try:
        return float(s)
    except ValueError:
        return default


def _bit_options(items: list[str]) -> list:
    """A bits constant's choices as [value, label]: "Open Loop", "Closed Loop" (value = position), or the sparse
    form 0="NONE", 105="A1 - INJ 1" (pins). Placeholders ("INVALID", empty) are left out."""
    out = []
    for i, x in enumerate(items):
        m = re.match(r'^\s*(\d+)\s*=\s*"(.*)"\s*$', x)
        v, label = (int(m.group(1)), m.group(2)) if m else (i, _unq(x.strip()))
        if label.strip() and label.strip().upper() != "INVALID" and not label.startswith("$"):
            out.append([v, label.strip()])
    return out


def _cond(s: str | None) -> str | None:
    """A dialog condition: { expression } (or a bare 0/1) -> the expression text; anything else -> None."""
    if s is None:
        return None
    s = s.strip()
    if s.startswith("{") and s.endswith("}"):
        return s[1:-1].strip() or None
    if re.match(r"^-?\d+(\.\d+)?$", s):
        return s
    return None


_IDENT = re.compile(r"\b[A-Za-z_]\w*\b")


def _label_and_name(first: str, rest: list[str]) -> tuple[str, list[str]]:
    """field = "Label", name, … — and the odd line missing its comma ("Label"   name, …)."""
    m = re.match(r'^"(.*)"\s+(\w+)$', first.strip())
    if m:
        return m.group(1), [m.group(2)] + rest
    return _unq(first.strip()), rest


def command_bytes(template: str) -> list:
    """A command template ("R%2o%2c", "k\\x00\\x00%2o%2c") as literal byte strings and placeholders."""
    parts, i, lit = [], 0, bytearray()
    t = _unq(template)
    while i < len(t):
        m = _ESC.match(t, i)
        if m:
            lit.append(int(m.group(1), 16))
            i = m.end()
            continue
        if t[i] == "%":
            m = re.match(r"%(\d?)([a-z])", t[i:])
            if m:
                if lit:
                    parts.append(bytes(lit))
                    lit = bytearray()
                parts.append({"n": int(m.group(1) or 1), "k": m.group(2)})
                i += m.end()
                continue
        lit.append(ord(t[i]) & 0xFF)
        i += 1
    if lit:
        parts.append(bytes(lit))
    return parts


def _preprocess(lines: list[str], defined: set[str]) -> list[str]:
    """#if / #else / #endif against the project's settings (the selected options, e.g. AFR not LAMBDA)."""
    out, stack = [], []
    for raw in lines:
        s = raw.strip()
        if s.startswith("#if"):
            name = s[3:].strip()
            stack.append(name in defined)
            continue
        if s.startswith("#else"):
            if stack:
                stack[-1] = not stack[-1]
            continue
        if s.startswith("#endif"):
            if stack:
                stack.pop()
            continue
        if s.startswith("#"):
            continue  # #define / #unset and the like
        if all(stack):
            out.append(raw)
    return out


def msq_values(msq_text: str) -> dict:
    """Plain numeric constants in a tune (<constant name="rpmHardLimit">7000.0</constant>), for gauge ranges
    written as expressions like {rpmHardLimit + 2000}."""
    out = {}
    for name, val in re.findall(r'<constant[^>]*\sname="(\w+)"[^>]*>\s*([-\d.eE+]+)\s*</constant>', msq_text or ""):
        try:
            out[name] = float(val)
        except ValueError:
            pass
    return out


_EXPR = re.compile(r"^\{\s*(\w+)\s*(?:([-+*/])\s*([\d.]+))?\s*\}$")


def _gauge_num(s: str, values: dict):
    """A gauge limit: a number, or {constant}, {constant + 2000} and the like, read from the tune."""
    s = s.strip()
    n = _num(s)
    if n is not None:
        return n
    m = _EXPR.match(s)
    if not m or m.group(1) not in values:
        return None
    v, op, k = values[m.group(1)], m.group(2), float(m.group(3) or 0)
    return v + k if op == "+" else v - k if op == "-" else v * k if op == "*" else v / k if op == "/" and k else v


_COLORS = {"white": "#ffffff", "black": "#000000", "red": "#ff2a1a", "yellow": "#ffe600", "green": "#22dd22",
           "blue": "#3366ff", "orange": "#ff9900", "gray": "#a0a0a0", "grey": "#a0a0a0", "cyan": "#00e5ff",
           "magenta": "#ff40ff", "lightgray": "#d6d6d6", "darkgray": "#606060"}
_IND = re.compile(r"^\{\s*(\w+)\s*(?:(!=|==|>|<|>=|<=)\s*(-?[\d.]+))?\s*\}$")


def msq_settings(msq_text: str) -> set[str]:
    """The setting options a tune was saved with (<setting name="AFR" value="AFR"/>)."""
    return set(re.findall(r'<setting\s+name="[^"]*"\s+value="([^"]+)"', msq_text or ""))


def parse(text: str, defined: set[str] | None = None, values: dict | None = None) -> dict:
    lines = _preprocess(text.replace("\r\n", "\n").split("\n"), defined or set())
    values = values or {}
    gauges: dict = {}
    front: list = []
    indicators: list = []
    code_lists: dict = {}
    section = ""
    comms: dict = {"pageSizes": [], "pageIdentifiers": []}
    constants: dict = {}
    outputs: dict = {}
    datalog: dict = {}
    datalog_digits: dict = {}  # how TunerStudio writes each logged channel: decimals from the entry's format
    tables: dict = {}
    curves: dict = {}
    labels: dict = {}
    power_cycle: set = set()
    menus: list = []      # TunerStudio's menu bar: [{title, items: [{target, label, cond} | {sep} | {group, items}]}]
    dialogs: dict = {}    # [UserDefined] dialogs: {name: {title, layout, items: [...]}}
    ind_panels: dict = {}  # indicatorPanel = name, columns: lamps driven by live channels
    help_text: dict = {}  # [SettingContextHelp]: the "?" text of each setting
    page = 1
    cur_table = cur_curve = cur_dialog = cur_group = cur_sel = cur_ind = None
    for raw in lines:
        line = _strip(raw)
        if not line:
            continue
        m = re.match(r"^\[(\w+)\]$", line)
        if m:
            section, cur_table, cur_curve = m.group(1), None, None
            cur_dialog = cur_group = cur_sel = cur_ind = None
            continue
        if "=" not in line:
            continue
        key, rhs = (x.strip() for x in line.split("=", 1))
        if key.endswith("CodeList") and rhs.startswith("bits"):  # what each value of a code means
            code_lists[key] = [_unq(x) for x in _fields(rhs)[3:]]
            continue
        if section in ("MegaTune", "TunerStudio"):
            if key in ("signature", "queryCommand", "versionInfo"):
                comms[key] = _unq(rhs)
        elif section == "Constants":
            if key in ("messageEnvelopeFormat", "endianness", "pageReadCommand", "burnCommand", "pageChunkWrite",
                       "crc32CheckCommand", "pageValueWrite"):
                comms[key] = rhs.strip()
            elif key in ("nPages", "blockingFactor", "tableBlockingFactor", "interWriteDelay", "blockReadTimeout"):
                vals = [_num(v, 0) for v in _fields(rhs)]
                comms[key] = int(vals[0] or 0)
            elif key == "pageSize":
                comms["pageSizes"] = [int(_num(v, 0) or 0) for v in _fields(rhs)]
            elif key == "pageIdentifier":
                comms["pageIdentifiers"] = [_unq(v) for v in _fields(rhs)]
            elif key == "page":
                page = int(_num(rhs, 1) or 1)
            else:
                f = _fields(rhs)
                if len(f) >= 4 and f[0] == "string":  # text (engine make, Lua script names…): shown, not edited
                    constants[key] = {"kind": "string", "type": "U08", "offset": int(_num(f[2], 0) or 0), "page": page,
                                      "len": int(_num(f[3], 0) or 0)}
                    continue
                if not f or f[0] not in ("scalar", "array", "bits") or len(f) < 3 or f[1] not in TYPES:
                    continue
                c = {"kind": f[0], "type": f[1], "offset": int(_num(f[2], 0) or 0), "page": page}
                rest = f[3:]
                if f[0] == "array":
                    shape = rest[0] if rest else ""
                    dims = [int(x) for x in re.findall(r"\d+", shape)]
                    if not dims:
                        continue
                    c["rows"], c["cols"] = (dims[1], dims[0]) if len(dims) >= 2 else (1, dims[0])
                    rest = rest[1:]
                if f[0] == "bits":
                    b = re.findall(r"\d+", rest[0]) if rest else []
                    c["bits"] = [int(b[0]), int(b[1]) if len(b) > 1 else int(b[0])] if b else [0, 0]
                    c["options"] = _bit_options(rest[1:])
                else:
                    c["units"] = _unq(rest[0]) if len(rest) > 0 else ""
                    c["scale"] = _num(rest[1], 1.0) if len(rest) > 1 else 1.0
                    c["translate"] = _num(rest[2], 0.0) if len(rest) > 2 else 0.0
                    c["lo"] = _num(rest[3]) if len(rest) > 3 else None
                    c["hi"] = _num(rest[4]) if len(rest) > 4 else None
                    d = _num(rest[5]) if len(rest) > 5 else None
                    c["digits"] = int(d) if d is not None else None
                constants[key] = c
        elif section == "OutputChannels":
            if key in ("ochGetCommand",):
                comms[key] = rhs.strip()
            elif key == "ochBlockSize":
                comms[key] = int(_num(rhs, 0) or 0)
            else:
                f = _fields(rhs)
                if not f or f[0] not in ("scalar", "bits") or len(f) < 3 or f[1] not in TYPES:
                    continue  # expressions ({...}) are worked out by TunerStudio, not read from the ECU
                o = {"kind": f[0], "type": f[1], "offset": int(_num(f[2], 0) or 0)}
                if f[0] == "bits":
                    b = re.findall(r"\d+", f[3]) if len(f) > 3 else []
                    o["bits"] = [int(b[0]), int(b[1]) if len(b) > 1 else int(b[0])] if b else [0, 0]
                else:
                    o["units"] = _unq(f[3]) if len(f) > 3 else ""
                    o["scale"] = _num(f[4], 1.0) if len(f) > 4 else 1.0
                    o["translate"] = _num(f[5], 0.0) if len(f) > 5 else 0.0
                    if o["scale"] is None or o["translate"] is None:
                        continue  # scale given as an expression
                outputs[key] = o
        elif section == "Datalog":
            if key == "entry":
                f = _fields(rhs)
                if len(f) >= 2:
                    datalog.setdefault(f[0], _unq(f[1]))  # the first label is the one logs use
                    if f[0] not in datalog_digits:
                        fm = re.search(r"%\.?(\d*)([dfi])", _unq(f[3])) if len(f) > 3 else None
                        kind = f[2].strip().lower() if len(f) > 2 else ""
                        datalog_digits[f[0]] = (0 if fm.group(2) in "di" else int(fm.group(1) or 6)) if fm else (0 if kind == "int" else None)
        elif section == "ConstantsExtensions":
            if key == "requiresPowerCycle":
                power_cycle.add(rhs.strip())
        elif section == "CurveEditor":
            f = _fields(rhs)
            if key == "curve" and len(f) >= 2:
                cur_curve = f[0]
                curves[cur_curve] = {"id": f[0], "title": _unq(f[1]), "x": None, "xch": None, "y": None}
            elif cur_curve and key == "columnLabel":
                curves[cur_curve]["cols"] = [_unq(x) for x in f[:2]]
            elif cur_curve and key == "xBins":
                curves[cur_curve]["x"] = f[0]
                curves[cur_curve]["xch"] = f[1] if len(f) > 1 else None
            elif cur_curve and key == "yBins" and curves[cur_curve]["y"] is None:
                curves[cur_curve]["y"] = f[0]
        elif section == "GaugeConfigurations":
            # name = channel, "Title", "units", lo, hi, loDanger, loWarn, hiWarn, hiDanger, valueDigits, labelDigits
            f = _fields(rhs)
            if key != "gaugeCategory" and len(f) >= 9 and re.match(r"^\w+$", f[0]):
                g = {"ch": f[0], "title": _unq(f[1]), "units": _unq(f[2])}
                for i, k in enumerate(("lo", "hi", "loD", "loW", "hiW", "hiD")):
                    g[k] = _gauge_num(f[3 + i], values)
                g["vd"] = int(_num(f[9], 0) or 0) if len(f) > 9 else 0
                g["ld"] = int(_num(f[10], 0) or 0) if len(f) > 10 else 0
                if g["lo"] is not None and g["hi"] is not None and g["hi"] > g["lo"]:
                    gauges[key] = g
        elif section == "FrontPage":
            f = _fields(rhs)
            if re.match(r"^gauge\d+$", key) and f:
                front.append((int(key[5:]), f[0]))
            elif key == "indicator" and len(f) >= 3:
                # { channel } or { channel != 0 }…, "off label", "on label", off-bg, off-fg, on-bg, on-fg
                m = _IND.match(f[0])
                if m and len(indicators) < 60:
                    col = lambda i, d: _COLORS.get(f[i].strip().lower(), d) if len(f) > i else d  # noqa: E731
                    on = _unq(f[2]) if f[2].startswith('"') else m.group(1)
                    # { Fuel cut: bitStringValue(fuelIgnCutCodeList, fuelCutReason) }: the reason, by name
                    bm = re.match(r"^\{\s*([^:{}]+):\s*bitStringValue\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\}$", f[2])
                    indicators.append({"ch": m.group(1), "op": m.group(2) or "", "v": float(m.group(3) or 0),
                                       "onPrefix": bm.group(1).strip() if bm else "", "onList": bm.group(2) if bm else "",
                                       "onCh": bm.group(3) if bm else "",
                                       "off": _unq(f[1]) if f[1].startswith('"') else "", "on": on,
                                       "offBg": col(3, "#ffffff"), "offFg": col(4, "#000000"),
                                       "onBg": col(5, "#22dd22"), "onFg": col(6, "#000000")})
        elif section == "Menu":
            f = _fields(rhs)
            if key == "menu" and f:
                menus.append({"title": _unq(f[0]).replace("&", ""), "items": []})
                cur_group = None
            elif menus and key in ("subMenu", "groupChildMenu") and f:
                if f[0] == "std_separator":
                    if key == "subMenu":
                        menus[-1]["items"].append({"sep": True})
                        cur_group = None
                    continue
                item = {"target": f[0], "label": _unq(f[1]).replace("&", "") if len(f) > 1 else f[0],
                        "cond": next((_cond(x) for x in f[2:] if x.strip().startswith("{")), None)}
                if key == "groupChildMenu" and cur_group is not None:
                    cur_group["items"].append(item)
                else:
                    menus[-1]["items"].append(item)
                    cur_group = None
            elif menus and key == "groupMenu" and f:
                cur_group = {"group": _unq(f[0]).replace("&", ""), "items": []}
                menus[-1]["items"].append(cur_group)
        elif section == "UserDefined":
            f = _fields(rhs)
            if key == "dialog" and f:
                cur_dialog = {"title": _unq(f[1]) if len(f) > 1 else "", "layout": f[2].strip() if len(f) > 2 else "",
                              "items": []}
                dialogs[f[0]] = cur_dialog
                cur_ind = None
            elif key == "indicatorPanel" and f:
                cur_ind = ind_panels[f[0]] = {"cols": int(_num(f[1], 1) or 1) if len(f) > 1 else 1, "items": []}
                cur_dialog = None
            elif key == "indicator" and cur_ind is not None and len(f) >= 3:
                cur_ind["items"].append({"expr": _cond(f[0]) or "0", "off": _unq(f[1]), "on": _unq(f[2])})
            elif not f:
                continue
            elif key in ("field", "displayOnlyField"):
                label, rest = _label_and_name(f[0], f[1:])
                name = rest[0].strip() if rest and re.match(r"^\w+$", rest[0].strip()) else None
                if name:
                    if label.strip():
                        labels.setdefault(name, label.strip())
                    rest = rest[1:]
                if cur_dialog is None:
                    continue
                item = {"k": "field", "label": label, "name": name, "en": _cond(rest[0]) if rest else None,
                        "vis": _cond(rest[1]) if len(rest) > 1 else None}
                if key == "displayOnlyField":
                    item["ro"] = True
                cur_dialog["items"].append(item)
            elif cur_dialog is None:
                continue
            elif key == "slider":
                label, rest = _label_and_name(f[0], f[1:])
                if rest and re.match(r"^\w+$", rest[0].strip()):
                    cur_dialog["items"].append({"k": "slider", "label": label, "name": rest[0].strip(),
                                                "en": next((_cond(x) for x in rest[1:] if x.strip().startswith("{")), None)})
            elif key == "panel":
                conds = [x for x in f[1:] if x.strip().startswith("{") or re.match(r"^\d+$", x.strip())]
                cur_dialog["items"].append({"k": "panel", "name": f[0], "en": _cond(conds[0]) if conds else None,
                                            "vis": _cond(conds[1]) if len(conds) > 1 else None})
            elif key == "commandButton":
                cur_dialog["items"].append({"k": "cmd", "label": _unq(f[0]), "cmd": f[1] if len(f) > 1 else "",
                                            "en": next((_cond(x) for x in f[2:] if x.strip().startswith("{")), None)})
            elif key == "settingSelector":
                cur_sel = {"k": "preset", "label": _unq(f[0]), "en": _cond(f[1]) if len(f) > 1 else None, "options": []}
                cur_dialog["items"].append(cur_sel)
            elif key == "settingOption" and cur_sel is not None and cur_sel in cur_dialog["items"]:
                sets = {}
                for x in f[1:]:
                    m = re.match(r"^\s*(\w+)\s*=\s*(-?[\d.]+)\s*$", x)
                    if m:
                        sets[m.group(1)] = float(m.group(2))
                cur_sel["options"].append({"label": _unq(f[0]), "set": sets})
            elif key == "gauge":
                cur_dialog["items"].append({"k": "gauge", "name": f[0]})
            elif key == "topicHelp":
                cur_dialog["topic"] = _unq(f[0])
        elif section == "SettingContextHelp":
            help_text[key] = _unq(rhs.strip()).replace("\\n", "\n")
        elif key == "field":  # dialog fields: the names people know settings by
            f = _fields(rhs)
            if len(f) >= 2 and f[1] and re.match(r"^\w+$", f[1]):
                labels.setdefault(f[1], _unq(f[0]).strip())
        elif section == "TableEditor":
            f = _fields(rhs)
            if key == "table" and len(f) >= 3:
                cur_table = f[0]
                tables[cur_table] = {"id": f[0], "title": _unq(f[2]), "x": None, "y": None, "z": None,
                                     "xch": None, "ych": None}
            elif cur_table and key in ("xBins", "yBins", "zBins"):
                t = tables[cur_table]
                if key == "zBins":
                    t["z"] = f[0]
                else:
                    t[key[0]] = f[0]
                    t[key[0] + "ch"] = f[1] if len(f) > 1 else None
    # keep only tables whose parts are all plain constants on the page
    good = {}
    for tid, t in tables.items():
        if all(t[k] in constants and constants[t[k]]["kind"] == "array" for k in ("x", "y", "z")):
            good[tid] = t
    if not comms.get("pageSizes"):
        raise IniError("This doesn't look like a TunerStudio ECU definition (no pageSize).")
    good_curves = {cid: c for cid, c in curves.items()
                   if c["x"] in constants and c["y"] in constants and constants[c["x"]]["kind"] == "array"
                   and constants[c["y"]]["kind"] == "array"}
    return {"comms": comms, "constants": constants, "outputs": outputs, "datalog": datalog, "datalogDigits": datalog_digits, "tables": good,
            "curves": good_curves, "labels": labels, "powerCycle": sorted(power_cycle), "gauges": gauges,
            "front": [g for _, g in sorted(front)], "indicators": indicators, "codeLists": code_lists,
            "menus": menus, "dialogs": dialogs, "indicatorPanels": ind_panels, "help": help_text,
            "allCurves": curves, "allTables": tables}


# Settings a remote tuner may not change, whatever the driver allows: what only takes effect after a power cycle
# (the ECU's own list), and what decides how the engine is wired, timed, measured or protected, where one wrong
# number can hurt the engine at once. Those are changed at the car, in TunerStudio.
NOT_REMOTE = re.compile(
    r"pin|port|freq|trigger|cylinder|firing|displacement|engineType|injectionMode|ignitionMode|twoStroke|"
    r"injector(Flow|.*Lag|.*Dead)|stoich|sensor|calib|tps.*(Min|Max)$|Voltage$|offset|angle|"
    r"limit|cut|protect|overboost|maxBoost|rpmHard|revLimit|knock|baud|can[A-Z]|serial|lua|script|"
    r"Name$|enable|use[A-Z]|is[A-Z]|injector_?flow|tempC|resistance|bias|bench|dwell|maf|vr\d|vrThreshold|"
    r"mapSampl|mapAverag|dead|lag", re.I)


# Settings that look protective but that tuners change all the time: allowed, with the driver approving each
# change and in limited steps (see checkChange in ecu.js).
REMOTE_ANYWAY = {"rpmHardLimit", "rpmSoftLimit", "rpmLimit", "revLimit", "RevLimit", "launchRpm"}
# Changed only at the car (the calibration buttons), never by a remote tuner.
CAR_ONLY = ("tpsMin", "tpsMax")


def remote_kind(name: str, c: dict, power_cycle: set) -> str | None:
    """How a remote tuner may change a constant: "table"/"curve" values, a "setting", or None (not at all)."""
    if name in REMOTE_ANYWAY and name not in power_cycle and c["kind"] == "scalar":
        return "setting"
    if name in power_cycle or NOT_REMOTE.search(name):
        return None
    if c["kind"] == "scalar" and c.get("lo") is not None and c.get("hi") is not None:
        return "setting"
    return None


def layout_for_live(ini: dict) -> dict:
    """What the live page needs: comms, the tables (with their axes and z constants), and the output channels
    that the log knows by name, labelled like a datalog so the usual channel roles apply."""
    c = ini["constants"]
    power = set(ini.get("powerCycle") or [])
    keep, editable = {}, {}
    for t in ini["tables"].values():
        for k in ("x", "y", "z"):
            keep[t[k]] = c[t[k]]
        if t["z"] not in power and not NOT_REMOTE.search(t["z"]):
            editable[t["z"]] = "table"
    curves = []
    for cv in (ini.get("curves") or {}).values():
        keep[cv["x"]], keep[cv["y"]] = c[cv["x"]], c[cv["y"]]
        if cv["y"] not in power and cv["y"] not in editable and not NOT_REMOTE.search(cv["y"]):
            editable[cv["y"]] = "curve"
        curves.append({"id": cv["id"], "title": cv["title"], "x": cv["x"], "xch": cv["xch"], "y": None, "ych": None,
                       "z": cv["y"], "curve": True})
    labels = ini.get("labels") or {}
    for name in ("stoichRatioPrimary",) + CAR_ONLY:  # read only remotely: stoich for AFR, TPS calibration at the car
        if name in c and c[name]["kind"] == "scalar":
            keep[name] = dict(c[name], label=labels.get(name, ""))
    for name, k in c.items():
        kind = remote_kind(name, k, power)
        if kind and name not in keep:
            keep[name] = dict(k, label=labels.get(name, ""))
            editable[name] = kind
    outs = {}
    for name, o in ini["outputs"].items():
        label = ini["datalog"].get(name)
        if label is not None or name in ("RPMValue",):
            outs[name] = dict(o, label=label or name)
    # the live channels that move each table's cursor, even if they aren't in the datalog
    for t in ini["tables"].values():
        for ch in (t["xch"], t["ych"]):
            if ch and ch in ini["outputs"] and ch not in outs:
                outs[ch] = dict(ini["outputs"][ch], label=ini["datalog"].get(ch) or ch)
    for t in curves:
        if t["xch"] and t["xch"] in ini["outputs"] and t["xch"] not in outs:
            outs[t["xch"]] = dict(ini["outputs"][t["xch"]], label=ini["datalog"].get(t["xch"]) or t["xch"])
    # the dials and indicator lamps, the way the project's front page has them (only what the ECU sends directly)
    gauges = {k: g for k, g in (ini.get("gauges") or {}).items() if g["ch"] in ini["outputs"]}
    front = [g for g in (ini.get("front") or []) if g in gauges][:8]
    indicators = [i for i in (ini.get("indicators") or []) if i["ch"] in ini["outputs"]]
    lists = ini.get("codeLists") or {}
    for i in indicators:
        if i.get("onList") in lists:
            i["onNames"] = lists[i["onList"]]
    extra = [n for n in ["stoichiometricRatio", "rawTps1Primary", "lastErrorCode", "warningCounter"] +
             [f"recentErrorCode{k}" for k in range(1, 9)] if n in ini["outputs"]]
    for ch in [gauges[g]["ch"] for g in gauges] + [i["ch"] for i in indicators] + extra:
        if ch not in outs:
            outs[ch] = dict(ini["outputs"][ch], label=ini["datalog"].get(ch) or ch)
    # what TunerStudio's own datalog holds, in its order, with its decimals: the session log is written the same way,
    # so it loads into TunerStudio (and its VE Analyze finds every field) like a log TunerStudio recorded
    digits = ini.get("datalogDigits") or {}
    datalog = [[n, digits.get(n)] for n in ini["datalog"] if n in outs]
    ui = dialogs_for_live(ini, keep, curves)
    return {"ui": ui,"comms": ini["comms"], "constants": keep, "outputs": outs, "datalog": datalog, "tables": list(ini["tables"].values()),
            "curves": curves, "editable": editable, "powerCycle": sorted(power), "gauges": gauges, "front": front,
            "indicators": indicators}


def _idents(expr: str | None) -> set[str]:
    return set(_IDENT.findall(re.sub(r'"[^"]*"', "", expr or ""))) if expr else set()


def dialogs_for_live(ini: dict, keep: dict, curves: list) -> dict:
    """TunerStudio's menus and settings dialogs, for the live page: only what the menus reach, with every constant
    those dialogs show (or test in their conditions) added to `keep`, so the car page reads them from the ECU.
    Menu entries that open TunerStudio's own tools (std_…) or things the page can't show are left out."""
    c, dialogs, panels_ind = ini["constants"], ini.get("dialogs") or {}, ini.get("indicatorPanels") or {}
    tables = {t["id"]: t for t in ini["tables"].values()}
    curve_ids = {cv["id"] for cv in curves}
    labels, help_all = ini.get("labels") or {}, ini.get("help") or {}
    used_d: dict = {}
    names: set = set()

    def showable(target: str) -> bool:
        return target in dialogs or target in tables or target in curve_ids

    def walk(name: str, depth: int = 0) -> None:
        if name in used_d or name not in dialogs or depth > 12:
            return
        used_d[name] = d = dialogs[name]
        for it in d["items"]:
            for k in ("en", "vis"):
                names.update(_idents(it.get(k)))
            if it.get("name") and it["k"] in ("field", "slider"):
                names.add(it["name"])
            if it["k"] == "preset":
                for o in it["options"]:
                    names.update(o["set"])
            if it["k"] == "panel":
                walk(it["name"], depth + 1)

    menus = []
    for m in ini.get("menus") or []:
        items = []
        for it in m["items"]:
            if it.get("group"):
                kids = [k for k in it["items"] if showable(k["target"])]
                if kids:
                    items.append({"group": it["group"], "items": kids})
            elif it.get("sep"):
                if items and not items[-1].get("sep"):
                    items.append(it)
            elif showable(it["target"]):
                items.append(it)
        while items and items[-1].get("sep"):
            items.pop()
        for it in items:
            for k in (it.get("items") or [it]):
                if k.get("target"):
                    names.update(_idents(k.get("cond")))
                    walk(k["target"])
        if items:
            menus.append({"title": m["title"], "items": items})
    ind = {}
    for d in used_d.values():
        for it in d["items"]:
            if it["k"] == "panel" and it["name"] in panels_ind:
                ind[it["name"]] = panels_ind[it["name"]]
    for n in names:
        if n in c and n not in keep and c[n]["kind"] in ("scalar", "bits", "string", "array"):
            keep[n] = dict(c[n], label=labels.get(n, ""), dlg=True)  # shown in a dialog; loading a tune file leaves it alone
    helps = {n: help_all[n] for n in names if n in help_all}
    return {"menus": menus, "dialogs": used_d, "indicatorPanels": ind, "help": helps}
