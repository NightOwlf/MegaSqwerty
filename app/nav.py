"""Group tables, curves and settings into TunerStudio-style categories.

TunerStudio users navigate by menu: Fuel Settings, Spark Settings, Idle,
Boost, Sensors… The .msq file has no such grouping — it is a flat bag of
constants — so we infer one from each constant's name and its label in the
tablemap. The result drives the left-hand tree and the grouped settings
list, so every value is one click away instead of buried in a 1200-row
table.

Matching is deliberately dumb and ordered: the first category whose
keywords appear wins. Nothing is ever dropped — anything unmatched lands in
"Other", and every constant appears in exactly one category.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

# (key, menu label, short label, keywords). Order is priority order:
# "idleVeTable" is Idle, not Fuel, because Idle is checked first.
CATEGORIES: list[tuple[str, str, tuple[str, ...]]] = [
    ("crank", "Cranking & Warmup", (
        "crank", "prime", "warmup", "wue", "afterstart", "ase", "startup", "coldstart", "cold_start")),
    ("idle", "Idle Control", (
        "idle", "iac", "isc", "etbidle", "iacpid")),
    ("boost", "Boost Control", (
        "boost", "wastegate", "turbo", "overboost")),
    ("vvt", "Cam / VVT", (
        "vvt", "cam", "vct", "variablecam", "phaser")),
    ("accel", "Accel Enrichment", (
        "accel", "tpsaccel", "mapaccel", "decel", "ae_", "aetps", "wall", "wetting", "tau", "xtau")),
    ("knock", "Knock & Protection", (
        "knock", "detonation", "retard", "protect", "cutoff", "cut_", "limiter", "revlim", "hardlimit",
        "softlimit", "oilpress", "overtemp", "failsafe", "limp")),
    ("engine", "Engine", (
        "cylinder", "displacement", "bore", "stroke", "firingorder", "firing", "enginetype", "engine",
        "compression", "camshaft", "valvecount")),
    ("afr", "AFR / Lambda", (
        "afr", "lambda", "ego", "o2", "wideband", "wbo2", "stoich", "closedloop", "cl_fuel", "fueltrim")),
    ("spark", "Ignition", (
        "spark", "ignition", "advance", "dwell", "timing", "coil", "trigger", "crankingadvance")),
    ("fuel", "Fuel", (
        "fuel", "ve", "injector", "inj", "pulse", "pw", "squirt", "reqfuel", "flex", "ethanol", "e85",
        "staging", "primary", "secondary", "gppwm_fuel")),
    ("sensors", "Sensors & Calibration", (
        "sensor", "clt", "iat", "mat", "tps", "map", "maf", "baro", "therm", "cal", "adc", "volt",
        "batt", "vbatt", "pressure", "temp", "speed", "vss", "gear", "fuellevel", "aux", "analog")),
    ("io", "I/O & Hardware", (
        "pin", "port", "output", "input", "gpio", "can", "spi", "i2c", "uart", "serial", "bluetooth",
        "led", "relay", "pump", "fan", "starter", "solenoid", "stepper", "dc_", "h_bridge", "hbridge",
        "etb", "throttlebody", "pedal", "pps", "dbw")),
    ("log", "Logging & Comms", (
        "log", "datalog", "tunerstudio", "ts_", "tscan", "telemetry", "debug", "console", "sd_", "sdcard")),
    ("script", "Scripting", (
        "lua", "script", "gppwm", "gp_pwm", "auxvalve")),
]

CATEGORY_LABEL = {k: label for k, label, _ in CATEGORIES}
CATEGORY_LABEL["other"] = "Other"

# How categories are laid out on the page and in the menus. Matching order
# above is about precedence; this is about what a tuner expects to see first.
CATEGORY_ORDER = ["engine", "fuel", "afr", "spark", "crank", "accel", "idle", "boost", "vvt",
                  "knock", "sensors", "io", "log", "script", "other"]
assert set(CATEGORY_ORDER) == set(CATEGORY_LABEL), "CATEGORY_ORDER must cover every category"

# Words that would otherwise drag a whole category along. "revlimit" is
# Protection, not Fuel, even though "ve" is inside "rev".
_WORD = re.compile(r"[^a-z0-9]+")

# Keywords short enough to cause false hits ("ve" inside "valve") only match
# as a whole word or as a camelCase/underscore-delimited token.
_SHORT = {"ve", "inj", "pw", "o2", "map", "maf", "iat", "mat", "clt", "tps", "vss", "can", "led",
          "ase", "wue", "iac", "isc", "etb", "pps", "dbw", "cam", "vct", "ego", "adc", "spi", "i2c"}


def _tokens(text: str) -> tuple[str, set[str]]:
    """-> (flattened lowercase haystack, set of word tokens).

    'boostTableOpenLoop' -> ('boosttableopenloop', {'boost','table','open','loop'})
    """
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    spaced = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", spaced)
    low = spaced.lower()
    words = {w for w in _WORD.split(low) if w}
    # Split trailing digits off so "vvtTable1" yields "vvt" and "table".
    for w in list(words):
        m = re.fullmatch(r"([a-z]+?)(\d+)", w)
        if m:
            words.add(m.group(1))
    return re.sub(r"[^a-z0-9]", "", low), words


@lru_cache(maxsize=8192)
def categorize(*texts: str) -> str:
    """Best-guess category key for a constant, from its name and label.

    Cached: a big rusEFI tune carries ~2000 constants and the same names come
    back on every page view.
    """
    hay, words = _tokens(" ".join(t for t in texts if t))
    for key, _label, keywords in CATEGORIES:
        for kw in keywords:
            if kw in _SHORT:
                if kw in words:
                    return key
            elif kw in hay:
                return key
    return "other"


@dataclass
class NavItem:
    """One clickable row in the left tree."""
    id: str          # DOM id of the target panel or group
    label: str
    sub: str = ""    # dims, counts — shown dimmed on the right
    kind: str = ""   # "table" | "curve" | "settings" | "page"


@dataclass
class NavGroup:
    id: str
    label: str
    items: list[NavItem] = field(default_factory=list)
    open: bool = True

    @property
    def count(self) -> int:
        return len(self.items)


@dataclass
class CatGroup:
    """A category bucket of tables, curves or settings."""
    key: str
    label: str
    items: list = field(default_factory=list)

    @property
    def id(self) -> str:
        return f"cat-{self.key}"

    @property
    def count(self) -> int:
        return len(self.items)


def group_by_category(entries, text_of) -> list[CatGroup]:
    """Bucket `entries` into CatGroups, in CATEGORY_ORDER, skipping empties."""
    buckets: dict[str, list] = {}
    for e in entries:
        buckets.setdefault(categorize(*text_of(e)), []).append(e)
    return [CatGroup(k, CATEGORY_LABEL[k], buckets[k]) for k in CATEGORY_ORDER if buckets.get(k)]


@dataclass
class Item:
    """One renderable thing inside a category section."""
    anchor: str      # DOM id, minus the "sec-" prefix
    label: str
    sub: str
    kind: str        # "grid" (rendered now) | "table" (lazy) | "curve"
    payload: object = None


@dataclass
class Section:
    """A TunerStudio-style category page: its tables, curves and settings."""
    key: str
    label: str
    items: list[Item] = field(default_factory=list)
    settings: list = field(default_factory=list)

    @property
    def anchor(self) -> str:
        return f"cat-{self.key}"

    @property
    def settings_anchor(self) -> str:
        return f"s-{self.key}"

    @property
    def count(self) -> int:
        return len(self.items)

    @property
    def sub(self) -> str:
        bits = []
        n_t = sum(1 for i in self.items if i.kind in ("grid", "table"))
        n_c = sum(1 for i in self.items if i.kind == "curve")
        if n_t:
            bits.append(f"{n_t} table" + ("s" if n_t != 1 else ""))
        if n_c:
            bits.append(f"{n_c} curve" + ("s" if n_c != 1 else ""))
        if self.settings:
            bits.append(f"{len(self.settings)} setting" + ("s" if len(self.settings) != 1 else ""))
        return " · ".join(bits)


def build_sections(grids=(), tables=(), curve_grids=(), settings=()) -> list[Section]:
    """Sort everything in a tune into category sections, in CATEGORY_ORDER.

    `grids` are already-rendered heatmaps (the featured tables), `tables` are
    TableViews rendered lazily on scroll, `curve_grids` are 1-D curves and
    `settings` are raw constants. Every input lands in exactly one section.
    """
    by_key: dict[str, Section] = {}

    def sect(key: str) -> Section:
        if key not in by_key:
            by_key[key] = Section(key, CATEGORY_LABEL[key])
        return by_key[key]

    n = 0
    for g in grids:
        n += 1
        sect(categorize(g.title, g.name)).items.append(
            Item(f"g{n}-{g.id}", g.title, g.dims, "grid", g))
    for v in tables:
        n += 1
        sect(categorize(v.label, v.z.name)).items.append(
            Item(f"t{n}-{v.id}", v.label, f"{v.z.rows}×{v.z.cols}", "table", v))
    for g in curve_grids:
        n += 1
        sect(categorize(g.title, g.name)).items.append(
            Item(f"c{n}-{g.id}", g.title, f"{len(g.x_labels)} pts", "curve", g))
    for c in settings:
        sect(categorize(c.name)).settings.append(c)
    return [by_key[k] for k in CATEGORY_ORDER if k in by_key]


def nav_from_sections(sections, overview_label: str = "Overview") -> list[NavGroup]:
    """The left-hand tree: one expandable group per category."""
    groups = [NavGroup("g-overview", "Tune", [NavItem("overview", overview_label, "", "page")])]
    for s in sections:
        items = [NavItem(i.anchor, i.label, i.sub, i.kind) for i in s.items]
        if s.settings:
            items.append(NavItem(s.settings_anchor, "Settings", str(len(s.settings)), "settings"))
        groups.append(NavGroup(s.anchor, s.label, items, open=len(items) <= 14))
    return groups
