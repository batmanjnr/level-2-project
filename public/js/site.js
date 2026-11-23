/* Shared header behaviour: shows the right buttons for signed-in / signed-out users. */
(function () {
  "use strict";

  var year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();

  HTAuth.ready.then(function (backend) {
    backend.onChange(function (user) {
      document.querySelectorAll('[data-auth="in"]').forEach(function (el) { el.classList.toggle("hidden", !user); });
      document.querySelectorAll('[data-auth="out"]').forEach(function (el) { el.classList.toggle("hidden", !!user); });
      if (!user) return;
      var label = user.name || user.email || "";
      document.querySelectorAll("[data-user-name]").forEach(function (el) { el.textContent = label; });
      document.querySelectorAll("[data-user-initial]").forEach(function (el) { el.textContent = label.charAt(0).toUpperCase(); });
    });

    document.querySelectorAll("[data-signout]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        await backend.signOut();
        location.href = "login.html";
      });
    });
  });
})();
