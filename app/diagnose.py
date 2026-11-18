"""Log doctor: read a whole datalog and find what a tuner would hunt for by hand (and what's easy to miss),
each with when it happened, what the numbers were, why it matters and what to check.

Works on any log the app reads (FOME/rusEFI, MegaSquirt, Speeduino… by channel role), uploaded or recorded
live. Thresholds are deliberately conservative: a finding is something worth looking at, not a verdict."""
from __future__ import annotations

import re

import numpy as np

from . import logs as logsmod
from .logfile import LogDoc

# FOME / rusEFI fuelIgnCutCodeList
CUT = ["None", "fatal error", "setting disabled", "RPM limit", "fault RPM limit", "boost cut", "oil pressure",
       "stop requested", "ETB problem", "launch control", "max injector duty", "flood clear", "engine sync",
       "kickstart", "ign off", "Lua", "ACR", "Lambda Prot"]
OBD = {105: "MAP sensor circuit", 107: "MAP sensor reads low", 108: "MAP sensor reads high",
       110: "Intake air temp sensor circuit", 112: "IAT reads low", 113: "IAT reads high",
       115: "Coolant temp sensor circuit", 117: "CLT reads low", 118: "CLT reads high",
       120: "TPS A circuit", 122: "TPS A reads low", 123: "TPS A reads high", 220: "TPS B circuit",
       222: "TPS B reads low", 223: "TPS B reads high", 325: "Knock sensor circuit",
       335: "Crankshaft position sensor circuit", 340: "Camshaft position sensor circuit", 500: "Vehicle speed sensor",
       560: "System voltage", 2120: "Pedal sensor D circuit", 2135: "Throttle sensors A/B disagree",
       2138: "Pedal sensors D/E disagree"}
SEV = {"bad": 0, "warn": 1, "info": 2}


def err_text(code: int) -> str:
    if code < 3500:
        return f"P{code:04d}" + (f": {OBD[code]}" if code in OBD else "")
    return f"firmware code {code}"


