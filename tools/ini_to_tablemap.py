#!/usr/bin/env python3
"""Generate a tablemap JSON from a TunerStudio .ini.

    python tools/ini_to_tablemap.py path/to/firmware.ini --family FOME > tablemaps/FOME.json

Reads:
  [MegaTune]/[TunerStudio]   signature
  [Constants]/[PcVariables]  units + digits for every constant
  [TableEditor(s)]           each table's z constant, x/y bins, title, axis labels
  [CurveEditor(s)]           1D curves (x bins + y values)

The primary VE / ignition / target-AFR(lambda) tables become featured tabs;
every other table editor is emitted with "featured": false so the viewer can
label it under "Other tables". Standard library only.

Preprocessor: by default every `#if NAME` takes its first branch. Pass
`--else NAME` to take the #else branch for NAME instead (e.g. `--else LAMBDA`
to get AFR units/titles on rusEFI inis).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

FAMILY_PATTERNS = {
    "FOME": ["fome"],
    "rusEFI": ["rusefi"],
    "Speeduino": ["speeduino"],
    "MS3": ["ms3"],
    "MS2": ["ms2", "msii"],
    "MS1": ["ms1", "msns"],
}

FEATURE_RULES = [
    # id, palette, preferred z names, title regex fallback
    ("ve", "ve", ["veTable1", "veTable", "veBins1"], r"\bVE\b"),
    ("spark", "spark", ["ignitionTable", "advanceTable1", "advTable1"], r"ignition|spark|advance|timing"),
    ("afr", "afr", ["lambdaTable", "afrTable1", "afrTable"], r"target.*(lambda|afr)|(lambda|afr).*target"),
]

SUMMARY_CANDIDATES = [
    ("Req fuel", ["reqFuel"]),
    ("Injector flow", ["injector_flow"]),
    ("Cylinders", ["nCylinders", "cylindersCount", "nCylinders1"]),
    ("Displacement", ["displacement"]),
    ("Inj open", ["injOpen1", "injOpen"]),
    ("Fuel algorithm", ["algorithm", "fuelAlgorithm", "algorithm1"]),
    ("Rev limit", ["rpmHardLimit", "RevLimNormal2", "HardRevLim", "rpmhardlimit"]),
    ("Injection mode", ["injectionMode"]),
    ("Ignition mode", ["ignitionMode"]),
    ("Squirts/cycle", ["divider"]),
    ("Stroke", ["twoStroke"]),
    ("Engine type", ["engineType"]),
    ("Boost cut", ["boostCutPressure", "OverBoostKpa", "boostCut"]),
]


def split_args(s: str) -> list[str]:
    """Split on commas that aren't inside quotes, braces or brackets."""
    out, buf, depth, quote = [], [], 0, False
    for ch in s:
        if ch == '"':
            quote = not quote
        elif not quote and ch in "{[":
            depth += 1
        elif not quote and ch in "}]":
            depth = max(0, depth - 1)
        if ch == "," and not quote and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    out.append("".join(buf).strip())
    return out


def strip_comment(line: str) -> str:
    quote = False
    for i, ch in enumerate(line):
        if ch == '"':
            quote = not quote
        elif ch == ";" and not quote:
            return line[:i]
    return line


def unquote(s: str | None) -> str | None:
    if s is None:
        return None
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] == '"':
        return s[1:-1]
    return None  # expressions like {bitStringValue(...)} aren't static text


def to_int(s: str | None) -> int | None:
    try:
        return int(float(s))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def iter_lines(text: str, else_names: set[str]):
    """Yield (section, line) with #if/#else/#endif resolved."""
    section = ""
    stack: list[bool] = []  # active flags
    defined: set[str] = set()
    for raw in text.splitlines():
        line = strip_comment(raw).strip()
        if not line:
            continue
        active = all(stack)
        if line.startswith("#"):
            parts = line[1:].split()
            directive = parts[0].lower() if parts else ""
            name = parts[1] if len(parts) > 1 else ""
            if directive == "if":
                cond = name not in else_names or name in defined
                stack.append(cond)
            elif directive == "else" and stack:
                stack[-1] = not stack[-1]
            elif directive == "endif" and stack:
                stack.pop()
            elif directive == "set" and active:
                defined.add(name)
                else_names.discard(name)
            elif directive == "unset" and active:
                else_names.add(name)
            continue
        if not active:
            continue
        m = re.match(r"^\[([^\]]+)\]$", line)
        if m:
            section = m.group(1).strip()
            continue
        yield section, line


