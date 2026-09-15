"""Page view-models: gallery cards, canvas thumbnails, sparklines, charts, stats, categories."""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from urllib.parse import quote

from . import diff as diffmod
from .nav import CATEGORY_LABEL, CATEGORY_ORDER, categorize
from .parser import Constant, TuneDoc, fmt_value, values_equal
from .render import Grid, axis_labels, build_grid, palette
from .tablemaps import CurveView, TableView, all_tables, curves, meta_digits, meta_units

# 64 intensity levels, one character per cell; "." marks a non-numeric cell.
THUMB_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

# Categories (Engine, Fuel, AFR/Lambda, Ignition, Cranking, …) come from app/nav.py.
CATEGORY_LABELS = CATEGORY_LABEL
# Toolbar buttons are narrow; the full label is in the menu header and tooltips.
CAT_SHORT = {"engine": "Engine", "fuel": "Fuel", "afr": "AFR / λ", "spark": "Ignition", "crank": "Cranking",
             "accel": "Accel", "idle": "Idle", "boost": "Boost", "vvt": "VVT / Cam", "knock": "Protection",
             "sensors": "Sensors", "io": "I/O", "log": "Logging", "script": "Scripting", "other": "Other"}
KIND_LABEL = {"number": "Number", "option": "Option", "array": "Array", "table": "Table"}
TAB_NAMES = {"ve": "VE", "spark": "Spark", "afr": "AFR", "ve2": "VE 2"}

ICONS = {
    "gauge": '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
    "grid": '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>'
            '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    "curve": '<path d="M3 20c4 0 5-14 9-14s5 14 9 14"/>',
    "list": '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    "search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    "share": '<path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
    "link": '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/>'
            '<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
    "download": '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
    "upload": '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 20h16"/>',
    "compare": '<path d="M8 3v14M4 13l4 4 4-4"/><path d="M16 21V7M12 11l4-4 4 4"/>',
    "code": '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
    "fit": '<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/>',
    "eye": '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    "copy": '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    "expand": '<path d="M14 3h7v7M10 21H3v-7M21 3l-7 7M3 21l7-7"/>',
    "left": '<path d="m15 18-6-6 6-6"/>',
    "right": '<path d="m9 18 6-6-6-6"/>',
    "trash": '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    "x": '<path d="M18 6 6 18M6 6l12 12"/>',
    "swap": '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
    "key": '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
    "fuel": '<path d="M12 3s-6 6.5-6 11a6 6 0 0 0 12 0c0-4.5-6-11-6-11z"/>',
    "ignition": '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    "target": '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    "boost": '<circle cx="12" cy="12" r="9"/><path d="M12 12c0-4 3-6.5 6.5-5.5M12 12c-3.5 2-7.5 1-8-2.5M12 12c3.5 2 3.5 6 .5 8.5"/>',
    "cam": '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1'
           'M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    "idle": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "throttle": '<circle cx="12" cy="12" r="9"/><path d="M6.5 17.5 17.5 6.5"/><circle cx="12" cy="12" r="1.5"/>',
    "other": '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    "cube": '<path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="m3.5 7 8.5 4.5L20.5 7M12 11.5v10"/>',
    "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4'
           'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    "moon": '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    "warn": '<path d="M12 3 2 20.5h20z"/><path d="M12 10v5M12 17.5h.01"/>',
    "folder": '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    "down": '<path d="m6 9 6 6 6-6"/>',
    "engine": '<path d="M4 10h2V8h4V6h4v2h3l2 2h1v6h-1l-2 2H9l-3-3H4z"/>',
    "thermo": '<path d="M10 14.5V4a2 2 0 0 1 4 0v10.5a4 4 0 1 1-4 0z"/><path d="M12 9v8"/>',
    "accel": '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    "shield": '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="M12 8v5M12 16h.01"/>',
    "chip": '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4'
            'M18 9h4M18 15h4"/>',
    "disk": '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
}
CAT_ICONS = {"engine": "engine", "fuel": "fuel", "afr": "target", "spark": "ignition", "crank": "key",
             "accel": "accel", "idle": "idle", "boost": "boost", "vvt": "cam", "knock": "shield",
             "sensors": "thermo", "io": "chip", "log": "disk", "script": "code", "other": "other"}


