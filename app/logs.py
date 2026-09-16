"""Read a datalog and say what it shows about the tune it came from.

Two jobs:

  * `parse_log` turns a TunerStudio log into channels and rows. `.msl`, `.csv` and `.tsv` text logs are the
    reliable path (TunerStudio and MegaLogViewer both export them). `.mlg` binary logs are read to the
    documented MLVLG layout, and anything that doesn't add up is refused with a message telling the user to
    export text instead, rather than guessed at.
  * `analyze` compares the log to the tune it was logged from: what would hurt the engine (lean in boost,
    knock, overboost, injectors out of duty, heat), what looks off, and what looks good. It also works out
    what to change — VE cells from the wideband, and timing where the ECU pulled it for knock — as suggestions
    the user can apply, never silently.

Channel names differ between firmware (`AFR`, `AFR1`, `Lambda`, `O2`…), so channels are matched by pattern
and the report always says which channel it used. Nothing is inferred from a channel that isn't there: a
check with no channel simply doesn't run, and the report says so.
"""
from __future__ import annotations

import math
import re
import struct
from dataclasses import asdict, dataclass, field

from .axes import ATMOSPHERE_KPA, BOOST_EDGE_KPA
from .parser import Constant, TuneDoc
from .render import fuel_mode
from .tablemaps import TableView

MAX_BYTES = 16 * 1024 * 1024
MAX_ROWS = 400_000
MAX_FIELDS = 400
CHART_POINTS = 700
PSI_KPA = 6.894757


class LogError(ValueError):
    """Raised for any log we can't read. `str(err)` is safe to show users."""


# ------------------------------------------------------------------ the log itself

@dataclass
class Channel:
    name: str
    units: str
    values: list  # one per row; None where the log had no number

    @property
    def nums(self) -> list[float]:
        return [v for v in self.values if v is not None]


@dataclass
class LogDoc:
    channels: list[Channel] = field(default_factory=list)
    rows: int = 0
    source: str = "text"
    truncated: bool = False
    title: str = ""

    def by_name(self, name: str) -> Channel | None:
        want = _key(name)
        return next((c for c in self.channels if _key(c.name) == want), None)


def _key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _float(text: str):
    t = text.strip().strip('"')
    if not t or t in ("-", "n/a", "NA", "null"):
        return None
    try:
        v = float(t)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _split(line: str, sep: str) -> list[str]:
    return [p.strip().strip('"') for p in line.split(sep)]


def _looks_numeric(parts: list[str]) -> float:
    """How much of a row is numbers, 0–1."""
    if not parts:
        return 0.0
    return sum(1 for p in parts if _float(p) is not None) / len(parts)


def parse_text(data: bytes) -> LogDoc:
    """A TunerStudio .msl / .csv / .tsv log: some header lines, a names row, usually a units row, then data."""
    text = data.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln for ln in text.split("\n")]
    sep = "\t" if text.count("\t") > text.count(",") else ("," if text.count(",") >= text.count(";") else ";")
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
    if len(names) > MAX_FIELDS:
        raise LogError(f"That log has too many channels to read ({len(names)}).")

    body = head_i + 1
    units = [""] * len(names)
    first = _split(lines[body], sep) if body < len(lines) else []
    if first and _looks_numeric(first) < 0.5:  # a units row, not data
        units = first
        body += 1

    cols: list[list] = [[] for _ in names]
    rows = 0
    truncated = False
    for line in lines[body:]:
        if not line.strip():
            continue
        parts = _split(line, sep)
        if len(parts) != len(names) or _looks_numeric(parts) < 0.4:
            continue  # markers, notes and torn last lines
        if rows >= MAX_ROWS:
            truncated = True
            break
        for k, p in enumerate(parts):
            cols[k].append(_float(p))
        rows += 1
    if rows < 2:
        raise LogError("That log has no data rows in it.")
    title = lines[0].strip().strip('"') if head_i > 0 else ""
    return LogDoc([Channel(n or f"Channel {i + 1}", units[i] if i < len(units) else "", cols[i])
                   for i, n in enumerate(names)], rows, "text", truncated, title)


_MLG_TYPES = {0: ("B", 1), 1: ("b", 1), 2: (">H", 2), 3: (">h", 2), 4: (">I", 4), 5: (">i", 4), 6: (">f", 4)}


def parse_mlg(data: bytes) -> LogDoc:
    """A binary MLVLG log, read to its documented layout. Anything inconsistent is refused, not guessed."""
    def bad(why: str):
        raise LogError(f"This .mlg log can't be read ({why}). In TunerStudio use File → Export → and save the "
                       "log as CSV or MSL, then upload that.")

    if len(data) < 32:
        bad("the file is too short")
    version, = struct.unpack_from(">H", data, 6)
    if version not in (1, 2):
        bad(f"unknown format version {version}")
    info_start, begin, record_len, n_fields = struct.unpack_from(">HIHH", data, 12)
    if not 0 < n_fields <= MAX_FIELDS:
        bad(f"it declares {n_fields} channels")
    entry = 55 if version == 1 else 89
    at = 22
    if at + entry * n_fields > len(data) or begin >= len(data):
        bad("its header runs past the end of the file")
    channels, fmt, size = [], [], 0
    for _ in range(n_fields):
        kind = data[at]
        if kind not in _MLG_TYPES:
            bad(f"a channel has an unknown data type ({kind})")
        code, width = _MLG_TYPES[kind]
        name = data[at + 1:at + 35].split(b"\0")[0].decode("latin-1").strip()
        units = data[at + 35:at + 45].split(b"\0")[0].decode("latin-1").strip()
        scale, transform = struct.unpack_from(">ff", data, at + 46)
        channels.append(Channel(name or f"Channel {len(channels) + 1}", units, []))
        fmt.append((code, width, scale if scale else 1.0, transform))
        size += width
        at += entry
    if record_len < size + 1 or record_len > size + 16:
        bad("its record length doesn't match its channels")

    head = record_len - size  # block type, counter and timestamp before the field data
    rows, truncated, pos = 0, False, begin
    while pos + record_len <= len(data):
        if rows >= MAX_ROWS:
            truncated = True
            break
        if data[pos] != 0:  # 0 is a data record; markers and annotations are skipped
            pos += record_len
            continue
        off = pos + head
        for c, (code, width, scale, transform) in zip(channels, fmt):
            raw, = struct.unpack_from(code, data, off)
            c.values.append(raw * scale + transform)
            off += width
        rows += 1
        pos += record_len
    if rows < 2:
        bad("it has no data records")
    return LogDoc(channels, rows, "mlg", truncated)


