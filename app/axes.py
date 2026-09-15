"""Axis names and units for tables and curves, and what a table's load axis measures.

What a .msq and its tablemap say about an axis is uneven: a label may be generic ("Load"), blank, or really
a unit ("%"), and the bins' units may be missing or not a unit at all ("Load", "TPS", "L"). This turns
whatever is there into a readable name plus units ("Load" + "kPa"). Where the tune records it, it also says
what load *is*, from the fuel or ignition algorithm setting ("MAP, because algorithm = Speed Density").
Nothing here converts values.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .parser import Constant, TuneDoc

# Words found in a label, units slot or bins name -> (axis name, units that word implies).
_WORDS: dict[str, tuple[str, str]] = {
    "rpm": ("RPM", ""), "load": ("Load", ""), "l": ("Load", ""),
    "tps": ("TPS", "%"), "throttle": ("TPS", "%"), "pedal": ("Pedal", "%"), "pps": ("Pedal", "%"),
    "map": ("MAP", "kPa"), "baro": ("Baro", "kPa"),
    "clt": ("Coolant", ""), "coolant": ("Coolant", ""), "iat": ("Intake air", ""), "mat": ("Intake air", ""),
    "batt": ("Battery", "V"), "vbatt": ("Battery", "V"), "voltage": ("Battery", "V"),
    "vss": ("Speed", ""), "speed": ("Speed", ""), "gear": ("Gear", ""),
}
# Labels that name nothing.
_JUNK = {"", "x", "y", "z", "value", "values", "bins", "bin", "axis"}
# Strings that are units, so a label holding one is moved to the units.
_UNIT_LIKE = {"%", "percent", "kpa", "psi", "bar", "deg", "degrees", "ms", "s", "v", "c", "degc", "deg c", "°c",
              "f", "degf", "deg f", "°f", "g/s", "kg/h", "mg", "cc/lobe", "lambda", "afr", "hz"}
_UNIT_SPELLING = {"percent": "%", "kpa": "kPa", "c": "°C", "degc": "°C", "deg c": "°C",
                  "f": "°F", "degf": "°F", "deg f": "°F"}
# Parts of a bins name that don't say what the axis is.
_FILLER = {"bins", "bin", "axis", "table", "tbl", "values", "x", "y", "to", "from"}


def _tokens(name: str) -> list[str]:
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name or "")
    return [w for w in re.split(r"[^a-z]+", spaced.lower()) if w and w not in _FILLER]


def _from_name(name: str) -> tuple[str, str] | None:
    """The last meaningful word wins: 'pedalToTpsPedalBins' is a Pedal axis, 'fuelTrimLoadBins' a Load axis."""
    for w in reversed(_tokens(name)):
        if w in _WORDS:
            return _WORDS[w]
        for key, found in _WORDS.items():
            if len(key) >= 3 and w.endswith(key):
                return found
    return None


def axis_info(label: str, bins: Constant | None, units: str = "") -> tuple[str, str]:
    """-> (name, units) for an axis, from its tablemap label, its bins constant and the bins' units."""
    label = (label or "").strip().rstrip(":").strip()
    units = (units or "").strip()
    if units.lower() in _WORDS:  # a name in the units slot: "Load", "TPS", "L"
        name, implied = _WORDS[units.lower()]
        if label.lower() in _JUNK or label.lower() == units.lower() or len(label) == 1:
            label = name
        units = implied
    if label.lower() in _UNIT_LIKE:  # a unit in the label slot: "%", "kPa"
        units = units or label
        label = ""
    if label.lower() in _WORDS:
        label, implied = _WORDS[label.lower()][0], _WORDS[label.lower()][1]
        units = units or implied
    elif label.lower() in _JUNK or len(label) == 1:
        label = ""
    if not label and bins is not None:
        guess = _from_name(bins.name)
        if guess:
            label, units = guess[0], units or guess[1]
    units = _UNIT_SPELLING.get(units.lower(), units)
    if units.lower() == label.lower():
        units = ""
    return label, units


