/* Live tuning page. One page, two roles:
   - "car": Chrome / Edge on the laptop at the car. Picks the TunerStudio project folder, connects to the ECU
     (Web Serial, or the simulated ECU), streams live data, and is the only thing that writes to the ECU:
     it checks every requested change against the driver's setting and limits, writes it to RAM, reads it
     back, and reports what the ECU now holds. Undo, burn.
   - "view": the tuner, on any phone or computer: gauges, a live graph, and the tables with the live cursor;
     changes go to the car page as requests. */
(function () {
  "use strict";
  var root = document.getElementById("live");
  if (!root) return;
  var ROLE = root.dataset.role, SID = root.dataset.sid || "", KEY = root.dataset.key || "";
  var $ = function (s, el) { return (el || root).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || root).querySelectorAll(s)); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  var layout = null, tables = {}, och = {}, state = {}, ws = null, wsOpen = false;
  var ecu = null, pipe = null, running = false, undoStack = [], queue = [], reqN = 0, pending = {};
  var STOICH = 14.7;
  var frames = 0, fps = 0, rtt = null, chList = [];
  setInterval(function () { fps = frames; frames = 0; if (ROLE === "view") { send({ t: "ping", at: Date.now() }); pill(); } }, 1000);
  var hist = { t: [], rows: {} }, HIST_S = 30;
  var sess = (function () { try { return JSON.parse(localStorage.getItem("msq.live.car") || "null"); } catch (e) { return null; } })();

  function toast(msg, bad) {
    var t = $(".lt-toast");
    t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("on");
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove("on"); }, 3800);
  }
  function fmt(v, d) { return v == null || v !== v ? "–" : (+v).toFixed(d == null ? 1 : d); }

  /* ---------------------------------------------------------------- the link to the server */
  function connectWs() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(proto + location.host + "/live/" + SID + "/ws?k=" + encodeURIComponent(KEY));
    ws.onopen = function () { wsOpen = true; pill(); if (ROLE === "car") pushState(); };
    ws.onclose = function (e) {
      wsOpen = false; pill();
      if (e.code === 4404) {
        if (ROLE === "car" && sess && layout) { restartSession(); return; }
        $(".lt-status").textContent = "This live session has ended (the link is no longer active).";
        return;
      }
      if (e.code === 4000) { toast("This session was opened on another computer; this page stopped sending.", true); return; }
      setTimeout(connectWs, 2000);
    };
    ws.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
  }
  function send(m) { if (ws && wsOpen) ws.send(JSON.stringify(m)); }
  function pushState() {
    send({ t: "state", ecu: !!running, mode: modeSel() ? modeSel().value : "ask", burn: !!($("[data-allow-burn]") || {}).checked,
           needBurn: !!state.needBurn, ecuSignature: state.ecuSignature || "", signature: layout ? layout.comms.signature : "" });
  }
  function onMessage(m) {
    if (m.t === "hello") {
      state = m.state || {}; tables = Object.keys(m.tables || {}).length ? m.tables : tables; if (m.och) och = m.och;
      if (m.chs) chList = m.chs;
      if (m.want && ROLE === "car") { wanted = {}; m.want.forEach(function (n) { wanted[n] = 1; }); }
      if (ROLE === "view") sendWant();
      (m.changes || []).forEach(logChange);
      renderAll();
    } else if (m.t === "state") { state = Object.assign(state, m.state); renderState(); }
    else if (m.t === "chs") { chList = m.n || []; }
    else if (m.t === "o" && ROLE === "view") {
      var v = m.v || [];
      for (var i = 0; i < chList.length; i++) if (v[i] != null) och[chList[i]] = v[i];
      frames++; pushHist(); drawLive();
    }
    else if (m.t === "want" && ROLE === "car") { wanted = {}; (m.n || []).forEach(function (n) { wanted[n] = 1; }); }
    else if (m.t === "pong") { rtt = Date.now() - (m.at || Date.now()); pill(); }
    else if (m.t === "tables" && ROLE === "view") { Object.keys(m.tables).forEach(function (k) { tables[k] = m.tables[k]; }); renderTable(); }
    else if (m.t === "applied") {
      if (ROLE === "view") {
        var vals = tables[m.table];
        if (vals) Object.keys(m.cells).forEach(function (k) { vals[+k] = m.cells[k]; });
        clearPending(m.id, m.table, m.cells);
      }
      logChange(m); flashCells(m.table, m.cells); renderTable();
      if (ROLE === "view" && m.by === "driver") toast("The driver changed " + Object.keys(m.cells).length + " cell(s) in " + title(m.table));
    } else if (m.t === "rejected") { clearPending(m.id); toast("Not changed: " + (m.why || "refused"), true); renderTable(); }
    else if (m.t === "burned") { toast("Burned to the ECU: the changes are now permanent."); state.needBurn = false; renderState(); }
    else if (m.t === "notice") toast(m.text || "");
    else if (ROLE === "car" && (m.t === "set" || m.t === "undo" || m.t === "burn")) carRequest(m);
  }

  /* ---------------------------------------------------------------- the car side: the ECU */
  function modeSel() { return $("[data-mode]"); }
  function startSession(files) {
    var ini = files.ini, msq = files.msq;
    var fd = new FormData();
    fd.append("ini", ini, "mainController.ini");
    if (msq) fd.append("msq", msq, msq.name || "CurrentTune.msq");
    if (sess) { fd.append("sid", sess.id); fd.append("car_key", sess.car_key); fd.append("view_key", sess.view_key); fd.append("tune", sess.tune || ""); }
    $(".lt-status").textContent = "Reading the ECU definition…";
    return fetch("/live/start", { method: "POST", body: fd }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      sess = { id: j.id, car_key: j.car_key, view_key: j.view_key, tune: j.tune };
      try { localStorage.setItem("msq.live.car", JSON.stringify(sess)); } catch (e) { /* ignore */ }
      SID = j.id; KEY = j.car_key;
      history.replaceState(null, "", j.car_url);
      return fetch("/live/" + SID + "/layout?k=" + encodeURIComponent(KEY)).then(function (r) { return r.json(); });
    }).then(function (l) {
      layout = l; carFiles = files;
      root.classList.add("has-session");
      renderShare(); renderTablePicker(); connectWs();
      $(".lt-status").textContent = "Ready. Connect the ECU (TunerStudio must be closed: only one program can use the ECU's USB port).";
    });
  }
  var carFiles = null;
  function restartSession() { if (carFiles) startSession(carFiles).catch(function (e) { toast(e.message, true); }); }

  function connectEcu(sim) {
    if (!layout) return;
    var p = sim ? Promise.resolve(ECU.simPipe(layout, carFiles && carFiles.msqText ? ECU.pageFromMsq(layout, carFiles.msqText) : null))
                : ECU.connectSerial();
    $(".lt-status").textContent = sim ? "Starting the simulated ECU…" : "Choose the ECU's USB port in the box Chrome shows…";
    p.then(function (pp) {
      pipe = pp;
      ecu = new ECU.Ecu(new ECU.Link(pipe, layout.comms.blockReadTimeout || 3000), layout);
      return ecu.signature();
    }).then(function (sig) {
      state.ecuSignature = sig;
      if (layout.comms.signature && sig.trim() !== layout.comms.signature.trim()) {
        toast("Careful: the ECU says “" + sig + "” but the project's .ini is for “" + layout.comms.signature + "”.", true);
      }
      $(".lt-status").textContent = "Reading the tune from the ECU…";
      return ecu.readPage(function (f) { $(".lt-status").textContent = "Reading the tune from the ECU… " + Math.round(f * 100) + "%"; });
    }).then(function (page) {
      tables = ECU.decodeConstants(layout, page, ecu.little);
      send({ t: "tables", tables: tables });
      running = true; root.classList.add("ecu-on"); root.classList.toggle("is-sim", !!sim);
      $(".lt-status").textContent = (sim ? "Simulated ECU" : "ECU") + " connected: " + state.ecuSignature;
      pushState(); renderAll(); pollLoop(); keepAwake();
    }).catch(function (e) {
      if (e && e.name === "NotFoundError") { $(".lt-status").textContent = "No port chosen."; return; }
      $(".lt-status").textContent = "Couldn't connect: " + (e && e.message || e);
    });
  }
  /* keep the laptop's screen (and so the USB link and this page) awake while the ECU is connected */
  var wake = null;
  function keepAwake() {
    if (!("wakeLock" in navigator) || !running) return;
    navigator.wakeLock.request("screen").then(function (w) { wake = w; }, function () { /* not allowed here */ });
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && running && !wake) keepAwake(); });
  function disconnectEcu() {
    if (wake) { wake.release().catch(function () { /* ignore */ }); wake = null; }
    running = false; root.classList.remove("ecu-on");
    if (pipe) pipe.close(); pipe = null; ecu = null;
    pushState(); $(".lt-status").textContent = "ECU disconnected.";
  }
  /* Read the ECU as fast as it answers (up to ~60 times a second, the way TunerStudio does), and send the
     tuners a compact frame about 30 times a second: just the numbers, in the order of a channel list sent
     once ("chs"), so each frame is small and the server passes it on untouched. */
  var lastSent = 0, lastRead = 0, reads = 0, rateT = Date.now(), chList = [], chKey = "", wanted = {};
  function streamChannels() {
    var keep = {};
    Object.keys(layout.roles || {}).forEach(function (r) { keep[layout.roles[r]] = 1; });
    (layout.tables || []).forEach(function (t) { if (t.xch) keep[t.xch] = 1; if (t.ych) keep[t.ych] = 1; });
    Object.keys(wanted).forEach(function (n) { if (layout.outputs[n]) keep[n] = 1; });
    return Object.keys(keep).sort();
  }
  function pollLoop() {
    if (!running || !ecu) return;
    if (queue.length) return work().then(function () { setTimeout(pollLoop, 0); });
    var started = Date.now();
    ecu.och().then(function (block) {
      och = ECU.decodeOutputs(layout, block, ecu.little);
      reads++; pushHist(); drawLive();
      var now = Date.now();
      if (now - rateT >= 1000) { state.ecuHz = Math.round(reads * 1000 / (now - rateT)); reads = 0; rateT = now; pill(); }
      if (now - lastSent >= 33) {
        lastSent = now;
        var list = streamChannels(), key = list.join(",");
        if (key !== chKey) { chKey = key; chList = list; send({ t: "chs", n: chList }); }
        send({ t: "o", v: chList.map(function (n) { var v = och[n]; return v == null ? null : v; }), ts: now });
      }
      // ~60 reads a second. With the page in the background Chrome slows timers right down, so there the next
      // read follows straight on (the ECU's own reply time paces it) and only the sending is limited.
      var wait = Math.max(0, 16 - (Date.now() - started));
      if (document.hidden || !wait) Promise.resolve().then(pollLoop); else setTimeout(pollLoop, wait);
    }, function (e) {
      $(".lt-status").textContent = "Lost the ECU: " + e.message + ". Retrying…";
      setTimeout(pollLoop, 800);
    });
  }

  /* Every change goes through here, one at a time, between live-data reads. */
  function carRequest(m) {
    if (m.t === "burn") { queue.push({ kind: "burn", m: m }); return; }
    if (m.t === "undo") { queue.push({ kind: "undo", m: m }); return; }
    var why = check(m.table, m.cells);
    if (why) { send({ t: "rejected", id: m.id, why: why }); return; }
    var mode = modeSel().value;
    if (mode === "off") { send({ t: "rejected", id: m.id, why: "The driver has remote changes turned off." }); return; }
    if (mode === "ask") return askDriver(m);
    queue.push({ kind: "set", m: m, by: "tuner" });
  }
  function check(table, cells) {
    var c = layout.constants[table], vals = tables[table];
    var isZ = (layout.tables || []).some(function (t) { return t.z === table; });
    if (!c || !vals || !isZ) return "That isn't a table that can be changed live.";
    var ks = Object.keys(cells || {});
    if (!ks.length || ks.length > 64) return "Change between 1 and 64 cells at a time.";
    var ign = /ign|timing|advance|spark/i.test(table), pct = c.units === "%" || /^ve/i.test(table);
    for (var i = 0; i < ks.length; i++) {
      var k = +ks[i], v = +cells[ks[i]], old = vals[k];
      if (!(k >= 0 && k < vals.length) || !(v === v)) return "That cell isn't in the table.";
      if ((c.lo != null && v < c.lo - 1e-9) || (c.hi != null && v > c.hi + 1e-9)) return title(table) + " must stay between " + c.lo + " and " + c.hi + ".";
      if (pct && old > 0 && Math.abs(v / old - 1) > 0.25) return "More than 25% in one step on " + title(table) + ". Make it in smaller steps.";
      if (ign && v - old > 5) return "More than 5° more timing in one step. Add it in smaller steps.";
    }
    return null;
  }
  function askDriver(m) {
    var box = $(".lt-ask");
    var c = layout.constants[m.table], vals = tables[m.table], ks = Object.keys(m.cells), big = 0;
    ks.forEach(function (k) { var o = vals[+k]; if (o) big = Math.max(big, Math.abs(m.cells[k] / o - 1) * 100); });
    box.hidden = false;
    box.innerHTML = "<p><b>The tuner wants to change " + ks.length + " cell" + (ks.length === 1 ? "" : "s") + " in " + esc(title(m.table)) + "</b>" +
      (big ? " (up to " + big.toFixed(1) + "%)" : "") + ". It goes to the ECU's working memory now, not burned.</p>" +
      '<div class="lt-ask-b"><button class="btn" type="button" data-ask="no">Reject</button><button class="btn primary" type="button" data-ask="yes">Allow</button></div>' +
      '<label class="check sm"><input type="checkbox" data-ask-always><span>Allow from now on (switches to “Allow”)</span></label>';
    var t = setTimeout(function () { finish(false, "The driver didn't answer in time."); }, 30000);
    function finish(yes, why) {
      clearTimeout(t); box.hidden = true; box.onclick = null;
      if (yes) queue.push({ kind: "set", m: m, by: "tuner" }); else send({ t: "rejected", id: m.id, why: why || "The driver said no." });
    }
    box.onclick = function (e) {
      var b = e.target.closest("[data-ask]");
      if (!b) return;
      if ($("[data-ask-always]", box).checked) { modeSel().value = "auto"; pushState(); }
      finish(b.dataset.ask === "yes");
    };
  }
  function work() {
    var job = queue.shift();
    if (!job || !ecu) return Promise.resolve();
    if (job.kind === "burn") {
      return ecu.burn().then(function () { state.needBurn = false; send({ t: "burned" }); pushState(); toast("Burned: the changes are permanent."); renderState(); },
        function (e) { send({ t: "rejected", id: job.m.id, why: "Burn failed: " + e.message }); });
    }
    if (job.kind === "undo") {
      var u = undoStack.pop();
      if (!u) { send({ t: "rejected", id: job.m.id, why: "Nothing to undo." }); return Promise.resolve(); }
      return writeCells(u.table, u.cells, job.m.by || "tuner", "undo").then(null, function (e) { send({ t: "rejected", id: job.m.id, why: e.message }); });
    }
    return writeCells(job.m.table, job.m.cells, job.by, job.m.note || "", job.m.id).then(null, function (e) {
      send({ t: "rejected", id: job.m.id, why: "Writing to the ECU failed: " + e.message });
    });
  }
  /* Write cells to the ECU's RAM, read them back, and report what it now holds. */
  function writeCells(table, cells, by, note, id) {
    var c = layout.constants[table], vals = tables[table], before = {};
    Object.keys(cells).forEach(function (k) { before[k] = vals[+k]; });
    var runs = ECU.encodeCells(c, cells, ecu.little), sz = ECU.SIZE[c.type];
    var chain = Promise.resolve(), got = {};
    runs.forEach(function (r) {
      chain = chain.then(function () { return ecu.write(r.offset, r.bytes); }).then(function () { return ecu.read(r.offset, r.bytes.length); }).then(function (back) {
        var dec = ECU.decodeConstants({ constants: { x: { kind: "array", type: c.type, offset: 0, rows: 1, cols: back.length / sz, scale: c.scale, translate: c.translate } } }, back, ecu.little).x;
        var first = (r.offset - c.offset) / sz;
        dec.forEach(function (v, i) { got[first + i] = Math.round(v * 1e6) / 1e6; vals[first + i] = got[first + i]; });
      });
    });
    return chain.then(function () {
      if (note !== "undo") undoStack.push({ table: table, cells: before });
      if (undoStack.length > 100) undoStack.shift();
      state.needBurn = true; pushState();
      send({ t: "applied", id: id, table: table, cells: got, by: by, note: note });
      logChange({ table: table, cells: got, by: by, note: note, at: Date.now() / 1000 });
      flashCells(table, got); renderTable(); renderState();
    });
  }

  /* ---------------------------------------------------------------- shared: tables, gauges, graph */
  var curTable = null, sel = {}, rangeMode = false, anchor = null;
  function title(z) { var t = (layout && layout.tables || []).filter(function (x) { return x.z === z; })[0]; return t ? t.title : z; }
  function usableTables() {
    return (layout && layout.tables || []).filter(function (t) { return tables[t.z] && tables[t.x] && tables[t.y]; });
  }
  function renderTablePicker() {
    var sel2 = $("[data-table]");
    if (!sel2 || !layout) return;
    var list = (layout.tables || []);
    var pick = function (re) { return list.filter(function (t) { return re.test(t.z); })[0]; };
    var first = [pick(/^veTable$/), pick(/^ignitionTable$/), pick(/^lambdaTable$|^afrTable$/)].filter(Boolean);
    var rest = list.filter(function (t) { return first.indexOf(t) < 0; });
    sel2.innerHTML = first.concat(rest).map(function (t) { return '<option value="' + esc(t.z) + '">' + esc(t.title) + "</option>"; }).join("");
    if (!curTable && first[0]) curTable = first[0].z;
    sel2.value = curTable || "";
  }
  function tableDef() { return (layout && layout.tables || []).filter(function (t) { return t.z === curTable; })[0]; }
  function renderTable() {
    var box = $(".lt-grid"), t = tableDef();
    if (!box) return;
    if (!t || !tables[t.z]) { box.innerHTML = '<p class="dim">' + (layout ? "Waiting for the tune from the ECU…" : "") + "</p>"; return; }
    var c = layout.constants[t.z], z = tables[t.z], xs = tables[t.x], ys = tables[t.y], C = xs.length, R = ys.length;
    var lo = Infinity, hi = -Infinity;
    z.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    var d = c.digits == null ? 1 : c.digits, h = [];
    for (var r = R - 1; r >= 0; r--) {
      h.push("<tr><th>" + bin(ys[r]) + "</th>");
      for (var cc = 0; cc < C; cc++) {
        var k = r * C + cc, v = z[k];
        var cls = (sel[k] ? " sel" : "") + (pending[t.z + ":" + k] ? " pend" : "");
        h.push('<td data-k="' + k + '" class="' + cls + '" style="background:' + heat(hi > lo ? (v - lo) / (hi - lo) : 0.5) + '">' + cell(v, d) + "</td>");
      }
      h.push("</tr>");
    }
    h.push('<tr class="ax"><th></th>' + xs.map(function (x) { return "<th>" + bin(x) + "</th>"; }).join("") + "</tr>");
    box.innerHTML = '<table class="lt-tt"><tbody>' + h.join("") + "</tbody></table>";
    fitText(box);
    cursor();
    $(".lt-tools").hidden = !Object.keys(sel).length;
    $(".lt-selinfo").textContent = Object.keys(sel).length ? Object.keys(sel).length + " selected" : "";
  }
  function fitText(box) {
    var td = box.querySelector("td"), tb = box.querySelector("table");
    if (!td || !tb) return;
    var longest = 3;
    $$("td", box).forEach(function (x) { longest = Math.max(longest, x.textContent.length); });
    tb.style.fontSize = Math.max(6.8, Math.min(14, (td.offsetWidth - 2) / (longest * 0.58))).toFixed(1) + "px";
  }
  function bin(v) { return Math.abs(v) >= 1000 ? +(v / 1000).toFixed(1) + "k" : Math.abs(v) >= 100 || v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1); }
  function cell(v, d) { var a = Math.abs(v); return v.toFixed(a >= 100 ? 0 : Math.min(d, a >= 10 ? 1 : 2)); }
  function heat(f) {
    f = Math.max(0, Math.min(1, f));
    var s = [[120, 150, 255], [120, 220, 240], [130, 230, 130], [240, 235, 110], [255, 170, 90], [255, 105, 95]];
    var x = f * (s.length - 1), k = Math.min(s.length - 2, Math.floor(x)), r = x - k;
    return "rgb(" + [0, 1, 2].map(function (j) { return Math.round(s[k][j] + (s[k + 1][j] - s[k][j]) * r); }).join(",") + ")";
  }
  function where(bins, v) {
    if (!(v === v) || !bins) return NaN;
    if (v <= bins[0]) return 0;
    for (var i = 0; i < bins.length - 1; i++) if (v < bins[i + 1]) return i + (v - bins[i]) / ((bins[i + 1] - bins[i]) || 1);
    return bins.length - 1;
  }
  var lastCur = null;
  function cursor() {
    var t = tableDef(), box = $(".lt-grid");
    if (!t || !box || !tables[t.x]) return;
    var fx = where(tables[t.x], och[t.xch]), fy = where(tables[t.y], och[t.ych]);
    if (lastCur != null) { var o = box.querySelector('td[data-k="' + lastCur + '"]'); if (o) o.classList.remove("cur"); }
    lastCur = null;
    if (fx === fx && fy === fy) {
      var k = Math.round(fy) * tables[t.x].length + Math.round(fx), el = box.querySelector('td[data-k="' + k + '"]');
      if (el) { el.classList.add("cur"); lastCur = k; }
    }
    var z = tables[t.z], v = fx === fx && fy === fy ? interp(t, fx, fy) : NaN, c = layout.constants[t.z];
    $(".lt-tv").textContent = v === v ? fmt(v, c.digits == null ? 1 : c.digits) + (c.units ? " " + c.units : "") : "";
  }
  function interp(t, fx, fy) {
    var z = tables[t.z], C = tables[t.x].length, R = tables[t.y].length, c0 = Math.floor(fx), r0 = Math.floor(fy);
    var c1 = Math.min(C - 1, c0 + 1), r1 = Math.min(R - 1, r0 + 1), a = fx - c0, b = fy - r0, at = function (r, c) { return z[r * C + c]; };
    return (at(r0, c0) * (1 - a) + at(r0, c1) * a) * (1 - b) + (at(r1, c0) * (1 - a) + at(r1, c1) * a) * b;
  }
  function flashCells(table, cells) {
    if (table !== curTable) return;
    setTimeout(function () {
      Object.keys(cells || {}).forEach(function (k) { var el = $('.lt-grid td[data-k="' + k + '"]'); if (el) { el.classList.remove("hit"); void el.offsetWidth; el.classList.add("hit"); } });
    }, 0);
  }

  /* gauges, from the roles the server found by log label */
  var GAUGES = [["rpm", "RPM", 0], ["map", "MAP", 1], ["afr", "AFR", 2], ["lambda_target", "Target AFR", 2], ["advance", "Timing", 1],
                ["tps", "Throttle", 1], ["clt", "Coolant", 1], ["iat", "Intake", 1], ["ve", "VE", 1], ["knock", "Knock", 1],
                ["inj_duty", "Inj duty", 1], ["duty", "Boost duty", 1], ["boost_target", "Boost target", 1], ["batt", "Battery", 2]];
  function gaugeValue(role) {
    var n = layout && layout.roles && layout.roles[role];
    if (!n || !(n in och)) return null;
    var v = och[n];
    if ((role === "afr" || role === "lambda_target") && v > 0 && v < 2) v *= STOICH;  // show mixture as AFR
    return v;
  }
  // gauges the tuner added: any live channel the ECU has (kept in this browser)
  var extra = (function () { try { return JSON.parse(localStorage.getItem("msq.live.gauges") || "[]") || []; } catch (e) { return []; } })();
  function saveExtra() { try { localStorage.setItem("msq.live.gauges", JSON.stringify(extra)); } catch (e) { /* ignore */ } sendWant(); }
  function sendWant() { if (ROLE === "view") send({ t: "want", n: extra }); }
  function drawGauges() {
    var box = $(".lt-gauges");
    if (!box || !layout) return;
    var sig = extra.join(",");
    if (box.dataset.built !== sig) {
      box.dataset.built = sig;
      box.innerHTML = GAUGES.filter(function (g) { return layout.roles && layout.roles[g[0]]; }).map(function (g) {
        var o = layout.outputs[layout.roles[g[0]]] || {};
        return '<div class="lt-g" data-g="' + g[0] + '"><small>' + esc(g[1]) + '</small><b class="mono">–</b><i>' + esc(g[0] === "afr" || g[0] === "lambda_target" ? "AFR" : o.units || "") + "</i></div>";
      }).join("") + extra.filter(function (n) { return layout.outputs[n]; }).map(function (n) {
        var o = layout.outputs[n];
        return '<div class="lt-g mine" data-ch="' + esc(n) + '"><small>' + esc(o.label || n) + '</small><b class="mono">–</b><i>' + esc(o.units || "") +
          '</i><button type="button" class="lt-gx" data-gdel="' + esc(n) + '" aria-label="Remove this gauge">×</button></div>';
      }).join("") + (ROLE === "view" || ROLE === "car" ? '<button type="button" class="lt-g lt-gadd" data-gadd>＋ Gauge</button>' : "");
    }
    GAUGES.forEach(function (g) {
      var el = box.querySelector('[data-g="' + g[0] + '"] b');
      if (el) el.textContent = fmt(gaugeValue(g[0]), g[2]);
    });
    extra.forEach(function (n) {
      var el = box.querySelector('[data-ch="' + n + '"] b'), o = layout.outputs[n];
      if (el && o) el.textContent = fmt(och[n], o.kind === "bits" ? 0 : Math.abs(och[n]) >= 100 ? 0 : 2);
    });
  }
  function pickGauge() {
    var dlg = $(".lt-pick"), list = Object.keys(layout.outputs).map(function (n) { return [n, layout.outputs[n].label || n]; })
      .sort(function (a, b) { return a[1].localeCompare(b[1]); });
    dlg.hidden = false;
    var inp = $("input", dlg), ul = $("ul", dlg);
    var render = function () {
      var q = inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      ul.innerHTML = list.filter(function (x) { var s = (x[1] + " " + x[0]).toLowerCase(); return q.every(function (w) { return s.indexOf(w) >= 0; }); })
        .slice(0, 120).map(function (x) { return '<li data-pick="' + esc(x[0]) + '">' + esc(x[1]) + (x[1] !== x[0] ? " <small>" + esc(x[0]) + "</small>" : "") + "</li>"; }).join("") ||
        '<li class="dim">No channel matches</li>';
    };
    inp.value = ""; inp.oninput = render; render();
    if (window.innerWidth > 700) inp.focus();
  }
  function pushHist() {
    var now = Date.now() / 1000;
    hist.t.push(now);
    ["rpm", "map", "afr", "lambda_target"].forEach(function (r) { (hist.rows[r] = hist.rows[r] || []).push(gaugeValue(r)); });
    while (hist.t.length && hist.t[0] < now - HIST_S) { hist.t.shift(); Object.keys(hist.rows).forEach(function (r) { hist.rows[r].shift(); }); }
  }
  var drawPending = false, lastData = 0;
  function drawLive() {
    lastData = Date.now();
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(frame);
  }
  function frame() {  // keeps the graph scrolling smoothly between frames while data is flowing
    drawGauges(); drawChart(); cursor();
    if (Date.now() - lastData < 1500) requestAnimationFrame(frame); else drawPending = false;
  }
  function drawChart() {
    var cv = $(".lt-chart canvas");
    if (!cv) return;
    var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    var ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    var now = Date.now() / 1000, kx = W / HIST_S;
    var lines = [["rpm", "#ffe14d", 0, 8000], ["map", "#4fd8ff", 0, 250], ["afr", "#ff5b4d", 10, 18], ["lambda_target", "#ffffff", 10, 18]];
    ctx.lineWidth = 1.4;
    ctx.font = "bold 11px system-ui, sans-serif"; ctx.textBaseline = "top";
    lines.forEach(function (l, i) {
      var ys = hist.rows[l[0]];
      if (!ys || !ys.length) return;
      ctx.strokeStyle = l[1]; ctx.beginPath(); var pen = false;
      for (var j = 0; j < ys.length; j++) {
        var v = ys[j]; if (v == null) { pen = false; continue; }
        var x = W - (now - hist.t[j]) * kx, y = H - 4 - (v - l[2]) / (l[3] - l[2]) * (H - 8);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
      ctx.fillStyle = l[1];
      ctx.fillText({ rpm: "RPM", map: "MAP", afr: "AFR", lambda_target: "Target" }[l[0]] + " " + fmt(ys[ys.length - 1], l[0] === "rpm" ? 0 : 1), 6 + i * 92, 4);
    });
  }

  /* ---------------------------------------------------------------- editing (both roles) */
  function step() { var c = layout.constants[curTable]; return Math.pow(10, -(c.digits == null ? 1 : c.digits)); }
  function requestChange(fn, note) {
    var t = tableDef(), vals = tables[curTable], cells = {};
    if (!t || !vals) return;
    Object.keys(sel).forEach(function (k) {
      var nv = fn(vals[+k]);
      var d = layout.constants[curTable].digits == null ? 1 : layout.constants[curTable].digits, u = Math.pow(10, d);
      nv = Math.round(nv * u) / u;
      if (nv === nv && Math.abs(nv - vals[+k]) > 1e-9) cells[k] = nv;
    });
    if (!Object.keys(cells).length) return;
    if (ROLE === "car") {
      var why = check(curTable, cells);
      if (why) { toast(why, true); return; }
      queue.push({ kind: "set", m: { table: curTable, cells: cells, note: note }, by: "driver" });
      if (!running) toast("Connect the ECU first.", true);
      return;
    }
    var id = ++reqN;
    Object.keys(cells).forEach(function (k) { pending[curTable + ":" + k] = id; });
    send({ t: "set", id: id, table: curTable, cells: cells, note: note || "" });
    renderTable();
  }
  function clearPending(id) { Object.keys(pending).forEach(function (k) { if (id == null || pending[k] === id) delete pending[k]; }); }
  root.addEventListener("click", function (e) {
    var td = e.target.closest(".lt-grid td[data-k]");
    if (td) {
      var k = +td.dataset.k;
      if (rangeMode && anchor != null) {
        var C = tables[tableDef().x].length, a = [Math.floor(anchor / C), anchor % C], b = [Math.floor(k / C), k % C];
        for (var r = Math.min(a[0], b[0]); r <= Math.max(a[0], b[0]); r++) for (var c = Math.min(a[1], b[1]); c <= Math.max(a[1], b[1]); c++) sel[r * C + c] = 1;
        rangeMode = false; $("[data-act=range]").classList.remove("on");
      } else if (sel[k]) delete sel[k]; else { sel[k] = 1; anchor = k; }
      renderTable(); return;
    }
    var b2 = e.target.closest("[data-act]");
    if (b2) {
      var a2 = b2.dataset.act, s = step();
      if (a2 === "clear") { sel = {}; renderTable(); }
      else if (a2 === "range") { rangeMode = !rangeMode; b2.classList.toggle("on", rangeMode); }
      else if (a2 === "inc") requestChange(function (v) { return v + s; });
      else if (a2 === "dec") requestChange(function (v) { return v - s; });
      else if (a2 === "up1") requestChange(function (v) { return v * 1.01; });
      else if (a2 === "dn1") requestChange(function (v) { return v * 0.99; });
      else if (a2 === "set") { var nv = parseFloat($(".lt-val").value); if (nv === nv) requestChange(function () { return nv; }); }
      else if (a2 === "undo") { if (ROLE === "car") queue.push({ kind: "undo", m: { by: "driver" } }); else send({ t: "undo", id: ++reqN }); }
      else if (a2 === "burn") {
        if (!confirm("Burn to the ECU? The changes become permanent (they survive turning the car off).")) return;
        if (ROLE === "car") queue.push({ kind: "burn", m: {} }); else send({ t: "burn", id: ++reqN });
      }
      return;
    }
    var gb = e.target.closest("[data-gadd]");
    if (gb) { pickGauge(); return; }
    gb = e.target.closest("[data-gdel]");
    if (gb) { extra = extra.filter(function (n) { return n !== gb.dataset.gdel; }); saveExtra(); drawGauges(); return; }
    gb = e.target.closest("[data-pick]");
    if (gb) { if (extra.indexOf(gb.dataset.pick) < 0) extra.push(gb.dataset.pick); saveExtra(); $(".lt-pick").hidden = true; drawGauges(); return; }
    if (e.target.closest("[data-pick-close]") || e.target.classList.contains("lt-pick")) { $(".lt-pick").hidden = true; return; }
    if (e.target.closest("[data-connect]")) connectEcu(false);
    else if (e.target.closest("[data-sim]")) connectEcu(true);
    else if (e.target.closest("[data-disconnect]")) disconnectEcu();
    else if (e.target.closest("[data-copy-view]")) copy(location.origin + "/live/" + SID + "?k=" + encodeURIComponent(sess.view_key));
    else if (e.target.closest("[data-share-view]")) navigator.share({ title: "Live tuning", url: location.origin + "/live/" + SID + "?k=" + encodeURIComponent(sess.view_key) }).catch(function () { /* cancelled */ });
  });
  root.addEventListener("change", function (e) {
    if (e.target.matches("[data-table]")) { curTable = e.target.value; sel = {}; renderTable(); }
    if (e.target.matches("[data-mode], [data-allow-burn]")) { pushState(); renderState(); }
    if (e.target.matches("[data-project]")) pickProject(e.target.files);
    if (e.target.matches("[data-files]")) pickProject(e.target.files);
  });
  function copy(text) {
    (navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast("Link copied: send it to your tuner."); },
      function () { window.prompt("Copy this link", text); });
  }

  /* the project folder: projectCfg/mainController.ini and the tune (CurrentTune.msq) */
  function pickProject(files) {
    files = Array.prototype.slice.call(files || []);
    var ini = files.filter(function (f) { return /mainController\.ini$/i.test(f.webkitRelativePath || f.name) || /\.ini$/i.test(f.name); })
      .sort(function (a, b) { return (/mainController/i.test(b.name) ? 1 : 0) - (/mainController/i.test(a.name) ? 1 : 0); })[0];
    var msqs = files.filter(function (f) { return /\.msq$/i.test(f.name) && !/restorePoints|backup/i.test(f.webkitRelativePath || ""); });
    var msq = msqs.filter(function (f) { return /^CurrentTune\.msq$/i.test(f.name); })[0] || msqs[0];
    if (!ini) { toast("That folder has no projectCfg/mainController.ini. Choose the TunerStudio project folder.", true); return; }
    var read = msq ? msq.text() : Promise.resolve("");
    read.then(function (msqText) {
      return startSession({ ini: ini, msq: msq, msqText: msqText });
    }).catch(function (e) { $(".lt-status").textContent = e.message; toast(e.message, true); });
  }

  /* ---------------------------------------------------------------- state and the change log */
  function pill() {
    var p = $(".lt-pill");
    if (!p) return;
    var car = state.car, live = state.ecu;
    p.className = "lt-pill " + (!wsOpen ? "off" : live ? "on" : car ? "warn" : "off");
    p.textContent = !wsOpen ? "Reconnecting…" : ROLE === "car" ? (live ? "Live · " + (state.ecuHz || 0) + " reads/s · " + (state.viewers || 0) + " tuner" + (state.viewers === 1 ? "" : "s") + " watching" : "Waiting for the ECU")
      : live ? "Live · " + fps + "/s" + (rtt != null ? " · " + rtt + " ms" : "") : car ? "Car connected, ECU not" : "Car offline";
    p.title = ROLE === "view" ? "Updates per second from the car, and the round trip to the server" : "";
  }
  function renderState() {
    pill();
    var mode = state.mode || "ask", m = $(".lt-mode-note");
    if (m) m.textContent = ROLE === "view" ? ({ off: "The driver has remote changes off: you can watch, not change.", ask: "The driver approves each change you send.", auto: "Your changes go to the ECU straight away." }[mode]) : "";
    var burn = $("[data-act=burn]");
    if (burn) { burn.disabled = ROLE === "view" && !state.burn; burn.classList.toggle("primary", !!state.needBurn); burn.textContent = state.needBurn ? "Burn to ECU •" : "Burn to ECU"; }
    var tl = $("[data-tune-link]");
    if (tl && (state.tune || (sess && sess.tune))) { tl.href = "/t/" + (state.tune || sess.tune); tl.hidden = false; }
  }
  function logChange(m) {
    var ul = $(".lt-log ul");
    if (!ul || !m.table) return;
    var n = Object.keys(m.cells || {}).length, at = new Date((m.at || Date.now() / 1000) * 1000);
    var li = document.createElement("li");
    li.innerHTML = '<span class="mono">' + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + "</span> " +
      esc(title(m.table)) + ": " + n + " cell" + (n === 1 ? "" : "s") + (m.note === "undo" ? " (undo)" : "") + ' <small class="dim">' + esc(m.by || "") + "</small>";
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 40) ul.removeChild(ul.lastChild);
  }
  function renderShare() {
    var box = $(".lt-share");
    if (!box || !sess) return;
    box.hidden = false;
    $("[data-view-url]").textContent = location.origin + "/live/" + SID + "?k=" + sess.view_key;
    var sh = $("[data-share-view]"); if (sh) sh.hidden = !navigator.share;
  }
  function renderAll() { renderTablePicker(); renderTable(); renderState(); drawLive(); }

  /* ---------------------------------------------------------------- start */
  if (ROLE === "car" && !("serial" in navigator)) root.classList.add("no-serial");
  if (SID) {
    fetch("/live/" + SID + "/layout?k=" + encodeURIComponent(KEY)).then(function (r) {
      if (!r.ok) throw new Error("gone");
      return r.json();
    }).then(function (l) {
      layout = l; root.classList.add("has-session");
      if (ROLE === "car") { renderShare(); $(".lt-status").textContent = "Choose the project folder again to reconnect the ECU, or connect it now."; }
      renderTablePicker(); connectWs(); renderAll();
    }).catch(function () {
      $(".lt-status").textContent = ROLE === "car" ? "This session isn't running any more. Choose the project folder to start a new one." : "This live session has ended. Ask for a new link.";
    });
  }
  window.addEventListener("resize", function () { renderTable(); });
  window.addEventListener("beforeunload", function (e) { if (ROLE === "car" && running) { e.preventDefault(); e.returnValue = ""; } });
})();