def parse_log(data: bytes, filename: str = "") -> LogDoc:
    if not isinstance(data, (bytes, bytearray)) or not data.strip():
        raise LogError("That file is empty.")
    if len(data) > MAX_BYTES:
        raise LogError("That log is too large (16 MB max).")
    if data[:5] == b"MLVLG":
        return parse_mlg(bytes(data))
    if filename.lower().endswith(".mlg"):
        raise LogError("That .mlg file doesn't start like an MLVLG log. In TunerStudio, export the log as CSV "
                       "or MSL and upload that.")
    return parse_text(bytes(data))


# ------------------------------------------------------------------ channels we look for

# role -> patterns matched against the squashed channel name ("Target AFR" -> "targetafr"). First match wins,
# so put the specific ones first: "afrtarget" must not be taken for the measured AFR.
ROLES: dict[str, tuple[str, ...]] = {
    "time": (r"^time", r"^seconds$", r"^secl$", r"^timestamp$"),
    "rpm": (r"^rpm$", r"^enginerpm$", r"^enginespeed$", r"^speedrpm$"),
    "map": (r"^map$", r"^mapkpa$", r"^manifoldpressure", r"^mapvalue$", r"^boostpressure$"),
    "tps": (r"^tps$", r"^tps1$", r"^throttle", r"^tpsposition$"),
    "lambda_target": (r"^lambdatarget", r"^targetlambda", r"^afrtarget", r"^targetafr", r"^afrtgt",
                      r"^lambdatgt", r"^airfuelratiotarget"),
    "lambda": (r"^lambda1?$", r"^afr1?$", r"^widebandafr", r"^wbafr", r"^o2$", r"^ego1?$", r"^airfuelratio$"),
    "advance": (r"^advance", r"^ignitionadvance", r"^sparkadvance", r"^timing$", r"^ignadv", r"^spkadv"),
    "knock": (r"^knock", r"^detonation", r"^knkretard", r"^ignitionretard"),
    "clt": (r"^clt$", r"^coolant", r"^cltdeg", r"^enginetemp"),
    "iat": (r"^iat$", r"^mat$", r"^intakeair", r"^intaketemp", r"^chargetemp", r"^airtemp"),
    "duty": (r"^boostduty", r"^boostpwm", r"^bcduty", r"^wastegateduty", r"^boostcontrolduty"),
    "boost_target": (r"^boosttarget", r"^targetboost", r"^boostcontroltarget", r"^boostkpatarget"),
    "inj_duty": (r"^injduty", r"^injectorduty", r"^dutycycle", r"^duty$", r"^injectorssduty"),
    "pw": (r"^pw1?$", r"^pulsewidth", r"^injpulsewidth", r"^injectorpulsewidth"),
    "batt": (r"^batt", r"^vbatt", r"^batteryvoltage", r"^voltage$"),
    "vss": (r"^vss$", r"^vehiclespeed", r"^speed$", r"^roadspeed"),
    "gear": (r"^gear$", r"^currentgear", r"^detectedgear", r"^gearnumber"),
    "fuel_press": (r"^fuelpress", r"^fuelpressure", r"^fp$", r"^railpressure"),
    "egt": (r"^egt1?$", r"^exhausttemp", r"^exhaustgastemp"),
    "ego_corr": (r"^egocor", r"^o2correction", r"^shorttermfueltrim", r"^stft", r"^closedloopcorrection",
                 r"^fueltrim"),
    "ve": (r"^vecurr", r"^vecurrent", r"^ve1?$", r"^vetable"),
    "accel": (r"^accelenrich", r"^tpsaccel", r"^accel$", r"^aeamount"),
}


def resolve(log: LogDoc) -> dict[str, Channel]:
    """-> {role: channel} for the roles this log has. A role with no channel is simply absent."""
    out: dict[str, Channel] = {}
    taken: set[int] = set()
    for role, patterns in ROLES.items():
        for pattern in patterns:
            for i, c in enumerate(log.channels):
                if i in taken or not re.match(pattern, _key(c.name)):
                    continue
                if not c.nums:
                    continue
                out[role] = c
                taken.add(i)
                break
            if role in out:
                break
    return out


def _is_lambda(c: Channel) -> bool:
    if "lambda" in _key(c.name) or "lambda" in (c.units or "").lower():
        return True
    if "afr" in _key(c.name) or "afr" in (c.units or "").lower():
        return False
    nums = c.nums
    return bool(nums) and max(nums) <= 2.0


