/* TunerStudio's settings dialogs on the live page, built from the ECU's own .ini (layout.ui from /live/start):
   its menu bar, and each dialog with its labelled fields, units, option lists, sliders, info lines, embedded
   curves and tables, greyed-out fields (the .ini's { conditions }, worked out from the ECU's values), the "?"
   help, and Burn / Close.

   Values are what the car page read from the ECU. A change goes the usual way (MSQLive → car page → checked →
   written to the ECU's RAM → read back), so the driver's rules apply: at the car anything a dialog shows can be
   changed (inside the ECU's range); a remote tuner only what remote tuning allows, with the driver approving.
   Mixture shows as AFR and temperatures in °F (the ECU keeps λ and °C): converted for display and back. */
(function () {
  "use strict";
  var api = window.MSQLive, ECU = window.ECU;
  var panel = document.querySelector(".lt-set");
  if (!api || !ECU || !panel) return;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var L = null, UI = null, ROLE = (api.state() || {}).role || "view";
  var bar, menuBox, win, search, results, openTarget = null, pend = {}, wanted = {}, index = null;

  /* ---------------------------------------------------------------- values and units */
  function vals() { return api.values() || {}; }
  function val(n, i) { var v = vals()[n]; return v ? v[i || 0] : undefined; }
  function lookup(n, i) {
    var v = vals()[n];
    if (v && typeof v[i || 0] === "number") return v[i || 0];
    var o = (api.live() || {})[n];
    return typeof o === "number" ? o : undefined;
  }
  function holds(expr) {  // a condition: true when it can't be worked out (TunerStudio would know; we don't grey it)
    if (expr == null || expr === "") return true;
    var r = ECU.evalExpr(expr, lookup);
    return r == null ? true : !!r;
  }
  function isC(u) { return /^\s*(°\s*c|deg\s*c|degc|c|celsius|degrees\s*c)\s*$/i.test(String(u || "")); }
  function isLambda(u) { return /^\s*(lambda|λ)\s*$/i.test(String(u || "")); }
  function digitsOf(c) {
    if (c.digits != null) return c.digits;
    var s = Math.abs(c.scale || 1);
    return s >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(s) - 1e-9));
  }
  /* how a constant is shown: units, decimals, and the conversion from the ECU's number and back */
  function conv(c) {
    var U = api.units(), d = digitsOf(c), u = c.units || "";
    if (isLambda(u)) return { to: function (v) { return v * U.stoich; }, from: function (v) { return v / U.stoich; }, units: "AFR", d: Math.max(1, Math.min(2, d)) };
    if (U.tempF && isC(u)) return { to: function (v) { return v * 1.8 + 32; }, from: function (v) { return (v - 32) / 1.8; }, units: "°F", d: Math.max(0, d) };
    return { to: function (v) { return v; }, from: function (v) { return v; }, units: u, d: d };
  }
  function fmt(v, d) { return v == null || v !== v ? "–" : (+v).toFixed(d); }
  function canEdit(n) {
    var c = L.constants[n];
    if (!c || c.kind === "string" || vals()[n] == null) return false;
    return ROLE === "car" ? true : !!(L.editable || {})[n];
  }
  function lockWhy(n) {
    var c = L.constants[n];
    if (!c) return "This ECU's definition doesn't place this setting in its memory.";
    if (c.kind === "string") return "Text: change it in TunerStudio.";
    if (vals()[n] == null) return "Waiting for the tune from the ECU.";
    return ROLE === "car" ? "" : "Changed at the car only (it needs a power cycle, or sets how the engine is wired, timed, measured or protected).";
  }
  function want(ch) { if (ch && !wanted[ch] && L.outputs && L.outputs[ch]) { wanted[ch] = 1; api.want(ch); } }

  /* ---------------------------------------------------------------- the menu bar */
  function curveById(id) { return (L.curves || []).filter(function (c) { return c.id === id; })[0]; }
  function tableById(id) { return (L.tables || []).filter(function (t) { return t.id === id; })[0]; }
  function build() {
    L = api.layout(); UI = L && L.ui;
    if (!UI || !UI.menus || !UI.menus.length || bar) return;
    ROLE = (api.state() || {}).role || ROLE;
    var top = document.createElement("div");
    top.className = "tsd-top";
    top.innerHTML = '<nav class="tsd-bar" role="menubar">' + UI.menus.map(function (m, i) {
      return '<button type="button" role="menuitem" aria-haspopup="true" data-dmenu="' + i + '">' + esc(m.title) + "</button>";
    }).join("") + '</nav><div class="tsd-menu" role="menu" hidden></div>' +
      '<input type="search" class="tsd-search" placeholder="Find a setting (idle, cranking, injector, trigger…)" aria-label="Find a setting" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<ul class="tsd-results" hidden></ul><div class="tsd-win" hidden></div>';
    panel.insertBefore(top, panel.firstChild);
    bar = top.querySelector(".tsd-bar"); menuBox = top.querySelector(".tsd-menu"); win = top.querySelector(".tsd-win");
    search = top.querySelector(".tsd-search"); results = top.querySelector(".tsd-results");
    var old = panel.querySelector(":scope > input[type=search]"); if (old) old.hidden = true;
    var ul = panel.querySelector(":scope > ul"); if (ul) ul.hidden = true;
    var fine = panel.querySelector(":scope > .fine");
    if (fine) fine.textContent = ROLE === "car" ? "At the car you can change anything these dialogs show, inside the range the ECU allows. Changes go to the ECU's working memory: Burn keeps them." :
      "The driver approves every change. What needs a power cycle, or sets how the engine is wired, timed, measured or protected, is greyed out with a lock: the driver changes those at the car.";
    top.addEventListener("click", onClick);
    top.addEventListener("change", onChange);
    top.addEventListener("keydown", onKey);
    top.addEventListener("focusout", function (e) {  // left without a change: show what the ECU has again
      var el = e.target;
      if (el.dataset && el.dataset.typing) setTimeout(function () { delete el.dataset.typing; refresh(); }, 0);
    });
    search.addEventListener("input", renderResults);
    document.addEventListener("click", function (e) { if (!e.target.closest(".tsd-menu, [data-dmenu]")) closeMenu(); });
    var first = (UI.menus[0].items || []).filter(function (x) { return x.target; })[0];
    showHome();
  }
  function showHome() {
    win.hidden = false; openTarget = null;
    win.innerHTML = '<div class="tsd-home"><b>Settings, the way TunerStudio has them</b><p class="dim">Open a menu above, or find a setting by name.</p>' +
      '<div class="tsd-quick">' + quickList().map(function (q) { return '<button type="button" class="btn sm" data-dopen="' + esc(q[0]) + '">' + esc(q[1]) + "</button>"; }).join("") + "</div></div>";
  }
  function quickList() {  // the dialogs people open most, when this ECU has them
    var want2 = ["engineChars", "injectorConfig", "ignitionSettings", "triggerConfiguration", "idleSettings", "crankingDialog", "AccelEnrich", "mapSettings"];
    var labels = {};
    allItems().forEach(function (it) { if (!labels[it.target]) labels[it.target] = it.label; });
    return want2.filter(function (n) { return UI.dialogs[n] && labels[n]; }).map(function (n) { return [n, labels[n]]; });
  }
  function allItems() {
    var out = [];
    UI.menus.forEach(function (m) { m.items.forEach(function (it) { (it.items || [it]).forEach(function (k) { if (k.target) out.push({ target: k.target, label: k.label, menu: m.title, cond: k.cond }); }); }); });
    return out;
  }
  function openMenu(i, btn) {
    var m = UI.menus[i];
    if (!menuBox.hidden && menuBox.dataset.i === String(i)) { closeMenu(); return; }
    menuBox.dataset.i = i;
    var item = function (k) {
      var ok = holds(k.cond);
      return '<button type="button" role="menuitem" data-dopen="' + esc(k.target) + '"' + (ok ? "" : ' disabled title="Not used with the current settings"') + ">" + esc(k.label) + "</button>";
    };
    menuBox.innerHTML = m.items.map(function (it) {
      if (it.sep) return '<hr>';
      if (it.group) return '<div class="tsd-grp"><small>' + esc(it.group) + "</small>" + it.items.map(item).join("") + "</div>";
      return item(it);
    }).join("");
    menuBox.hidden = false;
    var r = btn.getBoundingClientRect(), pr = menuBox.offsetParent ? menuBox.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
    menuBox.style.left = Math.max(0, Math.min(r.left - pr.left, (menuBox.offsetParent || document.body).clientWidth - menuBox.offsetWidth - 4)) + "px";
    menuBox.style.top = (r.bottom - pr.top + 2) + "px";
    bar.querySelectorAll("[data-dmenu]").forEach(function (b) { b.classList.toggle("on", b === btn); });
  }
  function closeMenu() { if (menuBox) { menuBox.hidden = true; bar.querySelectorAll("[data-dmenu]").forEach(function (b) { b.classList.remove("on"); }); } }

  /* ---------------------------------------------------------------- finding a setting */
  function buildIndex() {
    index = [];
    var seen = {};
    allItems().forEach(function (it) {
      var walk = function (name, depth) {
        var d = UI.dialogs[name];
        if (!d || depth > 10) return;
        d.items.forEach(function (f) {
          if ((f.k === "field" || f.k === "slider") && f.name && !seen[it.target + "|" + f.name]) {
            seen[it.target + "|" + f.name] = 1;
            var t = f.label.replace(/^[#!]+\s*/, "");
            if (t) index.push({ label: t, name: f.name, target: it.target, where: it.menu + " › " + it.label, hay: (t + " " + f.name + " " + it.label + " " + it.menu).toLowerCase() });
          }
          if (f.k === "panel") walk(f.name, depth + 1);
        });
      };
      if (UI.dialogs[it.target]) walk(it.target, 0);
      else index.push({ label: it.label, name: "", target: it.target, where: it.menu, hay: (it.label + " " + it.menu).toLowerCase() });
    });
  }
  function renderResults() {
    var q = search.value.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
    if (!words.length) { results.hidden = true; return; }
    if (!index) buildIndex();
    var hits = index.filter(function (r) { return words.every(function (w) { return r.hay.indexOf(w) >= 0; }); }).slice(0, 40);
    results.hidden = false;
    results.innerHTML = hits.map(function (r) {
      return '<li><button type="button" data-dopen="' + esc(r.target) + '" data-dfocus="' + esc(r.name) + '"><b>' + esc(r.label) + '</b> <small class="dim">' + esc(r.where) + "</small></button></li>";
    }).join("") || '<li class="dim">No setting matches.</li>';
  }

  /* ---------------------------------------------------------------- a dialog */
  function open(target, focusName) {
    closeMenu(); results.hidden = true;
    var item = allItems().filter(function (it) { return it.target === target; })[0] || { label: target };
    var d = UI.dialogs[target], body;
    openTarget = target;
    var title = d && d.title || item.label || target;
    if (d) body = renderDialog(target, 0, true);
    else if (curveById(target)) body = renderCurve(curveById(target));
    else if (tableById(target)) body = renderTable(tableById(target));
    else body = '<p class="dim">This ECU\'s definition has nothing to show here.</p>';
    win.hidden = false;
    win.innerHTML = '<div class="tsd-title"><b>' + esc(title) + '</b><span class="tsd-where dim">' + esc(item.menu || "") + '</span><button type="button" class="tsd-x" data-dclose aria-label="Close">×</button></div>' +
      '<div class="tsd-body">' + body + "</div>" +
      '<div class="tsd-foot"><span class="tsd-msg" aria-live="polite"></span><span class="st-grow"></span>' +
      '<button type="button" class="btn" data-dburn>Burn</button><button type="button" class="btn" data-dclose>Close</button></div>';
    refresh();
    if (focusName) {
      var f = win.querySelector('[data-f="' + CSS.escape(focusName) + '"]');
      if (f) { f.classList.add("tsd-hit"); f.scrollIntoView({ block: "center", behavior: "smooth" }); var inp = f.querySelector("input, select"); if (inp && !inp.disabled) setTimeout(function () { inp.focus(); }, 300); }
    } else win.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function cond(attrs, en, vis) { return (en ? ' data-en="' + esc(en) + '"' : "") + (vis ? ' data-vis="' + esc(vis) + '"' : "") + attrs; }
  function renderDialog(name, depth, topLevel) {
    var d = UI.dialogs[name];
    if (!d || depth > 10) return "";
    var row = /^xAxis$/i.test(d.layout || "");
    var inner = d.items.map(function (it) { return renderItem(it, depth); }).join("");
    if (topLevel) return '<div class="tsd-p ' + (row ? "tsd-row" : "tsd-col") + '">' + inner + "</div>";
    return '<fieldset class="tsd-p ' + (row ? "tsd-row" : "tsd-col") + '">' + (d.title ? "<legend>" + esc(d.title) + "</legend>" : "") + inner + "</fieldset>";
  }
  function renderItem(it, depth) {
    if (it.k === "panel") {
      var inner = UI.dialogs[it.name] ? renderDialog(it.name, depth + 1, false)
        : curveById(it.name) ? '<fieldset class="tsd-p">' + renderCurve(curveById(it.name)) + "</fieldset>"
        : tableById(it.name) ? '<fieldset class="tsd-p">' + renderTable(tableById(it.name)) + "</fieldset>"
        : UI.indicatorPanels && UI.indicatorPanels[it.name] ? renderLamps(UI.indicatorPanels[it.name]) : "";
      if (!inner) return "";
      return '<fieldset class="tsd-pw"' + cond("", it.en, it.vis) + ">" + inner + "</fieldset>";
    }
    if (it.k === "cmd") {
      return '<div class="tsd-f"' + cond("", it.en) + '><span></span><button type="button" class="btn sm" disabled title="ECU commands (tests, resets) run from TunerStudio">' + esc(it.label) + "</button></div>";
    }
    if (it.k === "preset") {
      return '<fieldset class="tsd-f tsd-preset"' + cond("", it.en) + "><label>" + esc(it.label) + '</label><span class="tsd-c"><select data-preset>' +
        '<option value="">Choose…</option>' + it.options.map(function (o, i) { return '<option value="' + i + '">' + esc(o.label) + "</option>"; }).join("") +
        '</select><button type="button" class="btn sm" data-dpreset>Apply</button></span></fieldset>';
    }
    if (it.k === "gauge") {
      var g = (L.gauges || {})[it.name];
      if (!g) return "";
      want(g.ch);
      return '<div class="tsd-f tsd-gauge"><label>' + esc(g.title) + '</label><b class="mono" data-live="' + esc(g.ch) + '" data-ld="' + (g.vd || 0) + '">–</b><span class="tsd-u">' + esc(g.units) + "</span></div>";
    }
    var label = it.label || "";
    if (!it.name) {  // a text line: "#" blue, "!" red, "" a gap
      if (!label.trim()) return '<div class="tsd-gap"></div>';
      var cls = label.charAt(0) === "!" ? "tsd-red" : label.charAt(0) === "#" ? "tsd-blue" : "tsd-txt";
      var t = label.replace(/^[#!]+\s*/, "");
      return '<div class="tsd-note ' + cls + '"' + cond("", it.en, it.vis) + ">" + (/^https?:\/\//.test(t) ? '<a href="' + esc(t) + '" target="_blank" rel="noopener">' + esc(t) + "</a>" : esc(t)) + "</div>";
    }
    var c = L.constants[it.name], help = (UI.help || {})[it.name];
    var lab = label.replace(/^[#!]+\s*/, "");
    var labCls = label.charAt(0) === "!" ? " tsd-red" : label.charAt(0) === "#" ? " tsd-blue" : "";
    var pc = (L.powerCycle || []).indexOf(it.name) >= 0 ? ' <span class="tsd-pc" title="Takes effect after the ECU restarts (power cycle)">⟳</span>' : "";
    var ctl = control(it, c);
    return '<fieldset class="tsd-f" data-f="' + esc(it.name) + '"' + cond("", it.en, it.vis) + ' title="' + esc(it.name) + '">' +
      '<label class="' + labCls + '">' + esc(lab) + pc + "</label>" + ctl +
      (help ? '<button type="button" class="tsd-q" data-dhelp aria-label="Help">?</button><div class="tsd-help" hidden>' + helpHtml(help) + "</div>" : "") + "</fieldset>";
  }
  function helpHtml(h) {
    return /^https?:\/\/\S+$/.test(h) ? '<a href="' + esc(h) + '" target="_blank" rel="noopener">' + esc(h) + "</a>" : esc(h).replace(/\n/g, "<br>");
  }
  function control(it, c) {
    if (!c) return '<span class="tsd-c dim">not in this ECU\'s memory map</span>';
    var n = esc(it.name);
    if (c.kind === "string") return '<span class="tsd-c"><output class="mono" data-n="' + n + '"></output></span>';
    if (c.kind === "bits") {
      return '<span class="tsd-c"><select data-n="' + n + '">' + (c.options || []).map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + "</option>"; }).join("") + "</select></span>";
    }
    if (c.kind === "array") return '<span class="tsd-c dim">(a list of ' + ECU.count(c) + " values)</span>";
    var cv = conv(c), lo = c.lo != null ? cv.to(c.lo) : null, hi = c.hi != null ? cv.to(c.hi) : null;
    if (lo != null && hi != null && hi < lo) { var tmp = lo; lo = hi; hi = tmp; }
    var range = lo != null && hi != null ? "Range " + fmt(lo, cv.d) + " to " + fmt(hi, cv.d) + " " + cv.units : "";
    if (it.k === "slider") {
      return '<span class="tsd-c"><input type="range" data-n="' + n + '"' + (lo != null ? ' min="' + lo + '"' : "") + (hi != null ? ' max="' + hi + '"' : "") +
        ' step="' + Math.pow(10, -cv.d) + '"><output class="mono" data-out="' + n + '"></output></span><span class="tsd-u">' + esc(cv.units) + "</span>";
    }
    return '<span class="tsd-c"><input type="number" inputmode="decimal" step="' + (cv.d ? Math.pow(10, -cv.d) : 1) + '" data-n="' + n + '"' +
      (it.ro ? " readonly" : "") + (lo != null ? ' min="' + +lo.toFixed(cv.d) + '"' : "") + (hi != null ? ' max="' + +hi.toFixed(cv.d) + '"' : "") +
      ' data-range="' + esc(range) + '" title="' + esc(range) + '"></span><span class="tsd-u">' + esc(cv.units) + "</span>";
  }
  function renderLamps(p) {
    return '<div class="tsd-lamps" style="--cols:' + Math.max(1, Math.min(4, p.cols || 2)) + '">' + p.items.map(function (x) {
      ECU.evalExpr(x.expr, function (n) { want(n); return 0; });
      return '<span class="tsd-lamp" data-lamp="' + esc(x.expr) + '" data-on="' + esc(x.on) + '" data-off="' + esc(x.off) + '">' + esc(x.off) + "</span>";
    }).join("") + "</div>";
  }
  /* a curve: its points as a small chart, and the values to edit (x across, y below) */
  function renderCurve(cv) {
    var cx = L.constants[cv.x], cy = L.constants[cv.z];
    if (!cx || !cy) return "";
    want(cv.xch);
    var vx = conv(cx), vy = conv(cy), cols = cv.cols || [];
    var n = ECU.count(cx), cells = function (name, c2, v2) {
      var out = "";
      for (var i = 0; i < n; i++) out += '<td><input type="number" inputmode="decimal" step="any" data-n="' + esc(name) + '" data-i="' + i + '" aria-label="' + esc(name) + " " + (i + 1) + '"></td>';
      return out;
    };
    return '<div class="tsd-curve" data-curve="' + esc(cv.id) + '"><div class="tsd-ct">' + esc(cv.title) + '</div><svg class="tsd-plot" viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      '<div class="tsd-scroll"><table class="tsd-grid"><tr><th>' + esc((cols[0] || "X") + (vx.units ? " (" + vx.units + ")" : "")) + "</th>" + cells(cv.x) + "</tr>" +
      "<tr><th>" + esc((cols[1] || "Y") + (vy.units ? " (" + vy.units + ")" : "")) + "</th>" + cells(cv.z) + "</tr></table></div></div>";
  }
  /* a table: the z values with the axes, highest load on top like TunerStudio */
  function renderTable(t) {
    var cz = L.constants[t.z], cx = L.constants[t.x], cy = L.constants[t.y];
    if (!cz || !cx || !cy) return "";
    var C = ECU.count(cx), R = ECU.count(cy), vz = conv(cz), html = "";
    for (var r = R - 1; r >= 0; r--) {
      html += '<tr><th><input type="number" inputmode="decimal" step="any" data-n="' + esc(t.y) + '" data-i="' + r + '" class="tsd-ax"></th>';
      for (var k = 0; k < C; k++) html += '<td><input type="number" inputmode="decimal" step="any" data-n="' + esc(t.z) + '" data-i="' + (r * C + k) + '" data-heat></td>';
      html += "</tr>";
    }
    html += "<tr><th></th>";
    for (var k2 = 0; k2 < C; k2++) html += '<th><input type="number" inputmode="decimal" step="any" data-n="' + esc(t.x) + '" data-i="' + k2 + '" class="tsd-ax"></th>';
    html += "</tr>";
    return '<div class="tsd-table"><div class="tsd-ct">' + esc(t.title) + (vz.units ? ' <small class="dim">' + esc(vz.units) + "</small>" : "") + '</div><div class="tsd-scroll"><table class="tsd-grid">' + html + "</table></div></div>";
  }

  /* ---------------------------------------------------------------- keeping it current */
  function refresh() {
    if (!win || win.hidden || !openTarget) return;
    // greyed out and hidden, from the conditions (a parent's state carries down: a disabled fieldset disables its fields)
    win.querySelectorAll("[data-vis]").forEach(function (el) { el.hidden = !holds(el.dataset.vis); });
    win.querySelectorAll("[data-en]").forEach(function (el) {
      var on = holds(el.dataset.en);
      if (el.tagName === "FIELDSET") el.disabled = !on;
      el.classList.toggle("tsd-off", !on);
    });
    win.querySelectorAll("[data-n]").forEach(function (el) {
      var n = el.dataset.n, i = +(el.dataset.i || 0), c = L.constants[n], v = val(n, i);
      if (!c) return;
      var editable = canEdit(n) && !el.readOnly;
      if (el.tagName === "OUTPUT") { el.textContent = v == null ? "–" : String(v); return; }
      el.disabled = !editable;
      el.title = editable ? el.dataset.range || "" : lockWhy(n);
      el.closest(".tsd-f, td, th") && el.closest(".tsd-f, td, th").classList.toggle("tsd-lock", !editable && ROLE !== "car");
      if (el.dataset.typing || el.classList.contains("tsd-pend")) return;  // being typed in, or on its way: left alone
      if (v == null) { el.value = ""; return; }
      if (c.kind === "bits") {
        if (!el.querySelector('option[value="' + v + '"]')) el.insertAdjacentHTML("beforeend", '<option value="' + v + '">(value ' + v + ")</option>");
        el.value = String(v);
        return;
      }
      var cv = conv(c), shown = cv.to(v);
      el.value = (+shown).toFixed(cv.d);
      var out = el.type === "range" && win.querySelector('[data-out="' + CSS.escape(n) + '"]');
      if (out) out.textContent = (+shown).toFixed(cv.d);
    });
    heat(); plots(); lamps();
    var burn = win.querySelector("[data-dburn]"), st = api.state() || {};
    if (burn) { burn.classList.toggle("primary", !!st.needBurn); burn.textContent = st.needBurn ? "Burn •" : "Burn"; burn.disabled = ROLE !== "car" && !st.burn; }
  }
  function heat() {
    win.querySelectorAll(".tsd-table").forEach(function (box) {
      var cells = box.querySelectorAll("[data-heat]"), lo = Infinity, hi = -Infinity;
      cells.forEach(function (el) { var v = parseFloat(el.value); if (v === v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
      cells.forEach(function (el) {
        var v = parseFloat(el.value), f = hi > lo ? (v - lo) / (hi - lo) : 0.5;
        el.style.setProperty("--h", v === v ? Math.round(220 - 220 * f) : 0);
      });
    });
  }
  function plots() {
    win.querySelectorAll(".tsd-curve").forEach(function (box) {
      var cv = curveById(box.dataset.curve), xs = vals()[cv.x], ys = vals()[cv.z], svg = box.querySelector("svg");
      if (!xs || !ys || !svg) return;
      var fx = conv(L.constants[cv.x]), fy = conv(L.constants[cv.z]);
      var X = xs.map(fx.to), Y = ys.map(fy.to), x0 = Math.min.apply(null, X), x1 = Math.max.apply(null, X), y0 = Math.min.apply(null, Y), y1 = Math.max.apply(null, Y);
      if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
      var px = function (x) { return 8 + (x1 > x0 ? (x - x0) / (x1 - x0) : 0.5) * 284; }, py = function (y) { return 112 - (y - y0) / (y1 - y0) * 104; };
      var pts = X.map(function (x, i) { return px(x).toFixed(1) + "," + py(Y[i]).toFixed(1); }).join(" ");
      var live = cv.xch != null ? (api.live() || {})[cv.xch] : null, cur = "";
      if (typeof live === "number") { var lx = px(Math.max(x0, Math.min(x1, fx.to(live)))); cur = '<line class="tsd-cur" x1="' + lx + '" x2="' + lx + '" y1="0" y2="120"/>'; }
      svg.innerHTML = cur + '<polyline points="' + pts + '"/>' + X.map(function (x, i) { return '<circle cx="' + px(x).toFixed(1) + '" cy="' + py(Y[i]).toFixed(1) + '" r="2.6"/>'; }).join("") +
        '<text x="4" y="10">' + fmt(y1, fy.d) + '</text><text x="4" y="118">' + fmt(y0, fy.d) + "</text>";
    });
  }
  function lamps() {
    win.querySelectorAll("[data-lamp]").forEach(function (el) {
      var on = ECU.evalExpr(el.dataset.lamp, lookup);
      el.classList.toggle("on", !!on);
      el.textContent = on ? el.dataset.on : el.dataset.off;
    });
    win.querySelectorAll("[data-live]").forEach(function (el) {
      var v = (api.live() || {})[el.dataset.live];
      el.textContent = typeof v === "number" ? v.toFixed(+el.dataset.ld || 0) : "–";
    });
  }
  var liveT = 0;
  api.on("frame", function () {
    if (!win || win.hidden || !openTarget || Date.now() - liveT < 200) return;
    liveT = Date.now(); lamps(); plots();
  });
  api.on("applied", function (m) {
    var el = m && m.id != null ? pend[m.id] : null;
    if (el) { delete pend[m.id]; el.classList.remove("tsd-pend"); flash(el, true); say(""); }
    refresh();
  });
  api.on("rejected", function (m) {
    var el = m && m.id != null ? pend[m.id] : null;
    if (!el) return;
    delete pend[m.id]; el.classList.remove("tsd-pend"); flash(el, false);
    say("Not changed: " + (m.why || "refused"), true);
    refresh();
  });
  api.on("tables", function () { refresh(); });
  api.on("state", function () { refresh(); });
  function flash(el, good) { el.classList.add(good ? "tsd-ok" : "tsd-bad"); setTimeout(function () { el.classList.remove("tsd-ok", "tsd-bad"); }, 900); }
  function say(t, bad) { var m = win && win.querySelector(".tsd-msg"); if (m) { m.textContent = t; m.classList.toggle("bad", !!bad); } }

  /* ---------------------------------------------------------------- changing a value */
  function commit(el) {
    delete el.dataset.typing;
    var n = el.dataset.n, i = +(el.dataset.i || 0), c = L.constants[n];
    if (!c || el.disabled || el.readOnly) return;
    var typed = el.tagName === "SELECT" ? +el.value : parseFloat(String(el.value).replace(",", "."));
    if (!(typed === typed)) { refresh(); return; }
    var v = c.kind === "bits" ? typed : conv(c).from(typed), cur = val(n, i);
    if (c.kind !== "bits") v = Math.round(v * 1e6) / 1e6;
    var tol = c.kind === "bits" ? 0 : Math.max(1e-9, Math.abs(c.scale || 0) * 0.49);
    if (cur != null && Math.abs(v - cur) <= tol) { refresh(); return; }
    if (c.kind !== "bits" && ((c.lo != null && v < c.lo - 1e-9) || (c.hi != null && v > c.hi + 1e-9))) {
      var cv = conv(c);
      say((L.constants[n].label || n) + " must stay between " + fmt(cv.to(Math.min(c.lo, c.hi)), cv.d) + " and " + fmt(cv.to(Math.max(c.lo, c.hi)), cv.d) + " " + cv.units + ".", true);
      flash(el, false); refresh(); return;
    }
    var cells = {}; cells[i] = v;
    el.classList.add("tsd-pend");
    var id = api.setSetting(n, cells);
    pend[id] = el;
    say(ROLE === "car" ? "Writing to the ECU…" : "Sent: waiting for the driver and the ECU…");
  }
  function applyPreset(fs) {
    var sel = fs.querySelector("[data-preset]"), it = null;
    if (sel.value === "") return;
    // find the preset definition again from the open dialog
    var walk = function (name, depth) {
      var d = UI.dialogs[name]; if (!d || depth > 10 || it) return;
      d.items.forEach(function (x) { if (x.k === "preset" && x.label === fs.querySelector("label").textContent) it = x; if (x.k === "panel") walk(x.name, depth + 1); });
    };
    walk(openTarget, 0);
    var opt = it && it.options[+sel.value];
    if (!opt) return;
    var names = Object.keys(opt.set).filter(function (n) { return L.constants[n] && canEdit(n); });
    if (!names.length) { say("Those settings can't be changed from here.", true); return; }
    if (!confirm("Set " + opt.label + "? It changes " + names.length + " setting" + (names.length === 1 ? "" : "s") + ".")) return;
    names.forEach(function (n) { var cells = {}; cells[0] = opt.set[n]; api.setSetting(n, cells); });
    say(opt.label + ": sent.");
  }

  /* ---------------------------------------------------------------- events */
  function onClick(e) {
    var b = e.target.closest("[data-dmenu]");
    if (b) { openMenu(+b.dataset.dmenu, b); return; }
    b = e.target.closest("[data-dopen]");
    if (b && !b.disabled) { if (b.closest(".tsd-results")) search.value = ""; open(b.dataset.dopen, b.dataset.dfocus || ""); return; }
    if (e.target.closest("[data-dclose]")) { showHome(); return; }
    if (e.target.closest("[data-dhelp]")) { var h = e.target.closest(".tsd-f").querySelector(".tsd-help"); if (h) h.hidden = !h.hidden; return; }
    if (e.target.closest("[data-dpreset]")) { applyPreset(e.target.closest(".tsd-preset")); return; }
    if (e.target.closest("[data-dburn]")) {
      if (!confirm("Burn to the ECU? The changes become permanent (they survive turning the car off).")) return;
      api.burn(); say("Burning…");
    }
  }
  function onChange(e) {
    var el = e.target;
    if (el.matches("[data-n]")) commit(el);
  }
  function onKey(e) {
    var el = e.target;
    if (e.key === "Escape") { if (el.matches("[data-n]")) { delete el.dataset.typing; el.blur(); refresh(); } else closeMenu(); }
    if (e.key === "Enter" && el.matches("input[data-n]")) { el.blur(); }
  }
  document.addEventListener("input", function (e) {  // a slider shows its value while it moves
    var el = e.target;
    if (el.matches(".tsd-win input[data-n]") && el.type !== "range") el.dataset.typing = "1";
    if (el.type === "range" && el.matches(".tsd-win [data-n]")) { var o = win.querySelector('[data-out="' + CSS.escape(el.dataset.n) + '"]'); if (o) o.textContent = el.value; }
  });
  var tries = 0, t = setInterval(function () { build(); if (bar || ++tries > 600) clearInterval(t); }, 500);
})();
