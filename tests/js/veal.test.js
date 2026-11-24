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

// 10. Only the chosen sections of the log are used, and only inside the user's filters.
{
  const log = makeLog();
  const n = log.T.length, half = new Uint8Array(n);
  for (let i = 0; i < n / 2; i++) half[i] = 1;
  log.inSection = half;
  const { res } = run(log, { lag: 0.15 });
  assert(res.stats.section > n * 0.45 && res.stats.section < n * 0.55, "half the log is outside the section");
  const log2 = makeLog();
  const { e, res: r2 } = run(log2, { lag: 0.15, rpmLo: 1500, rpmHi: 3000 });
  assert(r2.stats.filter > 0, "samples outside the RPM window are filtered");
  r2.changed.forEach(c => assert(X[c.i % C] >= 1000 && X[c.i % C] <= 3500, "only cells near the RPM window change, not " + X[c.i % C]));
  assert(Number.isFinite(e.error(3 * C + 3)), "a cell with data reports its mixture error");
  console.log("ok - sections and filters limit what is tuned");
}

// 11. Locked cells never move; strength scales the correction.
{
  const locked = [2 * C + 2, 4 * C + 4, 5 * C + 3];
  const { res } = run(makeLog(), { lag: 0.15, locked });
  locked.forEach(k => assert.strictEqual(res.values[k], tune[k], "locked cell " + k + " stayed at the tune's value"));
  assert(!res.changed.some(c => locked.includes(c.i)), "locked cells are not reported as changed");
  const full = run(makeLog(), { lag: 0.15 }).res, halfway = run(makeLog(), { lag: 0.15, strength: 50 }).res;
  const k = full.changed.reduce((a, c) => (Math.abs(c.pct) > Math.abs(a.pct) ? c : a)).i;
  const want = tune[k] + (full.values[k] - tune[k]) / 2;
  assert(Math.abs(halfway.values[k] - want) <= 0.11, "50% strength goes half way: " + halfway.values[k] + " vs " + want);
  console.log("ok - locked cells hold and strength scales the change");
}

// 12. A VE logged in one byte (FOME: 0–127.5) wraps above 127.5: the result is the same as with the true value.
{
  const assert = require("assert");
  const big = tune.map(v => v + 60);  // a tune with cells above 127.5
  const T2 = Object.assign({}, table, { z: big });
  const log = makeLog();
  const wrapped = Object.assign({}, log, { ve: log.ve.map(v => { const t = v + 60; return t > 127.5 ? t - 128 : t; }) });
  const exact = Object.assign({}, log, { ve: log.ve.map(v => v + 60) });
  const a = VEAL.create(T2, { lag: 0.15 }), b = VEAL.create(T2, { lag: 0.15 });
  a.begin(wrapped); b.begin(exact);
  for (let i = 0; i < log.T.length; i++) { a.step(i); b.step(i); }
  const ra = a.finish(), rb = b.finish();
  ra.values.forEach((v, k) => assert(Math.abs(v - rb.values[k]) <= 0.2, "cell " + k + ": " + v + " vs " + rb.values[k]));
  console.log("ok - a VE logged in one byte that wraps above 127.5 is put right");
}

/* VE Analyze Live: one engine for the whole session, corrections written into the ECU's table pass by pass while
   the car keeps running on it. Same steps as the viewer (rebase on the table as it is now, decay older evidence,
   a short window per pass, then the corrections go into the ECU). */
