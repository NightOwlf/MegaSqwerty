"""Prep a tune for boost, step boost up in stages, and set boost by gear or by speed.

The user answers a few questions about their setup. `assess` reads what the tune already has (what load the
fuel and ignition tables use, the MAP sensor's range, the boost controller, boost cut, by-gear settings).
`build_plan` works out the most boost this setup can start with, the reason for every limit, and the numbers
to write. `create` writes them with edit.apply_changes, exactly like any other edit, then `verify` re-reads the
result and refuses it if any safety property doesn't hold.

Safety rules the plan follows, and `verify` re-checks on the written file:
  * Only ever richer and only ever less advance in boost than the tune's own atmospheric row.
  * VE in boost never drops below the atmospheric row.
  * The boost target never exceeds the smallest limit (engine, fuel, intercooler, fuel pump, injectors,
    MAP sensor, step size), and never goes up more than a few psi from the tune's current boost.
  * Boost cut sits a few psi above the target and inside what the MAP sensor can read.
  * Stage 1 is the wastegate spring alone: open-loop duty 0% and, where the tune has it, max duty 0%.
  * A lost gear or speed signal falls back to the lowest scheduled boost, not the highest.
  * The rev limit is never touched, and the result must still pass Tune Health with nothing to fix.

Nothing here can switch an option (boost control on, boost cut on, fuel algorithm): a .msq doesn't list the
choices, so those become a checklist for TunerStudio. Setting names the plan can't confirm from the tune (its
units, its mode) are reported and left alone rather than guessed.

This makes a conservative starting point for logging with a wideband. It can't make a tune safe on its own.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass, field

from . import checks as checksmod
from .axes import ATMOSPHERE_KPA, BOOST_EDGE_KPA, placeholder_parts
from .edit import EditError, apply_changes, edit_digits
from .parser import Constant, MsqError, TuneDoc, parse_msq
from .render import fuel_mode
from .tablemaps import TableView, all_tables

PSI_KPA = 6.894757

# Load rows up to here count as atmospheric: kept as they are, and the highest one is the full-throttle row that
# boost rows are built from. A little above BOOST_EDGE_KPA, because many tunes put their last "no boost" bin at 105.
ATM_REF_KPA = 106.0


def kpa_of(psi: float) -> float:
    """Boost gauge psi -> absolute kPa at sea level."""
    return ATMOSPHERE_KPA + psi * PSI_KPA


def psi_of(kpa: float) -> float:
    return (kpa - ATMOSPHERE_KPA) / PSI_KPA


class BoostError(ValueError):
    """Raised when a boost tune can't be written safely. `str(err)` is safe to show users."""


# ------------------------------------------------------------------ profiles and limits

@dataclass(frozen=True)
class Fuel:
    label: str
    lam: float        # lambda target in boost
    retard: float     # degrees removed per psi of boost, from the atmospheric row
    max_adv: float    # the most advance allowed anywhere in boost
    stock_cap: float  # psi ceiling on stock internals
    built_cap: float  # psi ceiling on built internals
    flow: float       # fuel flow needed, relative to gasoline


FUELS = {
    "91": Fuel("Pump 91 (95 RON)", 0.78, 1.5, 18.0, 6.0, 12.0, 1.0),
    "93": Fuel("Pump 93 (98 RON)", 0.78, 1.2, 20.0, 8.0, 14.0, 1.0),
    "e30": Fuel("E30 blend", 0.80, 1.0, 22.0, 9.0, 16.0, 1.12),
    "e85": Fuel("E85", 0.80, 0.7, 26.0, 11.0, 20.0, 1.40),
    "race": Fuel("Race fuel (100+ octane)", 0.78, 0.8, 24.0, 10.0, 20.0, 1.0),
}
GOALS = {"stage1": "Stage 1 · first boost on the wastegate spring",
         "stage2": "Stage 2 · step up 3 psi over the spring",
         "custom": "Custom target"}

STAGE1_RETARD = 2.0      # extra degrees out for the first drive
STAGE1_RICHER = 0.02     # extra lambda richness for the first drive
STAGE1_VE = 1.05         # VE in boost rows relative to the atmospheric row, first drive
VE_ENRICH = 1.03
STAGE2_STEP = 3.0        # psi over the spring for Stage 2
STEP_PSI = 4.0           # the most boost can go up from what the tune already runs
NO_IC_CAP = 8.0
NO_IC_RETARD = 0.5
PUMP_CAP = 7.0           # stock or unknown fuel pump
UNVERIFIED_FUEL_CAP = 7.0  # no injector size / engine power to check fuel capacity against
MAX_DUTY_ABOVE_SPRING = 50.0
LOW_TPS = 20.0           # below this throttle the boost target stays at the spring
SENSOR_USABLE = 0.95     # a MAP sensor's output flattens near its top
BSFC = 0.60              # lb/hp/hr, a conservative figure for boosted gasoline
INJ_DUTY = 0.80
GEARS = 6
SPEED_ROWS = 6


def cut_margin(psi: float) -> float:
    """How far above the target boost cut sits: enough for spring creep and a small spike."""
    return max(3.0, 0.15 * psi)


# ------------------------------------------------------------------ answers

@dataclass
class Answers:
    spring_psi: float | None = None
    intercooler: bool = True
    fuel: str = "93"
    internals: str = "stock"      # stock | built
    pump: str = "unsure"          # upgraded | stock | unsure
    injector_cc: float | None = None
    na_hp: float | None = None
    map_kpa: float | None = None  # only asked when the tune doesn't say
    wideband: bool = False
    goal: str = "stage1"          # stage1 | stage2 | custom
    target_psi: float | None = None
    logged: bool = False          # the previous stage was logged and looked right
    schedule: str = "none"        # none | gear | speed
    gear_psi: list = field(default_factory=lambda: [None] * GEARS)
    speed_unit: str = "mph"       # mph | kmh
    speeds: list = field(default_factory=lambda: [[None, None] for _ in range(SPEED_ROWS)])

    def signature(self) -> str:
        """Identifies these answers, so Create can refuse a plan that wasn't the one previewed."""
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode()).hexdigest()[:16]


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:]


def parse_answers(form, defaults: dict | None = None) -> tuple[Answers, list[str]]:
    """Form fields (strings) -> Answers and the problems with them. Unknown choices fall back to the safest."""
    errors: list[str] = []
    get = (lambda k: str(form.get(k) or "").strip())

    def num(key, lo, hi, label, required=False):
        raw = get(key).replace(",", ".")
        if not raw:
            if required:
                errors.append(f"Enter {label}.")
            return None
        try:
            v = float(raw)
        except ValueError:
            errors.append(f"{_cap(label)} must be a number.")
            return None
        if not math.isfinite(v) or not lo <= v <= hi:
            errors.append(f"{_cap(label)} must be between {lo:g} and {hi:g}.")
            return None
        return v

    def pick(key, choices, fallback):
        v = get(key)
        return v if v in choices else fallback

    a = Answers()
    a.spring_psi = num("spring_psi", 2, 30, "the wastegate spring pressure (psi)", required=True)
    a.intercooler = get("intercooler") != "no"
    a.fuel = pick("fuel", FUELS, "91")
    a.internals = pick("internals", ("stock", "built"), "stock")
    a.pump = pick("pump", ("upgraded", "stock", "unsure"), "unsure")
    a.injector_cc = num("injector_cc", 80, 3000, "injector size (cc/min)")
    a.na_hp = num("na_hp", 20, 1500, "engine power without boost (hp)")
    a.map_kpa = num("map_kpa", 100, 1000, "the MAP sensor range (kPa)")
    a.wideband = get("wideband") in ("yes", "on", "1", "true")
    a.goal = pick("goal", GOALS, "stage1")
    a.target_psi = num("target_psi", 1, 40, "the custom boost target (psi)", required=a.goal == "custom")
    a.logged = get("logged") in ("yes", "on", "1", "true")
    a.schedule = pick("schedule", ("none", "gear", "speed"), "none")
    a.speed_unit = pick("speed_unit", ("mph", "kmh"), "mph")
    if a.schedule == "gear":
        a.gear_psi = [num(f"gear{i + 1}_psi", 0, 40, f"gear {i + 1} boost (psi)") for i in range(GEARS)]
        if all(v is None for v in a.gear_psi):
            errors.append("Enter boost for at least one gear, or turn boost by gear off.")
    if a.schedule == "speed":
        rows = []
        for i in range(SPEED_ROWS):
            s = num(f"speed{i + 1}", 0, 400, f"speed point {i + 1}")
            p = num(f"speed{i + 1}_psi", 0, 40, f"boost at speed point {i + 1} (psi)")
            if (s is None) != (p is None):
                errors.append(f"Speed point {i + 1} needs both a speed and a boost.")
            rows.append([s, p])
        a.speeds = rows
        filled = [r for r in rows if None not in r]
        if not filled:
            errors.append("Enter at least one speed and boost, or turn boost by speed off.")
        elif len({r[0] for r in filled}) != len(filled):
            errors.append("Each speed point needs a different speed.")
    return a, errors


