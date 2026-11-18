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
  function updateStoich() {  // the ECU's live stoich (flex fuel), else the tune's, else gasoline
    var live = och.stoichiometricRatio, set = tables.stoichRatioPrimary && tables.stoichRatioPrimary[0];
    STOICH = live > 5 && live < 30 ? live : set > 5 && set < 30 ? set : 14.7;
  }
  // Temperatures shown in °F (the ECU works in °C: values are converted for display, and back when set)
  var TEMP_F = (function () { try { return (localStorage.getItem("msq.lv.temp") || "F") !== "C"; } catch (e) { return true; } })();
  function isC(u) { return /^\s*(°\s*c|deg\s*c|degc|c|celsius|degrees\s*c)\s*$/i.test(String(u || "")); }
  function showT(v, u) { return TEMP_F && isC(u) && v != null ? v * 1.8 + 32 : v; }
  function showU(u) { return TEMP_F && isC(u) ? "°F" : u || ""; }
  var frames = 0, fps = 0, rtt = null, chList = [];
  /* The log viewer runs on this page's data (viewer.js in live mode): it listens here for frames, the session so
     far, and what the ECU applied or refused, and sends its table edits through set(). */
  var bus = {}, viewerReady = false, viewerWant = {}, heldHist = null;
  function emit(ev) { var a = Array.prototype.slice.call(arguments, 1); (bus[ev] || []).forEach(function (f) { try { f.apply(null, a); } catch (e) { console.error(e); } }); }
  window.MSQLive = {
    on: function (ev, f) { (bus[ev] = bus[ev] || []).push(f); },
    ready: function () {
      viewerReady = true;
      if (heldHist) { emit("hist", heldHist); heldHist = null; }
      if (Object.keys(tables).length) emit("tables", tables);
    },
    want: function (name) {
      if (!name || viewerWant[name]) return;
      viewerWant[name] = 1;
      if (ROLE === "car") wanted[name] = 1; else sendWant();
    },
    set: function (table, cells) { return liveSet(table, cells); },
    state: function () { return Object.assign({ role: ROLE }, state, { mode: ROLE === "car" && modeSel() ? modeSel().value : state.mode }); }
  };
  function liveSet(table, cells) {
    var id = ++reqN;
    if (ROLE === "car") {
      var why = !running ? "Connect the ECU first." : check(table, cells);
      if (why) { setTimeout(function () { emit("rejected", { id: id, why: why }); }, 0); return id; }
      queue.push({ kind: "set", m: { id: id, table: table, cells: cells }, by: "driver" });
      return id;
    }
    send({ t: "set", id: id, table: table, cells: cells });
    return id;
  }
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
    ws.onopen = function () {
      wsOpen = true; pill();
      if (ROLE === "car") {
        pushState();
        if (running) { chKey = ""; send({ t: "tables", tables: tables }); }  // a fresh session (server restarted) needs the tune again
      }
    };
    ws.onclose = function (e) {
      wsOpen = false; pill();
      if (e.code === 4404) {
        if (ROLE === "car") {
          if (carFiles) { $(".lt-status").textContent = "Reconnecting the session…"; setTimeout(restartSession, 500); }
          else $(".lt-status").textContent = "The session needs starting again: choose the project folder (the ECU stays connected).";
          return;
        }
        // the server restarted and the car hasn't started the session again yet: keep trying
        $(".lt-mode-note").textContent = "Waiting for the car to come back online…";
        setTimeout(connectWs, 5000);
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
      if (ROLE === "view") snapBase();
      updateStoich();
      if (m.chs) chList = m.chs;
      if (m.want && ROLE === "car") { wanted = {}; m.want.forEach(function (n) { wanted[n] = 1; }); }
      if (ROLE === "view") sendWant();
      (m.changes || []).forEach(logChange);
      renderAll();
    } else if (m.t === "state") { state = Object.assign(state, m.state); renderState(); renderRec(); emit("state"); }
    else if (m.t === "chs") { chList = m.n || []; }
    else if (m.t === "hist" && ROLE === "view") {
      loadHist(m);
      var fr = (m.f || []).map(function (x) { return [x[0], (m.chs || [])[x[1]], x[2] && x[2].v]; }).filter(function (x) { return x[1] && x[2]; });
      if (viewerReady) emit("hist", fr); else heldHist = fr;
    }
    else if (m.t === "o" && ROLE === "view") {
      var v = m.v || [];
      for (var i = 0; i < chList.length; i++) if (v[i] != null) och[chList[i]] = v[i];
      frames++; pushFrame(Date.now() / 1000, chList, v); drawLive();
      emit("frame", Date.now() / 1000, chList, v);
    }
    else if (m.t === "want" && ROLE === "car") { wanted = {}; (m.n || []).forEach(function (n) { wanted[n] = 1; }); }
    else if (m.t === "pong") { rtt = Date.now() - (m.at || Date.now()); pill(); }
    else if (m.t === "tables" && ROLE === "view") {
      Object.keys(m.tables).forEach(function (k) { tables[k] = m.tables[k]; base[k] = m.tables[k].slice(); });
      updateStoich(); renderTable(); emit("tables", m.tables);
    }
    else if (m.t === "applied") {
      if (ROLE === "view") {
        var vals = tables[m.table];
        if (vals) Object.keys(m.cells).forEach(function (k) { vals[+k] = m.cells[k]; });
        clearPending(m.id, m.table, m.cells);
      }
      logChange(m); flashCells(m.table, m.cells); renderTable(); if ((layout.editable || {})[m.table] === "setting") renderSettings();
      emit("applied", m);
      if (ROLE === "view" && m.by === "driver") toast("The driver changed " + Object.keys(m.cells).length + " cell(s) in " + title(m.table));
    } else if (m.t === "rejected") { clearPending(m.id); renderTable(); if (bus.rejected) emit("rejected", m); else toast("Not changed: " + (m.why || "refused"), true); }
    else if (m.t === "burned") { toast("Burned to the ECU: the changes are now permanent."); state.needBurn = false; snapBase(); renderTable(); renderState(); }
    else if (m.t === "notice") { toast(m.text || ""); $(".lt-mode-note") && ($(".lt-mode-note").textContent = m.text || ""); }
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
    var resumed = !!(SID && sess && sess.id === SID);
    return fetch("/live/start", { method: "POST", body: fd }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      sess = { id: j.id, car_key: j.car_key, view_key: j.view_key, tune: j.tune };
      try { localStorage.setItem("msq.live.car", JSON.stringify(sess)); } catch (e) { /* ignore */ }
      if (!root.dataset.sid) { location.replace(j.car_url); return new Promise(function () { /* the page is moving */ }); }
      SID = j.id; KEY = j.car_key;
      history.replaceState(null, "", j.car_url);
      return fetch("/live/" + SID + "/layout?k=" + encodeURIComponent(KEY)).then(function (r) { return r.json(); });
    }).then(function (l) {
      layout = l; carFiles = files;
      root.classList.add("has-session");
      renderShare(); renderTablePicker();
      if (!ws || ws.readyState > 1) connectWs();
      $(".lt-status").textContent = running ? "Session reconnected. ECU connected: " + (state.ecuSignature || "")
        : "Ready. Connect the ECU (TunerStudio must be closed: only one program can use the ECU's USB port).";
    });
  }
  var carFiles = null;
  function restartSession() {
    if (!carFiles) return;
    (carFiles.last ? useLast(carFiles.last) : startSession(carFiles)).catch(function (e) { toast(e.message, true); });
  }

  function connectEcu(sim) {
    if (!layout) return;
    // the simulated ECU starts from the project's tune (after a reload, the session's tune copy)
    var tuneSlug = state.tune || (sess && sess.tune);
    var msqText = carFiles && carFiles.msqText ? Promise.resolve(carFiles.msqText)
      : carFiles && carFiles.last ? Promise.resolve(carFiles.last.msq || "")
      : tuneSlug ? fetch("/t/" + tuneSlug + ".msq").then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; }) : Promise.resolve("");
    var p = sim ? msqText.then(function (t) { return ECU.simPipe(layout, t ? ECU.pageFromMsq(layout, t) : null); })
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
      snapBase(); updateStoich();
      send({ t: "tables", tables: tables }); emit("tables", tables);
      running = true; root.classList.add("ecu-on"); root.classList.toggle("is-sim", !!sim);
      $(".lt-status").textContent = (sim ? "Simulated ECU" : "ECU") + " connected: " + state.ecuSignature;
      pushState(); renderAll(); pollLoop(); keepAwake();
      $("[data-tpscal]").hidden = !canCalTps();
      var proj = carFiles && (carFiles.msqText || (carFiles.last && carFiles.last.msq));
      var pname = carFiles && (carFiles.msq ? carFiles.msq.name : carFiles.last ? (carFiles.last.msqName || "the project's tune") : "");
      if (proj) compareTune(proj, pname || "the project's tune", false); else tuneSrc("The ECU's own tune (read from it just now).");
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
  /* ---------------------------------------------------------------- the session log
     Like TunerStudio's datalog, started by itself when the ECU connects: about 20 records a second of the
     channels that matter for tuning (what the gauges, tables and log viewer use, then the rest of the ECU's
     log channels up to 120), kept here and sent to the server every two minutes, where it becomes a normal
     log against the session's tune copy: open it in the log viewer, run VE Analyze on it. A part holds up to
     about 30 minutes; then the next part starts. */
  var rec = { cols: null, rows: [], sent: 0, t0: 0, last: 0, part: 1, slug: "", busy: false, timer: 0, partT0: 0 };
  try { var rs = JSON.parse(localStorage.getItem("msq.live.rec") || "null"); if (rs && rs.sid === SID) { rec.part = rs.part; rec.slug = rs.slug; } } catch (e) { /* ignore */ }
  function recCols() {
    var keep = [], seen = {}, add = function (n) { if (n && layout.outputs[n] && !seen[n]) { seen[n] = 1; keep.push(n); } };
    Object.keys(layout.roles || {}).forEach(function (r) { add(layout.roles[r]); });
    allDefs().forEach(function (t) { add(t.xch); add(t.ych); });
    (layout.front || []).forEach(function (g) { add(((layout.gauges || {})[g] || {}).ch); });
    Object.keys(layout.outputs).forEach(function (n) { if (keep.length < 120 && layout.outputs[n].kind !== "bits") add(n); });
    return keep;
  }
  function record() {
    var now = Date.now();
    if (now - rec.last < 48) return;
    rec.last = now;
    if (!rec.cols) { rec.cols = recCols(); rec.t0 = now; rec.partT0 = now; }
    var r = new Array(rec.cols.length + 1);
    r[0] = ((now - rec.t0) / 1000).toFixed(3);
    for (var i = 0; i < rec.cols.length; i++) { var v = och[rec.cols[i]]; r[i + 1] = v == null || v !== v ? "" : +(+v).toPrecision(6); }
    rec.rows.push(r.join("\t"));
    if (!rec.timer) rec.timer = setInterval(flushLog, 120000);
    renderRec();
  }
  function flushLog() {
    if (rec.busy || !SID || rec.rows.length <= rec.sent) return Promise.resolve();
    rec.busy = true;
    var upto = rec.rows.length, first = !rec.slug;
    var head = first ? '"MSQ Viewer live session ' + new Date(rec.t0).toISOString() + '"\n' +
      ["Time"].concat(rec.cols.map(function (n) { return layout.outputs[n].label || n; })).join("\t") + "\n" +
      ["s"].concat(rec.cols.map(function (n) { return layout.outputs[n].units || ""; })).join("\t") + "\n" : "";
    var body = head + rec.rows.slice(rec.sent, upto).join("\n") + "\n";
    var secs = (rec.last - rec.partT0) / 1000;
    var url = "/live/" + SID + "/log?k=" + encodeURIComponent(KEY) + "&part=" + rec.part + "&slug=" + encodeURIComponent(rec.slug) + "&secs=" + secs.toFixed(1);
    return fetch(url, { method: "POST", body: body, headers: { "Content-Type": "text/plain" } }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      rec.busy = false;
      if (res.ok) {
        rec.slug = res.j.slug; rec.sent = upto;
        // keep only what's still to send (the server has the rest), and start a new part after ~30 minutes
        rec.rows = rec.rows.slice(upto); rec.sent = 0;
        if (secs > 1800) { rec.part++; rec.slug = ""; rec.partT0 = rec.last; }
        try { localStorage.setItem("msq.live.rec", JSON.stringify({ sid: SID, part: rec.part, slug: rec.slug })); } catch (e) { /* ignore */ }
      } else if (res.status === 409) { rec.part++; rec.slug = ""; }
      renderRec();
    }, function () { rec.busy = false; });
  }
  // a new part also starts from the header again
  function renderRec() {
    var el = $(".ts-rec");
    if (!el) return;
    var logs = state.logs || [], lastLog = logs[logs.length - 1];
    var rolling = ROLE === "car" && running && rec.cols;
    el.hidden = !rolling && !lastLog;
    if (el.hidden) return;
    var secs = rolling ? Math.round((rec.last - rec.t0) / 1000) : 0;
    var t = Math.floor(secs / 60) + ":" + ("0" + secs % 60).slice(-2);
    var html = (rolling ? '<b class="ts-dotrec">●</b> REC ' + t + " " : "") +
      (lastLog ? logs.map(function (l) {
        return '<a href="/l/' + esc(l.slug) + (state.tune ? "?tune=" + esc(state.tune) : "") + '" target="_blank" rel="noopener" title="Open the session log in the log viewer (saved every 2 minutes)">' +
          (logs.length > 1 ? "Log part " + l.part : "Open session log") + "</a>";
      }).join(" ") : '<span class="dim">first save in 2 min</span>');
    if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
  }
  setInterval(renderRec, 1000);
  window.addEventListener("pagehide", function () { if (ROLE === "car") flushLog(); });
  function disconnectEcu() {
    flushLog();
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
    (layout.front || []).forEach(function (g) { var c = (layout.gauges || {})[g]; if (c) keep[c.ch] = 1; });
    (layout.indicators || []).forEach(function (i) { keep[i.ch] = 1; });
    if (layout.outputs.stoichiometricRatio) keep.stoichiometricRatio = 1;
    return Object.keys(keep).sort();
  }
  function pollLoop() {
    if (!running || !ecu) return;
    if (queue.length) return work().then(function () { ECU.soon(pollLoop); });
    var started = Date.now();
    ecu.och().then(function (block) {
      och = ECU.decodeOutputs(layout, block, ecu.little);
      if (och.stoichiometricRatio) updateStoich();
      record();
      fails = 0; reads++; pushHist(); drawLive();
      var now = Date.now();
      if (now - rateT >= 1000) { state.ecuHz = Math.round(reads * 1000 / (now - rateT)); reads = 0; rateT = now; pill(); }
      if (now - lastSent >= 33) {
        lastSent = now;
        var list = streamChannels(), key = list.join(",");
        if (key !== chKey) { chKey = key; chList = list; send({ t: "chs", n: chList }); }
        var vals = chList.map(function (n) { var v = och[n]; return v == null ? null : v; });
        send({ t: "o", v: vals, ts: now });
        emit("frame", now / 1000, chList, vals);
      }
      // ~60 reads a second. With the page in the background Chrome slows timers right down, so there the next
      // read follows straight on (the ECU's own reply time paces it) and only the sending is limited.
      var wait = Math.max(0, 16 - (Date.now() - started));
      if (document.hidden || !wait) ECU.soon(pollLoop); else setTimeout(pollLoop, wait);
    }, function (e) {
      fails++;
      if (pipe && pipe.port && (pipe.isDead() || fails >= 3)) return reconnectEcu();
      $(".lt-status").textContent = "Lost the ECU: " + e.message + ". Retrying…";
      setTimeout(pollLoop, 300);
    });
  }
  var fails = 0, reconnecting = false;
  /* The USB link dropped (an ECU reset while cranking, a loose cable): open the same device again as soon as
     it's back, check it's the same ECU, and re-read the tune (an ECU that restarted lost anything not burned). */
  function reconnectEcu() {
    if (reconnecting || !running) return;
    reconnecting = true;
    var old = pipe.port;
    try { pipe.close(); } catch (e) { /* ignore */ }
    $(".lt-status").textContent = "The USB link to the ECU dropped: reconnecting…";
    send({ t: "notice", text: "The car's ECU connection dropped for a moment: reconnecting…" });
    var attempt = function (n) {
      if (!running) { reconnecting = false; return; }
      ECU.reopenSerial(old).then(function (pp) {
        if (!pp) return setTimeout(function () { attempt(n + 1); }, 1000);
        pipe = pp;
        ecu = new ECU.Ecu(new ECU.Link(pipe, layout.comms.blockReadTimeout || 3000), layout);
        return ecu.signature().then(function (sig) {
          if (layout.comms.signature && sig.trim() !== layout.comms.signature.trim()) throw new Error("a different ECU answered: " + sig);
          return ecu.readPage();
        }).then(function (page) {
          var fresh = ECU.decodeConstants(layout, page, ecu.little), lost = 0;
          Object.keys(fresh).forEach(function (k) {
            (fresh[k] || []).forEach(function (v, i) { if (tables[k] && Math.abs(tables[k][i] - v) > 1e-6) lost++; });
          });
          tables = fresh;
          if (lost) snapBase();
          send({ t: "tables", tables: tables }); emit("tables", tables);
          if (lost) {
            state.needBurn = false; undoStack = [];
            send({ t: "notice", text: "The ECU restarted: changes that weren't burned are gone (the tables show what it has now)." });
          } else send({ t: "notice", text: "The car's ECU is back." });
          reconnecting = false; fails = 0;
          $(".lt-status").textContent = "ECU reconnected: " + state.ecuSignature;
          pushState(); renderAll(); pollLoop();
        });
      }).catch(function () { setTimeout(function () { attempt(n + 1); }, 1000); });
    };
    attempt(0);
  }
  if ("serial" in navigator) navigator.serial.addEventListener("connect", function () { if (running && pipe && pipe.isDead && pipe.isDead()) reconnectEcu(); });

  /* Every change goes through here, one at a time, between live-data reads. */
  function carRequest(m) {
    if (m.t === "burn") { queue.push({ kind: "burn", m: m }); return; }
    if (m.t === "undo") { queue.push({ kind: "undo", m: m }); return; }
    var why = check(m.table, m.cells);
    if (why) { send({ t: "rejected", id: m.id, why: why }); return; }
    var mode = modeSel().value;
    if (mode === "off") { send({ t: "rejected", id: m.id, why: "The driver has remote changes turned off." }); return; }
    if (mode === "ask" || (layout.editable || {})[m.table] === "setting") return askDriver(m);  // settings: always asked
    queue.push({ kind: "set", m: m, by: "tuner" });
  }
  /* What a remote change may do. The car page is the only thing that writes to the ECU, so this is the rule:
     only what the layout marks editable (tables, curves, settings; never what needs a power cycle, or that
     sets how the engine is wired, timed, measured or protected), inside the ECU's range, in moderate steps. */
  function check(table, cells) { return ECU.checkChange(layout, tables, table, cells, STOICH, title); }
  var asks = [];
  function askDriver(m) {
    asks.push(m);
    if (asks.length === 1) showAsk();
  }
  function showAsk() {
    var m = asks[0];
    if (!m) return;
    var box = $(".lt-ask");
    var c = layout.constants[m.table], vals = tables[m.table], ks = Object.keys(m.cells), big = 0;
    ks.forEach(function (k) { var o = vals[+k]; if (o) big = Math.max(big, Math.abs(m.cells[k] / o - 1) * 100); });
    box.hidden = false;
    var isSet = (layout.editable || {})[m.table] === "setting";
    box.innerHTML = "<p><b>The tuner wants to " + (isSet ? "set " + esc(title(m.table)) + " from " + fmt(vals[0], c.digits) + " to " + fmt(m.cells[ks[0]], c.digits) + (c.units ? " " + esc(c.units) : "")
        : "change " + ks.length + " cell" + (ks.length === 1 ? "" : "s") + " in " + esc(title(m.table))) + "</b>" +
      (big && !isSet ? " (up to " + big.toFixed(1) + "%)" : "") + ". It goes to the ECU's working memory now, not burned.</p>" +
      '<div class="lt-ask-b"><button class="btn" type="button" data-ask="no">Reject</button><button class="btn primary" type="button" data-ask="yes">Allow</button></div>' +
      '<label class="check sm"><input type="checkbox" data-ask-always><span>Allow from now on (switches to “Allow”)</span></label>' +
      (asks.length > 1 ? '<p class="dim">' + (asks.length - 1) + " more waiting</p>" : "");
    var t = setTimeout(function () { finish(false, "The driver didn't answer in time."); }, 30000);
    function finish(yes, why) {
      clearTimeout(t); box.hidden = true; box.onclick = null;
      asks.shift();
      if (yes) {
        var again = check(m.table, m.cells);  // the table may have moved on while it waited
        if (again) send({ t: "rejected", id: m.id, why: again }); else queue.push({ kind: "set", m: m, by: "tuner" });
      } else send({ t: "rejected", id: m.id, why: why || "The driver said no." });
      if (modeSel().value === "auto") { var rest = asks.splice(0); rest.forEach(function (r) { queue.push({ kind: "set", m: r, by: "tuner" }); }); }
      else showAsk();
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
    if (job.kind === "done") { job.fn(); return Promise.resolve(); }
    if (job.kind === "burn") {
      return ecu.burn().then(function () { state.needBurn = false; snapBase(); send({ t: "burned" }); pushState(); toast("Burned: the changes are permanent."); renderTable(); renderState(); },
        function (e) { send({ t: "rejected", id: job.m.id, why: "Burn failed: " + e.message }); });
    }
    if (job.kind === "undo") {
      var u = undoStack.pop();
      if (!u) { send({ t: "rejected", id: job.m.id, why: "Nothing to undo." }); return Promise.resolve(); }
      return writeCells(u.table, u.cells, job.m.by || "tuner", "undo").then(null, function (e) { send({ t: "rejected", id: job.m.id, why: e.message }); });
    }
    return writeCells(job.m.table, job.m.cells, job.by, job.m.note || "", job.m.id).then(null, function (e) {
      send({ t: "rejected", id: job.m.id, why: "Writing to the ECU failed: " + e.message });
      if (job.by === "driver") emit("rejected", { id: job.m.id, why: "Writing to the ECU failed: " + e.message });
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
      send({ t: "applied", id: id, table: table, cells: got, was: before, by: by, note: note });
      emit("applied", { id: id, table: table, cells: got, was: before, by: by, note: note });
      logChange({ table: table, cells: got, was: before, by: by, note: note, at: Date.now() / 1000 });
      flashCells(table, got); renderTable(); renderState();
    });
  }

  /* What's in the ECU is what counts (TunerStudio's rule): the tables come from the ECU, not the file. If the
     project's tune (or one you open) is different, a difference report lets the driver keep the ECU's or write
     the file's into it (then Burn), the way TunerStudio asks. Only tables, curves and the settings this page
     handles are written; wiring, sensor and protection settings stay as the ECU has them. */
  function tuneSrc(text) { var el = $(".lt-tunesrc"); if (el) el.textContent = text; }
  function msqValues(text) {
    var doc = new DOMParser().parseFromString(text, "application/xml"), out = {};
    Array.prototype.forEach.call(doc.getElementsByTagName("constant"), function (el) {
      var name = el.getAttribute("name"), c = layout.constants[name];
      if (!c || !tables[name]) return;
      var vals = el.textContent.trim().split(/\s+/).map(Number);
      if (vals.length === tables[name].length && vals.every(function (v) { return v === v; })) out[name] = vals;
    });
    return out;
  }
  // constants that share ECU memory under two names, and what the firmware sets itself, can't be compared
  var shared = null;
  function sharedMem() {
    if (shared) return shared;
    shared = {};
    var list = Object.keys(layout.constants).map(function (n) { var c = layout.constants[n]; return [c.offset, c.offset + ECU.count(c) * ECU.SIZE[c.type], n]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length && list[j][0] < list[i][1]; j++) { shared[list[i][2]] = 1; shared[list[j][2]] = 1; }
    return shared;
  }
  function diffTune(vals) {
    var out = [], sh = sharedMem();
    Object.keys(vals).forEach(function (name) {
      if (sh[name] || /firmware|version|signature/i.test(name)) return;
      var c = layout.constants[name], tol = Math.pow(10, -(c.digits == null ? 2 : c.digits)) * 0.6 + Math.abs(c.scale || 0) * 0.51, cells = {}, n = 0;
      vals[name].forEach(function (v, i) { if (Math.abs(v - tables[name][i]) > tol) { cells[i] = v; n++; } });
      if (n) out.push({ name: name, cells: cells, n: n });
    });
    return out;
  }
  function compareTune(text, fname, asked) {
    var d = diffTune(msqValues(text)), box = $(".lt-diff");
    if (!d.length) { tuneSrc("ECU tune: the same as " + fname + "."); if (asked) toast("The ECU already has " + fname + "."); return; }
    tuneSrc("ECU tune: different from " + fname + " in " + d.length + " table" + (d.length === 1 ? "" : "s") + "/setting" + (d.length === 1 ? "" : "s") + " (using the ECU's).");
    box.hidden = false;
    $(".lt-modal-in", box).innerHTML = "<b>Difference report</b><p>The ECU and <b>" + esc(fname) + "</b> are different. The engine runs what's in the ECU.</p><ul class=\"lt-dlist\">" +
      d.slice(0, 40).map(function (x) { return "<li>" + esc(title(x.name)) + ' <small class="dim">' + x.n + " value" + (x.n === 1 ? "" : "s") + "</small></li>"; }).join("") + "</ul>" +
      '<div class="lt-row"><button class="btn" type="button" data-diff="ecu">Use the ECU\'s tune</button><button class="btn primary" type="button" data-diff="file">Write ' + esc(fname) + " to the ECU</button></div>" +
      '<p class="fine">Writing puts these tables and settings into the ECU\'s working memory; Burn makes it permanent. Wiring, sensor and protection settings aren\'t written from here.</p>';
    box.onclick = function (e) {
      var b = e.target.closest("[data-diff]");
      if (!b) return;
      box.hidden = true;
      if (b.dataset.diff === "file") loadTune(d, fname);
    };
  }
  function loadTune(d, fname) {
    tuneSrc("Writing " + fname + " to the ECU…");
    d.forEach(function (x) {
      var ks = Object.keys(x.cells);
      for (var i = 0; i < ks.length; i += 128) {
        var part = {}; ks.slice(i, i + 128).forEach(function (k) { part[k] = x.cells[k]; });
        queue.push({ kind: "set", m: { table: x.name, cells: part, note: "load" }, by: "driver" });
      }
    });
    queue.push({ kind: "done", fn: function () {
      tuneSrc("ECU tune: " + fname + " (written, not burned yet).");
      toast(fname + " is in the ECU now. Burn to keep it after the key goes off.");
      send({ t: "tables", tables: tables });
    } });
  }
  /* TPS calibration at the car (key on, engine off), like TunerStudio's: store the sensor voltage at closed and
     wide-open throttle. FOME/rusEFI keep it as tpsMin/tpsMax, 200 units a volt. */
  var tpsNew = {};
  function canCalTps() { return !!(layout && layout.constants.tpsMin && layout.constants.tpsMax && layout.outputs.rawTps1Primary && tables.tpsMin); }
  function drawTps() {
    var box = $(".lt-tps");
    if (!box || box.hidden) return;
    var v = och.rawTps1Primary, tp = gaugeValue("tps");
    $(".lt-tps-live", box).textContent = "Sensor now: " + fmt(v, 3) + " V  (" + Math.round((v || 0) * 200) + ")   TPS " + fmt(tp, 1) + "%\nSaved: closed " + tables.tpsMin[0] + ", wide open " + tables.tpsMax[0];
    $(".lt-tps-new", box).textContent = tpsNew.closed != null || tpsNew.open != null ? "New: closed " + (tpsNew.closed == null ? "–" : tpsNew.closed) + ", wide open " + (tpsNew.open == null ? "–" : tpsNew.open) : "";
    $("[data-tps-save]", box).disabled = !(tpsNew.closed != null && tpsNew.open != null);
  }
  /* ---------------------------------------------------------------- shared: tables, gauges, graph */
  var curTable = null, sel = {}, rangeMode = false, anchor = null, base = {}, trail = [];
  function snapBase() { base = {}; Object.keys(tables).forEach(function (k) { if (tables[k] && tables[k].slice) base[k] = tables[k].slice(); }); }
  function allDefs() { return layout ? (layout.tables || []).concat(layout.curves || []) : []; }
  function title(z) {
    var t = allDefs().filter(function (x) { return x.z === z; })[0], c = layout && layout.constants[z];
    return t && t.title ? t.title : c && c.label ? c.label : z;
  }
  function usableTables() {
    return (layout && layout.tables || []).filter(function (t) { return tables[t.z] && tables[t.x] && tables[t.y]; });
  }
  function renderTablePicker() {
    var sel2 = $("[data-table]");
    if (!sel2 || !layout) return;
    var list = (layout.tables || []), curves = (layout.curves || []).filter(function (c) { return c.title; }), ed = layout.editable || {};
    var pick = function (re) { return list.filter(function (t) { return re.test(t.z); })[0]; };
    var first = [pick(/^veTable$/), pick(/^ignitionTable$/), pick(/^lambdaTable$|^afrTable$/)].filter(Boolean);
    var rest = list.filter(function (t) { return first.indexOf(t) < 0; });
    var opt = function (t) { return '<option value="' + esc(t.z) + '">' + esc(t.title) + (ed[t.z] ? "" : " (view only)") + "</option>"; };
    sel2.innerHTML = '<optgroup label="Tables">' + first.concat(rest).map(opt).join("") + "</optgroup>" +
      (curves.length ? '<optgroup label="Curves">' + curves.map(opt).join("") + "</optgroup>" : "");
    if (!curTable && first[0]) curTable = first[0].z;
    sel2.value = curTable || "";
  }
  function tableDef(z) { var want = z || curTable; return allDefs().filter(function (t) { return t.z === want; })[0]; }
  function renderTable() {
    var box = $(".lt-grid"), t = tableDef();
    if (!box) return;
    if (!t || !tables[t.z] || !tables[t.x]) { box.innerHTML = '<p class="dim">' + (layout ? "Waiting for the tune from the ECU…" : "") + "</p>"; return; }
    var c = layout.constants[t.z], z = tables[t.z], xs = tables[t.x], ys = t.y ? tables[t.y] : [""], C = xs.length, R = ys.length;
    $(".lt-ro").hidden = !!(layout.editable || {})[t.z];
    var b0 = base[t.z] || [];
    var lo = Infinity, hi = -Infinity;
    z.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    var d = c.digits == null ? 1 : c.digits, h = [];
    for (var r = R - 1; r >= 0; r--) {
      h.push("<tr><th>" + (t.y ? bin(showT(ys[r], (layout.constants[t.y] || {}).units)) : esc(showU(c.units))) + "</th>");
      for (var cc = 0; cc < C; cc++) {
        var k = r * C + cc, v = z[k];
        var was = b0[k], tol = Math.pow(10, -(c.digits == null ? 1 : c.digits)) / 2;
        var cls = (sel[k] ? " sel" : "") + (pending[t.z + ":" + k] ? " pend" : "") + (was == null ? "" : v > was + tol ? " up" : v < was - tol ? " dn" : "");
        h.push('<td data-k="' + k + '" class="' + cls + '" style="background:' + heat(hi > lo ? (v - lo) / (hi - lo) : 0.5) + '">' + cell(v, d) + "</td>");
      }
      h.push("</tr>");
    }
    var xu = (layout.constants[t.x] || {}).units;
    h.push('<tr class="ax"><th></th>' + xs.map(function (x) { return "<th>" + bin(showT(x, xu)) + "</th>"; }).join("") + "</tr>");
    box.innerHTML = '<table class="lt-tt"><tbody>' + h.join("") + "</tbody></table>" +
      '<svg class="ts-trail" aria-hidden="true"><polyline points=""/></svg><span class="ts-dot" hidden></span>';
    fitText(box);
    lastCur = null; cursor();
    var n = Object.keys(sel).length;
    root.classList.toggle("has-sel", n > 0);
    $(".lt-selinfo").textContent = n ? n + " selected" : "Tap cells to select";
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
  function heat(f) {  // TunerStudio's table colours: blue, green, yellow, red
    f = Math.max(0, Math.min(1, f));
    var s = [[138, 140, 250], [124, 196, 232], [128, 224, 128], [196, 222, 112], [236, 196, 112], [238, 140, 118]];
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
    var fx = where(tables[t.x], och[t.xch]), fy = t.y ? where(tables[t.y], och[t.ych]) : 0;
    moveDot(box, fx, fy);
    if (lastCur != null) { var o = box.querySelector('td[data-k="' + lastCur + '"]'); if (o) o.classList.remove("cur"); }
    lastCur = null;
    if (fx === fx && fy === fy) {
      var k = Math.round(fy) * tables[t.x].length + Math.round(fx), el = box.querySelector('td[data-k="' + k + '"]');
      if (el) { el.classList.add("cur"); lastCur = k; }
    }
    var z = tables[t.z], v = fx === fx && fy === fy ? interp(t, fx, fy) : NaN, c = layout.constants[t.z];
    $(".lt-tv").textContent = v === v ? "now " + fmt(v, c.digits == null ? 1 : c.digits) + (c.units ? " " + c.units : "") : "";
  }
  /* the operating point: a dot that slides between cells as the engine runs, with a short trail (TunerStudio's) */
  function moveDot(box, fx, fy) {
    var dot = box.querySelector(".ts-dot"), c0 = box.querySelector('td[data-k="0"]'), svg = box.querySelector(".ts-trail");
    if (!dot || !c0) return;
    if (!(fx === fx && fy === fy)) { dot.hidden = true; return; }
    var now = Date.now();
    if (!trail.length || trail[trail.length - 1][0] !== fx || trail[trail.length - 1][1] !== fy) trail.push([fx, fy, now]);
    while (trail.length && (trail.length > 24 || now - trail[0][2] > 1500)) trail.shift();
    var cw = c0.offsetWidth, ch = c0.offsetHeight, x0 = c0.offsetLeft + cw / 2, y0 = c0.offsetTop + ch / 2;
    var px = function (p) { return (x0 + p[0] * cw).toFixed(1) + "," + (y0 - p[1] * ch).toFixed(1); };
    dot.hidden = false;
    dot.style.transform = "translate(" + px([fx, fy]).replace(",", "px,") + "px)";
    svg.setAttribute("width", box.scrollWidth); svg.setAttribute("height", box.scrollHeight);
    svg.firstChild.setAttribute("points", trail.map(px).join(" "));
  }
  function interp(t, fx, fy) {
    var z = tables[t.z], C = tables[t.x].length, R = t.y ? tables[t.y].length : 1, c0 = Math.floor(fx), r0 = Math.floor(fy);
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
    return showT(v, (layout.outputs[n] || {}).units);
  }
  // gauges the tuner added: any live channel the ECU has (kept in this browser)
  var extra = (function () { try { return JSON.parse(localStorage.getItem("msq.live.gauges") || "[]") || []; } catch (e) { return []; } })();
  function saveExtra() { try { localStorage.setItem("msq.live.gauges", JSON.stringify(extra)); } catch (e) { /* ignore */ } sendWant(); }
  function sendWant() { if (ROLE === "view") send({ t: "want", n: extra.concat(Object.keys(viewerWant)) }); }
  function drawGauges() {
    var box = $(".lt-gauges");
    if (!box || !layout) return;
    var sig = extra.join(",");
    if (box.dataset.built !== sig) {
      box.dataset.built = sig;
      box.innerHTML = GAUGES.filter(function (g) { return layout.roles && layout.roles[g[0]]; }).map(function (g) {
        var o = layout.outputs[layout.roles[g[0]]] || {};
        return '<div class="lt-g" data-g="' + g[0] + '"><small>' + esc(g[1]) + '</small><b class="mono">–</b><i>' + esc(g[0] === "afr" || g[0] === "lambda_target" ? "AFR" : showU(o.units)) + "</i></div>";
      }).join("") + extra.filter(function (n) { return layout.outputs[n]; }).map(function (n) {
        var o = layout.outputs[n];
        return '<div class="lt-g mine" data-ch="' + esc(n) + '"><small>' + esc(o.label || n) + '</small><b class="mono">–</b><i>' + esc(showU(o.units)) +
          '</i><button type="button" class="lt-gx" data-gdel="' + esc(n) + '" aria-label="Remove this gauge">×</button></div>';
      }).join("") + (ROLE === "view" || ROLE === "car" ? '<button type="button" class="lt-g lt-gadd" data-gadd>＋ Gauge</button>' : "");
    }
    GAUGES.forEach(function (g) {
      var el = box.querySelector('[data-g="' + g[0] + '"] b');
      if (el) el.textContent = fmt(gaugeValue(g[0]), g[2]);
    });
    extra.forEach(function (n) {
      var el = box.querySelector('[data-ch="' + n + '"] b'), o = layout.outputs[n];
      if (el && o) { var sv = showT(och[n], o.units); el.textContent = fmt(sv, o.kind === "bits" ? 0 : Math.abs(sv) >= 100 ? 0 : 2); }
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
  /* The session so far, about 10 frames a second: what the graph scrolls back through and the gauges, table dot
     and readouts show when you tap a moment. A tuner who joins later gets it from the server first. */
  var H = { t: [], f: [], c: [] }, descs = null;
  function descOf(list) {
    if (descs && descs.list === list) return descs;
    var at = {}; list.forEach(function (n, i) { at[n] = i; });
    descs = { list: list, at: at };
    return descs;
  }
  function pushFrame(ts, list, vals, force) {
    var n = H.t.length;
    if (!force && n && ts - H.t[n - 1] < 0.095) return;
    var f = new Float32Array(vals.length);
    for (var i = 0; i < vals.length; i++) f[i] = vals[i] == null ? NaN : vals[i];
    H.t.push(ts); H.f.push(f); H.c.push(descOf(list));
    if (H.t.length > 90000) { H.t.splice(0, 9000); H.f.splice(0, 9000); H.c.splice(0, 9000); }
  }
  function pushHist() { if (chList.length) pushFrame(Date.now() / 1000, chList, chList.map(function (n) { return och[n]; })); }
  function frameVal(i, name) { var d = H.c[i], k = d && d.at[name]; return k == null ? null : H.f[i][k]; }
  function frameOch(i) { var o = {}, d = H.c[i]; if (!d) return o; d.list.forEach(function (n, k) { var v = H.f[i][k]; if (v === v) o[n] = v; }); return o; }
  function frameAt(t) {  // the last frame at or before t
    var lo = 0, hi = H.t.length - 1;
    if (hi < 0 || t < H.t[0]) return -1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (H.t[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function loadHist(m) {  // [time, channel list id, frame] from the server, older than anything here
    var old = H; H = { t: [], f: [], c: [] }; descs = null;
    (m.f || []).forEach(function (x) { var list = (m.chs || [])[x[1]]; if (list && x[2] && x[2].v) pushFrame(x[0], list, x[2].v, true); });
    var last = H.t.length ? H.t[H.t.length - 1] : -Infinity;
    old.t.forEach(function (t, i) { if (t > last) { H.t.push(t); H.f.push(old.f[i]); H.c.push(old.c[i]); } });
    drawLive();
  }
  var drawPending = false, lastData = 0;
  function drawLive() {
    lastData = Date.now();
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(frame);
  }
  function frame() {  // keeps the graph scrolling smoothly between frames while data is flowing
    var real = och, si = scrub != null ? frameAt(scrub) : -1;
    if (si >= 0) och = frameOch(si);
    try { drawGauges(); drawDials(); drawLamps(); drawRead(); cursor(); } finally { och = real; }
    drawTps();
    drawChart();
    if (Date.now() - lastData < 1500 || gDirty) { gDirty = false; requestAnimationFrame(frame); } else drawPending = false;
  }
  /* The graph: TunerStudio's look, but it keeps the whole session. Drag to scroll back, pinch or the wheel or
     −/+ to zoom, tap a moment to see everything at that time (the gauges, readouts and table dot follow),
     "Live ▶" to follow the car again. */
  var view = { span: 30, end: null }, scrub = null, gDirty = false;
  var GL = [["rpm", "#00e5ff", "rpm (RPM)", 0], ["map", "#ff2a1a", "map (kPa)", 0], ["tps", "#ff66ff", "tps (%)", 0],
            ["lambda_target", "#ffe600", "target AFR", 2], ["afr", "#22dd22", "afr", 2]];
  function roleVal(i, role) {
    var n = layout && layout.roles && layout.roles[role], v = n == null ? null : frameVal(i, n);
    if (v == null || v !== v) return null;
    if ((role === "afr" || role === "lambda_target") && v > 0 && v < 2) v *= STOICH;
    return v;
  }
  function gRange(role) {
    var g = role === "afr" || role === "lambda_target" ? null : dialCfg(role);
    return role === "afr" || role === "lambda_target" ? [10, 20] : role === "tps" ? [0, 100] : g ? [g.lo, g.hi] : role === "rpm" ? [0, 8000] : [0, 250];
  }
  function drawChart() {
    var cv = $(".lt-chart canvas");
    if (!cv || !cv.offsetParent || !layout) return;
    var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H2 = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H2 * dpr); }
    var ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H2);
    var n = H.t.length, latest = n ? H.t[n - 1] : Date.now() / 1000;
    var end = view.end == null ? Math.max(latest, Date.now() / 1000 - 0.05) : view.end, t0 = end - view.span, kx = W / view.span;
    ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 1;
    for (var gy = 1; gy < 4; gy++) { var yy = Math.round(H2 * gy / 4) + 0.5; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke(); }
    var lines = GL.filter(function (l) { return layout.roles && layout.roles[l[0]]; });
    var i0 = Math.max(0, frameAt(t0)), i1 = n - 1, step = Math.max(1, Math.floor((i1 - i0) / (W * 1.5)));
    ctx.lineWidth = 1.5;
    lines.forEach(function (l) {
      var r = gRange(l[0]), pen = false;
      ctx.strokeStyle = l[1]; ctx.beginPath();
      for (var i = i0; i <= i1; i += step) {
        var t = H.t[i]; if (t > end + 1) break;
        var v = roleVal(i, l[0]);
        if (v == null || (i > i0 && H.t[i] - H.t[i - step] > 3)) { pen = false; if (v == null) continue; }
        var x = (t - t0) * kx, y = H2 - 4 - (v - r[0]) / (r[1] - r[0]) * (H2 - 8);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    });
    // scales left, names (and the value at the cursor or now) right
    var si = scrub != null ? frameAt(scrub) : n - 1, lx = 4, bx = 4;
    ctx.font = "12px Arial, Helvetica, sans-serif";
    lines.forEach(function (l, k) {
      var r = gRange(l[0]); ctx.fillStyle = l[1];
      var top = String(+(+r[1]).toFixed(l[3])), bot = String(+(+r[0]).toFixed(l[3]));
      ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(top, lx, 3); lx += ctx.measureText(top).width + 6;
      ctx.textBaseline = "bottom"; ctx.fillText(bot, bx, H2 - 2); bx += ctx.measureText(bot).width + 6;
      var v = si >= 0 ? roleVal(si, l[0]) : null;
      ctx.textAlign = "right"; ctx.textBaseline = "top"; ctx.fillText(l[2] + (v == null ? "" : "  " + fmt(v, l[3])), W - 4, 3 + k * 14);
    });
    if (scrub != null && scrub >= t0 && scrub <= end) {
      var sx = Math.round((scrub - t0) * kx) + 0.5;
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H2); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.textAlign = sx > W - 90 ? "right" : "left"; ctx.textBaseline = "bottom";
      ctx.fillText(new Date(scrub * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), sx + (sx > W - 90 ? -4 : 4), H2 - 16);
    }
    ctx.textAlign = "left";
    var sp = $(".ts-gspan"); if (sp) sp.textContent = view.span >= 120 ? Math.round(view.span / 60) + " min" : Math.round(view.span) + " s";
    var lb = $(".ts-glive"); if (lb) lb.hidden = view.end == null && scrub == null;
  }
  function gTotal() { return H.t.length ? Math.max(10, H.t[H.t.length - 1] - H.t[0] + 2) : 60; }
  function gZoom(f, atX) {
    var cv = $(".lt-chart canvas"), W = cv.clientWidth, latest = H.t.length ? H.t[H.t.length - 1] : Date.now() / 1000;
    var end = view.end == null ? latest : view.end, frac = atX == null ? 1 : atX / W, anchor = end - view.span * (1 - frac);
    view.span = Math.max(3, Math.min(gTotal(), view.span * f));
    if (view.end != null || atX != null && frac < 0.95) { view.end = Math.min(latest, anchor + view.span * (1 - frac)); if (view.end >= latest - 0.2) view.end = null; }
    gDirty = true; drawLive();
  }
  (function () {
    var cv = $(".lt-chart canvas");
    if (!cv) return;
    var pts = {}, start = null;
    cv.style.touchAction = "none";
    cv.addEventListener("pointerdown", function (e) {
      cv.setPointerCapture(e.pointerId); pts[e.pointerId] = [e.clientX, e.clientY];
      var latest = H.t.length ? H.t[H.t.length - 1] : Date.now() / 1000;
      var ids = Object.keys(pts);
      start = { x: e.clientX, end: view.end == null ? latest : view.end, span: view.span, moved: false,
                d: ids.length === 2 ? Math.abs(pts[ids[0]][0] - pts[ids[1]][0]) : 0 };
    });
    cv.addEventListener("pointermove", function (e) {
      if (!start || !pts[e.pointerId]) return;
      pts[e.pointerId] = [e.clientX, e.clientY];
      var ids = Object.keys(pts), W = cv.clientWidth;
      if (ids.length === 2 && start.d > 10) {
        var d = Math.abs(pts[ids[0]][0] - pts[ids[1]][0]);
        view.span = Math.max(3, Math.min(gTotal(), start.span * start.d / Math.max(10, d)));
        start.moved = true;
      } else if (ids.length === 1 && Math.abs(e.clientX - start.x) > 5) {
        var latest = H.t.length ? H.t[H.t.length - 1] : Date.now() / 1000;
        var end = start.end - (e.clientX - start.x) * view.span / W;
        view.end = end >= latest - 0.2 ? null : Math.max((H.t[0] || end) + view.span * 0.2, end);
        start.moved = true;
      }
      gDirty = true; drawLive();
    });
    function up(e) {
      if (start && !start.moved && Object.keys(pts).length === 1) {  // a tap: that moment
        var r = cv.getBoundingClientRect(), latest = H.t.length ? H.t[H.t.length - 1] : Date.now() / 1000;
        var end = view.end == null ? latest : view.end;
        scrub = end - view.span * (1 - (e.clientX - r.left) / r.width);
        if (view.end == null) view.end = end;  // hold still while looking
        gDirty = true; drawLive();
      }
      delete pts[e.pointerId];
      if (!Object.keys(pts).length) start = null;
    }
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", function (e) { delete pts[e.pointerId]; start = null; });
    cv.addEventListener("wheel", function (e) { e.preventDefault(); var r = cv.getBoundingClientRect(); gZoom(e.deltaY > 0 ? 1.25 : 0.8, e.clientX - r.left); }, { passive: false });
    cv.addEventListener("dblclick", function () { view.end = null; scrub = null; gDirty = true; drawLive(); });
    root.addEventListener("click", function (e) {
      var b = e.target.closest(".ts-gctl [data-g]");
      if (!b) return;
      if (b.dataset.g === "in") gZoom(0.5); else if (b.dataset.g === "out") gZoom(2);
      else { view.end = null; scrub = null; gDirty = true; drawLive(); }
    });
  })();
  /* the numbers a tuner watches, in one row: TPS and the rest, with target AFR beside AFR */
  var READ = [["rpm", "RPM", 0], ["map", "MAP", 1], ["tps", "TPS", 1], ["afr", "AFR", 2], ["lambda_target", "Target", 2], ["ve", "VE", 1],
              ["ego_corr", "EGO", 1], ["advance", "Timing", 1], ["clt", "CLT", 0], ["iat", "IAT", 0], ["batt", "Batt", 1]];
  function drawRead() {
    var box = $(".ts-read");
    if (!box || !layout || !box.offsetParent) return;
    var list = READ.filter(function (r) { return layout.roles && layout.roles[r[0]]; });
    if (box.dataset.n !== String(list.length)) {
      box.dataset.n = list.length;
      box.innerHTML = list.map(function (r) {
        var u = r[0] === "afr" || r[0] === "lambda_target" ? "" : showU((layout.outputs[layout.roles[r[0]]] || {}).units);
        return '<span class="r-' + r[0] + '"><small>' + r[1] + '</small><b class="mono">–</b>' + (u && u.length < 5 ? "<i>" + esc(u) + "</i>" : "") + "</span>";
      }).join("") + (scrub != null ? "" : "");
    }
    list.forEach(function (r, i) { var el = box.children[i] && box.children[i].querySelector("b"); if (el) el.textContent = fmt(gaugeValue(r[0]), r[2]); });
    box.classList.toggle("past", scrub != null);
  }
  /* ---------------------------------------------------------------- dials: TunerStudio's round gauges */
  // each dial's range, warning and danger zones come from the ECU's own .ini, like TunerStudio's
  var DEF = { rpm: [0, 8000, "RPM", "Engine Speed", 0], map: [0, 250, "kPa", "Engine MAP", 0], afr: [10, 20, "AFR", "Air:Fuel Ratio", 2],
              clt: [-40, 120, "C", "Coolant", 0], tps: [0, 100, "%", "Throttle", 0], advance: [-10, 50, "deg", "Timing", 1], batt: [8, 18, "V", "Battery", 1],
              iat: [-40, 100, "C", "Intake Air", 0] };
  function gaugeFor(ch) {
    var gs = layout.gauges || {}, keys = Object.keys(gs), front = layout.front || [];
    var hit = front.filter(function (g) { return gs[g].ch === ch; })[0] || keys.filter(function (g) { return gs[g].ch === ch; })[0];
    return hit ? gs[hit] : null;
  }
  function dialCfg(role) {
    var ch = layout && layout.roles && layout.roles[role];
    if (!ch) return null;
    var g = gaugeFor(ch), d = DEF[role] || [0, 100, "", role, 1];
    var cfg = g ? Object.assign({}, g) : { ch: ch, title: d[3], units: (layout.outputs[ch] || {}).units || d[2], lo: d[0], hi: d[1], vd: d[4], ld: d[4] };
    if (role === "afr") { cfg.title = "Air:Fuel Ratio"; cfg.ch2 = layout.roles.lambda_target || null; }
    if (role === "rpm") cfg.title = "Engine Speed";
    if (role === "map") cfg.title = "Engine MAP";
    return showCfg(cfg);
  }
  // shown the way you read it: mixture as AFR, temperatures in °F
  function showCfg(g) {
    var o = (layout.outputs[g.ch] || {}), c = Object.assign({}, g), lam = /lambda/i.test(g.title + " " + g.ch) && g.hi < 3;
    var f = lam ? function (v) { return v == null ? v : v * STOICH; } : TEMP_F && (isC(g.units) || isC(o.units)) ? function (v) { return v == null ? v : v * 1.8 + 32; } : null;
    if (f) ["lo", "hi", "loD", "loW", "hiW", "hiD"].forEach(function (k) { if (c[k] != null && Math.abs(c[k]) < 900) c[k] = f(c[k]); });
    if (lam) { c.title = "Air:Fuel Ratio"; c.units = "AFR"; c.vd = 2; c.ld = 0; }
    else if (f) c.units = "°F";
    c.f = f;
    return c;
  }
  function frontDials() {
    var gs = layout.gauges || {}, list = (layout.front || []).map(function (g) {
      var c = showCfg(gs[g]);
      if (layout.roles && c.ch === layout.roles.afr) c.ch2 = layout.roles.lambda_target || null;  // target on the AFR gauge
      return c;
    });
    if (list.length) return list;
    return ["rpm", "clt", "tps", "map", "afr", "batt", "advance", "iat"].map(dialCfg).filter(Boolean);
  }
  var dialSets = {};
  function buildDials(host, cfgs) {
    host.innerHTML = cfgs.map(function (g, i) { return '<div class="ts-dial"><canvas data-dial="' + i + '" aria-label="' + esc(g.title) + '"></canvas></div>'; }).join("");
    return { host: host, cfgs: cfgs, cvs: $$("canvas", host), faces: [] };
  }
  function drawDials() {
    if (!layout) return;
    ["tune", "cluster"].forEach(function (name) {
      var host = $('[data-dials="' + name + '"]');
      if (!host || !host.offsetParent) return;
      var set = dialSets[name], key = STOICH + "|" + TEMP_F;
      if (!set || set.key !== key) {
        var cfgs = name === "tune" ? ["rpm", "map", "afr"].map(dialCfg).filter(Boolean) : frontDials();
        set = dialSets[name] = buildDials(host, cfgs); set.key = key;
      }
      set.cvs.forEach(function (cv, i) {
        var g = set.cfgs[i], raw = och[g.ch], v = raw == null ? null : g.f ? g.f(raw) : raw;
        var t2 = g.ch2 != null ? och[g.ch2] : null;
        if (t2 != null && t2 > 0 && t2 < 2) t2 *= STOICH;  // the target, as AFR
        set.faces[i] = dial(cv, g, v, set.faces[i], t2);
      });
    });
  }
  function nice(span) {
    var raw = span / 8, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }
  // a round gauge: metal bezel, white face, warning (yellow) and danger (red) arcs, labelled ticks, red needle
  function dial(cv, g, v, face, v2) {
    var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return face;
    var Wp = Math.round(W * dpr), Hp = Math.round(H * dpr);
    if (cv.width !== Wp || cv.height !== Hp) { cv.width = Wp; cv.height = Hp; face = null; }
    var S = Math.min(W, H), cx = W / 2, cy = H / 2, R = S / 2 - 1, A0 = Math.PI * 0.75, SW = Math.PI * 1.5;
    var lo = g.lo, hi = g.hi, ang = function (x) { return A0 + Math.max(0, Math.min(1, (x - lo) / (hi - lo))) * SW; };
    if (!face) {
      face = document.createElement("canvas"); face.width = Wp; face.height = Hp;
      var f = face.getContext("2d"); f.setTransform(dpr, 0, 0, dpr, 0, 0);
      var gr = f.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      gr.addColorStop(0, "#fdfdfd"); gr.addColorStop(0.5, "#a9a9a9"); gr.addColorStop(1, "#5e5e5e");
      f.fillStyle = gr; f.beginPath(); f.arc(cx, cy, R, 0, 7); f.fill();
      gr = f.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      gr.addColorStop(0, "#6a6a6a"); gr.addColorStop(1, "#f0f0f0");
      f.fillStyle = gr; f.beginPath(); f.arc(cx, cy, R * 0.93, 0, 7); f.fill();
      gr = f.createRadialGradient(cx, cy - R * 0.25, R * 0.1, cx, cy, R * 0.89);
      gr.addColorStop(0, "#ffffff"); gr.addColorStop(0.75, "#f4f4f4"); gr.addColorStop(1, "#d2d2d2");
      f.fillStyle = gr; f.beginPath(); f.arc(cx, cy, R * 0.89, 0, 7); f.fill();
      var band = function (a, b, col) {
        if (a == null || b == null) return;
        a = Math.max(lo, Math.min(hi, a)); b = Math.max(lo, Math.min(hi, b));
        if (b - a <= (hi - lo) * 0.002) return;
        f.strokeStyle = col; f.lineWidth = R * 0.1; f.beginPath(); f.arc(cx, cy, R * 0.76, ang(a), ang(b)); f.stroke();
      };
      band(lo, g.loD, "#ff1a00"); band(g.loD, g.loW, "#ffe600"); band(g.hiW, g.hiD, "#ffe600"); band(g.hiD, hi, "#ff1a00");
      var div = hi - lo >= 2000 && /rpm/i.test(g.units + g.title) ? 1000 : 1, step = nice(hi - lo), first = Math.ceil(lo / step - 1e-9) * step;
      f.strokeStyle = "#111"; f.fillStyle = "#111"; f.textAlign = "center"; f.textBaseline = "middle";
      f.font = "bold " + Math.max(8, R * 0.13).toFixed(1) + "px Arial, Helvetica, sans-serif";
      for (var x = first; x <= hi + step * 1e-6; x += step / 2) {
        var major = Math.abs(Math.round((x - first) / step) * step - (x - first)) < step * 1e-6, a = ang(x);
        f.lineWidth = major ? Math.max(1.5, R * 0.025) : 1;
        f.beginPath(); f.moveTo(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86);
        f.lineTo(cx + Math.cos(a) * R * (major ? 0.72 : 0.79), cy + Math.sin(a) * R * (major ? 0.72 : 0.79)); f.stroke();
        if (major) {
          var lab = x / div, txt = String(+lab.toFixed(Math.abs(step / div) < 1 ? (Math.abs(step / div) < 0.1 ? 2 : 1) : 0));
          f.fillText(txt, cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.62);
        }
      }
      f.font = "bold " + Math.max(8, R * 0.12).toFixed(1) + "px Arial, Helvetica, sans-serif";
      var title = g.title.replace(/\s+-\s.*$/, "");
      if (title.length > 16) title = title.replace(/^[^:]+:\s*/, "");
      f.fillText(title, cx, cy - R * 0.2, R * 0.95);
      if (div > 1) { f.font = Math.max(7, R * 0.09).toFixed(1) + "px Arial, Helvetica, sans-serif"; f.fillText("x1000", cx, cy - R * 0.36); }
      f.font = Math.max(8, R * 0.12).toFixed(1) + "px Arial, Helvetica, sans-serif";
      if (g.ch2 == null) f.fillText(g.units || "", cx, cy + R * 0.52);
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, Wp, Hp); ctx.drawImage(face, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#111"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold " + Math.max(10, R * 0.17).toFixed(1) + "px Arial, Helvetica, sans-serif";
    var two = g.ch2 != null;
    ctx.fillText(v == null ? "–" : fmt(v, g.vd || 0), cx - (two ? R * 0.22 : 0), cy + R * 0.34);
    if (two) {  // the target: its own colour, needle and number
      ctx.fillStyle = "#c08a00"; ctx.fillText(v2 == null ? "–" : fmt(v2, g.vd || 0), cx + R * 0.24, cy + R * 0.34);
      ctx.font = Math.max(7, R * 0.085).toFixed(1) + "px Arial, Helvetica, sans-serif";
      ctx.fillStyle = "#444"; ctx.fillText("actual", cx - R * 0.22, cy + R * 0.47); ctx.fillStyle = "#c08a00"; ctx.fillText("target", cx + R * 0.24, cy + R * 0.47);
      if (v2 != null) {
        var a2 = ang(v2), c2 = Math.cos(a2), s2 = Math.sin(a2), w2 = R * 0.035;
        ctx.fillStyle = "#ffb000"; ctx.strokeStyle = "#7a5600"; ctx.lineWidth = 0.8; ctx.beginPath();
        ctx.moveTo(cx + c2 * R * 0.86, cy + s2 * R * 0.86);
        ctx.lineTo(cx - s2 * w2 + c2 * R * 0.3, cy + c2 * w2 + s2 * R * 0.3);
        ctx.lineTo(cx + s2 * w2 + c2 * R * 0.3, cy - c2 * w2 + s2 * R * 0.3);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    if (v != null) {
      var an = ang(v), ca = Math.cos(an), sa = Math.sin(an), w = R * 0.045;
      ctx.fillStyle = "#e01010"; ctx.beginPath();
      ctx.moveTo(cx + ca * R * 0.84, cy + sa * R * 0.84);
      ctx.lineTo(cx - sa * w - ca * R * 0.16, cy + ca * w - sa * R * 0.16);
      ctx.lineTo(cx + sa * w - ca * R * 0.16, cy - ca * w - sa * R * 0.16);
      ctx.closePath(); ctx.fill();
    }
    var hub = ctx.createRadialGradient(cx - R * 0.03, cy - R * 0.04, R * 0.01, cx, cy, R * 0.12);
    hub.addColorStop(0, "#666"); hub.addColorStop(1, "#000");
    ctx.fillStyle = hub; ctx.beginPath(); ctx.arc(cx, cy, R * 0.11, 0, 7); ctx.fill();
    return face;
  }
  /* indicator lamps, from the project's front page */
  var lampsBuilt = false;
  function drawLamps() {
    var box = $(".ts-ind"), view = box && box.closest(".ts-view, [data-lv-panel]");
    if (!box || !layout || !view || view.hidden) return;
    var list = layout.indicators || [];
    if (!lampsBuilt) { box.innerHTML = list.map(function (x, i) { return '<span data-lamp="' + i + '"></span>'; }).join(""); lampsBuilt = true; }
    list.forEach(function (x, i) {
      var el = box.children[i], v = och[x.ch];
      if (!el) return;
      var on = v == null ? false : x.op === "!=" ? v != x.v : x.op === "==" ? v == x.v : x.op === ">" ? v > x.v : x.op === "<" ? v < x.v :
        x.op === ">=" ? v >= x.v : x.op === "<=" ? v <= x.v : !!v;
      var txt = on ? x.on : x.off || x.on;
      if (el.textContent !== txt) el.textContent = txt;
      el.style.background = on ? x.onBg : x.offBg; el.style.color = on ? x.onFg : x.offFg;
      el.classList.toggle("dim", v == null);
    });
  }

  /* ---------------------------------------------------------------- editing (both roles) */
  function step() { var c = layout.constants[curTable]; return Math.pow(10, -(c.digits == null ? 1 : c.digits)); }
  function requestChange(fn, note) {
    var t = tableDef(), vals = tables[curTable], cells = {};
    if (!t || !vals) return;
    if (!(layout.editable || {})[curTable]) { toast(title(curTable) + " can't be changed remotely: change it at the car in TunerStudio.", true); return; }
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
    var sg = e.target.closest("[data-setgo]");
    if (sg) {
      var li = sg.closest("[data-set]"), name = li.dataset.set, nv = parseFloat(li.querySelector("input").value);
      if (!(nv === nv)) { li.querySelector("input").focus(); return; }
      if (TEMP_F && isC(layout.constants[name].units)) nv = Math.round((nv - 32) / 1.8 * 100) / 100;  // typed in °F, the ECU wants °C
      var cells = { 0: nv };
      if (ROLE === "car") {
        var why = check(name, cells);
        if (why) { toast(why, true); return; }
        queue.push({ kind: "set", m: { table: name, cells: cells }, by: "driver" });
      } else { var id = ++reqN; pending[name + ":0"] = id; send({ t: "set", id: id, table: name, cells: cells }); toast("Sent: the driver approves settings changes."); }
      li.querySelector("input").value = "";
      return;
    }
    var tabb = e.target.closest("[data-view]");
    if (tabb) { showView(tabb.dataset.view); return; }
    var lt = e.target.closest("[data-lv-tab]");
    if (lt) { setTimeout(function () { if (lt.dataset.lvTab === "settings") renderSettings(); dialSets = {}; drawLive(); }, 0); }
    if (e.target.closest("[data-live-burn]")) {
      if (!confirm("Burn to the ECU? The changes become permanent (they survive turning the car off).")) return;
      if (ROLE === "car") queue.push({ kind: "burn", m: {} }); else send({ t: "burn", id: ++reqN });
      return;
    }
    if (e.target.closest("[data-live-undo]")) {
      if (ROLE === "car") queue.push({ kind: "undo", m: { by: "driver" } }); else send({ t: "undo", id: ++reqN });
      return;
    }
    var cb = e.target.closest(".lt-chg");
    if (cb) {
      var li2 = cb.parentNode, open = li2.classList.toggle("open"), box2 = li2.querySelector(".lt-chg-d");
      if (open && !box2) { box2 = document.createElement("div"); box2.className = "lt-chg-d"; box2.innerHTML = changeDetail(li2._m); li2.appendChild(box2); }
      return;
    }
    var cs = e.target.closest("[data-chg-show]");
    if (cs) {
      var m3 = cs.closest("li")._m;
      curTable = m3.table; sel = {}; Object.keys(m3.cells).forEach(function (k) { sel[k] = 1; });
      if ((layout.editable || {})[curTable] === "setting") showView("settings"); else { showView("tune"); var s3 = $("[data-table]"); if (s3) s3.value = curTable; renderTable(); }
      $(".lt-tablebox").scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    var gb = e.target.closest("[data-gadd]");
    if (gb) { pickGauge(); return; }
    gb = e.target.closest("[data-gdel]");
    if (gb) { extra = extra.filter(function (n) { return n !== gb.dataset.gdel; }); saveExtra(); drawGauges(); return; }
    gb = e.target.closest("[data-pick]");
    if (gb) { if (extra.indexOf(gb.dataset.pick) < 0) extra.push(gb.dataset.pick); saveExtra(); $(".lt-pick").hidden = true; drawGauges(); return; }
    if (e.target.closest("[data-pick-close]") || e.target.classList.contains("lt-pick")) { $(".lt-pick").hidden = true; return; }
    if (e.target.closest("[data-tpscal]")) { tpsNew = {}; $(".lt-tps").hidden = false; drawTps(); return; }
    if (e.target.closest("[data-tps-close]") || e.target.classList.contains("lt-tps")) { $(".lt-tps").hidden = true; return; }
    var tg = e.target.closest("[data-tps-grab]");
    if (tg) {
      if ((gaugeValue("rpm") || 0) > 50) { toast("Turn the engine off first (key on, engine off).", true); return; }
      var v = och.rawTps1Primary;
      if (!(v > 0.05 && v < 4.95)) { toast("The sensor reads " + fmt(v, 2) + " V: check it's connected.", true); return; }
      tpsNew[tg.dataset.tpsGrab] = Math.round(v * 200); drawTps(); return;
    }
    if (e.target.closest("[data-tps-save]")) {
      if (!(tpsNew.open - tpsNew.closed >= 100)) { toast("Wide open has to read well above closed (at least 0.5 V more). Grab them again.", true); return; }
      queue.push({ kind: "set", m: { table: "tpsMin", cells: { 0: tpsNew.closed }, note: "TPS calibration" }, by: "driver" });
      queue.push({ kind: "set", m: { table: "tpsMax", cells: { 0: tpsNew.open }, note: "TPS calibration" }, by: "driver" });
      queue.push({ kind: "done", fn: function () { toast("TPS calibrated. Burn to keep it."); drawTps(); } });
      $(".lt-tps").hidden = true; return;
    }
    if (e.target.closest("[data-connect]")) connectEcu(false);
    else if (e.target.closest("[data-sim]")) connectEcu(true);
    else if (e.target.closest("[data-disconnect]")) disconnectEcu();
    else if (e.target.closest("[data-copy-view]")) copy(location.origin + "/live/" + SID + "?k=" + encodeURIComponent(sess.view_key));
    else if (e.target.closest("[data-share-view]")) navigator.share({ title: "Live tuning", url: location.origin + "/live/" + SID + "?k=" + encodeURIComponent(sess.view_key) }).catch(function () { /* cancelled */ });
  });
  root.addEventListener("input", function (e) { if (e.target.matches(".lt-set input[type=search]")) renderSettings(); });
  root.addEventListener("change", function (e) {
    if (e.target.matches("[data-table]")) { curTable = e.target.value; sel = {}; renderTable(); }
    if (e.target.matches("[data-mode], [data-allow-burn]")) { pushState(); renderState(); }
    if (e.target.matches("[data-project]")) pickProject(e.target.files);
    if (e.target.matches("[data-files]")) pickProject(e.target.files);
    if (e.target.matches("[data-loadmsq]") && e.target.files[0]) {
      var f = e.target.files[0];
      if (!running) { toast("Connect the ECU first.", true); return; }
      f.text().then(function (t) { compareTune(t, f.name, true); });
      e.target.value = "";
    }
  });
  function showView(v) {
    $$("[data-view]").forEach(function (x) { x.classList.toggle("on", x.dataset.view === v); x.setAttribute("aria-selected", x.dataset.view === v ? "true" : "false"); });
    $$("[data-v]").forEach(function (x) { x.hidden = x.dataset.v !== v; });
    try { localStorage.setItem("msq.live.view", v); } catch (e) { /* ignore */ }
    if (v === "settings") renderSettings();
    if (v === "tune") renderTable();
    drawLive();
  }
  function copy(text) {
    (navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast("Link copied: send it to your tuner."); },
      function () { window.prompt("Copy this link", text); });
  }

  /* The project is remembered in this browser (the .ini and tune, in IndexedDB), so next time it's one click. */
  function idb(fn) {
    return new Promise(function (ok, no) {
      if (!window.indexedDB) return no(new Error("no IndexedDB"));
      var r = indexedDB.open("msq-live", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("p"); };
      r.onsuccess = function () { var tx = r.result.transaction("p", "readwrite"); fn(tx.objectStore("p"), ok, no); };
      r.onerror = function () { no(r.error); };
    });
  }
  function saveProject(p) { idb(function (st, ok) { st.put(p, "last").onsuccess = ok; }).catch(function () { /* private window */ }); }
  function lastProject() { return idb(function (st, ok) { var g = st.get("last"); g.onsuccess = function () { ok(g.result || null); }; g.onerror = function () { ok(null); }; }).catch(function () { return null; }); }
  function useLast(p) {
    var ini = new File([p.ini], "mainController.ini"), msq = p.msq ? new File([p.msq], p.msqName || "CurrentTune.msq") : null;
    return startSession({ ini: ini, msq: msq, msqText: p.msq || "" });
  }
  if (ROLE === "car") lastProject().then(function (p) {
    var li = $(".lt-last");
    if (!p || !li) return;
    li.hidden = false;
    $("[data-last]", li).textContent = "Use " + (p.name || "my project") + " (from " + new Date(p.at).toLocaleDateString() + ")";
    li.querySelector("[data-last]").onclick = function () { useLast(p).catch(function (e) { toast(e.message, true); }); };
    if (SID && !carFiles) carFiles = { last: p };  // a reload: the session can restart by itself
  });

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
      return ini.text().then(function (iniText) {
        var path = (ini.webkitRelativePath || "").split("/"), name = path.length > 2 ? path[0] : (msq ? msq.name.replace(/\.msq$/i, "") : "my project");
        saveProject({ ini: iniText, msq: msqText, msqName: msq ? msq.name : "", name: name, at: Date.now() });
        return startSession({ ini: ini, msq: msq, msqText: msqText });
      });
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
    li.innerHTML = '<button type="button" class="lt-chg"><span class="mono">' + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + "</span> " +
      esc(title(m.table)) + ": " + n + " cell" + (n === 1 ? "" : "s") + (m.note === "undo" ? " (undo)" : m.note === "load" ? " (tune loaded)" : "") +
      ' <small class="dim">by the ' + esc(m.by === "driver" ? "driver" : "tuner") + "</small> <span class=\"lt-chg-more\">▸</span></button>";
    li._m = m;
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 200) ul.removeChild(ul.lastChild);
  }
  // each cell of a change: where it is (RPM and load), from what to what
  function changeDetail(m) {
    var t = allDefs().filter(function (x) { return x.z === m.table; })[0], c = layout.constants[m.table] || {};
    var d = c.digits == null ? 1 : c.digits, xs = t && tables[t.x], ys = t && t.y && tables[t.y], C = xs ? xs.length : 1;
    var xu = t ? ((layout.constants[t.x] || {}).units || "") : "", yu = t && t.y ? ((layout.constants[t.y] || {}).units || "") : "";
    var rows = Object.keys(m.cells || {}).map(Number).sort(function (a, b) { return a - b; }).map(function (k) {
      var to = m.cells[k], from = m.was && m.was[k] != null ? +m.was[k] : null;
      var where = t ? (xs ? bin(showT(xs[k % C], xu)) + " " + esc(showU(xu)) : "") + (ys ? " · " + bin(showT(ys[Math.floor(k / C)], yu)) + " " + esc(showU(yu)) : "") : "value";
      var pct = from ? (to / from - 1) * 100 : null;
      return "<tr><td>" + where + "</td><td>" + (from == null ? "–" : fmt(from, d)) + "</td><td>→ <b>" + fmt(to, d) + "</b></td><td class=\"" + (from != null && to > from ? "up" : "dn") + "\">" +
        (pct == null || !isFinite(pct) ? "" : (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%") + "</td></tr>";
    });
    return '<table class="lt-chg-t"><thead><tr><th>Cell</th><th>Was</th><th>Now</th><th></th></tr></thead><tbody>' + rows.join("") + "</tbody></table>" +
      (t && m.table !== curTable ? "" : "") + '<button type="button" class="btn sm" data-chg-show="' + esc(m.table) + '">Show in the table</button>';
  }
  function renderShare() {
    var box = $(".lt-share");
    if (!box || !sess) return;
    box.hidden = false;
    $("[data-view-url]").textContent = location.origin + "/live/" + SID + "?k=" + sess.view_key;
    var sh = $("[data-share-view]"); if (sh) sh.hidden = !navigator.share;
  }
  function renderSettings() {
    var box = $(".lt-set ul"), q = ($(".lt-set input[type=search]") || {}).value || "";
    if (!box || !layout) return;
    var words = q.trim().toLowerCase().split(/\s+/).filter(Boolean), ed = layout.editable || {};
    var names = Object.keys(ed).filter(function (n) { return ed[n] === "setting" && tables[n]; });
    var rows = names.map(function (n) { return [n, layout.constants[n].label || n]; })
      .filter(function (r) { var s = (r[1] + " " + r[0]).toLowerCase(); return words.every(function (w) { return s.indexOf(w) >= 0; }); })
      .sort(function (a, b) { return a[1].localeCompare(b[1]); }).slice(0, 60);
    box.innerHTML = rows.map(function (r) {
      var c = layout.constants[r[0]], v = showT(tables[r[0]][0], c.units);
      var lo = c.lo != null ? +showT(c.lo, c.units).toFixed(1) : null, hi = c.hi != null ? +showT(c.hi, c.units).toFixed(1) : null;
      return '<li data-set="' + esc(r[0]) + '"><span><b>' + esc(r[1]) + '</b> <small class="dim">' + esc(r[0]) + (c.units ? " · " + esc(showU(c.units)) : "") +
        (lo != null ? " · " + lo + " to " + hi : "") + '</small></span><b class="mono">' + fmt(v, c.digits == null ? 2 : c.digits) + "</b>" +
        '<input type="text" inputmode="decimal" aria-label="New value"><button class="btn sm" type="button" data-setgo>Set</button></li>';
    }).join("") || '<li class="dim">' + (names.length ? "No setting matches." : "Waiting for the tune from the ECU…") + "</li>";
  }
  function renderAll() { renderTablePicker(); renderTable(); renderState(); drawLive(); renderSettings(); }

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
  (function () { var v = null; try { v = localStorage.getItem("msq.live.view"); } catch (e) { /* ignore */ } if (v && v !== "tune" && $('[data-view="' + v + '"]')) showView(v); })();
  window.addEventListener("resize", function () { renderTable(); dialSets = {}; drawLive(); });
  window.addEventListener("beforeunload", function (e) { if (ROLE === "car" && running) { e.preventDefault(); e.returnValue = ""; } });
})();