# ------------------------------------------------------------------ helpers

def c_url(slug: str, name: str) -> str:
    return f"/t/{slug}/c/{quote(name, safe='')}"


def d_url(a: str, b: str, name: str) -> str:
    return f"/d/{a}/{b}/c/{quote(name, safe='')}"


def family_label(doc: TuneDoc) -> str:
    return doc.family if doc.family != "unknown" else "Unknown firmware"


def tune_label(doc: TuneDoc) -> str:
    return doc.tune_comment or f"{family_label(doc)} tune"


def display_value(c: Constant, tmap: dict | None = None) -> str:
    if c.kind in ("scalar", "string"):
        return fmt_value(c.value, meta_digits(tmap, c) if tmap else c.digits)
    if c.is_table:
        return f"{c.rows}×{c.cols} table"
    return f"{len(c.values)} values"


def kind_of(c: Constant) -> str:
    return {"scalar": "number", "string": "option", "array": "array", "table": "table"}.get(c.kind, "option")


def _search(*parts: str) -> str:
    return " ".join(p for p in parts if p).lower()


def _nums(values) -> list[float]:
    return [v for v in values if isinstance(v, float)]


@dataclass
class Stats:
    lo: str
    hi: str
    mean: str
    count: int


def stats(values, digits: int | None = None) -> Stats | None:
    nums = _nums(values)
    if not nums:
        return None
    return Stats(fmt_value(min(nums), digits), fmt_value(max(nums), digits),
                 fmt_value(sum(nums) / len(nums), digits), len(nums))


def thumb(z: Constant) -> str:
    """Encode a table as one intensity character per cell, top row = highest row index."""
    nums = _nums(z.values)
    lo, hi = (min(nums), max(nums)) if nums else (0.0, 0.0)
    span = hi - lo
    out = []
    for r in reversed(range(z.rows)):
        for v in z.row(r):
            if isinstance(v, float):
                out.append(THUMB_ALPHABET[round((v - lo) / span * 63) if span else 32])
            else:
                out.append(".")
    return "".join(out)


def diff_thumb(za: Constant, zb: Constant) -> str:
    """Middle level (32) = unchanged; lower = decreased, higher = increased."""
    digits = za.digits if za.digits is not None else zb.digits
    deltas = [b - a for a, b in zip(za.values, zb.values) if isinstance(a, float) and isinstance(b, float)]
    max_abs = max((abs(d) for d in deltas), default=0.0)
    out = []
    for r in reversed(range(zb.rows)):
        for a, b in zip(za.row(r), zb.row(r)):
            if values_equal(a, b, digits):
                out.append(THUMB_ALPHABET[32])
            elif isinstance(a, float) and isinstance(b, float):
                mag = abs(b - a) / max_abs if max_abs else 1.0
                step = round((0.3 + 0.7 * mag) * 31)
                out.append(THUMB_ALPHABET[max(0, min(63, 32 + step if b > a else 32 - step))])
            else:
                out.append(THUMB_ALPHABET[63])
    return "".join(out)


