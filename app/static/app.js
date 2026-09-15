/* MSQ Viewer front-end: theme switch, category menus, tabs, search + filter chips, thumbnails,
   table editor tools (fit, values, copy, 3D view), tap tooltip, lambda/AFR toggle, diff modes,
   copy/share, upload UX. No build step. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var slice = function (list, from) { return Array.prototype.slice.call(list, from || 0); };
  var bubble = $(".bubble");
  var selected = [];
  var plots = [];
  var ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function pref(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  function typing(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  }
  function redraw3d() { plots.forEach(function (p) { p.draw(); }); }

  /* ---------- theme ---------- */
  $$("[data-theme-toggle]").forEach(function (b) {
    b.hidden = false;
    b.addEventListener("click", function () {
      var root = document.documentElement;
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      pref("msq.theme", next);
      plots.forEach(function (p) { p.refresh(); });
    });
  });

  if (window.htmx) {
    // Let the delete form show "wrong key" (403) instead of silently ignoring it.
    htmx.config.responseHandling = [
      { code: "204", swap: false },
      { code: "[23]..", swap: true },
      { code: "403", swap: true, error: false },
      { code: "[45]..", swap: false, error: true }
    ];
  }

  /* ---------- upload ---------- */
  $$("form[data-max]").forEach(function (form) {
    var max = parseInt(form.dataset.max, 10);
    var status = $(".upload-status", form);
    var zone = $(".dropzone", form);
    var input = $("input[type=file]", form);
    if (!input) return;
    function fail(msg) {
      if (status) { status.textContent = msg; status.classList.add("err"); }
      form.classList.remove("busy");
      input.value = "";
    }
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      if (f.size > max) return fail("That file is " + (f.size / 1048576).toFixed(1) + " MB. The limit is " + Math.round(max / 1048576) + " MB.");
      if (status) { status.classList.remove("err"); status.textContent = f.name + " · " + Math.max(1, Math.round(f.size / 1024)) + " KB"; }
      var main = zone && $(".dz-main", zone);
      if (main) main.textContent = f.name;
      if (form.hasAttribute("data-autosubmit")) {
        form.classList.add("busy");
        if (status) status.textContent = "Uploading " + f.name + "…";
        if (form.requestSubmit) form.requestSubmit(); else form.submit();
      }
    });
    if (zone) {
      ["dragenter", "dragover"].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.add("drag"); }); });
      ["dragleave", "drop"].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove("drag"); }); });
    }
  });
  window.addEventListener("pageshow", function () { $$("form.busy").forEach(function (f) { f.classList.remove("busy"); }); });

  /* ---------- canvas thumbnails ---------- */
  var luts = {};
  function lut(stops) {
    if (luts[stops]) return luts[stops];
    var cs = stops.split(",").map(function (h) {
      h = h.trim();
      return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
    });
    var out = [];
    for (var i = 0; i < 64; i++) {
      var t = i / 63 * (cs.length - 1), k = Math.min(Math.floor(t), cs.length - 2), f = t - k;
      out.push([0, 1, 2].map(function (j) { return Math.round(cs[k][j] + (cs[k + 1][j] - cs[k][j]) * f); }));
    }
    luts[stops] = out;
    return out;
  }
  $$("canvas[data-thumb]").forEach(function (cv) {
    var cols = +cv.dataset.cols, rows = +cv.dataset.rows, s = cv.dataset.thumb;
    if (!cols || !rows || s.length < cols * rows || !cv.getContext) return;
    var colors = lut(cv.dataset.stops), ctx = cv.getContext("2d"), img = ctx.createImageData(cols, rows);
    for (var i = 0; i < cols * rows; i++) {
      var idx = ALPHA.indexOf(s.charAt(i)), c = idx < 0 ? [120, 124, 130] : colors[idx];
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });

  /* ---------- category menus (toolbar) ---------- */
  var menus = $$("details.tbmenu");
  function closeMenus(except) { menus.forEach(function (d) { if (d !== except) d.open = false; }); }
  menus.forEach(function (d) {
    d.addEventListener("toggle", function () {
      if (!d.open) return;
      closeMenus(d);
      var pop = $(".tbpop", d);
      pop.classList.remove("flip");
      if (getComputedStyle(pop).position === "absolute" && pop.getBoundingClientRect().right > window.innerWidth - 8) pop.classList.add("flip");
    });
  });

  /* ---------- search + filter chips ---------- */
  var searchInput = $("[data-global-search]");
  var clearBtn = $("[data-search-clear]");
  var lists = $$("[data-list]");
  var chipState = {};
  var query = [];

  function applyFilters() {
    var parts = [];
    lists.forEach(function (list) {
      var key = list.dataset.list, chip = chipState[key] || "all", shown = 0, items = list.children;
      for (var i = 0; i < items.length; i++) {
        var el = items[i], s = el.dataset.s || "";
        var ok = chip === "all" || el.dataset.chipVal === chip;
        for (var j = 0; ok && j < query.length; j++) if (s.indexOf(query[j]) === -1) ok = false;
        el.hidden = !ok;
        if (ok) shown++;
      }
      var total = items.length;
      $$('[data-count="' + key + '"]').forEach(function (el) { el.textContent = shown === total ? String(total) : shown + " / " + total; });
      $$('[data-dock-count="' + key + '"]').forEach(function (el) { el.textContent = shown; });
      var empty = $('[data-empty="' + key + '"]');
      if (empty) empty.hidden = shown > 0 || total === 0;
      parts.push({ key: key, label: list.dataset.label || key, shown: shown, list: list });
    });
    document.body.classList.toggle("searching", query.length > 0);
    var summary = $("[data-search-summary]");
    if (summary) {
      summary.textContent = "";
      summary.hidden = !query.length;
      parts.forEach(function (p) {
        if (!query.length) return;
        var a = document.createElement("a");
        a.href = "#" + (p.list.closest("[data-tab-panel]") || p.list).id;
        a.className = "hit" + (p.shown ? "" : " none");
        a.appendChild(document.createTextNode(p.label + " "));
        var b = document.createElement("b");
        b.textContent = p.shown;
        a.appendChild(b);
        summary.appendChild(a);
      });
    }
    hideBubble();
    return parts;
  }
  function runSearch() {
    query = searchInput ? searchInput.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
    if (clearBtn) clearBtn.hidden = !(searchInput && searchInput.value);
    return applyFilters();
  }
  function clearSearch() {
    if (!searchInput) return;
    searchInput.value = "";
    runSearch();
  }

  function setChip(key, val) {
    var bar = $('[data-chips="' + key + '"]');
    if (!bar || !$('[data-chip="' + val + '"]', bar)) val = "all";
    chipState[key] = val;
    if (bar) $$("[data-chip]", bar).forEach(function (x) { x.setAttribute("aria-pressed", x.dataset.chip === val ? "true" : "false"); });
    applyFilters();
  }
  $$("[data-chips]").forEach(function (bar) {
    var on = $("[data-chip][aria-pressed=true]", bar);
    chipState[bar.dataset.chips] = on ? on.dataset.chip : "all";
    bar.addEventListener("click", function (e) {
      var b = e.target.closest("[data-chip]");
      if (b) setChip(bar.dataset.chips, b.dataset.chip);
    });
  });

  if (searchInput) {
    var timer;
    searchInput.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(runSearch, 90); });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        var first = runSearch().filter(function (p) { return p.shown; })[0];
        if (first) {
          var sec = first.list.closest("section");
          if (sec) sec.scrollIntoView({ block: "start" });
          searchInput.blur();
        }
      } else if (e.key === "Escape") {
        clearSearch();
      }
    });
    if (clearBtn) clearBtn.addEventListener("click", function () { clearSearch(); searchInput.focus(); });
    $$("[data-focus-search]").forEach(function (b) { b.addEventListener("click", function () { searchInput.focus(); }); });
  }
  if (lists.length) applyFilters();

  /* ---------- tabs ---------- */
  var panels = $$("[data-tab-panel]");
  var tabLinks = $$("[data-tab]");
  function isPanel(id) { return panels.some(function (p) { return p.id === id; }); }
  function showTab(id, scroll) {
    if (!isPanel(id)) id = panels[0].id;
    panels.forEach(function (p) { p.classList.toggle("on", p.id === id); });
    tabLinks.forEach(function (a) { a.setAttribute("aria-current", a.dataset.tab === id ? "page" : "false"); });
    hideBubble();
    closeMenus();
    if (scroll) {
      var bar = $(".tabbar"), main = $("main");
      var top = main.getBoundingClientRect().top + window.scrollY - (bar ? bar.offsetHeight : 0);
      if (window.scrollY > top) window.scrollTo(0, Math.max(0, top));
    }
    redraw3d();
  }
  if (panels.length) {
    document.body.classList.add("tabbed");
    var startHash = location.hash.slice(1);
    showTab(startHash, false);
    if (isPanel(startHash)) {
      // The browser jumps to the #anchor after deferred scripts run; a tab link should open at the top.
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      window.scrollTo(0, 0);
      window.addEventListener("load", function () { setTimeout(function () { window.scrollTo(0, 0); }, 0); });
    }
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      var id = a.getAttribute("href").slice(1);
      if (!isPanel(id)) return;
      e.preventDefault();
      if (query.length && !a.hasAttribute("data-tab")) {
        document.getElementById(id).scrollIntoView({ block: "start" });
        return;
      }
      clearSearch();
      // a menu's "Settings" entry opens the Settings tab filtered to that category
      if (a.dataset.gotoChip) setChip("settings", a.dataset.gotoChip);
      history.replaceState(null, "", "#" + id);
      showTab(id, true);
    });
    window.addEventListener("hashchange", function () { showTab(location.hash.slice(1), true); });
  }

  /* ---------- window tabs (VE / Spark / AFR) ---------- */
  $$("[data-switch-group]").forEach(function (group) {
    var scope = group.closest("[data-switch-scope]") || document;
    group.addEventListener("click", function (e) {
      var b = e.target.closest("[data-switch]");
      if (!b) return;
      $$("[data-switch]", group).forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      $$("[data-switch-panel]", scope).forEach(function (p) { p.hidden = p.dataset.switchPanel !== b.dataset.switch; });
      hideBubble();
      redraw3d();
    });
  });

  /* ---------- table text helpers ---------- */
  function cellText(cell) {
    var n = cell.firstChild;
    return (cell.tagName === "TD" && n && n.nodeType === 3 ? n.nodeValue : cell.textContent).replace(/\s+/g, " ").trim();
  }
  function tableTSV(table) {
    var head = table.tHead ? slice(table.tHead.rows) : table.tFoot ? slice(table.tFoot.rows) : [];
    return head.concat($$("tbody tr", table)).map(function (tr) {
      return slice(tr.cells).map(function (c) { return c.classList.contains("corner") ? "" : cellText(c); }).join("\t");
    }).join("\n");
  }

  /* "Load (kPa)", "RPM", or the fallback — same rule as axes.axis_text on the server. */
  function axisName(label, units, fallback) {
    if (label && units) return label + " (" + units + ")";
    return label || units || fallback;
  }
  function withUnits(value, units) { return units ? value + " " + units : value; }
  /* Same as axes.gauge_text: absolute kPa as a boost gauge reads it at sea level. */
  function gaugeText(kpa) {
    var d = kpa - 101.325;
    if (Math.abs(d) < 1.5) return "atmospheric";
    return d > 0 ? (d * 0.1450377).toFixed(1) + " psi boost" : (-d * 0.2953).toFixed(1) + " inHg vacuum";
  }

  /* ---------- 3D table view ---------- */
  function num(t) {
    var n = parseFloat(String(t || "").replace(/−/g, "-").replace(/[^0-9eE+\-.]/g, ""));
    return isFinite(n) ? n : NaN;
  }
  function rgbOf(el) {
    var m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
    return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : [128, 128, 128];
  }
  function fmt(v, span) { return v.toFixed(span >= 20 ? 0 : span >= 2 ? 1 : 3); }

  function makePlot(fig) {
    var host = $(".ed-3d", fig), cv = host && $("canvas", host), table = $("table.hm", fig);
    if (!cv || !cv.getContext || !table) return null;
    var ctx = cv.getContext("2d"), YAW = -0.62, PITCH = 0.78, yaw = YAW, pitch = PITCH;
    var data = null, frame = 0, drag = null, lastTap = 0;

    function read() {
      var trs = $$("tbody tr", table).reverse(); // first row = lowest load bin
      data = {
        z: trs.map(function (tr) { return slice(tr.cells, 1).map(function (td) { return num(cellText(td)); }); }),
        rgb: trs.map(function (tr) { return slice(tr.cells, 1).map(rgbOf); }),
        xs: table.tFoot ? slice(table.tFoot.rows[0].cells, 1).map(function (c) { return c.textContent; }) : [],
        ys: trs.map(function (tr) { return tr.cells[0].textContent; }),
        xl: axisName(table.dataset.xl, table.dataset.xu, "Column"), yl: axisName(table.dataset.yl, table.dataset.yu, "Row"),
        units: fig.dataset.showUnits || table.dataset.units || ""
      };
    }

    function draw() {
      frame = 0;
      if (host.hidden || !host.clientWidth || !host.offsetParent) return;
      if (!data) read();
      var w = host.clientWidth, h = host.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var Z = data.z, R = Z.length, C = R ? Z[0].length : 0;
      var ink = getComputedStyle(host).color, font = getComputedStyle(document.body).fontFamily;
      ctx.fillStyle = ink;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "12px " + font;
      if (R < 2 || C < 2) { ctx.fillText("A 3D view needs at least 2 × 2 cells.", w / 2, h / 2); return; }

      var lo = Infinity, hi = -Infinity;
      Z.forEach(function (row) { row.forEach(function (v) { if (!isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
      if (lo === Infinity) { lo = 0; hi = 1; }
      var span = hi - lo || 1;
      var cY = Math.cos(yaw), sY = Math.sin(yaw), cP = Math.cos(pitch), sP = Math.sin(pitch);
      // the floor's diagonal spins through ~1.4× scale, and labels sit outside it
      var scale = Math.min(w * 0.56, h * 0.64), cx = w / 2, cy = h * 0.5;
      // (column, row, value) -> [screen x, screen y, depth]; larger depth = farther from the viewer
      function P(c, r, v) {
        var x = c / (C - 1) - 0.5, y = r / (R - 1) - 0.5, z = (isNaN(v) ? 0 : (v - lo) / span) * 0.36 - 0.18;
        var xr = x * cY - y * sY, yr = x * sY + y * cY;
        return [cx + xr * scale, cy - (yr * sP + z * cP) * scale, yr * cP - z * sP];
      }
      function path(pts) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      }

      // floor grid
      ctx.strokeStyle = "rgba(150,158,168,.22)";
      ctx.lineWidth = 1;
      for (var gc = 0; gc < C; gc += Math.max(1, Math.round((C - 1) / 8))) { var g1 = P(gc, 0, lo), g2 = P(gc, R - 1, lo); ctx.beginPath(); ctx.moveTo(g1[0], g1[1]); ctx.lineTo(g2[0], g2[1]); ctx.stroke(); }
      for (var gr = 0; gr < R; gr += Math.max(1, Math.round((R - 1) / 8))) { var g3 = P(0, gr, lo), g4 = P(C - 1, gr, lo); ctx.beginPath(); ctx.moveTo(g3[0], g3[1]); ctx.lineTo(g4[0], g4[1]); ctx.stroke(); }
      ctx.strokeStyle = "rgba(150,158,168,.5)";
      path([P(0, 0, lo), P(C - 1, 0, lo), P(C - 1, R - 1, lo), P(0, R - 1, lo)]);
      ctx.stroke();

      // surface, painted back to front
      var quads = [];
      for (var r = 0; r < R - 1; r++) {
        for (var c = 0; c < C - 1; c++) {
          var p = [P(c, r, Z[r][c]), P(c + 1, r, Z[r][c + 1]), P(c + 1, r + 1, Z[r + 1][c + 1]), P(c, r + 1, Z[r + 1][c])];
          var k = [data.rgb[r][c], data.rgb[r][c + 1], data.rgb[r + 1][c + 1], data.rgb[r + 1][c]];
          quads.push({
            p: p,
            d: (p[0][2] + p[1][2] + p[2][2] + p[3][2]) / 4,
            fill: "rgb(" + [0, 1, 2].map(function (i) { return Math.round((k[0][i] + k[1][i] + k[2][i] + k[3][i]) / 4); }).join(",") + ")"
          });
        }
      }
      quads.sort(function (a, b) { return b.d - a.d; });
      ctx.lineWidth = Math.max(0.4, Math.min(1, 14 / Math.max(R, C)));
      ctx.strokeStyle = "rgba(0,0,0,.55)";
      quads.forEach(function (q) { path(q.p); ctx.fillStyle = q.fill; ctx.fill(); ctx.stroke(); });

      // axis labels on the edges nearest the viewer
      ctx.fillStyle = ink;
      var nearRow = P((C - 1) / 2, 0, lo)[2] < P((C - 1) / 2, R - 1, lo)[2] ? 0 : R - 1;
      var nearCol = P(0, (R - 1) / 2, lo)[2] < P(C - 1, (R - 1) / 2, lo)[2] ? 0 : C - 1;
      var offR = Math.max(0.7, (R - 1) * 0.09) * (nearRow === 0 ? -1 : 1);
      var offC = Math.max(0.7, (C - 1) * 0.09) * (nearCol === 0 ? -1 : 1);
      ctx.font = "11px " + font;
      [0, Math.round((C - 1) / 2), C - 1].forEach(function (i) { var q = P(i, nearRow + offR, lo); ctx.fillText(data.xs[i] || String(i), q[0], q[1]); });
      [0, Math.round((R - 1) / 2), R - 1].forEach(function (i) { var q = P(nearCol + offC, i, lo); ctx.fillText(data.ys[i] || String(i), q[0], q[1]); });
      ctx.font = "600 12px " + font;
      var xt = P((C - 1) / 2, nearRow + offR * 2.3, lo), yt = P(nearCol + offC * 2.6, (R - 1) / 2, lo);
      ctx.fillText(data.xl, xt[0], xt[1]);
      ctx.fillText(data.yl, yt[0], yt[1]);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("max " + fmt(hi, span) + (data.units ? " " + data.units : ""), 10, 8);
      ctx.font = "11px " + font;
      ctx.fillText("min " + fmt(lo, span), 10, 26);
    }

    function schedule() { if (!frame) frame = requestAnimationFrame(draw); }
    function reset() { yaw = YAW; pitch = PITCH; schedule(); }
    cv.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY, yaw: yaw, pitch: pitch, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    });
    cv.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      yaw = drag.yaw + dx * 0.01;
      pitch = Math.max(0.08, Math.min(1.55, drag.pitch + dy * 0.008));
      schedule();
    });
    cv.addEventListener("pointerup", function () {
      if (drag && !drag.moved) {
        var now = Date.now();
        if (now - lastTap < 320) { reset(); now = 0; }
        lastTap = now;
      }
      drag = null;
    });
    cv.addEventListener("pointercancel", function () { drag = null; });
    return { host: host, draw: schedule, refresh: function () { data = null; schedule(); } };
  }

  $$(".hm-wrap").forEach(function (fig) {
    var p = makePlot(fig);
    if (p) { fig._plot = p; plots.push(p); }
  });
  if (plots.length) {
    if ("ResizeObserver" in window) {
      var ro = new ResizeObserver(redraw3d);
      plots.forEach(function (p) { ro.observe(p.host); });
    } else {
      window.addEventListener("resize", redraw3d);
    }
  }

  /* ---------- table editor tools ---------- */
  function setFit(on) {
    $$(".hm-wrap").forEach(function (f) { f.classList.toggle("fit", on); });
    $$("[data-hm-fit]").forEach(function (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); });
  }
  function setVals(on) {
    $$(".hm-wrap").forEach(function (f) { f.classList.toggle("novals", !on); });
    $$("[data-hm-vals]").forEach(function (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); });
  }
  function set3d(on) {
    $$(".hm-wrap").forEach(function (f) {
      f.classList.toggle("show3d", on);
      var h = $(".ed-3d", f);
      if (h) h.hidden = !on;
    });
    $$("[data-hm-3d]").forEach(function (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); });
    if (on) redraw3d();
  }
  if (pref("msq.fit") === "1") setFit(true);
  if (pref("msq.vals") === "0") setVals(false);
  if (pref("msq.3d") === "1") set3d(true);

  /* ---------- copy / share ---------- */
  function pageUrl() { return location.href.split("#")[0]; }
  function flash(btn, text) {
    var label = btn.querySelector("span") || btn;
    var old = label.dataset.label || label.textContent;
    label.dataset.label = old;
    label.textContent = text;
    setTimeout(function () { label.textContent = old; }, 1600);
  }
  function copyText(text, btn) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); flash(btn, "Copied"); } catch (e) { flash(btn, "Copy failed"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { flash(btn, "Copied"); }, fallback);
    } else fallback();
  }
  if (navigator.share) {
    $$("[data-share]").forEach(function (b) {
      b.hidden = false;
      b.addEventListener("click", function () {
        navigator.share({ title: document.title, url: pageUrl() }).catch(function () { /* cancelled */ });
      });
    });
  }

  /* ---------- tap tooltip ---------- */
  var bubbleAnchor = null;
  function hideBubble() {
    if (bubble) bubble.hidden = true;
    bubbleAnchor = null;
    selected.forEach(function (el) { el.classList.remove("sel", "hl"); });
    selected = [];
  }
  // Follows its cell while the page or table scrolls, and only goes away once the cell is off screen.
  // (Scroll events queued before a tap arrive after the click, so hiding on any scroll lost fresh taps.)
  function placeBubble() {
    if (!bubble || bubble.hidden || !bubbleAnchor) return;
    var r = bubbleAnchor.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) { hideBubble(); return; }
    var bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    var top = r.top - bh - 10;
    if (top < 8) top = r.bottom + 10;
    bubble.style.left = Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 8) + "px";
    bubble.style.top = top + "px";
  }
  function line(cls, text) {
    var d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  }
  function showBubble(anchor, parts) {
    bubble.textContent = "";
    parts.forEach(function (p) { bubble.appendChild(p); });
    bubble.hidden = false;
    bubbleAnchor = anchor;
    placeBubble();
  }
  function valueLine(value, units) {
    var v = line("val", value);
    if (units) { var s = document.createElement("small"); s.textContent = units; v.appendChild(s); }
    return v;
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;

    var b = t.closest("[data-hm-3d]");
    if (b) { var on3d = b.getAttribute("aria-pressed") !== "true"; set3d(on3d); pref("msq.3d", on3d ? "1" : "0"); hideBubble(); return; }
    b = t.closest("[data-hm-fit]");
    if (b) { var fitOn = b.getAttribute("aria-pressed") !== "true"; setFit(fitOn); pref("msq.fit", fitOn ? "1" : "0"); hideBubble(); return; }
    b = t.closest("[data-hm-vals]");
    if (b) { var valsOn = b.getAttribute("aria-pressed") !== "true"; setVals(valsOn); pref("msq.vals", valsOn ? "1" : "0"); return; }
    b = t.closest("[data-hm-copy]");
    if (b) { var tbl = $("table.hm", b.closest(".hm-wrap")); if (tbl) copyText(tableTSV(tbl), b); return; }
    b = t.closest("[data-copy-table]");
    if (b) { var vt = $(b.dataset.copyTable); if (vt) copyText(tableTSV(vt), b); return; }
    b = t.closest("[data-copy-link]");
    if (b) { copyText(pageUrl(), b); return; }
    b = t.closest("[data-copy]");
    if (b) { var el = $(b.dataset.copy); if (el) copyText(el.textContent.trim(), b); return; }

    if (!bubble) return;
    if (document.body.classList.contains("editing") && t.closest("[data-edit-name]")) return; // edit.js owns taps
    var td = t.closest("table.hm td");
    var pt = t.closest("circle.pt");
    if (!td && !pt) { hideBubble(); return; }
    if ((td || pt).classList.contains("sel")) { hideBubble(); return; }
    hideBubble();

    if (pt) {
      var svg = pt.closest("svg");
      pt.classList.add("sel");
      selected = [pt];
      showBubble(pt, [valueLine(pt.dataset.y, svg.dataset.units), line("xy", (svg.dataset.xl || "X") + " " + pt.dataset.x)]);
      return;
    }

    var table = td.closest("table"), tr = td.parentElement, col = td.cellIndex;
    var axisRow = table.tFoot || table.tHead;
    var xTh = axisRow && axisRow.rows[0].cells[col];
    var yTh = tr.cells[0];
    var fig = td.closest("[data-grid]");
    var units = (fig && fig.dataset.showUnits) || table.dataset.units || "";
    var value = cellText(td);
    var parts = [valueLine(value, units)];
    // A cell value in absolute kPa (a boost target, say) also reads as boost or vacuum.
    if (/^kpa$/i.test(units) && isFinite(parseFloat(value))) parts.push(line("gauge", "≈ " + gaugeText(parseFloat(value)) + " (at sea level)"));
    if (table.classList.contains("diff")) {
      var small = td.querySelector("small");
      parts.push(line("ab", "A " + (td.dataset.a || "?") + " → B " + (td.dataset.b || value) + (small ? "  (" + small.textContent + ")" : "")));
    }
    parts.push(line("xy", (table.dataset.xl || "Column") + " " + withUnits(xTh ? xTh.textContent : String(col - 1), table.dataset.xu) +
      " · " + (table.dataset.yl || "Row") + " " + withUnits(yTh.textContent, table.dataset.yu)));
    if (yTh.dataset.g) parts.push(line("gauge", "≈ " + yTh.dataset.g + " (at sea level)"));
    td.classList.add("sel"); yTh.classList.add("hl"); selected = [td, yTh];
    if (xTh) { xTh.classList.add("hl"); selected.push(xTh); }
    showBubble(td, parts);
  });
  document.addEventListener("scroll", placeBubble, { capture: true, passive: true });
  window.addEventListener("resize", placeBubble);

  /* ---------- diff cell modes ---------- */
  $$("[data-diff-modes]").forEach(function (group) {
    var scope = $(group.dataset.diffModes) || document;
    var table = $("table.hm.diff", scope);
    if (!table) return;
    var fig = table.closest(".hm-wrap");
    var cells = $$("tbody td", table);
    cells.forEach(function (td) {
      if (!td.firstChild || td.firstChild.nodeType !== 3) td.insertBefore(document.createTextNode(""), td.firstChild);
      td.dataset.b = td.firstChild.nodeValue;
      var small = td.querySelector("small");
      td.dataset.d = small ? small.textContent : "·";
    });
    group.addEventListener("click", function (e) {
      var b = e.target.closest("[data-mode]");
      if (!b) return;
      var mode = b.dataset.mode;
      cells.forEach(function (td) { td.firstChild.nodeValue = mode === "a" ? td.dataset.a : mode === "d" ? td.dataset.d : td.dataset.b; });
      table.classList.toggle("hide-delta", mode !== "b");
      $$("[data-mode]", group).forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      hideBubble();
      if (fig && fig._plot) fig._plot.refresh();
    });
  });

  /* ---------- navigation + keyboard ---------- */
  $$("select[data-nav]").forEach(function (s) { s.addEventListener("change", function () { if (s.value) location.href = s.value; }); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeMenus(); hideBubble(); }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if (e.key === "/" && searchInput) { e.preventDefault(); searchInput.focus(); return; }
    if (document.body.classList.contains("editing")) return; // digits and arrows edit cells (edit.js)
    var n = parseInt(e.key, 10);
    if (panels.length && n >= 1 && n <= panels.length) {
      clearSearch();
      history.replaceState(null, "", "#" + panels[n - 1].id);
      showTab(panels[n - 1].id, true);
      return;
    }
    var link = e.key === "ArrowLeft" ? $("[data-prev]") : e.key === "ArrowRight" ? $("[data-next]") : null;
    if (link) location.href = link.href;
  });

  /* ---------- lambda / AFR ---------- */
  $$("[data-fuel]").forEach(function (fig) {
    var stored = fig.dataset.fuel, mode = stored;
    var cells = $$("tbody td", fig);
    cells.forEach(function (td) { td.dataset.v = td.textContent; });
    // Not [data-units]: the <table> carries that too, and writing to it would wipe every row.
    var lo = $("[data-lo]", fig), hi = $("[data-hi]", fig), unitsEl = $("[data-units-label]", fig);
    [lo, hi].forEach(function (el) { if (el) el.dataset.v = el.textContent; });
    var sel = $("[data-stoich]", fig), custom = $("[data-stoich-custom]", fig);
    var showing = $("[data-showing]", fig), bar = $(".fuelbar", fig);
    var saved = pref("msq.stoich");
    if (saved) {
      if ($$("option", sel).some(function (o) { return o.value === saved; })) sel.value = saved;
      else { sel.value = "custom"; custom.hidden = false; custom.value = saved; }
    }
    function stoich() {
      var v = sel.value === "custom" ? parseFloat(custom.value) : parseFloat(sel.value);
      return v > 0 ? v : 14.7;
    }
    function conv(text) {
      var n = parseFloat(text);
      if (mode === stored || isNaN(n)) return text;
      return stored === "lambda" ? (n * stoich()).toFixed(1) : (n / stoich()).toFixed(3);
    }
    function render() {
      var st = stoich();
      cells.forEach(function (td) { td.textContent = conv(td.dataset.v); });
      [lo, hi].forEach(function (el) { if (el) el.textContent = conv(el.dataset.v); });
      var label = mode === "lambda" ? "λ" : "AFR";
      fig.dataset.showUnits = label;
      if (unitsEl) unitsEl.textContent = label;
      if (showing) {
        showing.textContent = mode === stored
          ? (mode === "lambda" ? "Lambda (λ), as stored in the tune" : "AFR, as stored in the tune")
          : (mode === "afr" ? "AFR, converted from lambda × " + st + " stoich" : "Lambda (λ), converted from AFR ÷ " + st + " stoich");
      }
      if (bar) bar.classList.toggle("native", mode === stored);
      $$("[data-fuel-show]", fig).forEach(function (b) { b.setAttribute("aria-pressed", b.dataset.fuelShow === mode ? "true" : "false"); });
      hideBubble();
      if (fig._plot) fig._plot.refresh();
    }
    $$("[data-fuel-show]", fig).forEach(function (b) { b.addEventListener("click", function () { mode = b.dataset.fuelShow; render(); }); });
    function save() { pref("msq.stoich", String(stoich())); }
    sel.addEventListener("change", function () {
      custom.hidden = sel.value !== "custom";
      if (sel.value === "custom") custom.focus();
      save(); render();
    });
    custom.addEventListener("input", function () { save(); render(); });
    render();
  });
})();
