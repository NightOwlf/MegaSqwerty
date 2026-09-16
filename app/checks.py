"""Tune health: what should be fixed before starting the engine, what looks off, and what's worth knowing.

Every rule is data (a kind, its parameters and its wording), so the same rule is evaluated here for the first
render and again by edit.js (evaluateCheck) each time a value is edited. Keep `_evaluate` and the JS in step.

Levels: "error" = fix before starting the engine, "warn" = looks wrong, "info" = worth knowing, not a fault.
These catch common setup mistakes; they can't prove a tune is safe.
"""
from __future__ import annotations

import operator

from .axes import BOOST_EDGE_KPA, PLACEHOLDERS, STOICH_NAMES, placeholder_parts, stoich_of
from .parser import TuneDoc
from .render import fuel_mode
from .tablemaps import TableView

REV_LIMIT_NAMES = ("hardRevLim", "rpmHardLimit", "RevLimNormal2", "RevLimRpm2", "HardRevLim", "rpmhardlimit",
                   "RevLimRPM", "revLimit")
MAIN_TABLES = ("ve", "spark", "afr")
_OPS = {"<": operator.lt, "<=": operator.le, ">=": operator.ge, ">": operator.gt}
_ORDER = {"error": 0, "warn": 1, "info": 2, "ok": 3}


# ------------------------------------------------------------------ helpers

def _g(v: float) -> str:
    return f"{round(v, 4):g}"


def _with(v: float, units: str) -> str:
    return f"{_g(v)} {units}" if units else _g(v)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _scalar(doc: TuneDoc, name: str) -> bool:
    c = doc.get(name)
    return c is not None and c.kind == "scalar" and isinstance(c.value, float)


def _first(doc: TuneDoc, names) -> str | None:
    return next((n for n in names if _scalar(doc, n)), None)


def _option(doc: TuneDoc, name: str) -> str | None:
    c = doc.get(name)
    return str(c.value).strip() if c is not None and c.kind == "string" else None


def _off(value: str | None) -> bool:
    return value is None or value.strip().lower() in ("off", "no", "disabled", "false", "0", "")


class _Values:
    def __init__(self, doc: TuneDoc):
        self.doc = doc

    def array(self, name) -> list | None:
        c = self.doc.get(name) if isinstance(name, str) and name else None
        return [v if isinstance(v, float) else None for v in c.values] if c is not None else None

    def ref(self, ref) -> float | None:
        if isinstance(ref, (int, float)) and not isinstance(ref, bool):
            return float(ref)
        if not ref:
            return None
        arr = self.array(ref[0])
        nums = [v for v in arr or [] if v is not None]
        if not nums:
            return None
        return max(nums) if ref[1] == "max" else min(nums) if ref[1] == "min" else arr[0]


def _where(vals: _Values, rule: dict, r: int, c: int) -> str:
    x, y = vals.array(rule.get("x")), vals.array(rule.get("y"))
    if x and y and c < len(x) and r < len(y) and x[c] is not None and y[r] is not None:
        return f"{_with(x[c], rule.get('xu', ''))} / {_with(y[r], rule.get('yu', ''))}"
    return f"row {r + 1}, column {c + 1}"


# ------------------------------------------------------------------ evaluation

