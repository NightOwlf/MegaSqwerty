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
})();
