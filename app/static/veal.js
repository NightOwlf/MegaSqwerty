/* VE Analyze: work out what each VE cell should be from a wideband log.

   For each record the ECU ran a VE (logged, or looked up in the tune) and asked for a mixture (the target);
   the wideband says what it got a moment later. The VE that would have hit the target is
       VE used × (measured λ / target λ) × closed-loop trim
   and that value belongs to the point in the table the engine was at, which sits between four cells.

   Two passes over the same samples:
     * while the log plays, each sample nudges its four cells in proportion to how close they are and how
       little data they've seen yet (a running least-squares estimate), so the table can be watched settling;
     * at the end the table is solved properly: the cell values that best explain every sample through the
       ECU's own bilinear interpolation, held to the tune where the data is thin, and lightly smoothed between
       neighbouring cells that both have data.

   Samples the VE table wasn't in charge of are left out, and counted by reason: a cold engine, throttle or
   MAP moving fast (accel enrichment and wall wetting), fuel cut and the moments after it, a wideband at its
   rail or not ready, maxed injectors, idle when a separate idle VE table runs it, and readings so far off
   they can only be bad data. Used from the browser (window.VEAL) and from node for tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VEAL = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    minClt: 70,        // °C: below this, warm-up enrichment is in the mixture
    tpsRate: 30,       // %/s of throttle movement that counts as a transient
    mapRate: 80,       // kPa/s of MAP movement that counts as a transient
    holdoff: 0.35,     // s to wait after a transient for the fuel film to settle
    lookAhead: 0.15,   // s: a record this close BEFORE a transient or fuel cut is left out too: with any error in the
                       // wideband delay its reading catches the start of the spike (a fuel-cut lean spike reads as
                       // "needs 50% more fuel", inside what passes as plausible)
    fuelRate: 0.4,     // 1/s: a record whose fuel per unit of air is changing this fast (relative) counts half: an
                       // error in the delay × how fast the mixture is being moved = how wrong its reading is
    wallPct: 5,        // %: wall-wetting correction (FOME/rusEFI) bigger than this share of the fuel is a transient
    wallSoft: 2,       // %: ...and a record whose wall correction is this share counts half (the ECU's film model is
                       // never exact, so what it's correcting partly shows on the wideband)
    decelHold: 1.0,    // s to wait after fuel cut
    lag: "auto",       // wideband delay: "auto" (measured from the log) or seconds
    lagByRpm: true,    // exhaust takes longer to reach the sensor at low RPM: scale the delay with it
    maxChange: 15,     // % a cell may move in one pass: cautious, so one bad stretch of log can't wreck a cell
    maxLean: null,     // % a cell may come DOWN in one pass (null: maxChange). Live uses a small step: leaning is the
                       // dangerous way, and small steps let the response check see a bad wideband before it goes far
    minData: 0.5,      // s of data a cell needs for full authority
    smooth: 0.15,      // 0–1: how much neighbouring cells with data are pulled together
    lamMin: 0.6,
    lamMax: 1.25,
    maxDuty: 90,       // % injector duty above which the injectors can't follow the table
    skipIdle: false,
    minRpm: 400,
    // Windows to tune inside (null = no limit), like TunerStudio's filters: only this RPM / load / throttle.
    rpmLo: null, rpmHi: null, loadLo: null, loadHi: null, tpsLo: null, tpsHi: null,
    strength: 100,     // % of the worked-out correction to apply (less, for a cautious first pass)
    locked: null,      // cell indexes that must not change: their neighbours take up the difference
    // Only change a cell when the data is sure of it: the correction has to be bigger than `confidence` times its
    // own uncertainty (the scatter of the samples behind it over how many independent ones there were). Noisy or
    // thin cells stay put instead of chasing noise. 0 turns it off.
    confidence: 2,
    minChange: 0,      // %: a correction smaller than this isn't worth making (live: saves the ECU pointless writes)
    // VE Analyze Live: a cell whose mixture doesn't get richer as its VE goes up isn't short of fuel (misfire, a
    // weak spark or a wideband problem reads lean however much fuel it gets): stop raising it and say so
    responseCheck: true,
    ref: "ran"         // what maxChange is measured from: "ran" (the VE the ECU logged running) or "base" (the
                       // table as it is now: VE Analyze Live, where the table changes as it runs)
  };
  var REASONS = ["used", "cold", "transient", "decel", "sensor", "idle", "duty", "outside", "nodata", "implausible",
                 "section", "filter"];
  var LABELS = {
    used: "Used", cold: "Engine cold", transient: "Throttle/MAP moving", decel: "Fuel cut or decel",
    sensor: "Wideband not reading", idle: "Idle (separate idle VE)", duty: "Injectors maxed",
    outside: "Off the table", nodata: "Missing data", implausible: "Implausible reading",
    section: "Outside the chosen sections", filter: "Your filters"
  };

  function finite(v) { return v === v && v !== Infinity && v !== -Infinity; }

  /* Where v falls along an axis: lower bin, fraction to the next one. Clamped at the edges. */
  function locate(bins, v) {
    var n = bins.length;
    if (n < 2 || !finite(v)) return null;
    if (v <= bins[0]) return [0, 0];
    if (v >= bins[n - 1]) return [n - 2, 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (bins[mid] <= v) lo = mid; else hi = mid; }
    var w = bins[lo + 1] - bins[lo];
    return [lo, w > 0 ? (v - bins[lo]) / w : 0];
  }

  function interp(t, z, x, y) {
    var a = locate(t.x, x), b = locate(t.y, y);
    if (!a || !b) return NaN;
    var c0 = a[0], r0 = b[0], fx = a[1], fy = b[1], C = t.cols;
    var v00 = z[r0 * C + c0], v01 = z[r0 * C + c0 + 1], v10 = z[(r0 + 1) * C + c0], v11 = z[(r0 + 1) * C + c0 + 1];
    return (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy;
  }

  /* The wideband's delay behind the fuel the ECU commanded: the shift that best lines up changes in fuel
     (pulse width, or VE × MAP) with the opposite change in measured λ. -> seconds, or null if unclear. */
  function measureLag(T, fuel, lam, ok) { var m = lagFit(T, fuel, lam, ok); return m ? m.lag : null; }
  /* -> {lag, r}: the delay, refined between samples (a parabola through the best correlation and its neighbours, so a
     20 Hz log isn't stuck to 50 ms steps), and how strongly the two line up. */
  function lagFit(T, fuel, lam, ok) {
    var n = T.length;
    if (!fuel || !lam || n < 500) return null;
    var dt = (T[n - 1] - T[0]) / (n - 1);
    if (!(dt > 0)) return null;
    var df = new Float32Array(n), dl = new Float32Array(n);
    for (var i = 1; i < n; i++) {
      var good = fuel[i] > 0 && fuel[i - 1] > 0 && lam[i] > 0 && lam[i - 1] > 0 && (!ok || (ok[i] && ok[i - 1]));
      df[i] = good ? Math.log(fuel[i] / fuel[i - 1]) : NaN;
      dl[i] = good ? -Math.log(lam[i] / lam[i - 1]) : NaN;
    }
    var step = Math.max(1, Math.round(0.025 / dt)), maxK = Math.round(0.8 / dt), rs = {};
    var corr = function (k) {
      if (k in rs) return rs[k];
      var sab = 0, saa = 0, sbb = 0, sa = 0, sb = 0, m = 0;
      for (var j = 1; j + k < n; j++) {
        var a = df[j], b = dl[j + k];
        if (a !== a || b !== b) continue;
        sa += a; sb += b; sab += a * b; saa += a * a; sbb += b * b; m++;
      }
      if (m < 200) return (rs[k] = null);
      var cov = sab / m - sa / m * sb / m, va = saa / m - sa * sa / m / m, vb = sbb / m - sb * sb / m / m;
      return (rs[k] = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0);
    };
    var best = -1, bestK = -1;
    for (var k = 0; k <= maxK; k += step) { var r = corr(k); if (r !== null && r > best) { best = r; bestK = k; } }
    if (!(best > 0.02)) return null;
    // the neighbouring samples, then the top of the parabola through the three
    for (var q = Math.max(0, bestK - step + 1); q < bestK + step; q++) { var rq = corr(q); if (rq !== null && rq > best) { best = rq; bestK = q; } }
    var r0 = corr(bestK - 1), r2 = corr(bestK + 1), off = 0;
    if (bestK > 0 && r0 !== null && r2 !== null) { var den = r0 - 2 * best + r2; if (den < 0) off = Math.max(-0.5, Math.min(0.5, 0.5 * (r0 - r2) / den)); }
    return { lag: (bestK + off) * dt, r: best };
  }

  /* Some ECUs log VE in one byte (FOME/rusEFI: U08 × 0.5, so 0–127.5): a VE above 127.5 comes out 128 less
     (a cell at 148.5 logs as 20.5). Put the 128 back when the table says the cell is up there: the logged value is
     well under the table's (less than 0.6 of it) and adding 128 lands closer. The table it's checked against needn't
     be the one that ran (a cell that ran at 151 may read 106 in today's tune), so there's no fixed threshold. */
  function unwrapVe(v, fromTune) {
    if (!(fromTune > 0) || !(v >= 0 && v < 128) || !(v < fromTune * 0.6)) return v;
    var best = v;
    for (var k = 1; k <= 3; k++) if (Math.abs(v + 128 * k - fromTune) < Math.abs(best - fromTune)) best = v + 128 * k;
    return best;
  }
  function median(arr) {
    var a = Array.prototype.filter.call(arr, finite).sort(function (p, q) { return p - q; });
    return a.length ? a[a.length >> 1] : NaN;
  }

  /* table: {x, y, z, cols, rows, d}. opts: see DEFAULTS. */
  function create(table, opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in opts || {}) if (opts[k] !== undefined && opts[k] !== null && opts[k] !== "") o[k] = opts[k];
    var C = table.cols, R = table.rows, N = C * R;
    var base = Float64Array.from(table.z);
    var val = Float64Array.from(table.z);   // the running estimate shown while the log plays
    var hits = new Float64Array(N);          // seconds of data behind each cell (interpolation-weighted)
    var A = new Float64Array(N * 9), b = new Float64Array(N);  // normal equations, 3×3 neighbourhood per cell
    // The same fit for the VE the ECU actually ran (logged), which rebuilds the table that was on the car even
    // when the tune attached isn't it. Changes are limited relative to this, not to a file that never ran.
    var bRan = new Float64Array(N), valRan = Float64Array.from(table.z);
    // the range of VE the ECU actually logged in each cell: the rebuilt "what ran" can't leave it (with sparse data,
    // or a table that was changed while the log ran, an unbounded fit swings neighbours to impossible values)
    var ranLo = new Float64Array(N).fill(Infinity), ranHi = new Float64Array(N).fill(-Infinity);
    // ...and the logged VE around each cell, weighted by how much each sample leans on it: a cell only ever reached at
    // the edge of its square (MAP never down at that row) isn't pinned by the fit, but can't be far from this
    var ranU = new Float64Array(N), ranW = new Float64Array(N);
    var mism = { n: 0, sum: 0, logged: 0 };
    var errSum = new Float64Array(N), errW = new Float64Array(N);  // mixture error each cell saw, before the fix
    // the correction each sample asked of a cell (want / used), weighted: its mean, scatter and effective count
    var rS = new Float64Array(N), rS2 = new Float64Array(N), wS2 = new Float64Array(N);
    var lockedSet = new Uint8Array(N);
    // per pass, per cell: the mixture it saw (for the response check), and its history across passes
    var pY = new Float64Array(N), pW = new Float64Array(N), hist = new Array(N), stuck = new Uint8Array(N);
    // which way a held cell was going when it stopped responding: +1 raised (a misfire reads lean), -1 lowered (a
    // wideband reading rich whatever the fuel): it's never moved further that way
    var stuckDir = new Int8Array(N);
    function setLocked(list) { lockedSet.fill(0); (list || []).forEach(function (k) { if (k >= 0 && k < N) lockedSet[k] = 1; }); }
    setLocked(o.locked);
    var within = function (v, lo, hi) { return (lo == null || !(v < lo)) && (hi == null || !(v > hi)); };
    var prior = 0.01;  // a whisker of the tune's own value, so cells with no samples stay put
    var stats = { total: 0 }, logs = [];
    REASONS.forEach(function (r) { stats[r] = 0; });
    var log = null;

    function band(p, q) {  // A[p][q] for cells within one row/column of each other
      var dr = Math.floor(q / C) - Math.floor(p / C), dc = q % C - p % C;
      return p * 9 + (dr + 1) * 3 + (dc + 1);
    }

    /* Start on a log. d: {T, rpm, load, lam, tgt, ve, veRef (the VE of the tune that ran with it), trim, trimMode, clt, tps, map, fuel, ae, dfco, cutCode, wall,
       mass, lamOk, idle, duty} as arrays (λ already divided to lambda), any but T/rpm/load/lam/tgt may be missing.
       Optional masks: d.inSection (1 = inside the sections chosen to tune) and d.userOk (1 = passes the
       user's own filters). */
    function begin(d) {
      var T = d.T, n = T.length, i;
      var lamLo = Infinity, lamHi = -Infinity;
      for (i = 0; i < n; i++) { var l = d.lam[i]; if (l === l) { if (l < lamLo) lamLo = l; if (l > lamHi) lamHi = l; } }
      var railLo = lamLo <= 0.56 ? lamLo + 1e-4 : -1, railHi = lamHi >= 1.15 ? lamHi - 1e-4 : 99;
      var okMask = new Uint8Array(n);
      for (i = 0; i < n; i++) {
        var lv = d.lam[i];
        okMask[i] = lv > railLo && lv < railHi && (!d.lamOk || d.lamOk[i] > 0) ? 1 : 0;
      }
      // What the wideband responds to is fuel per unit of air: fuel that just follows the air (MAP) leaves λ where it
      // is. So the delay is measured, and how settled a record is judged, on fuel ÷ MAP: it moves when the target,
      // the trim or the table under the engine changes, which is exactly when λ moves.
      var fuel = null;
      if (d.fuel || (d.ve && d.map)) {
        fuel = new Float32Array(n);
        for (i = 0; i < n; i++) {
          var fq = d.fuel ? d.fuel[i] : d.ve[i] * d.map[i] / (d.tgt && d.tgt[i] > 0 ? d.tgt[i] : 1);
          fuel[i] = d.map && d.map[i] > 5 ? fq / d.map[i] : fq;
        }
      }
      var lag = typeof o.lag === "number" ? o.lag : null, measured = false;
      if (lag === null) {
        lag = measureLag(T, fuel, d.lam, okMask);
        measured = lag !== null;
        if (lag === null) lag = 0.2;
        lag = Math.max(0.05, Math.min(0.6, lag));
      }
      var rpmMed = median(d.rpm.length > 20000 ? d.rpm.filter(function (_, q) { return q % 7 === 0; }) : d.rpm) || 2000;
      var lagAt = function (rpm) {
        return o.lagByRpm ? lag * Math.max(0.7, Math.min(1.5, Math.sqrt(rpmMed / Math.max(300, rpm || 300)))) : lag;
      };

      // reasons a record can't be used, decided up front (so a record knows about the transients around it)
      var why = new Uint8Array(n), j = new Int32Array(n), lastTrans = -1e9, lastDecel = -1e9;
      var fr = new Float32Array(n);  // how fast fuel per unit of air is changing, relative, per second
      var wr = new Float32Array(n);  // wall-wetting correction, % of the fuel
      var events = [];               // [time, reason] where a transient or fuel cut begins, for the look-ahead
      var win = 0.1, back = 0, back2 = 0, wasTrans = false, wasCut = false;
      for (i = 0; i < n; i++) {
        var t = T[i];
        while (back < i && T[back] < t - win) back++;
        while (back2 < i && T[back2] < t - 0.25) back2++;
        var span = t - T[back];
        var trans = false;
        if (span > 0) {
          if (d.tps && finite(d.tps[i]) && finite(d.tps[back]) && Math.abs(d.tps[i] - d.tps[back]) / span > o.tpsRate) trans = true;
          if (d.map && finite(d.map[i]) && finite(d.map[back]) && Math.abs(d.map[i] - d.map[back]) / span > o.mapRate) trans = true;
        }
        if (d.ae && finite(d.ae[i]) && d.ae[i] !== 0) trans = true;  // a flag, or fuel added/taken (FOME: ms, can be −)
        if (d.wall && d.mass && d.mass[i] > 0) { wr[i] = Math.abs(d.wall[i]) / d.mass[i] * 100; if (wr[i] > o.wallPct) trans = true; }
        if (trans) { lastTrans = t; if (!wasTrans) events.push([t, 2]); }
        wasTrans = trans;
        if (fuel && T[i] > T[back2] && fuel[i] > 0 && fuel[back2] > 0) fr[i] = Math.abs(Math.log(fuel[i] / fuel[back2])) / (T[i] - T[back2]);
        var rpm = d.rpm[i], lagI = lagAt(rpm);
        var lamCut = d.tps && d.tps[i] < 1.5 && d.lam[i] > 1.12 && rpm > 1400;
        var cut = (d.dfco && d.dfco[i] > 0) || (d.fuel && d.fuel[i] <= 0.05 && rpm > 600) ||
                  (d.cutCode && finite(d.cutCode[i]) && Math.abs(d.cutCode[i]) >= 0.5) || lamCut;
        if (cut) lastDecel = t;
        // a cut seen only on the wideband began a delay earlier
        if (cut && !wasCut) events.push([lamCut && !(d.dfco && d.dfco[i] > 0) ? t - lagI : t, 3]);
        wasCut = cut;

        // the record whose λ shows this record's fuel (none yet when what comes after it isn't known: live waits)
        var lo = i, hi = n - 1, want = t + lagI;
        if (T[hi] < Math.max(want, t + o.lookAhead)) { j[i] = -1; } else {
          while (lo < hi) { var mid = (lo + hi) >> 1; if (T[mid] < want) lo = mid + 1; else hi = mid; }
          j[i] = lo;
        }

        var reason = 0;
        if (d.inSection && !d.inSection[i]) reason = 10;
        else if (!(rpm >= o.minRpm) || !finite(d.load[i]) || j[i] < 0) reason = 8;
        else if (d.clt && d.clt[i] < o.minClt) reason = 1;
        else if (cut || t - lastDecel < o.decelHold) reason = 3;
        else if (t - lastTrans < o.holdoff) reason = 2;
        else if (o.skipIdle && d.idle && d.idle[i] > 0) reason = 5;
        else if (d.duty && d.duty[i] > o.maxDuty) reason = 6;
        else if ((d.userOk && !d.userOk[i]) || !within(rpm, o.rpmLo, o.rpmHi) || !within(d.load[i], o.loadLo, o.loadHi) ||
                 (d.tps && !within(d.tps[i], o.tpsLo, o.tpsHi))) reason = 11;
        why[i] = reason;
      }
      // look ahead: a record just before a transient or cut reads the start of it if the delay is a little off
      if (o.lookAhead > 0 && events.length) {
        events.sort(function (p, q) { return p[0] - q[0]; });
        var e = 0;
        for (i = 0; i < n; i++) {
          while (e < events.length && events[e][0] <= T[i]) e++;
          if (e < events.length && !why[i] && events[e][0] - T[i] <= o.lookAhead) why[i] = events[e][1];
        }
      }
      // a log that ever shows a VE above 127.5 isn't logging it in one byte: nothing in it has wrapped
      var veMax = -Infinity;
      if (d.ve) for (i = 0; i < n; i++) if (d.ve[i] > veMax && d.ve[i] < 300) veMax = d.ve[i];
      log = { d: d, n: n, why: why, j: j, ok: okMask, canWrap: !!d.ve && veMax <= 127.5 + 1e-3, lag: lag, measured: measured, rpmMed: rpmMed, fr: fr, wr: wr, lagAt: lagAt };
      logs.push({ lag: lag, measured: measured });
      return log;
    }

    var corner = [0, 0, 0, 0], weight = [0, 0, 0, 0];
    /* Feed record i of the current log. -> the index of the cell nearest to it if the record was used, else -1. */
    function step(i) {
      var d = log.d, n = log.n, reason = log.why[i];
      stats.total++;
      var jj = log.j[i];
      if (!reason) {
        var lam = d.lam[jj], tgt = d.tgt[i];
        if (!log.ok[jj] || !(lam > o.lamMin && lam < o.lamMax)) reason = 4;
        else if (!(tgt > 0.6 && tgt < 1.4)) reason = 8;
      }
      var a = reason ? null : locate(table.x, d.rpm[i]), c = reason ? null : locate(table.y, d.load[i]);
      if (!reason && (!a || !c)) reason = 7;
      var fromTune = reason ? NaN : interp(table, base, d.rpm[i], d.load[i]);
      // unwrapped against the tune that ran with this log when it's known (d.veRef), else the one attached. In a
      // one-byte log a 0 is a VE of 128 that wrapped, not a missing value
      var ref = d.veRef && d.veRef[i] > 0 ? d.veRef[i] : fromTune;
      var lv = !reason && d.ve && d.ve[i] >= 0 && d.ve[i] < 300 ? (log.canWrap ? unwrapVe(d.ve[i], ref) : d.ve[i]) : NaN;
      var logged = lv > 0;
      var used = reason ? NaN : (logged ? lv : fromTune);
      if (!reason && !(used > 0)) reason = 8;
      var want = NaN;
      if (!reason) {
        var trim = 1;
        if (d.trim && finite(d.trim[i])) trim = d.trimMode === "pct100" ? d.trim[i] / 100 : 1 + d.trim[i] / 100;
        if (!(trim > 0.5 && trim < 1.5)) trim = 1;
        want = used * (lam / tgt) * trim;
        if (!(want / used > 0.6 && want / used < 1.6)) reason = 9;
      }
      if (reason) { stats[REASONS[reason]]++; return -1; }
      stats.used++;
      if (logged) { mism.n++; mism.sum += Math.abs(fromTune / used - 1); mism.logged++; }

      var dt = i + 1 < n ? d.T[i + 1] - d.T[i] : d.T[i] - d.T[i - 1];
      dt = Math.max(0, Math.min(0.2, dt || 0));
      var rate = 0;
      if (i > 0 && d.T[i] > d.T[i - 1]) rate = Math.abs(d.rpm[i] - d.rpm[i - 1]) / (d.T[i] - d.T[i - 1]);
      // settled samples count for more: RPM sweeping, or fuel demand changing, put the reading in doubt
      var s = dt / (1 + Math.pow(rate / 2500, 2) + (o.fuelRate > 0 ? Math.pow(log.fr[i] / o.fuelRate, 2) : 0) +
                    (o.wallSoft > 0 ? Math.pow(log.wr[i] / o.wallSoft, 2) : 0));
      if (!(s > 0)) return -1;

      var c0 = a[0], r0 = c[0], fx = a[1], fy = c[1];
      corner[0] = r0 * C + c0; corner[1] = r0 * C + c0 + 1; corner[2] = (r0 + 1) * C + c0; corner[3] = (r0 + 1) * C + c0 + 1;
      weight[0] = (1 - fx) * (1 - fy); weight[1] = fx * (1 - fy); weight[2] = (1 - fx) * fy; weight[3] = fx * fy;
      var pred = 0, predRan = 0, p, q;
      for (p = 0; p < 4; p++) { pred += weight[p] * val[corner[p]]; predRan += weight[p] * valRan[corner[p]]; }
      var err = want - pred, errRan = used - predRan;
      for (p = 0; p < 4; p++) {
        var w = weight[p];
        if (w <= 0) continue;
        var cp = corner[p];
        hits[cp] += s * w;
        errSum[cp] += s * w * (lam / tgt - 1); errW[cp] += s * w;
        pY[cp] += s * w * Math.log(want); pW[cp] += s * w;  // the VE the engine needed, for the response check
        var r = want / used;
        rS[cp] += s * w * r; rS2[cp] += s * w * r * r; wS2[cp] += s * w * s * w;
        val[cp] += s * w / (hits[cp] + prior) * err;
        valRan[cp] += s * w / (hits[cp] + prior) * errRan;
        b[cp] += s * w * want;
        bRan[cp] += s * w * used;
        if (w >= 0.05 && used === used) { if (used < ranLo[cp]) ranLo[cp] = used; if (used > ranHi[cp]) ranHi[cp] = used; }
        if (used === used) { ranU[cp] += s * w * w * used; ranW[cp] += s * w * w; }
        for (q = 0; q < 4; q++) if (weight[q] > 0) A[band(cp, corner[q])] += s * w * weight[q];
      }
      return weight[0] >= weight[1] && weight[0] >= weight[2] && weight[0] >= weight[3] ? corner[0]
        : weight[1] >= weight[2] && weight[1] >= weight[3] ? corner[1] : weight[2] >= weight[3] ? corner[2] : corner[3];
    }

    /* The value a cell may show: a cell with less than minData seconds of data only moves part of the way
       (in proportion), almost none at all moves not at all, and nothing moves more than maxChange. */
    function limited(k, v, ran) {
      if (lockedSet[k] || hits[k] < o.minData * 0.1) return base[k];
      if (o.ref === "base") ran = base[k];
      var authority = Math.min(1, hits[k] / o.minData);
      var lim = Math.abs(ran) * o.maxChange / 100, limDown = o.maxLean == null ? lim : Math.abs(ran) * Math.min(o.maxChange, o.maxLean) / 100;
      v = base[k] + (v - base[k]) * authority;
      return Math.max(ran - limDown, Math.min(ran + lim, v));
    }
    function current(k) { return limited(k, val[k], valRan[k]); }

    /* How sure a cell's correction is: the relative 1-sigma uncertainty of the mean correction its samples asked
       for. Readings closer together than ~0.1 s aren't independent (the wideband's own filtering), and even a
       rock-steady reading is only good to about ±0.5% (the sensor's accuracy). Infinity where there's no data. */
    function uncertainty(k) {
      var w = errW[k];
      if (!(w > 0)) return Infinity;
      var m = rS[k] / w, v = rS2[k] / w - m * m;
      var neff = Math.min(wS2[k] > 0 ? w * w / wS2[k] : 0, hits[k] / 0.1);
      return Math.sqrt(Math.max(v, 0.005 * 0.005) / Math.max(1, neff));
    }

    /* VE Analyze Live keeps one engine for the whole session: what each sample says the engine needs is measured
       against the VE that ran then (logged), so it stays true after the table changes. Between passes the table
       it corrects moves on (rebase), older evidence slowly counts for less (decay), and locks can change. */
    /* After a live pass: note each cell's table value and the VE its samples said the engine needed this pass. On a
       healthy engine and wideband that need stays put however the table moves; when the cell has moved 6% or more
       over the session and the need moved with it, the wideband isn't measuring fuel there (a misfire reads lean,
       a bad sensor reads one mixture whatever the fuel): the cell is held, never moved further the way it was
       going (it may still go back). -> newly held cells */
    function passEnd() {
      var fresh = [];
      for (var q = 0; q < N; q++) {
        var h = hist[q] || (hist[q] = { pts: [], x: base[q] > 0 ? Math.log(base[q]) : NaN, sy: 0, sw: 0, moved: false }), x = base[q] > 0 ? Math.log(base[q]) : NaN;
        if (Math.abs(x - h.x) > 1e-9) h.moved = true;  // changed since the last pass
        if (Math.abs(x - h.x) > 1e-9 && h.sw > 0) {  // the cell's value changed: what it saw at the old one is a point
          if (h.sw >= 0.25) h.pts.push([h.x, h.sy / h.sw, Math.min(h.sw, 5)]);
          if (h.pts.length > 40) h.pts.shift();
          h.sy = 0; h.sw = 0;
        }
        h.x = x; h.sy += pY[q]; h.sw += pW[q];
        pY[q] = 0; pW[q] = 0;
        if (!o.responseCheck || stuck[q]) continue;
        var pts = h.sw >= 0.25 ? h.pts.concat([[h.x, h.sy / h.sw, Math.min(h.sw, 5)]]) : h.pts;
        if (pts.length < 2) continue;
        var sw = 0, sx = 0, sy = 0, lo = Infinity, hi = -Infinity;
        pts.forEach(function (p) { sw += p[2]; sx += p[2] * p[0]; sy += p[2] * p[1]; lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); });
        var mx = sx / sw, my = sy / sw, cxy = 0, cxx = 0;
        pts.forEach(function (p) { cxy += p[2] * (p[0] - mx) * (p[1] - my); cxx += p[2] * (p[0] - mx) * (p[0] - mx); });
        // what the engine needed (VE used × measured λ / target) doesn't depend on the table when the wideband reads
        // true: moving this cell or its neighbours leaves it where it is (slope ≈ 0). A wideband stuck reading one
        // mixture, or a misfire reading lean, makes it follow the table instead (slope ≈ the cell's share, ~0.5–1+)
        if (hi - lo >= Math.log(1.06) && cxx > 0 && cxy / cxx > 0.3) { stuck[q] = 1; stuckDir[q] = h.x >= pts[0][0] ? 1 : -1; fresh.push(q); }
      }
      return fresh;
    }
    function rebase(values) { for (var q = 0; q < N; q++) if (values[q] > 0) base[q] = values[q]; }
    function decay(f) {
      if (!(f < 1)) return;
      f = Math.max(0, f);
      [hits, A, b, bRan, errSum, errW, rS, rS2, ranU, ranW].forEach(function (arr) { for (var q = 0; q < arr.length; q++) arr[q] *= f; });
      for (var q = 0; q < N; q++) wS2[q] *= f * f;
    }

    /* Least squares through the ECU's interpolation: A x = rhs, plus a whisker of the tune and the smoothing. */
    function solve(rhsVec, start, smooth, hold) {
      var x = Float64Array.from(start), k, it, m;
      if (hold) for (k = 0; k < N; k++) if (lockedSet[k]) x[k] = base[k];  // locked: held, so the rest fit around it
      var smoothW = new Float64Array(N * 4);  // right, left, up, down neighbour pull
      var nb = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      for (k = 0; k < N; k++) {
        var r = Math.floor(k / C), cc = k % C;
        for (m = 0; m < 4; m++) {
          var rr = r + nb[m][0], c2 = cc + nb[m][1];
          if (rr < 0 || rr >= R || c2 < 0 || c2 >= C) continue;
          smoothW[k * 4 + m] = smooth * 0.15 * Math.min(hits[k], hits[rr * C + c2]);
        }
      }
      for (it = 0; it < 600; it++) {
        var moved = 0;
        for (k = 0; k < N; k++) {
          if (hold && lockedSet[k]) continue;
          var diag = A[k * 9 + 4] + prior, rhs = rhsVec[k] + prior * base[k];
          var rk = Math.floor(k / C), ck = k % C;
          for (m = 0; m < 9; m++) {
            if (m === 4) continue;
            var ar = A[k * 9 + m];
            if (ar) rhs -= ar * x[(rk + Math.floor(m / 3) - 1) * C + (ck + m % 3 - 1)];
          }
          for (m = 0; m < 4; m++) {
            var sw = smoothW[k * 4 + m];
            if (!sw) continue;
            diag += sw;
            rhs += sw * x[(rk + nb[m][0]) * C + ck + nb[m][1]];
          }
          var nv = rhs / diag;
          moved = Math.max(moved, Math.abs(nv - x[k]));
          x[k] = nv;
        }
        if (moved < 1e-6) break;
      }
      return x;
    }

    /* Solve the whole table from every sample. -> {values, changed: [{i, from, to, pct, hits}], ...} */
    function finish() {
      // what ran is rebuilt exactly (no smoothing): it's a record of the ECU's table, not a measurement
      // the tune attached is the one that ran (the logged VE matches it to within a couple of %): that's the record
      var live = o.ref === "base", same = !live && mism.n > 100 && mism.sum / mism.n < 0.02;
      var x = solve(b, val, o.smooth, true), ran = live || same ? Float64Array.from(base) : solve(bRan, valRan, 0, false), k;
      for (k = 0; k < N; k++) {  // keep what ran inside what was logged there (or the tune, where nothing was)
        if (live || same) continue;
        if (!(ran[k] === ran[k])) ran[k] = base[k];
        if (ranLo[k] <= ranHi[k]) {
          var lo = Math.min(ranLo[k], base[k]) * 0.85, hi = Math.max(ranHi[k], base[k]) * 1.15;
          ran[k] = Math.max(lo, Math.min(hi, ran[k]));
        }
        // and near the VE the ECU logged around it: a cell the fit can't pin down otherwise swings to nonsense
        if (ranW[k] > 0) { var avg = ranU[k] / ranW[k]; ran[k] = Math.max(avg * 0.85, Math.min(avg * 1.15, ran[k])); }
        else ran[k] = base[k];
      }
      var digits = Math.max(0, Math.min(4, table.d == null ? 1 : table.d)), unit = Math.pow(10, digits);
      var values = new Array(N), changed = [];
      for (k = 0; k < N; k++) {
        var rk = hits[k] >= o.minData * 0.1 ? ran[k] : base[k];
        var full = limited(k, x[k], rk), str = Math.max(0, Math.min(100, o.strength)) / 100;
        // not sure enough, or too small to bother with: the cell stays as it is
        var rel = base[k] ? Math.abs(full / base[k] - 1) : 0;
        if (rel * 100 < o.minChange || (o.confidence > 0 && rel < o.confidence * uncertainty(k))) full = base[k];
        // not responding to fuel: never moved further the way it was going (raised on a misfire, leaned on a bad reading)
        if (stuck[k] && (stuckDir[k] < 0 ? full < base[k] : full > base[k])) full = base[k];
        // live: after a change, see what the new value does before changing the cell again
        var hk = hist[k];
        if (o.responseCheck && hk && hk.moved && hk.sw < 0.25) full = base[k];
        var v = Math.round((base[k] + (full - base[k]) * str) * unit) / unit;
        if (!(v > 0)) v = base[k];  // a VE of zero or below is never an answer
        values[k] = v;
        val[k] = v;
        valRan[k] = rk;
        if (Math.abs(v - base[k]) >= 0.5 / unit) {
          changed.push({ i: k, from: base[k], to: v, pct: base[k] ? (v / base[k] - 1) * 100 : 0, hits: hits[k],
                         ran: Math.round(rk * unit) / unit });
        }
      }
      return { values: values, changed: changed, stats: stats, hits: hits, logs: logs, ran: Array.from(valRan),
               mismatch: mismatch(), error: Array.prototype.map.call(errW, function (w, q) { return w > 0 ? errSum[q] / w * 100 : NaN; }) };
    }

    /* How far the attached tune's VE is from what the ECU logged running: a different tune if it's large. */
    function mismatch() { return mism.n ? mism.sum / mism.n * 100 : null; }

    function summary() {
      var out = [];
      REASONS.forEach(function (r) { if (stats[r]) out.push({ key: r, label: LABELS[r], n: stats[r] }); });
      return out;
    }

    /* The average mixture error a cell saw, in % (+ lean, − rich), NaN where it saw nothing. */
    function error(k) { return errW[k] > 0 ? errSum[k] / errW[k] * 100 : NaN; }
    return { begin: begin, step: step, finish: finish, current: current, hits: hits, base: base, stats: stats, error: error,
             mismatch: mismatch, ran: function (k) { return valRan[k]; }, uncertainty: uncertainty,
             rebase: rebase, decay: decay, setLocked: setLocked, passEnd: passEnd,
             stuck: function () { var out = []; for (var q = 0; q < N; q++) if (stuck[q]) out.push(q); return out; },
             stuckDir: function (q) { return stuckDir[q]; },
             summary: summary, opts: o, logs: logs, cells: N };
  }

  return { create: create, interp: interp, locate: locate, measureLag: measureLag, unwrapVe: unwrapVe, DEFAULTS: DEFAULTS, LABELS: LABELS };
});