def _evaluate(rule: dict, vals: _Values) -> tuple[bool, dict] | None:
    """-> (passed, text variables), or None when the tune doesn't have what the rule needs."""
    kind, units = rule["kind"], rule.get("units", "")
    if kind == "cmp":
        a, b = vals.ref(rule["a"]), vals.ref(rule["b"])
        if a is None or b is None:
            return None
        return _OPS[rule["op"]](a, b), {"a": _with(a, units), "b": _with(b, units)}
    if kind == "range":
        a = vals.ref(rule["a"])
        if a is None:
            return None
        lo, hi = rule.get("lo"), rule.get("hi")
        return (lo is None or a >= lo) and (hi is None or a <= hi), {"a": _with(a, units)}
    if kind == "ascending":
        arr = vals.array(rule["a"])
        if not arr or len(arr) < 2 or None in arr:
            return None
        for i in range(len(arr) - 1):
            if arr[i] >= arr[i + 1]:
                return False, {"where": f"{_with(arr[i], units)} then {_with(arr[i + 1], units)}"}
        return True, {}
    if kind == "placeholder":
        nums = [v for v in vals.array(rule["z"]) or [] if v is not None]
        if len(nums) < 2:
            return None
        failed = len(set(nums)) == 1 and (not rule.get("strict") or nums[0] in PLACEHOLDERS)
        return not failed, {"value": _g(nums[0])}
    if kind == "coverage":
        a, b = vals.ref(rule["a"]), vals.ref(rule["b"])
        if a is None or b is None:
            return None
        return not (b > 110 and a <= BOOST_EDGE_KPA), {"a": _with(a, units), "b": _with(b, units)}
    if kind == "boostcut":
        a = vals.ref(rule["a"])
        if a is None:
            return None
        return bool(rule["enabled"]) or a <= BOOST_EDGE_KPA, {"a": _with(a, units)}
    if kind == "static":
        return bool(rule["passed"]), {}

    # table kinds: cells, spike, rows
    z, rows, cols = vals.array(rule["z"]), rule["rows"], rule["cols"]
    if not z or len(z) != rows * cols:
        return None
    scale = vals.ref(rule["scale"]) if rule.get("scale") is not None else 1.0
    if not scale:
        return None
    if kind == "cells":
        lo, hi = rule.get("lo"), rule.get("hi")
        bad = [i for i, v in enumerate(z)
               if v is not None and ((lo is not None and v / scale < lo) or (hi is not None and v / scale > hi))]
        if not bad:
            return True, {}
        i = bad[0]
        return False, {"cells": _plural(len(bad), "cell"), "value": _g(z[i]), "conv": f"{z[i] / scale:.2f}",
                       "where": _where(vals, rule, i // cols, i % cols)}
    if kind == "spike":
        worst = None
        for r in range(rows):
            for c in range(cols):
                v = z[r * cols + c]
                if v is None:
                    continue
                around = [z[rr * cols + cc] for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1))
                          if 0 <= rr < rows and 0 <= cc < cols and z[rr * cols + cc] is not None]
                if len(around) < 2:
                    continue
                mean = sum(around) / len(around)
                ratio = abs(v - mean) / max(rule["abs"], rule.get("pct", 0) * abs(mean))
                if ratio > 1 and (worst is None or ratio > worst[0]):
                    worst = (ratio, r, c, v, mean)
        if worst is None:
            return True, {}
        _, r, c, v, mean = worst
        return False, {"where": _where(vals, rule, r, c), "value": _g(v), "around": f"{mean:.1f}"}
    if kind == "rows":
        y = vals.array(rule["y"])
        if not y or len(y) != rows:
            return None
        x, min_rpm = vals.array(rule.get("x")), rule.get("min_rpm")
        use_col = [not (min_rpm and x and len(x) == cols and x[c] is not None and x[c] < min_rpm) for c in range(cols)]
        picked = [(z[r * cols + c], r, c) for r in range(rows) if y[r] is not None and y[r] >= rule["min_load"]
                  for c in range(cols) if use_col[c] and z[r * cols + c] is not None]
        if not picked:
            return None
        v, r, c = max(picked, key=lambda p: p[0])
        return v / scale <= rule["hi"], {"value": _g(v), "conv": f"{v / scale:.2f}", "where": _where(vals, rule, r, c)}
    raise ValueError(f"unknown check kind {kind!r}")


def _fill(template: str, variables: dict) -> str:
    for key, value in variables.items():
        template = template.replace("{" + key + "}", value)
    return template


def run(doc: TuneDoc, views: list[TableView]) -> list[dict]:
    """Evaluate every rule that applies to this tune. Problems first, then notes, then passes."""
    vals, out = _Values(doc), []
    for rule in build_rules(doc, views):
        result = _evaluate(rule, vals)
        if result is None:
            continue
        passed, variables = result
        out.append({**rule, "status": "ok" if passed else rule["level"],
                    "text": _fill(rule["ok"] if passed else rule["bad"], variables)})
    out.sort(key=lambda r: _ORDER[r["status"]])
    return out