function liveSession({ truthOf = truth, noise = 0.004, passes = 40, passS = 5, hz = 20, opts = {}, seed = 3, misfire = null, stuckRich = null } = {}) {
  const rand = rng(seed), dt = 1 / hz, lag = 0.15, per = Math.round(passS * hz), total = per * passes;
  const cur = tune.slice(), n0 = total + 200;
  const d = { T: new Float32Array(n0), rpm: new Float32Array(n0), load: new Float32Array(n0), lam: new Float32Array(n0),
              tgt: new Float32Array(n0), ve: new Float32Array(n0), tps: new Float32Array(n0), clt: new Float32Array(n0),
              map: new Float32Array(n0) };
  const ratio = new Float32Array(n0);
  const engine = VEAL.create(Object.assign({}, table, { z: cur.slice() }), Object.assign({ lag, lagByRpm: false, ref: "base", minChange: 1, maxLean: 5 }, opts));
  let from = 0, n = 0, sent = 0;
  const sample = (i) => {
    const t = i * dt;
    d.T[i] = t;
    d.rpm[i] = 700 + 3200 * (0.5 - 0.5 * Math.cos(t / 23)) + 60 * Math.sin(t * 1.3);
    d.load[i] = 25 + 70 * (0.5 - 0.5 * Math.cos(t / 7.3)) + 2 * Math.sin(t * 2.1);
    d.map[i] = d.load[i]; d.tps[i] = d.load[i] / 2; d.clt[i] = 88; d.tgt[i] = 0.95;
    d.ve[i] = VEAL.interp(table, cur, d.rpm[i], d.load[i]);           // what the ECU runs right now
    ratio[i] = VEAL.interp(table, truthOf, d.rpm[i], d.load[i]) / d.ve[i];
    const src = Math.max(0, i - Math.round(lag / dt));
    d.lam[i] = d.tgt[src] * ratio[src] * (1 + (rand() - 0.5) * 2 * noise);
    // a misfire: unburned air reaches the wideband, and the more fuel it's given the leaner it reads
    if (misfire && misfire(d.rpm[src], d.load[src])) d.lam[i] *= 1.12 * Math.pow(1 / ratio[src], 1.3);
    // a wideband that reads rich whatever the fuel does (a bad sensor, its ground): λ stuck near 0.85
    if (stuckRich && stuckRich(d.rpm[src], d.load[src])) d.lam[i] = 0.85 * (1 + (rand() - 0.5) * 2 * noise);
  };
  for (let p = 0; p < passes; p++) {
    for (let k = 0; k < per; k++) sample(n++);
    engine.rebase(cur); engine.decay(Math.pow(0.5, passS / 300));
    const s0 = Math.max(0, from - Math.round(2.5 * hz));
    const slice = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.subarray(s0, n)]));
    const log = engine.begin(slice);
    let i = from - s0;
    for (; i < n - s0 && log.j[i] >= 0; i++) engine.step(i);
    from = s0 + i;
    engine.passEnd();
    const res = engine.finish();
    res.changed.forEach(c => { cur[c.i] = c.to; sent++; });
  }
  return { cur, engine, sent };
}

// 13. VE Analyze Live closes the loop: the ECU's table ends up where the engine wants it, without overshooting.
{
  const { cur, engine } = liveSession();
  let w = 0, k0 = 0;
  cur.forEach((v, k) => { if (engine.hits[k] > 2) { k0++; w = Math.max(w, Math.abs(v / truth[k] - 1)); } });
  assert(k0 > 20, "the drive covers the table: " + k0 + " cells");
  assert(w < 0.02, "every driven cell lands within 2% of what the engine wants, worst " + (w * 100).toFixed(2) + "%");
  console.log("ok - VE Analyze Live converges on the engine's real VE in the ECU (worst cell " + (w * 100).toFixed(2) + "% off)");
}

// 14. ...and it doesn't chase noise: a table that's already right, read through a noisy wideband, is left alone.
{
  const quiet = liveSession({ truthOf: tune, noise: 0.03 });
  const naive = liveSession({ truthOf: tune, noise: 0.03, opts: { confidence: 0, minChange: 0 } });
  let drift = 0;
  quiet.cur.forEach((v, k) => { if (quiet.engine.hits[k] > 2) drift = Math.max(drift, Math.abs(v / tune[k] - 1)); });
  assert(drift < 0.02, "a right table stays right through noise, drift " + (drift * 100).toFixed(2) + "%");
  assert(quiet.sent < naive.sent / 3, "far fewer pointless writes than without the confidence check: " + quiet.sent + " vs " + naive.sent);
  console.log("ok - noise doesn't move a right table (" + quiet.sent + " writes vs " + naive.sent + " without the confidence check)");
}

