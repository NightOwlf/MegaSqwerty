"""Turn constants into heatmap view-models the templates can render."""
from __future__ import annotations

from dataclasses import dataclass, field

from .axes import (BOOST_EDGE_KPA, axis_info, axis_text, gauge_text, is_pressure_axis, placeholder_parts,
                   setup_text)
from .edit import edit_digits
from .parser import Constant, fmt_value

# TunerStudio-style table coloring: a light blue→cyan→green→yellow→red ramp that keeps
# black cell text readable everywhere. AFR runs the other way so rich reads red.
TS_RAMP = ["#7b9bff", "#6fd6e6", "#86e07a", "#f0e25a", "#f7a54a", "#f0604c"]

# name -> (color stops low..high, low label, high label)
PALETTES: dict[str, tuple[list[str], str, str]] = {
    "ve": (TS_RAMP, "low", "high"),
    "spark": (TS_RAMP, "retard", "advance"),
    "afr": (TS_RAMP[::-1], "rich", "lean"),
    "default": (TS_RAMP, "low", "high"),
    "diff": (["#3d7bf0", "#8a9099", "#f0583a"], "lower", "higher"),
}


def _hex(c: str) -> tuple[int, int, int]:
    return int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)


def palette(name: str) -> tuple[list[str], str, str]:
    return PALETTES.get(name, PALETTES["default"])


def color_at(t: float, name: str) -> tuple[str, str]:
    """Background + readable foreground for t in [0, 1]."""
    stops = [_hex(s) for s in palette(name)[0]]
    t = 0.0 if t != t else max(0.0, min(1.0, t))
    pos = t * (len(stops) - 1)
    i = min(int(pos), len(stops) - 2)
    f = pos - i
    r, g, b = (round(a + (bb - a) * f) for a, bb in zip(stops[i], stops[i + 1]))
    return f"#{r:02x}{g:02x}{b:02x}", ink_for(r, g, b)


def ink_for(r: int, g: int, b: int) -> str:
    lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    return "#000" if lum > 0.42 else "#fff"


def mix(c1: str, c2: str, t: float) -> tuple[int, int, int]:
    a, b = _hex(c1), _hex(c2)
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient_css(name: str) -> str:
    return "linear-gradient(90deg," + ",".join(palette(name)[0]) + ")"


def fuel_mode(z: Constant, units: str, palette_name: str) -> str | None:
    """'lambda' / 'afr' for target-mixture tables, else None. Never converts."""
    u = (units or "").lower()
    if "lambda" in u or "λ" in u:
        return "lambda"
    if "afr" in u:
        return "afr"
    if palette_name != "afr":
        return None
    nums = [v for v in z.values if isinstance(v, float)]
    if nums and 0.6 <= min(nums) and max(nums) <= 1.3:
        return "lambda"
    if nums and 6.0 <= min(nums) and max(nums) <= 25.0:
        return "afr"
    return None


@dataclass
class Cell:
    text: str
    r: int
    c: int
    style: str = ""
    cls: str = ""
    delta: str = ""
    a_text: str = ""


@dataclass
class Row:
    label: str
    index: int
    cells: list[Cell]
    gauge: str = ""  # what a boost gauge reads for this load bin, on a MAP axis
    boost_edge: bool = False  # the lowest row in boost; the line is drawn under it


@dataclass
class Grid:
    id: str
    title: str
    units: str
    palette: str
    name: str = ""
    x_label: str = ""
    y_label: str = ""
    x_labels: list[str] = field(default_factory=list)
    rows: list[Row] = field(default_factory=list)
    lo: str = ""
    hi: str = ""
    note: str = ""
    is_diff: bool = False
    fuel: str | None = None
    url: str = ""
    # editing: every cell is a number, how many decimals to write, and the color scale's range
    editable: bool = False
    edit_digits: int = 0
    lo_v: float = 0.0
    hi_v: float = 0.0
    # axes: units shown next to the names, what load measures (axes.LoadSource), how the bins were found
    x_units: str = ""
    y_units: str = ""
    load: object = None
    axes_note: str = ""
    pressure_note: str = ""
    setup_note: str = ""  # the table still holds never-configured placeholder values

    @property
    def boost_line(self) -> bool:
        return any(r.boost_edge for r in self.rows)

    @property
    def x_text(self) -> str:
        return axis_text(self.x_label, self.x_units, "Column")

    @property
    def y_text(self) -> str:
        return axis_text(self.y_label, self.y_units, "Row")

    @property
    def stops(self) -> str:
        return ",".join(palette(self.palette)[0])

    @property
    def gradient(self) -> str:
        return gradient_css(self.palette)

    @property
    def legend(self) -> tuple[str, str]:
        _, lo, hi = palette(self.palette)
        return lo, hi

    @property
    def dims(self) -> str:
        return f"{len(self.rows)}×{len(self.x_labels)}"


def _decimals_needed(v: float, cap: int = 3) -> int:
    for d in range(cap + 1):
        if abs(round(v, d) - v) <= 1e-6 * max(1.0, abs(v)):
            return d
    return cap


