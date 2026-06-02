// ===========================================================================
// feedback.js — "Made this pattern?" feedback widget.
//
// Drop this script onto any page (it self-injects its button + overlay). It
// collects the user's rating, comments, a few metrics, and an optional photo,
// then sends a {type:"feedback"} message over a short-lived WebSocket to the
// trainer server, which emails it to the maintainer.
//
// It reads the ws url from an #ws-url input if present (same as the trainer
// pages), otherwise defaults to ws://127.0.0.1:8765. It opens its own
// connection only for the moment of sending, so it doesn't depend on the
// page's training connection being live.
//
// Optional page hooks (both safe to omit):
//   window.entangledLastPattern  — string, the pattern being reviewed
//   window.entangledMetrics()    — function returning a metrics object
// ===========================================================================
(function () {
  "use strict";

  // ----- styles (scoped by .fbk- prefix; sharp corners to match the app) ----
  var css = ''
    + '.fbk-fab{position:fixed;right:20px;bottom:20px;z-index:9998;'
    +   'font-family:"Space Mono",monospace;font-size:12px;text-transform:uppercase;'
    +   'letter-spacing:0.08em;padding:10px 16px;border:1px solid var(--accent,#f60);'
    +   'background:#fff;color:#333;cursor:pointer;}'
    + '.fbk-fab:hover{background:#f60;color:#fff;}'
    + '.fbk-overlay{position:fixed;inset:0;z-index:9999;display:none;'
    +   'align-items:center;justify-content:center;background:rgba(0,0,0,0.45);}'
    + '.fbk-overlay.fbk-open{display:flex;}'
    + '.fbk-modal{background:var(--paper,#fff);color:var(--ink,#333);'
    +   'width:min(520px,92vw);max-height:90vh;overflow-y:auto;'
    +   'border:1px solid var(--accent,#f60);padding:1.5rem 1.75rem;'
    +   'font-family:"Montserrat",sans-serif;}'
    + '.fbk-modal h2{font-family:"Space Mono",monospace;font-size:14px;'
    +   'text-transform:uppercase;letter-spacing:0.1em;margin:0 0 0.25rem;}'
    + '.fbk-modal p.fbk-sub{font-size:12px;color:var(--ink-soft,#666);margin:0 0 1.25rem;line-height:1.5;}'
    + '.fbk-field{margin-bottom:1.1rem;}'
    + '.fbk-label{display:block;font-family:"Space Mono",monospace;font-size:11px;'
    +   'text-transform:uppercase;letter-spacing:0.12em;margin-bottom:0.5rem;}'
    + '.fbk-rating{display:flex;gap:8px;flex-wrap:wrap;}'
    + '.fbk-rating button{font-family:"Montserrat",sans-serif;font-size:12px;'
    +   'padding:7px 12px;border:1px solid var(--ink,#333);background:transparent;'
    +   'color:var(--ink,#333);cursor:pointer;}'
    + '.fbk-rating button.fbk-sel{background:var(--accent,#f60);color:#fff;border-color:var(--accent,#f60);}'
    + '.fbk-textarea{width:100%;min-height:90px;font-family:"Montserrat",sans-serif;'
    +   'font-size:13px;padding:8px;border:1px solid var(--ink,#333);background:transparent;'
    +   'color:var(--ink,#333);resize:vertical;box-sizing:border-box;}'
    + '.fbk-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;}'
    + '.fbk-metrics input{font-family:"Space Mono",monospace;font-size:12px;padding:6px 8px;'
    +   'border:1px solid var(--paper-edge,#ffe0cc);background:transparent;color:var(--ink,#333);'
    +   'box-sizing:border-box;width:100%;}'
    + '.fbk-photo-note{font-size:11px;color:var(--ink-soft,#666);line-height:1.45;margin:0.4rem 0 0;'
    +   'border-left:2px solid var(--accent,#f60);padding-left:0.6rem;}'
    + '.fbk-preview{margin-top:0.6rem;max-width:100%;max-height:180px;display:none;border:1px solid var(--paper-edge,#ffe0cc);}'
    + '.fbk-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:1.25rem;}'
    + '.fbk-btn{font-family:"Space Mono",monospace;font-size:12px;text-transform:uppercase;'
    +   'letter-spacing:0.08em;padding:9px 16px;cursor:pointer;border:1px solid var(--accent,#f60);}'
    + '.fbk-btn--send{background:var(--accent,#f60);color:#fff;}'
    + '.fbk-btn--send:disabled{opacity:0.45;cursor:not-allowed;}'
    + '.fbk-btn--cancel{background:transparent;color:var(--accent,#f60);}'
    + '.fbk-status{font-size:11px;color:var(--ink-soft,#666);min-height:1em;}'
    + '.fbk-status--err{color:var(--error,#662900);}'
    + '.fbk-status--ok{color:var(--accent,#f60);}';

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ----- markup -------------------------------------------------------------
  var fab = document.createElement("button");
  fab.className = "fbk-fab";
  fab.type = "button";
  fab.textContent = "Made this pattern?";
  document.body.appendChild(fab);

  var overlay = document.createElement("div");
  overlay.className = "fbk-overlay";
  overlay.innerHTML = ''
    + '<div class="fbk-modal" role="dialog" aria-modal="true" aria-label="Pattern feedback">'
    +   '<h2>Made this pattern?</h2>'
    +   '<p class="fbk-sub">We\'d love to hear how it went. This is sent privately to the maintainer.</p>'

    +   '<div class="fbk-field">'
    +     '<span class="fbk-label">What did you think?</span>'
    +     '<div class="fbk-rating" id="fbk-rating">'
    +       '<button type="button" data-v="loved it">Loved it</button>'
    +       '<button type="button" data-v="liked it">Liked it</button>'
    +       '<button type="button" data-v="it was okay">It was okay</button>'
    +       '<button type="button" data-v="didn\'t work">Didn\'t work</button>'
    +     '</div>'
    +   '</div>'

    +   '<div class="fbk-field">'
    +     '<label class="fbk-label" for="fbk-comments">Feedback</label>'
    +     '<textarea class="fbk-textarea" id="fbk-comments" placeholder="Anything you\'d like to share — what worked, what didn\'t, ideas…"></textarea>'
    +   '</div>'

    +   '<div class="fbk-field">'
    +     '<span class="fbk-label">A few details (optional)</span>'
    +     '<div class="fbk-metrics">'
    +       '<input id="fbk-m-rows" placeholder="Rows (e.g. 6)">'
    +       '<input id="fbk-m-complexity" placeholder="Complexity">'
    +       '<input id="fbk-m-time" placeholder="Time taken">'
    +       '<input id="fbk-m-yarn" placeholder="Yarn / hook used">'
    +     '</div>'
    +   '</div>'

    +   '<div class="fbk-field">'
    +     '<span class="fbk-label">Photo (optional)</span>'
    +     '<input type="file" id="fbk-photo" accept="image/*">'
    +     '<p class="fbk-photo-note">Please take a photo <strong>without any personally identifiable data</strong> — just the crocheted result.</p>'
    +     '<img class="fbk-preview" id="fbk-preview" alt="photo preview">'
    +   '</div>'

    +   '<div class="fbk-actions">'
    +     '<span class="fbk-status" id="fbk-status"></span>'
    +     '<span>'
    +       '<button type="button" class="fbk-btn fbk-btn--cancel" id="fbk-cancel">Cancel</button>'
    +       '<button type="button" class="fbk-btn fbk-btn--send" id="fbk-send">Send</button>'
    +     '</span>'
    +   '</div>'
    + '</div>';
  document.body.appendChild(overlay);

  var $ = function (id) { return document.getElementById(id); };
  var $rating   = $("fbk-rating");
  var $comments = $("fbk-comments");
  var $photo    = $("fbk-photo");
  var $preview  = $("fbk-preview");
  var $status   = $("fbk-status");
  var $send     = $("fbk-send");
  var $cancel   = $("fbk-cancel");

  var selectedRating = "";
  var photoDataUrl = "";
  var photoName = "";

  // ----- open / close -------------------------------------------------------
  function open() { overlay.classList.add("fbk-open"); }
  function close() { overlay.classList.remove("fbk-open"); }
  fab.addEventListener("click", open);
  $cancel.addEventListener("click", close);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) close();   // click backdrop to dismiss
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });

  // ----- rating selection ---------------------------------------------------
  $rating.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-v]");
    if (!btn) return;
    selectedRating = btn.getAttribute("data-v");
    Array.prototype.forEach.call($rating.querySelectorAll("button"),
      function (b) { b.classList.toggle("fbk-sel", b === btn); });
  });

  // ----- photo preview (read as data-URL for transport) ---------------------
  $photo.addEventListener("change", function () {
    var f = $photo.files && $photo.files[0];
    if (!f) { photoDataUrl = ""; photoName = ""; $preview.style.display = "none"; return; }
    photoName = f.name || "crochet-photo.png";
    var reader = new FileReader();
    reader.onload = function () {
      photoDataUrl = reader.result;          // "data:image/...;base64,...."
      $preview.src = photoDataUrl;
      $preview.style.display = "block";
    };
    reader.readAsDataURL(f);
  });

  // ----- collect metrics ----------------------------------------------------
  function collectMetrics() {
    var m = {};
    var rows = $("fbk-m-rows").value.trim();
    var cx   = $("fbk-m-complexity").value.trim();
    var time = $("fbk-m-time").value.trim();
    var yarn = $("fbk-m-yarn").value.trim();
    if (rows) m.rows = rows;
    if (cx)   m.complexity = cx;
    if (time) m.time_taken = time;
    if (yarn) m.yarn_hook = yarn;
    // Merge any page-supplied metrics (e.g. the actual trained settings).
    if (typeof window.entangledMetrics === "function") {
      try {
        var extra = window.entangledMetrics();
        if (extra && typeof extra === "object") {
          Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
        }
      } catch (_) {}
    }
    return m;
  }

  function wsUrl() {
    var el = document.getElementById("ws-url");
    return (el && el.value.trim()) || "ws://127.0.0.1:8765";
  }

  // ----- send ---------------------------------------------------------------
  function setStatus(text, kind) {
    $status.textContent = text || "";
    $status.className = "fbk-status" + (kind ? " fbk-status--" + kind : "");
  }

  $send.addEventListener("click", function () {
    if (!selectedRating && !$comments.value.trim() && !photoDataUrl) {
      setStatus("Add a rating, a comment, or a photo first.", "err");
      return;
    }
    $send.disabled = true;
    setStatus("Sending…");

    var payload = {
      type: "feedback",
      rating: selectedRating || "(none)",
      comments: $comments.value.trim(),
      metrics: collectMetrics(),
      pattern: (typeof window.entangledLastPattern === "string"
                ? window.entangledLastPattern : ""),
      photo: photoDataUrl || "",
      photo_name: photoName || "",
    };

    var sock;
    try { sock = new WebSocket(wsUrl()); }
    catch (e) { setStatus("Couldn't connect to send.", "err"); $send.disabled = false; return; }

    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      setStatus("Timed out — is the trainer server running?", "err");
      $send.disabled = false;
      try { sock.close(); } catch (_) {}
    }, 20000);

    sock.addEventListener("open", function () {
      sock.send(JSON.stringify(payload));
    });

    sock.addEventListener("message", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type !== "feedback_result") return;   // ignore unrelated traffic
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (msg.ok) {
        setStatus(msg.msg || "Sent — thank you!", "ok");
        setTimeout(close, 1400);
      } else {
        setStatus(msg.msg || "Something went wrong sending.", "err");
        $send.disabled = false;
      }
      try { sock.close(); } catch (_) {}
    });

    sock.addEventListener("error", function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setStatus("Connection error — couldn't send.", "err");
      $send.disabled = false;
    });
  });
})();