def _key(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


class _Log:
    """The log as numpy arrays by role, plus channel lookup by name."""

    def __init__(self, parsed: LogDoc, stoich: float):
        self.p = parsed
        self.roles = logsmod.resolve(parsed)
        t, _ = logsmod._timebase(parsed, self.roles)
        self.t = np.asarray(t, dtype=float)
        self.n = len(self.t)
        self.stoich = stoich or 14.7

    def a(self, role):
        c = self.roles.get(role)
        if c is None:
            return None
        v = np.asarray(c.arr, dtype=float)
        return v if len(v) == self.n else None

    def named(self, *patterns):
        for pat in patterns:
            for c in self.p.channels:
                if re.search(pat, _key(c.name)):
                    v = np.asarray(c.arr, dtype=float)
                    if len(v) == self.n:
                        return v, c
        return None, None

    def units(self, role) -> str:
        c = self.roles.get(role)
        return (c.units or "") if c is not None else ""

    def lam(self, role):
        """A mixture channel as lambda (AFR channels divided by stoich)."""
        c, v = self.roles.get(role), self.a(role)
        if c is None or v is None:
            return None
        return v if logsmod._is_lambda(c) else v / self.stoich

    def celsius(self, role):
        v = self.a(role)
        if v is None:
            return None
        u = self.units(role).lower()
        if "f" in u and "c" not in u.replace("deg", ""):
            return (v - 32) / 1.8
        return v


def _runs(mask: np.ndarray, t: np.ndarray, min_s: float = 0.0, gap_s: float = 0.25) -> list[tuple[int, int]]:
    """Stretches where mask is true (joined across gaps shorter than gap_s), at least min_s long."""
    out = []
    idx = np.flatnonzero(mask)
    if not len(idx):
        return out
    start = prev = idx[0]
    for i in idx[1:]:
        if t[i] - t[prev] > gap_s:
            out.append((start, prev))
            start = i
        prev = i
    out.append((start, prev))
    return [(a, b) for a, b in out if t[b] - t[a] >= min_s]


def diagnose(parsed: LogDoc, stoich: float = 14.7) -> dict:
    L = _Log(parsed, stoich)
    t, n = L.t, L.n
    findings: list[dict] = []
    if n < 10:
        return {"rows": n, "seconds": 0, "findings": [], "stats": {}}

    rpm, mp, tps = L.a("rpm"), L.a("map"), L.a("tps")
    running = rpm > 400 if rpm is not None else np.ones(n, dtype=bool)
    driving = rpm > 800 if rpm is not None else running  # past cranking and stalls

    def at(i):
        out = {"t": round(float(t[i]), 2)}
        for role, key, d in (("rpm", "rpm", 0), ("map", "map", 1), ("tps", "tps", 1)):
            v = L.a(role)
            if v is not None and v[i] == v[i]:
                out[key] = round(float(v[i]), d)
        lam, tgt = L.lam("lambda"), L.lam("lambda_target")
        if lam is not None and lam[i] == lam[i]:
            out["afr"] = round(float(lam[i] * L.stoich), 2)
        if tgt is not None and tgt[i] == tgt[i]:
            out["target"] = round(float(tgt[i] * L.stoich), 2)
        return out

    def add(fid, sev, title, detail, fix, runs, extra=None, limit=60):
        evs = []
        for a, b in runs[:limit]:
            e = {"t0": round(float(t[a]), 2), "t1": round(float(t[b]), 2), "at": at(a)}
            if extra:
                e.update(extra(a, b))
            evs.append(e)
        findings.append({"id": fid, "sev": sev, "title": title, "detail": detail, "fix": fix,
                         "count": len(runs), "events": evs})

    # ---------------------------------------------------------------- mixture
    lam, tgt = L.lam("lambda"), L.lam("lambda_target")
    ok, _ = L.named(r"^lambdacurrentlygood$")
    if lam is not None:
        good = driving & np.isfinite(lam)
        if ok is not None:
            good &= ok > 0
        lo_rail, hi_rail = np.nanmin(lam[good]) if good.any() else 0, np.nanmax(lam[good]) if good.any() else 0
        if good.any() and tgt is not None:
            err = (lam / tgt - 1) * 100  # + lean, - rich
            load = np.zeros(n, dtype=bool)
            if mp is not None:
                load |= mp > 95
            if tps is not None:
                load |= tps > 60
            r = _runs(good & load & (err > 6) & (lam < hi_rail - 1e-3), t, 0.3)
            if r:
                worst = max(r, key=lambda ab: np.nanmax(err[ab[0]:ab[1] + 1]))
                add("lean_load", "bad", "Lean under load",
                    f"{len(r)} time(s) the mixture was more than 6% leaner than target with the engine loaded "
                    f"(worst {np.nanmax(err[worst[0]:worst[1] + 1]):.0f}% lean).",
                    "Lean at load risks detonation. Add fuel in the VE cells at those RPM and MAP (VE Analyze over these "
                    "sections), check fuel pressure holds, and that injector duty isn't maxed.", r,
                    lambda a, b: {"worst": f"{np.nanmax(err[a:b + 1]):.0f}% lean"})
            r = _runs(good & load & (err < -10), t, 0.5)
            if r:
                add("rich_load", "warn", "Rich under load",
                    f"{len(r)} time(s) more than 10% richer than target under load.",
                    "Costs power and fuel; take fuel out of those VE cells (VE Analyze over the sections).", r,
                    lambda a, b: {"worst": f"{-np.nanmin(err[a:b + 1]):.0f}% rich"})
            cruise = good & ~load & (np.abs(err) > 8)
            if tps is not None:
                cruise &= tps > 2
            r = _runs(cruise, t, 2.0)
            if r:
                add("cruise_off", "warn", "Off target while cruising",
                    f"{len(r)} stretch(es) of 2 s or more where AFR stayed more than 8% off target at light load.",
                    "The VE table is off in those cells; closed loop may be covering it. Run VE Analyze on this log.", r,
                    lambda a, b: {"avg": f"{np.nanmean(err[a:b + 1]):+.0f}%"})
        # lean on tip-in: throttle opened fast and the mixture went lean right after
        if tps is not None and tgt is not None and good.any():
            dt = np.maximum(np.diff(t, prepend=t[0]), 1e-3)
            rate = np.diff(tps, prepend=tps[0]) / dt
            hits = []
            for i in np.flatnonzero((rate > 150) & running):
                j = np.searchsorted(t, t[i] + 0.6)
                seg = slice(i, min(n, j))
                e = (lam[seg] / tgt[seg] - 1) * 100
                if np.nanmax(e, initial=-99) > 12:
                    hits.append((i, min(n - 1, j)))
            hits = [h for k, h in enumerate(hits) if k == 0 or t[h[0]] - t[hits[k - 1][0]] > 1.0]
            if hits:
                add("tipin_lean", "warn", "Lean when the throttle opens",
                    f"{len(hits)} time(s) the mixture went more than 12% lean within 0.6 s of opening the throttle quickly.",
                    "That's acceleration enrichment: add TPS/MAP-rate enrichment (accel enrich tables) where it happens.",
                    hits)
        # the wideband itself
        if ok is not None:
            r = _runs(running & (ok <= 0), t, 5.0, 1.0)
            if r:
                add("wbo_not_ready", "warn", "Wideband not reading",
                    f"The ECU flagged the wideband as not ready for {len(r)} stretch(es) of 5 s or more with the engine running.",
                    "Check the wideband's heater power and warm-up, its wiring and the controller's status.", r)
        rail = good & ((lam <= lo_rail + 1e-4) | (lam >= hi_rail - 1e-4)) & (hi_rail - lo_rail > 0.3)
        r = _runs(rail, t, 1.5)
        if r and (hi_rail > 1.45 or lo_rail < 0.66):
            add("wbo_rail", "info", "Wideband at the end of its range",
                f"The mixture reading sat at its limit ({lo_rail * L.stoich:.1f} / {hi_rail * L.stoich:.1f} AFR) for {len(r)} stretch(es).",
                "Usually deceleration fuel cut (reads full lean); if it's under power, the reading isn't trustworthy there.", r)

    # ---------------------------------------------------------------- closed-loop trim working hard
    trim = L.a("ego_corr")
    if trim is not None:
        c = L.roles["ego_corr"]
        pct = trim - 100 if np.nanmax(trim) > 50 else trim
        r = _runs(running & (np.abs(pct) > 10), t, 2.0)
        if r:
            add("trim_high", "warn", "Closed loop correcting a lot",
                f"Fuel trim ({c.name}) beyond ±10% for {len(r)} stretch(es) of 2 s or more.",
                "The VE table is off where it happens; closed loop is hiding it. VE Analyze fixes the table so the trim sits near 0.", r,
                lambda a, b: {"trim": f"{np.nanmean(pct[a:b + 1]):+.0f}%"})

    # ---------------------------------------------------------------- knock
    kn = L.a("knock")
    if kn is not None:
        r = _runs(running & (kn > 0.5), t, 0.0, 0.3)
        if r:
            boosted = mp is not None and any(np.nanmax(mp[a:b + 1]) > 105 for a, b in r)
            add("knock", "bad" if boosted else "warn", "Knock retard",
                f"The ECU pulled timing for knock {len(r)} time(s), up to {np.nanmax(kn):.1f}°" + (" (some under boost)" if boosted else "") + ".",
                "Find the cells it happens in: take timing out there, check the mixture isn't lean, IAT and fuel quality. "
                "If it's only at low load and constant, the knock sensor threshold may be too sensitive.", r,
                lambda a, b: {"retard": f"{np.nanmax(kn[a:b + 1]):.1f}°"})

    # ---------------------------------------------------------------- fuel and spark cuts, warning codes
    pw = L.a("pw")
    dfco = L.a("dfco")
    for pats, what in (((r"^fuelcutcode$", r"^fuelcutreason$"), "Fuel"), ((r"^igncutcode$", r"^ignitioncutcode$", r"^sparkcutreason$"), "Spark")):
        code, ch = L.named(*pats)
        if code is None:
            continue
        cc = np.round(np.nan_to_num(code)).astype(int)
        for k in sorted(set(cc[running & (cc > 0)].tolist())):
            r = _runs(running & (cc == k), t, 0.0, 0.3)
            name = CUT[k] if 0 <= k < len(CUT) else f"code {k}"
            sev = "bad" if name in ("fatal error", "oil pressure", "Lambda Prot", "boost cut", "fault RPM limit", "ETB problem", "max injector duty") else "warn"
            if name == "engine sync":
                sev = "info"
            add(f"cut_{what.lower()}_{k}", sev, f"{what} cut: {name}",
                f"{what} was cut {len(r)} time(s) with the engine running, reason \"{name}\" (from {ch.name}).",
                {"RPM limit": "The rev limiter. Fine if intended; otherwise raise the limit or shift sooner.",
                 "boost cut": "Boost went over the boost-cut pressure: check the wastegate, boost control and the cut setting.",
                 "Lambda Prot": "Lambda protection: the engine ran lean under load. Fix the fueling there first.",
                 "max injector duty": "The injectors are too small for this power: bigger injectors or more fuel pressure.",
                 "launch control": "Launch control holding RPM.",
                 "engine sync": "The ECU lost trigger sync while running: check the crank/cam sensors and their wiring.",
                 "flood clear": "Flood clear: the throttle was floored while cranking."}.get(name, "See the ECU's documentation for this cut reason."),
                r)
    if pw is not None and L.named(r"^fuelcutcode$", r"^fuelcutreason$")[0] is None:
        stop = running & (pw <= 0.05) & (rpm > 1000 if rpm is not None else True)
        if dfco is not None:
            stop &= ~(dfco > 0)
        r = _runs(stop, t, 0.04, 0.2)
        if r:
            closed = [ab for ab in r if tps is not None and tps[ab[0]] < 10 and (mp is None or mp[ab[0]] < 60)]
            other = [ab for ab in r if ab not in closed]
            if closed:
                add("fuel_stop_decel", "info", "Fuel stopped on deceleration",
                    f"{len(closed)} time(s) fuel stopped with the throttle closed at speed: deceleration fuel cut. Normal.",
                    "Nothing to fix. The wideband reads lean during these; VE Analyze leaves them out.", closed)
            if other:
                add("fuel_stop", "bad", "Fuel stopped with the throttle open",
                    f"{len(other)} time(s) the injectors stopped while the engine ran with the throttle open, and this log has no cut-code channel saying why.",
                    "Likely the rev limiter, a protection cut or lost sync. Log the cut code (new live sessions do) to see the reason.", other)
    warn, wch = L.named(r"^warninglast$", r"^lasterrorcode$")
    if warn is not None:
        w = np.round(np.nan_to_num(warn)).astype(int)
        codes = sorted(set(w[w > 0].tolist()))
        for k in codes:
            first = int(np.flatnonzero(w == k)[0])
            add(f"warn_{k}", "warn", f"Warning code {err_text(k)}",
                f"The ECU raised {err_text(k)} (first at {t[first]:.1f} s).",
                "Check the sensor or circuit named; on FOME, the warnings list in TunerStudio shows the detail.", [(first, first)])

    # ---------------------------------------------------------------- RPM dropouts, trigger errors
    if rpm is not None:
        dt = np.diff(t, prepend=t[0])
        drop = (np.roll(rpm, 1) > 1000) & (rpm < 150) & (dt < 0.3)
        r = []
        for i in np.flatnonzero(drop):
            j = np.searchsorted(t, t[i] + 0.8)
            if j < n and np.nanmax(rpm[i:j + 1]) > 800:
                r.append((i, j))
        if r:
            add("rpm_dropout", "bad", "RPM dropped out while running",
                f"RPM fell to zero and came straight back {len(r)} time(s): the ECU lost the crank signal for a moment.",
                "Check the crank (and cam) sensor, its gap and wiring, trigger settings and the trigger error count.", r)
    trg, trc = L.named(r"^triggererrorcount", r"^trgtriggererrorcounter$", r"^triggererrors")
    if trg is not None and running.any():
        inc = np.flatnonzero(np.diff(trg, prepend=trg[0]) > 0)
        inc = [i for i in inc if running[i]]
        if inc:
            add("trigger_errors", "bad", "Trigger errors", f"The trigger error count went up {len(inc)} time(s) while running.",
                "Noise or a bad crank/cam signal: check sensor gap, shielding, grounds and the trigger settings.", [(i, i) for i in inc])

    # ---------------------------------------------------------------- sensor glitches
    for role, label, jump, unit in (("map", "MAP", 35.0, "kPa"), ("tps", "Throttle", 30.0, "%"), ("clt", "Coolant temp", 8.0, "°C"), ("iat", "Intake temp", 10.0, "°C")):
        v = L.celsius(role) if role in ("clt", "iat") else L.a(role)
        if v is None or n < 3:
            continue
        spike = (np.abs(v[1:-1] - v[:-2]) > jump) & (np.abs(v[1:-1] - v[2:]) > jump) & (np.abs(v[2:] - v[:-2]) < jump / 3)
        idx = np.flatnonzero(spike) + 1
        if len(idx) >= 2:
            add(f"glitch_{role}", "warn", f"{label} sensor glitches",
                f"{label} jumped by more than {jump:g} {unit} for a single sample and straight back {len(idx)} time(s).",
                "That's electrical noise or a loose connection, not the engine: check the sensor's connector, ground and wiring.",
                [(i, i) for i in idx])

    # ---------------------------------------------------------------- temperatures, voltage, injectors, fuel pressure
    clt = L.celsius("clt")
    if clt is not None:
        r = _runs(running & (clt > 105), t, 3.0)
        if r:
            add("hot", "bad" if np.nanmax(clt) > 112 else "warn", "Engine running hot",
                f"Coolant above 105 °C (221 °F) for {len(r)} stretch(es), up to {np.nanmax(clt) * 1.8 + 32:.0f} °F.",
                "Check the cooling system and fan control; hot coolant also makes knock more likely.", r)
    iat = L.celsius("iat")
    if iat is not None:
        r = _runs(running & (iat > 60), t, 5.0)
        if r:
            add("iat_hot", "warn", "Hot intake air", f"Intake air above 60 °C (140 °F) for {len(r)} stretch(es), up to {np.nanmax(iat) * 1.8 + 32:.0f} °F.",
                "Heat soak or intercooler: hot air knocks sooner. Check IAT timing correction and the intercooler / sensor placement.", r)
    bt = L.a("batt")
    if bt is not None:
        r = _runs(running & (bt < 12.2) & (rpm > 900 if rpm is not None else True), t, 3.0)
        if r:
            add("volts_low", "warn", "Low charging voltage", f"Battery under 12.2 V with the engine running for {len(r)} stretch(es) (lowest {np.nanmin(bt[running]):.1f} V).",
                "The alternator isn't charging or a connection is poor; low voltage lengthens injector dead time and upsets fueling.", r)
        r = _runs(running & (bt > 15.3), t, 3.0)
        if r:
            add("volts_high", "warn", "High voltage", f"Battery over 15.3 V for {len(r)} stretch(es).", "Check the alternator's regulator.", r)
    dc = L.a("inj_duty")
    if dc is not None:
        r = _runs(running & (dc > 85), t, 0.2)
        if r:
            add("inj_duty", "bad" if np.nanmax(dc) > 95 else "warn", "Injectors near their limit",
                f"Injector duty above 85% {len(r)} time(s), up to {np.nanmax(dc):.0f}%.",
                "Above ~85% the injectors can't add fuel when it's needed: bigger injectors or higher fuel pressure.", r)
    fp = L.a("fuel_press")
    if fp is not None and running.any() and np.nanmax(fp[running]) > 0:
        base = np.nanmedian(fp[running])
        r = _runs(running & (fp < base * 0.85), t, 0.5)
        if r:
            add("fuel_press", "bad", "Fuel pressure dropped", f"Fuel pressure fell more than 15% below its usual {base:.1f} {L.units('fuel_press')} {len(r)} time(s).",
                "The pump, filter or regulator can't keep up: the engine goes lean there.", r)

    # ---------------------------------------------------------------- boost
    bt_t = L.a("boost_target")
    if mp is not None and bt_t is not None:
        over = running & (bt_t > 105) & (mp > bt_t + 20)
        r = _runs(over, t, 0.3)
        if r:
            add("boost_over", "warn", "Boost over target", f"MAP more than 20 kPa over the boost target {len(r)} time(s), up to {np.nanmax(mp):.0f} kPa.",
                "Boost control overshoot: lower the duty in those cells or tune the closed-loop gains; check the wastegate.", r)

    # ---------------------------------------------------------------- idle
    if rpm is not None and tps is not None:
        idle = running & (tps < 2) & (rpm < 1400)
        if (L.t[idle].size and idle.sum() > 200):
            r = []
            for a, b in _runs(idle, t, 4.0):
                s = np.nanstd(rpm[a:b + 1])
                if s > 90:
                    r.append((a, b))
            if r:
                add("idle_hunt", "warn", "Idle is unsteady", f"RPM wandered more than ±90 at idle in {len(r)} stretch(es).",
                    "Check idle air / ETB idle position, idle timing control, vacuum leaks and the idle VE cells.", r,
                    lambda a, b: {"spread": f"±{np.nanstd(rpm[a:b + 1]):.0f} rpm"})

    # ---------------------------------------------------------------- the log itself
    gaps = _runs(np.diff(t, prepend=t[0]) > 1.0, t, 0.0, 0.0)
    if gaps:
        add("gaps", "info", "Gaps in the log", f"{len(gaps)} gap(s) of more than a second between records.",
            "Logging paused (connection, page in the background). Data is missing there.", gaps)

    findings.sort(key=lambda f: (SEV[f["sev"]], -f["count"]))
    stats = {}
    for role in ("rpm", "map", "tps", "clt", "iat", "batt", "knock", "inj_duty", "advance"):
        v = L.a(role)
        if v is not None and np.isfinite(v).any():
            stats[role] = {"channel": L.roles[role].name, "min": round(float(np.nanmin(v)), 2),
                           "max": round(float(np.nanmax(v)), 2), "mean": round(float(np.nanmean(v)), 2)}
    if lam is not None and np.isfinite(lam).any():
        stats["afr"] = {"min": round(float(np.nanmin(lam) * L.stoich), 2), "max": round(float(np.nanmax(lam) * L.stoich), 2)}
    run_s = float(np.sum(np.diff(t)[running[1:]])) if n > 1 else 0.0
    return {"rows": n, "seconds": round(float(t[-1] - t[0]), 1), "running_s": round(run_s, 1),
            "findings": findings, "stats": stats}
