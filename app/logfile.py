"""Read a datalog file into channels, and keep it as a column store the log viewer can load from.

  * `parse_log` reads TunerStudio text logs (`.msl`, `.csv`, `.tsv`) and binary MLVLG logs (`.mlg`, format
    versions 1 and 2, to EFI Analytics' published layout).
  * `write_columns` saves a parsed log as one compressed float32 block per channel, with an index, so a viewer
    can fetch just the channels it is drawing. A real log has hundreds of channels and tens of thousands of
    rows; nobody looks at more than a dozen at once.

Real logs are big (an hour of driving on rusEFI/FOME is over 100 MB), so everything here works on numpy
arrays, and a binary log's channels are only decoded when something asks for them.
"""
from __future__ import annotations

import json
import math
import re
import struct
import zlib

import numpy as np

MAX_BYTES = int(__import__("os").environ.get("LOG_MAX_MB", "128")) * 1024 * 1024
MAX_ROWS = 400_000
MAX_FIELDS = 2000


class LogError(ValueError):
    """Raised for any log we can't read. `str(err)` is safe to show users."""


class Channel:
    """One logged channel. Holds a float64 array (NaN where the log had no number), decoded on first use;
    `values` is the same thing as a list with None for the gaps, which is what the analysis code reads."""

    def __init__(self, name: str, units: str = "", values=None, digits: int | None = None, loader=None):
        self.name, self.units, self.digits = name, units, digits
        self._loader = loader
        self._arr = None
        self._values = None
        if isinstance(values, np.ndarray):
            self._arr = values
        elif values is not None:
            self._values = list(values)

    @property
    def arr(self) -> np.ndarray:
        if self._arr is None:
            if self._values is not None:
                self._arr = np.array([np.nan if v is None else v for v in self._values], dtype=np.float64)
            elif self._loader is not None:
                self._arr = self._loader()
            else:
                self._arr = np.zeros(0)
        return self._arr

    @property
    def values(self) -> list:
        if self._values is None:
            a = self.arr
            out = a.tolist()
            if np.isnan(a).any():
                out = [None if v != v else v for v in out]
            self._values = out
        return self._values

    @property
    def nums(self) -> list[float]:
        return [v for v in self.values if v is not None]

    @property
    def has_data(self) -> bool:
        a = self.arr
        return bool(a.size) and not bool(np.isnan(a).all())

    def drop(self) -> None:
        """Forget the decoded data (it can be decoded again), to keep a big log's memory down."""
        if self._loader is not None:
            self._arr = None
            self._values = None


class LogDoc:
    def __init__(self, channels=None, rows: int = 0, source: str = "text", truncated: bool = False,
                 title: str = ""):
        self.channels: list[Channel] = channels or []
        self.rows, self.source, self.truncated, self.title = rows, source, truncated, title

    def by_name(self, name: str) -> Channel | None:
        want = _key(name)
        return next((c for c in self.channels if _key(c.name) == want), None)


def _key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _float(text: str) -> float:
    t = text.strip().strip('"')
    if not t:
        return math.nan
    try:
        v = float(t)
    except ValueError:
        return math.nan
    return v if math.isfinite(v) else math.nan


def _split(line: str, sep: str) -> list[str]:
    return [p.strip().strip('"') for p in line.split(sep)]


def _looks_numeric(parts: list[str]) -> float:
    """How much of a row is numbers, 0–1."""
    if not parts:
        return 0.0
    return sum(1 for p in parts if _float(p) == _float(p)) / len(parts)


def _decimals(token: str) -> int:
    t = token.strip().strip('"')
    if "e" in t.lower() or "." not in t:
        return 0
    return min(4, len(t) - t.index(".") - 1)


