/* The difference report (TunerStudio's): what's burned in the ECU against this app's copy of the tune, setting
   by setting and cell by cell, so the driver can keep the ECU's or write the app's into it, per item or all.
   Pure logic, no page: the live page draws it, tests/js/tunediff.test.js checks it. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TuneDiff = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var SIZE = { U08: 1, S08: 1, U16: 2, S16: 2, U32: 4, S32: 4, F32: 4 };
  function count(c) { return c.kind === "array" ? (c.rows || 1) * (c.cols || 1) : 1; }
  function unq(s) { return String(s).trim().replace(/^"|"$/g, ""); }
  function unxml(s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }

  /* The values of a .msq, for the constants the ECU layout has, in the units the ECU's are decoded in.
     An option (bits) setting is its option's number, like the ECU holds it. -> {name: [numbers]} */
  function msqValues(text, layout) {
    var out = {}, re = /<constant\b([^>]*)>([\s\S]*?)<\/constant>/g, m;
    while ((m = re.exec(text || ""))) {
      var nm = /\bname="([^"]*)"/.exec(m[1]), name = nm && nm[1], c = name && layout.constants[name];
      if (!c) continue;
      var body = unxml(m[2]).trim(), vals;
      if (c.kind === "bits") {
        var opt = unq(body), k = (c.options || []).map(unq).indexOf(opt);
        vals = [k >= 0 ? k : /^-?\d+$/.test(opt) ? +opt : NaN];
      } else vals = body.split(/\s+/).map(function (x) { return Number(unq(x)); });
      if (vals.length === count(c) && vals.every(function (v) { return v === v; })) out[name] = vals;
    }
    return out;
  }

  /* Constants that are two names for the same ECU memory can't be told apart: left out (option settings
     packed in one word, each in its own bits, are fine). */
  function sharedMem(layout) {
    var list = Object.keys(layout.constants).map(function (n) {
      var c = layout.constants[n];
      return { n: n, c: c, a: c.offset, b: c.offset + count(c) * (SIZE[c.type] || 1) };
    }).sort(function (x, y) { return x.a - y.a; });
    var shared = {};
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length && list[j].a < list[i].b; j++) {
        var p = list[i], q = list[j];
        if (p.c.kind === "bits" && q.c.kind === "bits" && p.a === q.a && p.c.type === q.c.type &&
            (p.c.bits[1] < q.c.bits[0] || q.c.bits[1] < p.c.bits[0])) continue;
        shared[p.n] = 1; shared[q.n] = 1;
      }
    }
    return shared;
  }

  // the smallest step a value can really differ by: the ECU's own resolution and the decimals shown
  function tolerance(c) {
    if (c.kind === "bits") return 0.5;
    // a float holds any value: only an integer type's scale is a step it can't go below
    return Math.pow(10, -(c.digits == null ? 2 : c.digits)) * 0.6 + (c.type === "F32" ? 0 : Math.abs(c.scale || 0) * 0.51);
  }

  /* -> [{name, kind: "table"|"curve"|"setting", cells: [{i, ecu, app}]}], tables and curves first, then settings;
     only what the ECU and the app's tune both have. */
  function diff(layout, ecuTables, appVals) {
    var sh = sharedMem(layout), kindOf = {}, out = [];
    (layout.tables || []).forEach(function (t) { kindOf[t.z] = "table"; kindOf[t.x] = kindOf[t.x] || "axis"; if (t.y) kindOf[t.y] = kindOf[t.y] || "axis"; });
    (layout.curves || []).forEach(function (t) { kindOf[t.z] = kindOf[t.z] || "curve"; kindOf[t.x] = kindOf[t.x] || "axis"; });
    Object.keys(appVals).forEach(function (name) {
      var c = layout.constants[name], have = ecuTables[name], app = appVals[name];
      if (!c || !have || have.length !== app.length || sh[name] || /firmware|version|signature/i.test(name)) return;
      var tol = tolerance(c), cells = [];
      app.forEach(function (v, i) { if (!(Math.abs(v - have[i]) <= tol)) cells.push({ i: i, ecu: have[i], app: v }); });
      // wiring, pins, trigger and sensor settings (in the layout only for the settings dialogs): shown, never written
      if (cells.length) out.push(c.dlg ? { name: name, kind: "wiring", cells: cells, ro: true } : { name: name, kind: kindOf[name] || (c.kind === "array" ? "table" : "setting"), cells: cells });
    });
    var rank = { table: 0, curve: 1, axis: 2, setting: 3, wiring: 4 };
    return out.sort(function (a, b) { return rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name); });
  }

  /* Where cell i of a table or curve is: its axis values from the given tables -> {x, xName, y, yName, row, col} */
  function cellAt(layout, name, i, tables) {
    var defs = (layout.tables || []).concat(layout.curves || []), t = defs.filter(function (d) { return d.z === name; })[0];
    var c = layout.constants[name] || {}, cols = c.cols || 1;
    var row = Math.floor(i / cols), col = i % cols;
    if (!t) return { row: row, col: col };
    var xs = tables[t.x] || [], ys = t.y ? tables[t.y] || [] : null;
    if (!t.y) return { x: xs[i], xName: t.x, row: i, col: 0 };  // a curve: one value per x bin
    return { x: xs[col], xName: t.x, y: ys[row], yName: t.y, row: row, col: col };
  }

  /* The cells to write for the items chosen as the app's: [{name, cells: {i: value}}], in writes of up to n. */
  function writes(items, n) {
    var out = [];
    items.forEach(function (x) {
      if (x.ro) return;
      for (var k = 0; k < x.cells.length; k += n || 128) {
        var part = {};
        x.cells.slice(k, k + (n || 128)).forEach(function (cl) { part[cl.i] = cl.app; });
        out.push({ name: x.name, cells: part });
      }
    });
    return out;
  }

  /* How a table or curve is drawn as a grid (TunerStudio's way: the highest load row on top): -> {cols, rows,
     xName, yName} or null when it isn't one (axis bins, a plain setting). */
  function gridOf(layout, name, tables) {
    var defs = (layout.tables || []).concat(layout.curves || []), t = defs.filter(function (d) { return d.z === name; })[0];
    if (!t || !tables[t.x]) return null;
    var cols = tables[t.x].length, rows = t.y && tables[t.y] ? tables[t.y].length : 1, n = (tables[name] || []).length;
    if (cols * rows !== n) return null;
    return { cols: cols, rows: rows, xName: t.x, yName: t.y && tables[t.y] ? t.y : null };
  }

  /* Both versions of a table in full: the ECU's, and the ECU's with the app's differing cells put in.
     -> {ecu: [...], app: [...], lo, hi} (lo/hi over both, so one colour scale fits the two). */
  function versions(ecuVals, item) {
    var ecu = ecuVals.slice(), app = ecuVals.slice();
    item.cells.forEach(function (c) { app[c.i] = c.app; });
    var lo = Infinity, hi = -Infinity;
    ecu.concat(app).forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    return { ecu: ecu, app: app, lo: lo, hi: hi };
  }

  /* What to write, from the driver's picks: picks[k] is {cellIndex: true} for the cells taken from the app.
     -> items with only those cells (items with none left out; read-only ones never). */
  function chosen(items, picks) {
    return items.map(function (x, k) {
      if (x.ro) return { name: x.name, kind: x.kind, cells: [] };
      var p = picks[k] || {};
      return { name: x.name, kind: x.kind, cells: x.cells.filter(function (c) { return p[c.i]; }) };
    }).filter(function (x) { return x.cells.length; });
  }

  /* A tune that is all zeros (a simulated ECU started without its tune, a blank page): never something to keep. */
  function blank(tables, layout) {
    var seen = 0;
    for (var name in tables) {
      var c = layout && layout.constants[name];
      if (c && c.kind === "bits") continue;
      var v = tables[name] || [];
      for (var i = 0; i < v.length; i++) { if (v[i] !== 0 && v[i] === v[i]) return false; seen++; }
    }
    return seen > 0;
  }

  return { blank: blank, msqValues: msqValues, sharedMem: sharedMem, diff: diff, cellAt: cellAt, writes: writes, tolerance: tolerance,
           gridOf: gridOf, versions: versions, chosen: chosen };
});
