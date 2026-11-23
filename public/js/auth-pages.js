/* Login, sign-up and forgot-password page behaviour. Requires js/auth.js. */
(function () {
  "use strict";

  var page = document.body.getAttribute("data-page");
  var ICONS = {
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
  };
  var EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A10.6 10.6 0 0 1 12 4c6.5 0 10 8 10 8a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6A17.3 17.3 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  var alertBox = document.getElementById("alert");

  function showAlert(type, message) {
    if (!alertBox) return;
    var cls = type === "error" ? "alert-error" : type === "success" ? "alert-success" : "alert-info";
    alertBox.className = "alert " + cls;
    alertBox.innerHTML = (ICONS[type] || ICONS.info) + "<div></div>";
    alertBox.lastChild.textContent = message;
    alertBox.setAttribute("role", type === "error" ? "alert" : "status");
  }
  function clearAlert() { if (alertBox) { alertBox.className = "alert hidden"; alertBox.textContent = ""; } }

  function setLoading(btn, loading, label) {
    if (loading) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + (label || "Please wait…");
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }

  function fieldError(input, message) {
    var err = document.getElementById(input.id + "-error");
    input.setAttribute("aria-invalid", message ? "true" : "false");
    if (err) err.textContent = message || "";
  }
  function clearFieldErrors(form) {
    form.querySelectorAll(".input").forEach(function (i) { fieldError(i, ""); });
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Password show/hide toggles
  document.querySelectorAll(".password-toggle").forEach(function (btn) {
    var input = document.getElementById(btn.getAttribute("data-target"));
    btn.innerHTML = EYE;
    btn.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = show ? EYE_OFF : EYE;
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      input.focus();
    });
  });

  // Clear an input's error as the user edits it
  document.querySelectorAll(".input").forEach(function (input) {
    input.addEventListener("input", function () { fieldError(input, ""); });
  });

  var badge = document.getElementById("modeBadge");
  if (badge && location.protocol === "file:") {
    badge.textContent = "⚠ Opened as a file: use Live Server or your Firebase URL for Google sign-in and location";
    badge.classList.remove("hidden");
  }

  HTAuth.ready.catch(function (err) {
    showAlert("error", HTAuth.friendlyError(err));
  });

  HTAuth.ready.then(async function (backend) {
    var googleBlock = document.getElementById("googleBlock");
    if (googleBlock) googleBlock.classList.remove("hidden");

    if (page === "login" || page === "signup") {
      // Finish a Google sign-in that used the redirect fallback.
      try {
        if (await backend.completeRedirect()) { location.replace(HTAuth.nextPage("finder.html")); return; }
      } catch (err) {
        showAlert("error", HTAuth.friendlyError(err));
      }
      // Already signed in? Skip the login / sign-up screens.
      HTAuth.currentUser().then(function (u) {
        if (u) location.replace(HTAuth.nextPage("finder.html"));
      });
    }

    var googleBtn = document.getElementById("googleBtn");
    if (googleBtn) {
      googleBtn.addEventListener("click", async function () {
        clearAlert();
        setLoading(googleBtn, true, "Opening Google…");
        try {
          await backend.signInWithGoogle();
          location.href = HTAuth.nextPage("finder.html");
        } catch (err) {
          showAlert("error", HTAuth.friendlyError(err));
          setLoading(googleBtn, false);
        }
      });
    }

    if (page === "login") initLogin(backend);
    if (page === "signup") initSignup(backend);
    if (page === "forgot") initForgot(backend);
  });

  function initLogin(backend) {
    var form = document.getElementById("loginForm");
    var email = document.getElementById("email");
    var password = document.getElementById("password");
    var btn = form.querySelector("button[type=submit]");

    var params = new URLSearchParams(location.search);
    if (params.get("reset") === "1") showAlert("success", "Check your inbox for a password reset link.");
    if (params.get("next")) showAlert("info", "Please log in to continue.");

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clearAlert(); clearFieldErrors(form);
      var ok = true;
      if (!EMAIL_RE.test(email.value.trim())) { fieldError(email, "Enter a valid email address."); ok = false; }
      if (!password.value) { fieldError(password, "Enter your password."); ok = false; }
      if (!ok) return;

      setLoading(btn, true, "Logging in…");
      try {
        await backend.signIn(email.value.trim(), password.value);
        location.href = HTAuth.nextPage("finder.html");
      } catch (err) {
        showAlert("error", HTAuth.friendlyError(err));
        setLoading(btn, false);
      }
    });
  }

  function scorePassword(pw) {
    if (!pw) return 0;
    var s = 0;
    if (pw.length >= 8) s++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 12) s++;
    return Math.max(1, s);
  }

  function initSignup(backend) {
    var form = document.getElementById("signupForm");
    var name = document.getElementById("name");
    var email = document.getElementById("email");
    var password = document.getElementById("password");
    var confirm = document.getElementById("confirm");
    var meter = document.getElementById("strength");
    var hint = document.getElementById("password-hint");
    var btn = form.querySelector("button[type=submit]");
    var LABELS = ["", "Weak", "Fair", "Good", "Strong"];

    password.addEventListener("input", function () {
      var s = scorePassword(password.value);
      meter.setAttribute("data-score", String(s));
      hint.textContent = s ? "Strength: " + LABELS[s] : "Use 8+ characters with a mix of letters, numbers and symbols.";
    });

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clearAlert(); clearFieldErrors(form);
      var ok = true;
      if (!name.value.trim()) { fieldError(name, "Enter your full name."); ok = false; }
      if (!EMAIL_RE.test(email.value.trim())) { fieldError(email, "Enter a valid email address."); ok = false; }
      if (password.value.length < 8) { fieldError(password, "Use at least 8 characters."); ok = false; }
      if (confirm.value !== password.value) { fieldError(confirm, "Passwords don't match."); ok = false; }
      if (!ok) return;

      setLoading(btn, true, "Creating account…");
      try {
        await backend.signUp(name.value.trim(), email.value.trim(), password.value);
        location.href = HTAuth.nextPage("finder.html");
      } catch (err) {
        showAlert("error", HTAuth.friendlyError(err));
        setLoading(btn, false);
      }
    });
  }

  function initForgot(backend) {
    var form = document.getElementById("forgotForm");
    var email = document.getElementById("email");
    var btn = form.querySelector("button[type=submit]");

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clearAlert(); clearFieldErrors(form);
      if (!EMAIL_RE.test(email.value.trim())) { fieldError(email, "Enter a valid email address."); return; }

      setLoading(btn, true, "Sending…");
      try {
        var result = await backend.resetPassword(email.value.trim());
        if (result && result.demo) {
          showAlert("info", "Demo mode can't send emails. Deploy to Firebase Hosting to enable real password reset emails, or create a new account.");
        } else {
          // Same message whether or not the account exists, so emails can't be probed.
          showAlert("success", "If an account exists for " + email.value.trim() + ", a reset link is on its way. Check your inbox and spam folder.");
          form.reset();
        }
      } catch (err) {
        if (err && err.code === "auth/user-not-found") {
          showAlert("success", "If an account exists for " + email.value.trim() + ", a reset link is on its way. Check your inbox and spam folder.");
        } else {
          showAlert("error", HTAuth.friendlyError(err));
        }
      }
      setLoading(btn, false);
    });
  }
})();