def axis_text(label: str, units: str, fallback: str = "") -> str:
    """'Load (kPa)', 'RPM', 'kPa', or the fallback."""
    if label and units:
        return f"{label} ({units})"
    return label or units or fallback


# ------------------------------------------------------------------ load source

# Option text of a fuel/ignition algorithm setting -> what the load axis measures, and its usual units.
_SOURCES: list[tuple[str, str, str]] = [
    (r"baro", "MAP ÷ baro", "%"),
    (r"imap|emap", "IMAP/EMAP", ""),
    (r"speed.?density|^map\b|^sd$", "MAP", "kPa"),
    (r"alpha|^tps\b|throttle", "TPS", "%"),
    (r"\bmaf\b|air.?charge|air.?mass", "MAF", ""),
    (r"\bitb\b", "ITB (TPS/MAP blend)", ""),
    (r"\blua\b", "Lua script", ""),
]
# Which settings choose the load for a featured table, when the tablemap doesn't say ("load_from").
# Only tables whose load is known to follow these settings are listed; a setting a tune doesn't have is skipped.
DEFAULT_LOAD_FROM: dict[str, tuple[str, ...]] = {
    "ve": ("algorithm", "algorithm1", "fuelAlgorithm"),
    "ve2": ("algorithm2",),
    "spark": ("IgnAlgorithm", "ignAlgorithm", "ignAlgorithm1"),
}


@dataclass
class LoadSource:
    setting: str  # constant name, e.g. "algorithm"
    choice: str   # its option text in the tune, e.g. "Speed Density"
    measure: str  # what load is, e.g. "MAP"; the option text itself when it isn't recognised
    units: str = ""
    # Not `measure != choice`: newer Speeduino firmware stores the option as just "MAP" or "TPS".
    recognised: bool = True

    @property
    def known(self) -> bool:
        return self.recognised

    @property
    def text(self) -> str:
        what = axis_text(self.measure, self.units) if self.known else "set by"
        return f"Load is {what} · {self.setting} = “{self.choice}”" if self.known else \
            f"Load {what} {self.setting} = “{self.choice}”"


def load_source(doc: TuneDoc, load_from, table_id: str) -> LoadSource | None:
    names = load_from if load_from else DEFAULT_LOAD_FROM.get(table_id, ())
    for name in ([names] if isinstance(names, str) else names):
        c = doc.get(name) if isinstance(name, str) else None
        if c is None or c.kind != "string" or not str(c.value or "").strip():
            continue
        choice = str(c.value).strip()
        for pattern, measure, units in _SOURCES:
            if re.search(pattern, choice, re.I):
                return LoadSource(name, choice, measure, units)
        return LoadSource(name, choice, choice, recognised=False)
    return None


# ------------------------------------------------------------------ axis guessing

def guess_axes(doc: TuneDoc, z: Constant) -> tuple[Constant | None, Constant | None]:
    """Axis bins for a table no tablemap describes, matched by name: 'sparkMap' + 'sparkMapRpmBins'.

    Deliberately strict: the bins must start with the table's stem, be numeric, have the right length and
    say which axis they are (rpm / x for columns; load, map, tps, kpa / y for rows).
    """
    stem = re.sub(r"(?i)(table|tbl|map)?\d*$", "", z.name).rstrip("_")
    if len(stem) < 3:
        return None, None
    x = y = None
    for c in doc.constants.values():
        if (c is z or not c.is_array or not c.name.lower().startswith(stem.lower())
                or not all(isinstance(v, float) for v in c.values)):
            continue
        rest = c.name[len(stem):].lower()
        if x is None and len(c.values) == z.cols and re.search(r"rpm|(^|_)x|xbins|xaxis", rest):
            x = c
        elif y is None and len(c.values) == z.rows and re.search(r"load|map|tps|kpa|(^|_)y|ybins|yaxis", rest):
            y = c
    return x, y