# ------------------------------------------------------------------ reading the tune

def _is_off(value: str | None) -> bool:
    return value is None or value.strip().lower() in ("off", "no", "disabled", "false", "0", "")


def _scalar(doc: TuneDoc, name: str) -> float | None:
    c = doc.get(name)
    if c is None or c.kind not in ("scalar", "string") or not c.values:
        return None
    v = c.values[0]
    if isinstance(v, str):
        try:
            v = float(v.strip())
        except ValueError:
            return None
    return v if isinstance(v, float) and math.isfinite(v) else None


def _first_scalar(doc: TuneDoc, names) -> tuple[str, float] | None:
    for n in names:
        c = doc.get(n)
        if c is not None and c.kind == "scalar" and isinstance(c.value, float):
            return n, c.value
    return None


def _option(doc: TuneDoc, name: str) -> str | None:
    c = doc.get(name)
    return str(c.value).strip() if c is not None and c.kind == "string" else None


def _numeric(c: Constant | None) -> bool:
    return c is not None and bool(c.values) and all(isinstance(v, float) for v in c.values)


def _units(c: Constant | None, tmap: dict | None = None) -> str:
    if c is None:
        return ""
    u = c.units or ""
    if not u and tmap:
        m = tmap.get("constant_meta", {}).get(c.name)
        u = str(m.get("units") or "") if isinstance(m, dict) else ""
    return u.lower()


def _digits(c: Constant) -> int:
    return c.digits if c.digits is not None and 0 <= c.digits <= 6 else edit_digits(c)


@dataclass
class Fact:
    label: str
    value: str
    status: str  # ok | warn | bad | info
    detail: str = ""


@dataclass
class MainTable:
    role: str               # ve | spark | afr
    view: TableView
    fuel: str | None = None  # afr tables: lambda | afr
    assumed: bool = False   # load taken to be MAP because the VE table's is


@dataclass
class Blend:
    """A rusEFI/FOME closed-loop boost blend table: kPa adders looked up by a chosen parameter."""
    n: int
    table: Constant
    load_bins: Constant
    values: Constant | None
    axis: str   # the option that picks what load_bins mean, e.g. "Vehicle Speed"
    param: str  # the option that picks the bias curve's input


@dataclass
class Assessment:
    family: str
    tables: list[MainTable] = field(default_factory=list)
    facts: list[Fact] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    map_kpa: float | None = None
    map_source: str = ""
    cut: Constant | None = None
    cut_options: list[tuple[str, str]] = field(default_factory=list)
    boost_enabled: tuple[str, str] | None = None
    boost_type: tuple[str, str] | None = None
    targets: list[Constant] = field(default_factory=list)
    duties: list[Constant] = field(default_factory=list)
    max_duty: Constant | None = None
    safe_duty: Constant | None = None
    duty_adders: list[Constant] = field(default_factory=list)
    open_blends: list[Constant] = field(default_factory=list)
    blends: list[Blend] = field(default_factory=list)
    by_gear: list[Constant] = field(default_factory=list)
    by_gear_mode: tuple[str, str] | None = None
    cylinders: float | None = None
    injector_cc: float | None = None
    rev: tuple[str, float] | None = None
    incorporate: bool | None = None
    stoich: float = 14.7
    current_psi: float | None = None
    health_errors: list[str] = field(default_factory=list)
    lambda_protect: tuple[str, str] | None = None
    tps_rows: dict = field(default_factory=dict)  # target table name -> its TPS bins, when it has them

    @property
    def closed_loop(self) -> bool:
        return bool(self.targets) and (self.boost_type is None or "closed" in self.boost_type[1].lower())

    @property
    def top_load(self) -> float | None:
        ve = next((t for t in self.tables if t.role == "ve"), None)
        nums = [v for v in (ve.view.y.values if ve else []) if isinstance(v, float)]
        return max(nums) if nums else None


_MAP_SENSORS = [(r"2\.5.?bar", 250.0), (r"4250", 250.0), (r"6400|4.?bar", 400.0), (r"6300|3.?bar", 300.0),
                (r"2.?bar|4200", 200.0), (r"4100|4115|1.?bar", 105.0)]
MAP_MAX_NAMES = ("mapMax", "mapmax", "map_max", "MAPmax", "map_sensor_highValue", "mapHighValue")
CUT_NAMES = ("boostCutPressure", "OverBoostKpa", "boostLimit", "boostCut", "overboostKpa")
CUT_OPTIONS = ("boostCutEnabled", "OverBoostOption", "overboostOption", "engineProtectType")
TARGET_TABLES = ("boostTableClosedLoop", "boostTable", "boost_ctl_load_targets")
DUTY_TABLES = ("boostTableOpenLoop", "boostTable", "boost_ctl_pwm_targets")
# Names whose own label says what the table holds, for tunes that don't store units.
KNOWN_TARGET = {"boostTableClosedLoop"}
KNOWN_DUTY = {"boostTableOpenLoop"}
ROLE_IDS = (("ve", "ve"), ("ve2", "ve"), ("spark", "spark"), ("spark2", "spark"), ("afr", "afr"))


def _looks_kpa(bins: Constant | None) -> bool:
    nums = [v for v in (bins.values if bins else []) if isinstance(v, float)]
    return len(nums) >= 2 and min(nums) >= 0 and 90 <= max(nums) <= 1000


def _load_is_map(v: TableView) -> bool | None:
    if v.load is not None and v.load.known:
        return v.load.measure == "MAP"
    if v.y_units == "kPa":
        return True
    return None


def _map_sensor(doc: TuneDoc) -> tuple[float | None, str]:
    found = _first_scalar(doc, MAP_MAX_NAMES)
    if found and 100 <= found[1] <= 1000:
        return found[1], found[0]
    for c in doc.constants.values():
        if c.kind != "string" or not re.search(r"map", c.name, re.I) or not re.search(r"sensor|type", c.name, re.I):
            continue
        text = str(c.value)
        for pattern, kpa in _MAP_SENSORS:
            if re.search(pattern, text, re.I):
                return kpa, f"{c.name} = “{text}”"
    return None, ""


def _g(v: float, places: int = 1) -> str:
    return f"{round(v, places):g}"