def parse_text(data: bytes) -> LogDoc:
    """A TunerStudio .msl / .csv / .tsv log: some header lines, a names row, usually a units row, then data."""
    text = data.decode("utf-8", "replace")
    if "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    del text
    probe = "\n".join(lines[:50])
    sep = "\t" if probe.count("\t") > probe.count(",") else ("," if probe.count(",") >= probe.count(";") else ";")
    head_i, names = None, []
    for i, line in enumerate(lines[:200]):
        parts = _split(line, sep)
        if len(parts) < 3 or _looks_numeric(parts) > 0.5 or not any(p for p in parts):
            continue
        nxt = _split(lines[i + 1], sep) if i + 1 < len(lines) else []
        if len(nxt) != len(parts):
            continue
        head_i, names = i, parts
        break
    if head_i is None:
        raise LogError("That file doesn't look like a datalog: no row of channel names was found.")
    n = len(names)
    if n > MAX_FIELDS:
        raise LogError(f"That log has too many channels to read ({n}).")

    body = head_i + 1
    units = [""] * n
    first = _split(lines[body], sep) if body < len(lines) else []
    if first and _looks_numeric(first) < 0.5:  # a units row, not data
        units = first
        body += 1

    chunks, rows, truncated = [], 0, False
    digits = [0] * n
    for line in lines[body:]:
        if not line or line.isspace():
            continue
        parts = line.split(sep)
        if len(parts) != n:
            continue  # markers, notes and torn last lines
        try:
            row = np.array(parts, dtype=np.float64)
        except ValueError:
            row = np.array([_float(p) for p in parts], dtype=np.float64)
            if np.count_nonzero(~np.isnan(row)) < 0.4 * n:
                continue
        if rows >= MAX_ROWS:
            truncated = True
            break
        if rows < 25:
            digits = [max(d, _decimals(p)) for d, p in zip(digits, parts)]
        chunks.append(row)
        rows += 1
    if rows < 2:
        raise LogError("That log has no data rows in it.")
    table = np.vstack(chunks)
    del chunks
    table[~np.isfinite(table)] = np.nan
    title = lines[0].strip().strip('"') if head_i > 0 else ""
    return LogDoc([Channel(name or f"Channel {i + 1}", units[i] if i < len(units) else "",
                           np.ascontiguousarray(table[:, i]), digits[i])
                   for i, name in enumerate(names)], rows, "text", truncated, title)


# type code -> (numpy format, bytes). 10–12 are bit fields, which are stored like the unsigned types.
_MLG_TYPES = {0: (">u1", 1), 1: (">i1", 1), 2: (">u2", 2), 3: (">i2", 2), 4: (">u4", 4), 5: (">i4", 4),
              6: (">i8", 8), 7: (">f4", 4), 10: (">u1", 1), 11: (">u2", 2), 12: (">u4", 4)}
_MLG_MARKER = 54  # block type, counter, 2-byte time, 50-byte message


def parse_mlg(data: bytes) -> LogDoc:
    """A binary MLVLG log (format 1 or 2). Anything inconsistent is refused, not guessed."""
    def bad(why: str):
        raise LogError(f"This .mlg log can't be read ({why}). In TunerStudio use File → Export → and save the "
                       "log as CSV or MSL, then upload that.")

    if len(data) < 32:
        bad("the file is too short")
    version, = struct.unpack_from(">H", data, 6)
    if version == 1:
        info, begin, record_len, n_fields = struct.unpack_from(">HIHH", data, 12)
        at, entry = 22, 55
    elif version == 2:
        info, begin, record_len, n_fields = struct.unpack_from(">IIHH", data, 12)
        at, entry = 24, 89
    else:
        bad(f"unknown format version {version}")
    if not 0 < n_fields <= MAX_FIELDS:
        bad(f"it declares {n_fields} channels")
    if at + entry * n_fields > len(data) or not at + entry * n_fields <= begin < len(data):
        bad("its header runs past the end of the file")

    fields, offset = [], 4  # field data starts after block type, counter and timestamp
    for _ in range(n_fields):
        kind = data[at]
        if kind not in _MLG_TYPES:
            bad(f"a channel has an unknown data type ({kind})")
        fmt, width = _MLG_TYPES[kind]
        name = data[at + 1:at + 35].split(b"\0")[0].decode("latin-1").strip()
        units = data[at + 35:at + 45].split(b"\0")[0].decode("latin-1").strip()
        scale, transform, digits = 1.0, 0.0, 0
        if kind < 10:
            scale, transform = struct.unpack_from(">ff", data, at + 46)
            digits, = struct.unpack_from("b", data, at + 54)
            if not math.isfinite(scale) or not math.isfinite(transform) or scale == 0:
                scale, transform = 1.0, 0.0
        fields.append((name or f"Channel {len(fields) + 1}", units, fmt, offset, scale, transform,
                       digits if 0 <= digits <= 6 else None))
        offset += width
        at += entry
    if offset - 4 != record_len:
        bad("its record length doesn't match its channels")
    stride = record_len + 5  # block header, the record, one checksum byte

    # Data records are back to back; a marker is a shorter block in between, so read the runs around them.
    runs, rows, truncated, pos = [], 0, False, begin
    raw = np.frombuffer(data, dtype=np.uint8)
    while pos + stride <= len(data):
        kind = data[pos]
        if kind == 0:
            most = (len(data) - pos) // stride
            other = np.flatnonzero(raw[pos:pos + most * stride:stride])
            count = int(other[0]) if other.size else most
            if rows + count > MAX_ROWS:
                count, truncated = MAX_ROWS - rows, True
            runs.append((pos, count))
            rows += count
            pos += count * stride
            if truncated:
                break
        elif kind == 1:
            pos += _MLG_MARKER
        else:
            break  # a torn or foreign tail: keep what was read
    if rows < 2:
        bad("it has no data records")

    def loader(fmt, off, scale, transform):
        def load():
            dt = np.dtype({"names": ["v"], "formats": [fmt], "offsets": [off], "itemsize": stride})
            parts = [np.frombuffer(data, dtype=dt, count=count, offset=start)["v"] for start, count in runs]
            out = (parts[0] if len(parts) == 1 else np.concatenate(parts)).astype(np.float64)
            if transform:
                out += transform
            if scale != 1.0:
                out *= scale
            out[~np.isfinite(out)] = np.nan
            return out
        return load

    title = ""
    if 0 < info < begin:
        title = data[info:begin].split(b"\0")[0].decode("latin-1", "replace").strip().split("\n")[0].strip('"')
    return LogDoc([Channel(name, units, None, digits, loader(fmt, off, scale, transform))
                   for name, units, fmt, off, scale, transform, digits in fields], rows, "mlg", truncated, title)


