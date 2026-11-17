/* The log viewer: stacked graphs of any channels over time, a cursor with every value, zoom and pan, playback,
   a scatter plot, the tune's tables following the cursor (and editable), and VE Analyze, which plays through
   the log and corrects the VE table live. Channels are fetched one at a time as float32 and only when
   something draws them, so a 600-channel log opens as fast as a 10-channel one. */
(function () {
  "use strict";
  var root = document.getElementById("lv");
  if (!root) return;
  var SLUG = root.dataset.log, TUNE = root.dataset.tune || "";
  var base = "/l/" + SLUG;
  var query = location.search || "";
  var $ = function (s, el) { return (el || root).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || root).querySelectorAll(s)); };
  var $d = function (s) { return document.querySelector(s); };

  var COLORS = [["#ffe14d", "#4fd8ff", "#ff66d9", "#5df56a"], ["#ff5b4d", "#ffffff", "#6f8cff", "#ffb9ad"],
                ["#ffe14d", "#4fd8ff", "#ff66d9", "#5df56a"], ["#ff5b4d", "#ffffff", "#6f8cff", "#ffb9ad"]];
  var SLOTS = 4, MAX_PANES = 4;
  var DEFAULTS = [["rpm", "map", "tps", "vss"], ["afr", "afr_target", "advance", "pw"],
                  ["clt", "iat", "ego_corr", "batt"], ["knock", "duty", "boost_target", "inj_duty"]];
  var WATCH = ["rpm", "map", "tps", "afr", "afr_target", "advance", "clt", "iat", "batt", "vss", "gear",
               "inj_duty", "pw", "knock", "ego_corr", "ve"];
  // Mixture is shown as AFR: these are the names an AFR channel goes by, before falling back to lambda.
  var AFR_NAMES = { afr: ["afr", "afr1", "widebandafr", "wbafr", "airfuelratio", "afrcorrected"],
                    afr_target: ["fueltargetafr", "afrtarget", "targetafr", "afrtgt", "airfuelratiotarget"] };

  var idx = null, T = null, N = 0, tMin = 0, tMax = 1;
  var store = {};            // channel index -> {v: Float32Array, pyr: [...]} once loaded, or a Promise while loading
  var panes = [], paneCount = 3, watch = [];
  var view = { t0: 0, t1: 1 }, cur = 0;
  var playing = false, speed = 1, playT = 0, lastFrame = 0;
  var tab = "graphs", dirty = false, scatterDirty = true;
  var sc = { x: -1, y: -1, z: -1 };
  var tableSlots = [];
  var stoich = 14.7;
  var loadNote = $(".lv-load");

  /* ---------- data ---------- */
  function pyramid(v) {
    var out = [], src = null, n = v.length, s = 1;
    while (n > 256) {
      var m = Math.ceil(n / 16), mn = new Float32Array(m), mx = new Float32Array(m);
      for (var j = 0; j < m; j++) {
        var a = Infinity, b = -Infinity, end = Math.min(n, (j + 1) * 16);
        for (var i = j * 16; i < end; i++) {
          var lo = src ? src.min[i] : v[i], hi = src ? src.max[i] : v[i];
          if (lo === lo) { if (lo < a) a = lo; if (hi > b) b = hi; }
        }
        mn[j] = a === Infinity ? NaN : a; mx[j] = b === -Infinity ? NaN : b;
      }
      s *= 16; n = m;
      src = { s: s, min: mn, max: mx };
      out.push(src);
    }
    return out;
  }
  function fetchF32(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.arrayBuffer();
    }).then(function (buf) { return new Float32Array(buf); });
  }
  function load(i) {
    if (i == null || i < 0 || !idx || i >= idx.channels.length) return Promise.resolve(null);
    var have = store[i];
    if (have) return have.then ? have : Promise.resolve(have);
    var p = fetchF32(base + "/ch/" + i).then(function (v) {
      store[i] = { v: v, pyr: pyramid(v) };
      scatterDirty = true;
      invalidate();
      return store[i];
    }, function () { delete store[i]; return null; });
    store[i] = p;
    return p;
  }
  function got(i) { var d = store[i]; return d && !d.then ? d : null; }
  function lower(t) {  // first record at or after time t
    var lo = 0, hi = N;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (T[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function nearest(t) {
    var i = lower(t);
    if (i >= N) return N - 1;
    if (i > 0 && t - T[i - 1] < T[i] - t) return i - 1;
    return i;
  }
  function fmt(v, d) {
    if (v == null || v !== v) return "–";
    return v.toFixed(d == null ? 1 : Math.max(0, Math.min(4, d)));
  }
  function fmtT(t, span) {
    if (span > 600) { var m = Math.floor(t / 60), s = t - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(0); }
    return t.toFixed(span > 60 ? 0 : span > 8 ? 1 : 2) + "s";
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function key(name) { return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function usable(c) { return c != null && c >= 0 && idx && c < idx.channels.length && idx.channels[c].lo != null; }
  /* A role's channel, preferring an AFR channel for mixture. */
  function channelFor(role) {
    var roles = idx.roles || {};
    if (AFR_NAMES[role]) {
      for (var i = 0; i < idx.channels.length; i++) {
        var m = idx.channels[i];
        if (m.lo != null && m.hi > 2 && AFR_NAMES[role].indexOf(key(m.n)) >= 0) return i;
      }
      return usable(roles[role === "afr" ? "lambda" : "lambda_target"]) ? roles[role === "afr" ? "lambda" : "lambda_target"] : -1;
    }
    return usable(roles[role]) ? roles[role] : -1;
  }
  function plural(n, word) { return n.toLocaleString() + " " + word + (n === 1 ? "" : "s"); }

  /* ---------- view & cursor ---------- */
  function clampView() {
    var total = tMax - tMin, span = view.t1 - view.t0;
    var least = Math.min(total, Math.max(0.05, total / Math.max(1, N) * 12));
    if (span > total) span = total;
    if (span < least) { var mid = (view.t0 + view.t1) / 2; span = least; view.t0 = mid - span / 2; }
    if (view.t0 < tMin) view.t0 = tMin;
    if (view.t0 + span > tMax) view.t0 = tMax - span;
    view.t1 = view.t0 + span;
  }
  function setView(t0, t1) { view.t0 = t0; view.t1 = t1; clampView(); scatterDirty = true; invalidate(); saveSoon(); }
  function zoom(f, at) {
    if (at == null) at = T[cur] >= view.t0 && T[cur] <= view.t1 ? T[cur] : (view.t0 + view.t1) / 2;
    setView(at - (at - view.t0) * f, at + (view.t1 - at) * f);
  }
  function pan(dt) { setView(view.t0 + dt, view.t1 + dt); }
  function follow() {
    var t = T[cur], span = view.t1 - view.t0;
    if (t < view.t0) setView(t - span * 0.1, t + span * 0.9);
    else if (t > view.t1) setView(t - span * 0.9, t + span * 0.1);
  }
  function setCursor(i, doFollow) {
    cur = Math.max(0, Math.min(N - 1, i));
    if (doFollow) follow();
    invalidate(); saveSoon();
  }
  function play(on) {
    if (on && ve.running) return;
    if (on && cur >= N - 1) cur = 0;
    playing = on; playT = T[cur]; lastFrame = 0;
    var b = $("[data-lv=play]");
    b.textContent = on ? "⏸" : "▶"; b.classList.toggle("on", on);
    if (on) requestAnimationFrame(tick);
    invalidate();
  }
  function tick(now) {
    if (!playing) return;
    if (lastFrame) {
      playT += Math.min(0.25, (now - lastFrame) / 1000) * speed;
      var i = lower(playT);
      if (i >= N - 1) { cur = N - 1; play(false); return; }
      cur = i;
      var span = view.t1 - view.t0;
      if (T[cur] > view.t1 - span * 0.02 || T[cur] < view.t0) setView(T[cur] - span * 0.1, T[cur] + span * 0.9);
      invalidate();
    }
    lastFrame = now;
    requestAnimationFrame(tick);
  }

  /* ---------- canvases ---------- */
  function fit(cv) {
    var dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function trace(ctx, d, i0, i1, kx, yOf, W, v0) {
    var v = d.v, spp = (i1 - i0 + 1) / W, lvl = null, pen = false, i;
    for (var k = d.pyr.length - 1; k >= 0; k--) if (d.pyr[k].s * 2 <= spp) { lvl = d.pyr[k]; break; }
    ctx.beginPath();
    if (!lvl && spp <= 2) {
      for (i = i0; i <= i1; i++) {
        var val = v[i];
        if (val !== val) { pen = false; continue; }
        var x = (T[i] - v0) * kx, y = yOf(val);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
    } else {
      var s = lvl ? lvl.s : 1, a = Math.floor(i0 / s), b = Math.floor(i1 / s);
      var col = -1e9, cmin = Infinity, cmax = -Infinity, has = false;
      var flush = function () {
        if (!has) { pen = false; return; }
        var y1 = yOf(cmin), y2 = yOf(cmax);
        if (pen) ctx.lineTo(col + 0.5, y1); else { ctx.moveTo(col + 0.5, y1); pen = true; }
        if (y2 !== y1) ctx.lineTo(col + 0.5, y2);
      };
      for (var j = a; j <= b; j++) {
        var mn = lvl ? lvl.min[j] : v[j], mx = lvl ? lvl.max[j] : v[j];
        var c = Math.floor((T[Math.min(N - 1, j * s)] - v0) * kx);
        if (c !== col) { if (col !== -1e9) flush(); col = c; cmin = Infinity; cmax = -Infinity; has = false; }
        if (mn === mn) { if (mn < cmin) cmin = mn; if (mx > cmax) cmax = mx; has = true; }
      }
      flush();
    }
    ctx.stroke();
  }
  function ticks(span) {
    var steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
    for (var i = 0; i < steps.length; i++) if (span / steps[i] <= 10) return steps[i];
    return 7200;
  }
  function drawMarkers(ctx, W, H, kx, t0, t1, label) {
    if (!idx.markers || !idx.markers.length) return;
    ctx.save();
    ctx.strokeStyle = "#ff3b30"; ctx.fillStyle = "#ff8a80"; ctx.lineWidth = 1;
    ctx.font = "11px system-ui, sans-serif"; ctx.textBaseline = "top"; ctx.textAlign = "left";
    idx.markers.forEach(function (mk) {
      var t = T[Math.min(N - 1, mk[0])];
      if (t < t0 || t > t1) return;
      var x = Math.round((t - t0) * kx) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      if (label && mk[1]) ctx.fillText(mk[1], x + 3, H - 30);
    });
    ctx.restore();
  }
  function drawPane(p, last) {
    var f = fit(p.cv), ctx = f.ctx, W = f.w, H = f.h;
    if (W < 10 || H < 10) return;
    var small = W < 520, fs = small ? 10.5 : 12, lh = fs + 2;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    var span = view.t1 - view.t0, kx = W / span;
    var step = ticks(span), t;
    ctx.strokeStyle = "#1c2024"; ctx.lineWidth = 1; ctx.beginPath();
    for (t = Math.ceil(view.t0 / step) * step; t < view.t1; t += step) {
      var gx = Math.round((t - view.t0) * kx) + 0.5;
      ctx.moveTo(gx, 0); ctx.lineTo(gx, H);
    }
    for (var g = 1; g < 4; g++) { ctx.moveTo(0, Math.round(H * g / 4) + 0.5); ctx.lineTo(W, Math.round(H * g / 4) + 0.5); }
    ctx.stroke();
    drawMarkers(ctx, W, H, kx, view.t0, view.t1, last);

    var i0 = Math.max(0, lower(view.t0) - 1), i1 = Math.min(N - 1, lower(view.t1) + 1);
    var top = 5, bot = last ? 18 : 5, shown = [];
    ctx.lineWidth = 1.25; ctx.lineJoin = "round";
    p.ch.forEach(function (c, k) {
      var d = got(c), m = c >= 0 ? idx.channels[c] : null;
      if (!m) return;
      shown.push({ c: c, m: m, d: d, color: COLORS[p.i][k] });
      if (!d || m.lo == null) return;
      var range = m.hi - m.lo, ky = range > 0 ? (H - top - bot) / range : 0;
      var yOf = range > 0 ? function (v) { return H - bot - (v - m.lo) * ky; } : function () { return H / 2; };
      ctx.strokeStyle = COLORS[p.i][k];
      trace(ctx, d, i0, i1, kx, yOf, W, view.t0);
    });

    // min / max of each channel down the left edge, like a strip chart's scale
    ctx.font = "bold " + fs + "px system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    var tight = H - bot < shown.length * lh * 3 + 8, labelW = 0;  // too short for separate max and min stacks
    shown.forEach(function (s, k) {
      ctx.fillStyle = s.color;
      var u = s.m.u ? " (" + s.m.u + ")" : "", text;
      if (tight) {
        text = fmt(s.m.lo, s.m.d) + " – " + fmt(s.m.hi, s.m.d) + u;
        ctx.fillText(text, 4, 3 + k * lh);
      } else {
        text = "Max = " + fmt(s.m.hi, s.m.d) + u;
        ctx.fillText(text, 4, 3 + k * lh);
        ctx.fillText("Min = " + fmt(s.m.lo, s.m.d) + u, 4, H - bot - (shown.length - k) * lh);
      }
      labelW = Math.max(labelW, ctx.measureText(text).width + 6);
    });

    // the cursor and the values under it
    var cx = (T[cur] - view.t0) * kx;
    if (cx >= -1 && cx <= W + 1) {
      ctx.strokeStyle = "#39e6ff"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, 0); ctx.lineTo(Math.round(cx) + 0.5, H); ctx.stroke();
      var right = cx < W - 96;
      ctx.textAlign = right ? "left" : "right";
      var y0 = Math.min(H - bot - shown.length * lh - 2, Math.max(3 + shown.length * lh + 4, H / 2 - shown.length * lh / 2));
      var clear = Math.max(cx + 5, labelW + 8);  // keep clear of the scale labels at the left edge
      shown.forEach(function (s, k) {
        var text = s.d ? fmt(s.d.v[cur], s.m.d) : "…";
        var tx = right ? clear : cx - 5, ty = y0 + k * lh;
        ctx.fillStyle = "rgba(0,0,0,.72)";
        var tw = ctx.measureText(text).width;
        ctx.fillRect(right ? tx - 2 : tx - tw - 2, ty - 1, tw + 4, lh);
        ctx.fillStyle = s.color; ctx.fillText(text, tx, ty);
      });
    }
    if (last) {
      ctx.textBaseline = "bottom"; ctx.fillStyle = "#39e6ff"; ctx.font = fs + "px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "left"; ctx.fillText(fmtT(view.t0, span), 4, H - 2);
      ctx.textAlign = "right"; ctx.fillText(fmtT(view.t1, span), W - 4, H - 2);
      if (cx > 60 && cx < W - 60) { ctx.textAlign = "center"; ctx.fillText(fmtT(T[cur], Math.min(span, 60)), cx, H - 2); }
      ctx.fillStyle = "#39e6ff"; ctx.beginPath();
      for (t = Math.ceil(view.t0 / step) * step; t < view.t1; t += step) ctx.rect(Math.round((t - view.t0) * kx), H - 4, 1, 4);
      ctx.fill();
    }
  }
  function drawOverview() {
    var cv = $(".lv-over canvas"), f = fit(cv), ctx = f.ctx, W = f.w, H = f.h;
    ctx.fillStyle = "#0b0c0e"; ctx.fillRect(0, 0, W, H);
    var c = -1;
    panes.slice(0, paneCount).some(function (p) { return p.ch.some(function (x) { if (x >= 0 && got(x)) { c = x; return true; } }); });
    var total = tMax - tMin || 1, kx = W / total;
    if (c >= 0) {
      var d = got(c), m = idx.channels[c], range = m.hi - m.lo;
      if (range > 0) {
        ctx.strokeStyle = "#8a93a0"; ctx.lineWidth = 1;
        trace(ctx, d, 0, N - 1, kx, function (v) { return H - 3 - (v - m.lo) / range * (H - 6); }, W, tMin);
      }
    }
    drawMarkers(ctx, W, H, kx, tMin, tMax, false);
    var x0 = (view.t0 - tMin) * kx, x1 = (view.t1 - tMin) * kx;
    ctx.fillStyle = "rgba(53,116,240,.28)"; ctx.fillRect(x0, 0, Math.max(2, x1 - x0), H);
    ctx.strokeStyle = "#6ea2ff"; ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(2, Math.round(x1 - x0) - 1), H - 1);
    var cx = Math.round((T[cur] - tMin) * kx) + 0.5;
    ctx.strokeStyle = "#39e6ff"; ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  }

  /* ---------- gauges & status ---------- */
  var gaugeBox = $(".lv-gauges"), gaugeKey = "";
  function gaugeList() {
    var seen = {}, out = [];
    panes.slice(0, paneCount).forEach(function (p) {
      p.ch.forEach(function (c, k) { if (c >= 0 && !seen[c]) { seen[c] = 1; out.push({ c: c, color: COLORS[p.i][k] }); } });
    });
    watch.forEach(function (c) { if (c >= 0 && !seen[c]) { seen[c] = 1; out.push({ c: c, color: "", w: true }); } });
    return out;
  }
  function drawGauges() {
    var list = gaugeList(), sig = list.map(function (g) { return g.c + g.color; }).join(",");
    if (sig !== gaugeKey) {
      gaugeKey = sig;
      gaugeBox.innerHTML = list.map(function (g) {
        var m = idx.channels[g.c];
        return '<span class="lv-g" data-c="' + g.c + '"' + (g.w ? ' data-w title="Click to remove"' : "") + ">" +
          '<i style="background:' + (g.color || "#6b6f76") + '"></i><span class="lv-gn">' + esc(m.n) + "</span>" +
          '<b class="mono"></b>' + (m.u ? "<small>" + esc(m.u) + "</small>" : "") + "</span>";
      }).join("") + '<button type="button" class="lv-g lv-gadd" title="Show another channel here">+ Add</button>';
    }
    $$(".lv-g[data-c]", gaugeBox).forEach(function (el) {
      var c = +el.dataset.c, d = got(c);
      el.children[2].textContent = d ? fmt(d.v[cur], idx.channels[c].d) : "…";
    });
  }
  function drawStatus() {
    var total = tMax - tMin || 1, z = total / (view.t1 - view.t0);
    $(".lv-status").textContent = "Record " + (cur + 1).toLocaleString() + " of " + N.toLocaleString() +
      " · " + T[cur].toFixed(2) + " s · Zoom " + z.toFixed(1) + "× · Play speed " + Math.round(speed * 100) + "%";
  }

  /* ---------- the tune's tables: colours, values, edits ---------- */
  var edits = {};            // table name -> {cell index: new value}
  var EDIT_KEY = "msq.lv.edits:" + TUNE;
  function heat(f) {
    f = Math.max(0, Math.min(1, f));
    var stops = [[120, 150, 255], [120, 220, 240], [130, 230, 130], [240, 235, 110], [255, 170, 90], [255, 105, 95]];
    var x = f * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), r = x - k;
    return "rgb(" + [0, 1, 2].map(function (j) { return Math.round(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * r); }).join(",") + ")";
  }
  function diverge(pct, max) {  // blue for leaner (less fuel), red for richer
    var f = Math.max(-1, Math.min(1, pct / (max || 15)));
    if (Math.abs(f) < 0.02) return "rgb(232,234,237)";
    var c = f > 0 ? [235, 80, 60] : [60, 120, 235], a = Math.min(1, Math.abs(f) * 1.1);
    return "rgb(" + [0, 1, 2].map(function (j) { return Math.round(232 + (c[j] - 232) * a); }).join(",") + ")";
  }
  function where(bins, v) {  // fractional position of v along an axis
    var n = bins.length;
    if (!(v === v) || n < 2) return NaN;
    if (v <= bins[0]) return 0;
    if (v >= bins[n - 1]) return n - 1;
    for (var k = 0; k < n - 1; k++) if (v < bins[k + 1]) return k + (v - bins[k]) / ((bins[k + 1] - bins[k]) || 1);
    return n - 1;
  }
  function cellText(v, d) {  // as many decimals as fit a narrow cell
    var a = Math.abs(v);
    return v.toFixed(a >= 100 ? 0 : Math.min(d, a >= 10 ? 1 : 2));
  }
  function binText(v) { return Math.abs(v) >= 100 || v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1); }
  function valueAt(t, k) { var e = edits[t.name]; return e && k in e ? e[k] : t.z[k]; }
  function edited(t, k) { var e = edits[t.name]; return !!(e && k in e); }
  function range(t) {
    var lo = Infinity, hi = -Infinity;
    for (var k = 0; k < t.z.length; k++) { var v = valueAt(t, k); if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi];
  }
  function setValue(t, k, v) {
    var unit = Math.pow(10, t.d);
    v = Math.round(v * unit) / unit;
    if (!(v === v)) return;
    edits[t.name] = edits[t.name] || {};
    if (Math.abs(v - t.z[k]) < 0.5 / unit) delete edits[t.name][k];
    else edits[t.name][k] = v;
    if (!Object.keys(edits[t.name]).length) delete edits[t.name];
  }
  function editCount() {
    var n = 0;
    for (var name in edits) n += Object.keys(edits[name]).length;
    return n;
  }
  function saveEdits() {
    try {
      if (editCount()) localStorage.setItem(EDIT_KEY, JSON.stringify(edits));
      else localStorage.removeItem(EDIT_KEY);
    } catch (e) { /* storage unavailable */ }
  }
  function restoreEdits() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(EDIT_KEY) || "null"); } catch (e) { /* ignore */ }
    if (!saved || typeof saved !== "object") return;
    idx.tables.forEach(function (t) {
      var e = saved[t.name];
      if (!e) return;
      for (var k in e) if (+k >= 0 && +k < t.z.length && typeof e[k] === "number" && isFinite(e[k])) setValue(t, +k, e[k]);
    });
  }

  /* One editable grid of a table: used for the tables beside the graphs and the big VE Analyze grid. */
  function Grid(el, t, opts) {
    this.el = el; this.t = t; this.opts = opts || {};
    this.sel = null; this.anchor = null; this.last = null;
    this.mode = "value";
    this.render();
  }
  Grid.prototype.render = function () {
    var t = this.t, html = [];
    for (var r = t.rows - 1; r >= 0; r--) {
      html.push("<tr><th>" + binText(t.y[r]) + "</th>");
      for (var c = 0; c < t.cols; c++) html.push('<td data-k="' + (r * t.cols + c) + '"></td>');
      html.push("</tr>");
    }
    html.push('<tr class="lv-tx"><th></th>' + t.x.map(function (v) { return "<th>" + binText(v) + "</th>"; }).join("") + "</tr>");
    this.el.innerHTML = '<div class="lv-tw" tabindex="0"><table class="lv-tt' + (this.opts.big ? " big" : "") + '"><tbody>' +
      html.join("") + '</tbody></table><i class="lv-dot" hidden></i></div>';
    this.wrap = $(".lv-tw", this.el);
    this.cells = [];
    var self = this;
    $$("td", this.el).forEach(function (td) { self.cells[+td.dataset.k] = td; });
    this.paint();
    this.bind();
  };
  Grid.prototype.paint = function (only) {
    var t = this.t, rg = range(t), self = this, ks = only || this.cells.map(function (_, k) { return k; });
    var info = this.opts.info;
    ks.forEach(function (k) {
      var td = self.cells[k];
      if (!td) return;
      var v = self.opts.live ? self.opts.live(k) : valueAt(t, k), bg, text = cellText(v, t.d);
      if (self.mode === "change") {
        var pct = t.z[k] ? (v / t.z[k] - 1) * 100 : 0;
        bg = diverge(pct, 15); text = Math.abs(pct) < 0.05 ? "" : (pct > 0 ? "+" : "") + pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1);
      } else if (self.mode === "hits" && info) {
        var h = info.hits(k);
        bg = h > 0 ? "rgb(" + [0, 1, 2].map(function () { return Math.round(235 - Math.min(1, h / 3) * 150); }).join(",") + ")" : "#3a3d42";
        text = h >= 0.01 ? h.toFixed(h >= 10 ? 0 : 1) : "";
      } else if (self.mode === "ran" && info) {
        v = info.ran(k); text = cellText(v, t.d);
        bg = heat(rg[1] > rg[0] ? (v - rg[0]) / (rg[1] - rg[0]) : 0.5);
      } else {
        bg = heat(rg[1] > rg[0] ? (v - rg[0]) / (rg[1] - rg[0]) : 0.5);
      }
      td.style.background = bg;
      td.textContent = text;
      td.classList.toggle("vx-ed", !self.opts.live && edited(t, k));
    });
    this.markSel();
  };
  Grid.prototype.flash = function (k) {
    var td = this.cells[k];
    if (!td) return;
    td.classList.remove("vx-hit"); void td.offsetWidth; td.classList.add("vx-hit");
  };
  Grid.prototype.rc = function (k) { return [Math.floor(k / this.t.cols), k % this.t.cols]; };
  Grid.prototype.selected = function () {
    if (!this.sel) return [];
    var out = [], s = this.sel;
    for (var r = s[0]; r <= s[2]; r++) for (var c = s[1]; c <= s[3]; c++) out.push(r * this.t.cols + c);
    return out;
  };
  Grid.prototype.select = function (a, b) {
    var p = this.rc(a), q = this.rc(b);
    this.sel = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
    this.markSel();
    if (this.opts.onSelect) this.opts.onSelect(this);
  };
  Grid.prototype.clearSel = function () { this.sel = null; this.markSel(); if (this.opts.onSelect) this.opts.onSelect(this); };
  Grid.prototype.markSel = function () {
    var on = {};
    this.selected().forEach(function (k) { on[k] = 1; });
    this.cells.forEach(function (td, k) { td.classList.toggle("vx-sel", !!on[k]); });
  };
  Grid.prototype.bind = function () {
    var self = this, dragging = false;
    if (!this.opts.editable) return;
    this.wrap.addEventListener("pointerdown", function (e) {
      var td = e.target.closest("td[data-k]");
      if (!td) return;
      var k = +td.dataset.k;
      if (e.pointerType === "mouse") {
        dragging = true;
        if (e.shiftKey && self.anchor != null) self.select(self.anchor, k);
        else { self.anchor = k; self.select(k, k); }
        e.preventDefault();
        self.wrap.focus({ preventScroll: true });
      }
    });
    this.wrap.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var el = document.elementFromPoint(e.clientX, e.clientY), td = el && el.closest && el.closest("td[data-k]");
      if (td && self.wrap.contains(td)) self.select(self.anchor, +td.dataset.k);
    });
    window.addEventListener("pointerup", function () { dragging = false; });
    // touch: a tap selects a cell; with "Range" on, a second tap selects everything between
    this.wrap.addEventListener("click", function (e) {
      var td = e.target.closest("td[data-k]");
      if (!td || self.lastPointer === "mouse") return;
      var k = +td.dataset.k;
      if (self.rangeMode && self.anchor != null) { self.select(self.anchor, k); self.rangeMode = false; if (self.opts.onSelect) self.opts.onSelect(self); }
      else { self.anchor = k; self.select(k, k); }
    });
    this.wrap.addEventListener("pointerdown", function (e) { self.lastPointer = e.pointerType; }, true);
    this.wrap.addEventListener("keydown", function (e) { self.key(e); });
  };
  Grid.prototype.key = function (e) {
    if (!this.sel) return;
    var k = e.key, s = this.sel, t = this.t;
    if (/^[0-9.]$/.test(k) || (k === "-" && this.opts.input && !this.opts.input.value)) {
      var inp = this.opts.input;
      if (inp) { inp.value = k; inp.focus(); e.preventDefault(); }
      return;
    }
    if (k === "Escape") { this.clearSel(); e.preventDefault(); return; }
    if (k === "+" || k === "=") { this.opts.act("inc"); e.preventDefault(); return; }
    if (k === "-" || k === "_") { this.opts.act("dec"); e.preventDefault(); return; }
    if (k === "i" || k === "I") { this.opts.act("interp"); e.preventDefault(); return; }
    if (k === "s" || k === "S") { this.opts.act("smooth"); e.preventDefault(); return; }
    var mv = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k];
    if (!mv) return;
    e.preventDefault();
    var head = this.focusCell != null ? this.rc(this.focusCell) : [s[0], s[1]];
    var r = Math.max(0, Math.min(t.rows - 1, head[0] + mv[0])), c = Math.max(0, Math.min(t.cols - 1, head[1] + mv[1]));
    this.focusCell = r * t.cols + c;
    if (e.shiftKey) this.select(this.anchor, this.focusCell);
    else { this.anchor = this.focusCell; this.select(this.focusCell, this.focusCell); }
  };
  Grid.prototype.cursor = function (fx, fy) {
    var dot = $(".lv-dot", this.el);
    if (this.last != null && this.cells[this.last]) this.cells[this.last].classList.remove("cur");
    this.last = null;
    if (!(fx === fx) || !(fy === fy)) { dot.hidden = true; return; }
    var t = this.t, c0 = Math.floor(fx), r0 = Math.floor(fy);
    var c1 = Math.min(t.cols - 1, c0 + 1), r1 = Math.min(t.rows - 1, r0 + 1), a = fx - c0, b = fy - r0;
    var near = Math.round(fy) * t.cols + Math.round(fx);
    if (this.cells[near]) { this.cells[near].classList.add("cur"); this.last = near; }
    var p = this.cells[r0 * t.cols + c0], q = this.cells[r1 * t.cols + c1];
    var px = p.offsetLeft + p.offsetWidth / 2, qx = q.offsetLeft + q.offsetWidth / 2;
    var py = p.offsetTop + p.offsetHeight / 2, qy = q.offsetTop + q.offsetHeight / 2;
    dot.hidden = false;
    dot.style.transform = "translate(" + (px + (qx - px) * a - 5) + "px," + (py + (qy - py) * b - 5) + "px)";
  };

  /* What an edit button does to the selected cells of a grid. */
  function act(grid, what, arg) {
    var t = grid.t, ks = grid.selected();
    if (!ks.length) return;
    var step = Math.pow(10, -t.d), s = grid.sel;
    if (what === "set") ks.forEach(function (k) { setValue(t, k, arg); });
    else if (what === "inc" || what === "dec") ks.forEach(function (k) { setValue(t, k, valueAt(t, k) + (what === "inc" ? step : -step)); });
    else if (what === "pct") ks.forEach(function (k) { setValue(t, k, valueAt(t, k) * (1 + arg / 100)); });
    else if (what === "revert") ks.forEach(function (k) { setValue(t, k, t.z[k]); });
    else if (what === "interp") {
      var C = t.cols, v00 = valueAt(t, s[0] * C + s[1]), v01 = valueAt(t, s[0] * C + s[3]);
      var v10 = valueAt(t, s[2] * C + s[1]), v11 = valueAt(t, s[2] * C + s[3]);
      ks.forEach(function (k) {
        var r = Math.floor(k / C), c = k % C;
        var fx = s[3] > s[1] ? (t.x[c] - t.x[s[1]]) / (t.x[s[3]] - t.x[s[1]]) : 0;
        var fy = s[2] > s[0] ? (t.y[r] - t.y[s[0]]) / (t.y[s[2]] - t.y[s[0]]) : 0;
        setValue(t, k, (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy);
      });
    } else if (what === "smooth") {
      var src = {};
      ks.forEach(function (k) { src[k] = valueAt(t, k); });
      ks.forEach(function (k) {
        var r = Math.floor(k / t.cols), c = k % t.cols, sum = 0, n = 0;
        for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
          var rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= t.rows || cc < 0 || cc >= t.cols) continue;
          var w = dr || dc ? 1 : 2, kk = rr * t.cols + cc;
          sum += w * (kk in src ? src[kk] : valueAt(t, kk)); n += w;
        }
        setValue(t, k, sum / n);
      });
    }
    editsChanged(t);
  }
  function editsChanged(t) {
    saveEdits();
    allGrids().forEach(function (g) { if (!t || g.t === t) g.paint(); });
    renderSaveBars();
  }
  function allGrids() {
    var out = tableSlots.map(function (s) { return s.grid; });
    if (ve.grid && !ve.running) out.push(ve.grid);
    return out.filter(Boolean);
  }

  /* ---------- the tables beside the graphs ---------- */
  function toolbar(prefix) {
    return '<div class="lv-tools" hidden>' +
      '<input type="text" inputmode="decimal" class="lv-tin" aria-label="Value for the selected cells" placeholder="Value">' +
      '<button type="button" data-t="set" title="Set the selected cells (Enter)">Set</button>' +
      '<button type="button" data-t="dec" title="Down one step (−)">−</button>' +
      '<button type="button" data-t="inc" title="Up one step (+)">+</button>' +
      '<button type="button" data-t="pct" data-arg="-1" title="1% less">−1%</button>' +
      '<button type="button" data-t="pct" data-arg="1" title="1% more">+1%</button>' +
      '<button type="button" data-t="interp" title="Fill between the corners of the selection (I)">Interp</button>' +
      '<button type="button" data-t="smooth" title="Smooth the selection (S)">Smooth</button>' +
      '<button type="button" data-t="revert" title="Back to the tune\'s values">Revert</button>' +
      '<button type="button" data-t="range" class="lv-touch" title="Tap two cells to select everything between">Range</button>' +
      "</div>";
  }
  function wireTools(box, getGrid) {
    var tools = $(".lv-tools", box), input = $(".lv-tin", box);
    tools.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-t]"), g = getGrid();
      if (!b || !g) return;
      var what = b.dataset.t;
      if (what === "range") { g.rangeMode = !g.rangeMode; b.classList.toggle("on", g.rangeMode); return; }
      if (what === "set") {
        var v = parseFloat(input.value);
        if (!(v === v)) { input.focus(); return; }
        act(g, "set", v); input.value = "";
      } else act(g, what, b.dataset.arg ? +b.dataset.arg : undefined);
      g.wrap.focus({ preventScroll: true });
    });
    input.addEventListener("keydown", function (e) {
      var g = getGrid();
      if (e.key === "Enter" && g) { var v = parseFloat(input.value); if (v === v) { act(g, "set", v); input.value = ""; g.wrap.focus({ preventScroll: true }); } e.preventDefault(); }
      if (e.key === "Escape" && g) { input.value = ""; g.wrap.focus({ preventScroll: true }); }
    });
    return { tools: tools, input: input };
  }
  function buildSlot(slot) {
    var t = slot.t;
    var opts = idx.tables.map(function (o, i) { return "<option value=" + i + (o === t ? " selected" : "") + ">" + esc(o.label) + "</option>"; }).join("");
    slot.el.innerHTML = '<div class="lv-th"><select aria-label="Table">' + opts + '</select><span class="lv-tv mono"></span></div>' +
      '<div class="lv-grid"></div>' + toolbar() +
      '<p class="lv-tn">' + esc((t.yl || "Load") + (t.yu ? " (" + t.yu + ")" : "") + " ↑ · " + (t.xl || "RPM") + (t.xu ? " (" + t.xu + ")" : "") + " →") +
      (t.xc == null || t.yc == null ? " · no matching channel in this log, so no cursor" : "") + " · select cells to edit</p>";
    var w = wireTools(slot.el, function () { return slot.grid; });
    slot.grid = new Grid($(".lv-grid", slot.el), t, {
      editable: true, input: w.input, act: function (what) { act(slot.grid, what); },
      onSelect: function (g) { w.tools.hidden = !g.sel; }
    });
    load(t.xc); load(t.yc);
  }
  function tablePos(t) {
    var dx = got(t.xc), dy = got(t.yc);
    if (!dx || !dy) return null;
    var fx = where(t.x, dx.v[cur]), fy = where(t.y, dy.v[cur] * t.ya + t.yb);
    return fx === fx && fy === fy ? [fx, fy] : null;
  }
  function interpTable(t, z, fx, fy) {
    var c0 = Math.floor(fx), r0 = Math.floor(fy), c1 = Math.min(t.cols - 1, c0 + 1), r1 = Math.min(t.rows - 1, r0 + 1);
    var a = fx - c0, b = fy - r0, at = function (r, c) { return z(r * t.cols + c); };
    return (at(r0, c0) * (1 - a) + at(r0, c1) * a) * (1 - b) + (at(r1, c0) * (1 - a) + at(r1, c1) * a) * b;
  }
  function drawTables() {
    tableSlots.forEach(function (slot) {
      var t = slot.t, pos = tablePos(t), out = $(".lv-tv", slot.el);
      if (!pos) { slot.grid.cursor(NaN, NaN); out.textContent = ""; return; }
      slot.grid.cursor(pos[0], pos[1]);
      var v = interpTable(t, function (k) { return t.z[k]; }, pos[0], pos[1]);
      out.textContent = v.toFixed(Math.max(1, t.d)) + (t.units ? " " + t.units : "");
    });
  }

  /* ---------- saving edits as a new tune ---------- */
  function renderSaveBars() {
    var n = editCount(), tablesN = Object.keys(edits).length;
    $$(".lv-save").forEach(function (bar) {
      bar.hidden = !n;
      var label = $(".lv-save-n", bar);
      if (label) label.textContent = plural(n, "changed cell") + (tablesN > 1 ? " in " + tablesN + " tables" : "");
    });
  }
  function saveBar() {
    return '<div class="lv-save" hidden><span class="lv-save-n"></span><span class="st-grow"></span>' +
      '<button class="btn sm" type="button" data-save-discard>Discard</button>' +
      '<button class="btn sm primary" type="button" data-save-tune>Save as new tune</button></div>';
  }
  function saveTune(btn) {
    if (!TUNE || !editCount()) return;
    var label = btn.querySelector("span") || btn, old = label.textContent;
    btn.disabled = true; label.textContent = "Saving…";
    fetch("/t/" + TUNE + "/save", {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ changes: edits })
    }).then(function (r) { return r.json().then(function (j) { return [r.ok, j]; }); }).then(function (res) {
      btn.disabled = false; label.textContent = old;
      if (!res[0] || !res[1].slug) { alert(res[1].error || "That didn't save. Try again."); return; }
      var slug = res[1].slug;
      edits = {}; editsChanged();
      var dlg = $d('[data-dlg="saved"]');
      $d("[data-saved-download]").href = "/t/" + slug + ".msq";
      $d("[data-saved-open]").href = "/t/" + slug;
      $d("[data-saved-continue]").href = urlWithTune(slug);
      dlg.hidden = false;
    }, function () { btn.disabled = false; label.textContent = old; alert("That didn't save. Check your connection and try again."); });
  }
  function urlWithTune(slug) {
    var params = new URLSearchParams(location.search);
    if (slug) params.set("tune", slug); else params.set("tune", "none");
    return location.pathname + "?" + params.toString() + location.hash;
  }

  /* ---------- VE Analyze ---------- */
  var ve = { running: false, engine: null, grid: null, table: null, result: null };
  function veTable() { return idx.tables.filter(function (t) { return t.id === "ve"; })[0] || null; }
  function needs() {
    var t = veTable(), r = idx.roles || {}, why = [];
    if (!TUNE) why.push("a tune: add the tune this log was recorded with (or the one you want corrected)");
    else if (!t) why.push("a VE table in the tune");
    else if (t.xc == null || t.yc == null) why.push("RPM and load channels in the log for the VE table's axes");
    if (r.lambda == null) why.push("a wideband channel (AFR or lambda) in the log");
    if (r.lambda_target == null && !idx.tables.some(function (x) { return x.id === "afr"; })) why.push("an AFR target channel, or an AFR/lambda target table in the tune");
    return why;
  }
  function afrText(lambda) { return (lambda * stoich).toFixed(1); }
  function buildVE() {
    var body = $(".lv-ve-body"), t = veTable(), missing = needs();
    ve.table = t;
    if (missing.length) {
      body.innerHTML = '<div class="lv-ve-need"><h3>VE Analyze needs</h3><ul>' + missing.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") +
        "</ul>" + (!TUNE ? '<button class="btn primary" type="button" data-lv-tune>Add tune</button>' : "") + "</div>";
      return;
    }
    var also = (root.dataset.also || "").split(",").filter(Boolean);
    var opt = function (name, label, value, step, hint) {
      return '<label class="lv-opt"><span>' + label + "</span><input type=\"number\" step=\"" + step + "\" data-o=\"" + name + "\" value=\"" + value + "\">" +
        (hint ? "<small>" + hint + "</small>" : "") + "</label>";
    };
    body.innerHTML =
      '<div class="lv-ve-top">' +
        '<div class="lv-ve-ctl">' +
          '<button class="btn primary" type="button" data-ve="run">▶ Run VE Analyze</button>' +
          '<button class="btn" type="button" data-ve="stop" hidden>Stop</button>' +
          '<select data-ve-speed aria-label="How fast to play through the log"><option value="25">Watch it (25 s)</option><option value="10" selected>Quick (10 s)</option><option value="0">Instant</option></select>' +
          '<select data-ve-mode aria-label="What the cells show"><option value="value">New VE</option><option value="change">Change %</option><option value="hits">Data (s)</option><option value="ran">VE that ran</option></select>' +
        "</div>" +
        '<p class="lv-ve-status mono" aria-live="polite">Plays through the log and works out each VE cell from the wideband. Nothing is changed until you save.</p>' +
        '<div class="lv-ve-bar"><i></i></div>' +
      "</div>" +
      '<div class="lv-ve-warn" hidden></div>' +
      '<div class="lv-ve-main"><div class="lv-ve-gridbox"><div class="lv-th"><b>' + esc(t.label) + '</b><span class="lv-tv mono"></span></div><div class="lv-grid"></div>' + toolbar() +
        '<p class="lv-tn">' + esc((t.yl || "Load") + (t.yu ? " (" + t.yu + ")" : "") + " ↑ · " + (t.xl || "RPM") + " →") + " · after a run, select cells to adjust them</p></div>" +
        '<div class="lv-ve-side">' +
          '<div class="lv-ve-why"></div>' +
          '<details class="lv-ve-set"><summary>Filters &amp; settings</summary>' +
            opt("minClt", "Min coolant", 70, 1, "°C") +
            opt("maxChange", "Max change per cell", 25, 1, "%") +
            opt("minData", "Data for full change", 0.5, 0.1, "s per cell") +
            opt("tpsRate", "Throttle moving faster than", 30, 1, "%/s") +
            opt("mapRate", "MAP moving faster than", 80, 1, "kPa/s") +
            opt("holdoff", "Wait after a transient", 0.35, 0.05, "s") +
            '<label class="lv-opt"><span>Wideband delay</span><input type="number" step="10" data-o="lagms" placeholder="Auto"><small>ms · empty = measure it</small></label>' +
            '<label class="lv-opt"><span>Smoothing</span><select data-o="smooth"><option value="0">None</option><option value="0.15" selected>Light</option><option value="0.35">Medium</option><option value="0.6">Strong</option></select></label>' +
            '<label class="check sm"><input type="checkbox" data-o="skipIdle"' + (idx.tune && idx.tune.idle_ve ? " checked" : "") + "><span>Skip idle" + (idx.tune && idx.tune.idle_ve ? " (this tune uses a separate idle VE table)" : "") + "</span></label>" +
          "</details>" +
          (also.length ? '<div class="lv-ve-logs"><b>Logs to use</b><label class="check sm"><input type="checkbox" checked disabled><span>This log</span></label>' +
            also.map(function (s, i) { return '<label class="check sm"><input type="checkbox" data-also="' + s + '" checked><span>Uploaded with it #' + (i + 1) + "</span></label>"; }).join("") + "</div>" : "") +
          saveBar() +
        "</div>" +
      "</div>";
    var w = wireTools(body, function () { return ve.running ? null : ve.grid; });
    ve.grid = new Grid($(".lv-grid", body), t, {
      big: true, editable: true, input: w.input,
      act: function (what) { if (!ve.running) act(ve.grid, what); },
      onSelect: function (g) { w.tools.hidden = !g.sel || ve.running; },
      info: { hits: function (k) { return ve.engine ? ve.engine.hits[k] : 0; }, ran: function (k) { return ve.engine ? ve.engine.ran(k) : t.z[k]; } }
    });
    $("[data-ve-mode]").addEventListener("change", function () {
      ve.grid.mode = this.value; ve.grid.paint();
    });
    renderSaveBars();
    if (also.length) also.forEach(function (s, i) {
      fetch("/l/" + s + "/index.json" + query).then(function (r) { return r.json(); }).then(function (j) {
        var lab = $('[data-also="' + s + '"] + span');
        if (lab) lab.textContent = (j.title ? "" : "") + "Uploaded with it: " + fmtLen(j.seconds) + ", " + j.rows.toLocaleString() + " records";
      }).catch(function () { /* still usable */ });
    });
  }
  function fmtLen(s) { return s >= 60 ? Math.floor(s / 60) + " min " + Math.round(s % 60) + " s" : (s || 0).toFixed(1) + " s"; }
  function veOpts() {
    var o = {};
    $$("[data-o]").forEach(function (el) {
      var k = el.dataset.o;
      if (el.type === "checkbox") o[k] = el.checked;
      else if (el.value !== "") o[k] = +el.value;
    });
    if (o.lagms != null) { o.lag = o.lagms / 1000; delete o.lagms; } else o.lag = "auto";
    return o;
  }
  /* Everything VE Analyze reads from one log, as arrays (λ as lambda). */
  function veData(meta, get) {
    var t = meta.tables.filter(function (x) { return x.id === "ve"; })[0], R = meta.roles;
    var need = { T: "t", rpm: t.xc, load: t.yc, lam: R.lambda, tgt: R.lambda_target, ve: R.ve, trim: R.ego_corr,
                 clt: R.clt, tps: R.tps, map: R.map, fuel: R.pw, ae: R.ae_active, dfco: R.dfco, lamOk: R.lambda_ok,
                 idle: R.idle_active, duty: R.inj_duty };
    var afr = meta.tables.filter(function (x) { return x.id === "afr"; })[0], afrY = afr ? afr.yc : null;
    var names = Object.keys(need).filter(function (k) { return need[k] != null; });
    var extra = !need.tgt && afr ? [afr.xc, afrY] : [];
    return Promise.all(names.map(function (k) { return get(need[k]); }).concat(extra.map(get))).then(function (arrs) {
      var d = {};
      names.forEach(function (k, i) { d[k] = arrs[i]; });
      var lamDiv = (meta.lam && meta.lam.lambda) || 1, tgtDiv = (meta.lam && meta.lam.lambda_target) || 1;
      if (lamDiv !== 1) d.lam = d.lam.map(function (v) { return v / lamDiv; });
      if (d.tgt && tgtDiv !== 1) d.tgt = d.tgt.map(function (v) { return v / tgtDiv; });
      if (!d.tgt && afr) {  // no target channel: look the target up in the tune's own table
        var xs = arrs[names.length], ys = arrs[names.length + 1], div = afr.lam || stoich, n = d.T.length;
        d.tgt = new Float32Array(n);
        for (var i = 0; i < n; i++) {
          var fx = where(afr.x, xs[i]), fy = where(afr.y, ys[i] * afr.ya + afr.yb);
          d.tgt[i] = fx === fx && fy === fy ? interpTable(afr, function (k) { return afr.z[k]; }, fx, fy) / div : NaN;
        }
      }
      if (t.ya !== 1 || t.yb !== 0) d.load = d.load.map(function (v) { return v * t.ya + t.yb; });
      if (d.trim) d.trimMode = meta.channels[R.ego_corr].hi > 50 ? "pct100" : "pct0";
      return d;
    });
  }
  function runVE() {
    if (ve.running) return;
    if (playing) play(false);
    var t = ve.table, speedS = +$("[data-ve-speed]").value, opts = veOpts();
    var others = $$("[data-also]").filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.also; });
    var status = $(".lv-ve-status"), bar = $(".lv-ve-bar i");
    ve.running = true; ve.result = null;
    root.classList.add("ve-running");
    $('[data-ve="run"]').hidden = true; $('[data-ve="stop"]').hidden = false;
    $(".lv-ve-warn").hidden = true;
    ve.grid.clearSel();
    status.textContent = "Loading the channels VE Analyze reads…";
    var engine = VEAL.create(t, opts);
    ve.engine = engine;
    ve.grid.opts.live = function (k) { return engine.current(k); };
    ve.grid.paint();
    var jobs = others.map(function (s) {
      return fetch("/l/" + s + "/index.json" + query).then(function (r) { return r.json(); }).then(function (meta) {
        if (!meta.tables.some(function (x) { return x.id === "ve"; })) return null;
        return veData(meta, function (c) { return fetchF32("/l/" + s + "/ch/" + c); }).then(function (d) { return { d: d, own: false }; });
      }).catch(function () { return null; });
    });
    jobs.push(veData(idx, function (c) { return c === "t" ? Promise.resolve(T) : load(c).then(function (x) { return x && x.v; }); })
      .then(function (d) { return { d: d, own: true }; }));
    Promise.all(jobs).then(function (logs) {
      logs = logs.filter(Boolean);
      var li = 0, i = 0, cur0 = cur, data = null, lagInfo = null;
      function next() {
        if (li >= logs.length) return done();
        data = logs[li].d;
        lagInfo = engine.begin(data);
        i = 0;
        if (logs[li].own) setView(tMin, tMax);
        frame();
      }
      function frame() {
        if (!ve.running) return done(true);
        var n = data.T.length, per = speedS ? Math.max(50, Math.ceil(n / (speedS * 60 / logs.length))) : n, touched = {};
        var end = Math.min(n, i + per), lastUsed = -1;
        for (; i < end; i++) { var k = engine.step(i); if (k >= 0) { touched[k] = 1; lastUsed = i; } }
        var ks = Object.keys(touched).map(Number);
        if (speedS) {
          ve.grid.paint(ks);
          ks.forEach(function (k) { ve.grid.flash(k); });
          if (logs[li].own) { cur = Math.min(N - 1, i - 1); follow(); }
          var pos = lastUsed >= 0 ? [where(t.x, data.rpm[lastUsed]), where(t.y, data.load[lastUsed])] : null;
          if (pos) ve.grid.cursor(pos[0], pos[1]);
          if (lastUsed >= 0) {
            var j = Math.min(n - 1, lastUsed + Math.round(lagInfo.lag / ((data.T[n - 1] - data.T[0]) / n || 0.01)));
            $(".lv-tv", $(".lv-ve-gridbox")).textContent = data.rpm[lastUsed].toFixed(0) + " rpm · " + data.load[lastUsed].toFixed(0) +
              " · AFR " + afrText(data.lam[j]) + " / " + afrText(data.tgt[lastUsed]);
          }
          invalidate();
        }
        var frac = (li + i / n) / logs.length;
        bar.style.width = (frac * 100).toFixed(1) + "%";
        status.textContent = (logs.length > 1 ? "Log " + (li + 1) + " of " + logs.length + " · " : "") + Math.round(frac * 100) + "% · " +
          plural(engine.stats.used, "sample") + " used · wideband delay " + Math.round(lagInfo.lag * 1000) + " ms" + (lagInfo.measured ? " (measured)" : "");
        renderWhy();
        if (i >= n) { li++; return speedS ? requestAnimationFrame(next) : next(); }
        if (speedS) requestAnimationFrame(frame); else frame();
      }
      function done(stopped) {
        if (!ve.running && !stopped) return;
        ve.running = false;
        root.classList.remove("ve-running");
        $('[data-ve="run"]').hidden = false; $('[data-ve="stop"]').hidden = true;
        $('[data-ve="run"]').textContent = "▶ Run again";
        bar.style.width = "100%";
        if (stopped && engine.stats.used === 0) { ve.grid.opts.live = null; ve.grid.paint(); status.textContent = "Stopped."; return; }
        status.textContent = "Solving the best fit for every sample…";
        setTimeout(function () { finishVE(engine, stopped, cur0); }, 30);
      }
      next();
    }).catch(function () {
      ve.running = false; root.classList.remove("ve-running");
      $('[data-ve="run"]').hidden = false; $('[data-ve="stop"]').hidden = true;
      status.textContent = "The log couldn't be loaded for VE Analyze. Reload the page and try again.";
    });
  }
  function renderWhy() {
    var e = ve.engine;
    if (!e) return;
    var total = e.stats.total || 1;
    $(".lv-ve-why").innerHTML = "<b>Samples</b><ul>" + e.summary().map(function (s) {
      return '<li class="' + (s.key === "used" ? "use" : "") + '"><span>' + esc(s.label) + "</span><b class=\"mono\">" + (s.n / total * 100).toFixed(1) + "%</b></li>";
    }).join("") + "</ul>";
  }
  function finishVE(engine, stopped, cur0) {
    var t = ve.table, res = engine.finish();
    ve.result = res;
    ve.grid.opts.live = null;
    // the result becomes the VE table's edits, so it can be adjusted by hand and saved with anything else
    delete edits[t.name];
    res.changed.forEach(function (c) { setValue(t, c.i, c.to); });
    editsChanged(t);
    ve.grid.paint();
    res.changed.forEach(function (c) { ve.grid.flash(c.i); });
    cur = cur0; invalidate();
    renderWhy();
    var status = $(".lv-ve-status");
    if (!res.changed.length) {
      status.textContent = (stopped ? "Stopped. " : "") + "No cell needs changing: " +
        (res.stats.used ? "the mixture matched the target wherever the log had enough data." : "none of the log could be used (see why on the right).");
    } else {
      var other = res.mismatch != null && res.mismatch > 4;
      // Against a tune that never ran, "change" means little: measure it against what the ECU actually ran.
      var vsRan = res.changed.map(function (c) { return c.ran ? (c.to / c.ran - 1) * 100 : 0; });
      var pcts = other ? vsRan : res.changed.map(function (c) { return c.pct; });
      var bi = 0;
      pcts.forEach(function (p, i) { if (Math.abs(p) > Math.abs(pcts[bi])) bi = i; });
      var avgP = pcts.reduce(function (s, p) { return s + Math.abs(p); }, 0) / pcts.length, big = res.changed[bi];
      var richer = pcts.filter(function (p) { return p > 0.05; }).length, leaner = pcts.filter(function (p) { return p < -0.05; }).length;
      status.textContent = (stopped ? "Stopped early. " : "Done. ") + plural(res.changed.length, "cell") + " changed" +
        (other ? " from this tune. Against the VE the ECU actually ran: " : ": ") + richer + " richer, " + leaner + " leaner, " +
        avgP.toFixed(1) + "% on average, biggest " + (pcts[bi] > 0 ? "+" : "") + pcts[bi].toFixed(1) + "% at " +
        binText(t.x[big.i % t.cols]) + " rpm / " + binText(t.y[Math.floor(big.i / t.cols)]) + (t.yu ? " " + t.yu : "") +
        ". Save it as a new tune, or adjust cells first.";
    }
    var warn = $(".lv-ve-warn");
    if (res.mismatch != null && res.mismatch > 4) {
      warn.hidden = false;
      warn.innerHTML = "<b>This tune isn't the one the log was recorded with.</b> Its VE table is " + res.mismatch.toFixed(0) +
        "% away from the VE the ECU logged on average. VE Analyze rebuilt the table the ECU actually ran from the log and corrected that, so the cells the log covered are right; cells it didn't cover keep this tune's values. Switch <em>Change %</em> to <em>VE that ran</em> to see it.";
    } else warn.hidden = true;
  }

  /* ---------- scatter plot ---------- */
  var scCache = document.createElement("canvas"), scGeom = null;
  function drawScatter() {
    var cv = $(".lv-scatter-cv"), f = fit(cv), ctx = f.ctx, W = f.w, H = f.h;
    if (W < 10) return;
    var dx = got(sc.x), dy = got(sc.y), dz = got(sc.z);
    if (scatterDirty || scCache.width !== cv.width || scCache.height !== cv.height) {
      scatterDirty = false;
      scCache.width = cv.width; scCache.height = cv.height;
      var c2 = scCache.getContext("2d"), dpr = window.devicePixelRatio || 1;
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.fillStyle = "#000"; c2.fillRect(0, 0, W, H);
      scGeom = null;
      if (dx && dy) {
        var only = $("[data-sc-range]").checked;
        var i0 = only ? Math.max(0, lower(view.t0)) : 0, i1 = only ? Math.min(N - 1, lower(view.t1)) : N - 1;
        var stride = Math.max(1, Math.floor((i1 - i0) / 60000)), i;
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (i = i0; i <= i1; i += stride) {
          var a = dx.v[i], b = dy.v[i];
          if (a !== a || b !== b) continue;
          if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b;
          if (dz) { var q = dz.v[i]; if (q === q) { if (q < z0) z0 = q; if (q > z1) z1 = q; } }
        }
        if (x0 <= x1) {
          var L = 70, R = dz ? 64 : 14, Tp = 12, B = 34;
          var kx = (W - L - R) / ((x1 - x0) || 1), ky = (H - Tp - B) / ((y1 - y0) || 1);
          scGeom = { x0: x0, y0: y0, kx: kx, ky: ky, L: L, B: B, H: H };
          c2.strokeStyle = "#2a2e33"; c2.fillStyle = "#9aa1a9"; c2.font = "11px ui-monospace, Menlo, Consolas, monospace";
          var mx = idx.channels[sc.x], my = idx.channels[sc.y];
          for (var g = 0; g <= 4; g++) {
            var gx = L + (W - L - R) * g / 4, gy = H - B - (H - Tp - B) * g / 4;
            c2.beginPath(); c2.moveTo(gx + 0.5, Tp); c2.lineTo(gx + 0.5, H - B); c2.moveTo(L, gy + 0.5); c2.lineTo(W - R, gy + 0.5); c2.stroke();
            c2.textAlign = "center"; c2.textBaseline = "top"; c2.fillText(fmt(x0 + (x1 - x0) * g / 4, mx.d), gx, H - B + 5);
            c2.textAlign = "right"; c2.textBaseline = "middle"; c2.fillText(fmt(y0 + (y1 - y0) * g / 4, my.d), L - 6, gy);
          }
          c2.textAlign = "center"; c2.textBaseline = "bottom"; c2.fillStyle = "#d6d9de";
          c2.fillText(mx.n + (mx.u ? " (" + mx.u + ")" : ""), L + (W - L - R) / 2, H - 2);
          c2.save(); c2.translate(11, Tp + (H - Tp - B) / 2); c2.rotate(-Math.PI / 2); c2.textBaseline = "middle";
          c2.fillText(my.n + (my.u ? " (" + my.u + ")" : ""), 0, 0); c2.restore();
          for (i = i0; i <= i1; i += stride) {
            var xv = dx.v[i], yv = dy.v[i];
            if (xv !== xv || yv !== yv) continue;
            var zv = dz ? dz.v[i] : NaN;
            c2.fillStyle = zv === zv ? heat(z1 > z0 ? (zv - z0) / (z1 - z0) : 0.5) : "#ffe14d";
            c2.fillRect(L + (xv - x0) * kx - 1, H - B - (yv - y0) * ky - 1, 2.5, 2.5);
          }
          if (dz && z0 <= z1) {
            var mz = idx.channels[sc.z];
            for (var s = 0; s < H - Tp - B; s++) { c2.fillStyle = heat(1 - s / (H - Tp - B)); c2.fillRect(W - R + 14, Tp + s, 10, 1.5); }
            c2.fillStyle = "#9aa1a9"; c2.textAlign = "left"; c2.textBaseline = "top"; c2.fillText(fmt(z1, mz.d), W - R + 28, Tp);
            c2.textBaseline = "bottom"; c2.fillText(fmt(z0, mz.d), W - R + 28, H - B);
          }
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(scCache, 0, 0);
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    if (!dx || !dy) {
      ctx.fillStyle = "#9aa1a9"; ctx.font = "13px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(sc.x < 0 || sc.y < 0 ? "Choose an X and a Y channel above" : "Loading…", W / 2, H / 2);
    } else if (scGeom) {
      var px = scGeom.L + (dx.v[cur] - scGeom.x0) * scGeom.kx, py = scGeom.H - scGeom.B - (dy.v[cur] - scGeom.y0) * scGeom.ky;
      if (px === px && py === py) {
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 6, 0, 6.3); ctx.stroke();
        ctx.strokeStyle = "#39e6ff"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, 9, 0, 6.3); ctx.stroke();
      }
    }
  }
  function scButtons() {
    $$("[data-sc]").forEach(function (b) {
      var k = b.dataset.sc, c = sc[k];
      b.innerHTML = "<small>" + k.toUpperCase() + (k === "z" ? " (color)" : "") + "</small> " + (c >= 0 ? esc(idx.channels[c].n) : "None");
    });
  }

  /* ---------- drawing everything ---------- */
  var vePane = null;
  function invalidate() {
    if (dirty || !idx) return;
    dirty = true;
    requestAnimationFrame(function () {
      dirty = false;
      if (tab === "graphs") panes.slice(0, paneCount).forEach(function (p, i) { drawPane(p, i === paneCount - 1); });
      else if (tab === "scatter") drawScatter();
      else if (tab === "ve" && vePane) drawPane(vePane, true);
      drawOverview(); drawGauges(); drawStatus(); drawTables();
      if (tab === "ve" && ve.grid && !ve.running) {
        var pos = tablePos(ve.table);
        ve.grid.cursor(pos ? pos[0] : NaN, pos ? pos[1] : NaN);
      }
    });
  }

  /* ---------- panes ---------- */
  var graphs = $(".lv-graphs");
  function names(p) {
    p.names.innerHTML = p.ch.map(function (c, k) {
      return '<button type="button" data-slot="' + k + '" style="color:' + COLORS[p.i][k] + '"' + (c < 0 ? ' class="empty"' : "") +
        ' title="' + (c < 0 ? "Add a channel" : "Change or remove this channel") + '">' + (c < 0 ? "+" : esc(idx.channels[c].n)) + "</button>";
    }).join("");
  }
  function makePane(p, host) {
    p.el = document.createElement("div"); p.el.className = "lv-pane";
    p.cv = document.createElement("canvas");
    p.names = document.createElement("div"); p.names.className = "lv-names";
    p.el.appendChild(p.cv); p.el.appendChild(p.names);
    host.appendChild(p.el);
    names(p);
    scrub(p.cv, false);
    p.names.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      var k = +b.dataset.slot;
      pick(b, p.ch[k], true, function (c) {
        p.ch[k] = c; names(p); load(c); invalidate(); saveSoon(); if (!p.ve) saveLayout();
      });
    });
    p.ch.forEach(load);
  }
  function buildPanes() {
    graphs.innerHTML = "";
    panes.forEach(function (p, i) {
      p.i = i;
      makePane(p, graphs);
      p.el.hidden = i >= paneCount;
    });
    $("[data-lv-count]").value = String(paneCount);
  }

  /* ---------- pointer: scrub, pan, pinch ---------- */
  function scrub(cv, overview) {
    var pts = {}, pinch = null, drag = null;
    function tAt(e) {
      var r = cv.getBoundingClientRect(), f = (e.clientX - r.left) / r.width;
      return overview ? tMin + f * (tMax - tMin) : view.t0 + f * (view.t1 - view.t0);
    }
    cv.addEventListener("pointerdown", function (e) {
      if (e.button || ve.running) return;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
      pts[e.pointerId] = e.clientX;
      var ids = Object.keys(pts);
      if (ids.length === 2 && !overview) {
        pinch = { d: Math.abs(pts[ids[0]] - pts[ids[1]]) || 1, t0: view.t0, t1: view.t1, mid: (pts[ids[0]] + pts[ids[1]]) / 2 };
        drag = null;
        return;
      }
      if (playing) play(false);
      var t = tAt(e);
      if (overview) {
        var inside = t >= view.t0 && t <= view.t1;
        drag = { off: inside ? t - view.t0 : (view.t1 - view.t0) / 2 };
        setView(t - drag.off, t - drag.off + (view.t1 - view.t0));
      } else { drag = {}; setCursor(nearest(t)); }
    });
    cv.addEventListener("pointermove", function (e) {
      if (!(e.pointerId in pts)) return;
      pts[e.pointerId] = e.clientX;
      var ids = Object.keys(pts);
      if (pinch && ids.length === 2) {
        var r = cv.getBoundingClientRect(), d = Math.abs(pts[ids[0]] - pts[ids[1]]) || 1;
        var span = (pinch.t1 - pinch.t0) * pinch.d / d, mid = (pts[ids[0]] + pts[ids[1]]) / 2;
        var anchor = pinch.t0 + (pinch.mid - r.left) / r.width * (pinch.t1 - pinch.t0);
        var t0 = anchor - (mid - r.left) / r.width * span;
        setView(t0, t0 + span);
        return;
      }
      if (!drag) return;
      var t = tAt(e);
      if (overview) setView(t - drag.off, t - drag.off + (view.t1 - view.t0));
      else setCursor(nearest(t));
    });
    ["pointerup", "pointercancel"].forEach(function (ev) {
      cv.addEventListener(ev, function (e) { delete pts[e.pointerId]; pinch = null; if (!Object.keys(pts).length) drag = null; });
    });
    cv.addEventListener("wheel", function (e) {
      e.preventDefault();
      var span = view.t1 - view.t0, r = cv.getBoundingClientRect();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        pan((e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) / r.width * span);
      } else {
        var unit = e.deltaMode === 1 ? 33 : 1;
        zoom(Math.exp(e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016)), overview ? tAt(e) : view.t0 + (e.clientX - r.left) / r.width * span);
      }
    }, { passive: false });
    if (!overview) cv.addEventListener("dblclick", function (e) { zoom(0.5, tAt(e)); });
  }

  /* ---------- channel picker ---------- */
  var pop = $d(".lv-pop"), popIn = pop.querySelector("input"), popList = pop.querySelector("ul"), popDone = null;
  function pick(anchor, current, allowNone, done) {
    popDone = done;
    pop.hidden = false;
    var r = anchor.getBoundingClientRect();
    if (window.innerWidth >= 760) {
      pop.style.left = Math.max(8, Math.min(window.innerWidth - 328, r.left)) + "px";
      pop.style.top = Math.max(8, Math.min(window.innerHeight - 380, r.bottom + 4)) + "px";
    } else { pop.style.left = pop.style.top = ""; }
    popIn.value = "";
    var render = function () {
      var q = popIn.value.trim().toLowerCase().split(/\s+/).filter(Boolean), html = [], flat = [];
      if (allowNone && !q.length) html.push('<li data-c="-1" class="none">None (remove)</li>');
      idx.channels.forEach(function (m, i) {
        var name = m.n.toLowerCase();
        if (m.lo == null && i !== current) return;  // nothing was logged on it
        for (var k = 0; k < q.length; k++) if (name.indexOf(q[k]) < 0) return;
        (m.lo === m.hi ? flat : html).push('<li data-c="' + i + '"' + (i === current ? ' class="on"' : "") + ">" + esc(m.n) +
          (m.u ? " <small>" + esc(m.u) + "</small>" : "") + (m.lo === m.hi ? " <small>never changes</small>" : "") + "</li>");
      });
      popList.innerHTML = html.concat(flat).join("") || '<li class="none">No channel matches</li>';
      var on = popList.querySelector(".on");
      if (on && !q.length) popList.scrollTop = on.offsetTop - 60;
    };
    popIn.oninput = render;
    render();
    if (window.innerWidth >= 760) popIn.focus();
  }
  function closePick() { pop.hidden = true; popDone = null; }
  popList.addEventListener("click", function (e) {
    var li = e.target.closest("li[data-c]");
    if (!li || !popDone) return;
    var done = popDone;
    closePick();
    done(+li.dataset.c);
  });
  popIn.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { var li = popList.querySelector("li[data-c]:not(.none)") || popList.querySelector("li[data-c]"); if (li) li.click(); }
    if (e.key === "Escape") closePick();
  });
  document.addEventListener("pointerdown", function (e) {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".lv-names, .lv-gadd, [data-sc]")) closePick();
  });

  /* ---------- remembering the layout ---------- */
  var saveTimer = 0;
  function hash() {
    return "#p=" + panes.map(function (p) { return p.ch.map(function (c) { return c < 0 ? "-" : c; }).join("."); }).join("/") +
      "&n=" + paneCount + "&c=" + cur + "&v=" + view.t0.toFixed(2) + "-" + view.t1.toFixed(2) + (tab !== "graphs" ? "&tab=" + tab : "");
  }
  var lastHash = "";
  function saveNow() { lastHash = hash(); try { history.replaceState(null, "", lastHash); } catch (e) { /* file: or sandboxed */ } }
  // A shared link pasted into a tab that already has this log open: open it at that moment.
  window.addEventListener("hashchange", function () { if (location.hash && location.hash !== lastHash) location.reload(); });
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function saveLayout() {
    try {
      localStorage.setItem("msq.lv.layout", JSON.stringify({
        n: paneCount, w: watch.map(function (c) { return idx.channels[c].n; }),
        p: panes.map(function (p) { return p.ch.map(function (c) { return c < 0 ? "" : idx.channels[c].n; }); })
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function byName(name) {
    if (!name) return -1;
    for (var i = 0; i < idx.channels.length; i++) if (idx.channels[i].n === name && idx.channels[i].lo != null) return i;
    return -1;
  }
  var startHash = {};
  function initialLayout() {
    var pad = function (a) { a = a.slice(0, SLOTS); while (a.length < SLOTS) a.push(-1); return a; };
    paneCount = window.innerWidth < 760 ? 2 : 3;
    watch = WATCH.map(channelFor).filter(function (c) { return c >= 0; });

    var h = startHash;
    location.hash.replace(/^#/, "").split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) h[kv.slice(0, i)] = kv.slice(i + 1); });
    var chosen = null;
    if (h.p) {
      chosen = h.p.split("/").map(function (s) { return pad(s.split(".").map(function (x) { return /^\d+$/.test(x) && usable(+x) ? +x : -1; })); });
      if (+h.n >= 1 && +h.n <= MAX_PANES) paneCount = +h.n;
    } else {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem("msq.lv.layout") || "null"); } catch (e) { /* ignore */ }
      if (saved && saved.p) {
        var mapped = saved.p.map(function (row) { return pad((row || []).map(byName)); });
        var hits = 0;
        mapped.forEach(function (row) { row.forEach(function (c) { if (c >= 0) hits++; }); });
        if (hits >= 2) {
          chosen = mapped;
          if (saved.n >= 1 && saved.n <= MAX_PANES) paneCount = saved.n;
          if (saved.w) watch = saved.w.map(byName).filter(function (c) { return c >= 0; });
        }
      }
    }
    if (!chosen) {
      chosen = DEFAULTS.map(function (row) { return pad(row.map(channelFor).filter(function (c) { return c >= 0; })); });
      if (!chosen.some(function (row) { return row[0] >= 0; })) {  // a log whose channels we don't recognise: show the first few
        var all = [];
        idx.channels.forEach(function (m, i) { if (m.lo != null && m.lo !== m.hi && i !== (idx.roles || {}).time) all.push(i); });
        chosen = [0, 1, 2, 3].map(function (k) { return pad(all.slice(k * 3, k * 3 + 3)); });
      } else {
        chosen = chosen.filter(function (row) { return row[0] >= 0; });
      }
    }
    while (chosen.length < MAX_PANES) chosen.push(pad([]));
    panes = chosen.slice(0, MAX_PANES).map(function (row) { return { ch: row }; });

    tMin = T[0]; tMax = T[N - 1] > T[0] ? T[N - 1] : T[0] + 1;
    view.t0 = tMin; view.t1 = tMax;
    if (h.v) { var m = /^(-?[\d.]+)-(-?[\d.]+)$/.exec(h.v); if (m && +m[2] > +m[1]) { view.t0 = +m[1]; view.t1 = +m[2]; } }
    clampView();
    if (h.c && /^\d+$/.test(h.c)) cur = Math.min(N - 1, +h.c);
    sc.x = channelFor("rpm"); sc.y = channelFor("map"); sc.z = channelFor("afr");
    vePane = { ch: pad(["rpm", "map", "afr", "afr_target"].map(channelFor)), i: 0, ve: true };
  }

  /* ---------- tabs ---------- */
  function setTab(name) {
    if (ve.running && name !== "ve") return;
    tab = name;
    $$("[data-lv-tab]").forEach(function (x) { x.setAttribute("aria-selected", x.dataset.lvTab === tab ? "true" : "false"); });
    $$("[data-lv-panel]").forEach(function (x) { x.hidden = x.dataset.lvPanel !== tab; });
    root.classList.toggle("tab-ve", tab === "ve");
    if (tab === "scatter") { load(sc.x); load(sc.y); load(sc.z); scatterDirty = true; }
    if (tab === "ve") {
      if (!vePane.el) { makePane(vePane, $(".lv-ve-graph")); vePane.el.classList.add("lv-pane-ve"); }
      if (!ve.grid && !$(".lv-ve-body").children.length) buildVE();
    }
    invalidate(); saveSoon();
  }

  /* ---------- controls ---------- */
  function step(n) { if (playing) play(false); setCursor(cur + n, true); }
  root.addEventListener("click", function (e) {
    if (e.target.closest("[data-lv-tune]")) { $d('[data-dlg="tune"]').hidden = false; return; }
    if (ve.running && !e.target.closest('[data-ve="stop"]')) {
      if (e.target.closest("[data-lv], [data-lv-tab]")) return;
    }
    var b = e.target.closest("[data-lv]");
    if (b) {
      var a = b.dataset.lv;
      if (a === "play") play(!playing);
      else if (a === "back") step(-1);
      else if (a === "fwd") step(1);
      else if (a === "start") step(-N);
      else if (a === "end") step(N);
      else if (a === "zin") zoom(0.5);
      else if (a === "zout") zoom(2);
      else if (a === "fit") setView(tMin, tMax);
      return;
    }
    b = e.target.closest("[data-lv-tab]");
    if (b) { setTab(b.dataset.lvTab); return; }
    b = e.target.closest("[data-ve]");
    if (b) { if (b.dataset.ve === "run") runVE(); else ve.running = false; return; }
    b = e.target.closest("[data-save-tune]");
    if (b) { saveTune(b); return; }
    b = e.target.closest("[data-save-discard]");
    if (b) {
      if (confirm("Discard " + plural(editCount(), "changed cell") + "?")) { edits = {}; editsChanged(); }
      return;
    }
    b = e.target.closest("[data-sc]");
    if (b) {
      var k = b.dataset.sc;
      pick(b, sc[k], k === "z", function (c) { sc[k] = c; load(c); scButtons(); scatterDirty = true; invalidate(); });
      return;
    }
    b = e.target.closest(".lv-gadd");
    if (b) {
      pick(b, -1, false, function (c) { if (watch.indexOf(c) < 0) watch.push(c); load(c); invalidate(); saveLayout(); });
      return;
    }
    b = e.target.closest(".lv-g[data-w]");
    if (b) { watch = watch.filter(function (c) { return c !== +b.dataset.c; }); invalidate(); saveLayout(); return; }
    b = e.target.closest("[data-lv-share]");
    if (b) {
      saveNow();
      var label = b.querySelector("span"), old = label.textContent, url = location.href;
      var ok = function () { label.textContent = "Link copied"; setTimeout(function () { label.textContent = old; }, 1600); };
      var fallback = function () {
        var ta = document.createElement("textarea");
        ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); ok(); } catch (err) { window.prompt("Copy this link", url); }
        document.body.removeChild(ta);
      };
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
        navigator.share({ title: root.dataset.name, url: url }).catch(function () { /* cancelled */ });
      } else if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(ok, fallback);
      else fallback();
      return;
    }
    if (e.target.closest("[data-lv-help]")) $d(".lv-help").hidden = false;
  });
  $d(".lv-help").addEventListener("click", function (e) {
    if (e.target === this || e.target.closest("[data-lv-help-close]")) this.hidden = true;
  });
  $("[data-lv-speed]").addEventListener("change", function () { speed = +this.value || 1; invalidate(); });
  $("[data-lv-count]").addEventListener("change", function () {
    paneCount = +this.value;
    panes.forEach(function (p, i) { p.el.hidden = i >= paneCount; p.ch.forEach(load); });
    invalidate(); saveSoon(); saveLayout();
  });
  $("[data-sc-range]").addEventListener("change", function () { scatterDirty = true; invalidate(); });
  root.addEventListener("change", function (e) {
    var sel = e.target.closest(".lv-th select");
    if (!sel) return;
    var slot = tableSlots[+sel.closest(".lv-table").dataset.slot];
    slot.t = idx.tables[+sel.value];
    buildSlot(slot); invalidate();
  });
  document.addEventListener("keydown", function (e) {
    if (!idx || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (t && t.closest && t.closest(".lv-tw")) return;  // the table has the keyboard
    var k = e.key, big = e.shiftKey ? 10 : 1;
    if (k === "Escape") { closePick(); $$(".lv-help, .lv-dlg", document).forEach(function (d) { d.hidden = true; }); return; }
    if (ve.running) return;
    if (k === "ArrowLeft") step(-big);
    else if (k === "ArrowRight") step(big);
    else if (k === "ArrowUp" || k === "+" || k === "=") zoom(0.5);
    else if (k === "ArrowDown" || k === "-") zoom(2);
    else if (k === " ") play(!playing);
    else if (k === "Home") step(-N);
    else if (k === "End") step(N);
    else if (k === "f" || k === "F") setView(tMin, tMax);
    else return;
    e.preventDefault();
  });
  window.addEventListener("beforeunload", function (e) {
    if (ve.running) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------- the tune dialog ---------- */
  (function () {
    var dlg = $d('[data-dlg="tune"]');
    $$(".lv-dlg", document).forEach(function (d) {
      d.addEventListener("click", function (e) { if (e.target === d || e.target.closest("[data-dlg-close]")) d.hidden = true; });
    });
    var form = dlg.querySelector("[data-tune-upload]"), input = form.querySelector("input[type=file]"), status = form.querySelector(".upload-status");
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      if (/\.(mlg|msl|csv|tsv)$/i.test(f.name)) { status.textContent = "That's a log. Choose the tune's .msq file."; input.value = ""; return; }
      status.classList.remove("err");
      status.textContent = "Uploading " + f.name + "…";
      var fd = new FormData(); fd.append("file", f);
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/upload"); xhr.setRequestHeader("X-Upload", "1");
      xhr.onload = function () {
        var res = null;
        try { res = JSON.parse(xhr.responseText); } catch (err) { /* not JSON */ }
        if (res && res.slug) { location.href = urlWithTune(res.slug); return; }
        status.classList.add("err"); status.textContent = res && res.error ? res.error : "That tune didn't upload. Try again.";
        input.value = "";
      };
      xhr.onerror = function () { status.classList.add("err"); status.textContent = "That tune didn't upload. Check your connection."; input.value = ""; };
      xhr.send(fd);
    });
    dlg.querySelector("[data-tune-link]").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = this.tune.value.trim(), m = /\/t\/([A-Za-z0-9]{10})(?![A-Za-z0-9])/.exec(v) || /^([A-Za-z0-9]{10})$/.exec(v);
      if (!m) { this.tune.setCustomValidity("Paste a tune link, like …/t/AbCdEfGhIj"); this.tune.reportValidity(); return; }
      location.href = urlWithTune(m[1]);
    });
    dlg.querySelector("[data-tune-link] input").addEventListener("input", function () { this.setCustomValidity(""); });
    var clear = dlg.querySelector("[data-tune-clear]");
    if (clear) clear.addEventListener("click", function () { location.href = urlWithTune(""); });
    var own = dlg.querySelector("[data-tune-own]");
    if (own) own.addEventListener("click", function () { location.href = urlWithTune(own.dataset.tuneOwn); });
  })();

  /* ---------- start ---------- */
  function fail(msg) { loadNote.textContent = msg; loadNote.classList.add("err"); loadNote.hidden = false; }
  Promise.all([
    fetch(base + "/index.json" + query).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
    fetchF32(base + "/ch/t")
  ]).then(function (res) {
    idx = res[0]; T = res[1]; N = T.length;
    if (N < 2) return fail("This log has no records to show.");
    if (idx.tune && idx.tune.stoich) stoich = idx.tune.stoich;
    initialLayout();
    buildPanes();
    scButtons();
    scrub($(".lv-over canvas"), true);
    watch.forEach(load);
    var side = $(".lv-side");
    side.insertAdjacentHTML("afterbegin", saveBar());
    if (idx.tables && idx.tables.length) {
      root.classList.add("has-side");
      restoreEdits();
      $$(".lv-table").forEach(function (el, i) {
        var t = idx.tables[i === 0 ? 0 : Math.min(idx.tables.length - 1, 1)];
        if (i === 1 && idx.tables.length < 2) { el.hidden = true; return; }
        var slot = { el: el, t: t };
        tableSlots.push(slot);
        buildSlot(slot);
      });
    } else {
      $$(".lv-table").forEach(function (el) { el.hidden = true; });
      $(".lv-notune").hidden = !!TUNE;
      if (!TUNE) root.classList.add("has-side", "no-tune");
      else side.hidden = true;
    }
    renderSaveBars();
    loadNote.hidden = true;
    root.classList.add("ready");
    if (window.ResizeObserver) new ResizeObserver(function () { scatterDirty = true; invalidate(); }).observe($(".lv-main"));
    window.addEventListener("resize", function () { scatterDirty = true; invalidate(); });
    if (startHash.tab === "scatter" || startHash.tab === "ve") setTab(startHash.tab);
    invalidate();
  }).catch(function () { fail("This log couldn't be loaded. Reload the page to try again."); });
})();
