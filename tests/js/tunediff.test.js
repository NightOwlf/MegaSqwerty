/* The difference report: the ECU's tune against the app's copy, by setting and by cell. */
"use strict";
const test = require("node:test");
const assert = require("assert");
const TD = require("../../app/static/tunediff.js");

const layout = {
  constants: {
    veTable: { kind: "array", type: "U16", offset: 100, rows: 2, cols: 3, scale: 0.1, digits: 1, units: "%" },
    veLoadBins: { kind: "array", type: "U16", offset: 112, rows: 2, cols: 1, scale: 1, digits: 0, units: "kPa" },
    veRpmBins: { kind: "array", type: "U16", offset: 116, rows: 3, cols: 1, scale: 1, digits: 0, units: "RPM" },
    cltFuelCorrBins: { kind: "array", type: "F32", offset: 200, rows: 2, cols: 1, scale: 1, digits: 0 },
    cltFuelCorr: { kind: "array", type: "F32", offset: 208, rows: 2, cols: 1, scale: 1, digits: 2 },
    rpmHardLimit: { kind: "scalar", type: "U16", offset: 6, scale: 1, digits: 0, units: "rpm" },
    rpmAlias: { kind: "scalar", type: "U16", offset: 20, scale: 1, digits: 0 },            // same memory, another name
    injMode: { kind: "bits", type: "U08", offset: 8, bits: [0, 1], options: ['"Simultaneous"', '"Sequential"', '"Batch"'] },
    fanOn: { kind: "bits", type: "U08", offset: 8, bits: [2, 2], options: ['"false"', '"true"'] },  // same byte, own bit
    tempAlias: { kind: "scalar", type: "U08", offset: 21, scale: 1, digits: 0 },
    firmwareVersion: { kind: "scalar", type: "U16", offset: 30, scale: 1, digits: 0 }
  },
  tables: [{ z: "veTable", x: "veRpmBins", y: "veLoadBins", title: "VE Table" }],
  curves: [{ z: "cltFuelCorr", x: "cltFuelCorrBins", y: null, title: "Warmup" }]
};
const ecu = {
  veTable: [50, 51, 52, 60, 61, 62], veLoadBins: [30, 100], veRpmBins: [1000, 3000, 6000],
  cltFuelCorrBins: [-20, 80], cltFuelCorr: [1.5, 1.0], rpmHardLimit: [7000], rpmAlias: [7000],
  injMode: [1], fanOn: [0], firmwareVersion: [5]
};
const msq = `<?xml version="1.0"?><msq><page>
  <constant cols="3" digits="1" name="veTable" rows="2" units="%">
     50.0 51.04 52.0
     60.0 64.5 62.0
  </constant>
  <constant name="veRpmBins" rows="3" cols="1">1000 3000 6000</constant>
  <constant name="veLoadBins" rows="2" cols="1">30 100</constant>
  <constant name="cltFuelCorr" rows="2" cols="1">1.6 1.0</constant>
  <constant name="rpmHardLimit" units="rpm">7200</constant>
  <constant name="rpmAlias">7300</constant>
  <constant name="injMode">"Batch"</constant>
  <constant name="fanOn">"false"</constant>
  <constant name="firmwareVersion">9</constant>
  <constant name="tempAlias">3</constant>
  <constant name="notInTheEcu">1</constant>
  <constant name="veTableShort" rows="1">1 2</constant>
</page></msq>`;

test("reads a .msq in the ECU's units, options as their number", () => {
  const v = TD.msqValues(msq, layout);
  assert.deepStrictEqual(v.veTable, [50, 51.04, 52, 60, 64.5, 62]);
  assert.deepStrictEqual(v.injMode, [2]);
  assert.deepStrictEqual(v.fanOn, [0]);
  assert.ok(!("notInTheEcu" in v));
});

test("every difference, by cell and setting, with both values", () => {
  const d = TD.diff(layout, ecu, TD.msqValues(msq, layout));
  assert.deepStrictEqual(d.map((x) => x.name), ["veTable", "cltFuelCorr", "injMode", "rpmHardLimit"]);
  const ve = d[0];
  assert.strictEqual(ve.kind, "table");
  assert.deepStrictEqual(ve.cells, [{ i: 4, ecu: 61, app: 64.5 }]);  // 51.04 vs 51 is below the table's 0.1 step
  assert.deepStrictEqual(d[1], { name: "cltFuelCorr", kind: "curve", cells: [{ i: 0, ecu: 1.5, app: 1.6 }] });
  assert.deepStrictEqual(d[2].cells, [{ i: 0, ecu: 1, app: 2 }]);
  assert.deepStrictEqual(d[3], { name: "rpmHardLimit", kind: "setting", cells: [{ i: 0, ecu: 7000, app: 7200 }] });
  // the same memory under two names, and the firmware's own version, aren't compared
  assert.ok(!d.some((x) => x.name === "rpmAlias" || x.name === "tempAlias" || x.name === "firmwareVersion"));
});

test("the same tune: nothing to report", () => {
  const same = { veTable: ecu.veTable, veRpmBins: ecu.veRpmBins, injMode: [1], rpmHardLimit: [7000] };
  assert.deepStrictEqual(TD.diff(layout, ecu, same), []);
});

test("where a cell is, from the table's axes", () => {
  assert.deepStrictEqual(TD.cellAt(layout, "veTable", 4, ecu), { x: 3000, xName: "veRpmBins", y: 100, yName: "veLoadBins", row: 1, col: 1 });
  assert.deepStrictEqual(TD.cellAt(layout, "cltFuelCorr", 1, ecu), { x: 80, xName: "cltFuelCorrBins", row: 1, col: 0 });
});

test("the app's values chosen are written in parts", () => {
  const items = [{ name: "veTable", cells: [{ i: 0, ecu: 1, app: 2 }, { i: 1, ecu: 1, app: 3 }, { i: 5, ecu: 1, app: 4 }] }];
  assert.deepStrictEqual(TD.writes(items, 2), [{ name: "veTable", cells: { 0: 2, 1: 3 } }, { name: "veTable", cells: { 5: 4 } }]);
});
