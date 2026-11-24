/* Plain-English channel search. Run with `node tests/js/chansearch.test.js` (tests/test_chansearch.py runs it). */
"use strict";
const assert = require("assert");
const CS = require("../../app/static/chansearch.js");

// TunerStudio / MS3, FOME / rusEFI and Speeduino names for the same things
const CH = [["RPM", "rpm"], ["MAP", "kPa"], ["TPS", "%"], ["CLT", "°F"], ["MAT", "°F"], ["Coolant", "C"], ["IAT", "C"],
  ["AFR", "AFR"], ["AFR Target 1", "AFR"], ["EGO cor1", "%"], ["SPK: Spark Advance", "deg"], ["Advance", "deg"],
  ["Knock Retard", "deg"], ["PW", "ms"], ["Duty Cycle1", "%"], ["Batt V", "V"], ["CLT sensor voltage", "V"],
  ["Boost Duty", "%"], ["VSS", "mph"], ["Fuel: VE", "%"], ["Gwarm", "%"], ["Dwell", "ms"]];

function search(q) {
  return CH.map(([n, u]) => ({ n, s: CS.score(q, n, u) })).filter((h) => h.s >= 0).sort((a, b) => a.s - b.s).map((h) => h.n);
}

assert.deepStrictEqual(CS.about("CLT")[0], "Coolant temp");
assert.deepStrictEqual(CS.about("coolant temperature")[0], "Coolant temp");
assert.strictEqual(CS.about("CLT sensor voltage"), null, "a sensor's voltage isn't the sensor");
assert.deepStrictEqual(CS.about("MAT")[0], "Intake air temp");
assert.deepStrictEqual(CS.about("AFR Target 1")[0], "Target AFR");
assert.deepStrictEqual(CS.about("EGO cor1")[0], "AFR correction (closed-loop trim)");
assert.deepStrictEqual(CS.about("Batt V")[0], "Battery voltage");

assert.deepStrictEqual(search("coolant temp"), ["CLT", "Coolant"]);
assert.deepStrictEqual(search("Coolant Temp"), ["CLT", "Coolant"]);
assert.deepStrictEqual(search("intake air temp"), ["MAT", "IAT"]);
assert.ok(search("timing").includes("Advance") && search("timing").includes("SPK: Spark Advance"));
assert.ok(search("boost").includes("MAP") && search("boost").includes("Boost Duty"));
assert.strictEqual(search("boost duty")[0], "Boost Duty");
assert.ok(search("wideband").includes("AFR"));
assert.strictEqual(search("target afr")[0], "AFR Target 1");
assert.ok(search("battery").includes("Batt V"));
assert.ok(search("injector duty").includes("Duty Cycle1"));
assert.ok(search("warmup").includes("Gwarm"));
assert.ok(search("speed").includes("VSS"));
assert.ok(search("clt").includes("CLT"), "the factory names still work");
assert.deepStrictEqual(search("zzz"), []);
assert.strictEqual(CS.score("", "anything", ""), 0, "an empty search shows everything");
console.log("all channel search tests passed");
