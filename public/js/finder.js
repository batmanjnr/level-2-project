/*
 * Hospital finder
 *  - Location: browser geolocation or place search (OpenStreetMap Nominatim)
 *  - Facilities: OpenStreetMap Overpass API
 *  - Map: Leaflet with CARTO basemap tiles
 *  - Saved hospitals + recent searches: Firebase Realtime Database (per user)
 */
(function () {
  "use strict";

  var OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  var NOMINATIM = "https://nominatim.openstreetmap.org/search";
  var MAX_RESULTS = 60;

  var els = {
    locate: document.getElementById("locateBtn"),
    form: document.getElementById("searchForm"),
    place: document.getElementById("place"),
    radius: document.getElementById("radius"),
    clinics: document.getElementById("includeClinics"),
    emergency: document.getElementById("emergencyOnly"),
    list: document.getElementById("results"),
    summary: document.getElementById("resultsSummary"),
    tabNearby: document.getElementById("tabNearby"),
    tabSaved: document.getElementById("tabSaved"),
    savedCount: document.getElementById("savedCount"),
    recent: document.getElementById("recent"),
    recentList: document.getElementById("recentList")
  };

  var map, markersLayer, meMarker, radiusCircle;
  var origin = null;        // { lat, lon, label }
  var allResults = [];      // nearby facilities from Overpass
  var saved = {};           // key -> saved place (live from Realtime Database)
  var savedError = null;
  var view = "nearby";      // "nearby" | "saved"
  var nearbyState = null;   // last non-list state for the Nearby tab (loading/error/idle)
  var markerById = {};
  var activeId = null;
  var requestSeq = 0;
  var backend = null, user = null;

  var CROSS = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/></svg>';
  var ICON = {
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-12a7 7 0 1 1 14 0c0 5.8-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    nav: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 11 19-9-9 19-2-8-8-2Z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
    web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
  };

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function distanceKm(a, b) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
    var h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function formatDistance(km) {
    return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 1 : 0) + " km";
  }
  function safeUrl(u) {
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try { var url = new URL(u); return /^https?:$/.test(url.protocol) ? url.href : null; } catch (e) { return null; }
  }
  function telHref(phone) {
    if (!phone) return null;
    var first = String(phone).split(/[;,]/)[0].trim();
    var cleaned = first.replace(/[^\d+]/g, "");
    return cleaned.length >= 3 ? { href: "tel:" + cleaned, label: first } : null;
  }
  function formatAddress(t) {
    var line1 = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
    var parts = [line1, t["addr:suburb"], t["addr:city"] || t["addr:town"] || t["addr:village"], t["addr:postcode"]].filter(Boolean);
    return parts.join(", ") || t["addr:full"] || "";
  }
  // Realtime Database keys can't contain "/", ".", "#", "$", "[", "]"
  function keyFor(id) { return String(id).replace(/[\/.#$\[\]]/g, "_"); }

  /* ---------------- Realtime Database ---------------- */
  function savedRef(key) { return backend.db.ref("saved/" + user.uid + (key ? "/" + key : "")); }

  function toggleSave(r, btn) {
    var key = keyFor(r.id);
    btn.disabled = true;
    var op = saved[key]
      ? savedRef(key).remove()
      : savedRef(key).set({
          name: String(r.name).slice(0, 200),
          lat: r.lat, lon: r.lon,
          kind: r.kind,
          emergency: !!r.emergency,
          address: String(r.address || "").slice(0, 300),
          phone: r.phone ? String(r.phone.label).slice(0, 60) : "",
          website: String(r.website || "").slice(0, 500),
          osmId: String(r.id).slice(0, 40),
          savedAt: backend.firebase.database.ServerValue.TIMESTAMP
        });
    op.catch(function (err) {
      console.error(err);
      btn.disabled = false;
      alert(HTAuth.friendlyError(err));
    });
    // The live listener re-renders on success.
  }

  function savedAsResults() {
    return Object.keys(saved).map(function (key) {
      var s = saved[key];
      return {
        id: s.osmId || key,
        name: s.name, lat: s.lat, lon: s.lon,
        kind: s.kind || "hospital",
        emergency: !!s.emergency,
        hours: "",
        address: s.address || "",
        phone: telHref(s.phone),
        website: safeUrl(s.website),
        distance: origin ? distanceKm(origin, { lat: s.lat, lon: s.lon }) : null,
        savedAt: s.savedAt || 0
      };
    }).sort(function (a, b) {
      return origin ? a.distance - b.distance : b.savedAt - a.savedAt;
    });
  }

  function listenSaved() {
    savedRef().on("value", function (snap) {
      saved = snap.val() || {};
      savedError = null;
      els.savedCount.textContent = Object.keys(saved).length;
      render();
    }, function (err) {
      console.error("[finder] saved places:", err);
      savedError = err;
      if (view === "saved") render();
    });
  }

  function recordSearch(place) {
    backend.db.ref("searches/" + user.uid).push({
      label: place.label.slice(0, 120), lat: place.lat, lon: place.lon,
      at: backend.firebase.database.ServerValue.TIMESTAMP
    }).catch(function (err) { console.warn("[finder] could not save search:", err.message); });
  }

  function listenRecent() {
    backend.db.ref("searches/" + user.uid).orderByChild("at").limitToLast(15).on("value", function (snap) {
      var items = [], seen = {};
      snap.forEach(function (child) { items.push(child.val()); });
      items.reverse();
      items = items.filter(function (s) {
        var k = String(s.label).toLowerCase();
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      }).slice(0, 5);

      els.recent.classList.toggle("hidden", !items.length);
      els.recentList.innerHTML = "";
      items.forEach(function (s) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = s.label;
        b.addEventListener("click", function () {
          els.place.value = s.label;
          origin = { lat: s.lat, lon: s.lon, label: s.label };
          showView("nearby");
          loadFacilities();
        });
        els.recentList.appendChild(b);
      });
    }, function (err) { console.warn("[finder] recent searches:", err.message); });
  }

  /* ---------------- rendering ---------------- */
  function stateHtml(icon, tone, title, text, actionLabel) {
    return '<li class="state">' +
      '<span class="icon-tile ' + (tone || "") + '">' + icon + "</span>" +
      "<h3>" + esc(title) + "</h3><p>" + esc(text) + "</p>" +
      (actionLabel ? '<button type="button" class="btn btn-secondary btn-sm" data-state-action>' + esc(actionLabel) + "</button>" : "") +
      "</li>";
  }

  /** Show a message in the Nearby tab (kept so switching tabs restores it). */
  function setNearbyState(icon, tone, title, text, action) {
    nearbyState = { html: stateHtml(icon, tone, title, text, action && action.label), run: action && action.run };
    if (view === "nearby") paintNearbyState();
  }
  function paintNearbyState() {
    markersLayer.clearLayers();
    markerById = {};
    els.list.innerHTML = nearbyState.html;
    var btn = els.list.querySelector("[data-state-action]");
    if (btn && nearbyState.run) btn.addEventListener("click", nearbyState.run);
  }

  function setNearbyLoading(summary) {
    var html = "";
    for (var i = 0; i < 5; i++) html += '<li class="skeleton" aria-hidden="true"><div></div><div></div><div></div></li>';
    nearbyState = { html: html };
    if (view === "nearby") { els.summary.textContent = summary; paintNearbyState(); }
  }

  function visibleNearby() {
    return allResults.filter(function (r) {
      if (!els.clinics.checked && r.kind === "clinic") return false;
      if (els.emergency.checked && !r.emergency) return false;
      return true;
    });
  }

  function itemHtml(r) {
    var key = keyFor(r.id);
    var isSaved = !!saved[key];
    var badges = '<span class="badge ' + (r.kind === "clinic" ? "clinic" : "") + '">' + (r.kind === "clinic" ? "Clinic" : "Hospital") + "</span>";
    if (r.emergency) badges += '<span class="badge er">Emergency</span>';
    if (r.hours) badges += '<span class="badge">' + esc(r.hours === "24/7" ? "Open 24/7" : r.hours) + "</span>";

    var actions = '<a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=' + r.lat + "," + r.lon + '">' + ICON.nav + "Directions</a>";
    if (r.phone) actions += '<a class="btn btn-secondary btn-sm" href="' + esc(r.phone.href) + '">' + ICON.phone + "Call</a>";
    if (r.website) actions += '<a class="btn btn-secondary btn-sm" target="_blank" rel="noopener" href="' + esc(r.website) + '">' + ICON.web + "Website</a>";
    actions += '<button type="button" class="btn btn-secondary btn-sm btn-save' + (isSaved ? " saved" : "") + '" data-save="' + esc(r.id) + '" aria-pressed="' + isSaved + '">' +
      ICON.bookmark + (isSaved ? "Saved" : "Save") + "</button>";

    return '<li class="result" data-id="' + esc(r.id) + '" tabindex="0">' +
      '<div class="result-top"><div>' +
        '<div class="result-name">' + esc(r.name) + "</div>" +
        (r.address ? '<div class="result-meta">' + esc(r.address) + "</div>" : "") +
        (r.phone ? '<div class="result-meta">' + esc(r.phone.label) + "</div>" : "") +
      "</div>" +
      (r.distance != null ? '<span class="result-dist">' + formatDistance(r.distance) + "</span>" : "") +
      "</div>" +
      '<div class="badges">' + badges + "</div>" +
      '<div class="result-actions">' + actions + "</div>" +
    "</li>";
  }

  var currentItems = [];

  function paintList(items) {
    currentItems = items;
    els.list.innerHTML = items.map(itemHtml).join("");
    markersLayer.clearLayers();
    markerById = {};
    items.forEach(function (r) {
      var icon = L.divIcon({
        className: "",
        html: '<div class="marker-h ' + (r.kind === "clinic" ? "clinic" : "") + '">' + CROSS + "</div>",
        iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28]
      });
      var m = L.marker([r.lat, r.lon], { icon: icon, title: r.name, riseOnHover: true })
        .bindPopup("<strong>" + esc(r.name) + "</strong>" +
          (r.distance != null ? formatDistance(r.distance) + " away" : "") +
          (r.emergency ? " · Emergency" : ""))
        .on("click", function () { setActive(r.id, true); });
      m.addTo(markersLayer);
      markerById[r.id] = m;
    });
    if (activeId && markerById[activeId]) setActive(activeId, false);
  }

  function render() {
    if (!map) return;
    if (view === "saved") return renderSaved();

    if (!origin || nearbyState) {
      if (!nearbyState) {
        nearbyState = { html: stateHtml(ICON.pin, "", "Find care near you", "Use your current location or search for a city, area or address to see nearby hospitals.") };
        els.summary.textContent = "No search yet";
      }
      return paintNearbyState();
    }

    var items = visibleNearby();
    els.summary.innerHTML = "<strong>" + items.length + "</strong> " + (items.length === 1 ? "place" : "places") +
      " within " + Number(els.radius.value) / 1000 + " km of " + esc(origin.label);

    if (!items.length) {
      markersLayer.clearLayers();
      markerById = {};
      els.list.innerHTML = stateHtml(ICON.search, "", "Nothing found nearby",
        allResults.length ? "Try turning off filters or searching a wider area." : "Try a wider radius or a different location.",
        Number(els.radius.value) < 25000 ? "Search a wider area" : null);
      var btn = els.list.querySelector("[data-state-action]");
      if (btn) btn.addEventListener("click", widenSearch);
      return;
    }
    paintList(items);
  }

  function renderSaved() {
    if (savedError) {
      els.summary.textContent = "Saved places unavailable";
      markersLayer.clearLayers();
      els.list.innerHTML = stateHtml(ICON.alert, "red", "Couldn't load saved places", HTAuth.friendlyError(savedError));
      return;
    }
    var items = savedAsResults();
    var n = items.length;
    els.summary.innerHTML = "<strong>" + n + "</strong> saved " + (n === 1 ? "place" : "places") +
      (origin ? " · sorted by distance from " + esc(origin.label) : "");
    if (!n) {
      markersLayer.clearLayers();
      markerById = {};
      els.list.innerHTML = stateHtml(ICON.bookmark, "", "No saved places yet",
        "Tap Save on any hospital to keep it here. Saved places sync to your account on every device.");
      return;
    }
    paintList(items);
  }

  function showView(v) {
    view = v;
    els.tabNearby.classList.toggle("active", v === "nearby");
    els.tabSaved.classList.toggle("active", v === "saved");
    els.tabNearby.setAttribute("aria-selected", String(v === "nearby"));
    els.tabSaved.setAttribute("aria-selected", String(v === "saved"));
    activeId = null;
    render();
    if (v === "saved" && currentItems.length && !savedError) fitTo(currentItems);
    if (v === "nearby" && origin && !nearbyState) fitTo(visibleNearby().slice(0, 10));
  }

  function setActive(id, scrollList) {
    activeId = id;
    els.list.querySelectorAll(".result").forEach(function (li) {
      var on = li.getAttribute("data-id") === id;
      li.classList.toggle("active", on);
      if (on && scrollList) li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    Object.keys(markerById).forEach(function (k) {
      var el = markerById[k].getElement();
      if (el && el.firstChild) el.firstChild.classList.toggle("active", k === id);
    });
  }

  function fitTo(items) {
    if (!items.length) return;
    var bounds = L.latLngBounds(items.map(function (r) { return [r.lat, r.lon]; }));
    if (origin && view === "nearby") bounds.extend([origin.lat, origin.lon]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }

  /* ---------------- Overpass ---------------- */
  async function fetchOverpass(query, onRetry) {
    try {
      return await fetchOverpassOnce(query);
    } catch (e) {
      if (onRetry) onRetry();
      await wait(3000);
      return fetchOverpassOnce(query);
    }
  }

  async function fetchOverpassOnce(query) {
    var lastErr;
    for (var i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      var ctrl = "AbortController" in window ? new AbortController() : null;
      var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 15000);
      try {
        var res = await fetch(OVERPASS_ENDPOINTS[i], {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
          signal: ctrl ? ctrl.signal : undefined
        });
        if (!res.ok) throw new Error("Overpass HTTP " + res.status);
        return await res.json();
      } catch (e) {
        lastErr = e;
        console.warn("[finder] " + OVERPASS_ENDPOINTS[i] + " failed:", e.message || e);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function loadFacilities() {
    var seq = ++requestSeq;
    var r = Number(els.radius.value);
    var around = "(around:" + r + "," + origin.lat + "," + origin.lon + ")";
    var query = "[out:json][timeout:25];(" +
      'nwr["amenity"="hospital"]' + around + ";" +
      'nwr["healthcare"="hospital"]' + around + ";" +
      'nwr["amenity"="clinic"]' + around + ";" +
      'nwr["healthcare"="clinic"]' + around + ";" +
      ");out center tags;";

    setNearbyLoading("Searching near " + origin.label + "…");
    drawOrigin();

    try {
      var data = await fetchOverpass(query, function () {
        if (seq === requestSeq && view === "nearby") els.summary.textContent = "Map data servers are busy, retrying…";
      });
      if (seq !== requestSeq) return;

      var seen = {};
      allResults = (data.elements || []).map(function (el) {
        var t = el.tags || {};
        var lat = el.lat != null ? el.lat : el.center && el.center.lat;
        var lon = el.lon != null ? el.lon : el.center && el.center.lon;
        if (lat == null || lon == null) return null;
        var isHospital = t.amenity === "hospital" || t.healthcare === "hospital";
        return {
          id: el.type + "/" + el.id,
          name: t.name || t["name:en"] || t.operator || (isHospital ? "Unnamed hospital" : "Unnamed clinic"),
          lat: lat, lon: lon,
          kind: isHospital ? "hospital" : "clinic",
          emergency: t.emergency === "yes",
          hours: t.opening_hours || "",
          address: formatAddress(t),
          phone: telHref(t.phone || t["contact:phone"] || ""),
          website: safeUrl(t.website || t["contact:website"] || t.url),
          distance: distanceKm(origin, { lat: lat, lon: lon })
        };
      }).filter(function (x) {
        if (!x) return false;
        var key = x.name.toLowerCase() + "|" + x.lat.toFixed(3) + "|" + x.lon.toFixed(3);
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      }).sort(function (a, b) { return a.distance - b.distance; }).slice(0, MAX_RESULTS);

      nearbyState = null;
      activeId = null;
      if (view === "nearby") { render(); fitTo(visibleNearby().slice(0, 10)); }
      else render();
    } catch (err) {
      if (seq !== requestSeq) return;
      console.error(err);
      if (view === "nearby") els.summary.textContent = "Search failed";
      setNearbyState(ICON.alert, "red", "Couldn't load hospitals",
        "The free OpenStreetMap data servers are busy right now, or you're offline. Please try again in a minute.",
        { label: "Try again", run: loadFacilities });
    }
  }

  function drawOrigin() {
    if (meMarker) map.removeLayer(meMarker);
    if (radiusCircle) map.removeLayer(radiusCircle);
    meMarker = L.marker([origin.lat, origin.lon], {
      icon: L.divIcon({ className: "", html: '<div class="marker-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      keyboard: false, zIndexOffset: 1000, title: origin.label
    }).addTo(map);
    radiusCircle = L.circle([origin.lat, origin.lon], {
      radius: Number(els.radius.value), color: "#1d4ed8", weight: 1, fillOpacity: .05, interactive: false
    }).addTo(map);
    if (view === "nearby") map.fitBounds(radiusCircle.getBounds(), { padding: [20, 20] });
  }

  function widenSearch() {
    var opts = Array.prototype.map.call(els.radius.options, function (o) { return o.value; });
    var i = opts.indexOf(els.radius.value);
    if (i < opts.length - 1) els.radius.value = opts[i + 1];
    loadFacilities();
  }

  /* ---------------- location sources ---------------- */
  function useMyLocation() {
    showView("nearby");
    if (!("geolocation" in navigator)) {
      setNearbyState(ICON.alert, "red", "Location not supported", "Your browser can't share its location. Search for a place instead.");
      return;
    }
    var btn = els.locate, original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Finding your location…';

    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false; btn.innerHTML = original;
      origin = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "your location" };
      loadFacilities();
    }, function (err) {
      btn.disabled = false; btn.innerHTML = original;
      var msg = location.protocol === "file:"
        ? "Browsers block location for pages opened as a file. Open the site with Live Server or your Firebase URL, or search for a place instead."
        : err.code === 1
          ? "Location access was blocked. Click the icon on the left of the address bar to allow it, or search for a place instead."
          : "We couldn't get your location. Search for a city or address instead.";
      els.summary.textContent = "Location unavailable";
      setNearbyState(ICON.alert, "red", "Location unavailable", msg);
      els.place.focus();
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  async function searchPlace(q) {
    showView("nearby");
    var seq = ++requestSeq;
    setNearbyLoading("Looking up “" + q + "”…");
    try {
      var res = await fetch(NOMINATIM + "?format=jsonv2&limit=1&q=" + encodeURIComponent(q), { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("Geocoding HTTP " + res.status);
      var places = await res.json();
      if (seq !== requestSeq) return;
      if (!places.length) {
        els.summary.textContent = "No match";
        setNearbyState(ICON.search, "", "Place not found", "Check the spelling or try a nearby city, area or postcode.");
        return;
      }
      var p = places[0];
      var label = (p.display_name || q).split(",").slice(0, 2).join(",").trim();
      origin = { lat: Number(p.lat), lon: Number(p.lon), label: label };
      recordSearch(origin);
      loadFacilities();
    } catch (err) {
      if (seq !== requestSeq) return;
      console.error(err);
      els.summary.textContent = "Search failed";
      setNearbyState(ICON.alert, "red", "Couldn't search that place", "Check your connection and try again.",
        { label: "Try again", run: function () { searchPlace(q); } });
    }
  }

  /* ---------------- boot ---------------- */
  function initMap() {
    map = L.map("map", { zoomControl: true }).setView([20, 0], 2);
    // CARTO basemap (free, OpenStreetMap data). Unlike tile.openstreetmap.org it
    // doesn't block pages without a Referer, so it also works from Live Server/file.
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd",
      maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    window.addEventListener("resize", function () { map.invalidateSize(); });
  }

  function findItem(id) {
    for (var i = 0; i < currentItems.length; i++) if (currentItems[i].id === id) return currentItems[i];
    return null;
  }

  function bindEvents() {
    els.locate.addEventListener("click", useMyLocation);
    els.form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = els.place.value.trim();
      if (q) searchPlace(q); else els.place.focus();
    });
    els.radius.addEventListener("change", function () { if (origin) { showView("nearby"); loadFacilities(); } });
    [els.clinics, els.emergency].forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (view === "nearby" && origin && !nearbyState) { render(); fitTo(visibleNearby().slice(0, 10)); }
      });
    });
    els.tabNearby.addEventListener("click", function () { showView("nearby"); });
    els.tabSaved.addEventListener("click", function () { showView("saved"); });

    function activate(li) {
      if (!li) return;
      var id = li.getAttribute("data-id");
      var m = markerById[id];
      if (!m) return;
      setActive(id, false);
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
      m.openPopup();
    }
    els.list.addEventListener("click", function (e) {
      var saveBtn = e.target.closest("[data-save]");
      if (saveBtn) {
        var item = findItem(saveBtn.getAttribute("data-save"));
        if (item) toggleSave(item, saveBtn);
        return;
      }
      if (e.target.closest("a, button")) return;
      activate(e.target.closest(".result"));
    });
    els.list.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("result")) {
        e.preventDefault();
        activate(e.target);
      }
    });
  }

  HTAuth.ready.catch(function (err) {
    document.body.classList.add("ready");
    els.summary.textContent = "Couldn't start";
    els.list.innerHTML = stateHtml(ICON.alert, "red", "Couldn't connect to Firebase", HTAuth.friendlyError(err));
  });

  HTAuth.requireUser().then(async function (u) {
    user = u;
    backend = await HTAuth.ready;
    document.body.classList.add("ready");
    if (!window.L) {
      els.summary.textContent = "Map failed to load";
      els.list.innerHTML = stateHtml(ICON.alert, "red", "Map couldn't load", "Check your internet connection and reload the page.");
      return;
    }
    initMap();
    bindEvents();
    render();
    listenSaved();
    listenRecent();
  });
})();
