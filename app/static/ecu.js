/* Talking to an ECU the way TunerStudio does, driven by the ECU's own definition (.ini, via /live/start):
   the msEnvelope_1.0 framing (2-byte big-endian length, payload, CRC32 big-endian), the .ini's command
   templates (pageReadCommand "R%2o%2c", pageChunkWrite "C%2o%2c%v", ochGetCommand "O%2o%2c", burnCommand
   "B", queryCommand "S"), and its constants and output channels (type, offset, scale, translate).

   Two ways in, same bytes: Web Serial (Chrome / Edge on a computer, the ECU's USB port) and a simulated ECU
   for trying it without a car (it runs a small engine model that answers the VE table like a real one).
   Used as window.ECU in the browser and from node in tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ECU = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Run f soon, as its own task: always yields to the page (unlike a promise), and isn't slowed in a background
     tab (unlike a timer, which Chrome holds to about once a second there). */
  var soon = (function () {
    if (typeof MessageChannel === "undefined") return function (f) { setTimeout(f, 0); };
    var ch = new MessageChannel(), q = [];
    ch.port1.onmessage = function () { var f = q.shift(); if (f) f(); };
    if (ch.port1.unref) ch.port1.unref();  // node (tests): don't keep the process alive
    return function (f) { q.push(f); ch.port2.postMessage(0); };
  })();

  /* ---------- CRC32 (zlib) ---------- */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function frame(payload) {
    var out = new Uint8Array(payload.length + 6), dv = new DataView(out.buffer);
    dv.setUint16(0, payload.length, false);
    out.set(payload, 2);
    dv.setUint32(2 + payload.length, crc32(payload), false);
    return out;
  }

  /* ---------- command templates ---------- */
  function template(str) {  // '"R%2o%2c"' -> [{lit: [82]}, {n:2,k:"o"}, {n:2,k:"c"}]
    var s = String(str || "").replace(/^"|"$/g, ""), parts = [], lit = [], i = 0;
    while (i < s.length) {
      var hx = /^\\x([0-9a-fA-F]{2})/.exec(s.slice(i));
      if (hx) { lit.push(parseInt(hx[1], 16)); i += 4; continue; }
      var ph = s[i] === "%" ? /^%(\d?)([a-z])/.exec(s.slice(i)) : null;
      if (ph) {
        if (lit.length) { parts.push({ lit: lit }); lit = []; }
        parts.push({ n: +(ph[1] || 1), k: ph[2] }); i += ph[0].length; continue;
      }
      lit.push(s.charCodeAt(i) & 0xFF); i++;
    }
    if (lit.length) parts.push({ lit: lit });
    return parts;
  }
  function build(tpl, args, little) {  // args: {o: offset, c: count, v: Uint8Array, i: page id bytes}
    var out = [];
    template(tpl).forEach(function (p) {
      if (p.lit) { out.push.apply(out, p.lit); return; }
      if (p.k === "v") { out.push.apply(out, Array.prototype.slice.call(args.v || [])); return; }
      if (p.k === "i") { out.push.apply(out, args.i || []); return; }
      var val = p.k === "o" ? args.o : p.k === "c" ? args.c : 0;
      for (var b = 0; b < p.n; b++) out.push(little ? (val >> (8 * b)) & 0xFF : (val >> (8 * (p.n - 1 - b))) & 0xFF);
    });
    return new Uint8Array(out);
  }

  /* ---------- values ---------- */
  var SIZE = { U08: 1, S08: 1, U16: 2, S16: 2, U32: 4, S32: 4, F32: 4 };
  var RANGE = { U08: [0, 255], S08: [-128, 127], U16: [0, 65535], S16: [-32768, 32767], U32: [0, 4294967295], S32: [-2147483648, 2147483647] };
  function readRaw(dv, type, off, little) {
    switch (type) {
      case "U08": return dv.getUint8(off); case "S08": return dv.getInt8(off);
      case "U16": return dv.getUint16(off, little); case "S16": return dv.getInt16(off, little);
      case "U32": return dv.getUint32(off, little); case "S32": return dv.getInt32(off, little);
      default: return dv.getFloat32(off, little);
    }
  }
  function writeRaw(dv, type, off, raw, little) {
    switch (type) {
      case "U08": dv.setUint8(off, raw); break; case "S08": dv.setInt8(off, raw); break;
      case "U16": dv.setUint16(off, raw, little); break; case "S16": dv.setInt16(off, raw, little); break;
      case "U32": dv.setUint32(off, raw, little); break; case "S32": dv.setInt32(off, raw, little); break;
      default: dv.setFloat32(off, raw, little);
    }
  }
  function value(c, dv, off, little) {  // userValue = (raw + translate) * scale
    var raw = readRaw(dv, c.type, off, little);
    if (c.kind === "bits") return (raw >>> c.bits[0]) & ((1 << (c.bits[1] - c.bits[0] + 1)) - 1);
    return (raw + (c.translate || 0)) * (c.scale == null ? 1 : c.scale);
  }
  function rawFor(c, v) {  // raw = value / scale - translate, rounded and kept inside the type and the range
    if (c.lo != null && v < c.lo) v = c.lo;
    if (c.hi != null && v > c.hi) v = c.hi;
    var raw = v / (c.scale || 1) - (c.translate || 0);
    if (c.type === "F32") return raw;
    raw = Math.round(raw);
    var r = RANGE[c.type];
    return Math.max(r[0], Math.min(r[1], raw));
  }
  function count(c) { return c.kind === "array" ? c.rows * c.cols : 1; }

  /* ---------- the framed link, over any byte pipe {write(Uint8Array), onData(cb)} ---------- */
  function Link(pipe, timeoutMs) {
    var buf = new Uint8Array(0), waiting = null, chain = Promise.resolve();
    pipe.onData(function (chunk) {
      var b = new Uint8Array(buf.length + chunk.length); b.set(buf); b.set(chunk, buf.length); buf = b;
      if (waiting) waiting();
    });
    function readFrame() {
      return new Promise(function (ok, fail) {
        var t = setTimeout(function () { waiting = null; fail(new Error("The ECU didn't answer.")); }, timeoutMs || 3000);
        function check() {
          if (buf.length < 2) return;
          var n = (buf[0] << 8) | buf[1];
          if (buf.length < n + 6) return;
          var payload = buf.slice(2, 2 + n), got = new DataView(buf.buffer, buf.byteOffset + 2 + n, 4).getUint32(0, false);
          buf = buf.slice(n + 6);
          clearTimeout(t); waiting = null;
          if (got !== crc32(payload)) return fail(new Error("The reply from the ECU was garbled (CRC)."));
          ok(payload);
        }
        waiting = check; check();
      });
    }
    /* one request at a time, in order: -> the reply's payload (status byte first) */
    this.ask = function (payload) {
      var run = function () { buf = new Uint8Array(0); return pipe.write(frame(payload)).then(readFrame); };
      var p = chain.then(run, run);
      chain = p.catch(function () { /* the next one still runs */ });
      return p;
    };
  }

  /* ---------- an ECU, described by the layout from /live/start ---------- */
  function Ecu(link, layout) {
    var c = layout.comms, little = (c.endianness || "little") !== "big", self = this;
    var block = Math.max(16, c.blockingFactor || 256);
    this.layout = layout; this.little = little;
    this.pageSize = (c.pageSizes || [0])[0];
    function ok(p, what) {
      if (!p.length) throw new Error(what + ": empty reply");
      if (p[0] >= 0x80) throw new Error(what + " failed (ECU code 0x" + p[0].toString(16) + ")");
      return p.subarray(1);
    }
    this.signature = function () {
      return link.ask(build(c.queryCommand || "S", {}, little)).then(function (p) {
        var d = p[0] === 0 ? p.subarray(1) : p;
        return String.fromCharCode.apply(null, Array.prototype.slice.call(d)).replace(/\0+$/, "");
      });
    };
    this.read = function (offset, n) {  // bytes of the settings page, in blocks
      var out = new Uint8Array(n), at = 0;
      function next() {
        if (at >= n) return Promise.resolve(out);
        var k = Math.min(block, n - at);
        return link.ask(build(c.pageReadCommand, { o: offset + at, c: k }, little)).then(function (p) {
          var d = ok(p, "Reading the tune");
          out.set(d.subarray(0, k), at); at += k; return next();
        });
      }
      return next();
    };
    this.readPage = function (progress) {
      var n = self.pageSize, out = new Uint8Array(n), at = 0;
      function next() {
        if (at >= n) return Promise.resolve(out);
        var k = Math.min(block, n - at);
        return self.read(at, k).then(function (d) { out.set(d, at); at += k; if (progress) progress(at / n); return next(); });
      }
      return next();
    };
    this.write = function (offset, bytes) {
      var at = 0;
      function next() {
        if (at >= bytes.length) return Promise.resolve();
        var k = Math.min(block, bytes.length - at);
        return link.ask(build(c.pageChunkWrite, { o: offset + at, c: k, v: bytes.subarray(at, at + k) }, little))
          .then(function (p) { ok(p, "Writing to the ECU"); at += k; return next(); });
      }
      return next();
    };
    this.burn = function () { return link.ask(build(c.burnCommand || "B", {}, little)).then(function (p) { ok(p, "Burning"); }); };
    this.och = function () {
      return link.ask(build(c.ochGetCommand, { o: 0, c: c.ochBlockSize }, little)).then(function (p) { return ok(p, "Reading live data"); });
    };
  }

  /* Decode every constant in the layout from the page, and the live channels from an output block. */
  function decodeConstants(layout, page, little) {
    var dv = new DataView(page.buffer, page.byteOffset, page.byteLength), out = {};
    Object.keys(layout.constants).forEach(function (name) {
      var c = layout.constants[name], n = count(c), sz = SIZE[c.type], vals = [];
      if (c.offset + n * sz > page.length) return;
      for (var i = 0; i < n; i++) vals.push(value(c, dv, c.offset + i * sz, little));
      out[name] = vals;
    });
    return out;
  }
  function decodeOutputs(layout, block, little) {
    var dv = new DataView(block.buffer, block.byteOffset, block.byteLength), out = {};
    Object.keys(layout.outputs).forEach(function (name) {
      var o = layout.outputs[name];
      if (o.offset + SIZE[o.type] > block.length) return;
      var v = value(o, dv, o.offset, little);
      if (v === v && isFinite(v)) out[name] = Math.round(v * 1e4) / 1e4;
    });
    return out;
  }
  /* The bytes that put `values` (index -> number) into constant c: -> [{offset, bytes, raw}] runs */
  function encodeCells(c, cells, little) {
    var sz = SIZE[c.type], ks = Object.keys(cells).map(Number).sort(function (a, b) { return a - b; }), runs = [];
    ks.forEach(function (k) {
      var b = new Uint8Array(sz), dv = new DataView(b.buffer);
      writeRaw(dv, c.type, 0, rawFor(c, cells[k]), little);
      var off = c.offset + k * sz, last = runs[runs.length - 1];
      if (last && last.offset + last.bytes.length === off) {
        var nb = new Uint8Array(last.bytes.length + sz); nb.set(last.bytes); nb.set(b, last.bytes.length); last.bytes = nb;
      } else runs.push({ offset: off, bytes: b });
    });
    return runs;
  }

  /* ---------- Web Serial ---------- */
  function serialPipe(port) {
    var listeners = [], reader = null, writer = port.writable.getWriter(), stopped = false, dead = false;
    (function pump() {
      reader = port.readable.getReader();
      (function loop() {
        reader.read().then(function (r) {
          if (r.done || stopped) { dead = true; return; }
          listeners.forEach(function (f) { f(r.value); });
          loop();
        }, function () { dead = true; });  // unplugged, or the ECU reset its USB
      })();
    })();
    return {
      port: port,
      isDead: function () { return dead; },
      write: function (b) { return dead ? Promise.reject(new Error("The USB link to the ECU dropped.")) : writer.write(b); },
      onData: function (f) { listeners.push(f); },
      close: function () {
        stopped = true;
        try { reader.cancel(); } catch (e) { /* ignore */ }
        try { reader.releaseLock(); writer.releaseLock(); } catch (e) { /* ignore */ }
        return port.close().catch(function () { /* ignore */ });
      }
    };
  }
  function openPort(port) {
    return port.open({ baudRate: 115200 }).then(function () { return serialPipe(port); }, function (e) {
      if (e && /open|busy|access|use/i.test(e.message || "")) {
        throw new Error("The ECU's port is in use: close TunerStudio (or anything else connected to the ECU) and try again.");
      }
      throw e;
    });
  }
  function connectSerial() {
    if (!("serial" in navigator)) return Promise.reject(new Error("This browser can't reach USB devices. Use Chrome or Edge on a computer."));
    return navigator.serial.requestPort({}).then(openPort);
  }
  /* The ports this site was allowed before (TunerStudio's "remember this ECU"): Chrome hands them back
     without asking, so a known ECU is opened the moment it's plugged in. The one last used comes first.
     -> [port] */
  function grantedPorts(known) {
    if (!("serial" in navigator) || !navigator.serial.getPorts) return Promise.resolve([]);
    return navigator.serial.getPorts().then(function (ports) {
      var same = function (p) { var i = p.getInfo ? p.getInfo() : {}; return known && i.usbVendorId === known.usbVendorId && i.usbProductId === known.usbProductId; };
      return ports.filter(same).concat(ports.filter(function (p) { return !same(p); }));
    }, function () { return []; });
  }
  /* After the USB link drops (the ECU reset while cranking, a loose cable): open the same device again
     without asking, once it's back. -> a new pipe, or null if it isn't there yet. */
  function reopenSerial(old) {
    var info = old && old.getInfo ? old.getInfo() : {};
    return navigator.serial.getPorts().then(function (ports) {
      var same = ports.filter(function (p) { var i = p.getInfo(); return i.usbVendorId === info.usbVendorId && i.usbProductId === info.usbProductId; });
      var port = same.indexOf(old) >= 0 ? old : same[0];
      if (!port) return null;
      var closed = port.readable ? port.close().catch(function () { /* already closed */ }) : Promise.resolve();
      return closed.then(function () { return openPort(port); }).catch(function () { return null; });
    });
  }

  /* ---------- a simulated ECU (the same bytes over a fake wire) ---------- */
  function simPipe(layout, startPage) {
    var little = (layout.comms.endianness || "little") !== "big", listeners = [];
    var page = startPage ? new Uint8Array(startPage) : new Uint8Array(layout.comms.pageSizes[0]);
    var och = new Uint8Array(layout.comms.ochBlockSize), odv = new DataView(och.buffer), t0 = Date.now();
    var outs = layout.outputs, roles = layout.roles || {};
    var cmds = {};
    ["queryCommand", "pageReadCommand", "pageChunkWrite", "burnCommand", "ochGetCommand"].forEach(function (k) {
      if (layout.comms[k]) cmds[k] = template(layout.comms[k]);
    });
    function lead(tpl) { return tpl && tpl[0] && tpl[0].lit ? tpl[0].lit[0] : -1; }
    function setOut(name, v) {
      var o = outs[name];
      if (!o || o.offset + SIZE[o.type] > och.length) return;
      if (o.kind === "bits") {  // a flag: set or clear its bits in the word
        var w = readRaw(odv, o.type, o.offset, little) >>> 0, lo = o.bits[0], width = o.bits[1] - lo + 1, mask = ((1 << width) - 1) << lo;
        writeRaw(odv, o.type, o.offset, ((w & ~mask) | ((Math.round(v) << lo) & mask)) >>> 0, little);
        return;
      }
      var raw = v / (o.scale || 1) - (o.translate || 0);
      writeRaw(odv, o.type, o.offset, o.type === "F32" ? raw : Math.round(Math.max(RANGE[o.type][0], Math.min(RANGE[o.type][1], raw))), little);
    }
    function table(zname) { return (layout.tables || []).filter(function (t) { return t.z === zname; })[0]; }
    var base = new Uint8Array(page);  // the tune as it started: the simulated engine's real needs are based on it
    function interp(t, x, y, src) {
      var c = decodeConstants({ constants: { a: layout.constants[t.x], b: layout.constants[t.y], z: layout.constants[t.z] } }, src || page, little);
      if (!c.a || !c.b || !c.z) return NaN;
      var loc = function (bins, v) {
        if (v <= bins[0]) return [0, 0];
        for (var i = 0; i < bins.length - 1; i++) if (v < bins[i + 1]) return [i, (v - bins[i]) / ((bins[i + 1] - bins[i]) || 1)];
        return [bins.length - 2, 1];
      };
      var a = loc(c.a, x), b = loc(c.b, y), C = c.a.length, z = c.z;
      var at = function (r, cc) { return z[r * C + cc]; };
      return (at(b[0], a[0]) * (1 - a[1]) + at(b[0], a[0] + 1) * a[1]) * (1 - b[1]) + (at(b[0] + 1, a[0]) * (1 - a[1]) + at(b[0] + 1, a[0] + 1) * a[1]) * b[1];
    }
    function engine() {  // a car being driven: what the ECU would report right now
      var s = (Date.now() - t0) / 1000;
      var rpm = 1700 + 1500 * Math.sin(s / 6) + 900 * Math.sin(s / 2.3), load = 55 + 35 * Math.sin(s / 4.1 + 1) + 8 * Math.sin(s * 1.7);
      rpm = Math.max(800, rpm); load = Math.max(20, Math.min(160, load));
      var ve = table("veTable"), lam = table("lambdaTable") || table("afrTable"), ign = table("ignitionTable");
      var veCmd = ve ? interp(ve, rpm, load) : 80;
      // what this engine really needs: the starting tune, 7% off either way across the map (so there's tuning to do,
      // and every VE change moves the AFR the way it would on a real engine)
      var veTrue = ve ? interp(ve, rpm, load, base) * (1 + 0.07 * Math.sin(rpm / 700) * Math.cos(load / 35)) : 80;
      if (!(veTrue > 1)) veTrue = 60 + rpm / 200 + load / 6;
      var tgt = lam ? interp(lam, rpm, load) : 14.7;
      if (tgt < 2) tgt *= 14.7;
      var afr = tgt * (veTrue / (veCmd || veTrue)) * (1 + 0.006 * Math.sin(s * 9));
      Object.keys(outs).forEach(function (n) {
        var lbl = (outs[n].label || n).toLowerCase();
        if (n === roles.rpm || lbl === "rpm") setOut(n, rpm);
        else if (n === roles.map || lbl === "map") setOut(n, load);
        else if (n === roles.tps) setOut(n, Math.max(0, (load - 25) * 0.8));
        else if (n === roles.afr || lbl === "afr") setOut(n, afr);
        else if (n === roles.lambda) setOut(n, afr / 14.7);
        else if (n === roles.lambda_target) setOut(n, outs[n].units && /afr|ratio/i.test(outs[n].units) ? tgt : tgt / 14.7);
        else if (n === roles.clt) setOut(n, 88 + Math.sin(s / 30));
        else if (n === roles.iat) setOut(n, 32 + 4 * Math.sin(s / 50));
        else if (n === roles.batt) setOut(n, 14.1);
        else if (n === roles.ve) setOut(n, veCmd);
        else if (n === roles.advance) setOut(n, ign ? interp(ign, rpm, load) : 20);
        else if (n === roles.pw) setOut(n, 1.2 + veCmd * load / 1600);  // injector pulse width, ms
        else if (n === roles.inj_duty) setOut(n, (1.2 + veCmd * load / 1600) * rpm / 1200);
        else if (/target\s*afr/.test(lbl)) setOut(n, tgt);
        else if (n === roles.lambda_ok || /lambdacurrentlygood/i.test(n)) setOut(n, 1);  // the wideband is warmed up
      });
      var roleCh = {};
      Object.keys(roles).forEach(function (r) { roleCh[roles[r]] = 1; });
      (layout.tables || []).forEach(function (t) {  // the channels that move each table's cursor (not ones read as gauges)
        if (t.xch && !roleCh[t.xch]) setOut(t.xch, /rpm/i.test(t.xch) || (layout.constants[t.x] || {}).units === "RPM" ? rpm : load);
        if (t.ych && !roleCh[t.ych] && !/rpm/i.test(t.ych)) setOut(t.ych, load);
      });
    }
    function reply(payload) {
      var out = frame(payload);
      var deliver = function () { listeners.forEach(function (f) { f(out); }); };
      // a USB round trip of a few ms; but a timer in a background tab is slowed to ~1/s by the browser, which real
      // USB isn't, so there the reply comes straight back instead
      if (typeof document !== "undefined" && document.hidden) soon(deliver);
      else setTimeout(deliver, 2 + Math.random() * 3);
    }
    function u16(b, at) { return little ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]; }
    function handle(req) {
      var op = req[0];
      if (op === lead(cmds.queryCommand)) {
        var sig = layout.comms.signature || "SIM", b = new Uint8Array(sig.length + 1);
        for (var i = 0; i < sig.length; i++) b[i + 1] = sig.charCodeAt(i);
        return reply(b);
      }
      if (op === lead(cmds.ochGetCommand)) {
        engine();
        var o = u16(req, 1), n = u16(req, 3), r = new Uint8Array(n + 1); r.set(och.subarray(o, o + n), 1); return reply(r);
      }
      if (op === lead(cmds.pageReadCommand)) {
        var off = u16(req, 1), cnt = u16(req, 3), rr = new Uint8Array(cnt + 1); rr.set(page.subarray(off, off + cnt), 1); return reply(rr);
      }
      if (op === lead(cmds.pageChunkWrite)) {
        var wo = u16(req, 1), wc = u16(req, 3); page.set(req.subarray(5, 5 + wc), wo); return reply(new Uint8Array([0]));
      }
      if (op === lead(cmds.burnCommand)) return reply(new Uint8Array([4]));
      reply(new Uint8Array([0x83]));
    }
    var inbuf = new Uint8Array(0);
    return {
      page: page,
      write: function (b) {
        var nb = new Uint8Array(inbuf.length + b.length); nb.set(inbuf); nb.set(b, inbuf.length); inbuf = nb;
        while (inbuf.length >= 2) {
          var n = (inbuf[0] << 8) | inbuf[1];
          if (inbuf.length < n + 6) break;
          var payload = inbuf.slice(2, 2 + n), crc = new DataView(inbuf.buffer, inbuf.byteOffset + 2 + n, 4).getUint32(0, false);
          inbuf = inbuf.slice(n + 6);
          if (crc === crc32(payload)) handle(payload); else reply(new Uint8Array([0x82]));
        }
        return Promise.resolve();
      },
      onData: function (f) { listeners.push(f); },
      close: function () { return Promise.resolve(); }
    };
  }
  /* A settings page with the tune's values in it (for the simulator): msq constants -> bytes. */
  function pageFromMsq(layout, msqText) {
    var little = (layout.comms.endianness || "little") !== "big", page = new Uint8Array(layout.comms.pageSizes[0]), dv = new DataView(page.buffer);
    var doc = new DOMParser().parseFromString(msqText, "application/xml");
    Array.prototype.forEach.call(doc.getElementsByTagName("constant"), function (el) {
      var c = layout.constants[el.getAttribute("name")];
      if (!c) return;
      var vals = el.textContent.trim().split(/\s+/).map(Number);
      vals.forEach(function (v, i) {
        if (i < count(c) && v === v) writeRaw(dv, c.type, c.offset + i * SIZE[c.type], rawFor(c, v), little);
      });
    });
    return page;
  }

  /* What a remote change may do (the car page applies this to every request). -> null, or why not. */
  function checkChange(layout, tables, table, cells, STOICH, title, limits) {
    STOICH = STOICH || 14.7;
    title = title || function (n) { return n; };
    var tableDef = function (z) { return (layout.tables || []).concat(layout.curves || []).filter(function (t) { return t.z === z; })[0]; };
    var c = layout.constants[table], vals = tables[table], kind = (layout.editable || {})[table];
    if (!c || !vals || !kind) return title(table) + " can't be changed remotely (it needs a power cycle, or it sets how the engine is wired or protected): change it at the car in TunerStudio.";
    var ks = Object.keys(cells || {});
    if (!ks.length || ks.length > 64) return "Change between 1 and 64 cells at a time.";
    var nm = table + " " + (c.units || ""), ign = /ign|timing|advance|spark/i.test(table) && /deg/i.test(c.units || "");
    var ve = /ve/i.test(table) && c.units === "%", afr = /lambda|afr/i.test(nm) && kind === "table";
    var toAfr = /lambda/i.test(c.units || "") ? STOICH : 1, def = tableDef(table), loads = def && def.y ? tables[def.y] : null;
    var start = limits && limits.base && limits.base[table];
    for (var i = 0; i < ks.length; i++) {
      var k = +ks[i], v = +cells[ks[i]], old = vals[k], was = start ? start[k] : null;
      if (was != null && was === was && kind !== "setting") {  // how far from what the ECU had when the session started
        if (ign && limits.maxDeg != null && v - was > limits.maxDeg + 1e-9)
          return "That's more than " + limits.maxDeg + "° above what " + title(table) + " had at the start of the session (" + was + "°). The driver can raise the limit.";
        if (!ign && !afr && limits.maxPct != null && Math.abs(was) > 1e-9 && Math.abs(v / was - 1) * 100 > limits.maxPct + 1e-6)
          return "That's more than " + limits.maxPct + "% away from what " + title(table) + " had at the start of the session (" + was + " → " + v + "). The driver can raise the limit.";
      }
      if (!(k >= 0 && k < vals.length) || !(v === v)) return "That cell isn't in " + title(table) + ".";
      if ((c.lo != null && v < c.lo - 1e-9) || (c.hi != null && v > c.hi + 1e-9)) return title(table) + " must stay between " + c.lo + " and " + c.hi + ".";
      if (afr) {
        var a = v * toAfr, ao = old * toAfr, load = loads ? loads[Math.floor(k / tables[def.x].length)] : 0;
        if (a < 10 || a > 18) return "Target AFR has to stay between 10.0 and 18.0.";
        if (Math.abs(a - ao) > 1.0 + 1e-9) return "More than 1.0 AFR in one step on the target. Make it in smaller steps.";
        if (load > 100 && a > 15.0) return "No leaner than 15.0 AFR in boost (above 100 kPa).";
        continue;
      }
      if (ign && v - old > 5 + 1e-9) return "More than 5° more timing in one step. Add it in smaller steps.";
      if (/rpm.*limit|revlimit|launchrpm/i.test(table)) {  // the rev limiter: 500 RPM at a time, never below 1500
        if (Math.abs(v - old) > 500 + 1e-9) return "Move the rev limit 500 RPM at a time at most.";
        if (v < 1500) return "The rev limit can't go below 1500 RPM.";
        continue;
      }
      if (ve && old > 0 && Math.abs(v / old - 1) > 0.25) return "More than 25% in one step on " + title(table) + ". Make it in smaller steps.";
      if (!ign && !ve) {
        var span = c.lo != null && c.hi != null ? c.hi - c.lo : Math.abs(old) || 1;
        if (Math.abs(old) > 1e-9 ? Math.abs(v / old - 1) > 0.25 && Math.abs(v - old) > span * 0.02 : Math.abs(v - old) > span * 0.1)
          return "That's a big jump for " + title(table) + " (more than 25%). Make it in smaller steps.";
      }
    }
    return null;
  }

  return { crc32: crc32, frame: frame, template: template, build: build, Link: Link, Ecu: Ecu, decodeConstants: decodeConstants,
           decodeOutputs: decodeOutputs, encodeCells: encodeCells, rawFor: rawFor, count: count, SIZE: SIZE,
           soon: soon, checkChange: checkChange, connectSerial: connectSerial, reopenSerial: reopenSerial, grantedPorts: grantedPorts, openPort: openPort, simPipe: simPipe, pageFromMsq: pageFromMsq };
});
