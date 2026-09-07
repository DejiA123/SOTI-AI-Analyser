/* =============================================================================
 * THE USAGE BOARD — the page "Open my board" opens.
 *
 * WHY THIS LIVES INSIDE THE EXTENSION.
 *
 * The panel hands its report over in the URL FRAGMENT: the counters ride on the end
 * of the address and the destination page reads them out of its own location. A
 * fragment is never transmitted to a server, which is the whole reason the report can
 * travel that way without a host permission, without a fetch, and without anything in
 * transit seeing it.
 *
 * That only works if the destination is its own TOP-LEVEL page. Pointed at a dashboard
 * the browser renders inside a frame, the outer address carries the fragment and the
 * framed page reads its own — which is empty. The tab opens either way, so the panel
 * cannot tell the two apart and reports a clean success about a report that arrived
 * nowhere. That was tried, on a hosted board, and the board sat there looking like one
 * nobody had ever used.
 *
 * Served from chrome-extension:// this page IS top-level, so the fragment is simply
 * there. No hosting, no account, no network at all.
 *
 * WHAT IT IS NOT: shared. Everything here is this browser's own copy. One person
 * builds the team's picture by collecting other engineers' reports through the paste
 * box — "Copy report" in the panel produces exactly what it accepts.
 * ========================================================================== */