// 15. ...and it won't chase a misfire: where more fuel reads leaner (a weak spark, a misfire), it stops raising
// the cells and says which, instead of piling fuel in until the table hits its limits.
{
  const zone = (rpm, load) => rpm > 2400 && rpm < 3600 && load > 70;
  const inZone = k => X[k % C] >= 2500 && X[k % C] <= 3500 && Y[Math.floor(k / C)] >= 80;
  const guarded = liveSession({ misfire: zone, passes: 60 });
  const naive = liveSession({ misfire: zone, passes: 60, opts: { responseCheck: false } });
  let up = 0, upNaive = 0;
  tune.forEach((v, k) => { if (inZone(k)) { up = Math.max(up, guarded.cur[k] / v - 1); upNaive = Math.max(upNaive, naive.cur[k] / v - 1); } });
  const held = guarded.engine.stuck();
  assert(held.some(inZone), "the misfiring cells are reported: " + held);
  assert(upNaive > 0.3, "without the check the fuel runs away: +" + (upNaive * 100).toFixed(0) + "%");
  assert(up < upNaive / 2, "with it, the cells stop rising: +" + (up * 100).toFixed(0) + "% vs +" + (upNaive * 100).toFixed(0) + "%");
  let w = 0;
  guarded.cur.forEach((v, k) => { if (!zone(X[k % C], Y[Math.floor(k / C)]) && X[k % C] < 2000 && guarded.engine.hits[k] > 2) w = Math.max(w, Math.abs(v / truth[k] - 1)); });
  assert(w < 0.02, "cells away from the misfire still tune normally: " + (w * 100).toFixed(2) + "%");
  console.log("ok - a misfire isn't fed: " + held.length + " cells held at +" + (up * 100).toFixed(0) + "% (+" + (upNaive * 100).toFixed(0) + "% without the check)");
}

// 16. ...and it won't lean a cell out on a wideband that reads rich whatever the fuel does: once taking fuel out
// hasn't made the mixture leaner, it stops lowering the cells (the dangerous direction) and says which.
{
  const zone = (rpm, load) => rpm > 2400 && rpm < 3600 && load > 70;
  const inZone = k => X[k % C] >= 2500 && X[k % C] <= 3500 && Y[Math.floor(k / C)] >= 80;
  const guarded = liveSession({ stuckRich: zone, passes: 60 });
  const naive = liveSession({ stuckRich: zone, passes: 60, opts: { responseCheck: false } });
  let down = 0, downNaive = 0;
  tune.forEach((v, k) => { if (inZone(k)) { down = Math.max(down, 1 - guarded.cur[k] / v); downNaive = Math.max(downNaive, 1 - naive.cur[k] / v); } });
  assert(guarded.engine.stuck().some(inZone), "the cells on the bad reading are reported");
  assert(downNaive > 0.3, "without the check the cells lean out: -" + (downNaive * 100).toFixed(0) + "%");
  assert(down < 0.2 && down < downNaive / 2, "with it, they stop coming down: -" + (down * 100).toFixed(0) + "% vs -" + (downNaive * 100).toFixed(0) + "%");
  console.log("ok - a wideband stuck rich doesn't lean the table out: held at -" + (down * 100).toFixed(0) + "% (-" + (downNaive * 100).toFixed(0) + "% without the check)");
}

// 17. The delay is measured on fuel per unit of air (fuel that just follows MAP doesn't move λ, and lining it up
// with λ pulled the answer 40-60 ms short), and between samples: a 20 Hz log isn't stuck to 50 ms steps.
{
  const at20 = (log) => Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.filter((_, i) => i % 5 === 0)]));
  for (const lag of [0.13, 0.22, 0.31]) {
    for (const [name, log] of [["100 Hz", makeLog({ lag })], ["20 Hz", at20(makeLog({ lag }))]]) {
      const got = VEAL.create(table, { lagByRpm: false }).begin(log).lag;
      assert(Math.abs(got - lag) < 0.02, name + ": measured " + got.toFixed(3) + " s for " + lag + " s");
    }
  }
  console.log("ok - the delay is measured to within 20 ms, at 100 Hz and at 20 Hz");
}