def assess(doc: TuneDoc, views: list[TableView], tmap: dict | None = None, health: list[dict] | None = None) -> Assessment:
    a = Assessment(family=doc.family)
    facts, block = a.facts, a.blockers

    # ---- what load the main tables use
    by_id: dict[str, TableView] = {}
    for v in views:
        by_id.setdefault(v.id, v)
    ve_view = by_id.get("ve")
    ve_map = _load_is_map(ve_view) if ve_view is not None else None
    for tid, role in ROLE_IDS:
        v = by_id.get(tid)
        if v is None or v.y is None or len(v.y.values) != v.z.rows or not _numeric(v.z) or not _numeric(v.y):
            continue
        if placeholder_parts(v.z, v.x, v.y):
            continue
        is_map, assumed = _load_is_map(v), False
        if is_map is None and ve_map and _looks_kpa(v.y):
            is_map, assumed = True, True
        if tid == "ve" and not is_map:
            block.append(f"{v.label} doesn't use MAP (speed density) for load"
                         + (f" ({v.load.setting} = “{v.load.choice}”)" if v.load else "")
                         + ". Boost needs MAP load: switch the fuel algorithm to Speed Density in TunerStudio, "
                           "tune it, and upload again.")
            continue
        if not is_map:
            if role == "spark" and tid == "spark":
                block.append(f"{v.label} doesn't use MAP for load, so timing can't be pulled as boost rises. "
                             "Switch its algorithm to Speed Density/MAP in TunerStudio and upload again.")
            elif role == "afr":
                facts.append(Fact("AFR targets", "not by MAP", "warn",
                                  f"{v.label} isn't looked up by MAP, so its boost targets can't be set here."))
            continue
        a.tables.append(MainTable(role, v, fuel_mode(v.z, v.units, v.palette) if role == "afr" else None, assumed))
    roles = {t.role for t in a.tables}
    if ve_view is None:
        block.append("This tune has no VE table this tool can find, so it can't be prepared for boost.")
    elif ve_map:
        facts.append(Fact("Fuel load", "MAP (speed density)", "ok",
                          f"{ve_view.label}: {ve_view.load.text}" if ve_view.load else f"{ve_view.label} load bins are in kPa."))
    if "spark" not in roles and not any("MAP for load, so timing" in b for b in block):
        facts.append(Fact("Ignition", "no MAP-based table found", "warn",
                          "Timing in boost can't be set here. Boost only once timing in boost is handled."))
        block.append("No MAP-based ignition table was found, so timing in boost can't be set.")
    if "afr" not in roles:
        facts.append(Fact("AFR targets", "no MAP-based table", "info",
                          "Richer boost targets can't be written; VE carries the extra fuel instead."))

    # ---- load bins
    ve = next((t for t in a.tables if t.role == "ve"), None)
    if ve is not None:
        top = a.top_load
        atm = [b for b in ve.view.y.values if b <= ATM_REF_KPA]
        if not atm or max(atm) < 95:
            block.append(f"{ve.view.label} load bins don't reach atmospheric (about 100 kPa), so there's no full-"
                         "throttle fuel to build boost fuelling from. Extend and tune the table first.")
        elif top is not None and top <= ATM_REF_KPA:
            facts.append(Fact("Load bins", f"stop at {_g(top, 0)} kPa", "info",
                              "No boost rows yet. The plan rescales the load bins and adds boost rows."))
        elif top is not None:
            facts.append(Fact("Load bins", f"reach {_g(top, 0)} kPa ({_g(psi_of(top))} psi)", "ok",
                              "Boost rows already exist; the plan rewrites them conservatively."))

    # ---- MAP sensor
    a.map_kpa, a.map_source = _map_sensor(doc)
    if a.map_kpa is None:
        facts.append(Fact("MAP sensor", "range not in the tune", "warn", "Enter the sensor's range below."))
    elif a.map_kpa <= 115:
        facts.append(Fact("MAP sensor", f"reads up to {_g(a.map_kpa, 0)} kPa", "bad", a.map_source))
        block.append(f"The MAP sensor reads up to {_g(a.map_kpa, 0)} kPa ({a.map_source}), so it can't read boost. "
                     "Fit a 2.5 bar or larger sensor, set its calibration in TunerStudio and upload again.")
    else:
        facts.append(Fact("MAP sensor", f"reads up to {_g(a.map_kpa, 0)} kPa (≈ {_g(psi_of(a.map_kpa))} psi boost)",
                          "ok", a.map_source))

    # ---- boost controller
    for name in CUT_NAMES:
        c = doc.get(name)
        u = _units(c, tmap)
        if (c is not None and c.kind == "scalar" and isinstance(c.value, float) and 0 <= c.value <= 1000
                and ("kpa" in u or (not u and name != "boostCut"))):
            a.cut = c
            break
    a.cut_options = [(n, _option(doc, n)) for n in CUT_OPTIONS if _option(doc, n) is not None]
    for n in ("boostEnabled", "isBoostControlEnabled"):
        if _option(doc, n) is not None:
            a.boost_enabled = (n, _option(doc, n))
            break
    if _option(doc, "boostType") is not None:
        a.boost_type = ("boostType", _option(doc, "boostType"))
    seen: set[str] = set()
    for name in TARGET_TABLES:
        c = doc.get(name)
        if c is not None and c.is_table and _numeric(c) and ("kpa" in _units(c, tmap) or name in KNOWN_TARGET):
            a.targets.append(c)
            seen.add(name)
    for name in DUTY_TABLES:
        c = doc.get(name)
        if (c is not None and c.is_table and _numeric(c) and name not in seen
                and ("%" in _units(c, tmap) or name in KNOWN_DUTY)):
            a.duties.append(c)
    for c in a.targets:
        v = next((x for x in views if x.z.name == c.name), None)
        if v is not None and v.y is not None and len(v.y.values) == c.rows and _numeric(v.y) and (
                "tps" in v.y.name.lower() or v.y_label == "TPS"):
            a.tps_rows[c.name] = list(v.y.values)
    for name, attr in (("boostMaxDuty", "max_duty"), ("boostControlSafeDutyCycle", "safe_duty")):
        c = doc.get(name)
        if c is not None and c.kind == "scalar" and isinstance(c.value, float):
            setattr(a, attr, c)
    for name in ("gearBasedOpenLoopBoostAdder",):
        c = doc.get(name)
        if c is not None and c.is_array and _numeric(c):
            a.duty_adders.append(c)
    for n in (1, 2):
        c = doc.get(f"boostOpenLoopBlends{n}_table")
        if c is not None and c.is_table and _numeric(c):
            a.open_blends.append(c)
        table, bins = doc.get(f"boostClosedLoopBlends{n}_table"), doc.get(f"boostClosedLoopBlends{n}_loadBins")
        if table is not None and table.is_table and _numeric(table) and bins is not None and len(bins.values) == table.rows:
            a.blends.append(Blend(n, table, bins, doc.get(f"boostClosedLoopBlends{n}_blendValues"),
                                  _option(doc, f"boostClosedLoopBlends{n}_yAxisOverride") or "",
                                  _option(doc, f"boostClosedLoopBlends{n}_blendParameter") or ""))
    a.by_gear = [c for c in (doc.get(f"boostByGear{i}") for i in range(1, 9))
                 if c is not None and c.kind == "scalar" and isinstance(c.value, float)]
    if _option(doc, "boostByGearEnabled") is not None:
        a.by_gear_mode = ("boostByGearEnabled", _option(doc, "boostByGearEnabled"))

    if a.cut is not None:
        facts.append(Fact("Boost cut", f"{a.cut.name} = {_g(a.cut.value, 0)} kPa", "ok",
                          "The plan sets it a few psi above your target."))
    else:
        facts.append(Fact("Boost cut", "no setting found", "warn",
                          "Without an ECU boost cut, the wastegate is the only thing limiting boost. Only Stage 1 "
                          "(spring pressure) is allowed."))
    if a.closed_loop:
        facts.append(Fact("Boost control", "closed loop (kPa targets)", "ok",
                          ", ".join(c.name for c in a.targets)))
    elif a.targets or a.duties:
        what = f"{a.boost_type[0]} = “{a.boost_type[1]}”" if a.boost_type else ", ".join(c.name for c in a.duties)
        facts.append(Fact("Boost control", "open loop (duty only)", "warn",
                          f"{what}. Open-loop duty can't be turned into a pressure safely, so boost stays at the "
                          "wastegate spring until closed loop is on."))
    else:
        facts.append(Fact("Boost control", "no boost tables found", "warn",
                          "Boost is whatever the wastegate spring makes."))
    if a.by_gear or any(re.search(r"gear|speed", b.axis, re.I) for b in a.blends):
        facts.append(Fact("Boost by gear/speed", "available", "ok",
                          ", ".join([c.name for c in a.by_gear[:1]] + [f"{b.table.name} by “{b.axis}”" for b in a.blends
                                                                         if re.search(r"gear|speed", b.axis, re.I)])))

    # ---- engine and fuel system
    cyl = next((v for v in (_scalar(doc, n) for n in ("nCylinders", "nCylinders1", "cylindersCount")) if v), None)
    a.cylinders = cyl if cyl and 1 <= cyl <= 16 else None
    inj = _first_scalar(doc, ("injector_flow",))
    a.injector_cc = inj[1] if inj and 50 <= inj[1] <= 3000 else None
    a.rev = _first_scalar(doc, checksmod.REV_LIMIT_NAMES)
    stoich = _scalar(doc, "stoich")
    a.stoich = stoich if stoich and 6 <= stoich <= 16 else 14.7
    if doc.family in ("rusEFI", "FOME"):
        a.incorporate = True
    else:
        inc = next((c for c in doc.constants.values() if c.kind == "string" and "incorporat" in c.name.lower()), None)
        a.incorporate = None if inc is None else not _is_off(str(inc.value))
    if _option(doc, "lambdaProtectionEnable") is not None:
        a.lambda_protect = ("lambdaProtectionEnable", _option(doc, "lambdaProtectionEnable"))
    if a.rev:
        facts.append(Fact("Rev limit", f"{_g(a.rev[1], 0)} rpm", "ok" if 1000 <= a.rev[1] <= 20000 else "bad",
                          "Never changed by boost prep."))

    # ---- what boost the tune already runs
    boosted = [max(c.values) for c in a.targets if max(c.values) > BOOST_EDGE_KPA + 2]
    if boosted:
        a.current_psi = psi_of(max(boosted))
    elif a.cut is not None and a.cut.value > 115:
        cut_psi = psi_of(a.cut.value)
        a.current_psi = max(0.0, cut_psi - 3.0 if cut_psi < 23 else cut_psi / 1.15)
    if a.current_psi is not None:
        facts.append(Fact("Current boost", f"about {_g(a.current_psi)} psi", "info",
                          "Read from the boost targets or boost cut. New targets can go at most "
                          f"{STEP_PSI:g} psi above this."))

    # ---- tune health
    results = health if health is not None else checksmod.run(doc, views)
    a.health_errors = [r["text"] for r in results if r["status"] == "error"]
    if a.health_errors:
        facts.append(Fact("Tune Health", f"{len(a.health_errors)} to fix", "bad", a.health_errors[0]))
        block.append("Tune Health has problems to fix before this engine should run at all, let alone on boost: "
                     + " ".join(a.health_errors[:3]))
    else:
        facts.append(Fact("Tune Health", "nothing to fix", "ok"))
    return a