def summary(results: list[dict]) -> dict:
    n = {level: sum(1 for r in results if r["status"] == level) for level in ("error", "warn", "info")}
    passed = sum(1 for r in results if r["status"] == "ok" and r["text"])
    if n["error"]:
        verdict, tone, short = f"Not ready to start: {_plural(n['error'], 'problem')} to fix", "error", f"{n['error']} to fix"
    elif n["warn"]:
        look = "looks" if n["warn"] == 1 else "look"
        verdict, tone, short = (f"No blocking problems, but {_plural(n['warn'], 'thing')} {look} off", "warn",
                                f"{n['warn']} to check")
    else:
        verdict, tone, short = "No problems found", "ok", "All good"
    return {"verdict": verdict, "tone": tone, "short": short, "errors": n["error"], "warnings": n["warn"],
            "notes": n["info"], "passed": passed}


# ------------------------------------------------------------------ rules

def _unit(label: str, units: str) -> str:
    return units or ("rpm" if label == "RPM" else "")


def _axis_word(label: str, fallback: str) -> str:
    return label if label.isupper() else (label.lower() or fallback)


def build_rules(doc: TuneDoc, views: list[TableView]) -> list[dict]:
    rules: list[dict] = []

    def add(kind, level, group, ok, bad, **params):
        rules.append({"id": f"c{len(rules)}", "kind": kind, "level": level, "group": group, "ok": ok, "bad": bad,
                      **params})

    by_id: dict[str, TableView] = {}
    for v in views:
        by_id.setdefault(v.id, v)
    rev = _first(doc, REV_LIMIT_NAMES)
    map_max = "mapMax" if _scalar(doc, "mapMax") else None

    # ---- fuel basics
    req = _first(doc, ("reqFuel", "req_fuel", "reqFuel1"))
    if req:
        add("range", "error", "Fuel", "Required fuel is {a}.",
            "Required fuel is {a}, so the injectors never open. Set it from injector size, displacement and "
            "cylinder count.", a=[req, "value"], lo=0.1, units="ms")
        add("range", "warn", "Fuel", "",
            "Required fuel {a} is unusually large. Check injector size, displacement and cylinder count.",
            a=[req, "value"], hi=25, units="ms")
    dead = _first(doc, ("injOpen", "injOpen1"))
    if dead:
        add("range", "warn", "Fuel", "Injector open time is {a}.",
            "Injector open time {a} is outside the usual 0.2–3 ms, so small pulses (idle and cruise) will be off.",
            a=[dead, "value"], lo=0.2, hi=3.0, units="ms")
    for name, label, units, lo in (("injector_flow", "Injector flow", "cc/min", 1.0),
                                   ("displacement", "Engine displacement", "L", 0.05),
                                   ("cylindersCount", "Cylinder count", "", 1.0)):
        if _scalar(doc, name):
            add("range", "error", "Fuel", f"{label} is {{a}}.", f"{label} is {{a}}, so fuel can't be calculated.",
                a=[name, "value"], lo=lo, units=units)
    stoich_name = next((n for n in STOICH_NAMES if _scalar(doc, n)), None)
    if stoich_name:
        add("range", "warn", "Fuel", "Stoichiometric ratio is {a}:1.",
            "Stoichiometric ratio {a}:1 is outside 6–16, beyond gasoline, E85 and methanol.",
            a=[stoich_name, "value"], lo=6, hi=16)

    # ---- main tables
    for tid in MAIN_TABLES:
        v = by_id.get(tid)
        if v is None:
            continue
        z, label = v.z, v.label
        grid = {"z": z.name, "rows": z.rows, "cols": z.cols,
                "x": v.x.name if v.x is not None and len(v.x.values) == z.cols else "",
                "y": v.y.name if v.y is not None and len(v.y.values) == z.rows else "",
                "xu": _unit(v.x_label, v.x_units), "yu": _unit(v.y_label, v.y_units)}
        add("placeholder", "error", "Tables", "", f"{label} hasn't been set up: every cell is {{value}}.", z=z.name)
        for name, units, word in ((grid["x"], grid["xu"], _axis_word(v.x_label, "column")),
                                  (grid["y"], grid["yu"], _axis_word(v.y_label, "row"))):
            if name:
                add("ascending", "error", "Tables", "",
                    f"{label} {word} bins aren't in increasing order ({{where}}), so the ECU can't look the table "
                    "up correctly.", a=name, units=units)
        load_kpa = bool(grid["y"]) and v.y_units == "kPa"
        if tid == "ve":
            add("cells", "warn", "Fuel", "",
                "VE is 0 in {cells} (first at {where}), so no fuel is injected there.", lo=0.5, **grid)
            add("cells", "warn", "Fuel", "",
                "VE is above 200% in {cells} (first {value}% at {where}). Check that's intended.", hi=200, **grid)
            add("spike", "warn", "Fuel", f"{label} has no sharp spikes.",
                "VE jumps sharply at {where}: {value}% where the cells around it average {around}%.",
                abs=12, pct=0.25, **grid)
        elif tid == "spark":
            add("cells", "warn", "Ignition", "Advance stays between −20° and 55°.",
                "Advance is outside −20° to 55° in {cells} (first {value}° at {where}).", lo=-20, hi=55, **grid)
            add("spike", "warn", "Ignition", f"{label} has no sharp spikes.",
                "Advance jumps sharply at {where}: {value}° where the cells around it average {around}°.",
                abs=10, **grid)
            if load_kpa:
                add("rows", "warn", "Ignition", "",
                    "Advance reaches {value}° in boost (at {where}). Boosted engines usually need far less timing "
                    "there; watch for knock.", min_load=110, min_rpm=2000, hi=35, **grid)
        elif tid == "afr":
            mode = fuel_mode(z, v.units, v.palette)
            if mode:
                stoich_name = next((n for n in STOICH_NAMES if _scalar(doc, n)), None)
                scale = 1.0 if mode == "lambda" else (
                    [stoich_name, "value"] if stoich_name else stoich_of(doc))
                add("cells", "warn", "Fuel", "Targets stay between λ 0.65 and 1.20.",
                    "Target is outside λ 0.65–1.20 in {cells} (first {value} at {where}).",
                    lo=0.65, hi=1.2, scale=scale, **grid)
                if load_kpa:
                    add("rows", "warn", "Fuel", "Full-load targets are λ 0.95 or richer.",
                        "Full-load targets (95 kPa and up, from 2000 rpm) reach λ {conv} ({value} at {where}). "
                        "Engines are usually fuelled richer at full load, around λ 0.85–0.90.",
                        min_load=95, min_rpm=2000, hi=0.95, scale=scale, **grid)
                    add("rows", "warn", "Fuel", "",
                        "Boost targets reach λ {conv} ({value} at {where}). Boosted engines are usually run "
                        "richer, around λ 0.75–0.82.", min_load=110, min_rpm=2000, hi=0.86, scale=scale, **grid)
        if tid in ("ve", "spark"):
            if rev and grid["x"] and v.x_label == "RPM":
                add("cmp", "warn", "Limits", f"{label} RPM bins reach {{a}}, covering the rev limit ({{b}}).",
                    f"{label} RPM bins stop at {{a}}, below the rev limit {{b}}. Above that the last column is used.",
                    a=[grid["x"], "max"], b=[rev, "value"], op=">=", units="rpm")
            if map_max and load_kpa:
                add("cmp", "warn", "Sensors",
                    f"{label} load bins (up to {{a}}) are within the MAP sensor's range ({{b}}).",
                    f"{label} load bins go up to {{a}}, past what the MAP sensor is calibrated to read ({{b}}).",
                    a=[grid["y"], "max"], b=[map_max, "value"], op="<=", units="kPa")
        if tid == "ve" and map_max and load_kpa:
            add("coverage", "info", "Boost", "",
                "The MAP sensor reads up to {b}, but VE Table load bins stop at {a}. That's fine for a naturally "
                "aspirated engine; a boosted one needs load bins above 101 kPa in the VE, ignition and AFR tables.",
                a=[grid["y"], "max"], b=[map_max, "value"], units="kPa")

    # ---- limits
    if rev:
        add("range", "error", "Limits", "Rev limit is {a}.",
            "Rev limit is {a}, which can't be right: it looks unset or a placeholder.",
            a=[rev, "value"], lo=1000, hi=20000, units="rpm")
        if _scalar(doc, "SoftRevLim"):
            add("cmp", "warn", "Limits", "Soft rev limit {a} is below the hard rev limit {b}.",
                "Soft rev limit {a} should be below the hard rev limit {b}.",
                a=["SoftRevLim", "value"], b=[rev, "value"], op="<", units="rpm")
    launch = _option(doc, "launchEnable")
    if launch is None or not _off(launch):
        if rev:
            add("cmp", "warn", "Limits", "Launch hard limit {a} is at or below the rev limit {b}.",
                "Launch hard limit {a} is above the rev limit {b}.",
                a=["lnchHardLim", "value"], b=[rev, "value"], op="<=", units="rpm")
        add("cmp", "warn", "Limits", "Launch soft limit {a} is below the launch hard limit {b}.",
            "Launch soft limit {a} should be below the launch hard limit {b}.",
            a=["lnchSoftLim", "value"], b=["lnchHardLim", "value"], op="<", units="rpm")

    # ---- sensors
    if map_max and _scalar(doc, "mapMin"):
        add("cmp", "error", "Sensors", "MAP sensor calibration runs from {a} to {b}.",
            "MAP sensor calibration is wrong: the 0 V value ({a}) isn't below the 5 V value ({b}).",
            a=["mapMin", "value"], b=["mapMax", "value"], op="<", units="kPa")
    if not _off(_option(doc, "useExtBaro")) and _scalar(doc, "baroMin") and _scalar(doc, "baroMax"):
        add("cmp", "warn", "Sensors", "Baro sensor calibration runs from {a} to {b}.",
            "Baro sensor calibration is wrong: the 0 V value ({a}) isn't below the 5 V value ({b}).",
            a=["baroMin", "value"], b=["baroMax", "value"], op="<", units="kPa")

    # ---- boost
    cut = _option(doc, "boostCutEnabled")
    ve = by_id.get("ve")
    if cut is not None and ve is not None and ve.y is not None and ve.y_units == "kPa":
        add("boostcut", "info", "Boost", "",
            "Boost cut is off while the VE table has boost rows up to {a}, so nothing cuts power on an overboost.",
            a=[ve.y.name, "max"], enabled=not _off(cut), units="kPa")
    limit = _first(doc, ("boostLimit", "boostCutPressure"))
    if limit and map_max and (cut is None or not _off(cut)):
        add("cmp", "warn", "Boost", "Boost cut {a} is within the MAP sensor's range ({b}).",
            "Boost cut {a} is past what the MAP sensor can read ({b}), so it can never trigger.",
            a=[limit, "value"], b=[map_max, "value"], op="<=", units="kPa")
    if not _off(_option(doc, "boostEnabled")) and doc.get("boostTable") is not None:
        add("placeholder", "warn", "Boost", "",
            "Boost control is on, but its table hasn't been set up (every cell is {value}).",
            z="boostTable", strict=True)

    # ---- gauges (TunerStudio display settings; they don't affect how the engine runs)
    if rev:
        add("cmp", "info", "Gauges", "The tach gauge (max {b}) covers the rev limit {a}.",
            "The tach gauge tops out at {b}, below the rev limit {a}. Raise rpmhigh.",
            a=[rev, "value"], b=["rpmhigh", "value"], op="<=", units="rpm")
    for low, high, what, units in (("rpmwarn", "rpmdang", "Tach", "rpm"), ("mapwarn", "mapdang", "MAP", "kPa")):
        add("cmp", "info", "Gauges", f"{what} warning zone {{a}} starts before the danger zone {{b}}.",
            f"{what} warning zone {{a}} starts after the danger zone {{b}}.",
            a=[low, "value"], b=[high, "value"], op="<=", units=units)
    for danger, top, what, units in (("rpmdang", "rpmhigh", "Tach", "rpm"), ("mapdang", "maphigh", "MAP", "kPa")):
        add("cmp", "info", "Gauges", f"{what} danger zone {{a}} is on the gauge (max {{b}}).",
            f"{what} danger zone {{a}} is past the gauge maximum {{b}}.",
            a=[danger, "value"], b=[top, "value"], op="<=", units=units)

    # ---- setup
    unset = [v.label for v in views if v.id not in MAIN_TABLES and placeholder_parts(v.z, v.x, v.y)]
    if unset:
        more = "…" if len(unset) > 6 else ""
        add("static", "info", "Setup", "",
            f"{_plural(len(unset), 'other table')} still hold never-set placeholder values "
            f"({', '.join(unset[:6])}{more}). That's fine while those features are off.", passed=False)
    return rules


def referenced_names(results: list[dict]) -> set[str]:
    """Every setting a rule reads, so the page can hand their current values to edit.js."""
    names: set[str] = set()
    for r in results:
        for key in ("a", "b", "scale"):
            ref = r.get(key)
            if isinstance(ref, list) and ref:
                names.add(ref[0])
            elif isinstance(ref, str) and ref:
                names.add(ref)
        names.update(r[k] for k in ("z", "x", "y") if r.get(k))
    return names
