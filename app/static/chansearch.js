/* Finding a channel by what it is, not what the firmware calls it. TunerStudio / FOME / rusEFI / Speeduino name the
   same thing differently ("CLT", "Coolant", "coolant temperature"), so every channel gets a plain name and a set of
   everyday words, and a search matches either: "coolant temp" finds CLT, "timing" finds Advance, "boost" finds MAP.
   Used by the log graphs' channel picker (viewer.js) and the live page's "Add a gauge" (live.js).
   Tested in tests/js/chansearch.test.js. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CHANSEARCH = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // [plain name, everyday words, pattern on the squashed name ("Coolant Temp" -> "coolanttemp")]. First match wins,
  // so the specific ones (targets, corrections) come before the general ones.
  var ALIASES = [
    ["Time", "time seconds clock", /^(time|seconds|secl|timestamp)$/],
    ["Engine RPM", "rpm engine speed revs tach tachometer", /^(rpm|enginerpm|enginespeed|speedrpm)$/],
    ["Target AFR", "target afr air fuel ratio lambda mixture goal commanded", /(afrtarget|targetafr|afrtgt|lambdatarget|targetlambda|fueltargetlambda|fueltargetafr|lambdatgt|airfuelratiotarget)/],
    ["AFR correction (closed-loop trim)", "ego o2 correction closed loop fuel trim stft afr correction", /^(egocor|o2cor|o2correction|shorttermfueltrim|stft|closedloopcor|fueltrim|fuelpidcorrection|lambdacorrection|egocorrection)/],
    ["AFR (wideband)", "afr air fuel ratio wideband o2 oxygen sensor lambda mixture ego", /^(afr[12]?|widebandafr|wbafr|airfuelratio|lambda[12]?|lambdavalue|ego[12]?|o2|afrcorrected|wbo2|lambda1value)$/],
    ["Boost target", "boost target goal psi kpa", /(boosttarget|targetboost|boostcontroltarget|boostkpatarget)/],
    ["Boost control duty", "boost control duty wastegate solenoid pwm output", /(boostoutput|boostduty|boostpwm|bcduty|wastegateduty|boostcontrolduty|boostcontroloutput)/],
    ["Boost pressure", "boost pressure psi turbo manifold", /^boost(psi|pressure|kpa)?$/],
    ["Manifold pressure (MAP)", "map manifold absolute pressure boost vacuum load kpa psi", /^(map|mapkpa|manifoldpressure|manifoldabsolutepressure|mapvalue|mapfast)$/],
    ["Barometric pressure", "baro barometric pressure altitude atmosphere", /^(baro|barometric|baropressure|barometer)/],
    ["Throttle position (TPS)", "tps throttle position pedal", /^(tps1?|throttle|tpsposition|throttleposition|tpsvalue)/],
    ["Accelerator pedal", "pedal accelerator app gas pedal throttle", /^(pedal|app|acceleratorpedal|throttlepedal)/],
    ["Coolant temp", "coolant temperature temp engine water clt ect", /^(clt|coolant|cltdeg|enginetemp|watertemp|ect$)/],
    ["Intake air temp", "intake air temperature temp iat mat charge manifold air", /^(iat|mat|intakeair|intaketemp|chargetemp|airtemp|manifoldairtemp)/],
    ["Oil temp", "oil temperature temp", /oiltemp/],
    ["Oil pressure", "oil pressure", /oilpress/],
    ["Fuel pressure", "fuel pressure rail", /(fuelpress|^fp$|railpressure)/],
    ["Exhaust gas temp (EGT)", "egt exhaust gas temperature temp", /^(egt\d?|exhausttemp|exhaustgastemp)/],
    ["Ignition advance", "ignition timing spark advance degrees", /(^advance|^timing$|^ignadv|^spkadv|ignitionadvance|sparkadvance|igntiming|ignitiontiming)/],
    ["Knock retard", "knock retard detonation pinging ping", /(knockretard|knock|detonation|knkretard|ignitionretard)/],
    ["Coil dwell", "dwell coil charge time ignition", /dwell/],
    ["VE (volumetric efficiency)", "ve volumetric efficiency fuel table", /^(fuelve|vecurr|vecurrent|ve[12]?$|vetable[12]?$|vevalue)/],
    ["Injector pulse width", "injector pulse width pw fuel ms", /^(pw[12]?|pulsewidth|injpulsewidth|injectorpulsewidth|fuellastinjpulsewidth|actualpw)/],
    ["Injector duty", "injector duty cycle dc fuel", /(injduty|injectorduty|^dutycycle\d?$|fuelinjectorduty|injectorssduty)/],
    ["Warm-up enrichment", "warmup warm up enrichment cold start wue", /^(warmup|wue|warmupenrich|warmupcor|gwarm|warmupenrichment)/],
    ["Accel enrichment", "accel acceleration enrichment pump tps ae", /^(accelenrich|tpsaccel|accel$|aeamount|tpsae|mapae|accelenrichment)/],
    ["Total fuel correction", "total fuel correction enrichment gamma", /^(gammae|gammaenrich|totalcor|totalfuelcorrection)/],
    ["Air density correction", "air density correction iat", /^(aircor|airdensity|densitycor)/],
    ["Idle target RPM", "idle target rpm", /(idletarget|targetidle|idlerpmtarget)/],
    ["Idle valve position", "idle air control valve iac position steps duty", /(^iac|idlevalve|idleposition|idleair|idlestep|idleduty|idlecontrol)/],
    ["Battery voltage", "battery voltage volts batt charging alternator", /^(batt|vbatt|vbat|batteryvoltage|voltage$)/],
    ["Vehicle speed", "speed vehicle vss mph kph road wheel", /^(vss|vehiclespeed|speed$|roadspeed|wheelspeed)/],
    ["Gear", "gear transmission", /^(gear|currentgear|detectedgear|gearnumber)/],
    ["Ethanol content", "ethanol flex fuel content e85 composition", /(ethanol|flexfuel|fuelcomposition|flex$)/],
    ["Engine load", "load engine load fuel load", /^(fuelload|engineload|load$|ignitionload|ignload)/],
    ["Cooling fan", "cooling fan radiator", /fan/],
    ["Fuel pump", "fuel pump", /fuelpump/],
    ["Sync loss", "sync loss trigger crank cam", /sync/],
    ["Launch control", "launch control", /launch/]
  ];
  // Names that look like a sensor but are its voltage, raw reading or a fault flag: not the sensor itself.
  var NOT_SENSOR = /volt|adc|raw|err|fault|diag|code|status|state|flag|enable|count|timeout|accuracy|sensor$|min$|max$/;

  function key(name) { return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  /* -> [plain name, everyday words] for a channel, or null when it isn't one we know. */
  function about(name) {
    var k = key(name);
    if (!k) return null;
    for (var i = 0; i < ALIASES.length; i++) {
      var a = ALIASES[i];
      if (!a[2].test(k)) continue;
      if (NOT_SENSOR.test(k) && !/volt/.test(a[1])) return null;
      return [a[0], a[1]];
    }
    return null;
  }

  function words(q) { return String(q || "").trim().toLowerCase().split(/[\s,]+/).filter(Boolean); }

  /* How well a channel answers a search: -1 when it doesn't; lower is better. Every word must appear in the
     channel's name, units, plain name or everyday words. A match on the plain name beats one on the firmware's
     name, which beats one found only through the everyday words. */
  function score(q, name, units, label) {
    var w = Array.isArray(q) ? q : words(q);
    if (!w.length) return 0;
    var a = about(name), plain = ((a ? a[0] : "") + " " + (label || "")).toLowerCase(), own = (String(name) + " " + (units || "")).toLowerCase();
    var hay = plain + " " + own + " " + key(name) + " " + (a ? a[1] : ""), best = 3;
    // each word has to start a word ("oil" finds Oil temp, not Coil dwell); the squashed name counts as one word
    var at = function (s, x) { var k = s.indexOf(x); while (k > 0 && /[a-z0-9]/.test(s.charAt(k - 1))) k = s.indexOf(x, k + 1); return k; };
    for (var i = 0; i < w.length; i++) if (at(hay, w[i]) < 0) return -1;
    var all = function (s) { for (var j = 0; j < w.length; j++) if (at(s, w[j]) < 0) return false; return true; };
    if (a && all(a[0].toLowerCase())) best = a[0].toLowerCase().indexOf(w[0]) === 0 ? 0 : 1;
    else if (all(own)) best = own.indexOf(w[0]) === 0 ? 1 : 2;
    return best;
  }

  // Shown under the search box: things worth typing.
  var EXAMPLES = "coolant temp, intake air temp, boost, AFR, timing, knock, injector duty, battery…";

  return { about: about, score: score, words: words, key: key, ALIASES: ALIASES, EXAMPLES: EXAMPLES };
});
