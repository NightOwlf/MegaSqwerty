/* Tune editing. Tables edit like TunerStudio's table editor: select cells (click, drag, shift-click, or
   Range on a phone), then Set / Add / ± % / step / Interpolate, with undo. Curves, axis bins and single
   numbers edit in place. Edits are kept per tune in localStorage until saved, so they survive moving
   between the tune page and table pages. "Save as new tune" posts only the changed numbers; the server
   writes them into a copy of the original .msq and returns the new tune's link. The original is never
   modified. No build step. */
(function () {
  "use strict";
  var slug = document.body.dataset.slug;
  if (!slug) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var KEY = "msq.edits." + slug, MODE_KEY = "msq.editing." + slug;
  var editing = false, sel = null, rangeMode = false, dragging = false, pointerType = "mouse", undos = [];

  function stash(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable: edits last until the page is closed */ }
    return null;
  }
  var edits = {};
  try { edits = JSON.parse(stash(KEY) || "{}"); } catch (e) { edits = {}; }
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) edits = {};

  function num(t) {
    var s = String(t == null ? "" : t).trim().replace(/\u2212/g, "-").replace(/,/g, ".");
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? parseFloat(s) : NaN;
  }
  function fmt(v, d) {
    var s = v.toFixed(Math.max(0, Math.min(6, d || 0)));
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
  }
  function attr(s) { return String(s).replace(/["\\]/g, "\\$&"); }
  function textOf(el) { return el.dataset.v != null ? el.dataset.v : el.textContent.trim(); }
  function changeCount() {
    return Object.keys(edits).reduce(function (n, k) { return n + Object.keys(edits[k]).length; }, 0);
  }
  function bad(el) {
    if (!el) return;
    el.classList.remove("bad-input");
    void el.offsetWidth;
    el.classList.add("bad-input");
  }

  function record(name, i, value, changed) {
    var e = edits[name] || {};
    if (changed) e[i] = value; else delete e[i];
    if (Object.keys(e).length) edits[name] = e; else delete edits[name];
    stash(KEY, Object.keys(edits).length ? JSON.stringify(edits) : null);
    updateBar();
    refreshDerived();
  }

  /* ---------- showing a value: cell colors use the same ramp and ink rule as render.py ---------- */
  function paint(fig, td, v) {
    var stops = (fig.dataset.stops || "").split(",").map(function (h) {
      h = h.trim();
      return [1, 3, 5].map(function (k) { return parseInt(h.substr(k, 2), 16); });
    });
    if (stops.length < 2) return;
    var lo = +fig.dataset.loV, hi = +fig.dataset.hiV;
    var t = Math.max(0, Math.min(1, hi > lo ? (v - lo) / (hi - lo) : 0.5));
    var pos = t * (stops.length - 1), k = Math.min(Math.floor(pos), stops.length - 2), f = pos - k;
    var rgb = [0, 1, 2].map(function (j) { return Math.round(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * f); });
    td.style.background = "rgb(" + rgb.join(",") + ")";
    td.style.color = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.42 ? "#000" : "#fff";
  }
  function moveChartPoint(name, i, v, s) {
    var svg = $('svg[data-edit-chart="' + attr(name) + '"]');
    var pt = svg && $('circle.pt[data-i="' + i + '"]', svg);
    if (!pt) return;
    var ylo = +svg.dataset.ylo, yhi = +svg.dataset.yhi, top = +svg.dataset.top, ph = +svg.dataset.ph;
    var y = top + (1 - (v - ylo) / ((yhi - ylo) || 1)) * ph;
    pt.setAttribute("cy", Math.max(top - 8, Math.min(top + ph + 8, y)).toFixed(1));
    pt.dataset.y = s;
    var pts = $$("circle.pt", svg).map(function (c) { return c.getAttribute("cx") + "," + c.getAttribute("cy"); });
    var line = $("polyline.line", svg), area = $("polygon.area", svg), base = (top + ph).toFixed(1);
    if (line) line.setAttribute("points", pts.join(" "));
    if (area && pts.length) {
      area.setAttribute("points", pts[0].split(",")[0] + "," + base + " " + pts.join(" ") + " " + pts[pts.length - 1].split(",")[0] + "," + base);
    }
  }
  function show(box, el, v) {
    var s = fmt(v, +box.dataset.digits);
    el.textContent = s;
    if (box.classList.contains("hm-wrap")) {
      if (el.dataset.v != null) el.dataset.v = s; // lambda/AFR tables convert from this
      paint(box, el, v);
    } else {
      moveChartPoint(box.dataset.editName, el.dataset.i, v, s);
      el.dataset.cur = s; // last committed text, restored by Escape or invalid input
    }
    el.classList.toggle("edited", s !== el.dataset.orig);
    return s;
  }
  function setValue(box, el, v) {
    var s = show(box, el, v);
    record(box.dataset.editName, el.dataset.i, parseFloat(s), s !== el.dataset.orig);
  }
  function refreshPlots(boxes) {
    boxes.forEach(function (b) { if (b._plot) b._plot.refresh(); });
  }

  /* ---------- load: remember what the server rendered, then re-apply pending edits ---------- */
  $$("[data-edit-name] [data-i]").forEach(function (el) { el.dataset.orig = el.dataset.cur = textOf(el); });
  Object.keys(edits).forEach(function (name) {
    var e = edits[name];
    if (!e || typeof e !== "object") { delete edits[name]; return; }
    $$('[data-edit-name="' + attr(name) + '"]').forEach(function (box) {
      Object.keys(e).forEach(function (i) {
        var el = /^\d+$/.test(i) && $('[data-i="' + i + '"]', box);
        if (el && typeof e[i] === "number" && isFinite(e[i])) show(box, el, e[i]);
      });
    });
  });
  refreshPlots($$(".hm-wrap[data-edit-name]"));

  /* ---------- everything that follows from a setting ----------
     Other copies of the same field, gauge readouts, the limit dials (their needle and their scale), table
     stats, axis headers (with boost readings and the boost line) and the consistency checks all recompute
     from the tune's values plus pending edits, so the Dash always matches what's been typed. */
  var liveEl = $("[data-tune-values]"), tuneValues = {};
  try { tuneValues = liveEl ? JSON.parse(liveEl.dataset.tuneValues) || {} : {}; } catch (e) { tuneValues = {}; }
  var checksBox = $("[data-checks]"), checkRules = [];
  try { checkRules = checksBox ? JSON.parse(checksBox.dataset.checks) || [] : []; } catch (e) { checkRules = []; }

  function editedAt(name, i) {
    var e = edits[name];
    return e && typeof e[i || 0] === "number" ? e[i || 0] : undefined;
  }
  function current(name, i) {
    var e = editedAt(name, i);
    if (e !== undefined) return e;
    var v = tuneValues[name];
    v = Array.isArray(v) ? v[i || 0] : (i ? undefined : v);
    return typeof v === "number" ? v : undefined;
  }
  function currentMax(name) {
    var base = tuneValues[name], best;
    if (!Array.isArray(base)) return current(name, 0);
    base.forEach(function (_, i) {
      var v = current(name, i);
      if (typeof v === "number" && (best === undefined || v > best)) best = v;
    });
    return best;
  }
  function short(n) { return String(+n.toFixed(4)); }
  function gaugeText(kpa) {
    var d = kpa - 101.325;
    if (Math.abs(d) < 1.5) return "atmospheric";
    return d > 0 ? (d * 0.1450377).toFixed(1) + " psi boost" : (-d * 0.2953).toFixed(1) + " inHg vacuum";
  }
  function setText(ro, text, edited) {
    var v = $(".ro-v", ro), node = v && v.firstChild;
    if (!node || node.nodeType !== 3) return;
    if (ro.dataset.orig == null) ro.dataset.orig = node.nodeValue;
    node.nodeValue = text == null ? ro.dataset.orig : text;
    v.classList.toggle("edited", !!edited && node.nodeValue !== ro.dataset.orig);
  }

  function syncFields() {
    fields.forEach(function (el) {
      if (el === document.activeElement) return;
      var box = el.closest("[data-edit-name]"), e = editedAt(box.dataset.editName, el.dataset.i);
      var text = e !== undefined ? fmt(e, +box.dataset.digits) : el.dataset.orig;
      if (el.textContent.trim() !== text) {
        el.textContent = text;
        moveChartPoint(box.dataset.editName, el.dataset.i, num(text), text);
      }
      el.dataset.cur = text;
      el.classList.toggle("edited", text !== el.dataset.orig);
    });
  }
  function updateReadouts() {
    $$("[data-bind]").forEach(function (ro) {
      var e = editedAt(ro.dataset.bind, 0);
      setText(ro, e !== undefined ? fmt(e, +ro.dataset.digits) : null, e !== undefined);
    });
  }
  function updateStats() {
    $$("[data-stats-for]").forEach(function (strip) {
      var name = strip.dataset.statsFor, box = $('[data-edit-name="' + attr(name) + '"]');
      var ros = $$("[data-stat]", strip);
      if (!box || !edits[name]) { ros.forEach(function (ro) { setText(ro, null, false); }); return; }
      var nums = $$("[data-i]", box).map(function (el) { return num(textOf(el)); }).filter(function (n) { return !isNaN(n); });
      if (!nums.length) return;
      var d = +box.dataset.digits || 0;
      var vals = { lo: Math.min.apply(null, nums), hi: Math.max.apply(null, nums), mean: nums.reduce(function (a, b) { return a + b; }, 0) / nums.length };
      ros.forEach(function (ro) { setText(ro, fmt(vals[ro.dataset.stat], d), true); });
    });
  }
  function decimalsOf(text) { var m = /\.(\d+)/.exec(text || ""); return m ? m[1].length : 0; }
  function refreshBoostLine(fig) {
    var rows = $$("tbody tr", fig);
    if (!rows.length || rows[0].cells[0].dataset.g == null) return;
    var bins = rows.map(function (tr) { return parseFloat(tr.cells[0].textContent); });
    var boost = [], descending = true; // display order: highest load at the top
    bins.forEach(function (b, k) {
      if (b > 103) boost.push(k);
      if (k && !(b < bins[k - 1])) descending = false;
    });
    rows.forEach(function (tr) { tr.classList.remove("boost-edge"); });
    var where = boost.length + " of " + rows.length + " rows are boost.";
    if (boost.length && descending && boost.length < rows.length) {
      rows[boost[boost.length - 1]].classList.add("boost-edge");
      where = "Rows above the orange line are boost.";
    }
    var note = $(".pressure-note", fig), top = Math.max.apply(null, bins);
    if (!note) return;
    note.classList.toggle("has-line", !!$("tr.boost-edge", fig));
    note.textContent = boost.length
      ? where + " The top load bin, " + short(top) + " kPa, is about " + gaugeText(top) + " at sea level."
      : "No boost rows: the top load bin is " + short(top) + " kPa, about atmospheric. That's normal for a naturally aspirated engine; a turbo or supercharged engine needs load bins above ~101 kPa.";
  }
  function updateAxes() {
    var touched = [];
    $$("th[data-bin]").forEach(function (th) {
      if (th.dataset.orig == null) th.dataset.orig = th.textContent;
      var e = editedAt(th.dataset.bin, +th.dataset.binI);
      var text = e !== undefined ? fmt(e, decimalsOf(th.dataset.orig)) : th.dataset.orig;
      if (th.textContent === text) return;
      th.textContent = text;
      th.classList.toggle("edited", text !== th.dataset.orig);
      if (th.dataset.g != null) {
        th.dataset.g = gaugeText(parseFloat(text));
        th.title = text + " kPa ≈ " + th.dataset.g + " (at sea level)";
      }
      var fig = th.closest(".hm-wrap");
      if (fig && touched.indexOf(fig) < 0) touched.push(fig);
    });
    touched.forEach(function (fig) { refreshBoostLine(fig); if (fig._plot) fig._plot.refresh(); });
  }

  // Limit dials: same geometry as views.dial_geometry.
  var SVG_NS = "http://www.w3.org/2000/svg", NICE = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 1e9];
  function svgEl(tag, attrs, text) {
    var n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function polar(r, deg) {
    var a = deg * Math.PI / 180;
    return [Math.round((100 + r * Math.cos(a)) * 100) / 100, Math.round((100 + r * Math.sin(a)) * 100) / 100];
  }
  function arcPath(from, to, top) {
    var a0 = 135 + 270 * from / top, a1 = 135 + 270 * to / top, s = polar(80, a0), e = polar(80, a1);
    return "M" + s[0] + " " + s[1] + "A80 80 0 " + (a1 - a0 > 180 ? 1 : 0) + " 1 " + e[0] + " " + e[1];
  }
  function updateDials() {
    $$("[data-dial]").forEach(function (fig) {
      var names = (fig.dataset.scaleNames || "").split(",");
      var touched = [fig.dataset.name].concat(names).some(function (n) { return n && edits[n]; });
      if (!touched && !fig.dataset.redrawn) return; // the server's drawing is already current
      var v = current(fig.dataset.name, 0);
      if (!(v > 0)) return;
      var topS = current(names[0]), warnS = current(names[1]), dangerS = current(names[2]);
      var top, major, div;
      if (fig.dataset.kind === "rpm") {
        top = topS >= v ? topS : Math.ceil(v * 1.15 / 1000) * 1000;
        major = top > 12000 ? 2000 : 1000;
        div = 1000;
      } else {
        var step = NICE.filter(function (s) { return s * 7 >= v * 1.2; })[0];
        top = topS >= v ? topS : Math.ceil(v * 1.2 / step) * step;
        major = NICE.filter(function (s) { return s * 8 >= top; })[0];
        div = 1;
      }
      var minor = major / 2, svg = svgEl("svg", { viewBox: "0 0 200 200", "aria-hidden": "true" });
      svg.appendChild(svgEl("circle", { "class": "dial-rim", cx: 100, cy: 100, r: 97 }));
      svg.appendChild(svgEl("circle", { "class": "dial-face", cx: 100, cy: 100, r: 91 }));
      var redFrom = dangerS > 0 && dangerS < top ? dangerS : v;
      if (warnS > 0 && warnS < redFrom) svg.appendChild(svgEl("path", { "class": "dial-warn", d: arcPath(warnS, redFrom, top) }));
      if (redFrom < top) svg.appendChild(svgEl("path", { "class": "dial-red", d: arcPath(redFrom, top, top) }));
      for (var i = 0; i <= Math.floor(top / minor + 1e-9); i++) {
        var k = i * minor, deg = 135 + 270 * k / top, isMajor = i % 2 === 0;
        var p1 = polar(84, deg), p2 = polar(isMajor ? 70 : 77, deg);
        svg.appendChild(svgEl("line", { "class": isMajor ? "tk-major" : "tk-minor", x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] }));
        if (isMajor) {
          var lp = polar(56, deg);
          svg.appendChild(svgEl("text", { "class": "tk-label", x: lp[0], y: lp[1], "text-anchor": "middle", "dominant-baseline": "central" }, short(k / div)));
        }
      }
      svg.appendChild(svgEl("text", { "class": "dial-scale", x: 100, y: 76, "text-anchor": "middle" }, fig.dataset.kind === "rpm" ? "×1000 rpm" : fig.dataset.units));
      var needle = svgEl("g", { transform: "rotate(" + Math.round((135 + 270 * v / top) * 100) / 100 + " 100 100)" });
      needle.appendChild(svgEl("path", { "class": "dial-needle", d: "M84 100 100 96.6 178 100 100 103.4z" }));
      svg.appendChild(needle);
      svg.appendChild(svgEl("circle", { "class": "dial-hub", cx: 100, cy: 100, r: 7.5 }));
      var text = fmt(v, +fig.dataset.digits || 0);
      svg.appendChild(svgEl("text", { "class": "dial-val", x: 100, y: 146, "text-anchor": "middle" }, text));
      svg.appendChild(svgEl("text", { "class": "dial-label", x: 100, y: 166, "text-anchor": "middle" }, fig.dataset.label));
      fig.replaceChild(svg, $("svg", fig));
      fig.setAttribute("aria-label", fig.dataset.label + ": " + text + " " + (fig.dataset.units || ""));
      fig.classList.toggle("dial-edited", touched);
      fig.dataset.redrawn = touched ? "1" : "";
    });
  }

  function updateChecks() {
    if (!checksBox || !checkRules.length) return;
    var agg = function (ref) { return ref[1] === "max" ? currentMax(ref[0]) : current(ref[0], 0); };
    var results = checkRules.map(function (r) {
      var a = agg(r.a), b = agg(r.b);
      if (typeof a !== "number" || typeof b !== "number") return null;
      var ok = r.op === "<" ? a < b : r.op === "<=" ? a <= b : a >= b;
      return { ok: ok, text: (ok ? r.ok : r.bad).replace("{a}", short(a) + " " + r.units).replace("{b}", short(b) + " " + r.units) };
    }).filter(Boolean);
    var bad = results.filter(function (r) { return !r.ok; }), good = results.filter(function (r) { return r.ok; });
    var old = $("details.checks-ok", checksBox);
    function list(items, cls, led) {
      var ul = document.createElement("ul");
      if (cls) ul.className = cls;
      items.forEach(function (r) {
        var li = document.createElement("li"), dot = document.createElement("span"), t = document.createElement("span");
        dot.className = "led " + led;
        t.textContent = r.text;
        li.appendChild(dot);
        li.appendChild(t);
        ul.appendChild(li);
      });
      return ul;
    }
    checksBox.textContent = "";
    if (bad.length) checksBox.appendChild(list(bad, "checks-bad", "bad"));
    if (good.length) {
      var det = document.createElement("details"), sum = document.createElement("summary");
      det.className = "checks-ok";
      det.open = bad.length ? !!(old && old.open) : true;
      sum.textContent = good.length + (good.length === 1 ? " check passes" : " checks pass");
      det.appendChild(sum);
      det.appendChild(list(good, "", "on"));
      checksBox.appendChild(det);
    }
    var sub = $("[data-checks-sub]");
    if (sub) sub.textContent = bad.length ? bad.length + " to look at" : "All good";
  }

  // A timer, not requestAnimationFrame: rAF is paused while the tab is hidden, which left the Dash stale.
  // One pass per burst of edits (an Interpolate over 64 cells records 64 values).
  var derivedTimer = 0;
  function refreshDerived() {
    if (derivedTimer) return;
    derivedTimer = setTimeout(function () {
      derivedTimer = 0;
      syncFields();
      updateReadouts();
      updateStats();
      updateAxes();
      updateDials();
      updateChecks();
    });
  }

  /* ---------- table cell selection ---------- */
  function rowsOf(fig) { return fig.querySelector("table.hm").tBodies[0].rows; }
  function posOf(td) { return { r: td.parentNode.sectionRowIndex, c: td.cellIndex }; }
  function bounds() {
    return {
      r0: Math.min(sel.a.r, sel.b.r), r1: Math.max(sel.a.r, sel.b.r),
      c0: Math.min(sel.a.c, sel.b.c), c1: Math.max(sel.a.c, sel.b.c)
    };
  }
  function selected() {
    if (!sel) return [];
    var rows = rowsOf(sel.fig), b = bounds(), out = [];
    for (var r = b.r0; r <= b.r1; r++) for (var c = b.c0; c <= b.c1; c++) out.push(rows[r].cells[c]);
    return out;
  }
  function drawSel() {
    $$("td.insel").forEach(function (td) { td.classList.remove("insel"); });
    var cells = selected();
    cells.forEach(function (td) { td.classList.add("insel"); });
    $$("[data-edsel]").forEach(function (el) {
      if (!el.dataset.hint) el.dataset.hint = el.textContent;
      var fig = el.closest(".hm-wrap");
      if (!sel || sel.fig !== fig) { el.textContent = el.dataset.hint; return; }
      var b = bounds(), rows = b.r1 - b.r0 + 1, cols = b.c1 - b.c0 + 1;
      el.textContent = (cells.length === 1 ? "1 cell · " + textOf(cells[0]) : rows + " × " + cols + " cells selected") +
        (rangeMode ? " · now tap the far corner" : "");
    });
    $$("[data-op=range]").forEach(function (b) { b.setAttribute("aria-pressed", rangeMode ? "true" : "false"); });
  }
  function pick(td, extend) {
    var fig = td.closest(".hm-wrap");
    if (extend && sel && sel.fig === fig) sel.b = posOf(td); else sel = { fig: fig, a: posOf(td), b: posOf(td) };
    drawSel();
  }

  document.addEventListener("pointerdown", function (e) {
    pointerType = e.pointerType || "mouse";
    if (!editing || !e.target.closest) return;
    var td = e.target.closest(".hm-wrap[data-edit-name] td[data-i]");
    if (!td) {
      if (sel && !e.target.closest(".edtools, .editbar, .hm-wrap")) { sel = null; rangeMode = false; drawSel(); }
      return;
    }
    if (pointerType !== "mouse") return; // touch selects on click, so a swipe still scrolls the table
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    pick(td, e.shiftKey);
    dragging = true;
  });
  document.addEventListener("pointerover", function (e) {
    if (!dragging || !sel || !e.target.closest) return;
    var td = e.target.closest("td[data-i]");
    if (td && td.closest(".hm-wrap") === sel.fig) { sel.b = posOf(td); drawSel(); }
  });
  document.addEventListener("pointerup", function () { dragging = false; });

  /* ---------- operations ---------- */
  function lerp(a, b, t) { return a + (b - a) * t; }
  function op(fig, name) {
    var status = $("[data-edsel]", fig);
    if (name === "range") { rangeMode = !rangeMode; drawSel(); return; }
    if (name === "undo") { undo(); return; }
    if (!sel || sel.fig !== fig) { if (status) status.textContent = "Select cells first."; bad(status); return; }
    var d = +fig.dataset.digits || 0, step = Math.pow(10, -d);
    var input = $("[data-edval]", fig), x = num(input.value);
    if (/^(set|add|scale)$/.test(name) && isNaN(x)) { bad(input); input.focus(); return; }
    var b = bounds(), rows = rowsOf(fig);
    if (name === "interp" && b.r0 === b.r1 && b.c0 === b.c1) {
      status.textContent = "Select a range of cells to interpolate across.";
      bad(status);
      return;
    }
    var at = function (r, c) { return num(textOf(rows[r].cells[c])); };
    var q = [at(b.r0, b.c0), at(b.r0, b.c1), at(b.r1, b.c0), at(b.r1, b.c1)];
    var batch = [];
    selected().forEach(function (td) {
      var v = num(textOf(td)), p = posOf(td), nv;
      if (isNaN(v)) return;
      if (name === "set") nv = x;
      else if (name === "add") nv = v + x;
      else if (name === "scale") nv = v * (1 + x / 100);
      else if (name === "up") nv = v + step;
      else if (name === "down") nv = v - step;
      else if (name === "interp") {
        var fr = b.r1 > b.r0 ? (p.r - b.r0) / (b.r1 - b.r0) : 0, fc = b.c1 > b.c0 ? (p.c - b.c0) / (b.c1 - b.c0) : 0;
        nv = lerp(lerp(q[0], q[1], fc), lerp(q[2], q[3], fc), fr);
      } else return;
      if (!isFinite(nv)) return;
      batch.push({ box: fig, el: td, before: v });
      setValue(fig, td, nv);
    });
    if (batch.length) undos.push(batch);
    refreshPlots([fig]);
    drawSel();
  }
  function undo() {
    var batch = undos.pop();
    if (!batch) return;
    batch.forEach(function (u) { setValue(u.box, u.el, u.before); });
    refreshPlots(batch.map(function (u) { return u.box; }));
    drawSel();
  }

  document.addEventListener("click", function (e) {
    if (!e.target.closest) return;
    var b = e.target.closest("[data-op]");
    if (b) { op(b.closest(".hm-wrap"), b.dataset.op); return; }
    if (!editing || pointerType === "mouse") return;
    var td = e.target.closest(".hm-wrap[data-edit-name] td[data-i]");
    if (!td) return;
    var extend = rangeMode;
    rangeMode = false;
    pick(td, extend);
  });

  /* ---------- in-place fields: curves, axis bins, single numbers ---------- */
  var fields = $$("[data-edit-name]:not(.hm-wrap) [data-i]");
  function setFieldsEditable(on) {
    fields.forEach(function (el) {
      if (on) {
        el.setAttribute("contenteditable", "true");
        el.setAttribute("inputmode", "decimal");
        el.setAttribute("enterkeyhint", "done");
        el.setAttribute("role", "textbox");
        el.spellcheck = false;
      } else {
        el.removeAttribute("contenteditable");
        el.removeAttribute("role");
      }
    });
  }
  // While typing, record the value after a short pause without touching the text (that would move the caret),
  // so nothing is lost if the page closes before the field blurs. On blur or Enter, tidy the text and add an undo step.
  var typingTimer = null;
  function isField(el) { return el && el.dataset && el.dataset.i != null && el.hasAttribute("contenteditable"); }
  function commitField(el, final) {
    var box = el.closest("[data-edit-name]"), v = num(el.textContent), cur = el.dataset.cur;
    if (isNaN(v)) {
      if (final) { el.textContent = cur; bad(el); record(box.dataset.editName, el.dataset.i, num(cur), cur !== el.dataset.orig); }
      return;
    }
    var s = fmt(v, +box.dataset.digits);
    if (!final) {
      record(box.dataset.editName, el.dataset.i, parseFloat(s), s !== el.dataset.orig);
      el.classList.toggle("edited", s !== el.dataset.orig);
      moveChartPoint(box.dataset.editName, el.dataset.i, v, s);
      return;
    }
    if (s !== cur) undos.push([{ box: box, el: el, before: num(cur) }]);
    setValue(box, el, v);
  }
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (!editing || !isField(el)) return;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { commitField(el, false); }, 400);
  });
  document.addEventListener("focusout", function (e) {
    if (!isField(e.target)) return;
    clearTimeout(typingTimer);
    commitField(e.target, true);
  });

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", function (e) {
    if (!editing) return;
    var t = e.target, k = e.key;
    if (t.matches && t.matches("[data-edval]")) {
      if (k === "Enter") { e.preventDefault(); op(t.closest(".hm-wrap"), e.shiftKey ? "add" : "set"); }
      else if (k === "Escape") t.blur();
      return;
    }
    if (t.isContentEditable) {
      if (k === "Enter") { e.preventDefault(); t.blur(); }
      else if (k === "Escape") { t.textContent = t.dataset.cur; t.blur(); }
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if ((e.metaKey || e.ctrlKey) && (k === "z" || k === "Z")) { e.preventDefault(); undo(); return; }
    if (!sel || e.metaKey || e.ctrlKey || e.altKey) return;
    var move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k];
    if (move) {
      e.preventDefault();
      var rows = rowsOf(sel.fig), from = e.shiftKey ? sel.b : sel.a;
      var p = {
        r: Math.max(0, Math.min(rows.length - 1, from.r + move[0])),
        c: Math.max(1, Math.min(rows[0].cells.length - 1, from.c + move[1]))
      };
      if (e.shiftKey) sel.b = p; else sel = { fig: sel.fig, a: p, b: p };
      drawSel();
      rows[p.r].cells[p.c].scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (k === "+" || k === "=") { e.preventDefault(); op(sel.fig, "up"); return; }
    if (k === "-" || k === "_") { e.preventDefault(); op(sel.fig, "down"); return; }
    if (k === "Escape") { sel = null; rangeMode = false; drawSel(); return; }
    if (/^[0-9.]$/.test(k)) {
      e.preventDefault();
      var input = $("[data-edval]", sel.fig);
      input.focus();
      input.value = k;
    }
  });

  /* ---------- edit mode + pending-edits bar ---------- */
  var bar = $("[data-editbar]");
  var msg = bar && $("[data-edit-msg]", bar), list = bar && $("[data-edit-list]", bar);
  var review = bar && $("[data-edit-review]", bar), saveBtn = bar && $("[data-edit-save]", bar);
  var discardBtn = bar && $("[data-edit-discard]", bar), doneBtn = bar && $("[data-edit-done]", bar);
  var toggles = $$("[data-edit-toggle]");

  function updateBar() {
    if (!bar) return;
    var n = changeCount(), names = Object.keys(edits);
    bar.hidden = !editing && !n;
    document.body.classList.toggle("has-editbar", !bar.hidden);
    bar.classList.remove("err");
    msg.textContent = n
      ? n + " unsaved change" + (n === 1 ? "" : "s") + " in " + names.length + " setting" + (names.length === 1 ? "" : "s") +
        ". Saving creates a new tune with its own link; this one stays as it is."
      : "Editing: select table cells, or tap a number and type. Nothing is saved until you press Save as new tune.";
    saveBtn.hidden = discardBtn.hidden = review.hidden = !n;
    doneBtn.hidden = !editing;
    list.textContent = "";
    names.forEach(function (name) {
      var a = document.createElement("a"), label = document.createElement("span"), count = document.createElement("small");
      var k = Object.keys(edits[name]).length;
      a.href = "/t/" + slug + "/c/" + encodeURIComponent(name);
      label.textContent = name;
      count.textContent = k + (k === 1 ? " value" : " values");
      a.appendChild(label);
      a.appendChild(count);
      list.appendChild(a);
    });
  }

  function setEditing(on) {
    editing = on;
    document.body.classList.toggle("editing", on);
    stash(MODE_KEY, on ? "1" : null);
    toggles.forEach(function (b) {
      b.setAttribute("aria-pressed", on ? "true" : "false");
      var label = $("span", b);
      if (!label) return;
      if (!label.dataset.off) label.dataset.off = label.textContent;
      label.textContent = on ? "Editing" : label.dataset.off;
    });
    setFieldsEditable(on);
    if (on) {
      // Edit in the units the tune stores; lambda/AFR conversion is display-only.
      $$(".hm-wrap[data-edit-name][data-fuel]").forEach(function (fig) {
        var b = $('[data-fuel-show="' + fig.dataset.fuel + '"]', fig);
        if (b && b.getAttribute("aria-pressed") !== "true") b.click();
      });
      var tabbar = $(".tabbar");
      document.documentElement.style.setProperty("--stick", (tabbar ? tabbar.offsetHeight : 0) + "px");
    } else {
      sel = null;
      rangeMode = false;
      drawSel();
    }
    updateBar();
  }
  toggles.forEach(function (b) {
    b.hidden = false;
    b.addEventListener("click", function () { setEditing(!editing); });
  });

  if (bar) {
    doneBtn.addEventListener("click", function () { setEditing(false); });
    discardBtn.addEventListener("click", function () {
      var n = changeCount();
      if (!window.confirm("Discard " + n + " unsaved change" + (n === 1 ? "" : "s") + "?")) return;
      edits = {};
      stash(KEY, null);
      location.reload();
    });
    saveBtn.addEventListener("click", function () {
      var label = $("span", saveBtn);
      saveBtn.disabled = true;
      label.textContent = "Saving…";
      fetch("/t/" + slug + "/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ changes: edits })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
      }, function () {
        throw new Error("Couldn't reach the server. Your edits are kept; try again.");
      }).then(function (res) {
        if (!res.ok || !res.j.url) throw new Error(res.j.error || "Couldn't save the tune. Try again.");
        stash(KEY, null);
        stash(MODE_KEY, null);
        location.href = res.j.url;
      }).catch(function (err) {
        saveBtn.disabled = false;
        label.textContent = "Save as new tune";
        msg.textContent = err.message;
        bar.classList.add("err");
      });
    });
  }

  // Coming back via the back button restores a stale page; reload if edits changed meanwhile.
  var seen = stash(KEY);
  window.addEventListener("pageshow", function (e) { if (e.persisted && stash(KEY) !== seen) location.reload(); });
  window.addEventListener("pagehide", function () { seen = stash(KEY); });

  setEditing(stash(MODE_KEY) === "1" && toggles.length > 0);
  refreshDerived();
})();