// 18. Look ahead: with the delay set a little long, the lean spike of a fuel cut leaks into the readings just before
// it (its first readings ask for 10-30% more fuel, which passes as plausible). Those records are left out.
{
  const log = makeLog({ lag: 0.15 });
  const cuts = [];
  for (let s = 6000; s < 58000; s += 400) cuts.push(s);  // stop-and-go: a lift-off every 4 s
  cuts.forEach(s => { for (let i = s; i < s + 150; i++) log.fuel[i] = 0; for (let i = s + 15; i < s + 165; i++) log.lam[i] = Math.min(1.6, log.lam[i] + 0.03 * (i - s - 15)); });  // λ ramps lean
  const ahead = run(log, { lag: 0.25, maxChange: 30, confidence: 0 }).res, blind = run(log, { lag: 0.25, maxChange: 30, confidence: 0, lookAhead: 0 }).res;
  assert(ahead.stats.decel > blind.stats.decel, "records just before a cut are left out");
  assert(worst(ahead) < worst(blind), "and the table is closer: " + worst(ahead) + " vs " + worst(blind));
  console.log("ok - records just before a fuel cut are left out (worst cell " + (worst(ahead) * 100).toFixed(2) + "% vs " + (worst(blind) * 100).toFixed(2) + "%)");
}

// 19. FOME / rusEFI: the cut code (fuel cut right now), AE fuel added or taken (in ms, either sign) and a big
// wall-wetting correction all mark records the VE table wasn't in charge of.
{
  const log = makeLog({ n: 20000 });
  const n = log.T.length;
  log.cutCode = new Float32Array(n); log.ae = new Float32Array(n); log.wall = new Float32Array(n); log.mass = new Float32Array(n).fill(20);
  for (let i = 3000; i < 3400; i++) log.cutCode[i] = 3;    // RPM limit
  for (let i = 8000; i < 8200; i++) log.ae[i] = -0.4;      // decel enleanment
  for (let i = 12000; i < 12300; i++) log.wall[i] = 2.5;   // 12.5% of the fuel
  const { res } = run(log, { lag: 0.15 });
  assert(res.stats.decel >= 400, "cut code: " + res.stats.decel);
  assert(res.stats.transient >= 500, "AE and wall wetting: " + res.stats.transient);
  console.log("ok - FOME's cut code, AE fuel and wall-wetting correction are used");
}