def card(a: Assessment) -> dict:
    """A short summary for the Dash."""
    if a.blockers:
        return {"tone": "error", "headline": f"{len(a.blockers)} thing{'s' if len(a.blockers) != 1 else ''} to sort "
                                             "out before boost", "facts": a.facts[:4]}
    top = a.top_load
    if top is not None and top <= ATM_REF_KPA:
        return {"tone": "info", "headline": "Naturally aspirated tune: ready to prep for boost", "facts": a.facts[:4]}
    return {"tone": "ok", "headline": "Ready to prep or step up boost", "facts": a.facts[:4]}


# ------------------------------------------------------------------ the plan

@dataclass
class Limit:
    label: str
    psi: float
    reason: str
    binding: bool = False


@dataclass
class Item:
    label: str
    name: str
    detail: str


@dataclass
class Plan:
    answers: Answers
    assessment: Assessment
    errors: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    limits: list[Limit] = field(default_factory=list)
    safe_psi: float | None = None
    requested_psi: float | None = None
    target_psi: float | None = None
    table_psi: float | None = None  # what the boost target tables hold (lower with a fallback schedule)
    cut_kpa: float | None = None
    usable_kpa: float | None = None
    changes: dict = field(default_factory=dict)
    items: list[Item] = field(default_factory=list)
    failsafes: list[str] = field(default_factory=list)
    required: list[str] = field(default_factory=list)
    recommended: list[str] = field(default_factory=list)
    logging: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    schedule: list[dict] = field(default_factory=list)
    checks: dict = field(default_factory=dict)  # what verify() re-checks on the written file

    @property
    def ok(self) -> bool:
        return not self.errors and not self.blockers and bool(self.changes)

    @property
    def target_kpa(self) -> float | None:
        return kpa_of(self.target_psi) if self.target_psi is not None else None

    @property
    def stage(self) -> str:
        return GOALS.get(self.answers.goal, "")

    @property
    def fuel(self) -> Fuel:
        return FUELS[self.answers.fuel]


def _even(kpa: float) -> float:
    """Round down to an even kPa: some firmware stores pressures in 2 kPa steps, and down is the safe way."""
    return float(math.floor(kpa / 2) * 2)


def _put(plan: Plan, doc: TuneDoc, name: str, values) -> int:
    """Stage new values for a constant, keeping only the ones that differ. -> how many changed."""
    c = doc.get(name)
    d = _digits(c)
    out = plan.changes.setdefault(name, {})
    pairs = values.items() if isinstance(values, dict) else enumerate(values)
    for i, v in pairs:
        v = round(float(v), d) + 0.0
        old = c.values[i]
        if isinstance(old, float) and abs(round(old, d) - v) < 0.5 * 10 ** -d:
            out.pop(str(i), None)
        else:
            out[str(i)] = v
    if not out:
        del plan.changes[name]
    return len(out)


def _interp(bins: list[float], rows: list[list[float]], b: float) -> list[float]:
    if b <= bins[0]:
        return list(rows[0])
    if b >= bins[-1]:
        return list(rows[-1])
    for k in range(len(bins) - 1):
        if bins[k] <= b <= bins[k + 1]:
            span = bins[k + 1] - bins[k]
            t = (b - bins[k]) / span if span else 0.0
            return [p + (q - p) * t for p, q in zip(rows[k], rows[k + 1])]
    return list(rows[-1])


def _rows(z: Constant) -> list[list[float]]:
    return [list(z.row(r)) for r in range(z.rows)]


def atm_row(bins: list[float], rows: list[list[float]]) -> list[float]:
    """The table's own full-throttle, no-boost row: the highest load bin at or below atmospheric."""
    k = max(i for i, b in enumerate(bins) if b <= ATM_REF_KPA)
    return list(rows[k])


def new_load_bins(bins: list[float], cut_kpa: float, top: float, digits: int) -> list[float] | None:
    """Load bins that keep the vacuum rows the tune has and add boost rows up to `top`.

    -> the existing bins when they already cover boost to the cut, or None when rows can't be laid out.
    """
    n = len(bins)
    if bins[-1] >= cut_kpa and sum(1 for b in bins if ATM_REF_KPA < b <= cut_kpa + 15) >= 2:
        return list(bins)
    if n < 4:
        return None
    n_boost = max(2, min(5, round(n / 4)))
    n_vac = n - n_boost
    vac = [b for b in bins if b <= ATM_REF_KPA]
    if len(vac) >= n_vac:
        picked = [vac[round(i * (len(vac) - 1) / (n_vac - 1))] for i in range(n_vac)] if n_vac > 1 else [vac[-1]]
    else:
        picked = [vac[0] + (vac[-1] - vac[0]) * i / (n_vac - 1) for i in range(n_vac)]
    last = picked[-1]
    boost = [last + (top - last) * (i + 1) / n_boost for i in range(n_boost)]
    out = [round(b, digits) for b in picked] + [(_even(b) if digits == 0 else round(b, digits)) for b in boost]
    out[-1] = max(out[-1], round(cut_kpa, digits))
    if any(q <= p for p, q in zip(out, out[1:])):
        return None
    return out