def parse_ini(text: str, else_names: set[str] | None = None) -> dict:
    else_names = set(else_names or ())
    ini = {"signature": None, "constants": {}, "tables": [], "curves": []}
    cur_table = cur_curve = None
    for section, line in iter_lines(text, else_names):
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip()
        sec = section.lower()
        if sec in ("megatune", "tunerstudio") and key == "signature" and ini["signature"] is None:
            ini["signature"] = unquote(split_args(val)[0])
        elif sec in ("constants", "pcvariables"):
            args = split_args(val)
            kind = args[0].lower() if args else ""
            if key in ini["constants"] or kind not in ("scalar", "array", "bits", "string"):
                continue
            meta = {"kind": kind}
            if kind == "scalar" and len(args) >= 4:
                meta["units"] = unquote(args[3])
                meta["digits"] = to_int(args[8]) if len(args) > 8 else None
            elif kind == "array" and len(args) >= 5:
                shape = args[3].strip("[] ")
                dims = [to_int(d) for d in shape.lower().split("x")]
                meta["shape"] = [d for d in dims if d is not None]
                meta["units"] = unquote(args[4])
                meta["digits"] = to_int(args[9]) if len(args) > 9 else None
            ini["constants"][key] = meta
        elif sec in ("tableeditor", "tableeditors"):
            if key == "table":
                args = split_args(val)
                cur_table = {"id": args[0], "title": unquote(args[2]) if len(args) > 2 else None}
                ini["tables"].append(cur_table)
            elif cur_table is not None:
                args = split_args(val)
                if key in ("xBins", "yBins", "zBins") and args and key not in cur_table:
                    cur_table[key] = args[0]
                elif key == "xyLabels":
                    cur_table["xyLabels"] = [unquote(a) for a in args]
        elif sec in ("curveeditor", "curveeditors"):
            if key == "curve":
                args = split_args(val)
                cur_curve = {"id": args[0], "title": unquote(args[1]) if len(args) > 1 else None}
                ini["curves"].append(cur_curve)
            elif cur_curve is not None:
                args = split_args(val)
                if key in ("xBins", "yBins") and args and key not in cur_curve:
                    cur_curve[key] = args[0]
                elif key == "columnLabel":
                    cur_curve["columnLabel"] = [unquote(a) for a in args]
    return ini


def _clean_label(s: str | None) -> str:
    return (s or "").strip().rstrip(":").strip()


def _is_2d(meta: dict | None) -> bool:
    shape = (meta or {}).get("shape") or []
    return len(shape) == 2 and all(d > 1 for d in shape)


def _palette_for(title: str) -> str:
    t = title.lower()
    if re.search(r"\bve\b", t):
        return "ve"
    if re.search(r"ignition|spark|advance|timing", t):
        return "spark"
    if re.search(r"lambda|afr", t):
        return "afr"
    return "default"