def parse_log(data: bytes, filename: str = "") -> LogDoc:
    if not isinstance(data, (bytes, bytearray)) or not data.strip():
        raise LogError("That file is empty.")
    if len(data) > MAX_BYTES:
        raise LogError(f"That log is too large ({MAX_BYTES // (1024 * 1024)} MB max).")
    if data[:5] == b"MLVLG":
        return parse_mlg(bytes(data))
    if filename.lower().endswith(".mlg"):
        raise LogError("That .mlg file doesn't start like an MLVLG log. In TunerStudio, export the log as CSV "
                       "or MSL and upload that.")
    return parse_text(bytes(data))


# ------------------------------------------------------------------ the column store

MAGIC = b"MSQCOL1\n"


def _guess_digits(a: np.ndarray) -> int:
    ok = a[~np.isnan(a)]
    if not ok.size:
        return 0
    sample = ok[:: max(1, ok.size // 2000)]
    if np.all(sample == np.round(sample)):
        return 0
    top = float(np.max(np.abs(sample)))
    return 3 if top < 10 else 2 if top < 100 else 1


def _num(v) -> float | None:
    v = float(v)
    return round(v, 6) if math.isfinite(v) else None


def write_columns(log: LogDoc, time: list[float], path, extra: dict | None = None) -> dict:
    """Save a log as `path`: an index, then one zlib-compressed float32 block per channel (and one for time).
    Returns the index."""
    blobs, at = [], 0

    def add(a: np.ndarray) -> dict:
        nonlocal at
        blob = zlib.compress(np.ascontiguousarray(a, dtype="<f4").tobytes(), 5)
        blobs.append(blob)
        entry = {"o": at, "l": len(blob)}
        at += len(blob)
        return entry

    t = np.asarray(time, dtype=np.float64)
    index = {"v": 1, "rows": log.rows, "source": log.source, "truncated": log.truncated, "title": log.title,
             "seconds": _num(t[-1] - t[0]) if t.size > 1 else 0.0, "time": add(t), "channels": []}
    for c in log.channels:
        a = c.arr
        some = bool(a.size) and not bool(np.isnan(a).all())
        entry = add(a)
        entry.update(n=c.name, u=c.units, d=c.digits if c.digits is not None else _guess_digits(a),
                     lo=_num(np.nanmin(a)) if some else None, hi=_num(np.nanmax(a)) if some else None)
        index["channels"].append(entry)
        c.drop()
    index.update(extra or {})
    head = json.dumps(index, separators=(",", ":")).encode()
    with open(path, "wb") as f:
        f.write(MAGIC + struct.pack("<I", len(head)) + head)
        for blob in blobs:
            f.write(blob)
    return index


def read_index(path) -> tuple[dict, int]:
    """-> (index, file offset the blocks start at)."""
    with open(path, "rb") as f:
        head = f.read(len(MAGIC) + 4)
        if head[:len(MAGIC)] != MAGIC:
            raise LogError("That log's stored data can't be read.")
        size, = struct.unpack("<I", head[len(MAGIC):])
        return json.loads(f.read(size)), len(MAGIC) + 4 + size


def read_block(path, base: int, entry: dict) -> bytes:
    """One channel's compressed block, exactly as stored (zlib-wrapped little-endian float32)."""
    with open(path, "rb") as f:
        f.seek(base + entry["o"])
        return f.read(entry["l"])
