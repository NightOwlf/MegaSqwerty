/* VE Analyze against logs where the right answer is known. Run with `node tests/js/veal.test.js`
   (tests/test_veal.py runs it under pytest). */
"use strict";
const assert = require("assert");
const VEAL = require("../../app/static/veal.js");

const X = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
const Y = [20, 30, 40, 50, 60, 70, 80, 90, 100];
const C = X.length, R = Y.length;
const tune = [];
for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) tune.push(40 + r * 5 + c * 2);
// what the engine really wants: up to 12% more or less than the tune, varying across the map like a real one
const truth = tune.map((v, k) => v * (1 + 0.12 * Math.sin((k % C) / 1.7) * Math.cos(Math.floor(k / C) / 2.2)));
const table = { x: X, y: Y, z: tune, cols: C, rows: R, d: 1 };

function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

/* A log that sweeps the table slowly. λ responds to fuel `lag` seconds later. */
function makeLog({ n = 60000, lag = 0.15, transientAt = -1, cold = false, noise = 0.004, seed = 7 } = {}) {
  const rand = rng(seed), T = new Float32Array(n), rpm = new Float32Array(n), load = new Float32Array(n);
  const lam = new Float32Array(n), tgt = new Float32Array(n), ve = new Float32Array(n), tps = new Float32Array(n);
  const clt = new Float32Array(n), map = new Float32Array(n), fuel = new Float32Array(n);
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    T[i] = i * 0.01;
    // a slow sweep across every cell plus a little wobble, so each cell is visited at varied positions
    rpm[i] = 700 + 3200 * (0.5 - 0.5 * Math.cos(T[i] / 7)) + 60 * Math.sin(T[i] * 1.3);
    load[i] = 25 + 70 * (0.5 - 0.5 * Math.cos(T[i] / 2.3)) + 2 * Math.sin(T[i] * 2.1);
    map[i] = load[i];
    tps[i] = load[i] / 2;
    if (i >= transientAt && i < transientAt + 50 && transientAt >= 0) tps[i] += (i - transientAt) * 2;
    clt[i] = cold ? 40 : 88;
    tgt[i] = 0.95;
    ve[i] = VEAL.interp(table, tune, rpm[i], load[i]);
    ratio[i] = VEAL.interp(table, truth, rpm[i], load[i]) / ve[i];  // > 1: the engine wanted more fuel
    fuel[i] = ve[i] * map[i] * (1 + 0.005 * Math.sin(T[i] * 3.7)); // commanded fuel, with a wobble to measure lag by
  }
  const k = Math.round(lag / 0.01);
  for (let i = 0; i < n; i++) {
    const src = Math.max(0, i - k);
    const wobble = fuel[src] / (ve[src] * map[src]);
    lam[i] = tgt[src] * ratio[src] / wobble * (1 + (rand() - 0.5) * 2 * noise);
  }
  return { T, rpm, load, lam, tgt, ve, tps, clt, map, fuel };
}

function run(log, opts) {
  const e = VEAL.create(table, Object.assign({ lagByRpm: false }, opts));
  e.begin(log);
  for (let i = 0; i < log.T.length; i++) e.step(i);
  return { e, res: e.finish() };
}

function worst(res) {
  let w = 0;
  res.values.forEach((v, k) => { if (res.hits[k] > 0.5) w = Math.max(w, Math.abs(v / truth[k] - 1)); });
  return w;
}

// 1. It recovers the table the engine wants, to within a percent, wherever the log has data.
{
  const { res } = run(makeLog(), { lag: 0.15 });
  const w = worst(res);
  assert(w < 0.015, "cells should land within 1.5% of the true VE, worst was " + (w * 100).toFixed(2) + "%");
  assert(res.changed.length > 10, "cells that were wrong should change");
  console.log("ok - recovers the true VE (worst cell " + (w * 100).toFixed(2) + "% off)");
}

// 2. It measures the wideband delay from the log.
{
  const log = makeLog({ lag: 0.2 });
  const e = VEAL.create(table, {});
  const l = e.begin(log);
  assert(l.measured, "the delay should be measured");
  assert(Math.abs(l.lag - 0.2) < 0.06, "measured " + l.lag + " s for a 0.2 s delay");
  console.log("ok - measures the sensor delay (" + Math.round(l.lag * 1000) + " ms for 200 ms)");
}