// 20. Fuel film: the ECU's wall-wetting model is never exact, so what it corrects partly shows on the wideband.
// With the correction logged, records it's busy in count for less and the table lands closer.
{
  const log = makeLog({ n: 60000 });
  const n = log.T.length, wall = new Float32Array(n), mass = new Float32Array(n);
  let F = 0, film = Float32Array.from(log.lam);
  // throttle stabs every 6 s: the load (and fuel) jumps 25%, half the film effect is left over on the wideband
  for (let i = 0; i < n; i++) {
    const stab = i % 600 < 300 ? 1.25 : 1, inj = log.fuel[i] * stab, ev = F / 50;
    F += 0.3 * inj - ev;
    const err = inj > 0 ? ((0.7 * inj + ev) / inj - 1) : 0;
    wall[i] = -err * 0.5 * inj; mass[i] = inj;
    const k = Math.min(n - 1, i + 15);
    film[k] = log.lam[k] / (1 + err * 0.5);
  }
  log.lam = film;
  const withWall = run(Object.assign({}, log, { wall, mass }), { lag: 0.15, maxChange: 30, confidence: 0 }).res;
  const without = run(log, { lag: 0.15, maxChange: 30, confidence: 0 }).res;
  assert(worst(withWall) < worst(without), "wall correction logged: " + worst(withWall) + " vs " + worst(without));
  console.log("ok - fuel film is allowed for (worst cell " + (worst(withWall) * 100).toFixed(2) + "% vs " + (worst(without) * 100).toFixed(2) + "% without the wall correction)");
}
// 21. A cell the log only reaches at the edge of its square (here MAP sits at 59-60 kPa, so the 50 kPa row is never
// more than a tenth of the mix) isn't pinned down by the rebuild of the table that ran: any inconsistency in the logged
// VE (FOME logs it in 0.5 steps; a table changed mid-log) is multiplied tenfold there. On a real FOME log with a tune
// attached that wasn't the one that ran, that swung such a cell to a VE of 3 where the ECU logged about 40. A guard:
// the rebuilt cell is held near the VE logged around it.
{
  const log = makeLog({ n: 30000 });
  for (let i = 0; i < log.T.length; i++) {
    const at = i % 2 ? 60 : 59;                                         // right on the row, and a whisker below it
    log.load[i] = log.map[i] = at;
    const v = VEAL.interp(table, tune, log.rpm[i], at);
    log.ve[i] = at === 59 ? Math.round((v - 0.75) * 2) / 2 : Math.round(v * 2) / 2;  // logged in 0.5 steps, a bit off
    log.lam[i] = log.tgt[i] * VEAL.interp(table, truth, log.rpm[i], at) / v;
  }
  const other = Object.assign({}, table, { z: tune.map(v => v * 0.8) });  // not the tune that ran
  const e = VEAL.create(other, { lag: 0.01, lagByRpm: false });
  e.begin(log); for (let i = 0; i < log.T.length; i++) e.step(i);
  const res = e.finish();
  let w = 0;
  const row50 = Y.indexOf(50);
  res.ran.forEach((v, k) => { if (Math.floor(k / C) === row50 && res.hits[k] > 0.05) w = Math.max(w, Math.abs(v / tune[k] - 1)); });
  assert(w < 0.2, "the 50 kPa row of what ran stays near the VE logged around it, worst " + (w * 100).toFixed(0) + "% off");
  console.log("ok - cells reached only at the edge of their square stay sane (rebuilt within " + (w * 100).toFixed(0) + "% of what ran)");
}
// 22. A one-byte VE that wrapped is put right even when today's tune has the cell well under 128: a real FOME log ran
// about 151 at 3500 rpm / 90 kPa and logged 23.1, while the tune attached now has that cell at 106.6. Read as 23 it
// asked for ~85% less fuel and slipped past the plausibility check (which looks at λ, not the VE).
{
  assert.strictEqual(+VEAL.unwrapVe(23.1, 106.6).toFixed(1), 151.1, "23.1 against 106.6 is 151.1");
  assert.strictEqual(VEAL.unwrapVe(23, 60), 23, "a low cell stays low");
  assert.strictEqual(VEAL.unwrapVe(70, 106.6), 70, "a value near the tune is left alone");
  const ran = tune.map(v => v + 80);                                  // the tune that ran: lots of cells over 127.5
  const now = Object.assign({}, table, { z: ran.map(v => v * 0.72) }); // today's: the same cells 28% lower (106 for 148)
  const truthR = ran.map((v, k) => v * truth[k] / tune[k]);
  const log = makeLog();
  for (let i = 0; i < log.T.length; i++) {
    const v = VEAL.interp(table, ran, log.rpm[i], log.load[i]);
    log.ve[i] = v > 127.5 ? Math.round((v - 128) * 2) / 2 : Math.round(v * 2) / 2;
    log.lam[i] = log.tgt[i] * VEAL.interp(table, truthR, log.rpm[i], log.load[i]) / v;
  }
  const solve = (d, opts) => { const e = VEAL.create(now, Object.assign({ lag: 0.01, lagByRpm: false, maxChange: 50 }, opts)); e.begin(d); for (let i = 0; i < d.T.length; i++) e.step(i); return e.finish(); };
  const res = solve(log);
  let w = 0;
  res.values.forEach((v, k) => { if (res.hits[k] > 1) w = Math.max(w, Math.abs(v / truthR[k] - 1)); });
  assert(w < 0.03, "lands on what the engine needs, worst " + (w * 100).toFixed(1) + "%");
  // with the tune that ran known (d.veRef), the same; and a log that ever shows a VE over 127.5 isn't one-byte: no unwrapping
  const withRef = solve(Object.assign({}, log, { veRef: log.T.map((_, i) => VEAL.interp(table, ran, log.rpm[i], log.load[i])) }));
  let w2 = 0;
  withRef.values.forEach((v, k) => { if (withRef.hits[k] > 1) w2 = Math.max(w2, Math.abs(v / truthR[k] - 1)); });
  assert(w2 < 0.03, "against the tune that ran, worst " + (w2 * 100).toFixed(1) + "%");
  const e16 = VEAL.create(now, {}); const l16 = e16.begin(Object.assign({}, log, { ve: log.ve.map((v, i) => i === 5 ? 140 : v) }));
  assert.strictEqual(l16.canWrap, false, "VE over 127.5 in the log: two-byte, never unwrapped");
  console.log("ok - a wrapped one-byte VE is put right against a tune that has since moved (worst cell " + (w * 100).toFixed(1) + "%)");
}
console.log("all VE Analyze tests passed (incl. look-ahead, FOME channels, fuel film, edge cells, VE wrap)");