def _to_kpa(c: Channel) -> tuple[list, str]:
    """MAP as absolute kPa, whatever the log stored it in."""
    u = (c.units or "").lower()
    nums = c.nums
    if "psi" in u:
        gauge = bool(nums) and min(nums) > -20 and max(nums) < 60
        note = "MAP was logged in psi" + (" (gauge), read as absolute kPa" if gauge else "")
        return [None if v is None else (ATMOSPHERE_KPA + v * PSI_KPA if gauge else v * PSI_KPA) for v in c.values], note
    if "bar" in u:
        return [None if v is None else v * 100.0 for v in c.values], "MAP was logged in bar, read as kPa"
    return list(c.values), ""


def _to_c(c: Channel) -> tuple[list, str]:
    u = (c.units or "").lower()
    nums = c.nums
    fahrenheit = "f" in u and "c" not in u or (not u and nums and max(nums) > 140)
    if fahrenheit:
        return [None if v is None else (v - 32) / 1.8 for v in c.values], f"{c.name} was logged in °F"
    return list(c.values), ""


# ------------------------------------------------------------------ what the log shows

@dataclass
class Finding:
    level: str  # error | warn | info | ok
    group: str
    text: str
    where: str = ""


@dataclass
class Pull:
    start: float
    end: float
    seconds: float
    peak_psi: float
    peak_kpa: float
    rpm_from: float
    rpm_to: float
    leanest_lambda: float | None
    max_advance: float | None
    knock: bool
    lean: bool


@dataclass
class Report:
    findings: list = field(default_factory=list)
    stats: list = field(default_factory=list)
    pulls: list = field(default_factory=list)
    charts: list = field(default_factory=list)
    used: list = field(default_factory=list)     # (role, channel name) pairs the report relied on
    missing: list = field(default_factory=list)  # channels that would have added checks
    notes: list = field(default_factory=list)
    ve: dict | None = None
    timing: dict | None = None
    seconds: float = 0.0
    rows: int = 0

    @property
    def summary(self) -> dict:
        n = {lv: sum(1 for f in self.findings if f.level == lv) for lv in ("error", "warn", "info")}
        if n["error"]:
            return {"tone": "error", "short": f"{n['error']} to fix",
                    "verdict": f"Stop: {n['error']} thing{'s' if n['error'] != 1 else ''} to fix before the next pull"}
        if n["warn"]:
            return {"tone": "warn", "short": f"{n['warn']} to check",
                    "verdict": f"Nothing dangerous, but {n['warn']} thing{'s' if n['warn'] != 1 else ''} to look at"}
        return {"tone": "ok", "short": "Looks good", "verdict": "Nothing in this log looks dangerous"}


ROLE_LABELS = {"rpm": "RPM", "map": "MAP", "lambda": "wideband AFR/λ", "lambda_target": "AFR/λ target",
               "advance": "ignition advance", "knock": "knock", "clt": "coolant temperature",
               "iat": "intake air temperature", "inj_duty": "injector duty", "batt": "battery voltage",
               "duty": "boost duty", "tps": "throttle", "egt": "exhaust gas temperature",
               "fuel_press": "fuel pressure", "ego_corr": "closed-loop fuel correction"}


def _timebase(log: LogDoc, ch: dict) -> tuple[list[float], str]:
    c = ch.get("time")
    if c is not None and len(c.nums) > 1:
        out, offset, last = [], 0.0, None
        for v in c.values:
            if v is None:
                out.append(out[-1] if out else 0.0)
                continue
            if last is not None and v < last - 0.5:  # a seconds counter that wrapped
                offset += last - v
            last = v
            out.append(v + offset)
        base = out[0]
        return [v - base for v in out], ""
    return [i * 0.1 for i in range(log.rows)], "This log has no time channel, so times assume 10 samples a second."


def _at(values, i):
    v = values[i] if 0 <= i < len(values) else None
    return v if isinstance(v, (int, float)) else None


def _g(v: float, places: int = 1) -> str:
    return f"{round(v, places):g}"


def psi_of(kpa: float) -> float:
    return (kpa - ATMOSPHERE_KPA) / PSI_KPA


def _runs(flags: list[bool], t: list[float], min_seconds: float = 0.0):
    """Stretches where `flags` holds, as (first index, last index), ignoring blips shorter than min_seconds."""
    out, start = [], None
    for i, on in enumerate(flags + [False]):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if t[min(i, len(t) - 1)] - t[start] >= min_seconds or i - start > 1 and min_seconds == 0:
                out.append((start, i - 1))
            start = None
    return out


def _table_lookup(z: Constant, xb: list, yb: list, x: float, y: float) -> float | None:
    """Bilinear read of a table, clamped at its edges."""
    def span(bins, v):
        if v <= bins[0]:
            return 0, 0, 0.0
        if v >= bins[-1]:
            return len(bins) - 1, len(bins) - 1, 0.0
        k = max(i for i, b in enumerate(bins) if b <= v)
        width = bins[k + 1] - bins[k]
        return k, k + 1, (v - bins[k]) / width if width else 0.0

    if not xb or not yb or len(xb) != z.cols or len(yb) != z.rows:
        return None
    c0, c1, fc = span(xb, x)
    r0, r1, fr = span(yb, y)
    try:
        a = z.values[r0 * z.cols + c0] + (z.values[r0 * z.cols + c1] - z.values[r0 * z.cols + c0]) * fc
        b = z.values[r1 * z.cols + c0] + (z.values[r1 * z.cols + c1] - z.values[r1 * z.cols + c0]) * fc
    except (TypeError, IndexError):
        return None
    return a + (b - a) * fr


def _cell(bins: list, v: float) -> int | None:
    """Which bin a value belongs to: the nearest one, like an ECU's own rounding."""
    if not bins or v is None:
        return None
    return min(range(len(bins)), key=lambda i: abs(bins[i] - v))


