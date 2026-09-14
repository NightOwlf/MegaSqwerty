"""Pure .msq parser: bytes -> TuneDoc.

A .msq is XML written by TunerStudio (and compatible tools). Nothing here
touches the filesystem or network, and every input is treated as hostile:
DTDs / entities are forbidden, and file size, constant count and total
parsed values are capped.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from xml.etree.ElementTree import ParseError as _StdParseError

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import fromstring as _safe_fromstring

MAX_BYTES = 16 * 1024 * 1024
MAX_CONSTANTS = 5_000
MAX_VALUES = 2_000_000
MAX_DIM = 1024

FAMILIES = ("MS3", "MS2", "MS1", "Speeduino", "rusEFI", "FOME", "unknown")


class MsqError(ValueError):
    """Raised for any input we refuse. `str(err)` is safe to show users."""


@dataclass
class Constant:
    name: str
    kind: str  # "scalar" | "string" | "array" | "table"
    values: list  # flattened row-major; floats, or strings for bit options
    rows: int = 1
    cols: int = 1
    units: str | None = None
    digits: int | None = None
    page: int | None = None

    @property
    def is_table(self) -> bool:
        return self.kind == "table"

    @property
    def is_array(self) -> bool:
        return self.kind == "array"

    @property
    def value(self):
        return self.values[0] if self.values else None

    def row(self, r: int) -> list:
        return self.values[r * self.cols:(r + 1) * self.cols]


@dataclass
class TuneDoc:
    signature: str = ""  # raw, verbatim from the file — always displayed
    family: str = "unknown"
    version: str = ""
    branch: str = ""  # rusEFI/FOME only
    board: str = ""
    build: str = ""
    file_format: str = ""
    n_pages: str = ""
    firmware_info: str = ""
    author: str = ""
    tune_comment: str = ""
    write_date: str = ""
    constants: dict[str, Constant] = field(default_factory=dict)

    def get(self, name: str) -> Constant | None:
        return self.constants.get(name)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["constants"] = [asdict(c) for c in self.constants.values()]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "TuneDoc":
        consts = {c["name"]: Constant(**c) for c in d.get("constants", [])}
        meta = {k: v for k, v in d.items() if k != "constants"}
        return cls(**meta, constants=consts)


# ---------------------------------------------------------------- signature

# Loose, case-insensitive substring detection. Order matters: FOME
# signatures read "rusEFI (FOME) ...", and MS3 must win over MS2/MS1.
_SIG_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("FOME", ("fome",)),
    ("rusEFI", ("rusefi",)),
    ("Speeduino", ("speeduino",)),
    ("MS3", ("ms3", "megasquirt-iii", "megasquirt iii")),
    ("MS2", ("ms2", "msii", "megasquirt-ii", "megasquirt ii")),
    ("MS1", ("ms1", "msns", "megasquirt-i", "megasquirt i")),
]


def parse_signature(sig: str | None) -> dict:
    """Detect firmware family + version from a signature string.

    'MS3 format 0342.01'                                   -> MS3, '0342.01'
    'rusEFI (FOME) Vthpnp.2026.03.19.vthpnp.3616320453'    -> FOME, '2026.03.19',
        with branch='Vthpnp', board='vthpnp', build='3616320453'
    Never raises; anything unrecognised is family 'unknown'.
    """
    s = (sig or "").strip().strip('"').strip()
    low = s.lower()
    family = "unknown"
    for fam, needles in _SIG_RULES:
        # Short "ms…" needles must not start mid-word: "MS2Extra comms342hP" is MS2, not MS3.
        if any(re.search(r"(?<![a-z])" + re.escape(n), low) if n.startswith("ms") else n in low for n in needles):
            family = fam
            break
    out = {"family": family, "version": "", "branch": "", "board": "", "build": ""}
    if family in ("rusEFI", "FOME"):
        # <branch>.<yyyy>.<mm>.<dd>.<board>.<hash>, possibly after a prefix.
        m = re.search(r"([\w\-]+)\.(\d{4})\.(\d{2})\.(\d{2})\.([\w\-]+?)(?:\.(\d+))?\s*$", s)
        if m:
            out.update(branch=m.group(1), version=f"{m.group(2)}.{m.group(3)}.{m.group(4)}",
                       board=m.group(5), build=m.group(6) or "")
            return out
    if family != "unknown":
        m = re.search(r"(?:format|rev(?:ision)?|comms|serial)\s*([0-9][\w.\-]*)", s, re.I)
        if m:
            out["version"] = m.group(1).strip("*")
        else:
            tokens = [t for t in re.split(r"\s+", s) if re.search(r"\d", t) and not re.fullmatch(r"(?i)ms\d", t)]
            out["version"] = tokens[0].strip("*") if tokens else ""
    return out


# -------------------------------------------------------------------- parse

def _local(tag: str) -> str:
    # Strip "{namespace}" — TunerStudio writes xmlns="http://www.msefi.com/:msq".
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _int_attr(el, name: str) -> int | None:
    v = el.get(name)
    if v is None:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


_TOKEN_RE = re.compile(r'"[^"]*"|\S+')


def _tokens(text: str) -> list:
    out: list = []
    for tok in _TOKEN_RE.findall(text):
        if tok.startswith('"') and tok.endswith('"') and len(tok) >= 2:
            out.append(tok[1:-1])
            continue
        try:
            f = float(tok)
        except ValueError:
            out.append(tok)
            continue
        if f != f or f in (float("inf"), float("-inf")):
            out.append(tok)
        else:
            out.append(f)
    return out


def parse_msq(data: bytes) -> TuneDoc:
    if not isinstance(data, (bytes, bytearray)):
        raise MsqError("Upload must be a file.")
    if len(data) > MAX_BYTES:
        raise MsqError("File is too large (16 MB max).")
    if not data.strip():
        raise MsqError("File is empty.")
    head = data.lstrip()[:1]
    if head not in (b"<", b"\xef"):  # '<' or UTF-8 BOM
        raise MsqError("That doesn't look like a .msq tune file (not XML).")

    try:
        root = _safe_fromstring(bytes(data), forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except DefusedXmlException:
        raise MsqError("File contains XML DTD/entity declarations, which aren't allowed.") from None
    except (_StdParseError, ValueError, LookupError, UnicodeError):
        raise MsqError("That doesn't look like a .msq tune file (invalid XML).") from None

    if _local(root.tag) != "msq":
        raise MsqError("That XML file isn't a .msq tune (missing <msq> root).")

    doc = TuneDoc()
    total_values = 0

    for el in root:
        tag = _local(el.tag)
        if tag == "bibliography":
            doc.author = (el.get("author") or "").strip()
            doc.tune_comment = (el.get("tuneComment") or "").strip()
            doc.write_date = (el.get("writeDate") or "").strip()
        elif tag == "versionInfo":
            doc.signature = (el.get("signature") or "").strip()
            doc.file_format = (el.get("fileFormat") or "").strip()
            doc.n_pages = (el.get("nPages") or "").strip()
            doc.firmware_info = (el.get("firmwareInfo") or "").strip()

    def containers():
        for el in root:
            tag = _local(el.tag)
            if tag == "page":
                yield _int_attr(el, "number"), el
            elif tag in ("pcVariables", "settings"):
                yield None, el
        # A few writers put constants directly under <msq>.
        yield None, root

    for page_no, container in containers():
        for el in container:
            tag = _local(el.tag)
            if tag not in ("constant", "pcVariable"):
                continue
            name = (el.get("name") or "").strip()
            if not name or name in doc.constants:
                continue
            if len(doc.constants) >= MAX_CONSTANTS:
                raise MsqError("Tune has too many settings to display.")

            rows = _int_attr(el, "rows")
            cols = _int_attr(el, "cols")
            text = el.text or ""
            vals = _tokens(text)
            total_values += len(vals)
            if total_values > MAX_VALUES:
                raise MsqError("Tune has too many values to display.")

            rows = rows if rows and rows > 0 else None
            cols = cols if cols and cols > 0 else None
            if (rows and rows > MAX_DIM) or (cols and cols > MAX_DIM):
                raise MsqError("Tune contains a table with absurd dimensions.")

            digits = _int_attr(el, "digits")
            units = (el.get("units") or "").strip() or None

            if rows or cols:
                r, c = rows or 1, cols or 1
                if r * c != len(vals):
                    # Trust the data over the attributes rather than failing.
                    if r > 1 and c > 1 or not vals:
                        r, c = (len(vals), 1) if vals else (0, 0)
                    else:
                        r, c = (len(vals), 1) if r >= c else (1, len(vals))
                kind = "table" if r > 1 and c > 1 else ("array" if r * c > 1 else None)
                if kind is None:
                    kind = "scalar" if vals and isinstance(vals[0], float) else "string"
                const = Constant(name, kind, vals, r, c, units, digits, page_no)
            else:
                stripped = text.strip()
                if len(vals) == 1 and isinstance(vals[0], float):
                    const = Constant(name, "scalar", vals, 1, 1, units, digits, page_no)
                elif len(vals) > 1 and all(isinstance(v, float) for v in vals):
                    const = Constant(name, "array", vals, len(vals), 1, units, digits, page_no)
                else:
                    s = stripped[1:-1] if len(stripped) >= 2 and stripped[0] == stripped[-1] == '"' else stripped
                    const = Constant(name, "string", [s], 1, 1, units, digits, page_no)
            doc.constants[name] = const

    sig = parse_signature(doc.signature)
    doc.family, doc.version = sig["family"], sig["version"]
    doc.branch, doc.board, doc.build = sig["branch"], sig["board"], sig["build"]
    return doc


# ------------------------------------------------------------------ helpers

def fmt_value(v, digits: int | None = None) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if digits is not None and 0 <= digits <= 6:
        s = f"{v:.{digits}f}"
    else:
        s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "-0.0", "-0.00") else s


def values_equal(a, b, digits: int | None = None) -> bool:
    if isinstance(a, float) and isinstance(b, float):
        if digits is not None and 0 <= digits <= 6:
            return round(a, digits) == round(b, digits)
        return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))
    return a == b
