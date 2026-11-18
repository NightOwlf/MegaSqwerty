/* What FOME / rusEFI's codes mean: why fuel or spark was cut (the "Fuel: Cut Code" / "Ign: Cut Code" channels,
   from the ECU's own fuelIgnCutCodeList), and the warning / error codes ("Warning: last", recentErrorCode1-8).
   Error codes below 3500 are standard OBD-II codes (P0335 and so on); higher ones are the firmware's own. */
(function () {
  "use strict";
  var CUT = ["None", "fatal error", "setting disabled", "RPM limit", "fault RPM limit", "boost cut", "oil pressure",
             "stop requested", "ETB problem", "launch control", "max injector duty", "flood clear", "engine sync",
             "kickstart", "ign off", "Lua", "ACR", "Lambda Prot"];
  // why each cut happens, in plain words
  var CUT_WHY = {
    "fatal error": "the ECU hit a fatal error and stopped fuel or spark to protect the engine",
    "setting disabled": "fuel or spark is turned off in the settings",
    "RPM limit": "the rev limiter (or a soft limit) cut in",
    "fault RPM limit": "a sensor fault dropped the rev limit to a safe value and it was reached",
    "boost cut": "boost went over the boost-cut pressure",
    "oil pressure": "oil pressure protection",
    "stop requested": "the engine was asked to stop",
    "ETB problem": "an electronic throttle fault",
    "launch control": "launch control was holding RPM",
    "max injector duty": "the injectors hit their maximum duty cycle",
    "flood clear": "flood clear: throttle floored while cranking",
    "engine sync": "the ECU didn't have trigger sync (normal when the engine is stopped or just starting)",
    "kickstart": "kickstart",
    "ign off": "the ignition input was off",
    "Lua": "a Lua script asked for the cut",
    "ACR": "the decompression (ACR) valve",
    "Lambda Prot": "lambda protection: the mixture went lean under load"
  };
  var OBD = {
    105: "MAP sensor circuit", 106: "MAP sensor range / performance", 107: "MAP sensor reads low", 108: "MAP sensor reads high",
    110: "Intake air temp sensor circuit", 112: "Intake air temp sensor reads low", 113: "Intake air temp sensor reads high",
    115: "Coolant temp sensor circuit", 117: "Coolant temp sensor reads low", 118: "Coolant temp sensor reads high",
    120: "Throttle position sensor A circuit", 122: "TPS A reads low", 123: "TPS A reads high",
    130: "O2 / wideband sensor circuit", 220: "Throttle position sensor B circuit", 222: "TPS B reads low", 223: "TPS B reads high",
    300: "Random / multiple cylinder misfire", 325: "Knock sensor circuit", 335: "Crankshaft position sensor circuit",
    340: "Camshaft position sensor circuit", 500: "Vehicle speed sensor", 560: "System (battery) voltage",
    2120: "Pedal position sensor D circuit", 2122: "Pedal sensor D reads low", 2123: "Pedal sensor D reads high",
    2125: "Pedal position sensor E circuit", 2127: "Pedal sensor E reads low", 2128: "Pedal sensor E reads high",
    2135: "Throttle sensors A / B disagree", 2138: "Pedal sensors D / E disagree"
  };
  function cutText(code) {
    code = Math.round(+code);
    var name = CUT[code];
    return name ? name : "code " + code;
  }
  function cutWhy(code) { return CUT_WHY[CUT[Math.round(+code)]] || ""; }
  function errText(code) {
    code = Math.round(+code);
    if (!code) return "";
    if (code < 3500) return "P" + ("000" + code).slice(-4) + (OBD[code] ? ": " + OBD[code] : "");
    return "firmware code " + code;
  }
  window.MSQCodes = { CUT: CUT, cutText: cutText, cutWhy: cutWhy, errText: errText };
})();