def _view(views: list[TableView], role: str) -> TableView | None:
    v = next((x for x in views if x.id == role), None)
    if v is None or v.x is None or v.y is None:
        return None
    if len(v.x.values) != v.z.cols or len(v.y.values) != v.z.rows:
        return None
    return v if all(isinstance(n, float) for n in v.z.values) else None


def analyze(log: LogDoc, doc: TuneDoc, views: list[TableView], cut_kpa: float | None = None,
            map_max: float | None = None, rev: float | None = None) -> Report:
    """Compare a log to the tune it came from."""
    ch = resolve(log)
    r = Report(rows=log.rows)
    t, note = _timebase(log, ch)
    r.seconds = round(t[-1] - t[0], 1) if len(t) > 1 else 0.0
    if note:
        r.notes.append(note)
    if log.truncated:
        r.notes.append(f"This log is longer than {MAX_ROWS:,} samples; only the first part was read.")

    rpm = ch["rpm"].values if "rpm" in ch else [None] * log.rows
    kpa, map_note = _to_kpa(ch["map"]) if "map" in ch else ([None] * log.rows, "")
    if map_note:
        r.notes.append(map_note)
    tps = ch["tps"].values if "tps" in ch else [None] * log.rows
    clt, clt_note = _to_c(ch["clt"]) if "clt" in ch else ([None] * log.rows, "")
    iat, iat_note = _to_c(ch["iat"]) if "iat" in ch else ([None] * log.rows, "")
    r.notes += [n for n in (clt_note, iat_note) if n]

    stoich = next((c.value for c in [doc.get("stoich")] if c is not None and isinstance(c.value, float)
                   and 6 <= c.value <= 16), 14.7)
    lam = lam_t = None
    if "lambda" in ch:
        c = ch["lambda"]
        lam = list(c.values) if _is_lambda(c) else [None if v is None else v / stoich for v in c.values]
    if "lambda_target" in ch:
        c = ch["lambda_target"]
        lam_t = list(c.values) if _is_lambda(c) else [None if v is None else v / stoich for v in c.values]
    afr_view = _view(views, "afr")
    if lam_t is None and afr_view is not None and lam is not None:
        mode = fuel_mode(afr_view.z, afr_view.units, afr_view.palette)
        scale = 1.0 if mode == "lambda" else stoich
        xb, yb = list(afr_view.x.values), list(afr_view.y.values)
        lam_t = []
        for i in range(log.rows):
            v = _table_lookup(afr_view.z, xb, yb, _at(rpm, i) or 0.0, _at(kpa, i) or 0.0)
            lam_t.append(None if v is None else v / scale)
        r.notes.append(f"The log has no AFR target channel, so targets come from the tune's {afr_view.label}.")

    for role in ("rpm", "map", "lambda", "lambda_target", "advance", "knock", "clt", "iat", "inj_duty", "batt",
                 "duty", "tps", "egt", "fuel_press", "ego_corr"):
        if role in ch:
            r.used.append((ROLE_LABELS.get(role, role), ch[role].name))
        elif role in ROLE_LABELS and role not in ("duty", "egt", "fuel_press", "ego_corr", "lambda_target"):
            r.missing.append(ROLE_LABELS[role])

    inj = None
    if "inj_duty" in ch:
        inj = list(ch["inj_duty"].values)
    elif "pw" in ch:
        inj = [None if (_at(ch["pw"].values, i) is None or _at(rpm, i) is None)
               else ch["pw"].values[i] * rpm[i] / 1200.0 for i in range(log.rows)]
        r.notes.append("Injector duty isn't in this log, so it's worked out from pulse width and RPM.")

    def where(i: int) -> str:
        bits = [f"{_g(t[i])} s"]
        if _at(rpm, i) is not None:
            bits.append(f"{_g(rpm[i], 0)} rpm")
        if _at(kpa, i) is not None:
            bits.append(f"{_g(kpa[i], 0)} kPa ({_g(psi_of(kpa[i]))} psi)")
        return " · ".join(bits)

    def add(level, group, text, i=None):
        r.findings.append(Finding(level, group, text, where(i) if i is not None else ""))

    boost = [k is not None and k > BOOST_EDGE_KPA for k in kpa]
    in_boost = [i for i, b in enumerate(boost) if b]
    wot = [i for i in range(log.rows) if (_at(tps, i) or 0) > 70 or (_at(kpa, i) or 0) >= 95]
    peak_i = max(in_boost, key=lambda i: kpa[i], default=None)

    # ---- fuel
    if lam is not None and lam_t is not None:
        lean = [i for i in in_boost if _at(lam, i) is not None and _at(lam_t, i) is not None
                and (_at(rpm, i) or 0) > 2500 and lam[i] > lam_t[i] + 0.04]
        if lean:
            i = max(lean, key=lambda k: lam[k] - lam_t[k])
            add("error", "Fuel", f"Lean in boost: λ {lam[i]:.2f} against a target of λ {lam_t[i]:.2f} "
                                 f"({len(lean)} samples). Add fuel before the next pull.", i)
        elif in_boost:
            add("ok", "Fuel", "The wideband matched the AFR target in boost.")
        rich = [i for i in in_boost if _at(lam, i) is not None and lam[i] < 0.68]
        if rich:
            i = min(rich, key=lambda k: lam[k])
            add("warn", "Fuel", f"Very rich in boost: λ {lam[i]:.2f}. That's safe for the engine but costs power "
                                "and fouls plugs.", i)
        wot_lean = [i for i in wot if _at(lam, i) is not None and (_at(rpm, i) or 0) > 2500 and lam[i] > 0.95
                    and not boost[i]]
        if wot_lean:
            i = max(wot_lean, key=lambda k: lam[k])
            add("warn", "Fuel", f"Lean at full throttle: λ {lam[i]:.2f}. Full load usually wants λ 0.85–0.90.", i)
    if lam is not None:
        nums = [v for v in lam if v is not None]
        if nums and max(nums) - min(nums) < 0.02:
            add("warn", "Sensors", f"The wideband barely moved all log (λ {min(nums):.2f}–{max(nums):.2f}). "
                                   "Check the sensor is working and warmed up.")
    if "ego_corr" in ch:
        nums = [v for v in ch["ego_corr"].nums]
        worst = max(nums, key=lambda v: abs(v - 100 if max(nums) > 50 else v), default=None)
        if worst is not None:
            off = abs(worst - 100) if max(nums) > 50 else abs(worst)
            if off > 10:
                add("warn", "Fuel", f"Closed-loop fuel is working hard ({_g(off)}% correction). The VE table needs "
                                    "attention rather than the correction covering for it.")

    # ---- knock
    if "knock" in ch:
        events = [i for i, v in enumerate(ch["knock"].values) if v is not None and v > 0]
        if events:
            i = max(events, key=lambda k: ch["knock"].values[k])
            worst = ch["knock"].values[i]
            level = "error" if any(boost[k] for k in events) else "warn"
            add(level, "Knock", f"Knock detected: {len(events)} samples, worst {_g(worst)} "
                                f"{ch['knock'].units or 'counts'}. Pull timing where it happened before the next "
                                "pull.", i)
        else:
            add("ok", "Knock", "No knock in this log.")

    # ---- boost
    if peak_i is not None:
        peak = kpa[peak_i]
        if map_max and peak >= map_max * 0.98:
            add("error", "Boost", f"MAP reached {_g(peak, 0)} kPa, at the top of what the sensor reads "
                                  f"({_g(map_max, 0)} kPa). Readings above that are clipped, so the real boost "
                                  "may be higher.", peak_i)
        if cut_kpa and peak >= cut_kpa:
            add("error", "Boost", f"Boost hit the cut ({_g(cut_kpa, 0)} kPa): peak was {_g(peak, 0)} kPa "
                                  f"({_g(psi_of(peak))} psi).", peak_i)
        target_kpa = None
        if "boost_target" in ch:
            target_kpa, _ = _to_kpa(ch["boost_target"])
        if target_kpa is not None:
            over = [i for i in in_boost if _at(target_kpa, i) and target_kpa[i] > BOOST_EDGE_KPA
                    and kpa[i] > target_kpa[i] + 1.5 * PSI_KPA]
            if over:
                i = max(over, key=lambda k: kpa[k] - target_kpa[k])
                add("error", "Boost", f"Boost overshot its target by {_g((kpa[i] - target_kpa[i]) / PSI_KPA)} psi "
                                      f"({_g(kpa[i], 0)} against {_g(target_kpa[i], 0)} kPa). Check the wastegate "
                                      "and its plumbing before more pulls.", i)
            short = [i for i in in_boost if _at(target_kpa, i) and target_kpa[i] > BOOST_EDGE_KPA
                     and kpa[i] < target_kpa[i] - 2 * PSI_KPA and (_at(rpm, i) or 0) > 3500]
            if short and not over:
                i = min(short, key=lambda k: kpa[k] - target_kpa[k])
                maxed = "duty" in ch and (_at(ch["duty"].values, i) or 0) > 90
                add("warn", "Boost", f"Boost fell {_g((target_kpa[i] - kpa[i]) / PSI_KPA)} psi short of target"
                                     + (" with the solenoid at full duty" if maxed else "")
                                     + ". Raise max duty a little, or check for a boost leak.", i)
        add("info", "Boost", f"Peak boost was {_g(psi_of(peak))} psi ({_g(peak, 0)} kPa).", peak_i)
    elif kpa and any(k is not None for k in kpa):
        add("info", "Boost", "There's no boost in this log: MAP never went above atmospheric.")

    # ---- timing
    spark_view = _view(views, "spark")
    if "advance" in ch and spark_view is not None and in_boost:
        xb, yb = list(spark_view.x.values), list(spark_view.y.values)
        over = []
        for i in in_boost:
            want = _table_lookup(spark_view.z, xb, yb, _at(rpm, i) or 0, kpa[i])
            got = _at(ch["advance"].values, i)
            if want is not None and got is not None and got > want + 2.5:
                over.append((got - want, i, got, want))
        if over:
            d, i, got, want = max(over)
            add("warn", "Ignition", f"The ECU ran {_g(got)}° in boost where {spark_view.label} asks for "
                                    f"{_g(want)}°. Something is adding timing: check your corrections.", i)

    # ---- engine health
    for role, group, hi, err, text in (
            ("clt", "Temperature", 100.0, 107.0, "Coolant reached {v} °C"),
            ("iat", "Temperature", 60.0, 80.0, "Intake air reached {v} °C"),
            ("egt", "Temperature", 900.0, 950.0, "Exhaust gas temperature reached {v} °C")):
        if role not in ch:
            continue
        vals = (clt if role == "clt" else iat if role == "iat" else list(ch[role].values))
        i = max(range(log.rows), key=lambda k: (_at(vals, k) is not None, _at(vals, k) or -1e9))
        v = _at(vals, i)
        if v is None:
            continue
        if v >= err:
            add("error", group, text.format(v=_g(v)) + ". Stop and let it cool; that's damaging.", i)
        elif v >= hi:
            add("warn", group, text.format(v=_g(v)) + ". Watch it on the next pull.", i)
        elif role == "clt" and v > 60:
            add("ok", group, f"Coolant stayed at {_g(v)} °C.")
    warm = [i for i in wot if _at(clt, i) is not None and clt[i] < 65]
    if warm:
        add("warn", "Temperature", f"Full throttle at {_g(clt[warm[0]])} °C coolant: let the engine warm up "
                                   "fully before pulls.", warm[0])
    if inj is not None:
        i = max(range(log.rows), key=lambda k: (_at(inj, k) is not None, _at(inj, k) or -1e9))
        v = _at(inj, i)
        if v is not None:
            if v >= 90:
                add("error", "Fuel", f"Injectors reached {_g(v)}% duty. Over about 90% they can't add fuel, so "
                                     "the engine leans out. Fit larger injectors before more boost.", i)
            elif v >= 85:
                add("warn", "Fuel", f"Injectors reached {_g(v)}% duty: there's little headroom left.", i)
            elif v > 0:
                add("ok", "Fuel", f"Injectors peaked at {_g(v)}% duty.")
    if "batt" in ch:
        nums = ch["batt"].nums
        running = [v for v in nums if v > 5]
        if running and min(running) < 11.5:
            i = min(range(log.rows), key=lambda k: _at(ch["batt"].values, k) if _at(ch["batt"].values, k) and
                    ch["batt"].values[k] > 5 else 1e9)
            add("warn", "Electrical", f"Battery voltage dropped to {_g(min(running))} V. Low voltage makes "
                                      "injectors slower than the tune expects.", i)
    if "fuel_press" in ch and in_boost:
        fp = ch["fuel_press"]
        cruise = [v for i, v in enumerate(fp.values) if v is not None and not boost[i] and (_at(rpm, i) or 0) > 1000]
        boosted = [(v, i) for i, v in enumerate(fp.values) if v is not None and boost[i]]
        if cruise and boosted:
            base = sum(cruise) / len(cruise)
            low, i = min(boosted)
            if base > 0 and low < base * 0.9:
                add("error", "Fuel", f"Fuel pressure fell from about {_g(base)} to {_g(low)} "
                                     f"{fp.units or ''} in boost. The pump or filter can't keep up.".replace("  ", " "), i)
    if rev and any(v is not None and v >= rev - 50 for v in rpm):
        i = max(range(log.rows), key=lambda k: _at(rpm, k) or -1)
        add("info", "Limits", f"The rev limit was reached ({_g(rpm[i], 0)} rpm against a limit of {_g(rev, 0)}).", i)

    # ---- readouts, pulls and charts
    r.stats = _stats(log, ch, t, rpm, kpa, lam, clt, iat, inj, in_boost)
    r.pulls = _pulls(t, rpm, kpa, tps, lam, lam_t, ch.get("advance"), ch.get("knock"))
    r.charts = _charts(t, rpm, kpa, lam, lam_t, ch)
    r.ve = _ve_suggestion(doc, views, t, rpm, kpa, lam, lam_t, clt, tps, inj, ch)
    r.timing = _knock_suggestion(doc, views, rpm, kpa, ch)
    if r.ve:
        add("info", "Fuel", r.ve["text"])
    if r.timing:
        add("warn", "Ignition", r.timing["text"])
    order = {"error": 0, "warn": 1, "info": 2, "ok": 3}
    r.findings.sort(key=lambda f: order[f.level])
    return r


