"""Edit a tune by rewriting only the numbers that changed in the original .msq bytes.

Everything else in the file (whitespace, attribute order, encoding declaration, other constants,
bibliography, elements we don't understand) stays byte-for-byte identical, so TunerStudio loads the result
exactly as it loaded the original. The result is re-parsed, and the edit is refused if any value other than
the requested ones would change.

Only numeric values are editable. Option settings (quoted strings such as "Speed Density") aren't: a .msq
doesn't record which choices are valid, that lives in the firmware's ini.
"""
from __future__ import annotations

import math
import re

from .parser import Constant, MsqError, parse_msq

MAX_CHANGED_CONSTANTS = 500
MAX_CHANGED_VALUES = 100_000
MAX_ABS = 1e9


class EditError(ValueError):
    """Raised for any edit we refuse. `str(err)` is safe to show users."""


# A <constant> or <pcVariable> with text content (self-closing elements have no values to edit).
_ELEMENT = re.compile(rb"<(constant|pcVariable)(\s[^<>]*?)(?<!/)>([^<]*)</\1\s*>")
_NAME_ATTR = re.compile(rb"""\bname\s*=\s*(["'])(.*?)\1""", re.S)
# Same tokenisation as parser._TOKEN_RE, on bytes, so token i here is value i there.
_TOKEN = re.compile(rb'"[^"]*"|\S+')


def is_editable(c: Constant | None) -> bool:
    return (c is not None and c.kind in ("scalar", "array", "table") and bool(c.values)
            and all(isinstance(v, float) for v in c.values))


def _decimals_needed(v: float, cap: int = 4) -> int:
    for d in range(cap + 1):
        if abs(round(v, d) - v) <= 1e-6 * max(1.0, abs(v)):
            return d
    return cap


def edit_digits(c: Constant) -> int:
    """Decimal places an editor should offer: the file's `digits`, else what the stored values use."""
    if c.digits is not None and 0 <= c.digits <= 6:
        return c.digits
    return max((_decimals_needed(v) for v in c.values if isinstance(v, float)), default=0)


def format_number(v: float, digits: int | None, like: bytes) -> bytes:
    """Write `v` the way the file writes this value: `digits` places, else as many as the old token had."""
    if digits is not None and 0 <= digits <= 6:
        places = digits
    else:
        old = like.decode("ascii", "replace")
        places = None if "e" in old.lower() else min(10, len(old.split(".", 1)[1]) if "." in old else 0)
    s = repr(float(v)) if places is None else f"{v:.{places}f}"
    if s.startswith("-") and float(s) == 0:
        s = s[1:]
    return s.encode("ascii")


def _short(name) -> str:
    s = str(name)
    return s if len(s) <= 60 else s[:57] + "…"


def _elements(raw: bytes, wanted: set[bytes]) -> dict[bytes, list[re.Match]]:
    found: dict[bytes, list[re.Match]] = {}
    for m in _ELEMENT.finditer(raw):
        attr = _NAME_ATTR.search(m.group(2))
        if attr is not None and attr.group(2).strip() in wanted:
            found.setdefault(attr.group(2).strip(), []).append(m)
    return found


def apply_changes(raw: bytes, changes) -> tuple[bytes, int]:
    """`changes` is {constant name: {value index: new number}}; indexes are in file order (row-major).

    -> (new .msq bytes, number of values rewritten). Raises EditError.
    """
    if not isinstance(changes, dict) or not changes:
        raise EditError("There are no changes to save.")
    if len(changes) > MAX_CHANGED_CONSTANTS:
        raise EditError(f"That's too many changed settings to save at once (max {MAX_CHANGED_CONSTANTS}).")
    try:
        doc = parse_msq(raw)
    except MsqError:
        raise EditError("The original tune file can't be read, so it can't be edited.") from None

    wanted: dict[bytes, str] = {}
    for name in changes:
        c = doc.get(name) if isinstance(name, str) else None
        if c is None:
            raise EditError(f"{_short(name)} isn't in this tune.")
        if not is_editable(c):
            raise EditError(f"{_short(name)} can't be edited. Only numbers, curves and tables can.")
        try:
            wanted[name.encode("ascii")] = name
        except UnicodeEncodeError:
            raise EditError(f"{_short(name)} can't be edited.") from None
    elements = _elements(raw, set(wanted))

    plan: list[tuple[int, int, bytes]] = []
    expected: dict[str, list] = {}
    total = 0
    for bname, name in wanted.items():
        c, edits = doc.get(name), changes[name]
        found = elements.get(bname, [])
        if len(found) != 1:
            raise EditError(f"{_short(name)} can't be edited: it appears {len(found) or 'zero'} times in the file.")
        m = found[0]
        tokens = list(_TOKEN.finditer(m.group(3)))
        if len(tokens) != len(c.values):
            raise EditError(f"The values of {_short(name)} couldn't be located in the file.")
        if not isinstance(edits, dict) or not edits:
            raise EditError(f"No values were given for {_short(name)}.")
        new_values = list(c.values)
        by_index: dict[int, bytes] = {}
        for key, v in edits.items():
            try:
                i = int(key)
            except (TypeError, ValueError):
                raise EditError(f"{_short(name)}: {_short(key)} isn't a value position.") from None
            if not 0 <= i < len(c.values):
                raise EditError(f"{_short(name)}: value #{i} is out of range.")
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > MAX_ABS:
                raise EditError(f"{_short(name)}: {_short(v)} isn't a usable number.")
            total += 1
            if total > MAX_CHANGED_VALUES:
                raise EditError(f"That's too many changed values to save at once (max {MAX_CHANGED_VALUES}).")
            token = tokens[i].group()
            text = format_number(float(v), c.digits, token)
            if text != token:
                by_index[i] = text
                new_values[i] = float(text)
        start = m.start(3)
        plan += [(start + tokens[i].start(), start + tokens[i].end(), text) for i, text in by_index.items()]
        expected[name] = new_values

    if not plan:
        raise EditError("Nothing changed: the new values are the same as the tune's.")
    out = bytearray(raw)
    for s, e, text in sorted(plan, reverse=True):
        out[s:e] = text
    new = bytes(out)

    try:
        check = parse_msq(new)
    except MsqError:
        raise EditError("Those changes couldn't be written back into the file safely.") from None
    for name, c in doc.constants.items():
        nc = check.get(name)
        if nc is None or nc.values != expected.get(name, c.values):
            raise EditError("Those changes couldn't be written back into the file safely.")
    return new, len(plan)