def spark(ys, xs=None, w: float = 100.0, h: float = 40.0) -> tuple[str, str]:
    """SVG polyline points (and a closed area polygon) for a small inline chart."""
    xs = xs if xs is not None and len(xs) == len(ys) else None
    pts = [((xs[i] if xs else float(i)), y) for i, y in enumerate(ys)
           if isinstance(y, float) and isinstance(xs[i] if xs else 0.0, float)]
    if len(pts) < 2:
        return "", ""
    xlo, xhi = min(p[0] for p in pts), max(p[0] for p in pts)
    ylo, yhi = min(p[1] for p in pts), max(p[1] for p in pts)
    xspan, yspan = (xhi - xlo) or 1.0, yhi - ylo
    coords = [((x - xlo) / xspan * w, (h - 3 - (y - ylo) / yspan * (h - 6)) if yspan else h / 2) for x, y in pts]
    line = " ".join(f"{x:.1f},{y:.1f}" for x, y in coords)
    area = f"{coords[0][0]:.1f},{h} {line} {coords[-1][0]:.1f},{h}"
    return line, area


@dataclass
class ChartPoint:
    px: float
    py: float
    xl: str
    yl: str


@dataclass
class Chart:
    w: int
    h: int
    left: int
    right: int
    top: int
    bottom: int
    line: str
    area: str
    points: list[ChartPoint]
    yticks: list[tuple[float, str]]
    xticks: list[tuple[float, str]]
    x_label: str
    y_label: str


