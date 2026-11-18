#!/usr/bin/env python3
"""Tap into MegaSqwerty from a terminal: diagnose a log or a live session, list its channels, pull exact
numbers for any stretch, watch a live session, and see what changed.

    python tools/msq.py diagnose  <log or live link>            what the log doctor finds, worst first
    python tools/msq.py channels  <log link>                    channels and the roles they play
    python tools/msq.py slice     <log link> -c rpm,map,lambda -s 2110-2120 [-e 5]   the numbers, as a table
    python tools/msq.py around    <log link> -t 2524.05 [-w 3] [-c ...]             the seconds around a moment
    python tools/msq.py live      <live link>                   session state, live values now, recent changes
    python tools/msq.py tune      <log or tune link>            the tune's main tables

Links are the ones the app shows: https://…/l/<log>?tune=<tune>, https://…/live/<session>?k=<key>,
https://…/t/<tune>. Only reads; it never changes anything. Python 3 standard library only."""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "msq-tools/1.0"}


def get(url: str):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
        return json.loads(r.read().decode())


def parse(link: str):
    u = urllib.parse.urlparse(link)
    base = f"{u.scheme}://{u.netloc}"
    q = urllib.parse.parse_qs(u.query)
    parts = [p for p in u.path.split("/") if p]
    if len(parts) >= 2 and parts[0] == "l":
        return "log", base, parts[1], (q.get("tune") or [""])[0]
    if len(parts) >= 2 and parts[0] == "live":
        return "live", base, parts[1], (q.get("k") or [""])[0]
    if len(parts) >= 2 and parts[0] == "t":
        return "tune", base, parts[1], ""
    sys.exit(f"Not a MegaSqwerty log, live or tune link: {link}")


def clock(s: float) -> str:
    m, r = divmod(max(0.0, s), 60)
    return f"{int(m)}:{r:04.1f}"


def cmd_diagnose(a):
    kind, base, slug, extra = parse(a.link)
    if kind == "log":
        j = get(f"{base}/l/{slug}/diagnose.json" + (f"?tune={extra}" if extra else ""))
    elif kind == "live":
        j = get(f"{base}/live/{slug}/diagnose.json?k={urllib.parse.quote(extra)}")
    else:
        sys.exit("diagnose needs a log or live link")
    print(f"{j.get('name', slug)}: {j['rows']:,} records, {j['seconds'] / 60:.1f} min, engine running {j.get('running_s', 0) / 60:.1f} min")
    for f in j["findings"]:
        print(f"\n[{f['sev'].upper():4}] {f['title']}  (x{f['count']})\n  {f['detail']}\n  check: {f['fix']}")
        for e in f["events"][: a.n]:
            at = e.get("at", {})
            bits = [f"{k}={v}" for k, v in at.items() if k != "t"] + [f"{k}={e[k]}" for k in ("worst", "trim", "retard", "avg", "spread") if k in e]
            print(f"    {clock(e['t0']):>8}  ({e['t0']:.2f}-{e['t1']:.2f} s)  " + "  ".join(bits))
    print("\nstats:", json.dumps(j.get("stats", {})))


def cmd_channels(a):
    kind, base, slug, _ = parse(a.link)
    j = get(f"{base}/l/{slug}/data.json")
    print(f"{j['name']}: {j['rows']:,} records, {j['seconds']} s\nroles:")
    for r, n in sorted(j["roles"].items()):
        print(f"  {r:14} {n}")
    print("channels:")
    for c in j["channels"]:
        print(f"  {c['n']:40} {c.get('u') or '':10} {c.get('lo')} .. {c.get('hi')}")


def table(j):
    names = list(j["channels"])
    print("time".rjust(10) + "".join(n[:14].rjust(15) for n in names))
    for i, t in enumerate(j["t"]):
        row = [j["channels"][n][i] for n in names]
        print(f"{t:10.3f}" + "".join(("" if v is None else f"{v:.4g}").rjust(15) for v in row))


def cmd_slice(a):
    kind, base, slug, _ = parse(a.link)
    q = urllib.parse.urlencode({"ch": a.c, "s": a.s or "", "every": a.e})
    j = get(f"{base}/l/{slug}/data.json?{q}")
    table(j)


def cmd_around(a):
    a.s = f"{a.t - a.w}-{a.t + a.w}"
    cmd_slice(a)


def cmd_live(a):
    kind, base, slug, key = parse(a.link)
    j = get(f"{base}/live/{slug}/status.json?k={urllib.parse.quote(key)}")
    st = j["state"]
    print(f"{j['signature']}\ncar online: {st.get('car')}  ECU: {st.get('ecu')}  mode: {st.get('mode')}  not burned: {st.get('needBurn')}"
          f"  tuners watching: {st.get('viewers')}  tune: {st.get('tune')}")
    print("now:", ", ".join(f"{k}={v:.4g}" if isinstance(v, (int, float)) else f"{k}={v}" for k, v in list(j["now"].items())[: a.n * 4]))
    print("logs:", ", ".join(f"{l['name']} ({base}/l/{l['slug']})" for l in j["logs"]))
    for c in j["changes"][-a.n:]:
        cells = ", ".join(f"{k}: {c.get('was', {}).get(k, '?')}->{v}" for k, v in list(c["cells"].items())[:8])
        print(f"  {c['at']}  {c['table']} by {c['by']}: {cells}")


def cmd_tune(a):
    kind, base, slug, extra = parse(a.link)
    tune = slug if kind == "tune" else extra
    if not tune:
        sys.exit("give a tune link, or a log link with ?tune=")
    j = get(f"{base}/t/{tune}.json")
    print(json.dumps(j, indent=1)[: 20000])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("diagnose"); s.add_argument("link"); s.add_argument("-n", type=int, default=6, help="events shown per finding"); s.set_defaults(f=cmd_diagnose)
    s = sub.add_parser("channels"); s.add_argument("link"); s.set_defaults(f=cmd_channels)
    s = sub.add_parser("slice"); s.add_argument("link"); s.add_argument("-c", default="rpm,map,tps,lambda,lambda_target")
    s.add_argument("-s", help="from-to seconds"); s.add_argument("-e", type=int, default=1, help="every Nth record"); s.set_defaults(f=cmd_slice)
    s = sub.add_parser("around"); s.add_argument("link"); s.add_argument("-t", type=float, required=True); s.add_argument("-w", type=float, default=3)
    s.add_argument("-c", default="rpm,map,tps,lambda,lambda_target,pw,ego_corr,advance"); s.add_argument("-e", type=int, default=1); s.set_defaults(f=cmd_around)
    s = sub.add_parser("live"); s.add_argument("link"); s.add_argument("-n", type=int, default=10); s.set_defaults(f=cmd_live)
    s = sub.add_parser("tune"); s.add_argument("link"); s.set_defaults(f=cmd_tune)
    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