def axis_labels(bins: list | None, n: int, digits: int | None = None) -> list[str]:
    """Format axis bins with one sensible precision for the whole axis.

    MegaSquirt bins are usually integers ("2500"); rusEFI stores floats that
    may carry F32 noise ("0.30000001"). Use the fewest decimals (<= 3) that
    represent every bin. The file's `digits` hint is ignored on purpose: it
    would either pad integer bins with zeros or hide real fractions (12.5).
    """
    if bins is None or len(bins) != n:
        return [str(i) for i in range(n)]
    nums = [v for v in bins if isinstance(v, float)]
    dec = max((_decimals_needed(v) for v in nums), default=0)
    out = []
    for v in bins:
        if isinstance(v, float):
            s = f"{v:.{dec}f}"
            out.append("0" if s.strip("-0.") == "" else s)
        else:
            out.append(str(v))
    return out


def build_grid(gid: str, title: str, z: Constant, x: Constant | None = None, y: Constant | None = None,
               palette_name: str = "default", units: str | None = None,
               x_label: str = "", y_label: str = "", digits: int | None = None,
               x_units: str = "", y_units: str = "", load=None, pressure_note: bool = True) -> Grid:
    digits = z.digits if digits is None else digits
    if not (x_label or x_units) and x is not None:
        x_label, x_units = axis_info("", x, x.units or "")
    if not (y_label or y_units) and y is not None:
        y_label, y_units = axis_info("", y, y.units or "")
    nums = [v for v in z.values if isinstance(v, float)]
    lo, hi = (min(nums), max(nums)) if nums else (0.0, 0.0)
    span = hi - lo
    x_bins = x.values if x is not None and len(x.values) == z.cols else None
    y_bins = y.values if y is not None and len(y.values) == z.rows else None
    u = units if units is not None else (z.units or "")
    grid = Grid(
        id=gid, title=title, units=u, palette=palette_name, name=z.name,
        x_label=x_label, y_label=y_label, x_units=x_units, y_units=y_units, load=load,
        x_labels=axis_labels(x_bins, z.cols, x.digits if x is not None else None),
        lo=fmt_value(lo, digits) if nums else "", hi=fmt_value(hi, digits) if nums else "",
        fuel=fuel_mode(z, u, palette_name),
    )
    grid.editable = z.is_table and len(nums) == len(z.values)
    grid.edit_digits, grid.lo_v, grid.hi_v = edit_digits(z), lo, hi
    if (x is not None and x_bins is None) or (y is not None and y_bins is None):
        grid.note = "Axis bins don't match the table size; showing cell indexes."
    y_labels = axis_labels(y_bins, z.rows, y.digits if y is not None else None)
    # Row 0 is the lowest load bin; draw it at the bottom like TunerStudio.
    for r in reversed(range(z.rows)):
        cells = []
        for c, v in enumerate(z.row(r)):
            if isinstance(v, float):
                bg, fg = color_at((v - lo) / span if span else 0.5, palette_name)
                cells.append(Cell(fmt_value(v, digits), r, c, f"background:{bg};color:{fg}"))
            else:
                cells.append(Cell(str(v), r, c, cls="nan"))
        grid.rows.append(Row(y_labels[r], r, cells))
    grid.setup_note = setup_text(placeholder_parts(z, x, y, grid.x_label or "column", grid.y_label or "row"))
    apply_pressure(grid, y_bins, note=pressure_note and not grid.setup_note)
    return grid


def apply_pressure(grid: Grid, y_bins, note: bool = True) -> None:
    """On a MAP (absolute kPa) load axis: each row's boost/vacuum reading, where boost starts, and a note.

    The note is for main tables (VE, ignition, AFR), where "no boost rows" is worth saying.
    """
    if not y_bins or not is_pressure_axis(grid.y_label, grid.y_units, grid.load):
        return
    nums = [v for v in y_bins if isinstance(v, float)]
    if not nums:
        return
    for row in grid.rows:
        if isinstance(y_bins[row.index], float):
            row.gauge = gauge_text(y_bins[row.index])
    top = max(nums)
    boost = [r for r in grid.rows if isinstance(y_bins[r.index], float) and y_bins[r.index] > BOOST_EDGE_KPA]
    if not boost:
        if note:
            grid.pressure_note = (f"No boost rows: the top load bin is {top:g} kPa, about atmospheric. That's normal for a "
                                  "naturally aspirated engine; a turbo or supercharged engine needs load bins above "
                                  "~101 kPa.")
        return
    ascending = len(nums) == len(y_bins) and all(a < b for a, b in zip(nums, nums[1:]))
    if ascending and len(boost) < len(grid.rows):
        min(boost, key=lambda r: y_bins[r.index]).boost_edge = True
        where = "Rows above the orange line are boost."
    else:
        where = f"{len(boost)} of {len(grid.rows)} rows are boost."
    if note:
        grid.pressure_note = f"{where} The top load bin, {top:g} kPa, is about {gauge_text(top)} at sea level."

