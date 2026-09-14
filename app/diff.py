"""Compare two tunes: cell-by-cell for tables, value-by-value for settings."""
from __future__ import annotations

from dataclasses import dataclass, field

from .parser import Constant, TuneDoc, fmt_value, values_equal
from .render import Cell, Grid, Row, axis_labels
from .tablemaps import TableView, all_tables


@dataclass
class TableDiff:
    id: str
    label: str
    name: str
    status: str  # same | changed | dims | only_a | only_b | kind
    message: str = ""
    changed: int = 0
    total: int = 0
    axis_notes: list[str] = field(default_factory=list)
    featured: bool = False
    va: TableView | None = field(default=None, repr=False)
    vb: TableView | None = field(default=None, repr=False)
    zb: Constant | None = field(default=None, repr=False)


@dataclass
class SettingDiff:
    name: str
    status: str  # changed | only_a | only_b
    a: str = ""
    b: str = ""
    units: str = ""
    detail: list[str] = field(default_factory=list)


def _dims(c: Constant) -> str:
    return f"{c.rows}×{c.cols}"


def compare_tables(za: Constant | None, zb: Constant | None) -> tuple[str, str, int, int]:
    """-> (status, message, changed_cells, total_cells). Never raises."""
    if za is None and zb is None:
        return "same", "", 0, 0
    if za is None:
        return "only_b", "Only in tune B.", 0, 0
    if zb is None:
        return "only_a", "Only in tune A.", 0, 0
    if za.kind != zb.kind:
        return "kind", "One tune stores this as a table and the other doesn't, so cells can't be compared.", 0, 0
    if (za.rows, za.cols) != (zb.rows, zb.cols) or len(za.values) != len(zb.values):
        return ("dims", f"Table dimensions differ ({_dims(za)} vs {_dims(zb)}), so it can't be compared cell by cell.",
                0, 0)
    digits = za.digits if za.digits is not None else zb.digits
    changed = sum(1 for a, b in zip(za.values, zb.values) if not values_equal(a, b, digits))
    return ("changed" if changed else "same"), "", changed, len(za.values)


def _axis_note(label: str, a: Constant | None, b: Constant | None) -> str | None:
    if a is None or b is None:
        return None
    if len(a.values) != len(b.values):
        return f"{label} axis has {len(a.values)} vs {len(b.values)} bins."
    digits = a.digits if a.digits is not None else b.digits
    if any(not values_equal(x, y, digits) for x, y in zip(a.values, b.values)):
        return f"{label} axis bins differ between the tunes; showing tune B's bins."
    return None


def diff_grid(gid: str, title: str, za: Constant, zb: Constant, x: Constant | None, y: Constant | None,
              units: str = "", x_label: str = "", y_label: str = "") -> Grid:
    """Assumes compare_tables(...) returned changed/same (matching dims)."""
    digits = za.digits if za.digits is not None else zb.digits
    deltas = [b - a for a, b in zip(za.values, zb.values) if isinstance(a, float) and isinstance(b, float)]
    max_abs = max((abs(d) for d in deltas), default=0.0)
    x_bins = x.values if x is not None and len(x.values) == zb.cols else None
    y_bins = y.values if y is not None and len(y.values) == zb.rows else None
    grid = Grid(id=gid, title=title, units=units or zb.units or "", palette="diff", name=zb.name, is_diff=True,
                x_label=x_label, y_label=y_label,
                x_labels=axis_labels(x_bins, zb.cols, x.digits if x is not None else None))
    y_labels = axis_labels(y_bins, zb.rows, y.digits if y is not None else None)
    for r in reversed(range(zb.rows)):
        cells = []
        for c, (a, b) in enumerate(zip(za.row(r), zb.row(r))):
            b_text, a_text = fmt_value(b, digits), fmt_value(a, digits)
            if values_equal(a, b, digits):
                cells.append(Cell(b_text, r, c, cls="same", a_text=a_text))
            elif isinstance(a, float) and isinstance(b, float):
                d = b - a
                mag = abs(d) / max_abs if max_abs else 1.0
                alpha = 0.35 + 0.65 * mag
                rgb = "255,86,48" if d > 0 else "56,142,255"
                sign = "+" if d > 0 else "−"
                cells.append(Cell(b_text, r, c, style=f"background:rgba({rgb},{alpha:.2f});color:#fff",
                                  cls="up" if d > 0 else "down", delta=f"{sign}{fmt_value(abs(d), digits)}",
                                  a_text=a_text))
            else:
                cells.append(Cell(b_text, r, c, style="background:#7a5cff;color:#fff", cls="up",
                                  delta="≠", a_text=a_text))
        grid.rows.append(Row(y_labels[r], r, cells))
    grid.lo = f"−{fmt_value(max_abs, digits)}" if max_abs else "0"
    grid.hi = f"+{fmt_value(max_abs, digits)}" if max_abs else "0"
    return grid