def _injector_psi(ans: Answers, a: Assessment, fuel: Fuel) -> float | None:
    """The most boost the injectors can fuel at 80% duty, assuming power rises with pressure ratio."""
    cc = ans.injector_cc or a.injector_cc
    if not (cc and ans.na_hp and a.cylinders):
        return None
    lb_hr = cc * a.cylinders / 10.5
    capacity_hp = lb_hr * INJ_DUTY / (BSFC * fuel.flow)
    return 14.7 * (capacity_hp / ans.na_hp - 1)


def build_plan(doc: TuneDoc, views: list[TableView], tmap: dict | None, ans: Answers,
               errors: list[str] | None = None, a: Assessment | None = None) -> Plan:
    a = a or assess(doc, views, tmap)
    plan = Plan(ans, a, errors=list(errors or []), blockers=list(a.blockers))
    fuel = FUELS[ans.fuel]
    spring = ans.spring_psi
    if not ans.wideband:
        plan.blockers.append("A wideband O2 sensor that the ECU logs is required. Without one there's no way to see "
                             "a lean condition in boost before it does damage.")
    map_kpa = a.map_kpa or ans.map_kpa
    if map_kpa is None:
        plan.blockers.append("The tune doesn't say what the MAP sensor can read. Enter its range (for example 250 "
                             "for a 2.5 bar sensor).")
    elif map_kpa <= 115:
        if a.map_kpa is None:
            plan.blockers.append("A MAP sensor that reads up to about 100 kPa can't read boost. Fit a 2.5 bar or "
                                 "larger sensor first.")
    if spring is None or plan.errors:
        return plan

    # ---- limits
    limits = plan.limits
    cap = fuel.stock_cap if ans.internals == "stock" else fuel.built_cap
    limits.append(Limit("Engine and fuel", cap, f"{'Stock' if ans.internals == 'stock' else 'Built'} internals on "
                                                f"{fuel.label}"))
    if not ans.intercooler:
        limits.append(Limit("No intercooler", min(cap - 2, NO_IC_CAP), "Hot intake air makes knock far more likely"))
    if ans.pump != "upgraded":
        limits.append(Limit("Fuel pump", PUMP_CAP, "A stock or unknown pump and regulator may not hold pressure "
                                                    "in boost"))
    inj = _injector_psi(ans, a, fuel)
    if inj is not None:
        cc = ans.injector_cc or a.injector_cc
        limits.append(Limit("Injectors", max(0.0, inj), f"{_g(cc, 0)} cc/min × {_g(a.cylinders, 0)} cylinders at "
                                                        f"80% duty for about {_g(ans.na_hp, 0)} hp without boost"))
    else:
        missing = [w for w, ok in (("injector size", ans.injector_cc or a.injector_cc), ("engine power", ans.na_hp),
                                   ("cylinder count in the tune", a.cylinders)) if not ok]
        limits.append(Limit("Fuel capacity unverified", UNVERIFIED_FUEL_CAP,
                            f"Enter {' and '.join(missing)} to check the injectors can keep up"))
    if map_kpa and map_kpa > 115:
        usable = map_kpa * SENSOR_USABLE
        plan.usable_kpa = usable
        t = psi_of(usable)
        best = 0.0
        while best + 0.25 + cut_margin(best + 0.25) <= t:
            best += 0.25
        limits.append(Limit("MAP sensor", best, f"Boost cut must stay readable: the sensor reads up to "
                                                f"{_g(map_kpa, 0)} kPa, reliably to about {_g(usable, 0)}"))
    if ans.goal != "stage1":
        base = max(spring, a.current_psi or 0.0)
        limits.append(Limit("Step size", base + STEP_PSI, f"Raise boost at most {STEP_PSI:g} psi at a time from "
                                                          f"{_g(base)} psi, logging each step"))
        if not a.closed_loop:
            limits.append(Limit("Boost control", spring, "More than spring pressure needs closed-loop boost control "
                                                         "(or a stiffer wastegate spring)"))
        if a.cut is None:
            limits.append(Limit("No boost cut", spring, "More than spring pressure needs an ECU boost cut"))
    safe = min(lim.psi for lim in limits)
    plan.safe_psi = safe

    # ---- target
    requested = {"stage1": spring, "stage2": spring + STAGE2_STEP}.get(ans.goal, ans.target_psi)
    if requested is None:
        return plan
    plan.requested_psi = requested
    if ans.goal != "stage1" and not ans.logged:
        plan.blockers.append("Above spring pressure comes after Stage 1 has been logged: boost held at the spring "
                             "without spiking, the wideband matched the targets and there was no knock. Tick the box "
                             "once that's done.")
    if requested < spring:
        plan.notes.append(f"{_g(requested)} psi is below the wastegate spring ({_g(spring)} psi). The ECU can't make "
                          "less than the spring, so the target is the spring pressure.")
        requested = spring
    if spring > safe + 1e-9:
        binding = [lim for lim in limits if lim.psi <= safe + 1e-9]
        for lim in binding:
            lim.binding = True
        plan.blockers.append(f"The wastegate spring alone makes {_g(spring)} psi, more than this setup's limit of "
                             f"{_g(safe)} psi ({', '.join(lim.label.lower() for lim in binding)}). The ECU can't "
                             "hold boost below the spring: fit a softer spring or lift that limit first.")
        return plan
    target = min(requested, safe)
    target = math.floor(target * 4 + 1e-9) / 4  # quarter-psi steps, rounded down
    if target < requested - 1e-9:
        for lim in limits:
            lim.binding = lim.psi <= target + 0.25
        plan.notes.append(f"You asked for {_g(requested)} psi; the most this setup allows is {_g(target)} psi "
                          f"({', '.join(lim.label.lower() for lim in limits if lim.binding)}).")
    plan.target_psi = target
    plan.table_psi = target
    if plan.blockers:
        return plan

    cut = kpa_of(target + cut_margin(target))
    if plan.usable_kpa is not None:
        cut = min(cut, plan.usable_kpa)
    plan.cut_kpa = _even(cut)

    _schedule(plan, doc, ans, a)
    _tables(plan, doc, views, a, fuel)
    if not plan.blockers:
        _controller(plan, doc, a, tmap)
        _checklists(plan, a, fuel)
    if not plan.blockers and not plan.changes:
        plan.blockers.append("This tune already matches the plan, so there's nothing to write.")
    return plan


# ------------------------------------------------------------------ plan parts

