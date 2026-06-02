// ===========================================================================
// trainer_easy.js — controller for the simplified ("easy") trainer page.
//
// Speaks the same WebSocket protocol as train.js (configure / start /
// generate ; status / progress / generated), but exposes only the three
// controls a non-technical user needs: rows, stitch selection, and an optional
// (clearly-labelled "you don't need to change this") training-time slider.
//
// Differences from the advanced page:
//   - progress BAR only, no reward chart
//   - "Generate pattern" validates the result (renders OK + correct row
//     count) and opens it in a NEW WINDOW (the sandbox) on success.
// ===========================================================================
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var $statusDot    = $("status-dot");
  var $statusTxt    = $("status-text");
  var $wsUrl        = $("ws-url");

  var $rows         = $("rows");
  var $rowsVal      = $("rows-val");
  var $stitchMenu   = $("stitch-menu");
  var $timesteps    = $("timesteps");
  var $timestepsVal = $("timesteps-val");

  var stitchInputs  = {};   // token -> checkbox element

  var $progressFill  = $("progress-fill");
  var $progressLabel = $("progress-label");
  var $progressPct   = $("progress-pct");
  var $trainBtn      = $("train-btn");
  var $trainHint     = $("train-hint");
  var $resetBtn      = $("reset-btn");

  var $generateBtn  = $("generate-btn");
  var $generateHint = $("generate-hint");

  var ws = null;
  var connected = false;
  var trainedOnce = false;
  var awaitingGen = false;

  // ----- status pill --------------------------------------------------------
  function setStatus(state, text) {
    $statusDot.className = "controls__dot" + (state ? " controls__dot--" + state : "");
    $statusTxt.textContent = text || "";
  }

  // ----- WebSocket ----------------------------------------------------------
  function connect() {
    var url = ($wsUrl.value || "").trim();
    if (!url) return;
    try { ws = new WebSocket(url); }
    catch (e) { setStatus("err", "bad ws url"); return; }

    setStatus("busy", "connecting…");

    ws.addEventListener("open", function () {
      connected = true;
      setStatus("ok", "connected");
      $trainBtn.disabled = false;
      $resetBtn.disabled = false;
      $trainHint.textContent = "Ready. Click to train.";
    });

    ws.addEventListener("close", function () {
      connected = false;
      setStatus("err", "disconnected");
      $trainBtn.disabled = true;
      $resetBtn.disabled = true;
      $generateBtn.disabled = true;
      $trainHint.textContent = "Lost connection to trainer.";
    });

    ws.addEventListener("error", function () {
      setStatus("err", "connection error");
    });

    ws.addEventListener("message", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); }
      catch (e) { return; }
      handleMessage(msg);
    });
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus("err", "not connected");
      return false;
    }
    ws.send(JSON.stringify(obj));
    return true;
  }

  // ----- server messages ----------------------------------------------------
  function handleMessage(msg) {
    switch (msg.type) {
      case "ready":
        buildStitchMenu(Array.isArray(msg.stitch_menu) ? msg.stitch_menu : []);
        break;
      case "status":
        if (msg.phase === "done") onTrainingDone();
        else if (msg.phase === "error") {
          setStatus("err", msg.msg || "error");
          $trainHint.textContent = "Training failed: " + (msg.msg || "unknown");
          $trainHint.className = "easy__hint easy__hint--err";
          $trainBtn.disabled = false;
        }
        break;
      case "progress":
        renderProgress(msg);
        break;
      case "generated":
        onGenerated(msg);
        break;
      case "best_pattern":
        break;                       // ignored on the easy page
      case "error":
        setStatus("err", msg.msg || "server error");
        break;
    }
  }

  // ----- progress bar (no chart) -------------------------------------------
  function renderProgress(msg) {
    var step = msg.step || 0;
    var total = msg.total || 1;
    var pct = Math.min(100, (100 * step) / total);
    $progressFill.style.right = (100 - pct) + "%";
    $progressPct.textContent = Math.round(pct) + "%";
    $progressLabel.textContent =
      "Training… " + step.toLocaleString() + " / " + total.toLocaleString() + " steps";
  }

  function onTrainingDone() {
    trainedOnce = true;
    $progressFill.style.right = "0%";
    $progressPct.textContent = "100%";
    $progressLabel.textContent = "Training complete";
    setStatus("ok", "trained");
    $trainBtn.disabled = false;
    $trainBtn.textContent = "Re-train model";
    $trainHint.textContent = "Done! You can generate a pattern now.";
    $trainHint.className = "easy__hint easy__hint--ok";
    $generateBtn.disabled = false;
    $generateHint.textContent = "Ready to generate.";
    $generateHint.className = "easy__hint";
  }

  // ----- reset --------------------------------------------------------------
  // Discards the trained model on the server and clears the page back to its
  // pre-training state, so the next Train starts fresh. Mirrors the Reset
  // button on the full trainer page.
  function onReset() {
    if (connected) send({ type: "reset" });
    trainedOnce = false;
    awaitingGen = false;
    $progressFill.style.right = "100%";
    $progressPct.textContent = "0%";
    $progressLabel.textContent = "Not started";
    $trainBtn.disabled = !connected;
    $trainBtn.textContent = "Train model";
    $trainHint.textContent = connected
      ? "Model reset. Click to train."
      : "Lost connection to trainer.";
    $trainHint.className = "easy__hint";
    $generateBtn.disabled = true;
    $generateHint.textContent = "Train the model first.";
    $generateHint.className = "easy__hint";
    if (connected) setStatus("ok", "model reset");
  }

  // ----- config -------------------------------------------------------------
  function readConfig() {
    return {
      target_rounds: parseInt($rows.value, 10),
      custom_bodies: selectedStitches(),
      total_timesteps: parseInt($timesteps.value, 10),
      rewards: {},
    };
  }

  function onTrain() {
    if (!connected) return;
    $progressFill.style.right = "100%";
    $progressPct.textContent = "0%";
    $progressLabel.textContent = "Starting…";
    setStatus("busy", "training…");
    $trainBtn.disabled = true;
    $trainHint.textContent = "Training in progress, please wait...";
    $trainHint.className = "easy__hint";
    $generateBtn.disabled = true;
    $generateHint.textContent = "Training… generate when it finishes.";

    var cfg = readConfig();
    send({ type: "configure", target_rounds: cfg.target_rounds,
           custom_bodies: cfg.custom_bodies,
           total_timesteps: cfg.total_timesteps,
           rewards: cfg.rewards });
    send({ type: "start" });
  }

  // ----- generate + validate + open new window -----------------------------
  function onGenerate() {
    if (!connected || !trainedOnce) return;
    awaitingGen = true;
    $generateBtn.disabled = true;
    $generateHint.textContent = "Generating…";
    $generateHint.className = "easy__hint";
    // Procedural env ignores any prefix; send empty so each call is a fresh,
    // unique sample from the trained policy.
    send({ type: "generate", prefix: "" });
  }

  // Count rounds in a generated pattern. The generator emits the magic ring
  // as line 1 (`ring.R`) then one line per round. Every round labels its
  // stitches st_{N}_{k} (the turning chain is st_{N}_1, and the closer
  // references it as ss@st_{N}_1), so the set of distinct row numbers N gives
  // the round count.
  function countRounds(pattern) {
    if (!pattern) return 0;
    var m = pattern.match(/st_(\d+)_\d+/g);
    if (!m) return 0;
    var seen = {};
    m.forEach(function (s) {
      var n = s.match(/st_(\d+)_/)[1];
      seen[n] = true;
    });
    return Object.keys(seen).length;
  }

  function onGenerated(msg) {
    if (!awaitingGen) return;
    awaitingGen = false;
    $generateBtn.disabled = false;

    var pattern = msg.pattern || "";
    var wanted = parseInt($rows.value, 10);

    // Validation 1: the server confirms it renders/parses.
    if (!msg.ok) {
      $generateHint.textContent =
        "Couldn't render that pattern — try generating again" +
        (msg.error ? " (" + msg.error + ")" : "") + ".";
      $generateHint.className = "easy__hint easy__hint--err";
      return;
    }

    // Validation 2: it has the number of rows the user asked for.
    var got = countRounds(pattern);
    if (got !== wanted) {
      $generateHint.textContent =
        "Got " + got + " rows but you asked for " + wanted +
        " — try generating again.";
      $generateHint.className = "easy__hint easy__hint--err";
      return;
    }

    // Passed both checks → hand off to the sandbox in a NEW WINDOW.
    var opened = openInNewWindow(pattern);
    if (opened) {
      $generateHint.textContent = "Opened a " + got + "-row pattern in a new window.";
      $generateHint.className = "easy__hint easy__hint--ok";
    } else {
      $generateHint.textContent =
        "Pattern is valid, but your browser blocked the new window — " +
        "allow pop-ups and try again.";
      $generateHint.className = "easy__hint easy__hint--err";
    }
  }

  // Store the pattern for the sandbox to pick up, then open the sandbox in a
  // new tab/window. The sandbox reads sessionStorage["entangled.handoff"] on
  // load (same mechanism the advanced trainer uses).
  function openInNewWindow(pattern) {
    try { sessionStorage.setItem("entangled.handoff", pattern); }
    catch (e) { /* private mode — sandbox falls back to default */ }
    var win = window.open("./sandbox.html", "_blank");
    return !!win;
  }

  // ----- config-dirty handling ---------------------------------------------
  // If the user changes settings after training, require a re-train before
  // generating (otherwise the row count / stitches wouldn't match).
  function markDirty() {
    if (!trainedOnce) return;
    $generateBtn.disabled = true;
    $generateHint.textContent = "Settings changed — re-train to apply.";
    $generateHint.className = "easy__hint";
    $trainHint.textContent = "Settings changed — click to re-train.";
    $trainHint.className = "easy__hint";
  }

  // ----- stitch menu --------------------------------------------------------
  // Built from the server's STITCH_MENU (sent in the "ready" message). Each
  // item's `default` flag decides whether it starts checked (hdc/dc/tr by
  // default); the last remaining box can't be unticked.
  function buildStitchMenu(menu) {
    var k;
    for (k in stitchInputs) { if (stitchInputs.hasOwnProperty(k)) delete stitchInputs[k]; }
    $stitchMenu.innerHTML = "";

    if (!menu || menu.length === 0) {
      var p = document.createElement("p");
      p.className = "config__advanced-note";
      p.textContent = "No stitches defined in rules.STITCH_MENU.";
      $stitchMenu.appendChild(p);
      return;
    }

    menu.forEach(function (item) {
      var label = document.createElement("label");
      label.className = "config__stitch";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = item.default !== false;
      input.setAttribute("data-token", item.token);
      input.addEventListener("change", function () {
        ensureAtLeastOne(input);
        markDirty();
      });
      var text = document.createElement("span");
      text.textContent = item.label;
      label.appendChild(input);
      label.appendChild(text);
      $stitchMenu.appendChild(label);
      stitchInputs[item.token] = input;
    });
  }

  function ensureAtLeastOne(justChanged) {
    var any = false, k;
    for (k in stitchInputs) {
      if (stitchInputs.hasOwnProperty(k) && stitchInputs[k].checked) { any = true; break; }
    }
    if (!any && justChanged) justChanged.checked = true;
  }

  function selectedStitches() {
    var out = [], k;
    for (k in stitchInputs) {
      if (stitchInputs.hasOwnProperty(k) && stitchInputs[k].checked) {
        out.push(stitchInputs[k].getAttribute("data-token"));
      }
    }
    return out;
  }

  // ----- wiring -------------------------------------------------------------
  function bindRange(input, output) {
    output.value = input.value;
    input.addEventListener("input", function () { output.value = input.value; });
  }
  bindRange($rows, $rowsVal);
  bindRange($timesteps, $timestepsVal);

  [$rows, $timesteps].forEach(function (el) {
    el.addEventListener("change", markDirty);
  });

  $trainBtn.addEventListener("click", onTrain);
  $resetBtn.addEventListener("click", onReset);
  $generateBtn.addEventListener("click", onGenerate);

  setTimeout(connect, 100);
})();