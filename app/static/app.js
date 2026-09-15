/* MSQ Viewer front-end: menu bar, project tree, search, cell readouts,
   lambda/AFR toggle, upload UX. No build step, no framework. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var body = document.body;
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

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* private mode */ }
    return null;
  }

  /* ------------------------------------------------------------ menus */
  function closeMenus(except) {
    $$("details.menu[open]").forEach(function (m) { if (m !== except) m.open = false; });
  }
  document.addEventListener("click", function (e) {
    var summary = e.target.closest && e.target.closest("details.menu > summary");
    if (summary) { closeMenus(summary.parentElement); return; }
    if (!e.target.closest || !e.target.closest("details.menu")) closeMenus();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeMenus(); setDock(false); }
  });

  /* ------------------------------------------------------- side dock */
  function setDock(open) {
    body.classList.toggle("dock-open", !!open);
    $$("[data-dock-toggle]").forEach(function (b) {
      if (b.hasAttribute("aria-expanded")) b.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  $$("[data-dock-toggle]").forEach(function (b) {
    b.addEventListener("click", function () {
      closeMenus();
      setDock(!body.classList.contains("dock-open"));
    });
  });
  var narrow = window.matchMedia("(max-width: 1019px)");

  /* -------------------------------------------------------- jump/nav */
  function sectionFor(id) { return document.getElementById("sec-" + id); }
  function jumpTo(id) {
    var el = sectionFor(id);
    if (!el) return false;
    hideBubble();
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    try { history.replaceState(null, "", "#sec-" + id); } catch (e) { /* ignore */ }
    if (narrow.matches) setDock(false);
    closeMenus();
    markActive(id);
    return true;
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-jump]");
    if (!t) return;
    if (jumpTo(t.dataset.jump)) e.preventDefault();
  });

  function markActive(id) {
    var link = null;
    $$(".tl").forEach(function (a) {
      var on = a.dataset.jump === id;
      a.classList.toggle("active", on);
      if (on) link = a;
    });
    // A category panel has no link of its own — light up its group instead.
    var group = link ? link.closest("details.tg") : $('.tree [data-tg="' + id + '"]');
    $$(".tree details.tg").forEach(function (d) { d.classList.toggle("active", d === group); });
    if (group && !group.open) group.open = true;
    $$(".jumpbar [data-jump]").forEach(function (b) {
      var sec = group ? group.dataset.tg : null;
      b.setAttribute("aria-current", (b.dataset.jump === id || b.dataset.jump === sec) ? "true" : "false");
    });
    var crumb = $("[data-crumb]");
    if (crumb) {
      var where = group ? $(".tg-l", group).textContent : "";
      if (link) where = where ? where + " · " + $(".tl-l", link).textContent : $(".tl-l", link).textContent;
      crumb.textContent = where;
    }
  }

  /* scrollspy: whichever section owns the top of the viewport wins */
  var sections = $$("[data-section]");
  if (sections.length && "IntersectionObserver" in window) {
    var visible = {};
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.dataset.section] = en.isIntersecting; });
      // The most specific thing whose top has passed under the menu bar wins;
      // cards are nested inside category panels, so the deepest match is last.
      var line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mb-h")) || 46) + 24;
      var passed = null, passedTop = -Infinity, firstBelow = null, firstTop = Infinity;
      sections.forEach(function (s) {
        if (!visible[s.dataset.section]) return;
        var top = s.getBoundingClientRect().top;
        if (top <= line && top >= passedTop) { passedTop = top; passed = s.dataset.section; }
        if (top > line && top < firstTop) { firstTop = top; firstBelow = s.dataset.section; }
      });
      var best = passed || firstBelow;
      if (best) markActive(best);
    }, { rootMargin: "0px 0px -55% 0px", threshold: 0 });
    sections.forEach(function (s) { spy.observe(s); });
  }

  /* ------------------------------------------------------ dock search */
  var navq = $("#navq"), navres = $("#navres");
  if (navq) {
    var settingRows = null;
    function rows() {
      if (!settingRows) {
        settingRows = $$("tr[data-setting]").map(function (tr) {
          return { hay: tr.dataset.name || "", name: tr.cells[0] ? tr.cells[0].textContent.trim() : "",
                   val: tr.cells[1] ? tr.cells[1].textContent.trim() : "", el: tr };
        });
      }
      return settingRows;
    }
    function clearHits() { $$("tr.hit").forEach(function (tr) { tr.classList.remove("hit"); }); }
    function runSearch() {
      var q = navq.value.trim().toLowerCase();
      $$(".tree li").forEach(function (li) {
        var a = li.firstElementChild;
        li.hidden = !!q && (a.dataset.name || "").indexOf(q) === -1;
      });
      $$(".tree details.tg").forEach(function (d) {
        var any = $$("li", d).some(function (li) { return !li.hidden; });
        d.hidden = !!q && !any;
        if (q && any) d.open = true;
      });
      if (!q) { navres.hidden = true; navres.textContent = ""; clearHits(); return; }

      var hits = rows().filter(function (r) { return r.hay.indexOf(q) !== -1; });
      navres.textContent = "";
      var head = document.createElement("div");
      head.className = "rgroup";
      head.textContent = hits.length ? "Settings (" + hits.length + ")" : "No settings match";
      navres.appendChild(head);
      hits.slice(0, 40).forEach(function (r) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "rhit";
        var n = document.createElement("b");
        n.textContent = r.name;
        var v = document.createElement("span");
        v.className = "rv";
        v.textContent = r.val;
        b.appendChild(n);
        b.appendChild(v);
        b.addEventListener("click", function () {
          clearHits();
          r.el.classList.add("hit");
          r.el.scrollIntoView({ block: "center", behavior: "smooth" });
          if (narrow.matches) setDock(false);
        });
        navres.appendChild(b);
      });
      if (hits.length > 40) {
        var more = document.createElement("div");
        more.className = "rnone";
        more.textContent = (hits.length - 40) + " more — keep typing to narrow it down.";
        navres.appendChild(more);
      }
      navres.hidden = false;
    }
    var timer;
    navq.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(runSearch, 110);
    });
    navq.addEventListener("search", runSearch);
    document.addEventListener("keydown", function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        if (narrow.matches) setDock(true);
        navq.focus();
        navq.select();
      }
    });
  }

  /* --------------------------------------------------- fold / density */
  function foldWrap(wrap, open) {
    wrap.classList.toggle("folded", !open);
    var btn = $("[data-fold]", wrap);
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-fold]");
    if (!btn) return;
    var wrap = btn.closest(".hm-wrap");
    foldWrap(wrap, wrap.classList.contains("folded"));
  });
  $$("[data-all-tables]").forEach(function (b) {
    b.addEventListener("click", function () {
      var open = b.dataset.allTables === "open";
      $$(".hm-wrap").forEach(function (w) { foldWrap(w, open); });
      closeMenus();
    });
  });
  if (store("msq.compact") === "1") body.classList.add("compact");
  $$("[data-density]").forEach(function (b) {
    b.addEventListener("click", function () {
      body.classList.toggle("compact");
      store("msq.compact", body.classList.contains("compact") ? "1" : "0");
      closeMenus();
    });
  });

  /* ---------------------------------------------------- cell readouts */
  var selCell = null;
  function hideBubble() {
    if (bubble) bubble.hidden = true;
    selected.forEach(function (el) { el.classList.remove("sel", "hl", "rowhl"); });
    selected = [];
    selCell = null;
  }
  function placeBubble() {
    if (!bubble || bubble.hidden || !selCell) return;
    var r = selCell.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
      hideBubble();
      return;
    }
    var bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 8);
    var top = r.top - bh - 12;
    if (top < 8) top = r.bottom + 12;
    bubble.style.left = left + "px";
    bubble.style.top = top + "px";
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
    if (!td) {
      if (!e.target.closest || !e.target.closest(".bubble")) hideBubble();
      return;
    }
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
    var xl = table.dataset.xl || "X", yl = table.dataset.yl || "Y";
    var xv = xTh ? xTh.textContent : String(col - 1), yv = yTh.textContent;

    bubble.textContent = "";
    var v = line("val", value);
    if (units) {
      var s = document.createElement("small");
      s.textContent = units;
      v.appendChild(s);
    }
    bubble.appendChild(v);
    if (table.classList.contains("diff")) {
      var delta = td.querySelector("small");
      bubble.appendChild(line("ab", "A " + (td.dataset.a || "?") + " → B " + value + (delta ? "  (" + delta.textContent + ")" : "")));
    }
    bubble.appendChild(line("xy", xl + " " + xv + " · " + yl + " " + yv));

    td.classList.add("sel");
    yTh.classList.add("hl");
    tr.classList.add("rowhl");
    selected = [td, yTh, tr];
    if (xTh) { xTh.classList.add("hl"); selected.push(xTh); }

    var readout = fig && $("[data-readout]", fig);
    if (readout) {
      readout.textContent = xl + " " + xv + "  ·  " + yl + " " + yv + "  →  " + value + (units ? " " + units : "");
      readout.classList.add("live");
    }

    selCell = td;
    bubble.hidden = false;
    placeBubble();
  });
  var queued = false;
  document.addEventListener("scroll", function () {
    if (!bubble || bubble.hidden || queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; placeBubble(); });
  }, { capture: true, passive: true });
  window.addEventListener("resize", placeBubble);

  /* ------------------------------------------------------ copy/share */
  function pageUrl() { return location.href.split("#")[0]; }
  function flash(btn, text) {
    var target = $(".mi-k", btn) || btn;
    var old = target.dataset.label || target.textContent;
    target.dataset.label = old;
    target.textContent = text;
    setTimeout(function () { target.textContent = old; }, 1600);
  }
  function copyText(text, btn) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); flash(btn, "Copied ✓"); } catch (e) { flash(btn, "Copy failed"); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { flash(btn, "Copied ✓"); }, fallback);
    } else fallback();
  }
  $$("[data-copy-link]").forEach(function (b) {
    b.addEventListener("click", function () { copyText(pageUrl(), b); });
  });
  $$("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var el = $(b.dataset.copy);
      if (el) copyText(el.textContent.trim(), b);
    });
  });
  if (navigator.share) {
    $$("[data-share]").forEach(function (b) {
      b.hidden = false;
      b.addEventListener("click", function () {
        navigator.share({ title: document.title, url: pageUrl() }).catch(function () { /* cancelled */ });
      });
    });
  }

  /* ---------------------------------------------------------- upload */
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
      if (status) {
        status.classList.remove("err");
        status.textContent = f.name + " · " + Math.max(1, Math.round(f.size / 1024)) + " KB";
      }
      var main = zone && $(".dz-main", zone);
      if (main) main.textContent = f.name;
      if (form.hasAttribute("data-autosubmit")) {
        form.classList.add("busy");
        if (status) status.textContent = "Uploading " + f.name + "…";
        if (form.requestSubmit) form.requestSubmit(); else form.submit();
      }
    });
    if (zone) {
      ["dragenter", "dragover"].forEach(function (ev) {
        zone.addEventListener(ev, function () { zone.classList.add("drag"); });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        zone.addEventListener(ev, function () { zone.classList.remove("drag"); });
      });
    }
  });
  window.addEventListener("pageshow", function () {
    $$("form.busy").forEach(function (f) { f.classList.remove("busy"); });
  });

  /* ------------------------------------------------------ lambda/AFR */
  var STOICH_KEY = "msq.stoich";
  function initFuel(root) {
    $$("[data-fuel]", root).forEach(function (fig) {
      if (fig.dataset.fuelReady) return;
      fig.dataset.fuelReady = "1";
      var stored = fig.dataset.fuel;          // what the file contains
      var mode = stored;                      // what we're displaying
      var cells = $$("tbody td", fig);
      cells.forEach(function (td) { td.dataset.v = td.textContent; });
      var los = $$("[data-lo]", fig), his = $$("[data-hi]", fig);
      // NB: the <table> carries data-units too — only label elements may be rewritten.
      var avgs = $$("[data-avg]", fig), unitEls = $$("[data-units-label]", fig);
      los.concat(his, avgs).forEach(function (el) { el.dataset.v = el.textContent; });
      var sel = $("[data-stoich]", fig), custom = $("[data-stoich-custom]", fig);
      var showing = $("[data-showing]", fig), bar = $(".fuelbar", fig);
      var saved = store(STOICH_KEY);
      if (saved && sel) {
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
        los.concat(his, avgs).forEach(function (el) { el.textContent = conv(el.dataset.v); });
        var label = mode === "lambda" ? "λ" : "AFR";
        fig.dataset.showUnits = label;
        unitEls.forEach(function (el) { el.textContent = label; });
        if (showing) {
          showing.textContent = mode === stored
            ? (mode === "lambda" ? "lambda (λ), as stored in the tune" : "AFR, as stored in the tune")
            : (mode === "afr" ? "AFR, converted from lambda × " + st + " stoich"
                              : "lambda (λ), converted from AFR ÷ " + st + " stoich");
        }
        if (bar) bar.classList.toggle("native", mode === stored);
        $$("[data-fuel-show]", fig).forEach(function (b) {
          b.setAttribute("aria-pressed", b.dataset.fuelShow === mode ? "true" : "false");
        });
        hideBubble();
      }
      $$("[data-fuel-show]", fig).forEach(function (b) {
        b.addEventListener("click", function () { mode = b.dataset.fuelShow; render(); });
      });
      function save() { store(STOICH_KEY, String(stoich())); }
      if (sel) {
        sel.addEventListener("change", function () {
          custom.hidden = sel.value !== "custom";
          if (sel.value === "custom") custom.focus();
          save();
          render();
        });
        custom.addEventListener("input", function () { save(); render(); });
      }
      render();
    });
  }

  /* ---------------------------------------------- htmx-less fallback */
  /* The lazy tables and array popouts are htmx-driven. If the CDN is
     blocked (corporate proxy, blocker), load them with plain fetch so the
     page still works rather than sitting on "loading…" forever. */
  function lazyFallback() {
    if (window.htmx) return;
    function load(el) {
      var url = el.getAttribute("hx-get");
      var target = el.getAttribute("hx-target") === "find .cbody" ? $(".cbody", el) : el;
      if (!url || el.dataset.loaded) return;
      el.dataset.loaded = "1";
      fetch(url, { headers: { "HX-Request": "true" } })
        .then(function (r) { return r.text(); })
        .then(function (html) {
          (target || el).innerHTML = html;
          initFuel(target || el);
        })
        .catch(function () {
          (target || el).innerHTML = '<p class="note">Couldn\'t load this table. Reload the page to try again.</p>';
        });
    }
    var io = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { io.unobserve(en.target); load(en.target); }
      });
    }, { rootMargin: "300px 0px" }) : null;
    $$("[hx-get]").forEach(function (el) {
      var trig = el.getAttribute("hx-trigger") || "";
      if (trig.indexOf("intersect") !== -1) {
        if (io) io.observe(el); else load(el);
      } else if (trig.indexOf("toggle") !== -1) {
        el.addEventListener("toggle", function () { if (el.open) load(el); });
      }
    });
  }
  window.addEventListener("load", function () { setTimeout(lazyFallback, 1200); });

  /* --------------------------------------- keep --mb-h honest on wrap */
  var menubar = $(".menubar");
  if (menubar) {
    var syncBar = function () {
      document.documentElement.style.setProperty("--mb-h", menubar.offsetHeight + "px");
    };
    syncBar();
    window.addEventListener("resize", syncBar);
    if (window.ResizeObserver) new ResizeObserver(syncBar).observe(menubar);
  }

  /* ------------------------------------------------------------ init */
  initFuel(document);
  body.addEventListener("htmx:afterSwap", function (e) { initFuel(e.target); });
  var hash = decodeURIComponent(location.hash.replace(/^#sec-/, ""));
  if (hash && sectionFor(hash)) markActive(hash);
  else if (sections.length) markActive(sections[0].dataset.section);
})();