def _stats(log, ch, t, rpm, kpa, lam, clt, iat, inj, in_boost) -> list[dict]:
    def stat(label, value, units=""):
        return {"label": label, "value": value, "units": units}

    out = [stat("Length", _g(t[-1] - t[0]) if len(t) > 1 else "0", "s"), stat("Samples", f"{log.rows:,}")]
    nums = [v for v in rpm if v is not None]
    if nums:
        out.append(stat("Peak RPM", _g(max(nums), 0)))
    boosted = [kpa[i] for i in in_boost]
    if boosted:
        out.append(stat("Peak boost", _g(psi_of(max(boosted))), "psi"))
        out.append(stat("Time in boost", _g(len(in_boost) * (t[-1] - t[0]) / max(1, log.rows)), "s"))
    if lam is not None:
        in_b = [lam[i] for i in in_boost if lam[i] is not None]
        if in_b:
            out.append(stat("Leanest in boost", f"{max(in_b):.2f}", "λ"))
    for label, vals, units in (("Max coolant", clt, "°C"), ("Max intake air", iat, "°C"),
                               ("Max injector duty", inj, "%")):
        nums = [v for v in (vals or []) if v is not None]
        if nums:
            out.append(stat(label, _g(max(nums)), units))
    return out


def _pulls(t, rpm, kpa, tps, lam, lam_t, advance, knock) -> list[Pull]:
    """Full-throttle runs, so the report can talk about "the third pull" rather than a sample number."""
    flags = [((_at(tps, i) or 0) > 70 or (_at(kpa, i) or 0) > BOOST_EDGE_KPA) and (_at(rpm, i) or 0) > 1500
             for i in range(len(t))]
    out = []
    for a, b in _runs(flags, t, 0.8):
        window = range(a, b + 1)
        peak = max((_at(kpa, i) or 0) for i in window)
        lams = [lam[i] for i in window if lam and _at(lam, i) is not None]
        lean = bool(lam and lam_t and any(_at(lam, i) is not None and _at(lam_t, i) is not None
                                          and lam[i] > lam_t[i] + 0.04 and (_at(kpa, i) or 0) > BOOST_EDGE_KPA
                                          for i in window))
        advs = [v for v in ((_at(advance.values, i) if advance else None) for i in window) if v is not None]
        knocks = any((_at(knock.values, i) or 0) > 0 for i in window) if knock else False
        out.append(Pull(round(t[a], 1), round(t[b], 1), round(t[b] - t[a], 1), round(psi_of(peak), 1),
                        round(peak, 1), round(_at(rpm, a) or 0), round(max((_at(rpm, i) or 0) for i in window)),
                        round(max(lams), 2) if lams else None, round(max(advs), 1) if advs else None, knocks, lean))
    return out[:12]


