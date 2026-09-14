/* MSQ Viewer: tabs, tap bubble, copy/share, filters, lambda/AFR toggle, upload UX. No build step. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var bubble = $(".bubble");
  var selected = [];

  if (window.htmx) {
    // Let the delete form show "wrong key" messages (403) instead of silently ignoring them.
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

  /* ---------- tabs ---------- */
  var tabs = $$(".tabbar [data-tab]");
  function showTab(id, remember) {
    var panels = $$("[data-panel]");
    if (!panels.length) return;
    if (!panels.some(function (p) { return p.dataset.panel === id; })) id = panels[0].dataset.panel;
    panels.forEach(function (p) { p.hidden = p.dataset.panel !== id; });
    tabs.forEach(function (t) {
      var on = t.dataset.tab === id;
      t.setAttribute("aria-selected", on ? "true" : "false");
      if (on && t.scrollIntoView) t.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    hideBubble();
    if (remember) {
      try { history.replaceState(null, "", "#" + id); } catch (e) { /* ignore */ }
      var active = panels.filter(function (p) { return !p.hidden; })[0];
      if (active && active.getBoundingClientRect().top < 0) active.scrollIntoView({ block: "start" });
    }
  }
  tabs.forEach(function (t) { t.addEventListener("click", function () { showTab(t.dataset.tab, true); }); });
  if (tabs.length) showTab(decodeURIComponent(location.hash.slice(1)) || tabs[0].dataset.tab, false);

  /* ---------- tap a cell ---------- */
  function hideBubble() {
    if (bubble) bubble.hidden = true;
    selected.forEach(function (el) { el.classList.remove("sel", "hl"); });
    selected = [];
  }
  function line(cls, text) {
    var d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  }
  document.addEventListener("click", function (e) {
    if (!bubble) return;
    var td = e.target.closest && e.target.closest("table.hm td");
    if (!td) { hideBubble(); return; }
    if (td.classList.contains("sel")) { hideBubble(); return; }
    hideBubble();
    var table = td.closest("table");
    var tr = td.parentElement;
    var col = td.cellIndex; // cell 0 is the Y-axis header
    var xTh = table.tHead && table.tHead.rows[0].cells[col];
    var yTh = tr.cells[0];
    var fig = td.closest("[data-grid]");
    var units = (fig && fig.dataset.showUnits) || table.dataset.units || "";
    var value = td.firstChild ? td.firstChild.textContent : td.textContent;

    bubble.textContent = "";
    var v = line("val", value);
    if (units) { var s = document.createElement("small"); s.textContent = units; v.appendChild(s); }
    bubble.appendChild(v);
    if (table.classList.contains("diff")) {
      var delta = td.querySelector("small");
      bubble.appendChild(line("ab", "A " + (td.dataset.a || "?") + " → B " + value + (delta ? "  (" + delta.textContent + ")" : "")));
    }
    var xl = table.dataset.xl || "X", yl = table.dataset.yl || "Y";
    bubble.appendChild(line("xy", xl + " " + (xTh ? xTh.textContent : col - 1) + " · " + yl + " " + yTh.textContent));

    td.classList.add("sel"); yTh.classList.add("hl"); selected = [td, yTh];
    if (xTh) { xTh.classList.add("hl"); selected.push(xTh); }

    bubble.hidden = false;
    var r = td.getBoundingClientRect(), bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 8);
    var top = r.top - bh - 12;
    if (top < 8) top = r.bottom + 12;
    bubble.style.left = left + "px";
    bubble.style.top = top + "px";
  });
  document.addEventListener("scroll", function () { if (bubble && !bubble.hidden) hideBubble(); }, { capture: true, passive: true });

  /* ---------- copy / share ---------- */
  function pageUrl() { return location.href.split("#")[0]; }
  function flash(btn, text) {
    var old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1600);
  }
  function copyText(text, btn) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); flash(btn, "Copied ✓"); } catch (e) { flash(btn, "Copy failed"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { flash(btn, "Copied ✓"); }, fallback);
    } else fallback();
  }
  $$("[data-copy-link]").forEach(function (b) { b.addEventListener("click", function () { copyText(pageUrl(), b); }); });
  $$("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () { var el = $(b.dataset.copy); if (el) copyText(el.textContent.trim(), b); });
  });
  if (navigator.share) {
    $$("[data-share]").forEach(function (b) {
      b.hidden = false;
      b.addEventListener("click", function () {
        navigator.share({ title: document.title, url: pageUrl() }).catch(function () { /* cancelled */ });
      });
    });
  }

  /* ---------- filters ---------- */
  $$("input[data-filter]").forEach(function (inp) {
    var timer;
    inp.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var q = inp.value.trim().toLowerCase();
        $$(inp.dataset.filter).forEach(function (el) {
          el.hidden = !!q && (el.dataset.name || "").indexOf(q) === -1;
        });
      }, 120);
    });
  });

  /* ---------- lambda / AFR ---------- */
  var STOICH_KEY = "msq.stoich";
  function storedStoich() { try { return localStorage.getItem(STOICH_KEY); } catch (e) { return null; } }
  function initFuel(root) {
    $$("[data-fuel]", root).forEach(function (fig) {
      if (fig.dataset.fuelReady) return;
      fig.dataset.fuelReady = "1";
      var stored = fig.dataset.fuel;         // what the file contains
      var mode = stored;                     // what we're displaying
      var cells = $$("tbody td", fig);
      cells.forEach(function (td) { td.dataset.v = td.textContent; });
      var lo = $("[data-lo]", fig), hi = $("[data-hi]", fig), unitsEl = $("[data-units]", fig);
      [lo, hi].forEach(function (el) { if (el) el.dataset.v = el.textContent; });
      var sel = $("[data-stoich]", fig), custom = $("[data-stoich-custom]", fig);
      var showing = $("[data-showing]", fig), bar = $(".fuelbar", fig);
      var saved = storedStoich();
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
      }
      $$("[data-fuel-show]", fig).forEach(function (b) {
        b.addEventListener("click", function () { mode = b.dataset.fuelShow; render(); });
      });
      function save() { try { localStorage.setItem(STOICH_KEY, String(stoich())); } catch (e) { /* ignore */ } }
      sel.addEventListener("change", function () {
        custom.hidden = sel.value !== "custom";
        if (sel.value === "custom") custom.focus();
        save(); render();
      });
      custom.addEventListener("input", function () { save(); render(); });
      render();
    });
  }
  initFuel(document);
  document.body.addEventListener("htmx:afterSwap", function (e) { initFuel(e.target); });
})();