def build_tablemap(ini: dict, family: str, name: str | None = None, include_signature: bool = True,
                   source: str | None = None) -> dict:
    consts = ini["constants"]
    tables = [t for t in ini["tables"] if t.get("zBins")]

    def units(n):
        return (consts.get(n) or {}).get("units")

    def entry(t: dict, tid: str, palette: str, featured: bool) -> dict:
        labels = t.get("xyLabels") or [None, None]
        labels += [None] * (2 - len(labels))
        title = t.get("title") or t["zBins"]
        e = {
            "id": tid,
            "label": title,
            "z": t["zBins"],
            "x": t.get("xBins"),
            "y": t.get("yBins"),
            "x_label": _clean_label(labels[0]) or (units(t.get("xBins")) or ""),
            "y_label": _clean_label(labels[1]) or (units(t.get("yBins")) or ""),
            "units": units(t["zBins"]) or "",
            "palette": palette,
        }
        if not featured:
            e["featured"] = False
        return e

    featured, used = [], set()
    for fid, palette, preferred, title_re in FEATURE_RULES:
        pick = None
        for zname in preferred:
            pick = next((t for t in tables if t["zBins"] == zname and t["id"] not in used), None)
            if pick:
                break
        if pick is None:
            pick = next((t for t in tables if t["id"] not in used and _is_2d(consts.get(t["zBins"]))
                         and re.search(title_re, t.get("title") or "", re.I)), None)
        if pick:
            used.add(pick["id"])
            featured.append(entry(pick, fid, palette, True))

    others = []
    seen_z = {e["z"] for e in featured}
    for t in tables:
        if t["id"] in used or t["zBins"] in seen_z:
            continue
        seen_z.add(t["zBins"])
        tid = re.sub(r"[^A-Za-z0-9_-]", "", t["id"]) or t["zBins"]
        others.append(entry(t, tid, _palette_for(t.get("title") or ""), False))

    curves = []
    for c in ini["curves"]:
        if not c.get("yBins"):
            continue
        labels = (c.get("columnLabel") or []) + [None, None]
        curves.append({
            "id": re.sub(r"[^A-Za-z0-9_-]", "", c["id"]) or c["yBins"],
            "label": c.get("title") or c["yBins"],
            "x": c.get("xBins"),
            "y": c["yBins"],
            "x_label": _clean_label(labels[0]) or (units(c.get("xBins")) or ""),
            "y_label": _clean_label(labels[1]) or (units(c["yBins"]) or ""),
        })

    summary = []
    for label, names in SUMMARY_CANDIDATES:
        if family in ("rusEFI", "FOME") and label == "Engine type":
            continue  # a preset enum there, not an engine description
        present = [n for n in names if n in consts]
        if present:
            summary.append({"name": present[0], "label": label})

    referenced = set()
    for e in featured + others:
        referenced.update(v for v in (e["z"], e["x"], e["y"]) if v)
    for c in curves:
        referenced.update(v for v in (c["x"], c["y"]) if v)
    referenced.update(s["name"] for s in summary)
    constant_meta = {}
    for n in sorted(referenced):
        m = consts.get(n) or {}
        info = {k: m[k] for k in ("units", "digits") if m.get(k) not in (None, "")}
        if info:
            constant_meta[n] = info

    out = {
        "family": family,
        "name": name or family,
        "generated_by": "tools/ini_to_tablemap.py",
    }
    if source:
        out["source_ini"] = source
    out["signatures"] = [ini["signature"]] if include_signature and ini.get("signature") else []
    out["signature_patterns"] = FAMILY_PATTERNS.get(family, [])
    out["tables"] = featured + others
    out["curves"] = curves
    out["summary_fields"] = summary
    out["constant_meta"] = constant_meta
    return out


def validate_tablemap(m: dict) -> list[str]:
    """Return a list of problems; empty means the map is usable by the viewer."""
    errs = []
    if not isinstance(m.get("family"), str) or not m["family"]:
        errs.append("family must be a non-empty string")
    if not isinstance(m.get("tables"), list):
        errs.append("tables must be a list")
    else:
        ids = set()
        for i, t in enumerate(m["tables"]):
            if not isinstance(t, dict) or not t.get("z"):
                errs.append(f"tables[{i}] needs a z constant")
                continue
            if t.get("id") in ids:
                errs.append(f"duplicate table id {t.get('id')!r}")
            ids.add(t.get("id"))
    if not isinstance(m.get("summary_fields", []), list):
        errs.append("summary_fields must be a list")
    for pat in m.get("signature_patterns", []):
        try:
            re.compile(pat)
        except re.error:
            errs.append(f"bad signature_pattern {pat!r}")
    return errs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ini", type=Path)
    ap.add_argument("--family", required=True, help="MS3, MS2, MS1, Speeduino, rusEFI, FOME, or a new name")
    ap.add_argument("--name", help="display name (defaults to family)")
    ap.add_argument("--else", dest="else_names", action="append", default=[],
                    help="take the #else branch for this #if NAME (repeatable)")
    ap.add_argument("--no-signature", action="store_true",
                    help="don't pin the ini's exact signature (use for maps meant for a whole family)")
    ap.add_argument("-o", "--output", type=Path, help="write here instead of stdout")
    args = ap.parse_args(argv)

    text = args.ini.read_text("latin-1")
    ini = parse_ini(text, set(args.else_names))
    tmap = build_tablemap(ini, args.family, args.name, include_signature=not args.no_signature,
                          source=args.ini.name)
    problems = validate_tablemap(tmap)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    payload = json.dumps(tmap, indent=2) + "\n"
    if args.output:
        args.output.write_text(payload, "utf-8")
        print(f"wrote {args.output} ({len(tmap['tables'])} tables, {len(tmap['curves'])} curves)", file=sys.stderr)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