def _charts(t, rpm, kpa, lam, lam_t, ch) -> list[dict]:
    """Downsampled traces, each normalised to its own range, with its range in the legend."""
    n = len(t)
    if n < 2:
        return []
    stride = max(1, n // CHART_POINTS)
    xs = list(range(0, n, stride))
    span = (t[-1] - t[0]) or 1.0

    def trace(values, label, cls, mode="max", units=""):
        if values is None or not any(v is not None for v in values):
            return None
        pts, lo, hi = [], None, None
        for k in xs:
            bucket = [v for v in values[k:k + stride] if v is not None]
            if not bucket:
                continue
            v = max(bucket) if mode == "max" else min(bucket) if mode == "min" else sum(bucket) / len(bucket)
            pts.append((t[k], v))
            lo = v if lo is None else min(lo, v)
            hi = v if hi is None else max(hi, v)
        if len(pts) < 2 or lo is None:
            return None
        rng = (hi - lo) or 1.0
        coords = " ".join(f"{(x - t[0]) / span * 100:.2f},{100 - (y - lo) / rng * 92 - 4:.2f}" for x, y in pts)
        return {"label": label, "cls": cls, "points": coords, "lo": _g(lo), "hi": _g(hi), "units": units}

    charts = []
    engine = [x for x in (trace(rpm, "RPM", "c1", units="rpm"), trace(kpa, "MAP", "c2", units="kPa")) if x]
    if engine:
        charts.append({"title": "Engine speed and manifold pressure", "series": engine})
    fuel = [x for x in (trace(lam, "Wideband λ", "c3", mode="max"),
                        trace(lam_t, "Target λ", "c4", mode="mean")) if x]
    if fuel:
        charts.append({"title": "Mixture against target (higher is leaner)", "series": fuel})
    spark = [x for x in (trace(ch["advance"].values if "advance" in ch else None, "Advance", "c1", units="°"),
                         trace(ch["knock"].values if "knock" in ch else None, "Knock", "c5"),
                         trace(ch["duty"].values if "duty" in ch else None, "Boost duty", "c2", units="%")) if x]
    if spark:
        charts.append({"title": "Ignition and boost control", "series": spark})
    return charts


# ------------------------------------------------------------------ what to change

# The wideband sees exhaust from a little while ago, so samples are matched to the RPM and load from just before.
SENSOR_LAG_S = 0.35
MIN_SAMPLES = 8
MIN_SAMPLES_BOOST = 12
MAX_CHANGE = 0.15        # the most a cell may move in one pass
MAX_CUT_IN_BOOST = 0.05  # taking fuel out of a boost cell needs more proof, so it moves less
KNOCK_PULL = 2.0         # degrees out of a cell that knocked
MAX_KNOCK_PULL = 6.0


def _rate(values, t, i, window=0.3):
    """How fast a channel is moving around sample i, per second."""
    j = i
    while j > 0 and t[i] - t[j] < window:
        j -= 1
    a, b = _at(values, j), _at(values, i)
    dt = t[i] - t[j]
    return abs(b - a) / dt if a is not None and b is not None and dt > 0 else 0.0


def _ve_suggestion(doc: TuneDoc, views, t, rpm, kpa, lam, lam_t, clt, tps, inj, ch) -> dict | None:
    """VE cells worked out from the wideband: where it ran leaner than target, the cell needs more fuel."""
    ve = _view(views, "ve")
    if ve is None or lam is None or lam_t is None:
        return None
    xb, yb = list(ve.x.values), list(ve.y.values)
    if not all(isinstance(v, float) for v in xb + yb):
        return None
    dt = (t[-1] - t[0]) / max(1, len(t) - 1)
    lag = max(0, round(SENSOR_LAG_S / dt)) if dt > 0 else 0
    accel = ch["accel"].values if "accel" in ch else None
    totals: dict[int, list] = {}
    for i in range(len(t) - lag):
        j = i + lag  # the mixture that resulted from sample i
        a, want = _at(lam, j), _at(lam_t, j)
        n, k = _at(rpm, i), _at(kpa, i)
        if a is None or want is None or n is None or k is None or not (0.5 < a < 1.6) or not (0.5 < want < 1.6):
            continue
        if _at(clt, i) is not None and clt[i] < 70:
            continue
        if _at(inj, i) is not None and inj[i] > 95:
            continue  # the injectors are maxed out; VE can't fix that
        if accel is not None and (_at(accel, i) or 0) > 1:
            continue  # accel enrichment is in the mixture, not the table
        if _rate(tps, t, i) > 30 or _rate(rpm, t, i) > 3000:
            continue  # only settled samples
        col, row = _cell(xb, n), _cell(yb, k)
        if col is None or row is None:
            continue
        totals.setdefault(row * ve.z.cols + col, []).append(a / want)

    z = ve.z
    digits = z.digits if z.digits is not None and 0 <= z.digits <= 6 else 1
    step = 0.5 * 10 ** -digits
    changes, bounds, cells = {}, {}, []
    for idx, ratios in sorted(totals.items()):
        row, col = divmod(idx, z.cols)
        boosted = yb[row] > BOOST_EDGE_KPA
        if len(ratios) < (MIN_SAMPLES_BOOST if boosted else MIN_SAMPLES):
            continue
        old = z.values[idx]
        if not isinstance(old, float) or old <= 0:
            continue
        ratio = sum(ratios) / len(ratios)
        down = MAX_CUT_IN_BOOST if boosted else MAX_CHANGE
        ratio = max(1 - down, min(1 + MAX_CHANGE, ratio))
        scale = 10 ** digits
        # Round to the table's own precision, then pull back inside the clamp: rounding must never take a cell
        # past the limit the report promises.
        new = min(math.floor(old * (1 + MAX_CHANGE) * scale) / scale,
                  max(math.ceil(old * (1 - down) * scale) / scale, round(old * ratio, digits)))
        if abs(new - old) < step:
            continue
        changes[str(idx)] = new
        bounds[str(idx)] = [round(old * (1 - down) - step, 6), round(old * (1 + MAX_CHANGE) + step, 6)]
        cells.append({"i": idx, "row": row, "col": col, "rpm": _g(xb[col], 0), "kpa": _g(yb[row], 0),
                      "old": _g(old, 2), "new": _g(new, 2), "pct": round((new / old - 1) * 100, 1),
                      "samples": len(ratios), "boost": boosted})
    if not changes:
        return None
    pcts = [c["pct"] for c in cells]
    biggest = max(cells, key=lambda c: abs(c["pct"]))
    return {
        "kind": "ve", "name": z.name, "label": ve.label, "rows": z.rows, "cols": z.cols,
        "changes": changes, "bounds": bounds, "cells": cells,
        "count": len(cells), "avg": round(sum(abs(p) for p in pcts) / len(pcts), 1),
        "up": sum(1 for p in pcts if p > 0), "down": sum(1 for p in pcts if p < 0),
        "text": (f"{len(cells)} VE cells can be corrected from the wideband: {sum(1 for p in pcts if p > 0)} up, "
                 f"{sum(1 for p in pcts if p < 0)} down, {round(sum(abs(p) for p in pcts) / len(pcts), 1)}% on "
                 f"average, biggest {biggest['pct']:+.1f}% at {biggest['rpm']} rpm / {biggest['kpa']} kPa."),
    }


def _knock_suggestion(doc: TuneDoc, views, rpm, kpa, ch) -> dict | None:
    """Timing out of the cells where the ECU saw knock."""
    spark = _view(views, "spark")
    if spark is None or "knock" not in ch:
        return None
    xb, yb = list(spark.x.values), list(spark.y.values)
    if not all(isinstance(v, float) for v in xb + yb):
        return None
    worst: dict[int, float] = {}
    for i, v in enumerate(ch["knock"].values):
        if v is None or v <= 0:
            continue
        col, row = _cell(xb, _at(rpm, i) or 0), _cell(kpa, i) is not None and _cell(yb, kpa[i])
        if col is None or row is None or row is False:
            continue
        idx = row * spark.z.cols + col
        worst[idx] = max(worst.get(idx, 0.0), float(v))
    z = spark.z
    digits = z.digits if z.digits is not None and 0 <= z.digits <= 6 else 1
    changes, bounds, cells = {}, {}, []
    for idx, retard in sorted(worst.items()):
        old = z.values[idx]
        if not isinstance(old, float):
            continue
        pull = min(max(KNOCK_PULL, retard), MAX_KNOCK_PULL)
        new = round(old - pull, digits)
        changes[str(idx)] = new
        bounds[str(idx)] = [round(old - MAX_KNOCK_PULL - 0.01, 6), round(old, 6)]
        row, col = divmod(idx, z.cols)
        cells.append({"i": idx, "row": row, "col": col, "rpm": _g(xb[col], 0), "kpa": _g(yb[row], 0),
                      "old": _g(old, 2), "new": _g(new, 2), "pct": round(new - old, 1), "samples": 1,
                      "boost": yb[row] > BOOST_EDGE_KPA})
    if not changes:
        return None
    return {"kind": "timing", "name": z.name, "label": spark.label, "rows": z.rows, "cols": z.cols,
            "changes": changes, "bounds": bounds, "cells": cells, "count": len(cells),
            "avg": 0.0, "up": 0, "down": len(cells),
            "text": (f"Timing can come out of the {len(cells)} cell{'s' if len(cells) != 1 else ''} where the ECU "
                     f"saw knock (at least {KNOCK_PULL:g}° each). Knock is the one thing that ends an engine "
                     "quickly: fix it before another pull.")}


def apply_suggestion(raw: bytes, doc: TuneDoc, tmap: dict, sug: dict) -> tuple[bytes, int]:
    """Write a suggestion into a copy of the .msq, then check what came out. Raises LogError."""
    from . import checks as checksmod
    from .edit import EditError, apply_changes
    from .parser import MsqError, parse_msq
    from .tablemaps import all_tables

    if not isinstance(sug, dict) or not sug.get("changes"):
        raise LogError("There's nothing to apply.")
    changes = {sug["name"]: {k: float(v) for k, v in sug["changes"].items()}}
    try:
        new_raw, n = apply_changes(raw, changes)
        new_doc = parse_msq(new_raw)
    except (EditError, MsqError) as e:
        raise LogError(str(e)) from None
    z = new_doc.get(sug["name"])
    if z is None or len(z.values) != sug["rows"] * sug["cols"]:
        raise LogError("Those corrections don't fit this tune's table.")
    for key, (lo, hi) in sug.get("bounds", {}).items():
        v = z.values[int(key)]
        if not isinstance(v, float) or not lo - 1e-6 <= v <= hi + 1e-6:
            raise LogError("Those corrections were refused: a cell moved further than a single pass allows.")
    featured, other = all_tables(new_doc, tmap)
    errors = [r["text"] for r in checksmod.run(new_doc, featured + other) if r["status"] == "error"]
    if errors:
        raise LogError("Those corrections were refused: Tune Health found a problem with the result: " + errors[0])
    return new_raw, n


def to_dict(r: Report) -> dict:
    """The report as plain data, so it can be stored with the log and rendered without re-reading it."""
    d = asdict(r)
    d["summary"] = r.summary
    return d