// 3. Getting the delay right matters: with no delay compensation the result is worse.
{
  const log = makeLog({ lag: 0.4 });
  const good = worst(run(log, { lag: 0.4 }).res), bad = worst(run(log, { lag: 0.05 }).res);
  assert(good < bad, "matching the delay should help (" + good + " vs " + bad + ")");
  console.log("ok - delay compensation helps");
}

// 4. A cold engine is left out entirely.
{
  const { res } = run(makeLog({ cold: true }), { lag: 0.15 });
  assert.strictEqual(res.changed.length, 0);
  assert(res.stats.cold > 0 && res.stats.used === 0);
  console.log("ok - cold samples are not used");
}

// 5. Changes are limited to maxChange, and a cell with too little data doesn't move.
{
  const log = makeLog();
  for (let i = 0; i < log.lam.length; i++) log.lam[i] *= 1.4;  // wildly lean everywhere (but plausible)
  const { res } = run(log, { lag: 0.15, maxChange: 10 });
  res.changed.forEach(c => assert(Math.abs(c.to / c.ran - 1) <= 0.1005, "cell moved " + c.pct + "%"));
  res.changed.forEach(c => assert(Math.abs(c.ran / c.from - 1) < 0.01, "the rebuilt table is the tune that ran"));
  res.values.forEach((v, k) => { if (res.hits[k] < 0.5 * 0.1) assert.strictEqual(v, tune[k]); });
  console.log("ok - changes are clamped and thin cells are left alone");
}

// 6. Throttle transients are counted and skipped, and the results are rounded to the table's digits.
{
  const { res } = run(makeLog({ transientAt: 20000 }), { lag: 0.15 });
  assert(res.stats.transient > 50, "the throttle stab should be left out");
  res.values.forEach(v => assert.strictEqual(Math.round(v * 10) / 10, v));
  console.log("ok - transients are skipped, values rounded");
}

// 7. Wideband rail readings and fuel cut are left out.
{
  const log = makeLog();
  for (let i = 30000; i < 30400; i++) log.lam[i] = 0.5;          // the sensor's floor
  for (let i = 40000; i < 40300; i++) { log.fuel[i] = 0; log.lam[i] = 1.3; }
  const { res } = run(log, { lag: 0.15 });
  assert(res.stats.sensor >= 350, "rail readings: " + res.stats.sensor);
  assert(res.stats.decel >= 300, "fuel cut: " + res.stats.decel);
  assert(worst(res) < 0.015);
  console.log("ok - rail readings and fuel cut are skipped");
}

// 8. Several logs add up: two half logs give the same answer as one whole one.
{
  const whole = makeLog({ n: 60000 });
  const half = (a, b) => Object.fromEntries(Object.entries(whole).map(([k, v]) => [k, v.slice(a, b)]));
  const e = VEAL.create(table, { lag: 0.15, lagByRpm: false });
  [half(0, 30000), half(30000, 60000)].forEach(l => { e.begin(l); for (let i = 0; i < l.T.length; i++) e.step(i); });
  const both = e.finish();
  assert(worst(both) < 0.015, "two logs together: " + worst(both));
  assert.strictEqual(both.logs.length, 2);
  console.log("ok - several logs combine");
}
// 9. When the attached tune isn't the one that ran, it says so, and corrects what actually ran.
{
  const log = makeLog();
  const other = Object.assign({}, table, { z: tune.map(v => v * 0.6) });  // a file 40% off what the ECU ran
  const e = VEAL.create(other, { lag: 0.15, lagByRpm: false, maxChange: 25 });
  e.begin(log); for (let i = 0; i < log.T.length; i++) e.step(i);
  const res = e.finish();
  assert(res.mismatch > 30, "mismatch " + res.mismatch);
  assert(worst(res) < 0.015, "still lands on the true VE: " + worst(res));
  console.log("ok - a tune that didn't run is detected (" + res.mismatch.toFixed(0) + "% off) and the result is still right");
}
console.log("all VE Analyze tests passed");