def _tables(plan: Plan, doc: TuneDoc, views: list[TableView], a: Assessment, fuel: Fuel) -> None:
    stage1 = plan.answers.goal == "stage1"
    lam_boost = fuel.lam - (STAGE1_RICHER if stage1 else 0.0)
    retard = fuel.retard + (0.0 if plan.answers.intercooler else NO_IC_RETARD)
    cut = plan.cut_kpa
    top = math.ceil((cut + 10) / 10) * 10
    if plan.usable_kpa is not None:
        top = max(cut, min(top, math.floor(plan.usable_kpa / 5) * 5))
    # When the ECU doesn't fold the AFR target into fuelling, VE has to carry the richer mixture: scale it by how
    # much richer the boost target is than the tune's own full-throttle target.
    lam_atm = 0.90
    afr_t = next((t for t in a.tables if t.role == "afr" and t.fuel), None)
    if afr_t is not None:
        row = atm_row(list(afr_t.view.y.values), _rows(afr_t.view.z))
        lam_atm = sum(row) / len(row) / (1.0 if afr_t.fuel == "lambda" else a.stoich)
    ratio = 1.0 if a.incorporate else max(1.0, min(1.2, lam_atm / lam_boost))
    enrich = STAGE1_VE if stage1 else VE_ENRICH
    groups: dict[str, list[MainTable]] = {}
    for t in a.tables:
        groups.setdefault(t.view.y.name, []).append(t)
    plan.checks["tables"] = []
    for bins_name, tables in groups.items():
        y = doc.get(bins_name)
        old_bins = list(y.values)
        if any(q <= p for p, q in zip(old_bins, old_bins[1:])):
            plan.blockers.append(f"{bins_name} isn't in increasing order, so it can't be rescaled.")
            return
        bins = new_load_bins(old_bins, cut, top, _digits(y))
        if bins is None:
            plan.blockers.append(f"{tables[0].view.label} has too few load rows to add boost rows to.")
            return
        others = [v for v in views if v.y is not None and v.y.name == bins_name
                  and v.z.name not in {t.view.z.name for t in tables}]
        crossed = [v for v in views if v.x is not None and v.x.name == bins_name]
        if bins != old_bins and crossed:
            plan.blockers.append(f"{bins_name} is also the column axis of {crossed[0].label}, so it can't be "
                                 "rescaled safely. Rescale it by hand.")
            return
        if bins != old_bins:
            _put(plan, doc, bins_name, bins)
            plan.items.append(Item("Load bins", bins_name, f"{_g(old_bins[0], 0)}–{_g(old_bins[-1], 0)} kPa → "
                                                           f"{_g(bins[0], 0)}–{_g(bins[-1], 0)} kPa, "
                                   f"{sum(1 for b in bins if b > ATM_REF_KPA)} boost rows"))
            for v in others:
                if not _numeric(v.z):
                    plan.blockers.append(f"{v.label} shares {bins_name} but isn't all numbers, so it can't be resampled.")
                    return
                rows = _rows(v.z)
                _put(plan, doc, v.z.name, [x for b in bins for x in _interp(old_bins, rows, b)])
                plan.items.append(Item(v.label, v.z.name, f"resampled onto the new load bins (it shares {bins_name})"))
        for t in tables:
            z = t.view.z
            rows = _rows(z)
            ref = atm_row(old_bins, rows)
            scale = 1.0
            if t.role == "afr":
                if t.fuel is None:
                    plan.notes.append(f"{t.view.label}: couldn't tell if it holds AFR or lambda, so it's left alone.")
                    continue
                scale = 1.0 if t.fuel == "lambda" else a.stoich
            new = []
            for b in bins:
                cur = _interp(old_bins, rows, b)
                real = b <= old_bins[-1] + 1e-6
                if b <= ATM_REF_KPA:
                    new.append(cur)
                    continue
                psi = psi_of(b)
                row = []
                for c, r0 in enumerate(ref):
                    if t.role == "ve":
                        derived = r0 * enrich * ratio
                        v = max(derived, min(cur[c], derived * 1.25)) if real else derived
                    elif t.role == "spark":
                        derived = r0 - retard * psi - (STAGE1_RETARD if stage1 else 0.0)
                        derived = min(derived, fuel.max_adv, r0)
                        v = min(derived, cur[c]) if real else derived
                        v = max(v, min(0.0, r0))
                    else:
                        lam0 = r0 / scale
                        ramp = max(0.0, min(1.0, psi / 3.0))
                        lam = lam0 - (lam0 - lam_boost) * ramp if lam0 > lam_boost else lam0
                        if real:
                            lam = min(lam, cur[c] / scale)
                        v = lam * scale
                    row.append(v)
                new.append(row)
            changed = _put(plan, doc, z.name, [x for row in new for x in row])
            boost_rows = [b for b in bins if b > ATM_REF_KPA]
            what = {"ve": f"boost rows start {round((enrich * ratio - 1) * 100)}% above the full-throttle row and never "
                          "drop below it",
                    "spark": f"{_g(retard)}°/psi out from the full-throttle row"
                             + (f", {STAGE1_RETARD:g}° extra for the first drive" if stage1 else "")
                             + f", never above {fuel.max_adv:g}°",
                    "afr": f"λ {lam_boost:.2f} by 3 psi"
                           + (f" (AFR {lam_boost * scale:.1f})" if t.fuel == "afr" else "") + ", never leaner than now"}[t.role]
            plan.items.append(Item(t.view.label, z.name, f"{changed} cells · {len(boost_rows)} boost rows up to "
                                                        f"{_g(boost_rows[-1], 0) if boost_rows else '?'} kPa · {what}"))
            if t.assumed:
                plan.notes.append(f"{t.view.label}'s load is taken to be MAP (kPa) like the VE table's; the tune doesn't "
                                  "say. Check its algorithm setting in TunerStudio.")
            plan.checks["tables"].append({"role": t.role, "z": z.name, "y": bins_name, "scale": scale,
                                          "lam": lam_boost, "max_adv": fuel.max_adv})
    if a.incorporate is None:
        plan.recommended.append("The tune doesn't say whether the ECU incorporates the AFR target into fuelling, so "
                                "VE in boost carries the extra fuel. If it does incorporate it, expect the first "
                                "logs to read richer than target and lean it toward target in small steps.")
    plan.failsafes.append(f"Fuel in boost only gets richer: targets reach λ {lam_boost:.2f} by 3 psi and VE in boost "
                          "never drops below the full-throttle row.")
    plan.failsafes.append(f"Timing in boost comes out {_g(retard)}° per psi from the full-throttle row"
                          + (f", plus {STAGE1_RETARD:g}° for the first drive" if stage1 else "")
                          + f", and never exceeds {fuel.max_adv:g}°.")


def _schedule(plan: Plan, doc: TuneDoc, ans: Answers, a: Assessment) -> None:
    """Boost by gear or by speed: work out each point's boost, and how (or whether) this tune can hold it."""
    if ans.schedule == "none":
        return
    spring, target = ans.spring_psi, plan.target_psi
    if ans.schedule == "gear":
        filled, last = [], None
        for i, v in enumerate(ans.gear_psi):
            last = v if v is not None else last
            filled.append(last)
        first = next(v for v in filled if v is not None)
        points = [(f"Gear {i + 1}", float(i + 1), v if v is not None else first) for i, v in enumerate(filled)]
    else:
        rows = sorted((s, p) for s, p in ans.speeds if s is not None and p is not None)
        points = [(f"{_g(s, 0)} {'mph' if ans.speed_unit == 'mph' else 'km/h'}", s, p) for s, p in rows]
    out = []
    for label, key, asked in points:
        psi, note = asked, ""
        if psi > target:
            psi, note = target, f"capped at the {_g(target)} psi limit"
        if psi < spring:
            psi, note = spring, "the spring is the least boost there can be"
        out.append({"label": label, "key": key, "asked": asked, "psi": psi, "kpa": kpa_of(psi), "note": note})
    plan.schedule = out
    lowest = min(r["psi"] for r in out)
    highest = max(r["psi"] for r in out)
    plan.checks["schedule_max_kpa"] = kpa_of(highest)
    how = _schedule_mechanism(a, ans.schedule)
    if how is None:
        plan.table_psi = lowest
        want = ("boost by gear (Speeduino: boostByGearEnabled; rusEFI/FOME: a closed-loop boost blend by gear)"
                if ans.schedule == "gear" else "boost by speed (rusEFI/FOME: a closed-loop boost blend by vehicle speed)")
        plan.notes.append(f"This tune has no {ans.schedule} setting that can be written safely, so the whole boost "
                          f"target is your lowest point, {_g(lowest)} psi. That's the fail-safe choice. To get the "
                          f"schedule, turn on {want} in TunerStudio, upload the tune again and rerun this.")
        return
    plan.checks["schedule"] = how
    if how["kind"] == "blend":
        plan.table_psi = lowest
    plan.failsafes.append("If the gear or speed signal is lost, boost falls back to "
                          + (f"the {_g(lowest)} psi base target." if how["kind"] == "blend"
                             else "the main target, which is already within the limit."))


