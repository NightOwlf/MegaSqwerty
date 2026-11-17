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
  // The graphs a log opens with: engine and boost, the mixture with its target and the AFR correction
  // (closed-loop trim), timing and knock with boost duty, then temperatures.
  var DEFAULTS = [["rpm", "map", "boost_target", "tps"], ["afr", "afr_target", "afr_corr", "ego_corr", "pw"],
                  ["advance", "knock", "duty", "inj_duty"], ["clt", "iat", "batt", "vss"]];
  // One-tap layouts for the job at hand (the Layout menu).
  var PRESETS = {
    tuning: { label: "Tuning overview", n: 3, p: DEFAULTS },
    fuel: { label: "Fuel / VE", n: 3, p: [["rpm", "map", "tps", "ve"], ["afr", "afr_target", "afr_corr", "ego_corr", "pw"], ["clt", "iat", "inj_duty", "accel"]] },
    boost: { label: "Boost", n: 3, p: [["rpm", "map", "boost_target", "tps"], ["duty", "gear", "vss", "iat"], ["afr", "afr_target", "advance", "knock"]] },
    spark: { label: "Ignition & knock", n: 3, p: [["rpm", "map", "tps", "gear"], ["advance", "knock", "iat", "clt"], ["afr", "afr_target", "ego_corr", "inj_duty"]] },
    afr: { label: "AFR & correction", n: 2, p: [["afr", "afr_target", "afr_corr", "ego_corr", "rpm"], ["rpm", "map", "tps", "pw", "clt"]] },
    warm: { label: "Warm-up & idle", n: 3, p: [["rpm", "clt", "tps", "map"], ["afr", "afr_target", "ego_corr", "advance"], ["iat", "batt", "pw", "vss"]] }
  };
  // What the channel picker suggests first, with plain names.
  var SUGGEST = [["rpm", "RPM"], ["map", "MAP / boost"], ["boost_target", "Boost target"], ["tps", "Throttle"],
                 ["afr", "AFR (wideband)"], ["afr_target", "Target AFR"], ["afr_corr", "AFR correction needed (from the wideband)"],
                 ["ego_corr", "AFR correction (closed-loop trim)"],
                 ["ve", "VE in use"], ["pw", "Injector pulse width"], ["inj_duty", "Injector duty"], ["advance", "Ignition advance"],
                 ["knock", "Knock retard"], ["duty", "Boost duty"], ["clt", "Coolant temp"], ["iat", "Intake air temp"],
                 ["gear", "Gear"], ["vss", "Speed"], ["batt", "Battery"], ["fuel_press", "Fuel pressure"], ["egt", "EGT"]];
  function sameScale(m) {
    var u = String(m.u || "").trim().toLowerCase();
    if (!u || u === "%" || u === "on/off" || u === "bits") return "";
    if (u === "ratio" || u === "afr" || u === ":1") return "afr";
    return u.replace(/^deg\s*/, "°").replace(/^°\s*/, "°");
  }
  var WATCH = ["rpm", "map", "tps", "afr", "afr_target", "afr_corr", "advance", "clt", "iat", "batt", "vss", "gear",
               "inj_duty", "pw", "knock", "ego_corr", "ve"];
  // Mixture is shown as AFR: these are the names an AFR channel goes by, before falling back to lambda.
  var AFR_NAMES = { afr: ["afr", "afr1", "widebandafr", "wbafr", "airfuelratio", "afrcorrected"],
                    afr_target: ["fueltargetafr", "afrtarget", "targetafr", "afrtgt", "airfuelratiotarget"] };

  var idx = null, T = null, N = 0, tMin = 0, tMax = 1;
  var store = {};            // channel index -> {v: Float32Array, pyr: [...]} once loaded, or a Promise while loading
  var panes = [], paneCount = 3, watch = [];
  var view = { t0: 0, t1: 1 }, cur = 0;
  // Sections of the log chosen for VE Analyze (seconds), like a tuner cutting a log into pulls.
  var sections = [], selMode = false, selDrag = null, secStart = null;
  var playing = false, speed = 1, playT = 0, lastFrame = 0;
  var tab = "graphs", dirty = false, scatterDirty = true;
  var sc = { x: -1, y: -1, z: -1 };
  var tableSlots = [];
  var stoich = 14.7;
  var loadNote = $(".lv-load");

  /* Display options (the ⚙ menu), remembered in this browser. */
  var OPT_DEF = { range: "view", scale: "log", cursorVals: true, peaks: false, line: 1.25, text: 1 };
  var opt = (function () {
    var o = {}, s = null, k;
    for (k in OPT_DEF) o[k] = OPT_DEF[k];
    try { s = JSON.parse(localStorage.getItem("msq.lv.opts") || "null"); } catch (e) { /* ignore */ }
    if (s) for (k in OPT_DEF) if (k in s && typeof s[k] === typeof OPT_DEF[k]) o[k] = s[k];
    return o;
  })();
  function saveOpts() { try { localStorage.setItem("msq.lv.opts", JSON.stringify(opt)); } catch (e) { /* ignore */ } }

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
    var m = idx.channels[i];
    var p = (m.virt ? m.virt() : fetchF32(base + "/ch/" + i)).then(function (v) {
      if (m.toF) for (var q = 0; q < v.length; q++) v[q] = v[q] * 1.8 + 32;  // shown in °F
      store[i] = { v: v, pyr: pyramid(v) };
      scatterDirty = true;
      invalidate();
      return store[i];
    }, function () { delete store[i]; return null; });
    store[i] = p;
    return p;
  }
  function got(i) { var d = store[i]; return d && !d.then ? d : null; }
  /* Computed channels, added to the log's own. "AFR correction needed": how far the wideband is from the
     target, as the % more (+) or less (−) fuel it would take to hit it. It works with closed loop off. */
  /* "What if": this drive's AFR as it would have been with the VE table as it is now (edits, 3D drags, a VE
     Analyze suggestion). Fuel follows VE, so at every record
         simulated AFR = measured AFR × VE that ran ÷ VE now
     where "VE that ran" is the ECU's logged VE (else the table this tune started from) and "VE now" is the
     table read at that record's RPM and load. It doesn't model closed-loop trim reacting or the wideband's
     delay, so it's a guide to the direction and size of a change, not a replacement for a new log. */
  var simIdx = -1, simStats = null;
  function veTableDef() { return (idx.tables || []).filter(function (t) { return t.id === "ve"; })[0] || null; }
  function addSimulated() {
    var R = idx.roles || {}, t = veTableDef();
    if (!t || t.xc == null || t.yc == null || R.lambda == null) return;
    var lamDiv = (idx.lam && idx.lam.lambda) || 1, tgtDiv = (idx.lam && idx.lam.lambda_target) || 1;
    simIdx = idx.channels.length;
    idx.channels.push({ n: "AFR (simulated)", u: "AFR", d: 2, lo: 9, hi: 18, sim: true, virt: function () {
      var need = [load(t.xc), load(t.yc), load(R.lambda), R.lambda_target != null ? load(R.lambda_target) : Promise.resolve(null),
                  R.ve != null ? load(R.ve) : Promise.resolve(null), R.rpm != null ? load(R.rpm) : Promise.resolve(null)];
      return Promise.all(need).then(function (r) {
        var X = r[0].v, Y = r[1].v, L = r[2].v, G = r[3] && r[3].v, V = r[4] && r[4].v, n = X.length, out = new Float32Array(n);
        var base = t.p || t.z, now = function (k) { return valueAt(t, k); }, was = function (k) { return base[k]; };
        var sec = inSections(T), st = { n: 0, eb: 0, ea: 0, wb: 0, wa: 0, changed: 0 };
        for (var i = 0; i < n; i++) {
          var fx = where(t.x, X[i]), fy = where(t.y, Y[i] * t.ya + t.yb), afr = L[i] / lamDiv * stoich;
          if (!(fx === fx) || !(fy === fy) || !(afr > 5 && afr < 30)) { out[i] = NaN; continue; }
          var veNow = interpTable(t, now, fx, fy), veRan = V && V[i] > 1 && V[i] < 300 ? V[i] : interpTable(t, was, fx, fy);
          var sim = veNow > 0 ? afr * veRan / veNow : NaN;
          out[i] = sim;
          if (Math.abs(veNow / veRan - 1) > 0.001) st.changed++;
          var tgt = G ? G[i] / tgtDiv * (G[i] / tgtDiv < 2 ? stoich : 1) : NaN;
          if (sec && !sec[i]) continue;
          if (tgt > 9 && tgt < 20 && afr > 9 && afr < 18 && sim === sim) {  // running, not fuel cut
            st.n++;
            var eb = Math.abs(afr - tgt), ea = Math.abs(sim - tgt);
            st.eb += eb; st.ea += ea; if (eb <= 0.5) st.wb++; if (ea <= 0.5) st.wa++;
          }
        }
        simStats = st;
        return out;
      });
    } });
  }
  var simTimer = 0;
  function resim() {
    if (simIdx < 0) return;
    delete store[simIdx];
    $(".lv-sim-sum") && ($(".lv-sim-sum").textContent = "Simulating…");
    load(simIdx).then(function () { renderSimSummary(); invalidate(); });
  }
  function simSoon() { clearTimeout(simTimer); simTimer = setTimeout(resim, 400); }
  function renderSimSummary() {
    var box = $(".lv-sim-sum");
    if (!box) return;
    var s = simStats;
    if (simIdx < 0) { box.textContent = "This log can't be simulated: it needs a wideband channel and a tune with a VE table."; return; }
    if (!s || !s.n) { box.textContent = "Not enough running data to compare (outside fuel cut, with a target)."; return; }
    var where2 = sections.length ? " in your sections" : "";
    var head = s.changed ? "" : "The VE table is the same as what ran" + where2 + ", so the simulated log matches the recorded one. Edit cells or run VE Analyze, then look again.\n";
    box.innerHTML = esc(head) + "<b>Recorded</b>: " + (s.eb / s.n).toFixed(2) + " AFR off target on average, within ±0.5 AFR " + Math.round(s.wb / s.n * 100) + "% of the time" +
      "<br><b>Simulated</b>: " + (s.ea / s.n).toFixed(2) + " AFR off on average, within ±0.5 AFR <b>" + Math.round(s.wa / s.n * 100) + "%</b> of the time" +
      (s.ea < s.eb - 0.02 ? ' <span class="up-good">closer to target</span>' : s.ea > s.eb + 0.02 ? ' <span class="up-bad">further from target</span>' : "") + where2;
  }
  function addVirtual() {
    var R = idx.roles || {};
    if (R.lambda == null || R.lambda_target == null) return;
    var lamDiv = (idx.lam && idx.lam.lambda) || 1, tgtDiv = (idx.lam && idx.lam.lambda_target) || 1;
    var at = idx.channels.length;
    idx.channels.push({ n: "AFR correction needed", u: "%", d: 1, lo: -20, hi: 20, virt: function () {
      return Promise.all([load(R.lambda), load(R.lambda_target)]).then(function (r) {
        var a = r[0] && r[0].v, b = r[1] && r[1].v, n = a ? a.length : 0, out = new Float32Array(n), lo = Infinity, hi = -Infinity;
        for (var k = 0; k < n; k++) {
          var x = a[k] / lamDiv, y = b[k] / tgtDiv, c = y > 0.3 && x > 0.3 ? (x / y - 1) * 100 : NaN;
          out[k] = c; if (c === c) { if (c < lo) lo = c; if (c > hi) hi = c; }
        }
        if (lo <= hi) { idx.channels[at].lo = Math.round(lo * 10) / 10; idx.channels[at].hi = Math.round(hi * 10) / 10; }
        return out;
      });
    } });
    idx.roles.afr_corr = at;
  }
  /* Lowest and highest value between records i0 and i1 (and where the highest is), using the min/max
     pyramid so it stays instant on a 400,000-record log. */
  function spanRange(d, i0, i1) {
    var v = d.v, lo = Infinity, hi = -Infinity, at = -1, n = i1 - i0 + 1, lvl = null, i, k;
    for (k = d.pyr.length - 1; k >= 0; k--) if (d.pyr[k].s * 48 <= n) { lvl = d.pyr[k]; break; }
    var raw = function (a, b) {
      for (var j = a; j <= b; j++) { var x = v[j]; if (x === x) { if (x < lo) lo = x; if (x > hi) { hi = x; at = j; } } }
    };
    if (!lvl) raw(i0, i1);
    else {
      var s = lvl.s, a = Math.ceil(i0 / s), b = Math.floor((i1 + 1) / s), best = -1;
      raw(i0, Math.min(i1, a * s - 1));
      for (i = a; i < b; i++) {
        var mn = lvl.min[i], mx = lvl.max[i];
        if (mn === mn) { if (mn < lo) lo = mn; if (mx > hi) { hi = mx; best = i; at = -2; } }
      }
      raw(Math.max(i0, b * s), i1);
      if (at === -2) {  // the peak is inside a block: find the record
        var top = -Infinity;
        for (i = best * s; i < Math.min(v.length, (best + 1) * s); i++) if (v[i] > top) { top = v[i]; at = i; }
      }
    }
    return lo <= hi ? { lo: lo, hi: hi, at: at } : null;
  }
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
  /* A role's channel for a ready-made layout: not one that never changes in this log (a flat line says nothing). */
  function layoutChannel(role) {
    var c = channelFor(role), m = c >= 0 ? idx.channels[c] : null;
    return m && (m.virt || m.lo !== m.hi) ? c : -1;
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
  function setView(t0, t1) { view.t0 = t0; view.t1 = t1; clampView(); scatterDirty = true; invalidate(); saveSoon(); together.send(); }
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
    invalidate(); saveSoon(); together.send();
  }
  function play(on) {
    if (on && ve.running) return;
    if (on && cur >= N - 1) cur = 0;
    playing = on; playT = T[cur]; lastFrame = 0;
    var b = $("[data-lv=play]");
    b.textContent = on ? "⏸" : "▶"; b.classList.toggle("on", on);
    if (on) requestAnimationFrame(tick);
    invalidate(); together.send(true);
  }
  /* "Live view": everyone on this log link sees the same moment. Whoever plays, pauses, scrubs or zooms sends
     it and the others follow; "Private" neither sends nor follows. The connection is only open while someone
     is using the page (it closes after 10 idle minutes or when the page is hidden), so an open tab left alone
     doesn't keep the server busy. */
  var together = (function () {
    var ws = null, open = false, mode = "live", applying = false, last = 0, timer = 0, here = 1, lastUse = Date.now(), idleT = 0;
    try { if (sessionStorage.getItem("msq.lv.private") === "1") mode = "private"; } catch (e) { /* ignore */ }
    function render() {
      var b = $('[data-lv="together"]');
      if (!b) return;
      b.classList.toggle("on", mode === "live");
      b.innerHTML = mode === "live" ? "● Live view" + (open && here > 1 ? " · " + here + " here" : "") : "Private";
      b.title = mode === "live" ? "Everyone on this log link sees what you play, pause and scrub, and you see theirs. Tap for Private."
                                : "Private: you play the log on your own. Tap for Live view.";
    }
    function connect() {
      if (ws || mode !== "live" || document.hidden || !idx) return;
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      ws = new WebSocket(proto + location.host + "/l/" + SLUG + "/together");
      ws.onopen = function () { open = true; render(); };
      ws.onclose = function () { open = false; ws = null; here = 1; render(); if (mode === "live" && !document.hidden && Date.now() - lastUse < 600000) setTimeout(connect, 3000); };
      ws.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.t === "here") { here = m.n; render(); return; }
        if (m.t !== "s" || mode !== "live" || !T) return;
        applying = true;
        try {
          if (m.speed && m.speed !== speed) { speed = m.speed; $("[data-lv-speed]").value = String(speed); }
          if (m.v) { view.t0 = m.v[0]; view.t1 = m.v[1]; clampView(); scatterDirty = true; }
          if (m.playing) {
            cur = nearest(m.pos + Math.max(0, (Date.now() - m.at) / 1000) * (m.speed || 1));
            if (!playing) play(true);
            playT = T[cur];
          } else {
            if (playing) play(false);
            cur = nearest(m.pos);
          }
          invalidate();
        } finally { applying = false; }
      };
    }
    function stop() { if (ws) { try { ws.close(); } catch (e) { /* ignore */ } } ws = null; open = false; render(); }
    function used() {
      lastUse = Date.now();
      clearTimeout(idleT); idleT = setTimeout(function () { if (!playing) stop(); }, 600000);
      if (!ws) connect();
    }
    ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (ev) { document.addEventListener(ev, used, { passive: true, capture: true }); });
    document.addEventListener("visibilitychange", function () { if (document.hidden) setTimeout(function () { if (document.hidden) stop(); }, 60000); else used(); });
    return {
      start: function () { render(); used(); },
      send: function (force) {
        if (applying || mode !== "live" || !T) return;
        if (playing && !force) return;  // while playing, the others play along by themselves
        clearTimeout(timer);
        var go = function () {
          last = Date.now();
          if (ws && open) ws.send(JSON.stringify({ t: "s", pos: T[cur], v: [view.t0, view.t1], playing: playing, at: Date.now(), speed: speed }));
        };
        if (force || Date.now() - last > 80) go(); else timer = setTimeout(go, 80);
      },
      toggle: function () {
        mode = mode === "live" ? "private" : "live";
        try { sessionStorage.setItem("msq.lv.private", mode === "private" ? "1" : "0"); } catch (e) { /* ignore */ }
        if (mode === "live") { used(); setTimeout(function () { together.send(true); }, 400); } else stop();
        render();
      }
    };
  })();
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
  function drawSections(ctx, H, kx, t0) {
    var list = sections.slice();
    if (selDrag) list.push([Math.min(selDrag.a, selDrag.b), Math.max(selDrag.a, selDrag.b)]);
    if (secStart != null) list.push([secStart, secStart]);
    if (!list.length) return;
    ctx.save();
    list.forEach(function (r) {
      var x0 = (r[0] - t0) * kx, x1 = (r[1] - t0) * kx;
      ctx.fillStyle = "rgba(255, 196, 0, .13)"; ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
      ctx.strokeStyle = "rgba(255, 196, 0, .8)"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(Math.round(x0) + 0.5, 0); ctx.lineTo(Math.round(x0) + 0.5, H);
      ctx.moveTo(Math.round(x1) + 0.5, 0); ctx.lineTo(Math.round(x1) + 0.5, H); ctx.stroke();
    });
    ctx.restore();
  }
  function addSection(a, b) {
    a = Math.max(tMin, Math.min(a, b)); b = Math.min(tMax, Math.max(a, b));
    if (b - a < 0.2) return;
    var all = sections.concat([[a, b]]).sort(function (p, q) { return p[0] - q[0]; }), out = [];
    all.forEach(function (r) {  // overlapping sections merge
      var last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
    });
    sections = out;
    sectionsChanged();
  }
  function sectionsChanged() { renderSections(); invalidate(); saveSoon(); refreshOverlays(); }
  function secLen() { return sections.reduce(function (s, r) { return s + r[1] - r[0]; }, 0); }
  function renderSections() {
    var bar = $(".lv-secbar"), btn = $('[data-lv="sec"]');
    if (btn) btn.classList.toggle("on", selMode);
    root.classList.toggle("sel-mode", selMode);
    if (!bar) return;
    bar.hidden = !sections.length && !selMode && secStart == null;
    var span = tMax - tMin > 600;
    bar.innerHTML = '<b>Sections to tune</b>' +
      (sections.length ? sections.map(function (r, i) {
        return '<span class="lv-chip mono"><button type="button" data-sec-go="' + i + '" title="Show this section">' + fmtT(r[0], span ? 700 : 60) + "–" + fmtT(r[1], span ? 700 : 60) +
          '</button><button type="button" data-sec-del="' + i + '" aria-label="Remove this section">×</button></span>';
      }).join("") + '<span class="dim mono">' + secLen().toFixed(1) + " s of " + (tMax - tMin).toFixed(0) + " s</span>"
        : '<span class="dim">' + (selMode ? "Drag across a graph to choose a section (or mark start and end at the cursor)." : "Whole log") + "</span>") +
      '<span class="st-grow"></span>' +
      '<button type="button" class="btn sm" data-sec="start" title="Mark where a section starts, at the cursor">⟦ Start</button>' +
      '<button type="button" class="btn sm" data-sec="end" title="Mark where it ends, at the cursor">End ⟧</button>' +
      '<button type="button" class="btn sm" data-sec="view" title="Add what\'s on screen as a section">+ On screen</button>' +
      (sections.length ? '<button type="button" class="btn sm" data-sec="clear">Clear</button>' +
        (tab !== "ve" ? '<button type="button" class="btn sm primary" data-sec="tune">Tune these ▶</button>' : "") : "");
  }
  function inSections(Tarr) {
    if (!sections.length) return null;
    var m = new Uint8Array(Tarr.length), r = 0;
    for (var i = 0; i < Tarr.length; i++) {
      var t = Tarr[i];
      while (r < sections.length && t > sections[r][1]) r++;
      m[i] = r < sections.length && t >= sections[r][0] ? 1 : 0;
    }
    return m;
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
    drawSections(ctx, H, kx, view.t0);
    drawMarkers(ctx, W, H, kx, view.t0, view.t1, last);

    var i0 = Math.max(0, lower(view.t0) - 1), i1 = Math.min(N - 1, lower(view.t1) + 1);
    var j0 = Math.min(N - 1, lower(view.t0)), j1 = Math.max(j0, Math.min(N - 1, lower(view.t1)));
    var top = 5, bot = last ? 18 : 5, shown = [];
    fs = Math.round(fs * opt.text * 2) / 2; lh = fs + 3;
    ctx.lineWidth = opt.line; ctx.lineJoin = "round";
    p.ch.forEach(function (c, k) {
      var d = got(c), m = c >= 0 ? idx.channels[c] : null;
      if (!m) return;
      var rr = d ? spanRange(d, j0, j1) : null;
      var s = { c: c, m: m, d: d, rr: rr, color: COLORS[p.i][k], lo: m.lo, hi: m.hi };
      if (opt.scale === "view" && rr) { s.lo = rr.lo; s.hi = rr.hi; }  // fit the trace to what's on screen
      shown.push(s);
    });
    // Channels in the same units share one scale, so AFR sits on its target and MAP on the boost target.
    var groups = {};
    shown.forEach(function (s) {
      var u = sameScale(s.m);
      if (!u || s.lo == null) return;
      var g = groups[u] || (groups[u] = { lo: Infinity, hi: -Infinity });
      g.lo = Math.min(g.lo, s.lo); g.hi = Math.max(g.hi, s.hi);
    });
    shown.forEach(function (s) {
      var u = sameScale(s.m), lo = u && groups[u] ? groups[u].lo : s.lo, hi = u && groups[u] ? groups[u].hi : s.hi;
      if (!s.d || lo == null) return;
      if (opt.scale === "view") { var pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad; }
      var range = hi - lo, ky = range > 0 ? (H - top - bot) / range : 0;
      s.yOf = range > 0 ? function (v) { return H - bot - (v - lo) * ky; } : function () { return H / 2; };
      ctx.strokeStyle = s.color;
      trace(ctx, s.d, i0, i1, kx, s.yOf, W, view.t0);
    });

    // The left edge: each channel's value at the cursor (it follows the cursor as you scrub or play),
    // then the highest and lowest it reached, on screen or in the whole log (the ⚙ menu).
    var font = "px system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    var labelW = 0, rows = [];
    shown.forEach(function (s) {
      var src = opt.range === "log" || !s.rr ? { lo: s.m.lo, hi: s.m.hi } : s.rr;
      var now = s.d ? fmt(s.d.v[cur], s.m.d) : "…", u = s.m.u ? " " + s.m.u : "";
      var mm = "▲" + fmt(src.hi, s.m.d) + "  ▼" + fmt(src.lo, s.m.d);
      ctx.font = "bold " + (fs + 1) + font; var w1 = ctx.measureText(now).width;
      ctx.font = fs + font; var w2 = ctx.measureText(u).width, w3 = ctx.measureText(mm).width;
      rows.push({ s: s, now: now, u: u, mm: mm, w1: w1, w2: w2 });
      labelW = Math.max(labelW, w1 + w2 + 10 + w3 + 8);
    });
    var legendW = Math.min(labelW, W * 0.62);
    if (rows.length) {
      ctx.fillStyle = "rgba(0,0,0,.62)";
      ctx.fillRect(0, 0, legendW + 2, 4 + rows.length * lh);
    }
    rows.forEach(function (r, k) {
      var y = 3 + k * lh, x = 4;
      ctx.fillStyle = r.s.color;
      ctx.font = "bold " + (fs + 1) + font; ctx.fillText(r.now, x, y - 1); x += r.w1;
      ctx.font = fs + font; ctx.fillText(r.u, x, y); x += r.w2 + 10;
      ctx.globalAlpha = 0.72; ctx.fillText(r.mm, x, y); ctx.globalAlpha = 1;
    });

    // where each channel peaks on screen
    if (opt.peaks) {
      ctx.font = "bold " + fs + font; ctx.textBaseline = "bottom"; ctx.textAlign = "center";
      shown.forEach(function (s) {
        if (!s.rr || s.rr.at < 0 || !s.yOf) return;
        var px = (T[s.rr.at] - view.t0) * kx, py = s.yOf(s.rr.hi);
        if (px < 0 || px > W) return;
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.moveTo(px, py - 2); ctx.lineTo(px - 4, py - 8); ctx.lineTo(px + 4, py - 8); ctx.closePath(); ctx.fill();
        var tx = Math.max(legendW + 20, Math.min(W - 20, px)), ty = Math.max(fs + 2, py - 9);
        ctx.fillText(fmt(s.rr.hi, s.m.d), tx, ty);
      });
      ctx.textBaseline = "top"; ctx.textAlign = "left";
    }
    labelW = legendW;

    // the cursor and the values under it
    ctx.font = "bold " + fs + font;
    var cx = (T[cur] - view.t0) * kx;
    if (cx >= -1 && cx <= W + 1) {
      ctx.strokeStyle = "#39e6ff"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, 0); ctx.lineTo(Math.round(cx) + 0.5, H); ctx.stroke();
      var namesW = p.names && p.names.offsetWidth ? p.names.offsetWidth + 8 : 0;
      var right = cx < W - Math.max(96, namesW + 64);
      ctx.textAlign = right ? "left" : "right";
      var y0 = Math.min(H - bot - shown.length * lh - 2, Math.max(3 + shown.length * lh + 4, H / 2 - shown.length * lh / 2));
      var clear = cx + 5;
      if (opt.cursorVals) shown.forEach(function (s, k) {
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
    drawSections(ctx, H, kx, tMin);
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
  function cellText(v, d, narrow) {  // as many decimals as fit the cell (a table fitted to a phone: fewer)
    var a = Math.abs(v);
    // Narrow cells drop the second decimal only: an AFR target of 13.5 must read 13.5, never 14.
    if (narrow) return v.toFixed(a >= 10 ? 0 : Math.min(d, 1));  // a cell under ~21 px: pinch to see the decimal
    return v.toFixed(a >= 100 ? 0 : Math.min(d, a >= 10 ? 1 : 2));
  }
  function binText(v) { return Math.abs(v) >= 100 || v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1); }
  // Cells locked against VE Analyze, by table name (kept in this browser across tunes).
  var locks = (function () { try { return JSON.parse(localStorage.getItem("msq.lv.locks") || "{}") || {}; } catch (e) { return {}; } })();
  function isLocked(t, k) { return !!(locks[t.name] && locks[t.name][k]); }
  function saveLocks() { try { localStorage.setItem("msq.lv.locks", JSON.stringify(locks)); } catch (e) { /* ignore */ } }
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
    this.pos = null;
    this.render();
    if (want3d()) this.set3d(true);
  }
  function setCellSize(big) {
    root.classList.toggle("cells-big", big);
    $$("[data-cells]").forEach(function (x) { x.textContent = big ? "Fit" : "Bigger"; x.classList.toggle("on", big); });
    try { localStorage.setItem("msq.lv.cells", big ? "big" : "fit"); } catch (e) { /* ignore */ }
    allGrids().forEach(function (g) { g.paint(); });
    invalidate();
  }
  var shapeMode = false;
  function want3d() { try { return localStorage.getItem("msq.lv.3d") === "1"; } catch (e) { return false; } }
  Grid.prototype.set3d = function (on) {
    this.is3d = on;
    if (on && !this.s3) this.s3 = new Surface(this);
    this.wrap.style.display = on ? "none" : "";
    if (this.s3) { this.s3.cv.hidden = !on; this.s3.reset.hidden = !on; if (on) this.s3.draw(); }
    var b = this.el.parentNode && this.el.parentNode.querySelector("[data-3d]");
    if (b) b.classList.toggle("on", on);
    var sb = this.el.parentNode && this.el.parentNode.querySelector("[data-shape]");
    if (sb) { sb.hidden = !on || !this.opts.editable; sb.classList.toggle("on", shapeMode); }
    if (this.s3) this.s3.cv.classList.toggle("shaping", shapeMode && on);
  };

  /* The table as a 3D surface: drag to turn it, pinch or wheel to zoom, tap a point to select that cell. */
  function Surface(grid) {
    this.g = grid; this.cam = grid.opts.cam || { yaw: -0.62, pitch: 0.62, zoom: 1 }; this.pts = [];
    this.cv = document.createElement("canvas"); this.cv.className = "lv-3d";
    var self0 = this;
    this.reset = document.createElement("button");
    this.reset.type = "button"; this.reset.className = "lv-3dreset"; this.reset.textContent = "⟲ Reset view";
    this.reset.title = "Back to the whole map, from the usual angle";
    this.reset.addEventListener("click", function () { self0.cam.yaw = -0.62; self0.cam.pitch = 0.62; self0.cam.zoom = 1; self0.draw(); });
    grid.el.appendChild(this.cv);
    grid.el.appendChild(this.reset);
    this.bind();
  }
  Surface.prototype.draw = function (alone) {
    if (!alone && this.g.opts.peers) this.g.opts.peers().forEach(function (g) { if (g.s3 && g.s3 !== this) g.s3.draw(true); }, this);
    if (this.pending) return;
    var self = this; this.pending = true;
    requestAnimationFrame(function () { self.pending = false; self.paint(); });
  };
  Surface.prototype.paint = function () {
    var cv = this.cv;
    if (cv.hidden || !cv.clientWidth) return;
    var f = fit(cv), ctx = f.ctx, W = f.w, H = f.h, g = this.g, t = g.t, C = t.cols, R = t.rows, k;
    ctx.fillStyle = "#0b0c0e"; ctx.fillRect(0, 0, W, H);
    var vals = [], lo = Infinity, hi = -Infinity;
    for (k = 0; k < C * R; k++) {
      var v = this.preview && k in this.preview ? this.preview[k] : g.opts.surf ? g.opts.surf(k) : g.opts.live ? g.opts.live(k) : valueAt(t, k);
      vals[k] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (g.opts.zr) { lo = g.opts.zr[0]; hi = g.opts.zr[1]; }  // side-by-side surfaces share one height scale
    if (!(hi > lo)) hi = lo + 1;
    var paintOf = g.opts.color || function (v) { return heat((v - lo) / (hi - lo)); };
    var cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    var S = Math.min(W * 0.64, H * 0.9) * this.cam.zoom, ox = W / 2, oy = H * 0.54;
    var proj = function (c, r, v) {  // c, r may be fractional; returns [x, y, depth]
      var x = c / (C - 1) - 0.5, y = r / (R - 1) - 0.5, z = (v - lo) / (hi - lo) * 0.5 - 0.25;
      var X = x * cy - y * sy, Y = x * sy + y * cy;
      return [ox + X * S, oy - (z * cp + Y * sp) * S, Y * cp - z * sp];
    };
    var P = [];
    for (k = 0; k < C * R; k++) P[k] = proj(k % C, Math.floor(k / C), vals[k]);
    this.pts = P;
    var quads = [];
    for (var r = 0; r < R - 1; r++) for (var c = 0; c < C - 1; c++) {
      var a = r * C + c, b = a + 1, d2 = a + C, e = d2 + 1;
      quads.push([a, b, e, d2, (P[a][2] + P[b][2] + P[d2][2] + P[e][2]) / 4, (vals[a] + vals[b] + vals[d2] + vals[e]) / 4]);
    }
    quads.sort(function (m, n) { return n[4] - m[4]; });
    ctx.lineWidth = 0.6; ctx.strokeStyle = "rgba(0,0,0,.45)";
    quads.forEach(function (q) {
      ctx.beginPath(); ctx.moveTo(P[q[0]][0], P[q[0]][1]);
      for (var j = 1; j < 4; j++) ctx.lineTo(P[q[j]][0], P[q[j]][1]);
      ctx.closePath(); ctx.fillStyle = paintOf(q[5]); ctx.fill(); ctx.stroke();
    });
    // axis labels along two edges, and the value range
    ctx.font = "10.5px ui-monospace, Menlo, Consolas, monospace"; ctx.fillStyle = "#9aa1a9";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    var everyC = Math.max(1, Math.ceil(C / 6)), everyR = Math.max(1, Math.ceil(R / 6));
    for (c = 0; c < C; c += everyC) { var q1 = proj(c, -0.9, lo); ctx.fillText(binText(t.x[c]), q1[0], q1[1]); }
    for (r = 0; r < R; r += everyR) { var q2 = proj(C - 1 + 0.9, r, lo); ctx.fillText(binText(t.y[r]), q2[0], q2[1]); }
    ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = "#d6d9de";
    ctx.fillText(g.opts.title || ((t.xl || "RPM") + " × " + (t.yl || "Load") + " · " + cellText(lo, t.d) + "–" + cellText(hi, t.d) + (t.units ? " " + t.units : "")), 6, 5);
    // changed cells, selection, and where the log is now
    var mark = function (ks, color, rad) {
      ctx.fillStyle = color;
      ks.forEach(function (j) { ctx.beginPath(); ctx.arc(P[j][0], P[j][1], rad, 0, 6.3); ctx.fill(); });
    };
    if (g.opts.marks) mark(g.opts.marks(), "#ff9f0a", 2.2);
    if (t.p && !g.opts.live) mark(vals.map(function (v, j) { return Math.abs(v - t.p[j]) > 0.5 * Math.pow(10, -t.d) ? j : -1; }).filter(function (j) { return j >= 0; }), "#ff9f0a", 2.2);
    mark(g.selected(), "#ffffff", 3.5);
    if (this.preview) {
      mark(Object.keys(this.preview).map(Number), "#ffd54a", 4);
      ctx.textAlign = "center"; ctx.fillStyle = "#ffd54a"; ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillText((this.delta >= 0 ? "+" : "") + this.delta.toFixed(Math.max(1, t.d)) + (t.units ? " " + t.units : ""), W / 2, 6);
      ctx.font = "10.5px ui-monospace, Menlo, Consolas, monospace";
    }
    if (g.pos) {
      var fx = g.pos[0], fy = g.pos[1], cv0 = interpTable(t, function (j) { return vals[j]; }, fx, fy);
      var top = proj(fx, fy, cv0), base = proj(fx, fy, lo);
      ctx.strokeStyle = "rgba(57,230,255,.7)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
      ctx.fillStyle = "#39e6ff"; ctx.beginPath(); ctx.arc(top[0], top[1], 5, 0, 6.3); ctx.fill();
      ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.textAlign = "right"; ctx.fillStyle = "#39e6ff"; ctx.fillText(cellText(cv0, t.d), W - 6, 5);
    }
  };
  Surface.prototype.bind = function () {
    var self = this, cv = this.cv, pts = {}, start = null, pinch = null;
    cv.addEventListener("pointerdown", function (e) {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
      pts[e.pointerId] = [e.clientX, e.clientY];
      var ids = Object.keys(pts);
      if (ids.length === 2) {
        var a = pts[ids[0]], b = pts[ids[1]];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z: self.cam.zoom }; start = null; self.preview = null;
      } else {
        start = { x: e.clientX, y: e.clientY, yaw: self.cam.yaw, pitch: self.cam.pitch, moved: false };
        var g = self.g;
        if (shapeMode && g.opts.editable && !g.opts.live) {
          // Shape: the point under the finger (and the selection, if it's in it) moves up and down
          var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, best = -1, bd = 34 * 34;
          self.pts.forEach(function (p, k) { var d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y); if (d < bd) { bd = d; best = k; } });
          if (best >= 0) {
            var t = g.t, C = t.cols, w = {}, sel = g.selected();
            if (sel.indexOf(best) >= 0) sel.forEach(function (k) { w[k] = 1; });
            else {  // no selection: a soft brush, so one drag makes a smooth hill, not a spike
              var br = Math.floor(best / C), bc = best % C;
              for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
                var rr = br + dr, cc = bc + dc;
                if (rr >= 0 && rr < t.rows && cc >= 0 && cc < C) w[rr * C + cc] = dr || dc ? 0.4 : 1;
              }
            }
            var lo = Infinity, hi = -Infinity, base = {};
            for (var k = 0; k < t.z.length; k++) { var vv = valueAt(t, k); if (vv < lo) lo = vv; if (vv > hi) hi = vv; }
            Object.keys(w).forEach(function (k) { base[k] = valueAt(t, +k); });
            start.shape = { w: w, base: base, per: Math.max(hi - lo, 1) / 180, key: best };
          }
        }
      }
    });
    cv.addEventListener("pointermove", function (e) {
      if (!(e.pointerId in pts)) return;
      pts[e.pointerId] = [e.clientX, e.clientY];
      var ids = Object.keys(pts);
      if (pinch && ids.length === 2) {
        var a = pts[ids[0]], b = pts[ids[1]];
        self.cam.zoom = Math.max(0.5, Math.min(2.2, pinch.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) || 1) / pinch.d));
        self.draw(); return;
      }
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) start.moved = true;
      if (!start.moved) return;
      if (start.shape) {
        var sh = start.shape, d = -dy * sh.per, unit = Math.pow(10, -self.g.t.d);
        self.preview = {};
        Object.keys(sh.w).forEach(function (k) { self.preview[k] = Math.round((sh.base[k] + d * sh.w[k]) / unit) * unit; });
        self.delta = d;
        self.draw(); return;
      }
      self.cam.yaw = start.yaw + dx * 0.01;
      self.cam.pitch = Math.max(0.08, Math.min(1.5, start.pitch + dy * 0.008));
      self.draw();
    });
    var up = function (e) {
      if (start && start.shape && start.moved && self.preview) {  // the drag is the edit: write it to the table
        var t = self.g.t, pv = self.preview;
        rememberUndo(t, Object.keys(pv).map(Number));
        Object.keys(pv).forEach(function (k) { setValue(t, +k, pv[k]); });
        self.preview = null; self.delta = 0;
        editsChanged(t);
        delete pts[e.pointerId]; start = null; return;
      }
      self.preview = null;
      var tap = start && !start.moved && Object.keys(pts).length === 1;
      delete pts[e.pointerId];
      if (Object.keys(pts).length < 2) pinch = null;
      if (tap && e.type === "pointerup" && self.g.opts.editable && !self.g.opts.live) {
        var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, best = -1, bd = 26 * 26;
        self.pts.forEach(function (p, k) { var d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y); if (d < bd) { bd = d; best = k; } });
        var g = self.g;
        if (best >= 0) {
          if ((e.shiftKey || g.rangeMode) && g.anchor != null) { g.select(g.anchor, best); g.rangeMode = false; }
          else { g.anchor = best; g.select(best, best); }
        } else g.clearSel();
        self.draw();
      }
      if (!Object.keys(pts).length) start = null;
    };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", function (e) {
      e.preventDefault();
      self.cam.zoom = Math.max(0.5, Math.min(2.2, self.cam.zoom * Math.exp(-e.deltaY * 0.0015))); self.draw();
    }, { passive: false });
    cv.addEventListener("dblclick", function () { self.cam.yaw = -0.62; self.cam.pitch = 0.62; self.cam.zoom = 1; self.draw(); });
  };
  Grid.prototype.render = function () {
    var t = this.t, html = [];
    for (var r = t.rows - 1; r >= 0; r--) {
      html.push("<tr><th>" + binText(t.y[r]) + "</th>");
      for (var c = 0; c < t.cols; c++) html.push('<td data-k="' + (r * t.cols + c) + '"></td>');
      html.push("</tr>");
    }
    html.push('<tr class="lv-tx"><th></th>' + t.x.map(function (v) { return "<th>" + binText(v) + "</th>"; }).join("") + "</tr>");
    this.el.innerHTML = '<div class="lv-tw" tabindex="0"><table class="lv-tt' + (this.opts.big ? " big" : "") + '"><tbody>' +
      html.join("") + '</tbody></table><i class="lv-dot" hidden></i></div>' +
      '<button type="button" class="lv-zreset" hidden>⤡ Fit table</button>';
    this.wrap = $(".lv-tw", this.el);
    this.cells = [];
    var self = this;
    $$("td", this.el).forEach(function (td) { self.cells[+td.dataset.k] = td; });
    this.paint();
    this.bind();
    this.pinchable();
  };
  /* Pinch a table to zoom into it (two fingers, any direction); it scrolls sideways when zoomed in, and
     "Fit table" or pinching back out shows all of it again. */
  Grid.prototype.pinchable = function () {
    var self = this, w = this.wrap, g = null;
    this.zoomLv = 1;
    var reset = $(".lv-zreset", this.el);
    reset.addEventListener("click", function () { self.setZoom(1); });
    w.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      var a = e.touches[0], b = e.touches[1], r = w.getBoundingClientRect(), mx = (a.clientX + b.clientX) / 2 - r.left;
      g = { d: Math.max(20, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), z: self.zoomLv,
            fx: (mx + w.scrollLeft) / (w.scrollWidth || 1), mx: mx };
    }, { passive: false });
    w.addEventListener("touchmove", function (e) {
      if (!g || e.touches.length !== 2) return;
      e.preventDefault();
      var a = e.touches[0], b = e.touches[1];
      self.setZoom(Math.max(1, Math.min(3.5, g.z * Math.max(20, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) / g.d)));
      w.scrollLeft = g.fx * w.scrollWidth - g.mx;
    }, { passive: false });
    var end = function (e) { if (e.touches.length < 2) g = null; };
    w.addEventListener("touchend", end); w.addEventListener("touchcancel", end);
  };
  Grid.prototype.setZoom = function (z) {
    var tbl = this.wrap.querySelector("table"), on = z > 1.02;
    this.zoomLv = on ? z : 1;
    tbl.style.width = on ? (z * 100).toFixed(1) + "%" : "";
    tbl.style.fontSize = on ? Math.min(16, 10.5 * Math.sqrt(z) * 1.08).toFixed(1) + "px" : "";
    if (on) tbl.style.setProperty("--zh", Math.round(Math.min(40, 19 * Math.sqrt(z) * 1.1)) + "px"); else tbl.style.removeProperty("--zh");
    tbl.classList.toggle("zoomed", on);
    $(".lv-zreset", this.el).hidden = !on;
    if (!on) this.wrap.scrollLeft = 0;
    this.paint();
  };
  Grid.prototype.paint = function (only) {
    var t = this.t, rg = this.opts.range || range(t), self = this, ks = only || this.cells.map(function (_, k) { return k; });
    var tbl = this.wrap && this.wrap.querySelector("table"), info = this.opts.info, tw = tbl ? tbl.offsetWidth : 0;
    var narrow = this.narrow = tw > 0 && tw / (t.cols + 1) < 34;  // RPM labels as 1k, 1.5k
    var cw = this.cells[0] ? this.cells[0].offsetWidth : 0;
    var tiny = cw > 0 && cw < 15 && !(this.zoomLv > 1.02);  // decimals stay; only a cell under 15 px drops them
    if (narrow !== this.axisNarrow) {  // RPM as 1k, 1.5k… when the columns are narrow
      this.axisNarrow = narrow;
      $$("tr.lv-tx th", this.el).slice(1).forEach(function (th, c) {
        var xv = t.x[c];
        th.textContent = narrow && Math.abs(xv) >= 1000 ? +(xv / 1000).toFixed(1) + "k" : binText(xv);
      });
    }
    ks.forEach(function (k) {
      var td = self.cells[k];
      if (!td) return;
      var v = self.opts.live ? self.opts.live(k) : valueAt(t, k), bg, text = cellText(v, t.d, tiny);
      if (self.mode === "ov" && self.opts.ov) {
        var ov = self.opts.ov[k], kind = self.opts.ovKind;
        if (!(ov === ov)) { bg = "#3a3d42"; text = ""; }
        else if (kind === "time") {
          var mxT = Math.max.apply(null, self.opts.ov.filter(function (q) { return q === q; })) || 1, f = Math.log(1 + ov) / Math.log(1 + mxT);
          bg = "rgb(" + Math.round(215 - 175 * f) + "," + Math.round(230 - 120 * f) + "," + Math.round(255 - 40 * f) + ")";
          text = ov >= 10 ? ov.toFixed(0) : ov >= 0.05 ? ov.toFixed(1) : "";
        } else if (kind === "knock") {
          if (ov > 0.05) { var kf = Math.min(1, ov / 4); bg = "rgb(255," + Math.round(200 - 160 * kf) + "," + Math.round(170 - 140 * kf) + ")"; text = ov.toFixed(1); }
          else { bg = "#b9e6b4"; text = ""; }
        } else { bg = diverge(ov, 10); text = (ov > 0 ? "+" : "") + ov.toFixed(Math.abs(ov) >= 10 ? 0 : 1); }
      } else if (self.mode === "change") {
        var b0 = self.opts.base ? self.opts.base[k] : t.p ? t.p[k] : t.z[k];  // against the original tune
        var pct = b0 ? (v / b0 - 1) * 100 : 0;
        bg = diverge(pct, 15); text = Math.abs(pct) < 0.05 ? "" : (pct > 0 ? "+" : "") + pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1);
      } else if (self.mode === "hits" && info) {
        var h = info.hits(k);
        bg = h > 0 ? "rgb(" + [0, 1, 2].map(function () { return Math.round(235 - Math.min(1, h / 3) * 150); }).join(",") + ")" : "#3a3d42";
        text = h >= 0.01 ? h.toFixed(h >= 10 ? 0 : 1) : "";
      } else if (self.mode === "err" && info) {
        var er = info.err(k);  // + lean (wanted more fuel), − rich
        bg = er === er ? diverge(er, 10) : "#3a3d42"; text = er === er ? (er > 0 ? "+" : "") + er.toFixed(Math.abs(er) >= 10 ? 0 : 1) : "";
      } else if (self.mode === "ran" && info) {
        v = info.ran(k); text = cellText(v, t.d);
        bg = heat(rg[1] > rg[0] ? (v - rg[0]) / (rg[1] - rg[0]) : 0.5);
      } else {
        bg = heat(rg[1] > rg[0] ? (v - rg[0]) / (rg[1] - rg[0]) : 0.5);
      }
      td.style.background = bg;
      td.textContent = text;
      td.classList.toggle("vx-ed", !self.opts.live && edited(t, k));
      td.classList.toggle("vx-lock", isLocked(t, k));
      // an edited copy: mark the cells that differ from the tune it was edited from
      var was = t.p && !self.opts.live ? t.p[k] : null, diff = was != null && Math.abs(v - was) > 0.5 * Math.pow(10, -t.d);
      td.classList.toggle("vx-ch", diff);
      if (diff) td.title = "Was " + cellText(was, t.d) + " in the original"; else if (td.title) td.removeAttribute("title");
    });
    this.fitText(cw);
    this.markSel();
    if (this.s3) this.s3.draw();
  };
  /* The biggest text that fits the cells as they are on this screen, so numbers never overlap or get cut off,
     whatever the phone, the orientation or the number of columns. (Pinch-zoomed tables size themselves.) */
  Grid.prototype.fitText = function (cw) {
    var tbl = this.wrap && this.wrap.querySelector("table");
    if (!tbl || !cw || this.zoomLv > 1.02) return;
    var longest = 3;
    for (var k = 0; k < this.cells.length; k++) { var n = this.cells[k] ? this.cells[k].textContent.length : 0; if (n > longest) longest = n; }
    var fs = Math.max(6.8, Math.min(13.5, (cw - 2) / (longest * 0.58)));
    var want = fs >= 13.4 ? "" : fs.toFixed(1) + "px";
    if (tbl.style.fontSize !== want) tbl.style.fontSize = want;
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
    if (this.s3) this.s3.draw();
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
    var np = fx === fx && fy === fy ? [fx, fy] : null;
    if (this.s3 && this.is3d && (!np !== !this.pos || (np && (np[0] !== this.pos[0] || np[1] !== this.pos[1])))) { this.pos = np; this.s3.draw(); }
    this.pos = np;
    if (this.is3d) return;
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
  /* Undo: before any change to a table (buttons, typing a value, a 3D drag), what those cells were; stepped
     back one change at a time, as long as the page is open. Older states are in History. */
  var undoStack = [];
  function rememberUndo(t, ks) {
    var cells = {};
    ks.forEach(function (k) { cells[k] = valueAt(t, k); });
    undoStack.push({ t: t, cells: cells });
    if (undoStack.length > 200) undoStack.shift();
    renderUndo();
  }
  function undoEdit() {
    var u = undoStack.pop();
    if (!u) { toast("Nothing to undo."); return; }
    Object.keys(u.cells).forEach(function (k) { setValue(u.t, +k, u.cells[k]); });
    editsChanged(u.t);
    allGrids().forEach(function (g) { if (g.t === u.t) Object.keys(u.cells).forEach(function (k) { g.flash(+k); }); });
    toast("Undone: " + Object.keys(u.cells).length + " cell" + (Object.keys(u.cells).length === 1 ? "" : "s") + " in " + (u.t.label || u.t.name) + " back as they were." +
      (undoStack.length ? " (" + undoStack.length + " more to undo)" : ""));
    renderUndo();
  }
  function renderUndo() {
    $$("[data-undo-edit]").forEach(function (b) {
      b.hidden = !undoStack.length;
      b.title = undoStack.length ? "Undo the last change to " + (undoStack[undoStack.length - 1].t.label || "the table") + " (Ctrl/Cmd+Z)" : "";
    });
  }
  function act(grid, what, arg) {
    var t = grid.t, ks = grid.selected();
    if (!ks.length) return;
    if (what !== "lock") rememberUndo(t, ks);
    var step = Math.pow(10, -t.d), s = grid.sel;
    if (what === "set") ks.forEach(function (k) { setValue(t, k, arg); });
    else if (what === "inc" || what === "dec") ks.forEach(function (k) { setValue(t, k, valueAt(t, k) + (what === "inc" ? step : -step)); });
    else if (what === "pct") ks.forEach(function (k) { setValue(t, k, valueAt(t, k) * (1 + arg / 100)); });
    else if (what === "revert") ks.forEach(function (k) { setValue(t, k, t.p ? t.p[k] : t.z[k]); });
    else if (what === "lock") {
      var on = !ks.every(function (k) { return isLocked(t, k); }), set = locks[t.name] || {};
      ks.forEach(function (k) { if (on) set[k] = 1; else delete set[k]; });
      locks[t.name] = set; saveLocks();
      allGrids().forEach(function (g) { if (g.t === t) g.paint(); });
      return;
    }
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
    saveErr = "";
    saveBarClosed = false;
    saveEdits();
    allGrids().forEach(function (g) { if (!t || g.t === t) g.paint(); });
    renderSaveBars();
    scheduleAuto();
    compareSoon();
    if (tab === "sim") simSoon();
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
      '<button type="button" data-t="revert" title="Back to the original tune\'s values">Revert</button>' +
      '<button type="button" data-t="lock" title="Lock or unlock the selected cells: VE Analyze leaves locked cells alone">🔒 Lock</button>' +
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
    slot.el.innerHTML = '<div class="lv-th"><select aria-label="Table">' + opts + '</select><span class="lv-tv mono"></span><button type="button" class="lv-3dbtn lv-sizebtn" data-cells title="Bigger cells for editing (scroll sideways), or fit the whole table">Bigger</button><button type="button" class="lv-3dbtn lv-undobtn" data-undo-edit hidden title="Undo the last change (Ctrl/Cmd+Z)">↶ Undo</button><button type="button" class="lv-3dbtn" data-3d title="Show as a 3D surface">3D</button><button type="button" class="lv-3dbtn lv-shapebtn" data-shape hidden title="Shape the 3D map: drag a point up or down (selected cells move together)">Shape</button></div>' +
      '<div class="lv-ovrow"><span>Cells show</span><select class="lv-ovsel" aria-label="What the cells show">' +
        '<option value="">Values</option><option value="time">Time in each cell</option>' +
        (idx.roles && idx.roles.knock != null ? '<option value="knock">Knock retard (most)</option>' : "") +
        (idx.roles && idx.roles.lambda != null && idx.roles.lambda_target != null ? '<option value="afr">AFR error (average)</option>' : "") +
      '</select><span class="lv-ovnote dim"></span></div>' +
      '<div class="lv-grid"></div>' + toolbar() +
      '<p class="lv-tn">' + esc((t.yl || "Load") + (t.yu ? " (" + t.yu + ")" : "") + " ↑ · " + (t.xl || "RPM") + (t.xu ? " (" + t.xu + ")" : "") + " →") +
      (t.xc == null || t.yc == null ? " · no matching channel in this log, so no cursor" : "") + " · select cells to edit</p>";
    var w = wireTools(slot.el, function () { return slot.grid; });
    slot.grid = new Grid($(".lv-grid", slot.el), t, {
      editable: true, input: w.input, act: function (what) { act(slot.grid, what); },
      onSelect: function (g) { w.tools.hidden = !g.sel; }
    });
    load(t.xc); load(t.yc);
    renderUndo();
    if (slot.ov) { $(".lv-ovsel", slot.el).value = slot.ov; showOverlay(slot); }
  }
  /* What the log did in each cell of a table: seconds spent there, the most knock retard, or the average
     mixture error (+ lean / − rich). Over the chosen sections if there are any, else the whole log. */
  function overlay(t, kind) {
    var R = idx.roles || {}, need = [t.xc, t.yc];
    if (kind === "knock") need.push(R.knock);
    if (kind === "afr") need.push(R.lambda, R.lambda_target);
    if (need.some(function (c) { return c == null || c < 0; })) return Promise.resolve(null);
    return Promise.all(need.map(load)).then(function (arr) {
      if (arr.some(function (a) { return !a; })) return null;
      var X = arr[0].v, Y = arr[1].v, A = arr[2] && arr[2].v, B = arr[3] && arr[3].v, n = t.z.length;
      var sum = new Float64Array(n), wt = new Float64Array(n), top = new Float64Array(n), seen = new Uint8Array(n);
      var sec = inSections(T), ld = (idx.lam && idx.lam.lambda) || 1, td = (idx.lam && idx.lam.lambda_target) || 1;
      for (var i = 0; i < N; i++) {
        if (sec && !sec[i]) continue;
        var fx = where(t.x, X[i]), fy = where(t.y, Y[i] * t.ya + t.yb);
        if (!(fx === fx) || !(fy === fy)) continue;
        var k = Math.round(fy) * t.cols + Math.round(fx), dt = i + 1 < N ? Math.max(0, Math.min(0.2, T[i + 1] - T[i])) : 0;
        if (kind === "time") { sum[k] += dt; seen[k] = 1; }
        else if (kind === "knock") { var v = A[i]; if (v === v) { if (!seen[k] || v > top[k]) top[k] = v; seen[k] = 1; } }
        else {
          var l = A[i] / ld, g = B[i] / td;
          if (l > 0.55 && l < 1.4 && g > 0.55 && g < 1.4) { sum[k] += dt * (l / g - 1) * 100; wt[k] += dt; seen[k] = 1; }
        }
      }
      var out = [];
      for (k = 0; k < n; k++) out.push(!seen[k] ? NaN : kind === "time" ? sum[k] : kind === "knock" ? top[k] : (wt[k] > 0 ? sum[k] / wt[k] : NaN));
      return out;
    });
  }
  function showOverlay(slot) {
    var kind = slot.ov, note = $(".lv-ovnote", slot.el);
    if (!kind) { slot.grid.mode = "value"; slot.grid.opts.ov = null; slot.grid.paint(); note.textContent = ""; return; }
    note.textContent = "working…";
    overlay(slot.t, kind).then(function (vals) {
      if (slot.ov !== kind) return;
      if (!vals) { note.textContent = "this log can't show that for this table"; return; }
      slot.grid.mode = "ov"; slot.grid.opts.ov = vals; slot.grid.opts.ovKind = kind; slot.grid.paint();
      var hit = vals.filter(function (v) { return v === v && (kind !== "knock" || v > 0.05); }).length;
      note.textContent = (sections.length ? "in your sections · " : "whole log · ") +
        (kind === "knock" ? plural(hit, "cell") + " with knock" : plural(vals.filter(function (v) { return v === v; }).length, "cell") + " visited");
    });
  }
  function refreshOverlays() { tableSlots.forEach(function (sl) { if (sl.ov) showOverlay(sl); }); }
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
      out.textContent = "now " + v.toFixed(Math.max(1, t.d)) + (t.units ? " " + t.units : "");
      out.title = "What the engine was using at the cursor: the table read at that moment's RPM and load (the dot), blended between the four cells around it, like the ECU does.";
    });
  }

  /* ---------- saving and sharing edits ----------
     Edits save to the server as an edited copy of the tune, and the page's link switches to it, so the link
     you send shows your changes. Saving again updates your copy in place (this browser keeps its key);
     someone else editing your copy gets their own, so nobody overwrites anybody. Auto-save does it for you. */
  var saveBarClosed = false;
  // A VE Analyze result waiting to be applied or discarded (kept across a reload, never auto-saved).
  var vePending = (function () { try { return localStorage.getItem("msq.lv.vepending:" + TUNE) === "1"; } catch (e) { return false; } })();
  function setVePending(on) {
    vePending = on;
    try { if (on) localStorage.setItem("msq.lv.vepending:" + TUNE, "1"); else localStorage.removeItem("msq.lv.vepending:" + TUNE); } catch (e) { /* ignore */ }
    renderVeApply(); renderSaveBars();
  }
  var OWN_KEY = "msq.lv.own", saving = null, saveAgain = false, autoTimer = 0, saveErr = "", lastSaved = null;
  var autoSave = true;  // always on when a page opens: turning it off lasts only until a reload
  var EKEY = "msq.lv.ekey";
  function editKeys() { try { return JSON.parse(localStorage.getItem(EKEY) || "{}") || {}; } catch (e) { return {}; } }
  function rememberEdit(slug, k) {
    var o = editKeys(), ks;
    o[slug] = k; ks = Object.keys(o);
    while (ks.length > 80) delete o[ks.shift()];
    try { localStorage.setItem(EKEY, JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
  }
  function owned() { try { return JSON.parse(localStorage.getItem(OWN_KEY) || "{}") || {}; } catch (e) { return {}; } }
  function remember(slug, k) {
    var o = owned(), ks;
    o[slug] = k; ks = Object.keys(o);
    while (ks.length > 80) delete o[ks.shift()];
    try { localStorage.setItem(OWN_KEY, JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
  }
  function changedCells() {
    var n = 0;
    idx.tables.forEach(function (t) {
      if (t.p) for (var k = 0; k < t.z.length; k++) if (Math.abs(valueAt(t, k) - t.p[k]) > 0.5 * Math.pow(10, -t.d)) n++;
    });
    return n;
  }
  function renderSaveBars() {
    var n = editCount(), tablesN = Object.keys(edits).length, copy = idx && idx.tune && idx.tune.parent;
    $$(".lv-save").forEach(function (bar) {
      var idle = !n && !saving && !saveErr;  // nothing waiting: a slim line that doesn't follow you around
      bar.hidden = !TUNE || (!n && !copy && !lastSaved && !saveErr) || (idle && saveBarClosed);
      bar.classList.toggle("idle", idle);
      var label = $(".lv-save-n", bar), btn = $("[data-save-tune]", bar);
      $("[data-save-discard]", bar).hidden = !n || !!saving;
      $("[data-save-close]", bar).hidden = !idle;
      $("[data-save-discard]", bar).hidden = true;  // auto-save keeps nothing unsaved for long: Undo does this job
      $("[data-undo-edit]", bar).hidden = !undoStack.length;
      $("[data-save-compare]", bar).hidden = !n && !changedCells();
      $("[data-autosave]", bar).checked = autoSave;
      label.classList.toggle("err", !!saveErr);
      if (vePending && n) label.textContent = "VE Analyze suggests " + plural(n, "change") + ": not applied yet";
      else if (saveErr) label.textContent = "Not saved: " + saveErr;
      else if (saving) label.textContent = "Saving…";
      else if (n) label.textContent = plural(n, "unsaved change") + (tablesN > 1 ? " in " + tablesN + " tables" : "") + (autoSave ? " · saving…" : "");
      else label.textContent = "✓ Saved" + (copy ? " · " + plural(changedCells(), "cell") + " changed from the original" : "");
      btn.textContent = vePending && n ? "Review" : n ? "Save & share" : "Share";
      btn.disabled = !!saving;
    });
  }
  function saveBar() {
    return '<div class="lv-save" hidden><span class="lv-save-n"></span><span class="st-grow"></span>' +
      '<label class="check sm lv-auto" title="Save every change to your edited copy as you go, so your link always has the latest"><input type="checkbox" data-autosave><span>Auto-save</span></label>' +
      '<button class="btn sm" type="button" data-save-discard>Discard</button>' +
      '<button class="btn sm" type="button" data-undo-edit hidden>↶ Undo</button>' +
      '<button class="btn sm" type="button" data-save-compare title="Before and after, side by side">Compare</button>' +
      '<button class="btn sm primary" type="button" data-save-tune>Save &amp; share</button>' +
      '<button class="lv-save-x" type="button" data-save-close title="Hide this until you change something" aria-label="Hide">×</button></div>';
  }
  function scheduleAuto(ms) {
    clearTimeout(autoTimer);
    if (!autoSave || !TUNE || !editCount() || ve.running || vePending) return;
    autoTimer = setTimeout(function () { pushEdits().catch(function () { /* shown in the bar */ }); }, ms == null ? 1500 : ms);
  }
  function pushEdits(checkpoint) {
    if (!TUNE) return Promise.reject(new Error("no tune"));
    if (saving) { saveAgain = true; return saving; }
    if (!editCount()) return Promise.resolve(lastSaved);
    clearTimeout(autoTimer);
    var sent = JSON.parse(JSON.stringify(edits));
    saveErr = "";
    saving = fetch("/t/" + TUNE + "/save", {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ changes: sent, key: owned()[TUNE] || "", checkpoint: checkpoint || "" })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return [r.ok, j]; });
    }, function () { return [false, { error: "check your connection." }]; }).then(function (res) {
      saving = null;
      if (!res[0] || !res[1].slug) {
        saveErr = (res[1] && res[1].error) || "try again.";
        renderSaveBars();
        throw new Error(saveErr);
      }
      applySaved(sent, res[1]);
      if (saveAgain) { saveAgain = false; scheduleAuto(300); }
      return res[1];
    });
    renderSaveBars();
    return saving;
  }
  function applySaved(sent, j) {
    if (j.key) remember(j.slug, j.key);
    if (j.edit_key) rememberEdit(j.slug, j.edit_key);
    var fresh = j.slug !== TUNE;
    idx.tables.forEach(function (t) {
      var e = sent[t.name];
      if (fresh) t.p = e ? t.z.slice() : undefined;  // a new copy: what it was edited from is the tune we were on
      if (!e) return;
      for (var k in e) t.z[k] = e[k];
      var now = edits[t.name];  // keep anything edited while this was saving
      if (now) { for (k in e) if (now[k] === e[k]) delete now[k]; if (!Object.keys(now).length) delete edits[t.name]; }
    });
    if (fresh) {
      try { localStorage.removeItem(EDIT_KEY); } catch (e) { /* ignore */ }
      idx.tune.parent = { slug: TUNE, label: idx.tune.label };
      TUNE = j.slug; EDIT_KEY = "msq.lv.edits:" + TUNE; idx.tune.slug = TUNE; root.dataset.tune = TUNE;
      try { history.replaceState(null, "", urlWithTune(TUNE)); } catch (e) { /* sandboxed */ }
      query = location.search;
      $$(".lv-back").forEach(function (a) { a.href = "/t/" + TUNE; });
    }
    if (j.file) idx.tune.file = j.file;
    lastSaved = j;
    if (typeof schedulePoll === "function") { lastChange = Date.now(); schedulePoll(); }
    compareSoon();
    renderNotes();
    syncSoon(0);  // pick up anything someone else saved meanwhile
    saveEdits();
    allGrids().forEach(function (g) { g.paint(); });
    renderSaveBars();
  }
  function copyText(text, label) {
    var old = label.textContent;
    var ok = function () { label.textContent = "Copied"; setTimeout(function () { label.textContent = old; }, 1600); };
    var fallback = function () {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ok(); } catch (err) { window.prompt("Copy this link", text); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }
  var shareFile = null;
  function openShare() {
    saveNow();
    var url = location.href, dlg = $d('[data-dlg="saved"]'), copy = idx.tune && idx.tune.parent;
    $d("[data-saved-link]").value = url;
    $d("[data-together-link]").hidden = true;
    $d("[data-saved-what]").textContent = copy
      ? "Everyone with this link sees this log with this tune and edits the same tune with you: changes show up on every phone within a few seconds, no refresh. " +
        plural(changedCells(), "cell") + " differ from the original (marked in orange); the original upload is never changed."
      : "Whoever opens this link sees this log, this tune and this exact moment.";
    var dl = $d("[data-saved-download]"), file = (idx.tune && idx.tune.file) || TUNE + ".msq";
    dl.href = "/t/" + TUNE + ".msq"; dl.setAttribute("download", file);
    dl.hidden = !TUNE;
    $d("[data-saved-open]").href = "/t/" + TUNE;
    $d("[data-saved-open]").hidden = !TUNE;
    $d("[data-saved-share]").hidden = !navigator.share;
    var fb = $d("[data-saved-file]");
    fb.hidden = true; shareFile = null;
    // Sending the file itself (to Discord, Messages…) needs it in hand before the tap, so fetch it now.
    if (TUNE && navigator.canShare && window.File) {
      try {
        if (navigator.canShare({ files: [new File([""], file, { type: "application/octet-stream" })] })) {
          fetch("/t/" + TUNE + ".msq").then(function (r) { return r.blob(); }).then(function (b) {
            shareFile = new File([b], file, { type: "application/octet-stream" }); fb.hidden = false;
          }).catch(function () { /* the download link still works */ });
        }
      } catch (e) { /* not supported */ }
    }
    dlg.hidden = false;
  }
  /* A link that lets a friend edit this same tune with you: both pages update live. Makes an edited copy first
     if this is someone's original (originals are never changed). */
  function editTogether(btn) {
    var label = btn.querySelector("span") || btn, old = label.textContent;
    var show = function (k) {
      var u = new URL(location.href);
      u.hash = (location.hash || "#").replace(/&?k=[^&]*/, "") + "&k=" + k;
      var box = $d("[data-together-link]");
      box.value = u.toString(); box.hidden = false; box.focus(); box.select();
      label.textContent = old;
      copyText(box.value, label);
    };
    var fail = function (msg) { label.textContent = old; alert(msg || "That didn't work. Try again."); };
    var ek = editKeys()[TUNE], own = owned()[TUNE];
    if (ek) return show(ek);
    label.textContent = "Setting it up…";
    if (own && idx.tune.parent) {
      fetch("/t/" + TUNE + "/editkey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: own }) })
        .then(function (r) { return r.json(); }).then(function (j) {
          if (!j.edit_key) return fail(j.error);
          rememberEdit(TUNE, j.edit_key); show(j.edit_key);
        }, function () { fail(); });
      return;
    }
    // not ours to change: make our own copy (carrying any unsaved edits), then share that
    var body = editCount() ? { changes: edits } : { fork: true };
    var sent = JSON.parse(JSON.stringify(edits));
    fetch("/t/" + TUNE + "/save", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j.slug) return fail(j.error);
        applySaved(sent, j);
        $d("[data-saved-link]").value = location.href;
        show(j.edit_key);
      }, function () { fail(); });
  }
  /* A separate copy of this tune (with any unsaved edits), with its own link: to try something without
     changing the shared one. */
  function ownCopy(btn) {
    var label = btn.querySelector("span") || btn, old = label.textContent, sent = JSON.parse(JSON.stringify(edits));
    label.textContent = "Making your copy…"; btn.disabled = true;
    fetch("/t/" + TUNE + "/save", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(editCount() ? { changes: edits, fork: true } : { fork: true }) })
      .then(function (r) { return r.json(); }).then(function (j) {
        btn.disabled = false; label.textContent = old;
        if (!j.slug) { alert(j.error || "That didn't work. Try again."); return; }
        applySaved(sent, j); saveNow();
        $d("[data-saved-link]").value = location.href;
        toast("This is now your own copy: its link is in the box. The shared tune is unchanged.");
      }, function () { btn.disabled = false; label.textContent = old; alert("That didn't work. Check your connection."); });
  }
  function saveAndShare(btn) {
    if (!editCount() && !idx.tune.parent) {  // an original: make the shared copy first
      btn.disabled = true;
      fetch("/t/" + TUNE + "/save", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ fork: true }) })
        .then(function (r) { return r.json(); }).then(function (j) {
          btn.disabled = false;
          if (!j.slug) { alert(j.error || "That didn't work. Try again."); return; }
          applySaved({}, j); openShare();
        }, function () { btn.disabled = false; alert("That didn't work. Check your connection."); });
      return;
    }
    if (!editCount()) { openShare(); return; }
    btn.disabled = true;
    pushEdits().then(function () { btn.disabled = false; openShare(); }, function () { btn.disabled = false; });
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
    var range2 = function (name, label, step) {
      return '<label class="lv-opt lv-opt2"><span>' + esc(label) + '</span><input type="number" inputmode="decimal" step="' + step + '" data-o="' + name + 'Lo" placeholder="from">' +
        '<input type="number" inputmode="decimal" step="' + step + '" data-o="' + name + 'Hi" placeholder="to"></label>';
    };
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
          '<select data-ve-mode aria-label="What the cells show"><option value="value">New VE</option><option value="change">Change %</option><option value="hits">Data (s)</option><option value="err">AFR error %</option><option value="ran">VE that ran</option></select>' +
        "</div>" +
        '<p class="lv-ve-status mono" aria-live="polite">Plays through the log and works out each VE cell from the wideband. Nothing changes until you apply it, and the tune is backed up first.</p>' +
        '<div class="lv-ve-bar"><i></i></div>' +
      "</div>" +
      '<div class="lv-ve-apply" hidden></div>' +
      '<div class="lv-ve-warn" hidden></div>' +
      '<div class="lv-ve-main"><div class="lv-ve-gridbox"><div class="lv-th"><b>' + esc(t.label) + '</b><span class="lv-tv mono"></span><button type="button" class="lv-3dbtn lv-sizebtn" data-cells title="Bigger cells for editing (scroll sideways), or fit the whole table">Bigger</button><button type="button" class="lv-3dbtn lv-undobtn" data-undo-edit hidden title="Undo the last change (Ctrl/Cmd+Z)">↶ Undo</button><button type="button" class="lv-3dbtn" data-3d title="Show as a 3D surface">3D</button><button type="button" class="lv-3dbtn lv-shapebtn" data-shape hidden title="Shape the 3D map: drag a point up or down (selected cells move together)">Shape</button></div><div class="lv-grid"></div>' + toolbar() +
        '<p class="lv-tn">' + esc((t.yl || "Load") + (t.yu ? " (" + t.yu + ")" : "") + " ↑ · " + (t.xl || "RPM") + " →") + " · after a run, select cells to adjust them</p></div>" +
        '<div class="lv-ve-side">' +
          '<div class="lv-ve-why"></div>' +
          '<details class="lv-ve-set"><summary>Filters &amp; settings</summary>' +
            opt("minClt", "Min coolant", TEMP_F ? 158 : 70, 1, TEMP_F ? "°F" : "°C") +
            opt("maxChange", "Max change per cell", 15, 1, "% per run (run again for more)") +
            opt("minData", "Data for full change", 0.5, 0.1, "s per cell") +
            opt("tpsRate", "Throttle moving faster than", 30, 1, "%/s") +
            opt("mapRate", "MAP moving faster than", 80, 1, "kPa/s") +
            opt("holdoff", "Wait after a transient", 0.35, 0.05, "s") +
            '<p class="lv-opt-h">Only tune where</p>' +
            range2("rpm", "RPM", 50) + range2("load", (t.yl || "Load") + (t.yu ? " (" + t.yu + ")" : ""), 1) + range2("tps", "Throttle (%)", 1) +
            '<div class="lv-cf"></div><button type="button" class="btn sm" data-cf-add>+ Skip when a channel…</button>' +
            '<p class="lv-opt-h">Result</p>' +
            '<label class="lv-opt"><span>Strength</span><select data-o="strength"><option value="100" selected>100%</option><option value="75">75%</option><option value="50">50%</option><option value="25">25%</option></select><small>how much of the correction to apply</small></label>' +
            '<label class="lv-opt"><span>Wideband delay</span><input type="number" step="10" data-o="lagms" placeholder="Auto"><small>ms · empty = measure it</small></label>' +
            '<label class="lv-opt"><span>Smoothing</span><select data-o="smooth"><option value="0">None</option><option value="0.15" selected>Light</option><option value="0.35">Medium</option><option value="0.6">Strong</option></select></label>' +
            '<label class="check sm"><input type="checkbox" data-o="skipIdle"' + (idx.tune && idx.tune.idle_ve ? " checked" : "") + "><span>Skip idle" + (idx.tune && idx.tune.idle_ve ? " (this tune uses a separate idle VE table)" : "") + "</span></label>" +
          "</details>" +
          (also.length ? '<div class="lv-ve-logs"><b>Logs to use</b><label class="check sm"><input type="checkbox" checked disabled><span>This log</span></label>' +
            also.map(function (s, i) { return '<label class="check sm"><input type="checkbox" data-also="' + s + '" checked><span>Uploaded with it #' + (i + 1) + "</span></label>"; }).join("") + "</div>" : "") +
          saveBar() +
        "</div>" +
      "</div>" +
      '<section class="lv-cmp" hidden>' +
        '<div class="lv-cmp-head"><h3>What changed</h3><select data-cmp-table aria-label="Table to compare"></select>' +
          '<div class="lv-seg" role="group" aria-label="Show as"><button type="button" data-cmp-view="2d" class="on">Tables</button><button type="button" data-cmp-view="3d">3D</button></div>' +
          '<div class="lv-seg lv-cmp-pick" role="group" aria-label="Which to show"><button type="button" data-cmp-show="b">Before</button><button type="button" data-cmp-show="a" class="on">After</button><button type="button" data-cmp-show="d">Change</button></div>' +
        "</div>" +
        '<p class="lv-cmp-sum mono"></p>' +
        '<div class="lv-cmp-grids" data-show="a">' +
          '<div class="lv-cmp-col" data-col="b"><h4>Before <small>the original tune</small></h4><div class="lv-grid"></div></div>' +
          '<div class="lv-cmp-col" data-col="a"><h4>After <small>with the changes</small></h4><div class="lv-grid"></div></div>' +
          '<div class="lv-cmp-col" data-col="d"><h4>Change <small>% more (red) or less (blue) fuel</small></h4><div class="lv-grid"></div></div>' +
        "</div>" +
        '<details class="lv-cmp-list" open><summary>Every changed cell</summary><div class="lv-cmp-tw"><table><thead><tr><th>RPM</th><th>Load</th><th>Before</th><th>After</th><th>Change</th><th class="lv-cmp-hits">Data</th></tr></thead><tbody></tbody></table></div></details>' +
      "</section>";
    var w = wireTools(body, function () { return ve.running ? null : ve.grid; });
    ve.grid = new Grid($(".lv-grid", body), t, {
      big: true, editable: true, input: w.input,
      act: function (what) { if (!ve.running) act(ve.grid, what); },
      onSelect: function (g) { w.tools.hidden = !g.sel || ve.running; },
      info: { hits: function (k) { return ve.engine ? ve.engine.hits[k] : 0; }, ran: function (k) { return ve.engine ? ve.engine.ran(k) : t.z[k]; },
              err: function (k) { return ve.engine ? ve.engine.error(k) : NaN; } }
    });
    $("[data-ve-mode]").addEventListener("change", function () {
      ve.grid.mode = this.value; ve.grid.paint();
    });
    renderSaveBars();
    renderUndo();
    renderFilters();
    renderVeApply();
    if (root.classList.contains("cells-big")) $$("[data-cells]").forEach(function (x) { x.textContent = "Fit"; x.classList.add("on"); });
    if (also.length) also.forEach(function (s, i) {
      fetch("/l/" + s + "/index.json" + query).then(function (r) { return r.json(); }).then(function (j) {
        var lab = $('[data-also="' + s + '"] + span');
        if (lab) lab.textContent = (j.title ? "" : "") + "Uploaded with it: " + fmtLen(j.seconds) + ", " + j.rows.toLocaleString() + " records";
      }).catch(function () { /* still usable */ });
    });
  }
  /* ---------- what changed: before / after / change, side by side ---------- */
  var cmp = { t: null, grids: [], is3d: false, cam: { yaw: -0.62, pitch: 0.62, zoom: 1 }, timer: 0 };
  function baseOf(t) { return t.p || t.z; }
  function changedKs(t) {
    var b = baseOf(t), out = [], eps = 0.5 * Math.pow(10, -t.d);
    for (var k = 0; k < t.z.length; k++) if (Math.abs(valueAt(t, k) - b[k]) > eps) out.push(k);
    return out;
  }
  function compareSoon() { clearTimeout(cmp.timer); cmp.timer = setTimeout(renderCompare, 120); }
  function renderCompare() {
    var box = $(".lv-cmp");
    if (!box || ve.running) return;
    var list = idx.tables.filter(function (t) { return changedKs(t).length; });
    box.hidden = !list.length;
    if (!list.length) { cmp.grids = []; return; }
    if (!cmp.t || list.indexOf(cmp.t) < 0) cmp.t = list.indexOf(ve.table) >= 0 ? ve.table : list[0];
    var t = cmp.t, base = baseOf(t).slice(), ks = changedKs(t), C = t.cols;
    $("[data-cmp-table]", box).innerHTML = list.map(function (x) {
      return "<option value=" + idx.tables.indexOf(x) + (x === t ? " selected" : "") + ">" + esc(x.label) + " · " + plural(changedKs(x).length, "cell") + "</option>";
    }).join("");
    var after = function (k) { return valueAt(t, k); }, pct = function (k) { return base[k] ? (valueAt(t, k) / base[k] - 1) * 100 : 0; };
    var lo = Infinity, hi = -Infinity, big = 0;
    for (var k = 0; k < t.z.length; k++) {
      lo = Math.min(lo, base[k], after(k)); hi = Math.max(hi, base[k], after(k)); big = Math.max(big, Math.abs(pct(k)));
    }
    big = Math.max(5, Math.ceil(big));
    var marks = function () { return ks; }, peers = function () { return cmp.grids; };
    var common = { range: [lo, hi], zr: [lo, hi], cam: cmp.cam, peers: peers, marks: marks };
    var mk = function (col, extra) {
      var o = {}, x;
      for (x in common) o[x] = common[x];
      for (x in extra) o[x] = extra[x];
      return new Grid($('[data-col="' + col + '"] .lv-grid', box), t, o);
    };
    var keep3d = cmp.is3d;
    cmp.grids = [];  // a fresh set (peers() reads this list)
    cmp.grids.push(mk("b", { live: function (k) { return base[k]; }, title: "Before" }));
    cmp.grids.push(mk("a", { live: after, title: "After" }));
    var dg = mk("d", { live: after, base: base, surf: pct, zr: [-big, big], title: "Change %", color: function (v) { return diverge(v, big); } });
    dg.mode = "change"; dg.paint();
    cmp.grids.push(dg);
    cmp.grids.forEach(function (g) { g.set3d(keep3d); });
    // the totals, and every changed cell, biggest first
    var richer = 0, leaner = 0, sum = 0;
    ks.forEach(function (k) { var c = pct(k); if (c > 0) richer++; else leaner++; sum += Math.abs(c); });
    var why = t.p ? "against the tune it was edited from" : "against this tune";
    $(".lv-cmp-sum", box).textContent = plural(ks.length, "cell") + " changed " + why + ": " + richer + " up, " + leaner + " down, " +
      (ks.length ? (sum / ks.length).toFixed(1) : "0") + "% on average.";
    var hits = t === ve.table && ve.engine ? ve.engine.hits : null;
    $(".lv-cmp-hits", box).hidden = !hits;
    var rows = ks.slice().sort(function (a, b) { return Math.abs(pct(b)) - Math.abs(pct(a)); }).slice(0, 400);
    $(".lv-cmp-list tbody", box).innerHTML = rows.map(function (k) {
      var c = pct(k);
      return '<tr data-k="' + k + '"><td>' + binText(t.x[k % C]) + "</td><td>" + binText(t.y[Math.floor(k / C)]) + "</td><td>" + cellText(base[k], t.d) +
        "</td><td><b>" + cellText(after(k), t.d) + '</b></td><td class="' + (c > 0 ? "up" : "down") + '">' + (c > 0 ? "+" : "") + c.toFixed(1) + "%</td>" +
        (hits ? "<td>" + (hits[k] || 0).toFixed(1) + " s</td>" : "") + "</tr>";
    }).join("");
  }
  (function () {
    document.addEventListener("click", function (e) {
      var box = e.target.closest && e.target.closest(".lv-cmp");
      if (!box) return;
      var b = e.target.closest("[data-cmp-view]");
      if (b) {
        cmp.is3d = b.dataset.cmpView === "3d";
        $$("[data-cmp-view]", box).forEach(function (x) { x.classList.toggle("on", x === b); });
        cmp.grids.forEach(function (g) { g.set3d(cmp.is3d); });
        return;
      }
      b = e.target.closest("[data-cmp-show]");
      if (b) {
        $(".lv-cmp-grids", box).dataset.show = b.dataset.cmpShow;
        $$("[data-cmp-show]", box).forEach(function (x) { x.classList.toggle("on", x === b); });
        cmp.grids.forEach(function (g) { if (g.s3) g.s3.draw(true); });
        return;
      }
      var tr = e.target.closest("tr[data-k]");
      if (tr) {  // show that cell in all three
        var k = +tr.dataset.k, C = cmp.t.cols, r = Math.floor(k / C), c = k % C;
        cmp.grids.forEach(function (g) { g.sel = [r, c, r, c]; g.markSel(); });
        $$("tr.on", box).forEach(function (x) { x.classList.remove("on"); });
        tr.classList.add("on");
        $(".lv-cmp-grids", box).scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
    document.addEventListener("change", function (e) {
      var sel = e.target.closest && e.target.closest("[data-cmp-table]");
      if (sel) { cmp.t = idx.tables[+sel.value]; renderCompare(); }
    });
  })();
  var vef = (function () { try { return JSON.parse(localStorage.getItem("msq.lv.vef") || "[]") || []; } catch (e) { return []; } })();
  function saveVef() { try { localStorage.setItem("msq.lv.vef", JSON.stringify(vef)); } catch (e) { /* ignore */ } }
  function renderFilters() {
    var box = $(".lv-cf");
    if (!box) return;
    box.innerHTML = vef.map(function (f, i) {
      return '<div class="lv-cf-row" data-cf="' + i + '"><span>Skip when</span><button type="button" class="lv-pick" data-cf-ch>' + esc(f.n || "Choose…") + "</button>" +
        '<select data-cf-op>' + ["<", ">", "=", "≠"].map(function (o) { return "<option" + (o === f.op ? " selected" : "") + ">" + o + "</option>"; }).join("") + "</select>" +
        '<input type="number" inputmode="decimal" step="any" data-cf-v value="' + (f.v == null ? "" : f.v) + '">' +
        '<button type="button" class="lv-cf-x" data-cf-del aria-label="Remove this filter">×</button></div>';
    }).join("");
  }
  root.addEventListener("click", function (e) {
    if (e.target.closest("[data-cf-add]")) { vef.push({ n: "", op: ">", v: null }); saveVef(); renderFilters(); var last = $$(".lv-cf-row [data-cf-ch]").pop(); if (last) last.click(); return; }
    var row = e.target.closest("[data-cf]");
    if (!row) return;
    var f = vef[+row.dataset.cf];
    if (e.target.closest("[data-cf-del]")) { vef.splice(+row.dataset.cf, 1); saveVef(); renderFilters(); return; }
    var b = e.target.closest("[data-cf-ch]");
    if (b) pick(b, byName(f.n), false, function (c) { f.n = idx.channels[c].n; saveVef(); renderFilters(); });
  });
  root.addEventListener("change", function (e) {
    var row = e.target.closest && e.target.closest("[data-cf]");
    if (!row) return;
    var f = vef[+row.dataset.cf];
    if (e.target.matches("[data-cf-op]")) f.op = e.target.value;
    if (e.target.matches("[data-cf-v]")) f.v = e.target.value === "" ? null : +e.target.value;
    saveVef();
  });
  /* The user's filters as a mask over one log (1 = keep). get(name) -> Promise of that channel's values or null. */
  function filterMask(n, get) {
    var rules = vef.filter(function (f) { return f.n && f.v != null && isFinite(f.v); });
    if (!rules.length) return Promise.resolve(null);
    return Promise.all(rules.map(function (f) { return get(f.n); })).then(function (arrs) {
      var m = new Uint8Array(n);
      for (var i = 0; i < n; i++) {
        var keep = 1;
        for (var r = 0; r < rules.length && keep; r++) {
          var a = arrs[r];
          if (!a) continue;
          var v = a[i], f = rules[r];
          if ((f.op === "<" && v < f.v) || (f.op === ">" && v > f.v) || (f.op === "=" && Math.abs(v - f.v) < 1e-6) || (f.op === "≠" && Math.abs(v - f.v) >= 1e-6)) keep = 0;
        }
        m[i] = keep;
      }
      return m;
    });
  }
  /* The apply / discard / undo strip under VE Analyze's status. */
  var veUndo = null;  // after applying: how to undo it ({id} of the backup, or {parent: true})
  function renderVeApply() {
    var box = $(".lv-ve-apply");
    if (!box) return;
    var n = ve.table && edits[ve.table.name] ? Object.keys(edits[ve.table.name]).length : 0;
    if (vePending && n) {
      box.hidden = false; box.className = "lv-ve-apply pending";
      box.innerHTML = "<span><b>VE Analyze suggests " + plural(n, "cell") + "</b> · not applied yet. The tune is backed up before it changes.</span>" +
        '<span class="st-grow"></span><button class="btn sm" type="button" data-save-compare>Compare</button>' +
        '<button class="btn sm" type="button" data-goto-sim>See it simulated</button>' +
        '<button class="btn sm" type="button" data-ve-discard>Discard</button><button class="btn sm primary" type="button" data-ve-apply>Apply to tune</button>';
    } else if (veUndo) {
      box.hidden = false; box.className = "lv-ve-apply done";
      box.innerHTML = "<span><b>✓ Applied to the tune.</b> The tune as it was before is backed up.</span><span class=\"st-grow\"></span>" +
        '<button class="btn sm" type="button" data-lv-history>History</button><button class="btn sm" type="button" data-ve-undo>↶ Undo VE Analyze</button>';
    } else box.hidden = true;
  }
  function applyVE(btn) {
    if (!editCount()) return;
    btn.disabled = true;
    var wasCopy = !!(idx.tune && idx.tune.parent), stamp = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    vePending = false;
    pushEdits("Before VE Analyze (" + stamp + ")").then(function () {
      try { localStorage.removeItem("msq.lv.vepending:" + TUNE); } catch (e) { /* ignore */ }
      if (!wasCopy) { veUndo = { parent: true }; renderVeApply(); toast("Applied. The original upload is untouched, so Undo goes straight back to it."); return; }
      return fetch("/t/" + TUNE + "/versions", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
        var v = (j.versions || []).filter(function (x) { return /^Before VE Analyze/.test(x.label); })[0];
        veUndo = v ? { id: v.id } : { parent: true };
        renderVeApply(); toast("Applied to the tune. “" + (v ? v.label : "Backup") + "” is in History.");
      });
    }, function () { vePending = true; btn.disabled = false; renderVeApply(); alert("That didn't save. Check your connection and try again."); });
  }
  function undoVE(btn) {
    if (!veUndo || !confirm("Put the tune back to how it was before VE Analyze? (What's there now is backed up too.)")) return;
    btn.disabled = true;
    restoreTo(veUndo).then(function () { veUndo = null; renderVeApply(); toast("Back to how it was before VE Analyze."); },
      function () { btn.disabled = false; });
  }
  function restoreTo(what) {
    return fetch("/t/" + TUNE + "/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(what) })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { alert(j.error || "That didn't restore. Try again."); throw new Error("restore"); }
        idx.tune.rev = null;  // make the next check pull the restored values in
        return new Promise(function (ok) { sync(true); setTimeout(ok, 600); });
      });
  }

  /* History: every backup of this tune, to restore or download. */
  function openHistory() {
    var dlg = $d('[data-dlg="history"]'), list = $d("[data-history-list]");
    dlg.hidden = false;
    list.innerHTML = '<p class="dim">Loading…</p>';
    var fmtAt = function (s) { return new Date(s * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
    fetch("/t/" + TUNE + "/versions", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
      $d("[data-history-backup]").hidden = !j.editable;
      if (!j.editable) { list.innerHTML = '<p class="dim">This is an uploaded original: it never changes, so it has no history. The first edit makes a shared copy, and that copy keeps backups.</p>'; return; }
      list.innerHTML = '<div class="lv-hrow now"><span><b>Now</b> <span class="dim">the tune as it is</span></span></div>' +
        (j.versions || []).map(function (v) {
          return '<div class="lv-hrow"><span><b>' + esc(v.label) + '</b> <span class="dim mono">' + fmtAt(v.at) + "</span></span>" +
            '<a class="btn sm" href="/t/' + TUNE + "/versions/" + v.id + '.msq" download title="Download this backup">⬇</a>' +
            '<button class="btn sm" type="button" data-restore="' + v.id + '">Restore</button></div>';
        }).join("") +
        (j.parent && j.parent.exists ? '<div class="lv-hrow"><span><b>The original</b> <span class="dim">' + esc(j.parent.label || j.parent.slug) + "</span></span>" +
          '<a class="btn sm" href="/t/' + j.parent.slug + '.msq" download>⬇</a><button class="btn sm" type="button" data-restore-parent>Restore</button></div>' : "") +
        (!(j.versions || []).length ? '<p class="dim">No backups yet. One is made before VE Analyze is applied, before any restore, and every 10 minutes while the tune is being edited.</p>' : "");
    }, function () { list.innerHTML = '<p class="dim">History couldn\'t be loaded. Check your connection.</p>'; });
  }
  (function () {
    var dlg = $d('[data-dlg="history"]');
    dlg.addEventListener("click", function (e) {
      var b = e.target.closest("[data-restore], [data-restore-parent]");
      if (b) {
        var parent = b.hasAttribute("data-restore-parent"), what = parent ? { parent: true } : { id: +b.dataset.restore };
        var name = b.closest(".lv-hrow").querySelector("b").textContent;
        if (!confirm("Put the tune back to “" + name + "”? What's there now is backed up first, so you can come back.")) return;
        b.disabled = true;
        restoreTo(what).then(function () { toast("Restored “" + name + "”. Everyone on this link sees it."); openHistory(); }, function () { b.disabled = false; });
        return;
      }
      if (e.target.closest("[data-history-backup]")) {
        var nm = prompt("Name this backup", "Before the next pulls");
        if (nm === null) return;
        fetch("/t/" + TUNE + "/versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: nm }) })
          .then(function (r) { return r.json(); }).then(function (j) { if (j.error) alert(j.error); else { toast("Backed up: " + (nm || "Backup")); openHistory(); } });
      }
    });
  })();
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
      if (d.clt && TEMP_F && isCelsius((meta.channels[R.clt] || {}).u)) d.clt = d.clt.map(f);  // other logs arrive in °C
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
    opts.locked = Object.keys(locks[t.name] || {}).map(Number);
    if (sections.length) others = [];  // sections are times in this log: tune only those
    var engine = VEAL.create(t, opts);
    ve.engine = engine;
    ve.grid.opts.live = function (k) { return engine.current(k); };
    ve.grid.paint();
    var jobs = others.map(function (s) {
      return fetch("/l/" + s + "/index.json" + query).then(function (r) { return r.json(); }).then(function (meta) {
        if (!meta.tables.some(function (x) { return x.id === "ve"; })) return null;
        var fetchC = function (c) { return fetchF32("/l/" + s + "/ch/" + c); };
        return veData(meta, fetchC).then(function (d) {
          return filterMask(d.T.length, function (name) {
            var c = -1;
            meta.channels.forEach(function (m, q) { if (m.n === name) c = q; });
            return c >= 0 ? fetchC(c) : Promise.resolve(null);
          }).then(function (m) { if (m) d.userOk = m; return { d: d, own: false }; });
        });
      }).catch(function () { return null; });
    });
    jobs.push(veData(idx, function (c) { return c === "t" ? Promise.resolve(T) : load(c).then(function (x) { return x && x.v; }); })
      .then(function (d) {
        var sec = inSections(d.T);
        if (sec) d.inSection = sec;
        return filterMask(d.T.length, function (name) { var c = byName(name); return c >= 0 ? load(c).then(function (x) { return x && x.v; }) : Promise.resolve(null); })
          .then(function (m) { if (m) d.userOk = m; return { d: d, own: true }; });
      }));
    Promise.all(jobs).then(function (logs) {
      logs = logs.filter(Boolean);
      var li = 0, i = 0, cur0 = cur, data = null, lagInfo = null;
      function next() {
        if (li >= logs.length) return done();
        data = logs[li].d;
        lagInfo = engine.begin(data);
        i = 0;
        if (logs[li].own) {
          if (sections.length) { var a0 = sections[0][0], a1 = sections[sections.length - 1][1], pd = (a1 - a0) * 0.05; setView(a0 - pd, a1 + pd); }
          else setView(tMin, tMax);
        }
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
    // The result is a suggestion: the VE table's edits, shown and adjustable, but not saved until "Apply to
    // tune" (which backs the tune up first). "Discard" throws it away.
    delete edits[t.name];
    res.changed.forEach(function (c) { setValue(t, c.i, c.to); });
    vePending = res.changed.length > 0;
    setVePending(vePending);
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
      status.textContent = (stopped ? "Stopped early. " : "Done. ") + (sections.length ? "From " + plural(sections.length, "section") + " (" + secLen().toFixed(0) + " s): " : "") +
        plural(res.changed.length, "cell") + " changed" +
        (other ? " from this tune. Against the VE the ECU actually ran: " : ": ") + richer + " richer, " + leaner + " leaner, " +
        avgP.toFixed(1) + "% on average, biggest " + (pcts[bi] > 0 ? "+" : "") + pcts[bi].toFixed(1) + "% at " +
        binText(t.x[big.i % t.cols]) + " rpm / " + binText(t.y[Math.floor(big.i / t.cols)]) + (t.yu ? " " + t.yu : "") +
        ". Nothing is changed yet: check it (Compare shows before and after), adjust cells if you like, then Apply to tune.";
    }
    renderCompare();
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
      else if (tab === "sim" && simPanes) simPanes.forEach(function (p, k) { drawPane(p, k === simPanes.length - 1); });
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
      if (e.pointerType === "touch" && !overview) return;  // fingers on a graph: see touchGraph below
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
      } else if (selMode) { drag = { sel: true }; selDrag = { a: t, b: t }; invalidate(); }
      else { drag = {}; setCursor(nearest(t)); }
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
      else if (drag.sel) { selDrag.b = t; invalidate(); }
      else setCursor(nearest(t));
    });
    ["pointerup", "pointercancel"].forEach(function (ev) {
      cv.addEventListener(ev, function (e) {
        delete pts[e.pointerId]; pinch = null;
        if (drag && drag.sel && selDrag) {
          var a = selDrag.a, b = selDrag.b;
          selDrag = null;
          if (ev === "pointerup" && Math.abs(b - a) >= 0.2) addSection(a, b); else invalidate();
        }
        if (!Object.keys(pts).length) drag = null;
      });
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
    if (!overview) {
      cv.addEventListener("dblclick", function (e) { zoom(0.5, tAt(e)); });
      touchGraph(cv.parentNode || cv, cv);
    }
  }
  /* Fingers on a graph, handled from touch events so nothing depends on hitting a sweet spot:
     two fingers anywhere zoom and pan (spread in any direction), one finger sideways scrubs (or selects a
     section in ✂ mode), one finger up or down scrolls the page, a tap moves the cursor, a double-tap zooms in. */
  function touchGraph(el, cv) {
    var g = null, lastTap = 0, lastX = 0;
    var tAtX = function (x) { var r = cv.getBoundingClientRect(); return view.t0 + (x - r.left) / r.width * (view.t1 - view.t0); };
    var startPinch = function (e) {
      var a = e.touches[0], b = e.touches[1];
      g = { pinch: true, d: Math.max(24, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), t0: view.t0, t1: view.t1,
            mid: (a.clientX + b.clientX) / 2 };
      selDrag = null;
    };
    el.addEventListener("touchstart", function (e) {
      if (ve.running) return;
      if (e.touches.length >= 2) { e.preventDefault(); if (playing) play(false); startPinch(e); return; }
      if (e.target.closest && e.target.closest("button")) { g = null; return; }  // a channel name: let it be tapped
      var t = e.touches[0];
      g = { x: t.clientX, y: t.clientY, mode: null };
    }, { passive: false });
    el.addEventListener("touchmove", function (e) {
      if (!g) return;
      if (e.touches.length >= 2) {
        if (e.cancelable) e.preventDefault();
        if (!g.pinch) startPinch(e);
        var a = e.touches[0], b = e.touches[1], r = cv.getBoundingClientRect();
        var d = Math.max(24, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), mid = (a.clientX + b.clientX) / 2;
        var span = (g.t1 - g.t0) * g.d / d, anchor = g.t0 + (g.mid - r.left) / r.width * (g.t1 - g.t0);
        var t0 = anchor - (mid - r.left) / r.width * span;
        setView(t0, t0 + span);
        return;
      }
      if (g.pinch) return;  // one finger left after a pinch: do nothing until it lifts
      var t = e.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y;
      if (!g.mode) {
        if (Math.abs(dx) > 6 && Math.abs(dx) >= Math.abs(dy) * 0.8) {
          g.mode = "h";
          if (playing) play(false);
          if (selMode) selDrag = { a: tAtX(g.x), b: tAtX(g.x) };
        } else if (Math.abs(dy) > 8) { g.mode = "v"; return; }  // the page scrolls
        else return;
      }
      if (g.mode !== "h") return;
      if (e.cancelable) e.preventDefault();
      if (selDrag) { selDrag.b = tAtX(t.clientX); invalidate(); }
      else setCursor(nearest(tAtX(t.clientX)));
    }, { passive: false });
    var end = function (e) {
      if (!g) return;
      if (g.pinch) { if (!e.touches.length) g = null; return; }
      if (selDrag) {
        var a = selDrag.a, b = selDrag.b;
        selDrag = null;
        if (Math.abs(b - a) >= 0.2) addSection(a, b); else invalidate();
      } else if (!g.mode && e.type === "touchend") {  // a tap
        var now = Date.now();
        if (e.cancelable) e.preventDefault();  // no emulated mouse click / dblclick after it
        if (playing) play(false);
        if (now - lastTap < 320 && Math.abs(g.x - lastX) < 40) { zoom(0.5, tAtX(g.x)); lastTap = 0; }
        else { setCursor(nearest(tAtX(g.x))); lastTap = now; lastX = g.x; }
      }
      g = null;
    };
    el.addEventListener("touchend", end, { passive: false });
    el.addEventListener("touchcancel", end);
    el.addEventListener("gesturestart", function (e) { e.preventDefault(); });  // iOS: no page zoom over a graph
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
    pop.querySelector(".lv-pop-title").textContent = allowNone ? "Choose a channel for this graph" : "Choose a channel";
    var render = function () {
      var q = popIn.value.trim().toLowerCase().split(/\s+/).filter(Boolean), html = [], flat = [];
      if (allowNone && !q.length) html.push('<li data-c="-1" class="none">None (remove)</li>');
      if (!q.length) {  // the channels that matter for tuning, by plain name, before the full list
        var sug = [], seenS = {};
        SUGGEST.forEach(function (r) {
          var c = channelFor(r[0]);
          if (c < 0 || seenS[c]) return;
          seenS[c] = 1;
          sug.push('<li data-c="' + c + '"' + (c === current ? ' class="on"' : "") + ">" + esc(r[1]) + " <small>" + esc(idx.channels[c].n) + "</small></li>");
        });
        if (sug.length) html.push('<li class="lv-pop-h">Suggested for tuning</li>' + sug.join("") + '<li class="lv-pop-h">All channels</li>');
      }
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
      "&n=" + paneCount + "&c=" + cur + "&v=" + view.t0.toFixed(2) + "-" + view.t1.toFixed(2) + (tab !== "graphs" ? "&tab=" + tab : "") +
      (sections.length ? "&s=" + sections.map(function (r) { return r[0].toFixed(2) + "-" + r[1].toFixed(2); }).join(",") : "");
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
      chosen = DEFAULTS.map(function (row) { return pad(row.map(layoutChannel).filter(function (c) { return c >= 0; })); });
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
    if (h.k && TUNE && /^[A-Za-z0-9_-]{8,64}$/.test(h.k)) { remember(TUNE, h.k); rememberEdit(TUNE, h.k); }  // an edit-together link
    if (h.k) setTimeout(saveNow, 0);  // take the key out of the address bar, so Copy link never hands it on
    if (h.s) h.s.split(",").forEach(function (part) {
      var m2 = /^(-?[\d.]+)-(-?[\d.]+)$/.exec(part);
      if (m2 && +m2[2] > +m2[1]) sections.push([Math.max(tMin, +m2[1]), Math.min(tMax, +m2[2])]);
    });
    sc.x = channelFor("rpm"); sc.y = channelFor("map"); sc.z = channelFor("afr");
    vePane = { ch: pad(["rpm", "map", "afr", "afr_target"].map(channelFor)), i: 0, ve: true };
  }

  /* ---------- tabs ---------- */
  function setTab(name) {
    if (ve.running && name !== "ve") return;
    tab = name;
    if (idx) setTimeout(renderSections, 0);
    $$("[data-lv-tab]").forEach(function (x) { x.setAttribute("aria-selected", x.dataset.lvTab === tab ? "true" : "false"); });
    $$("[data-lv-panel]").forEach(function (x) { x.hidden = x.dataset.lvPanel !== tab; });
    root.classList.toggle("tab-ve", tab === "ve");
    if (tab === "scatter") { load(sc.x); load(sc.y); load(sc.z); scatterDirty = true; }
    if (tab === "ve") {
      if (!vePane.el) { makePane(vePane, $(".lv-ve-graph")); vePane.el.classList.add("lv-pane-ve"); }
      if (!ve.grid && !$(".lv-ve-body").children.length) buildVE();
    }
    if (tab === "sim") openSim();
    invalidate(); saveSoon();
  }
  var simPanes = null;
  function openSim() {
    var host = $(".lv-sim-graph");
    if (!simPanes && simIdx >= 0) {
      var afrC = channelFor("afr"), tgtC = channelFor("afr_target"), rpmC = channelFor("rpm");
      simPanes = [{ ch: [afrC, tgtC, rpmC, -1], i: 0, sim: true, ve: true }, { ch: [simIdx, tgtC, rpmC, -1], i: 1, sim: true, ve: true }];
      simPanes.forEach(function (p, k) {
        makePane(p, host);
        var tag = document.createElement("span");
        tag.className = "lv-pane-tag " + (k ? "sim" : "rec");
        tag.textContent = k ? "Simulated: with the VE table as it is now" : "Recorded";
        p.el.appendChild(tag);
      });
    }
    resim();
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
      else if (a === "sec") { selMode = !selMode; secStart = null; renderSections(); invalidate(); }
      else if (a === "together") together.toggle();
      return;
    }
    b = e.target.closest("[data-sec], [data-sec-del], [data-sec-go]");
    if (b) {
      if (b.dataset.secDel != null) { sections.splice(+b.dataset.secDel, 1); sectionsChanged(); return; }
      if (b.dataset.secGo != null) { var r0 = sections[+b.dataset.secGo], pad = (r0[1] - r0[0]) * 0.1; setView(r0[0] - pad, r0[1] + pad); return; }
      var w = b.dataset.sec;
      if (w === "start") { secStart = T[cur]; renderSections(); invalidate(); }
      else if (w === "end") { addSection(secStart != null ? secStart : tMin, T[cur]); secStart = null; renderSections(); }
      else if (w === "view") addSection(view.t0, view.t1);
      else if (w === "clear") { sections = []; secStart = null; sectionsChanged(); }
      else if (w === "tune") { selMode = false; setTab("ve"); renderSections(); }
      return;
    }
    b = e.target.closest("[data-lv-tab]");
    if (b) { setTab(b.dataset.lvTab); return; }
    b = e.target.closest("[data-ve]");
    if (b) { if (b.dataset.ve === "run") runVE(); else ve.running = false; return; }
    b = e.target.closest("[data-save-tune]");
    if (b && vePending && editCount()) { setTab("ve"); return; }
    if (b) { saveAndShare(b); return; }
    b = e.target.closest("[data-ve-apply]");
    if (b) { applyVE(b); return; }
    b = e.target.closest("[data-ve-discard]");
    if (b) { if (confirm("Throw away VE Analyze's suggestion? The tune stays as it is.")) { var vt = ve.table; delete edits[vt.name]; setVePending(false); editsChanged(vt); } return; }
    b = e.target.closest("[data-ve-undo]");
    if (b) { undoVE(b); return; }
    b = e.target.closest("[data-goto-sim]");
    if (b) { setTab("sim"); window.scrollTo(0, 0); return; }
    b = e.target.closest("[data-sim-run]");
    if (b) { resim(); return; }
    b = e.target.closest("[data-lv-history]");
    if (b) { openHistory(); return; }
    b = e.target.closest("[data-undo-edit]");
    if (b) { undoEdit(); return; }
    b = e.target.closest("[data-save-close]");
    if (b) { saveBarClosed = true; renderSaveBars(); return; }
    b = e.target.closest("[data-save-compare]");
    if (b) {
      setTab("ve");
      renderCompare();
      var cbox = $(".lv-cmp");
      if (cbox && !cbox.hidden) setTimeout(function () { cbox.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
      return;
    }
    b = e.target.closest("[data-cells]");
    if (b) { setCellSize(!root.classList.contains("cells-big")); return; }
    b = e.target.closest("[data-shape]");
    if (b) {
      shapeMode = !shapeMode;
      allGrids().concat(ve.grid ? [ve.grid] : []).forEach(function (g) { if (g.is3d) g.set3d(true); });
      toast(shapeMode ? "Shape: drag a point up or down. Tap cells first to move a whole area together (great for slopes). Tap Shape again to turn the map."
                      : "Back to turning the map. Tap Shape to edit by dragging.");
      return;
    }
    b = e.target.closest("[data-3d]");
    if (b) {
      var box = b.closest(".lv-table, .lv-ve-gridbox"), gr = null;
      tableSlots.forEach(function (s) { if (s.el === box) gr = s.grid; });
      if (!gr && ve.grid && box && box.contains(ve.grid.el)) gr = ve.grid;
      if (gr) {
        var on = !gr.is3d;
        allGrids().concat(ve.grid ? [ve.grid] : []).forEach(function (g) { g.set3d(on); });
        try { localStorage.setItem("msq.lv.3d", on ? "1" : "0"); } catch (err) { /* ignore */ }
        invalidate();
      }
      return;
    }
    b = e.target.closest("[data-lv-opts]");
    if (b) { openOpts(); return; }
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
    if (b && TUNE && (editCount() || !idx.tune.parent)) { saveAndShare(b); return; }
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
  $("[data-lv-speed]").addEventListener("change", function () { speed = +this.value || 1; invalidate(); together.send(true); });
  function applyPreset(name) {
    var pr = PRESETS[name];
    if (!pr) return;
    var pad = function (a) { a = a.slice(0, SLOTS); while (a.length < SLOTS) a.push(-1); return a; };
    var rows = pr.p.map(function (row) { return pad(row.map(layoutChannel).filter(function (c) { return c >= 0; })); })
      .filter(function (row) { return row[0] >= 0; });
    while (rows.length < MAX_PANES) rows.push(pad([]));
    panes = rows.slice(0, MAX_PANES).map(function (row) { return { ch: row }; });
    paneCount = Math.min(pr.n, window.innerWidth < 760 ? 2 : pr.n);
    buildPanes();
    panes.forEach(function (p, i) { if (i < paneCount) p.ch.forEach(load); });
    invalidate(); saveSoon(); saveLayout();
  }
  $("[data-lv-preset]").addEventListener("change", function () {
    if (this.value) applyPreset(this.value);
    this.value = "";
  });
  $("[data-lv-count]").addEventListener("change", function () {
    paneCount = +this.value;
    panes.forEach(function (p, i) { p.el.hidden = i >= paneCount; p.ch.forEach(load); });
    invalidate(); saveSoon(); saveLayout();
  });
  $("[data-sc-range]").addEventListener("change", function () { scatterDirty = true; invalidate(); });
  root.addEventListener("change", function (e) {
    var cb = e.target.closest("[data-autosave]");
    if (!cb) return;
    autoSave = cb.checked;
    renderSaveBars(); scheduleAuto(200);
  });

  /* ---------- editing together: stay in step with every other page on this tune ---------- */
  var syncing = false, syncTimer = 0;
  function syncSoon(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(function () { sync(true); }, ms || 0); }
  function sync(force) {
    if (!TUNE || !idx || !idx.tune || syncing || saving || ve.running) return;
    if (!force && document.hidden) return;
    syncing = true;
    var done = function () { syncing = false; };
    fetch("/t/" + TUNE + "/rev", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || j.rev === idx.tune.rev) return done();
      lastChange = Date.now(); schedulePoll();  // edits are flying: check often for a while
      return fetch(base + "/index.json?tune=" + TUNE + "&lite=1", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (fresh) {
        done();
        if (!fresh.tune || fresh.tune.slug !== TUNE) return;
        var moved = 0, flashes = {};
        (fresh.tables || []).forEach(function (nt) {
          var t = idx.tables.filter(function (x) { return x.name === nt.name; })[0];
          if (!t || nt.z.length !== t.z.length) return;
          for (var k = 0; k < t.z.length; k++) {
            if (Math.abs(nt.z[k] - t.z[k]) > 1e-9) {
              t.z[k] = nt.z[k];
              if (!edited(t, k)) { moved++; (flashes[t.name] = flashes[t.name] || []).push(k); }
            }
          }
          t.p = nt.p;
        });
        var notesChanged = (fresh.tune.notes || "") !== (idx.tune.notes || "");
        idx.tune.rev = fresh.tune.rev; idx.tune.notes = fresh.tune.notes; idx.tune.changed = fresh.tune.changed;
        allGrids().forEach(function (g) { g.paint(); (flashes[g.t.name] || []).forEach(function (k) { g.flash(k); }); });
        renderSaveBars(); compareSoon();
        if (notesChanged) renderNotes(true);
        if (moved) toast("Updated live: " + plural(moved, "cell") + " changed on this tune");
        else if (notesChanged) toast("Notes updated");
      });
    }).catch(done);
  }
  /* How often to check, so the server only works while people are: every 3 s while edits are flying (a change
     here or from someone else in the last 2 minutes), every 8 s while someone is using the page, every 30 s
     for a while after, and not at all once the page has sat untouched for 10 minutes or is hidden. Touching
     the page again checks at once. (With nothing checking, Railway can put the server to sleep.) */
  var lastUse = Date.now(), lastChange = 0, pollT = 0, polling = false;
  function pollDelay() {
    var now = Date.now(), use = now - lastUse, change = now - lastChange;
    if (document.hidden || (use > 600000 && change > 600000)) return 0;
    if (change < 120000) return 3000;
    if (use < 120000) return 8000;
    return 30000;
  }
  function schedulePoll() {
    clearTimeout(pollT);
    var d = pollDelay();
    polling = d > 0;
    if (polling) pollT = setTimeout(function () { sync(false); schedulePoll(); }, d);
  }
  function woke() {
    var idle = !polling;
    lastUse = Date.now();
    if (idle && !document.hidden) { sync(true); schedulePoll(); }
  }
  ["pointerdown", "keydown", "touchstart", "wheel"].forEach(function (ev) { document.addEventListener(ev, woke, { passive: true, capture: true }); });
  window.addEventListener("scroll", function () { if (!polling) woke(); else lastUse = Date.now(); }, { passive: true });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { lastUse = Date.now(); sync(true); } schedulePoll(); });
  schedulePoll();

  var toastBox = null, toastT = 0;
  function toast(msg) {
    if (!toastBox) { toastBox = document.createElement("div"); toastBox.className = "lv-toast"; toastBox.setAttribute("role", "status"); document.body.appendChild(toastBox); }
    toastBox.textContent = msg; toastBox.classList.add("on");
    var ms = Math.max(4500, Math.min(10000, String(msg).length * 70));  // longer messages stay up longer
    clearTimeout(toastT); toastT = setTimeout(function () { toastBox.classList.remove("on"); }, ms);
  }

  /* Notes on the tune, shared with everyone on its link (and carried into copies). */
  var notesT = 0;
  function renderNotes(fromServer) {
    var box = $(".lv-notesbox");
    if (!box || !idx || !idx.tune) { if (box) box.hidden = true; return; }
    box.hidden = false;
    var ta = $("textarea", box), mine = !!(idx.tune.parent || owned()[TUNE]);
    if (!fromServer || document.activeElement !== ta) ta.value = idx.tune.notes || "";
    ta.placeholder = mine ? "What you changed and why, what to log next… everyone on this link sees it."
      : "Notes for this tune. Typing here makes the shared copy (like editing a cell).";
    $(".lv-notes-n", box).textContent = idx.tune.notes ? "" : "none yet";
    if (idx.tune.notes && !box.open && fromServer) box.open = true;
  }
  root.addEventListener("input", function (e) {
    var ta = e.target.closest && e.target.closest(".lv-notesbox textarea");
    if (!ta) return;
    clearTimeout(notesT);
    var st = $(".lv-notes-st");
    st.textContent = "…";
    notesT = setTimeout(function () {
      var text = ta.value, go = function () {
        fetch("/t/" + TUNE + "/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: text, key: owned()[TUNE] || "" }) })
          .then(function (r) { return r.json(); }).then(function (j) {
            if (j.ok) { idx.tune.notes = text; idx.tune.rev = j.rev; st.textContent = "✓ saved"; $(".lv-notes-n").textContent = ""; }
            else st.textContent = j.error || "not saved";
          }, function () { st.textContent = "not saved: check your connection"; });
      };
      if (idx.tune.parent) return go();
      // someone else's tune: make our own copy first, then write the notes on it
      fetch("/t/" + TUNE + "/save", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ fork: true }) })
        .then(function (r) { return r.json(); }).then(function (j) { if (j.slug) { applySaved({}, j); go(); } else st.textContent = j.error || "not saved"; },
          function () { st.textContent = "not saved: check your connection"; });
    }, 900);
  });

  /* ---------- the share dialog and the display options ---------- */
  (function () {
    var dlg = $d('[data-dlg="saved"]');
    dlg.addEventListener("click", function (e) {
      var url = $d("[data-saved-link]").value;
      if (e.target.closest("[data-saved-copy]")) copyText(url, e.target.closest("[data-saved-copy]").querySelector("span") || e.target);
      else if (e.target.closest("[data-saved-share]")) navigator.share({ title: root.dataset.name + " · edited tune", url: url }).catch(function () { /* cancelled */ });
      else if (e.target.closest("[data-saved-file]") && shareFile) navigator.share({ files: [shareFile], title: shareFile.name }).catch(function () { /* cancelled */ });
      else if (e.target.closest("[data-ownfork]")) ownCopy(e.target.closest("[data-ownfork]"));
    });
    $d("[data-saved-link]").addEventListener("focus", function () { this.select(); });
  })();
  function openOpts() {
    var dlg = $d('[data-dlg="opts"]');
    $d("[data-temp]").value = TEMP_F ? "F" : "C";
    $$("[data-opt]", dlg).forEach(function (el) {
      var k = el.dataset.opt;
      if (el.type === "checkbox") el.checked = !!opt[k]; else el.value = String(opt[k]);
    });
    dlg.hidden = false;
  }
  $d('[data-dlg="opts"]').addEventListener("change", function (e) {
    if (e.target.matches("[data-temp]")) {
      try { localStorage.setItem("msq.lv.temp", e.target.value); } catch (err) { /* ignore */ }
      location.reload(); return;
    }
    var el = e.target.closest("[data-opt]");
    if (!el) return;
    var k = el.dataset.opt;
    opt[k] = el.type === "checkbox" ? el.checked : typeof OPT_DEF[k] === "number" ? +el.value : el.value;
    saveOpts(); invalidate();
  });
  $d("[data-opt-reset]").addEventListener("click", function () {
    for (var k in OPT_DEF) opt[k] = OPT_DEF[k];
    saveOpts(); openOpts(); invalidate();
  });
  root.addEventListener("change", function (e) {
    var ovs = e.target.closest(".lv-ovsel");
    if (ovs) {
      var sl = tableSlots[+ovs.closest(".lv-table").dataset.slot];
      sl.ov = ovs.value; showOverlay(sl);
      return;
    }
    var sel = e.target.closest(".lv-th select");
    if (!sel) return;
    var slot = tableSlots[+sel.closest(".lv-table").dataset.slot];
    slot.t = idx.tables[+sel.value];
    buildSlot(slot); invalidate();
  });
  document.addEventListener("keydown", function (e) {
    if (idx && (e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      var tg = e.target && e.target.tagName;
      if (tg !== "INPUT" && tg !== "TEXTAREA") { e.preventDefault(); undoEdit(); return; }
    }
    if (!idx || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (t && t.closest && t.closest(".lv-tw")) return;  // the table has the keyboard
    var k = e.key, big = e.shiftKey ? 10 : 1;
    if (k === "Escape" && selMode) { selMode = false; renderSections(); invalidate(); }
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

  function gestureHint() {
    var seen = false;
    try { seen = localStorage.getItem("msq.lv.hint") === "1"; } catch (e) { /* ignore */ }
    if (seen || !window.matchMedia("(pointer: coarse)").matches) return;
    var box = document.createElement("div");
    box.className = "lv-hint";
    box.innerHTML = "<p><b>Two fingers</b> on a graph to zoom · <b>drag sideways</b> to move through the log · <b>double-tap</b> to zoom in · " +
      "<b>pinch a table</b> to make it bigger · <b>tap a channel name</b> to change it</p><button type=\"button\" class=\"btn sm primary\">Got it</button>";
    graphs.appendChild(box);
    var done = function () { box.remove(); try { localStorage.setItem("msq.lv.hint", "1"); } catch (e) { /* ignore */ } };
    box.querySelector("button").addEventListener("click", done);
    setTimeout(function () { if (box.isConnected) box.classList.add("fade"); }, 9000);
    setTimeout(function () { if (box.isConnected) done(); }, 9800);
  }

  /* Temperatures in °F (the default; ⚙ has °C): whatever the log or tune stores, °C channels, ranges and
     temperature axes are converted for display. Table values themselves aren't, so edits save as stored. */
  var TEMP_F = (function () { try { return (localStorage.getItem("msq.lv.temp") || "F") !== "C"; } catch (e) { return true; } })();
  function isCelsius(u) { return /^\s*(°\s*c|deg\s*c|degc|c|celsius|degrees\s*c)\s*$/i.test(String(u || "")); }
  function f(v) { return v == null ? v : v * 1.8 + 32; }
  function toFahrenheit() {
    if (!TEMP_F || !idx) return;
    idx.channels.forEach(function (m) {
      if (!isCelsius(m.u)) return;
      m.toF = true; m.u = "°F"; m.lo = f(m.lo); m.hi = f(m.hi);
      if (m.lo != null) { m.lo = Math.round(m.lo * 10) / 10; m.hi = Math.round(m.hi * 10) / 10; }
    });
    (idx.tables || []).forEach(function (t) {
      if (isCelsius(t.xu)) { t.x = t.x.map(f); t.xu = "°F"; }
      if (isCelsius(t.yu)) { t.y = t.y.map(f); t.yu = "°F"; }
    });
  }

  /* ---------- start ---------- */
  function fail(msg) { loadNote.textContent = msg; loadNote.classList.add("err"); loadNote.hidden = false; }
  Promise.all([
    fetch(base + "/index.json" + query).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
    fetchF32(base + "/ch/t")
  ]).then(function (res) {
    idx = res[0]; T = res[1]; N = T.length;
    toFahrenheit();
    if (N < 2) return fail("This log has no records to show.");
    addVirtual();
    addSimulated();
    if (idx.tune && idx.tune.stoich) stoich = idx.tune.stoich;
    initialLayout();
    buildPanes();
    scButtons();
    scrub($(".lv-over canvas"), true);
    watch.forEach(load);
    var side = $(".lv-side");
    side.insertAdjacentHTML("afterbegin", saveBar());
    if (TUNE) side.insertAdjacentHTML("afterbegin", '<details class="lv-notesbox" hidden><summary><b>Notes</b> <span class="dim lv-notes-n"></span>' +
      '<span class="st-grow"></span><span class="lv-notes-st dim"></span></summary><textarea rows="4" maxlength="8000" aria-label="Notes on this tune"></textarea></details>');
    if (idx.tables && idx.tables.length) {
      root.classList.add("has-side");
      restoreEdits();
      if (editCount()) setTimeout(function () { scheduleAuto(600); renderSaveBars(); }, 0);  // unsaved edits from before a reload: save them now
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
    renderNotes();
    renderSections();
    together.start();
    try { localStorage.removeItem("msq.lv.cells"); } catch (e) { /* ignore */ }
    var repaintT = 0;
    window.addEventListener("resize", function () { clearTimeout(repaintT); repaintT = setTimeout(function () { allGrids().forEach(function (g) { g.paint(); }); }, 150); });
    loadNote.hidden = true;
    gestureHint();
    root.classList.add("ready");
    if (window.ResizeObserver) new ResizeObserver(function () { scatterDirty = true; invalidate(); }).observe($(".lv-main"));
    // Held wide (a phone on its side, an iPhone Duo open), the viewer fits the screen: tell the CSS how much
    // height is left under the header and the fixed status bar.
    var fitHeight = function () {
      var top = $(".lv-body").getBoundingClientRect().top + window.scrollY;
      var sb = document.querySelector(".statusbar"), sbh = sb && getComputedStyle(sb).position === "fixed" ? sb.offsetHeight : 0;
      var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      root.style.setProperty("--lvh", Math.max(240, Math.floor(vh - top - sbh - 6)) + "px");
    };
    fitHeight();
    window.addEventListener("resize", function () { fitHeight(); scatterDirty = true; invalidate(); });
    window.addEventListener("orientationchange", function () { setTimeout(function () { fitHeight(); scatterDirty = true; invalidate(); }, 250); });
    if (startHash.tab === "scatter" || startHash.tab === "ve") setTab(startHash.tab);
    invalidate();
  }).catch(function () { fail("This log couldn't be loaded. Reload the page to try again."); });
})();
