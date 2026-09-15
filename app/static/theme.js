/* Loaded synchronously in <head> so the saved theme applies before first paint. */
(function () {
  var t = null;
  try { t = localStorage.getItem("msq.theme"); } catch (e) { /* storage unavailable */ }
  if (t !== "light" && t !== "dark") {
    t = window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", t);
})();