def _schedule_mechanism(a: Assessment, mode: str) -> dict | None:
    if mode == "gear" and a.by_gear and a.by_gear_mode and not _is_off(a.by_gear_mode[1]):
        text, units = a.by_gear_mode[1].lower(), (a.by_gear[0].units or "").lower()
        if "multipl" in text and "%" in units and a.closed_loop:
            return {"kind": "gear_pct"}
        if re.search(r"const|fixed|target|absolute", text) and "add" not in text and "kpa" in units:
            return {"kind": "gear_kpa"}
    for b in a.blends:
        if re.search(r"speed" if mode == "speed" else r"gear", b.axis, re.I) and re.search(r"zero", b.param, re.I):
            return {"kind": "blend", "n": b.n}
    return None


def _controller(plan: Plan, doc: TuneDoc, a: Assessment, tmap: dict | None) -> None:
    ans, stage1 = plan.answers, plan.answers.goal == "stage1"
    spring_kpa = _even(kpa_of(ans.spring_psi))
    table_kpa = _even(kpa_of(plan.table_psi))
    target_kpa = _even(plan.target_kpa)
    plan.checks.update(target_kpa=target_kpa, table_kpa=table_kpa, spring_kpa=spring_kpa, cut_kpa=plan.cut_kpa)

    if a.cut is not None:
        _put(plan, doc, a.cut.name, [plan.cut_kpa])
        plan.items.append(Item("Boost cut", a.cut.name, f"{_g(a.cut.value, 0)} → {_g(plan.cut_kpa, 0)} kPa "
                                                        f"({_g(psi_of(plan.cut_kpa))} psi)"))
        plan.failsafes.append(f"Boost cut at {_g(plan.cut_kpa, 0)} kPa ({_g(psi_of(plan.cut_kpa))} psi), "
                              f"{_g(psi_of(plan.cut_kpa) - plan.target_psi)} psi above the target and inside what the "
                              "MAP sensor can read.")
    else:
        plan.required.append(f"This tune has no boost cut setting this tool recognises. If your firmware has one "
                             f"(overboost protection), set it to {_g(plan.cut_kpa, 0)} kPa before driving.")

    for c in a.duties:
        _put(plan, doc, c.name, [0.0] * len(c.values))
        plan.items.append(Item("Open-loop boost duty", c.name, "0% everywhere"))
    if a.duties:
        plan.failsafes.append("Open-loop boost duty is 0% everywhere, so the solenoid adds nothing on its own"
                              + (": boost is the wastegate spring." if stage1 else "; closed loop has to earn every psi."))
    for c in a.duty_adders + a.open_blends:
        _put(plan, doc, c.name, [0.0] * len(c.values))
        plan.items.append(Item("Hidden duty adders", c.name, "0 everywhere, so nothing adds duty behind the table's back"))

    how = plan.checks.get("schedule") or {}
    for c in a.targets:
        tps = a.tps_rows.get(c.name)
        vals = []
        for r in range(c.rows):
            low = stage1 or (tps is not None and tps[r] < LOW_TPS)
            vals += [spring_kpa if low else table_kpa] * c.cols
        _put(plan, doc, c.name, vals)
        plan.items.append(Item("Boost target", c.name, f"{_g(spring_kpa, 0)} kPa (spring)" if stage1 else
                               f"{_g(table_kpa, 0)} kPa ({_g(psi_of(table_kpa))} psi) from {LOW_TPS:g}% throttle, "
                               f"spring pressure below"))
    for b in a.blends:
        if how.get("kind") == "blend" and how.get("n") == b.n:
            continue
        _put(plan, doc, b.table.name, [0.0] * len(b.table.values))
        plan.items.append(Item("Hidden target adders", b.table.name, "0 everywhere"))

    if a.max_duty is not None:
        new = 0.0 if stage1 else min(a.max_duty.value, MAX_DUTY_ABOVE_SPRING)
        _put(plan, doc, a.max_duty.name, [new])
        plan.checks["max_duty"] = new
        plan.items.append(Item("Max boost duty", a.max_duty.name, f"{_g(a.max_duty.value, 0)} → {_g(new, 0)}%"))
        plan.failsafes.append("Max boost duty is 0%: the solenoid can't raise boost above the spring." if stage1 else
                              f"Max boost duty is capped at {_g(new, 0)}%. If logs show boost short of target, raise "
                              "it in small steps.")
    if a.safe_duty is not None:
        _put(plan, doc, a.safe_duty.name, [0.0])
        plan.items.append(Item("Sensor-failure duty", a.safe_duty.name, "0%: a failed sensor falls back to spring pressure"))
        plan.failsafes.append("If a sensor fails, boost duty drops to 0% (spring pressure).")

    # boost by gear / speed
    if how.get("kind") in ("gear_pct", "gear_kpa"):
        by_psi = [r["psi"] for r in plan.schedule]
        for i, c in enumerate(a.by_gear):
            psi = by_psi[min(i, len(by_psi) - 1)]
            if how["kind"] == "gear_pct":
                v = math.floor(min(100.0, kpa_of(psi) / table_kpa * 100))
            else:
                v = min(_even(kpa_of(psi)), target_kpa)
            _put(plan, doc, c.name, [v])
        plan.items.append(Item("Boost by gear", ", ".join(c.name for c in a.by_gear[:2]) + ("…" if len(a.by_gear) > 2 else ""),
                               "percent of the target per gear" if how["kind"] == "gear_pct" else "kPa target per gear"))
    elif how.get("kind") == "blend":
        b = next(x for x in a.blends if x.n == how["n"])
        n = len(b.load_bins.values)
        pts = plan.schedule
        if len(pts) > n:
            plan.blockers.append(f"{b.load_bins.name} has room for {n} points; enter at most {n}.")
            return
        keys = [p["key"] * (1.609344 if plan.answers.schedule == "speed" and plan.answers.speed_unit == "mph" else 1.0)
                for p in pts]
        keys = [round(k, _digits(b.load_bins)) for k in keys]
        while len(keys) < n:
            keys.append(keys[-1] + 10)
        psis = [p["psi"] for p in pts] + [pts[-1]["psi"]] * (n - len(pts))
        if any(q <= p for p, q in zip(keys, keys[1:])):
            plan.blockers.append("Speed points need to be at least 1 apart.")
            return
        _put(plan, doc, b.load_bins.name, keys)
        adders = [max(0.0, min(_even(kpa_of(p)), target_kpa) - table_kpa) for p in psis]
        _put(plan, doc, b.table.name, [adders[r] for r in range(b.table.rows) for _ in range(b.table.cols)])
        if b.values is not None and _numeric(b.values):
            _put(plan, doc, b.values.name, [100.0] * len(b.values.values))
        plan.checks["blend"] = b.table.name
        plan.items.append(Item("Boost by " + plan.answers.schedule, b.table.name,
                               f"base target {_g(table_kpa, 0)} kPa plus 0–{_g(max(adders), 0)} kPa by “{b.axis}”"))

    # TunerStudio MAP gauge zones, so the dash shows trouble
    for name, v in (("mapwarn", _even(kpa_of(plan.target_psi + 1.5))), ("mapdang", plan.cut_kpa)):
        c = doc.get(name)
        if c is not None and c.kind == "scalar" and isinstance(c.value, float):
            _put(plan, doc, name, [v])
    top = doc.get("maphigh")
    if top is not None and top.kind == "scalar" and isinstance(top.value, float) and top.value < plan.cut_kpa + 20:
        _put(plan, doc, "maphigh", [math.ceil((plan.cut_kpa + 20) / 50) * 50])
    if any(n in plan.changes for n in ("mapwarn", "mapdang", "maphigh")):
        plan.items.append(Item("MAP gauge", "mapwarn / mapdang", "warning zone just above the target, danger zone at the cut"))


