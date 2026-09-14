"""Firmware table maps: JSON config that says which tables to feature.

Resolution order for a tune:
  1. a map whose "signatures" list contains the exact signature string
  2. a map whose "family" equals the parsed family
  3. a map whose "signature_patterns" (regexes) match the signature
  4. the generic fallback (every 2D constant rendered, unlabeled axes)

Adding firmware support = dropping a new JSON file in tablemaps/ (generate
one with tools/ini_to_tablemap.py). Any name field (z/x/y, summary field)
may be a string or a list of candidate names; the first present wins.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .parser import Constant, TuneDoc

log = logging.getLogger(__name__)

TABLEMAP_DIR = Path(__file__).resolve().parent.parent / "tablemaps"

GENERIC = {"family": "generic", "name": "Generic", "tables": [], "curves": [], "summary_fields": [],
           "constant_meta": {}}


def _candidates(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def first_present(doc: TuneDoc, names) -> Constant | None:
    for n in _candidates(names):
        c = doc.get(n)
        if c is not None:
            return c
    return None


@lru_cache(maxsize=4)
def load_maps(directory: str | None = None) -> tuple[dict, ...]:
    d = Path(directory) if directory else TABLEMAP_DIR
    maps = []
    for p in sorted(d.glob("*.json")):
        try:
            m = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            log.exception("bad tablemap %s", p.name)
            continue
        if not isinstance(m, dict) or not isinstance(m.get("tables", []), list):
            log.error("tablemap %s has wrong shape", p.name)
            continue
        for key, default in (("tables", []), ("curves", []), ("summary_fields", []), ("constant_meta", {})):
            if not isinstance(m.get(key), type(default)):
                m[key] = default
        m.setdefault("family", p.stem)
        m.setdefault("name", m["family"])
        maps.append(m)
    return tuple(maps)


def resolve_map(doc: TuneDoc, maps=None) -> dict:
    maps = load_maps() if maps is None else maps
    sig = doc.signature.strip()
    for m in maps:
        if sig and sig in _candidates(m.get("signatures")):
            return m
    for m in maps:
        if doc.family != "unknown" and m.get("family") == doc.family:
            return m
    for m in maps:
        for pat in _candidates(m.get("signature_patterns")):
            try:
                if sig and re.search(pat, sig, re.I):
                    return m
            except re.error:
                log.error("bad signature_pattern %r in %s", pat, m.get("family"))
    return GENERIC


def meta_units(tmap: dict, c: Constant | None) -> str:
    if c is None:
        return ""
    if c.units:
        return c.units
    m = tmap.get("constant_meta", {}).get(c.name)
    return str(m.get("units") or "") if isinstance(m, dict) else ""


def meta_digits(tmap: dict, c: Constant | None) -> int | None:
    if c is None:
        return None
    if c.digits is not None:
        return c.digits
    m = tmap.get("constant_meta", {}).get(c.name)
    d = m.get("digits") if isinstance(m, dict) else None
    return d if isinstance(d, int) else None


@dataclass
class TableView:
    id: str
    label: str
    palette: str
    z: Constant
    x: Constant | None
    y: Constant | None
    x_label: str
    y_label: str
    units: str
    featured: bool = True
    mapped: bool = True


def _safe_id(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", s) or "t"


def _spec_view(doc: TuneDoc, tmap: dict, t: dict) -> TableView | None:
    z = first_present(doc, t.get("z"))
    if z is None or not z.is_table:
        return None
    return TableView(
        id=_safe_id(str(t.get("id") or z.name)),
        label=str(t.get("label") or z.name),
        palette=str(t.get("palette") or "default"),
        z=z,
        x=first_present(doc, t.get("x")),
        y=first_present(doc, t.get("y")),
        x_label=str(t.get("x_label") or ""),
        y_label=str(t.get("y_label") or ""),
        units=str(t.get("units") or meta_units(tmap, z)),
        featured=t.get("featured", True) is not False,
    )


def all_tables(doc: TuneDoc, tmap: dict) -> tuple[list[TableView], list[TableView]]:
    """-> (featured, other). Every 2D constant in the tune appears exactly once."""
    featured, other, seen = [], [], set()
    for t in tmap.get("tables", []):
        if not isinstance(t, dict):
            continue
        v = _spec_view(doc, tmap, t)
        if v is None or v.z.name in seen:
            continue
        seen.add(v.z.name)
        (featured if v.featured else other).append(v)
    for name, c in doc.constants.items():
        if c.is_table and name not in seen:
            seen.add(name)
            other.append(TableView(id=_safe_id(name), label=name, palette="default", z=c, x=None, y=None,
                                   x_label="", y_label="", units=c.units or "", featured=False, mapped=False))
    return featured, other


def featured_tables(doc: TuneDoc, tmap: dict) -> list[TableView]:
    return all_tables(doc, tmap)[0]


def find_table(doc: TuneDoc, tmap: dict, zname: str) -> TableView | None:
    featured, other = all_tables(doc, tmap)
    return next((v for v in featured + other if v.z.name == zname), None)


@dataclass
class CurveView:
    id: str
    label: str
    x: Constant | None
    y: Constant
    x_label: str
    y_label: str


def curves(doc: TuneDoc, tmap: dict) -> list[CurveView]:
    out = []
    for c in tmap.get("curves", []):
        if not isinstance(c, dict):
            continue
        y = first_present(doc, c.get("y"))
        if y is None or y.is_table or len(y.values) < 2:
            continue
        x = first_present(doc, c.get("x"))
        if x is not None and len(x.values) != len(y.values):
            x = None
        out.append(CurveView(_safe_id(str(c.get("id") or y.name)), str(c.get("label") or y.name), x, y,
                             str(c.get("x_label") or ""), str(c.get("y_label") or "")))
    return out


def summary_fields(doc: TuneDoc, tmap: dict) -> list[tuple[str, Constant]]:
    out = []
    for f in tmap.get("summary_fields", []):
        if isinstance(f, dict):
            label, names = f.get("label"), f.get("name")
        else:
            label, names = None, f
        c = first_present(doc, names)
        if c is not None and not c.is_table:
            out.append((str(label or c.name), c))
    return out