def build_chart(ys, xs=None, x_label: str = "", y_label: str = "", digits: int | None = None) -> Chart | None:
    W, H, L, R, T, B = 440, 250, 50, 14, 14, 40
    xs = xs if xs is not None and len(xs) == len(ys) else None
    x_text = axis_labels(xs, len(ys)) if xs else [str(i) for i in range(len(ys))]
    pts = []
    for i, y in enumerate(ys):
        x = xs[i] if xs else float(i)
        if isinstance(y, float) and isinstance(x, float):
            pts.append((x, y, x_text[i], fmt_value(y, digits)))
    if not pts:
        return None
    xlo, xhi = min(p[0] for p in pts), max(p[0] for p in pts)
    ylo, yhi = min(p[1] for p in pts), max(p[1] for p in pts)
    pad = (yhi - ylo) * 0.08 if yhi != ylo else (abs(yhi) * 0.1 or 1.0)
    ylo, yhi = ylo - pad, yhi + pad
    pw, ph = W - L - R, H - T - B

    def px(x):
        return L + ((x - xlo) / (xhi - xlo) * pw if xhi != xlo else pw / 2)

    def py(y):
        return T + (1 - (y - ylo) / (yhi - ylo)) * ph

    points = [ChartPoint(round(px(x), 1), round(py(y), 1), xl, yl) for x, y, xl, yl in pts]
    line = " ".join(f"{p.px},{p.py}" for p in points)
    base = T + ph
    area = f"{points[0].px},{base} {line} {points[-1].px},{base}"
    span = yhi - ylo
    dec = 0 if span >= 50 else 1 if span >= 5 else 2 if span >= 0.5 else 3
    yticks = [(round(py(ylo + span * k / 4), 1), f"{ylo + span * k / 4:.{dec}f}") for k in range(5)]
    step = max(1, -(-len(points) // 7))
    xticks = [(p.px, p.xl) for p in points[::step]]
    return Chart(W, H, L, R, T, B, line, area, points, yticks, xticks, x_label, y_label)


# --------------------------------------------------------------- tune page

@dataclass
class TableCard:
    name: str
    label: str
    cat: str
    rows: int
    cols: int
    units: str
    thumb: str
    stops: str
    url: str
    search: str
    featured: bool = False

    @property
    def dims(self) -> str:
        return f"{self.rows}×{self.cols}"


@dataclass
class CurveCard:
    name: str
    label: str
    cat: str
    n: int
    units: str
    line: str
    area: str
    url: str
    search: str
    lo: str
    hi: str


@dataclass
class SettingRow:
    name: str
    kind: str
    value: str
    units: str
    line: str
    url: str
    search: str
    cat: str = "other"


@dataclass
class TuneModel:
    featured: list[TableView]
    table_views: list[TableView]
    curve_views: list[CurveView]
    tables: list[TableCard]
    curves: list[CurveCard]
    settings: list[SettingRow]
    table_cats: list[tuple[str, str, int]]
    curve_cats: list[tuple[str, str, int]]
    setting_cats: list[tuple[str, str, int]]
    menus: list[tuple[str, str, str, int, list[dict]]]


def _menus(tables: list[TableCard], curve_cards: list[CurveCard],
           settings: list[SettingRow]) -> list[tuple[str, str, str, int, list[dict]]]:
    """TunerStudio-style toolbar menus, one per category: its tables and curves, then its settings.

    -> (category, label, short label, tables + curves, items). Every table and curve is in exactly one menu.
    """
    n_settings = Counter(s.cat for s in settings)
    out = []
    for cid in CATEGORY_ORDER:
        items = [{"label": t.label, "url": t.url, "kind": "grid", "meta": t.dims} for t in tables if t.cat == cid]
        items += [{"label": c.label, "url": c.url, "kind": "curve", "meta": f"{c.n} pts"}
                  for c in curve_cards if c.cat == cid]
        n = len(items)
        if n_settings[cid]:
            items.append({"label": "Settings", "url": "#settings", "kind": "list", "meta": str(n_settings[cid]),
                          "chip": cid})
        if items:
            out.append((cid, CATEGORY_LABEL[cid], CAT_SHORT[cid], n, items))
    return out


def _cat_counts(items) -> list[tuple[str, str, int]]:
    counts = Counter(i.cat for i in items)
    return [(cid, CATEGORY_LABEL[cid], counts[cid]) for cid in CATEGORY_ORDER if counts[cid]]


def curve_views(doc: TuneDoc, tmap: dict, table_views: list[TableView]) -> list[CurveView]:
    """Mapped curves; without any, numeric arrays that aren't a table's axis."""
    mapped = curves(doc, tmap)
    if mapped:
        return mapped
    axes = {c.name for v in table_views for c in (v.x, v.y) if c is not None}
    out = []
    for name, c in doc.constants.items():
        if c.is_array and name not in axes and len(c.values) >= 4 and len(_nums(c.values)) == len(c.values):
            out.append(CurveView(re.sub(r"[^A-Za-z0-9_-]", "", name) or "c", name, None, c, "", ""))
    return out


def tune_model(slug: str, doc: TuneDoc, tmap: dict) -> TuneModel:
    featured, other = all_tables(doc, tmap)
    tviews = featured + other
    tables = []
    for v in tviews:
        cat = categorize(v.label, v.z.name)
        tables.append(TableCard(v.z.name, v.label, cat, v.z.rows, v.z.cols, v.units, thumb(v.z),
                                ",".join(palette(v.palette)[0]), c_url(slug, v.z.name),
                                _search(v.label, v.z.name, v.units, CATEGORY_LABELS[cat]), v.featured))
    cvs = curve_views(doc, tmap, tviews)
    curve_cards = []
    for cv in cvs:
        line, area = spark(cv.y.values, cv.x.values if cv.x else None)
        st = stats(cv.y.values, meta_digits(tmap, cv.y))
        cat = categorize(cv.label, cv.y.name)
        units = meta_units(tmap, cv.y)
        curve_cards.append(CurveCard(cv.y.name, cv.label, cat, len(cv.y.values), units, line, area,
                                     c_url(slug, cv.y.name), _search(cv.label, cv.y.name, units, CATEGORY_LABELS[cat]),
                                     st.lo if st else "", st.hi if st else ""))
    settings = []
    for c in doc.constants.values():
        k = kind_of(c)
        value, units = display_value(c, tmap), meta_units(tmap, c)
        line = spark(c.values, w=60, h=20)[0] if k == "array" and len(c.values) <= 512 else ""
        cat = categorize(c.name)
        settings.append(SettingRow(c.name, k, value, units, line,
                                   c_url(slug, c.name) if k in ("array", "table") else "",
                                   _search(c.name, value, units, CATEGORY_LABELS[cat]), cat))
    return TuneModel(featured, tviews, cvs, tables, curve_cards, settings, _cat_counts(tables),
                     _cat_counts(curve_cards), _cat_counts(settings), _menus(tables, curve_cards, settings))


# ------------------------------------------------------------------ gauges

@dataclass
class Tick:
    x1: float
    y1: float
    x2: float
    y2: float
    major: bool
    label: str = ""
    lx: float = 0.0
    ly: float = 0.0


@dataclass
class Dial:
    label: str
    value: str
    units: str
    scale: str
    angle: float
    red: str
    ticks: list[Tick]


_DIAL_START, _DIAL_SWEEP, _CX = 135.0, 270.0, 100.0


def _polar(r: float, deg: float) -> tuple[float, float]:
    rad = math.radians(deg)
    return round(_CX + r * math.cos(rad), 2), round(_CX + r * math.sin(rad), 2)


def build_dial(label: str, text: str, units: str) -> Dial | None:
    """An analog gauge for a limit setting (rev limit, boost cut): the needle and the red zone start at the limit."""
    u = (units or "").lower()
    try:
        v = float(text)
    except ValueError:
        return None
    if v <= 0 or not ("limit" in label.lower() or "cut" in label.lower()):
        return None
    if "rpm" in u:
        major = 2000.0 if v > 11000 else 1000.0
        top, div, scale = math.ceil(v * 1.15 / major) * major, 1000.0, "×1000 rpm"
    elif "kpa" in u:
        major = next(s for s in (10, 20, 25, 50, 100, 200, 250, 500, 1000, 1e9) if s * 7 >= v * 1.2)
        top, div, scale = math.ceil(v * 1.2 / major) * major, 1.0, units
    else:
        return None
    ticks = []
    minor = major / 2
    for i in range(int(round(top / minor)) + 1):
        k = i * minor
        deg = _DIAL_START + _DIAL_SWEEP * k / top
        is_major = i % 2 == 0
        x1, y1 = _polar(84, deg)
        x2, y2 = _polar(70 if is_major else 77, deg)
        lx, ly = _polar(56, deg)
        ticks.append(Tick(x1, y1, x2, y2, is_major, f"{k / div:g}" if is_major else "", lx, ly))
    a0 = _DIAL_START + _DIAL_SWEEP * v / top
    sx, sy = _polar(80, a0)
    ex, ey = _polar(80, _DIAL_START + _DIAL_SWEEP)
    large = 1 if _DIAL_SWEEP * (top - v) / top > 180 else 0
    return Dial(label, text, units, scale, round(a0, 2), f"M{sx} {sy}A80 80 0 {large} 1 {ex} {ey}", ticks)


def gauges(summary: list[tuple[str, str, str]]) -> tuple[list[Dial], list[tuple[str, str, str]]]:
    """Split summary rows into analog dials (limits) and digital readouts (everything else)."""
    dials, readouts = [], []
    for label, val, units in summary:
        d = build_dial(label, val, units)
        if d:
            dials.append(d)
        else:
            readouts.append((label, val, units))
    return dials, readouts


def demo_grid() -> Grid:
    """A made-up VE table for the home page preview."""
    rpm = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000]
    kpa = [30, 40, 50, 60, 70, 80, 90, 100]
    vals = []
    for p in kpa:
        for n in rpm:
            torque = math.exp(-((n - 4200) / 2600) ** 2)
            vals.append(float(round(28 + 52 * (p / 100) ** 0.85 * (0.55 + 0.45 * torque))))
    z = Constant("veTable", "table", vals, len(kpa), len(rpm), "%", 0)
    return build_grid("demo", "VE Table", z, Constant("rpmBins", "array", [float(n) for n in rpm]),
                      Constant("mapBins", "array", [float(p) for p in kpa]), "ve", "%", "RPM", "kPa")


def table_nav(slug: str, tviews: list[TableView]) -> tuple[list[dict], list[tuple[str, list[dict]]]]:
    items = [{"name": v.z.name, "label": v.label, "cat": categorize(v.label, v.z.name), "url": c_url(slug, v.z.name)}
             for v in tviews]
    groups = [(CATEGORY_LABEL[cid], [i for i in items if i["cat"] == cid]) for cid in CATEGORY_ORDER]
    return items, [(label, g) for label, g in groups if g]


# --------------------------------------------------------------- diff page

STATUS_CHIPS = [("changed", "Changed"), ("mismatch", "Can't compare"), ("only_a", "Only in A"),
                ("only_b", "Only in B"), ("same", "Identical")]


@dataclass
class DiffCard:
    name: str
    label: str
    cat: str
    status: str
    changed: int
    total: int
    rows: int
    cols: int
    thumb: str
    stops: str
    url: str
    message: str
    search: str


@dataclass
class DiffModel:
    featured: list[tuple[diffmod.TableDiff, Grid | None]]
    cards: list[DiffCard]
    status_counts: list[tuple[str, str, int]]
    default_chip: str
    settings: list[tuple[diffmod.SettingDiff, str]]
    setting_counts: list[tuple[str, str, int]]
    tables_changed: int
    cells_changed: int


def diff_model(a: str, b: str, da: TuneDoc, db: TuneDoc, tmap: dict) -> DiffModel:
    tds = diffmod.diff_tables(da, db, tmap)
    stops = ",".join(palette("diff")[0])
    cards = []
    for td in tds:
        z = td.va.z if td.va else (td.vb.z if td.vb else td.zb)
        comparable = td.status in ("changed", "same")
        status = "mismatch" if td.status in ("dims", "kind") else td.status
        cards.append(DiffCard(td.name, td.label, categorize(td.label, td.name), status, td.changed, td.total,
                              z.rows if z else 0, z.cols if z else 0,
                              diff_thumb(td.va.z, td.zb) if comparable else "", stops,
                              d_url(a, b, td.name) if comparable else "", td.message, _search(td.label, td.name)))
    sc = Counter(c.status for c in cards)
    featured = []
    for td in tds:
        if td.featured:
            g = diffmod.grid_for(td)
            if g is not None:
                g.url = d_url(a, b, td.name)
            featured.append((td, g))
    sds = diffmod.diff_settings(da, db)
    stc = Counter(s.status for s in sds)
    return DiffModel(
        featured=featured,
        cards=cards,
        status_counts=[(s, label, sc[s]) for s, label in STATUS_CHIPS if sc[s]],
        default_chip="changed" if sc["changed"] else "all",
        settings=[(s, _search(s.name, s.a, s.b, " ".join(s.detail))) for s in sds],
        setting_counts=[(k, label, stc[k]) for k, label in (("changed", "Changed"), ("only_a", "Only in A"),
                                                           ("only_b", "Only in B")) if stc[k]],
        tables_changed=sum(1 for t in tds if t.status != "same"),
        cells_changed=sum(t.changed for t in tds),
    )


def diff_stats(td: diffmod.TableDiff) -> dict | None:
    if td.va is None or td.zb is None or td.status not in ("changed", "same"):
        return None
    za, zb = td.va.z, td.zb
    digits = za.digits if za.digits is not None else zb.digits
    deltas = [b - a for a, b in zip(za.values, zb.values)
              if isinstance(a, float) and isinstance(b, float) and not values_equal(a, b, digits)]
    up = max((d for d in deltas if d > 0), default=None)
    down = min((d for d in deltas if d < 0), default=None)
    return {
        "changed": td.changed,
        "total": td.total,
        "pct": f"{(td.changed / td.total * 100) if td.total else 0:.0f}%",
        "up": f"+{fmt_value(up, digits)}" if up is not None else "—",
        "down": f"−{fmt_value(abs(down), digits)}" if down is not None else "—",
    }
