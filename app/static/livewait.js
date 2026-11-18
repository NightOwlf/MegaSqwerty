/* "Waiting for the car": the live session isn't on the server right now (it restarted). A tuner's page keeps
   checking (it reloads) and goes live when the car's laptop starts the session again. If this is the car's own
   laptop, it starts it: back to the live page, which opens the project and the ECU by itself. */
(function () {
  "use strict";
  try {
    var m = /^\/live\/([A-Za-z0-9]{12})$/.exec(location.pathname), k = new URLSearchParams(location.search).get("k");
    var car = JSON.parse(localStorage.getItem("msq.live.car") || "null");
    if (m && car && car.id === m[1] && car.car_key === k) location.replace("/live");
  } catch (e) { /* not the car */ }
})();
