/*
 * Hospital Tracker — Firebase Authentication + Realtime Database layer.
 * Requires js/firebase-config.js to be loaded first.
 *
 * Exposes window.HTAuth with:
 *   ready            Promise<backend>
 *   currentUser()    Promise<user|null>   (first auth state)
 *   requireUser()    redirects to login.html when signed out
 *   friendlyError(e) human-readable message for Firebase errors
 *   nextPage(def)    safe ?next= target
 *
 * Database layout (see database.rules.json):
 *   users/{uid}               profile: name, email, photoURL, provider, createdAt, lastLoginAt
 *   saved/{uid}/{placeKey}    saved hospitals
 *   searches/{uid}/{pushId}   recent place searches
 */
(function () {
  "use strict";

  var FIREBASE_VERSION = "10.12.2";
  var SDK = "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/";

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  function authError(code) { var e = new Error(code); e.code = code; return e; }

  function toUser(u) {
    if (!u) return null;
    return { uid: u.uid, email: u.email, name: u.displayName || "", photoURL: u.photoURL || "" };
  }

  async function init() {
    var config = window.HT_FIREBASE_CONFIG;
    if (!config || !config.apiKey) throw authError("app/no-config");

    await loadScript(SDK + "firebase-app-compat.js");
    await Promise.all([
      loadScript(SDK + "firebase-auth-compat.js"),
      loadScript(SDK + "firebase-database-compat.js")
    ]);

    var fb = window.firebase;
    var app = fb.apps.length ? fb.app() : fb.initializeApp(config);
    var auth = app.auth();
    var db = app.database();

    /** Create or update users/{uid} after any successful sign-in. */
    async function saveProfile(u, isNew, provider) {
      var ref = db.ref("users/" + u.uid);
      var now = fb.database.ServerValue.TIMESTAMP;
      var data = {
        name: u.displayName || "",
        email: u.email || "",
        photoURL: u.photoURL || "",
        provider: provider,
        lastLoginAt: now
      };
      if (isNew) data.createdAt = now;
      try { await ref.update(data); }
      catch (e) { console.warn("[HTAuth] Could not save profile (check database rules):", e.message); }
    }

    return {
      firebase: fb,
      auth: auth,
      db: db,

      onChange: function (cb) {
        return auth.onAuthStateChanged(function (u) { cb(toUser(u)); });
      },

      signIn: async function (email, password) {
        var cred = await auth.signInWithEmailAndPassword(email, password);
        await saveProfile(cred.user, false, "password");
        return toUser(cred.user);
      },

      signUp: async function (name, email, password) {
        var cred = await auth.createUserWithEmailAndPassword(email, password);
        if (name) await cred.user.updateProfile({ displayName: name });
        await saveProfile(cred.user, true, "password");
        return toUser(cred.user);
      },

      signInWithGoogle: async function () {
        if (location.protocol === "file:") throw authError("app/file-protocol");
        var provider = new fb.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        var cred;
        try {
          cred = await auth.signInWithPopup(provider);
        } catch (e) {
          // Pop-ups are often blocked on mobile; fall back to a full-page redirect.
          if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
            await auth.signInWithRedirect(provider);
            return new Promise(function () {});
          }
          throw e;
        }
        var isNew = !!(cred.additionalUserInfo && cred.additionalUserInfo.isNewUser);
        await saveProfile(cred.user, isNew, "google");
        return toUser(cred.user);
      },

      /** Completes a Google redirect sign-in (if one is in progress). */
      completeRedirect: async function () {
        var cred = await auth.getRedirectResult();
        if (cred && cred.user) {
          var isNew = !!(cred.additionalUserInfo && cred.additionalUserInfo.isNewUser);
          await saveProfile(cred.user, isNew, "google");
          return toUser(cred.user);
        }
        return null;
      },

      resetPassword: function (email) {
        return auth.sendPasswordResetEmail(email).then(function () { return { sent: true }; });
      },

      signOut: function () { return auth.signOut(); }
    };
  }

  var ready = init();
  ready.catch(function (e) { console.error("[HTAuth] Firebase failed to start:", e); });

  var MESSAGES = {
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/missing-password": "Please enter your password.",
    "auth/user-not-found": "Incorrect email or password.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/invalid-login-credentials": "Incorrect email or password.",
    "auth/user-disabled": "This account has been disabled.",
    "auth/email-already-in-use": "An account with this email already exists. Try logging in instead.",
    "auth/account-exists-with-different-credential": "This email is already registered with a different sign-in method. Log in with email and password.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
    "auth/network-request-failed": "Network error. Check your connection and try again.",
    "auth/popup-closed-by-user": "The Google sign-in window was closed before finishing.",
    "auth/cancelled-popup-request": "The Google sign-in window was closed before finishing.",
    "auth/operation-not-allowed": "This sign-in method isn't enabled. Enable it in Firebase Console → Authentication → Sign-in method.",
    "auth/unauthorized-domain": "This address isn't allowed to use Google sign-in. Add it in Firebase Console → Authentication → Settings → Authorized domains (e.g. 127.0.0.1 for Live Server).",
    "app/file-protocol": "Google sign-in doesn't work when the page is opened as a file. Open the site with VS Code Live Server or from your Firebase Hosting URL.",
    "app/no-config": "Firebase isn't configured. Check js/firebase-config.js.",
    "PERMISSION_DENIED": "The database refused this request. Publish the rules from database.rules.json in Firebase Console → Realtime Database → Rules."
  };

  function friendlyError(err) {
    if (!err) return "Something went wrong. Please try again.";
    if (MESSAGES[err.code]) return MESSAGES[err.code];
    if (/permission[_ ]denied/i.test(err.message || "")) return MESSAGES.PERMISSION_DENIED;
    if (/Failed to load https:\/\/www\.gstatic/.test(err.message || "")) return "Couldn't reach Firebase. Check your internet connection and reload.";
    return err.message || "Something went wrong. Please try again.";
  }

  function nextPage(fallback) {
    var next = new URLSearchParams(location.search).get("next");
    return next && /^[\w-]+\.html$/.test(next) ? next : fallback;
  }

  function currentUser() {
    return ready.then(function (b) {
      return new Promise(function (resolve) {
        var done = false, unsub = null;
        unsub = b.onChange(function (u) {
          if (done) return;
          done = true;
          resolve(u);
          setTimeout(function () { if (unsub) unsub(); }, 0);
        });
      });
    });
  }

  async function requireUser() {
    var user = await currentUser();
    if (!user) {
      var here = location.pathname.split("/").pop() || "index.html";
      location.replace("login.html?next=" + encodeURIComponent(here));
      return new Promise(function () {});
    }
    return user;
  }

  window.HTAuth = {
    ready: ready,
    friendlyError: friendlyError,
    nextPage: nextPage,
    currentUser: currentUser,
    requireUser: requireUser
  };
})();
