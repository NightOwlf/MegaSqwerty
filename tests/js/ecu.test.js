/* The ECU protocol end to end against the simulated ECU: the same framed bytes a real one gets. */
"use strict";
const test = require("node:test");
const assert = require("assert");
const ECU = require("../../app/static/ecu.js");

const layout = {
  comms: { signature: "rusEFI (FOME) test", queryCommand: "S", pageReadCommand: '"R%2o%2c"', pageChunkWrite: '"C%2o%2c%v"',
           burnCommand: '"B"', ochGetCommand: '"O%2o%2c"', ochBlockSize: 64, pageSizes: [2048], blockingFactor: 100,
           endianness: "little" },
  constants: {
    veTable: { kind: "array", type: "U16", offset: 100, rows: 16, cols: 16, scale: 0.1, translate: 0, lo: 0, hi: 999, digits: 1, units: "%" },
    veLoadBins: { kind: "array", type: "U16", offset: 612, rows: 1, cols: 16, scale: 1, translate: 0, units: "kPa" },
    veRpmBins: { kind: "array", type: "U16", offset: 644, rows: 1, cols: 16, scale: 1, translate: 0, units: "RPM" },
    ignitionTable: { kind: "array", type: "S16", offset: 700, rows: 2, cols: 2, scale: 0.1, translate: 0, lo: -20, hi: 90, digits: 1 }
  },
  outputs: { RPMValue: { kind: "scalar", type: "U16", offset: 4, scale: 1, translate: 0, label: "RPM" },
             veTableYAxis: { kind: "scalar", type: "U16", offset: 12, scale: 0.01, translate: 0, label: "veTableYAxis" },
             coolant: { kind: "scalar", type: "S16", offset: 8, scale: 0.01, translate: 0, label: "CLT" } },
  tables: [{ id: "veTableTbl", title: "VE Table", x: "veRpmBins", xch: "RPMValue", y: "veLoadBins", ych: "veTableYAxis", z: "veTable" }],
  roles: { rpm: "RPMValue", clt: "coolant" }
};

test("CRC and framing match the msEnvelope format", () => {
  assert.strictEqual(ECU.crc32(new TextEncoder().encode("123456789")), 0xCBF43926);  // the standard check value
  const f = ECU.frame(new Uint8Array([0x53]));
  assert.deepStrictEqual(Array.from(f.slice(0, 3)), [0, 1, 0x53]);
  assert.deepStrictEqual(Array.from(ECU.build('"R%2o%2c"', { o: 0x1234, c: 0x0102 }, true)), [0x52, 0x34, 0x12, 0x02, 0x01]);
  assert.deepStrictEqual(Array.from(ECU.build('"k\\x00\\x00%2o"', { o: 1 }, true)), [0x6b, 0, 0, 1, 0]);
});

test("signature, reading the page in blocks, writing cells and reading them back, live data, burn", async () => {
  // a page with a VE table of 60.0 and bins
  const page = new Uint8Array(2048), dv = new DataView(page.buffer);
  for (let i = 0; i < 256; i++) dv.setUint16(100 + i * 2, 600, true);
  for (let i = 0; i < 16; i++) { dv.setUint16(612 + i * 2, 20 + i * 10, true); dv.setUint16(644 + i * 2, 500 + i * 500, true); }
  dv.setInt16(700, -50, true);
  const pipe = ECU.simPipe(layout, page);
  const ecu = new ECU.Ecu(new ECU.Link(pipe, 2000), layout);
  assert.strictEqual(await ecu.signature(), "rusEFI (FOME) test");
  const got = await ecu.readPage();                              // 2048 bytes in 100-byte blocks
  const t = ECU.decodeConstants(layout, got, true);
  assert.strictEqual(t.veTable.length, 256);
  assert.ok(Math.abs(t.veTable[17] - 60) < 1e-9 && t.veRpmBins[3] === 2000 && Math.abs(t.ignitionTable[0] + 5) < 1e-9);

  // change three cells (two next to each other: one write), as the car page does, and read them back
  const runs = ECU.encodeCells(layout.constants.veTable, { 3: 61.5, 4: 62.25, 40: 1200 }, true);
  assert.strictEqual(runs.length, 2);
  for (const r of runs) await ecu.write(r.offset, r.bytes);
  const back = ECU.decodeConstants(layout, await ecu.readPage(), true).veTable;
  assert.ok(Math.abs(back[3] - 61.5) < 1e-9 && Math.abs(back[4] - 62.3) < 1e-9);  // rounded to the ECU's 0.1
  assert.strictEqual(back[40], 999);                                                 // held to the table's range
  const neg = ECU.encodeCells(layout.constants.ignitionTable, { 1: -3.7 }, true);
  await ecu.write(neg[0].offset, neg[0].bytes);
  assert.ok(Math.abs(ECU.decodeConstants(layout, await ecu.readPage(), true).ignitionTable[1] + 3.7) < 1e-9);

  const live = ECU.decodeOutputs(layout, await ecu.och(), true);
  assert.ok(live.RPMValue >= 800 && live.RPMValue < 6000, "the simulated engine is running: " + live.RPMValue);
  assert.ok(live.coolant > 80 && live.coolant < 100);
  await ecu.burn();
});

test("a garbled reply is caught, not used", async () => {
  const listeners = [];
  const pipe = { write: () => { setTimeout(() => { const f = ECU.frame(new Uint8Array([0, 65])); f[f.length - 1] ^= 0xFF; listeners.forEach((l) => l(f)); }, 5); return Promise.resolve(); },
                 onData: (f) => listeners.push(f) };
  const ecu = new ECU.Ecu(new ECU.Link(pipe, 500), layout);
  await assert.rejects(ecu.signature(), /garbled/);
});