(function () {
  "use strict";

  var PARAM = "sotiusage";
  var KEY = "soti_usage_board_v1";

  /* ---------------------------------------------------------------------- *
   * Decoding what the panel put on the end of the address.
   * base64url in, UTF-8 JSON out — the exact inverse of usagePayloadParam()
   * in sidepanel.js, which strips the padding and swaps + / for - _.
   * -------------------------------------------------------------------- */
  function decodePayload(raw) {
    var b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch (e) { return JSON.parse(decodeURIComponent(escape(bin))); }
  }

  function readFragment() {
    var m = new RegExp("[#&]" + PARAM + "=([A-Za-z0-9_-]+)").exec(window.location.hash || "");
    if (!m) return null;
    try {
      var rep = decodePayload(m[1]);
      if (!rep || typeof rep !== "object" || !rep.id) {
        return { error: "That report carried no install id." };
      }
      return { report: rep };
    } catch (e) {
      return { error: "That address had something on it that was not a usage report (" + e.message + ")." };
    }
  }

  /* ---------------------------------------------------------------------- *
   * Where the reports are kept.
   *
   * chrome.storage.local when this is running as an extension page, which is
   * the normal case and survives the browser profile being synced. Plain
   * localStorage when the file is opened on its own — the page is then still
   * fully usable, which is what makes it testable outside Chrome.
   * -------------------------------------------------------------------- */
  var haveChromeStore = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local);

  function readAll() {
    if (haveChromeStore) {
      return new Promise(function (res) {
        chrome.storage.local.get(KEY, function (got) {
          res((got && got[KEY]) || {});
        });
      });
    }
    try { return Promise.resolve(JSON.parse(localStorage.getItem(KEY) || "{}") || {}); }
    catch (e) { return Promise.resolve({}); }
  }

  function writeAll(map) {
    if (haveChromeStore) {
      return new Promise(function (res) {
        var o = {};
        o[KEY] = map;
        chrome.storage.local.set(o, function () { res(); });
      });
    }
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* full or blocked */ }
    return Promise.resolve();
  }

  var store = {
    list: function () {
      return readAll().then(function (m) {
        return Object.keys(m).map(function (k) { return m[k]; }).filter(Boolean);
      });
    },
    /* ONE DOCUMENT PER INSTALL, REPLACED rather than added to. Each report is
     * CUMULATIVE and self-contained — it carries the all-time counters, not the
     * events since last time — so keeping every report an install ever sent would
     * count the same press once per send. */
    put: function (rec) {
      return readAll().then(function (m) {
        m[rec.id] = rec;
        return writeAll(m);
      });
    },
    clear: function () { return writeAll({}); }
  };

  /* ---------------------------------------------------------------------- *
   * Aggregating
   * -------------------------------------------------------------------- */
  function aggregate(records) {
    var catalogue = {}, presses = {}, reachedBy = {}, byDay = {};
    var totals = { events: 0, chat: 0, closed: 0, opened: 0, up: 0, down: 0 };
    var medians = [];

    records.forEach(function (r) {
      Object.keys(r.catalogue || {}).forEach(function (id) {
        if (!catalogue[id]) catalogue[id] = r.catalogue[id];
      });
      Object.keys(r.actions || {}).forEach(function (id) {
        var n = (r.actions[id] || {}).n || 0;
        if (!catalogue[id]) catalogue[id] = id;
        presses[id] = (presses[id] || 0) + n;
        if (n > 0) reachedBy[id] = (reachedBy[id] || 0) + 1;
      });
      Object.keys(r.byDay || {}).forEach(function (d) {
        byDay[d] = (byDay[d] || 0) + (r.byDay[d] || 0);
      });
      totals.events += r.events || 0;
      totals.chat += r.chatPrompts || 0;
      totals.closed += r.casesClosed || 0;
      totals.opened += r.casesOpened || 0;
      totals.up += (r.feedback && r.feedback.up) || 0;
      totals.down += (r.feedback && r.feedback.down) || 0;
      var med = (r.resolve && r.resolve.medianMs) || 0;
      if (med > 0) medians.push(med);
    });

    var rows = Object.keys(catalogue).map(function (id) {
      return { id: id, label: catalogue[id], n: presses[id] || 0, installs: reachedBy[id] || 0 };
    });

    return {
      rows: rows, byDay: byDay, totals: totals, installs: records.length,
      medianOfMedians: median(medians),
      lastReport: records.reduce(function (a, r) { return Math.max(a, r.sentAt || 0); }, 0)
    };
  }

  function median(list) {
    var a = (list || []).filter(function (n) { return isFinite(n) && n > 0; })
                        .sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
  }

  function duration(ms) {
    var n = Number(ms) || 0;
    if (n <= 0) return "—";
    var h = n / 3600000;
    if (h < 1) return Math.max(1, Math.round(n / 60000)) + " min";
    if (h < 48) return h.toFixed(1) + " h";
    return (h / 24).toFixed(1) + " days";
  }

  function ago(ts) {
    if (!ts) return "—";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    var mins = Math.round(d / 60000);
    if (mins < 60) return mins + " min ago";
    var hrs = Math.round(d / 3600000);
    if (hrs < 48) return hrs + " h ago";
    return Math.round(d / 86400000) + " days ago";
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------------- *
   * Rendering
   * -------------------------------------------------------------------- */
  function render(records) {
    var agg = aggregate(records);

    var ledger = $("ledger");
    ledger.textContent = "";
    var dead = agg.rows.filter(function (r) { return r.n === 0; }).length;
    [
      ["Installs reporting", String(agg.installs)],
      ["Actions catalogued", String(agg.rows.length)],
      ["Never pressed", String(dead)],
      ["Events counted", agg.totals.events.toLocaleString()],
      ["Newest report", ago(agg.lastReport)]
    ].forEach(function (p) {
      var d = el("div");
      d.appendChild(el("dt", null, p[0]));
      d.appendChild(el("dd", null, p[1]));
      ledger.appendChild(d);
    });

    // -- never pressed, which is the point of the page --------------------
    var list = $("deadList");
    list.textContent = "";
    var quiet = agg.rows.filter(function (r) { return r.installs <= 1; })
      .sort(function (a, b) { return a.installs - b.installs || a.n - b.n || a.label.localeCompare(b.label); });

    if (!quiet.length) {
      var none = el("div", "dead-row");
      none.appendChild(el("div", "dead-name",
        "Every catalogued action has been pressed on at least two installs."));
      list.appendChild(none);
    } else {
      quiet.forEach(function (r) {
        var row = el("div", "dead-row");
        var name = el("div", "dead-name", r.label);
        name.appendChild(el("span", "dead-id", r.id));
        row.appendChild(name);
        row.appendChild(el("div", "reach", r.installs + " of " + agg.installs + " installs"));
        row.appendChild(el("div", "verdict " + (r.n === 0 ? "dead" : "thin"),
          r.n === 0 ? "Dead" : "Thin · " + r.n));
        list.appendChild(row);
      });
    }

    // -- most pressed -----------------------------------------------------
    var ranks = $("ranks");
    ranks.textContent = "";
    var used = agg.rows.filter(function (r) { return r.n > 0; })
                       .sort(function (a, b) { return b.n - a.n; }).slice(0, 12);
    if (!used.length) {
      ranks.appendChild(el("p", "sec-note", "Nothing has been pressed on any reporting install yet."));
    }
    var top = used.length ? used[0].n : 1;
    used.forEach(function (r) {
      var row = el("div", "rank");
      row.appendChild(el("div", "rank-name", r.label));
      var track = el("div", "track");
      var fill = el("div", "fill");
      fill.style.width = Math.max(2, Math.round((r.n / top) * 100)) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("div", "rank-n", r.n.toLocaleString() + " · " + r.installs + "×"));
      ranks.appendChild(row);
    });

    renderSpark(agg.byDay);

    // -- roster -----------------------------------------------------------
    var roster = $("roster");
    roster.textContent = "";
    records.slice().sort(function (a, b) { return (b.sentAt || 0) - (a.sentAt || 0); })
      .forEach(function (r) {
        var tr = el("tr");
        var who = el("td", "who", r.who || "not named");
        who.appendChild(el("span", null, r.id));
        tr.appendChild(who);
        tr.appendChild(el("td", null, r.ver || "—"));
        tr.appendChild(el("td", "num", (r.events || 0).toLocaleString()));
        tr.appendChild(el("td", "num", (r.chatPrompts || 0).toLocaleString()));
        tr.appendChild(el("td", "num", (r.casesClosed || 0).toLocaleString()));
        tr.appendChild(el("td", "num", duration((r.resolve && r.resolve.medianMs) || 0)));
        var stale = r.sentAt && (Date.now() - r.sentAt) > 14 * 86400000;
        tr.appendChild(el("td", stale ? "stale" : null, ago(r.sentAt)));
        roster.appendChild(tr);
      });
  }

  function renderSpark(byDay) {
    var wrap = $("sparkWrap");
    wrap.textContent = "";
    var days = Object.keys(byDay).sort();
    if (!days.length) {
      wrap.appendChild(el("p", "sec-note", "No dated activity reported yet."));
      return;
    }
    var W = 900, H = 150, PL = 44, PR = 12, PT = 12, PB = 26;
    var max = days.reduce(function (a, d) { return Math.max(a, byDay[d]); }, 0) || 1;
    var iW = W - PL - PR, iH = H - PT - PB;
    var barW = Math.max(1, iW / days.length - 2);
    var NS = "http://www.w3.org/2000/svg";

    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Daily counted events across all reporting installs");

    var css = getComputedStyle(document.body);
    var alive = css.getPropertyValue("--alive").trim() || "#0f6e5c";
    var faint = css.getPropertyValue("--faint").trim() || "#98a1a9";
    var soft = css.getPropertyValue("--line-soft").trim() || "#eaeef1";

    [0, 0.5, 1].forEach(function (f) {
      var y = PT + iH - f * iH;
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", PL); ln.setAttribute("x2", W - PR);
      ln.setAttribute("y1", y); ln.setAttribute("y2", y);
      ln.setAttribute("stroke", soft); ln.setAttribute("stroke-width", "1");
      svg.appendChild(ln);
      var tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", PL - 8); tx.setAttribute("y", y + 4);
      tx.setAttribute("text-anchor", "end");
      tx.setAttribute("fill", faint); tx.setAttribute("font-size", "11");
      tx.textContent = String(Math.round(f * max));
      svg.appendChild(tx);
    });

    days.forEach(function (d, i) {
      var h = (byDay[d] / max) * iH;
      var x = PL + (i * iW) / days.length;
      var rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", x.toFixed(1));
      rect.setAttribute("y", (PT + iH - h).toFixed(1));
      rect.setAttribute("width", barW.toFixed(1));
      rect.setAttribute("height", Math.max(1, h).toFixed(1));
      rect.setAttribute("fill", alive);
      rect.setAttribute("rx", "1");
      var t = document.createElementNS(NS, "title");
      t.textContent = d + " — " + byDay[d] + " events";
      rect.appendChild(t);
      svg.appendChild(rect);
    });

    [[days[0], PL, "start"], [days[days.length - 1], W - PR, "end"]].forEach(function (p) {
      var tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", p[1]); tx.setAttribute("y", H - 8);
      tx.setAttribute("text-anchor", p[2]);
      tx.setAttribute("fill", faint); tx.setAttribute("font-size", "11");
      tx.textContent = p[0];
      svg.appendChild(tx);
    });

    wrap.appendChild(svg);
  }

  function notice(kind, mark, text) {
    var n = el("div", "notice " + kind);
    n.appendChild(el("span", "notice-mark", mark));
    n.appendChild(el("p", null, text));
    $("notices").appendChild(n);
  }

  /* ---------------------------------------------------------------------- *
   * Boot
   * -------------------------------------------------------------------- */
  var incoming = readFragment();
  var pasted = null;

  /* THE ONE PLACE NOTICES ARE WRITTEN, so a repaint replaces them instead of
   * stacking another copy underneath the last. */
  function paint() {
    return store.list().then(function (recs) {
      $("notices").textContent = "";
      if (incoming && incoming.error) notice("warn", "Ignored", incoming.error);
      var got = (incoming && incoming.report) || pasted;
      if (got) {
        notice("good", "Received",
          "Report from " + (got.who || got.id) + " — "
          + (got.events || 0).toLocaleString() + " recorded actions, panel version "
          + (got.ver || "unknown") + ".");
      }
      if (!recs.length) {
        notice("warn", "Nothing yet",
          "No report has reached this board. Open Settings → Usage & Feedback in the panel "
          + "and press “Open my board”, and this fills in with your own counters.");
      }
      render(recs);
      $("intake").hidden = false;
    });
  }

  function absorb() {
    var rep = (incoming && incoming.report) || pasted;
    if (!rep) return Promise.resolve();
    return store.put(Object.assign({}, rep, { receivedAt: Date.now() }))
                .catch(function () { /* a refused write must not blank the page */ });
  }

  absorb().then(paint);

  /* PRESSED TWICE, WITH THE PAGE ALREADY OPEN. Chrome reuses the tab and only the
   * fragment changes, so without this the second press appears to do nothing. */
  window.addEventListener("hashchange", function () {
    var again = readFragment();
    if (!again || !again.report) return;
    incoming = again;
    absorb().then(paint);
  });

  $("btnPaste").addEventListener("click", function () {
    var ta = $("pasteBox");
    var raw = (ta.value || "").trim();
    if (!raw) return;
    var rep = null;
    var m = /[#&]sotiusage=([A-Za-z0-9_-]+)/.exec(raw);
    try {
      rep = m ? decodePayload(m[1]) : JSON.parse(raw);
    } catch (e) {
      $("notices").textContent = "";
      notice("warn", "Not a report",
        "That was neither a board link nor the JSON from Copy report — " + e.message + ".");
      return;
    }
    if (!rep || !rep.id) {
      $("notices").textContent = "";
      notice("warn", "Not a report", "That decoded, but carried no install id.");
      return;
    }
    pasted = rep;
    incoming = null;
    ta.value = "";
    absorb().then(paint);
  });

  $("btnCopy").addEventListener("click", function () {
    store.list().then(function (recs) {
      var text = JSON.stringify(aggregate(recs), null, 2);
      navigator.clipboard.writeText(text).then(function () {
        $("notices").textContent = "";
        notice("good", "Copied", "The aggregate is on your clipboard as JSON.");
      }, function () {
        $("notices").textContent = "";
        notice("warn", "Blocked", "This browser would not let the page write to the clipboard.");
      });
    });
  });

  $("btnForget").addEventListener("click", function () {
    if (!confirm("Forget every report on this board?\n\n"
      + "The counters in the panel are not touched — press “Open my board” "
      + "again and this one fills straight back in.")) return;
    store.clear().then(function () {
      incoming = null;
      pasted = null;
      if (window.location.hash) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      paint();
    });
  });
})();