def grid_for(td: TableDiff) -> Grid | None:
    if td.status not in ("changed", "same") or td.va is None or td.zb is None:
        return None
    v = td.vb or td.va
    return diff_grid(td.id, td.label, td.va.z, td.zb, v.x, v.y, units=v.units, x_label=v.x_label,
                     y_label=v.y_label)


def _setting_text(c: Constant) -> str:
    if c.kind in ("scalar", "string"):
        return fmt_value(c.value, c.digits)
    return f"{len(c.values)} values"


def diff_settings(a: TuneDoc, b: TuneDoc) -> list[SettingDiff]:
    out: list[SettingDiff] = []
    names = list(a.constants) + [n for n in b.constants if n not in a.constants]
    for name in names:
        ca, cb = a.get(name), b.get(name)
        if (ca is not None and ca.is_table) or (cb is not None and cb.is_table):
            continue
        if ca is None:
            out.append(SettingDiff(name, "only_b", "—", _setting_text(cb), cb.units or ""))
            continue
        if cb is None:
            out.append(SettingDiff(name, "only_a", _setting_text(ca), "—", ca.units or ""))
            continue
        digits = ca.digits if ca.digits is not None else cb.digits
        if len(ca.values) != len(cb.values):
            out.append(SettingDiff(name, "changed", _setting_text(ca), _setting_text(cb), ca.units or "",
                                   ["Different number of values."]))
            continue
        diffs = [i for i, (x, y) in enumerate(zip(ca.values, cb.values)) if not values_equal(x, y, digits)]
        if not diffs:
            continue
        if ca.kind in ("scalar", "string") and len(ca.values) == 1:
            out.append(SettingDiff(name, "changed", _setting_text(ca), _setting_text(cb), ca.units or cb.units or ""))
        else:
            detail = [f"[{i}] {fmt_value(ca.values[i], digits)} → {fmt_value(cb.values[i], digits)}"
                      for i in diffs[:12]]
            if len(diffs) > 12:
                detail.append(f"…and {len(diffs) - 12} more")
            out.append(SettingDiff(name, "changed", f"{len(diffs)} of {len(ca.values)} changed", "",
                                   ca.units or "", detail))
    return out


def diff_tables(a: TuneDoc, b: TuneDoc, tmap: dict) -> list[TableDiff]:
    """Every 2D table in either tune, matched by tablemap id then by name. Never raises."""
    fa, oa = all_tables(a, tmap)
    fb, ob = all_tables(b, tmap)
    b_by_id = {v.id: v for v in fb + ob if v.mapped}
    b_by_name = {v.z.name: v for v in fb + ob}
    used_b: set[str] = set()
    out: list[TableDiff] = []
    for va in fa + oa:
        vb = (b_by_id.get(va.id) if va.mapped else None) or b_by_name.get(va.z.name)
        zb = vb.z if vb is not None else b.get(va.z.name)  # may be a non-table of the same name
        if vb is not None:
            used_b.add(vb.z.name)
        status, msg, changed, total = compare_tables(va.z, zb)
        td = TableDiff(id=va.id, label=va.label, name=va.z.name, status=status, message=msg, changed=changed,
                       total=total, featured=va.featured, va=va, vb=vb, zb=zb)
        if status in ("changed", "same") and vb is not None:
            for lab, xa, xb in ((va.x_label or "X", va.x, vb.x), (va.y_label or "Y", va.y, vb.y)):
                note = _axis_note(lab, xa, xb)
                if note:
                    td.axis_notes.append(note)
        out.append(td)
    for vb in fb + ob:
        if vb.z.name in used_b or a.get(vb.z.name) is not None:
            continue
        out.append(TableDiff(id=vb.id, label=vb.label, name=vb.z.name, status="only_b", message="Only in tune B.",
                             featured=vb.featured, vb=vb))
    return out