def _checklists(plan: Plan, a: Assessment, fuel: Fuel) -> None:
    ans, stage1 = plan.answers, plan.answers.goal == "stage1"
    req, rec = plan.required, plan.recommended
    for name, value in a.cut_options:
        if _is_off(value):
            what = ("so the boost cut actually cuts (Spark Only or Both)" if name == "engineProtectType"
                    else "without it the boost cut value does nothing")
            req.append(f"Turn on {name} (it's “{value}”): {what}.")
    if a.boost_enabled and _is_off(a.boost_enabled[1]):
        if stage1:
            rec.append(f"Boost control is off ({a.boost_enabled[0]} = “{a.boost_enabled[1]}”), so boost is the wastegate "
                       "spring, which is what Stage 1 wants.")
        else:
            req.append(f"Turn on boost control ({a.boost_enabled[0]} = “{a.boost_enabled[1]}”), or the targets do "
                       "nothing and boost stays at the spring.")
    if ans.schedule != "none" and plan.checks.get("schedule") is None:
        req.append("Boost by " + ans.schedule + " isn't set in this tune yet: the target is your lowest point until it is.")
    if ans.schedule == "speed" and plan.checks.get("schedule"):
        req.append("Check the speed the ECU logs matches the speedometer before relying on boost by speed.")
    if ans.schedule == "gear" and plan.checks.get("schedule"):
        req.append("Check the gear the ECU detects matches the gear you're in, in every gear, before relying on boost "
                   "by gear.")
    if a.lambda_protect and _is_off(a.lambda_protect[1]):
        rec.append("Turn on lambda protection (lambdaProtectionEnable): it cuts power if the mixture goes lean under "
                   "load.")
    req.append("With the key on and the engine off, check the MAP reading is about 100 kPa (at sea level). Every "
               "target and the cut assume the sensor is calibrated.")
    req.append("Check the boost cut works before the first pull: temporarily lower it just below idle MAP in "
               "TunerStudio and confirm it cuts, then put it back.")
    rec.append("Check base timing with a timing light matches what the ECU reports.")
    rec.append("Pressure-test the intake for boost leaks, and check the wastegate actuator line is connected.")
    if not ans.intercooler:
        rec.append("Watch intake air temperature closely; without an intercooler it climbs fast in repeated pulls.")
    if ans.fuel in ("e30", "e85"):
        rec.append("Confirm the actual ethanol content with a flex sensor or tester; pump E85 varies season to season.")
    t = plan.target_psi
    plan.logging = [
        "Warm the engine fully. Drive off boost first and confirm idle, cruise and light throttle are unchanged.",
        "Log RPM, MAP, boost target, wideband AFR/λ, AFR target, ignition advance, boost duty, intake air temp and "
        "knock (if fitted).",
        "Start with a part-throttle pull in 3rd gear from about 2500 rpm to 4500 rpm. Lift at once if the wideband "
        "goes leaner than target or you hear knock.",
        f"Check the log: peak boost should be within about 1 psi of {_g(t)} psi. More than 2 psi over means a "
        "wastegate or actuator problem, so stop and fix it before any more pulls.",
        f"In boost the wideband should read λ {fuel.lam - (STAGE1_RICHER if stage1 else 0):.2f} or richer. Leaner than "
        "λ 0.86 in boost: stop and add fuel before continuing.",
        "Only then do a full-throttle pull in 3rd gear to the rev limit, and check the same things again.",
        "When the logs are clean, come back with the saved tune and choose the next step (at most "
        f"{STEP_PSI:g} psi more).",
    ]


# ------------------------------------------------------------------ writing and verifying

def verify(orig: TuneDoc, new: TuneDoc, tmap: dict, plan: Plan) -> None:
    """Re-read the written tune and refuse it unless every safety rule holds. Raises BoostError."""
    def fail(msg: str):
        raise BoostError(f"The boost tune was refused by its own safety check: {msg}")

    for spec in plan.checks.get("tables", []):
        z, y = new.get(spec["z"]), new.get(spec["y"])
        bins, rows = list(y.values), _rows(z)
        if any(q <= p for p, q in zip(bins, bins[1:])):
            fail(f"{spec['y']} isn't in increasing order.")
        if bins[-1] < min(plan.cut_kpa, plan.usable_kpa or plan.cut_kpa) - 1:
            fail(f"{spec['z']} load bins stop below the boost cut.")
        ref = atm_row(bins, rows)
        tol = 1.01 * 10 ** -_digits(z)
        for b, row in zip(bins, rows):
            if b <= ATM_REF_KPA:
                continue
            for c, v in enumerate(row):
                if spec["role"] == "ve" and v < ref[c] - tol:
                    fail(f"VE at {b:g} kPa ({v:g}) is below the full-throttle row ({ref[c]:g}).")
                if spec["role"] == "spark" and (v > ref[c] + tol or v > spec["max_adv"] + tol):
                    fail(f"advance at {b:g} kPa ({v:g}°) is more than the full-throttle row or {spec['max_adv']:g}°.")
                if spec["role"] == "afr":
                    lam, lam0, t = v / spec["scale"], ref[c] / spec["scale"], tol / spec["scale"]
                    if lam > lam0 + t or (psi_of(b) >= 3 and lam > max(spec["lam"], 0) + t and lam0 > spec["lam"]):
                        fail(f"the target at {b:g} kPa (λ {lam:.2f}) is leaner than planned.")
    chk = plan.checks
    if plan.assessment.cut is not None:
        v = new.get(plan.assessment.cut.name).value
        if not (chk["target_kpa"] + 6 <= v <= (plan.usable_kpa or 1e9) + 1):
            fail(f"boost cut {v:g} kPa isn't between the target plus a margin and the MAP sensor's range.")
    ceiling = max(chk.get("target_kpa", 0), chk.get("spring_kpa", 0)) + 1
    for c in plan.assessment.targets:
        if max(new.get(c.name).values) > ceiling:
            fail(f"{c.name} asks for more than the {chk['target_kpa']:g} kPa limit.")
    if chk.get("blend"):
        adders = new.get(chk["blend"]).values
        if max(adders) + chk["table_kpa"] > ceiling or min(adders) < 0:
            fail("boost by gear/speed would go past the limit or below the base target.")
    for c in plan.assessment.duties + plan.assessment.duty_adders + plan.assessment.open_blends:
        if any(v != 0 for v in new.get(c.name).values):
            fail(f"{c.name} isn't 0.")
    if "max_duty" in chk and new.get(plan.assessment.max_duty.name).value > chk["max_duty"] + 0.5:
        fail("max boost duty is above the plan.")
    kind = (chk.get("schedule") or {}).get("kind")
    for c in plan.assessment.by_gear if kind in ("gear_pct", "gear_kpa") else []:
        v = new.get(c.name).value
        if (kind == "gear_pct" and v > 100) or (kind == "gear_kpa" and v > chk["target_kpa"] + 1):
            fail(f"{c.name} is past the limit.")
    rev = plan.assessment.rev
    if rev and new.get(rev[0]).value != orig.get(rev[0]).value:
        fail("the rev limit changed.")
    featured, other = all_tables(new, tmap)
    errors = [r["text"] for r in checksmod.run(new, featured + other) if r["status"] == "error"]
    if errors:
        fail("Tune Health found a problem to fix: " + errors[0])


def create(raw: bytes, doc: TuneDoc, tmap: dict, plan: Plan) -> tuple[bytes, int]:
    """Write the plan into a copy of the .msq and verify it. -> (new bytes, values rewritten). Raises BoostError."""
    if not plan.ok:
        raise BoostError("This plan can't be written: " + ((plan.errors + plan.blockers) or ["nothing to change"])[0])
    try:
        new_raw, n = apply_changes(raw, plan.changes)
        new_doc = parse_msq(new_raw)
    except (EditError, MsqError) as e:
        raise BoostError(str(e)) from None
    verify(doc, new_doc, tmap, plan)
    return new_raw, n
