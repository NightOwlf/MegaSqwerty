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


def msq_settings(msq_text: str) -> set[str]:
    """The setting options a tune was saved with (<setting name="AFR" value="AFR"/>)."""
    return set(re.findall(r'<setting\s+name="[^"]*"\s+value="([^"]+)"', msq_text or ""))


def parse(text: str, defined: set[str] | None = None) -> dict:
    lines = _preprocess(text.replace("\r\n", "\n").split("\n"), defined or set())
    section = ""
    comms: dict = {"pageSizes": [], "pageIdentifiers": []}
    constants: dict = {}
    outputs: dict = {}
    datalog: dict = {}
    tables: dict = {}
    page = 1
    cur_table = None
    for raw in lines:
        line = _strip(raw)
        if not line:
            continue
        m = re.match(r"^\[(\w+)\]$", line)
        if m:
            section, cur_table = m.group(1), None
            continue
        if "=" not in line:
            continue
        key, rhs = (x.strip() for x in line.split("=", 1))
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
                    c["options"] = [_unq(x) for x in rest[1:]]
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
    return {"comms": comms, "constants": constants, "outputs": outputs, "datalog": datalog, "tables": good}


def layout_for_live(ini: dict) -> dict:
    """What the live page needs: comms, the tables (with their axes and z constants), and the output channels
    that the log knows by name, labelled like a datalog so the usual channel roles apply."""
    c = ini["constants"]
    keep = {}
    for t in ini["tables"].values():
        for k in ("x", "y", "z"):
            keep[t[k]] = c[t[k]]
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
    return {"comms": ini["comms"], "constants": keep, "outputs": outs, "tables": list(ini["tables"].values())}
