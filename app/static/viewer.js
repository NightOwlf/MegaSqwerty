/* The log viewer: stacked graphs of any channels over time, a cursor with every value, zoom and pan, playback,
   a scatter plot, and the tune's tables following the cursor. Channels are fetched one at a time as float32
   and only when something draws them, so a 600-channel log opens as fast as a 10-channel one. */
(function () {
  "use strict";
  var root = document.getElementById("lv");
  if (!root) return;
  var base = "/l/" + root.dataset.log;
  var $ = function (s, el) { return (el || root).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || root).querySelectorAll(s)); };

  var COLORS = [["#ffe14d", "#4fd8ff", "#ff66d9", "#5df56a"], ["#ff5b4d", "#ffffff", "#6f8cff", "#ffb9ad"],
                ["#ffe14d", "#4fd8ff", "#ff66d9", "#5df56a"], ["#ff5b4d", "#ffffff", "#6f8cff", "#ffb9ad"]];
  var SLOTS = 4, MAX_PANES = 4;
  var DEFAULTS = [["rpm", "map", "tps", "vss"], ["lambda", "lambda_target", "advance", "pw"],
                  ["clt", "iat", "ego_corr", "batt"], ["knock", "duty", "boost_target", "inj_duty"]];
  var WATCH = ["rpm", "map", "tps", "lambda", "lambda_target", "advance", "clt", "iat", "batt", "vss", "gear",
               "inj_duty", "pw", "knock", "ego_corr"];

  var idx = null, T = null, N = 0, tMin = 0, tMax = 1;
  var store = {};            // channel index -> {v: Float32Array, pyr: [...]} once loaded, or a Promise while loading
  var panes = [], paneCount = 3, watch = [];
  var view = { t0: 0, t1: 1 }, cur = 0;
  var playing = false, speed = 1, playT = 0, lastFrame = 0;
  var tab = "graphs", dirty = false, scatterDirty = true;
  var sc = { x: -1, y: -1, z: -1 };
  var tableSlots = [];
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
  function fetchF32(path) {
    return fetch(base + path).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.arrayBuffer();
    }).then(function (buf) { return new Float32Array(buf); });
  }
  function load(i) {
    if (i == null || i < 0 || i >= idx.channels.length) return Promise.resolve(null);
    var have = store[i];
    if (have) return have.then ? have : Promise.resolve(have);
    var p = fetchF32("/ch/" + i).then(function (v) {
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
  function setCursor(i, follow) {
    cur = Math.max(0, Math.min(N - 1, i));
    if (follow) {
      var t = T[cur], span = view.t1 - view.t0;
      if (t < view.t0) setView(t - span * 0.1, t + span * 0.9);
      else if (t > view.t1) setView(t - span * 0.9, t + span * 0.1);
    }
    invalidate(); saveSoon();
  }
  function play(on) {
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
  function trace(ctx, d, i0, i1, kx, yOf, W) {
    var v = d.v, spp = (i1 - i0 + 1) / W, lvl = null, pen = false, i;
    for (var k = d.pyr.length - 1; k >= 0; k--) if (d.pyr[k].s * 2 <= spp) { lvl = d.pyr[k]; break; }
    ctx.beginPath();
    if (!lvl && spp <= 2) {
      for (i = i0; i <= i1; i++) {
        var val = v[i];
        if (val !== val) { pen = false; continue; }
        var x = (T[i] - view.t0) * kx, y = yOf(val);
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
        var c = Math.floor((T[Math.min(N - 1, j * s)] - view.t0) * kx);
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
      trace(ctx, d, i0, i1, kx, yOf, W);
    });

    // min / max of each channel down the left edge, like a strip chart's scale
    ctx.font = "bold " + fs + "px " + "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
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
      for (t = Math.ceil(view.t0 / step) * step; t < view.t1; t += step) {
        var tx2 = Math.round((t - view.t0) * kx);
        ctx.rect(tx2, H - 4, 1, 4);
      }
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
        var keep = view;
        view = { t0: tMin, t1: tMax };
        ctx.strokeStyle = "#8a93a0"; ctx.lineWidth = 1;
        trace(ctx, d, 0, N - 1, kx, function (v) { return H - 3 - (v - m.lo) / range * (H - 6); }, W);
        view = keep;
      }
    }
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
    var list = gaugeList(), key = list.map(function (g) { return g.c + g.color; }).join(",");
    if (key !== gaugeKey) {
      gaugeKey = key;
      gaugeBox.innerHTML = list.map(function (g) {
        var m = idx.channels[g.c];
        return '<span class="lv-g" data-c="' + g.c + '"' + (g.w ? ' data-w title="Click to remove"' : "") + ">" +
          '<i style="background:' + (g.color || "#6b6f76") + '"></i><span class="lv-gn">' + esc(m.n) + "</span>" +
          '<b class="mono"></b>' + (m.u ? '<small>' + esc(m.u) + "</small>" : "") + "</span>";
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

  /* ---------- the tune's tables ---------- */
  function heat(f) {
    f = Math.max(0, Math.min(1, f));
    var stops = [[120, 150, 255], [120, 220, 240], [130, 230, 130], [240, 235, 110], [255, 170, 90], [255, 105, 95]];
    var x = f * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), r = x - k;
    return "rgb(" + [0, 1, 2].map(function (j) { return Math.round(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * r); }).join(",") + ")";
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
  function buildTable(slot) {
    var t = slot.t, lo = Math.min.apply(null, t.z), hi = Math.max.apply(null, t.z), html = [];
    var bd = function (v) { return Math.abs(v) >= 100 || v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1); };
    for (var r = t.rows - 1; r >= 0; r--) {
      html.push("<tr><th>" + bd(t.y[r]) + "</th>");
      for (var c = 0; c < t.cols; c++) {
        var v = t.z[r * t.cols + c];
        html.push('<td style="background:' + heat(hi > lo ? (v - lo) / (hi - lo) : 0.5) + '">' + cellText(v, t.d) + "</td>");
      }
      html.push("</tr>");
    }
    html.push("<tr><th></th>" + t.x.map(function (v) { return "<th>" + bd(v) + "</th>"; }).join("") + "</tr>");
    var opts = idx.tables.map(function (o, i) { return "<option value=" + i + (o === t ? " selected" : "") + ">" + esc(o.label) + "</option>"; }).join("");
    slot.el.innerHTML = '<div class="lv-th"><select aria-label="Table">' + opts + '</select><span class="lv-tv mono"></span></div>' +
      '<div class="lv-tw"><table class="lv-tt"><tbody>' + html.join("") + '</tbody></table><i class="lv-dot" hidden></i></div>' +
      '<p class="lv-tn">' + esc((t.yl || "Load") + (t.yu ? " (" + t.yu + ")" : "") + " ↑ · " + (t.xl || "RPM") + (t.xu ? " (" + t.xu + ")" : "") + " →") +
      (t.xc == null || t.yc == null ? " · no matching channel in this log, so no cursor" : "") + "</p>";
    slot.cells = $$("td", slot.el);
    slot.last = null;
    load(t.xc); load(t.yc);
  }
  function drawTables() {
    tableSlots.forEach(function (slot) {
      var t = slot.t, dx = got(t.xc), dy = got(t.yc), dot = $(".lv-dot", slot.el), out = $(".lv-tv", slot.el);
      if (slot.last) { slot.last.classList.remove("cur"); slot.last = null; }
      if (!dx || !dy) { dot.hidden = true; out.textContent = ""; return; }
      var fx = where(t.x, dx.v[cur]), fy = where(t.y, dy.v[cur] * t.ya + t.yb);
      if (!(fx === fx) || !(fy === fy)) { dot.hidden = true; out.textContent = ""; return; }
      var c0 = Math.floor(fx), r0 = Math.floor(fy), c1 = Math.min(t.cols - 1, c0 + 1), r1 = Math.min(t.rows - 1, r0 + 1);
      var a = fx - c0, b = fy - r0, z = function (r, c) { return t.z[r * t.cols + c]; };
      var val = (z(r0, c0) * (1 - a) + z(r0, c1) * a) * (1 - b) + (z(r1, c0) * (1 - a) + z(r1, c1) * a) * b;
      out.textContent = val.toFixed(Math.max(1, t.d)) + (t.units ? " " + t.units : "");
      var cell = function (r, c) { return slot.cells[(t.rows - 1 - r) * t.cols + c]; };
      var near = cell(Math.round(fy), Math.round(fx));
      near.classList.add("cur"); slot.last = near;
      var p = cell(r0, c0), q = cell(r1, c1);
      var px = p.offsetLeft + p.offsetWidth / 2, qx = q.offsetLeft + q.offsetWidth / 2;
      var py = p.offsetTop + p.offsetHeight / 2, qy = q.offsetTop + q.offsetHeight / 2;
      dot.hidden = false;
      dot.style.transform = "translate(" + (px + (qx - px) * a - 5) + "px," + (py + (qy - py) * b - 5) + "px)";
    });
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
  function invalidate() {
    if (dirty || !idx) return;
    dirty = true;
    requestAnimationFrame(function () {
      dirty = false;
      if (tab === "graphs") panes.slice(0, paneCount).forEach(function (p, i) { drawPane(p, i === paneCount - 1); });
      else drawScatter();
      drawOverview(); drawGauges(); drawStatus(); drawTables();
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
  function buildPanes() {
    graphs.innerHTML = "";
    panes.forEach(function (p, i) {
      p.i = i;
      p.el = document.createElement("div"); p.el.className = "lv-pane"; p.el.hidden = i >= paneCount;
      p.cv = document.createElement("canvas");
      p.names = document.createElement("div"); p.names.className = "lv-names";
      p.el.appendChild(p.cv); p.el.appendChild(p.names);
      graphs.appendChild(p.el);
      names(p);
      scrub(p.cv, false);
      p.names.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b) return;
        var k = +b.dataset.slot;
        pick(b, p.ch[k], true, function (c) {
          p.ch[k] = c; names(p); load(c); invalidate(); saveSoon(); saveLayout();
        });
      });
      p.ch.forEach(load);
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
      if (e.button) return;
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
  var pop = document.querySelector(".lv-pop"), popIn = pop.querySelector("input"), popList = pop.querySelector("ul"), popDone = null;
  function pick(anchor, current, allowNone, done) {
    popDone = done;
    pop.hidden = false;
    var r = anchor.getBoundingClientRect();
    if (window.innerWidth >= 760) {
      pop.style.left = Math.max(8, Math.min(window.innerWidth - 328, r.left)) + "px";
      pop.style.top = Math.min(window.innerHeight - 380, r.bottom + 4) + "px";
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
      "&n=" + paneCount + "&c=" + cur + "&v=" + view.t0.toFixed(2) + "-" + view.t1.toFixed(2);
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
  function initialLayout() {
    var roles = idx.roles || {}, ok = function (c) { return c != null && c >= 0 && c < idx.channels.length && idx.channels[c].lo != null; };
    var fromRole = function (r) { return ok(roles[r]) ? roles[r] : -1; };
    var pad = function (a) { a = a.slice(0, SLOTS); while (a.length < SLOTS) a.push(-1); return a; };
    paneCount = window.innerWidth < 760 ? 2 : 3;
    watch = WATCH.map(fromRole).filter(function (c) { return c >= 0; });

    var h = {};
    location.hash.replace(/^#/, "").split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) h[kv.slice(0, i)] = kv.slice(i + 1); });
    var chosen = null;
    if (h.p) {
      chosen = h.p.split("/").map(function (s) { return pad(s.split(".").map(function (x) { return /^\d+$/.test(x) && ok(+x) ? +x : -1; })); });
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
      chosen = DEFAULTS.map(function (row) { return pad(row.map(fromRole).filter(function (c) { return c >= 0; })); });
      var any = chosen.some(function (row) { return row[0] >= 0; });
      if (!any) {  // a log whose channels we don't recognise: just show the first few
        var all = [];
        idx.channels.forEach(function (m, i) { if (m.lo != null && m.lo !== m.hi && i !== roles.time) all.push(i); });
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
    sc.x = fromRole("rpm"); sc.y = fromRole("map"); sc.z = fromRole("lambda");
  }

  /* ---------- controls ---------- */
  function step(n) { if (playing) play(false); setCursor(cur + n, true); }
  root.addEventListener("click", function (e) {
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
    if (b) {
      tab = b.dataset.lvTab;
      $$("[data-lv-tab]").forEach(function (x) { x.setAttribute("aria-selected", x === b ? "true" : "false"); });
      $$("[data-lv-panel]").forEach(function (x) { x.hidden = x.dataset.lvPanel !== tab; });
      if (tab === "scatter") { load(sc.x); load(sc.y); load(sc.z); scatterDirty = true; }
      invalidate();
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
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(ok, fallback); else fallback();
      return;
    }
    if (e.target.closest("[data-lv-help]")) document.querySelector(".lv-help").hidden = false;
  });
  document.querySelector(".lv-help").addEventListener("click", function (e) {
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
    buildTable(slot); invalidate();
  });
  document.addEventListener("keydown", function (e) {
    if (!idx || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    var k = e.key, big = e.shiftKey ? 10 : 1;
    if (k === "ArrowLeft") step(-big);
    else if (k === "ArrowRight") step(big);
    else if (k === "ArrowUp" || k === "+" || k === "=") zoom(0.5);
    else if (k === "ArrowDown" || k === "-") zoom(2);
    else if (k === " ") play(!playing);
    else if (k === "Home") step(-N);
    else if (k === "End") step(N);
    else if (k === "f" || k === "F") setView(tMin, tMax);
    else if (k === "Escape") { closePick(); document.querySelector(".lv-help").hidden = true; return; }
    else return;
    e.preventDefault();
  });

  /* ---------- start ---------- */
  function fail(msg) { loadNote.textContent = msg; loadNote.classList.add("err"); loadNote.hidden = false; }
  Promise.all([
    fetch(base + "/index.json").then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
    fetchF32("/ch/t")
  ]).then(function (res) {
    idx = res[0]; T = res[1]; N = T.length;
    if (N < 2) return fail("This log has no records to show.");
    initialLayout();
    buildPanes();
    scButtons();
    scrub($(".lv-over canvas"), true);
    watch.forEach(load);
    if (idx.tables && idx.tables.length) {
      $(".lv-side").hidden = false;
      root.classList.add("has-side");
      $$(".lv-table").forEach(function (el, i) {
        var t = idx.tables[i];
        if (!t) { el.hidden = true; return; }
        var slot = { el: el, t: t };
        tableSlots.push(slot);
        buildTable(slot);
      });
    }
    loadNote.hidden = true;
    root.classList.add("ready");
    if (window.ResizeObserver) new ResizeObserver(function () { scatterDirty = true; invalidate(); }).observe($(".lv-main"));
    window.addEventListener("resize", function () { scatterDirty = true; invalidate(); });
    invalidate();
  }).catch(function () { fail("This log couldn't be loaded. Reload the page to try again."); });
})();
