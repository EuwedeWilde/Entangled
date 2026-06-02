// train.js — browser-side controller for the Python PPO trainer.
//
// Thin client. All RL happens in the Python server reached over WebSocket.
// We send `configure`, `start`, `pause`, `resume`, `reset`, and `generate`
// messages, and we render the `status`, `progress`, `best_pattern`, and
// `generated` messages the server pushes back.
//
// The reward editor is built dynamically from the server's `ready` message
// (which lists the keys in rules.REWARDS). That way, editing rules.py to add
// or remove keys requires no UI changes.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // DOM handles
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const $wsUrl = $("ws-url");
  const $connectBtn = $("connect-btn");
  const $statusDot = $("status-dot");
  const $statusTxt = $("status-text");

  const $targetRounds = $("target-rounds");
  const $targetRoundsVal = $("target-rounds-val");
  const $stitchMenu = $("stitch-menu");
  const $episodes = $("episodes");
  const $episodesVal = $("episodes-val");
  const $vocabCount = $("vocab-count");

  const $rwFields = $("rw-fields");
  const $rwEmpty = $("rw-empty");

  const $startBtn = $("start-btn");
  const $pauseBtn = $("pause-btn");
  const $resetBtn = $("reset-btn");

  const $epCounter = $("ep-counter");
  const $progressFill = $("progress-fill");
  const $statAvg = $("stat-avg");
  const $statBest = $("stat-best");
  const $statValid = $("stat-valid");
  const $statQsize = $("stat-qsize");
  const $bestPattern = $("best-pattern");
  const $openBest = $("open-best-btn");
  const $rewardChart = $("reward-chart");

  const $prefix = $("prefix");
  const $generateBtn = $("generate-btn");
  const $generateHint = $("generate-hint");
  const $genOut = $("generated-out");
  const $openGen = $("open-gen-btn");
  const $copyGen = $("copy-gen-btn");
  const $genStatus = $("gen-status");

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let ws = null;
  let connected = false;
  let trainingPhase = "idle";
  let vocabSizes = { low: 0, medium: 0, high: 0 };
  let stitchMenu = [];                   // [{id,label,token}] from "ready"
  const stitchInputs = {};               // token → <input> checkbox
  let rewardKeys = [];                   // populated from server's "ready" msg
  const rewardInputs = {};               // keyname → <input> element
  let lastBestPattern = "";
  let lastGenerated = "";

  const REWARD_HISTORY_LEN = 200;
  const rewardHistory = [];

  // ---------------------------------------------------------------------------
  // Status pill
  // ---------------------------------------------------------------------------
  function setStatus(state, text) {
    $statusDot.className =
      "controls__dot" + (state ? " controls__dot--" + state : "");
    $statusTxt.textContent = text || "";
  }

  function setPhase(phase, msg) {
    trainingPhase = phase;
    const map = {
      idle:       ["ok", "idle"],
      configured: ["ok", "configured"],
      training:   ["busy", "training…"],
      paused:     ["", "paused"],
      done:       ["ok", "done"],
      error:      ["err", "error"],
    };
    const [state, label] = map[phase] || ["", phase];
    setStatus(state, msg || label);
    $startBtn.disabled = phase === "training";
    $pauseBtn.disabled = phase !== "training" && phase !== "paused";
    $pauseBtn.textContent = phase === "paused" ? "Resume" : "Pause";
    if (phase === "done" || phase === "configured") {
      $generateBtn.disabled = !connected;
      $generateHint.textContent = phase === "done"
        ? "Model trained — generation will use it."
        : "Configure & start training to refine the model.";
    }
    if (phase === "training") {
      $generateHint.textContent = "Generation will use the in-progress model.";
      $generateBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------
  function connect() {
    const url = ($wsUrl.value || "").trim();
    if (!url) return;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus("err", "bad ws url");
      return;
    }
    setStatus("busy", "connecting…");
    $connectBtn.disabled = true;

    ws.addEventListener("open", () => {
      connected = true;
      $connectBtn.textContent = "Disconnect";
      $connectBtn.disabled = false;
      $startBtn.disabled = false;
      $resetBtn.disabled = false;
      setStatus("ok", "connected");
    });

    ws.addEventListener("close", () => {
      connected = false;
      $connectBtn.textContent = "Connect";
      $connectBtn.disabled = false;
      $startBtn.disabled = true;
      $pauseBtn.disabled = true;
      $resetBtn.disabled = true;
      $generateBtn.disabled = true;
      setStatus("err", "disconnected");
    });

    ws.addEventListener("error", () => {
      setStatus("err", "ws error");
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); }
      catch (e) { console.warn("bad message", ev.data); return; }
      handleServerMessage(msg);
    });
  }

  function disconnect() {
    if (ws) { try { ws.close(); } catch (_) {} }
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus("err", "not connected");
      return false;
    }
    ws.send(JSON.stringify(obj));
    return true;
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "ready":
        vocabSizes = msg.vocab_sizes || msg.vocabs || {};
        rewardKeys = Array.isArray(msg.reward_keys) ? msg.reward_keys : [];
        stitchMenu = Array.isArray(msg.stitch_menu) ? msg.stitch_menu : [];
        buildRewardFields(rewardKeys);
        buildStitchMenu(stitchMenu);
        updateVocabCount();
        break;

      case "status":
        if (msg.phase) setPhase(msg.phase, msg.msg);
        break;

      case "progress":
        renderProgress(msg);
        break;

      case "best_pattern":
        lastBestPattern = msg.pattern || "";
        $bestPattern.textContent = lastBestPattern || "—";
        $statBest.textContent = (msg.reward ?? 0).toFixed(1);
        $openBest.disabled = !lastBestPattern;
        break;

      case "generated":
        lastGenerated = msg.pattern || "";
        if (msg.ok) {
          $genOut.textContent = lastGenerated || "(empty)";
          $genStatus.textContent =
            `valid · ${msg.n_stitches || 0} stitches`;
          $openGen.disabled = !lastGenerated;
          $copyGen.disabled = !lastGenerated;
        } else {
          $genOut.textContent = (lastGenerated || "") +
            "\n\n— error: " + (msg.error || "unknown");
          $genStatus.textContent = "generation failed";
          $openGen.disabled = true;
          $copyGen.disabled = !lastGenerated;
        }
        break;

      case "error":
        setStatus("err", msg.msg || "server error");
        break;

      default:
        console.debug("unknown msg", msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Dynamic reward editor — built from the server's reward_keys list.
  // Each key becomes a labelled number input. We don't ship default values from
  // the client; the server has the canonical defaults in rules.REWARDS, and we
  // only send overrides for fields the user touches.
  // ---------------------------------------------------------------------------
  function buildRewardFields(keys) {
    // Clear out previous fields (e.g. if we re-connect).
    Object.keys(rewardInputs).forEach((k) => delete rewardInputs[k]);
    $rwFields.innerHTML = "";

    if (!keys || keys.length === 0) {
      const p = document.createElement("p");
      p.className = "config__advanced-note";
      p.textContent = "rules.REWARDS is empty.";
      $rwFields.appendChild(p);
      return;
    }

    // Group keys into rows of 3 for a tidy layout.
    let row = null;
    keys.forEach((key, i) => {
      if (i % 3 === 0) {
        row = document.createElement("div");
        row.className = "config__rewards-row";
        $rwFields.appendChild(row);
      }
      const label = document.createElement("label");
      const human = humaniseKey(key);
      label.textContent = human + " ";
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.5";
      input.dataset.rwKey = key;
      input.placeholder = "default";
      input.addEventListener("change", markConfigDirty);
      label.appendChild(input);
      row.appendChild(label);
      rewardInputs[key] = input;
    });
  }

  function humaniseKey(key) {
    return key.replaceAll("_", " ");
  }

  // Build the stitch checkbox menu from the server's STITCH_MENU. Each item's
  // `default` flag decides whether it starts checked (hdc/dc/tr by default).
  function buildStitchMenu(menu) {
    Object.keys(stitchInputs).forEach((k) => delete stitchInputs[k]);
    $stitchMenu.innerHTML = "";

    if (!menu || menu.length === 0) {
      const p = document.createElement("p");
      p.className = "config__advanced-note";
      p.textContent = "No stitches defined in rules.STITCH_MENU.";
      $stitchMenu.appendChild(p);
      return;
    }

    menu.forEach((item) => {
      const label = document.createElement("label");
      label.className = "config__stitch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = item.default !== false;
      input.dataset.token = item.token;
      input.addEventListener("change", () => {
        ensureAtLeastOne(input);
        markConfigDirty();
        updateVocabCount();
      });
      const text = document.createElement("span");
      text.textContent = item.label;
      const code = document.createElement("code");
      code.textContent = item.token;
      label.appendChild(input);
      label.appendChild(text);
      label.appendChild(code);
      $stitchMenu.appendChild(label);
      stitchInputs[item.token] = input;
    });
  }

  // Don't let the user uncheck the last box — the agent needs ≥1 stitch.
  function ensureAtLeastOne(justChanged) {
    const checked = Object.values(stitchInputs).filter((i) => i.checked);
    if (checked.length === 0 && justChanged) {
      justChanged.checked = true;
    }
  }

  function selectedStitches() {
    return Object.values(stitchInputs)
      .filter((i) => i.checked)
      .map((i) => i.dataset.token);
  }

  function readRewards() {
    // Only send keys whose input is non-empty — that way blank fields fall
    // through to the server's defaults from rules.REWARDS.
    const out = {};
    Object.entries(rewardInputs).forEach(([k, input]) => {
      const v = input.value.trim();
      if (v === "") return;
      const f = parseFloat(v);
      if (Number.isFinite(f)) out[k] = f;
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Configure + start/pause/reset
  // ---------------------------------------------------------------------------
  function readConfig() {
    return {
      target_rounds: parseInt($targetRounds.value, 10),
      custom_bodies: selectedStitches(),
      total_timesteps: parseInt($episodes.value, 10),
      rewards: readRewards(),
    };
  }

  function onStart() {
    rewardHistory.length = 0;
    redrawChart();
    $bestPattern.textContent = "Training… best pattern will appear here.";
    $openBest.disabled = true;
    send({ type: "configure", ...readConfig() });
    send({ type: "start" });
    setPhase("training");
    modelDirty = true;
  }

  function onPause() {
    if (trainingPhase === "paused") {
      send({ type: "resume" });
      setPhase("training");
    } else {
      send({ type: "pause" });
      setPhase("paused");
    }
  }

  function onReset() {
    send({ type: "reset" });
    rewardHistory.length = 0;
    redrawChart();
    $statAvg.textContent = "—";
    $statBest.textContent = "—";
    $statValid.textContent = "—";
    $statQsize.textContent = "0";
    $bestPattern.textContent = "Model reset. Configure and start training.";
    lastBestPattern = "";
    $openBest.disabled = true;
    modelDirty = false;
    setPhase("idle");
  }

  function onGenerate() {
    if (!connected) return;
    send({ type: "generate", prefix: $prefix.value || "" });
    $genStatus.textContent = "generating…";
  }

  // ---------------------------------------------------------------------------
  // Progress rendering
  // ---------------------------------------------------------------------------
  function renderProgress(msg) {
    const step = msg.step ?? 0;
    const total = msg.total ?? 1;
    const pct = Math.min(100, (100 * step) / total);
    $progressFill.style.right = (100 - pct) + "%";

    $epCounter.textContent = `step ${step.toLocaleString()} / ${total.toLocaleString()}`;
    $statAvg.textContent = (msg.ep_reward_mean ?? 0).toFixed(1);
    $statValid.textContent = (msg.ep_count ?? 0).toString();
    $statQsize.textContent = step.toLocaleString();
    if (msg.best_reward != null) {
      $statBest.textContent = msg.best_reward.toFixed(1);
    }

    rewardHistory.push(msg.ep_reward_mean ?? 0);
    if (rewardHistory.length > REWARD_HISTORY_LEN) rewardHistory.shift();
    redrawChart();
  }

  // ---------------------------------------------------------------------------
  // Reward chart
  // ---------------------------------------------------------------------------
  function redrawChart() {
    const cnv = $rewardChart;
    const ctx = cnv.getContext("2d");
    const cssW = cnv.clientWidth || 600;
    const cssH = cnv.clientHeight || 180;
    const dpr = window.devicePixelRatio || 1;
    if (cnv.width !== cssW * dpr || cnv.height !== cssH * dpr) {
      cnv.width = cssW * dpr;
      cnv.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const cs = getComputedStyle(document.documentElement);
    const inkSoft = cs.getPropertyValue("--ink-soft").trim() || "#666";
    const accent  = cs.getPropertyValue("--accent").trim()  || "#f60";
    const paperEdge = cs.getPropertyValue("--paper-edge").trim() || "#ffe0cc";

    ctx.strokeStyle = paperEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cssH - 0.5);
    ctx.lineTo(cssW, cssH - 0.5);
    ctx.stroke();

    if (rewardHistory.length < 2) {
      ctx.fillStyle = inkSoft;
      ctx.font = '11px "Space Mono", monospace';
      ctx.fillText("waiting for episodes…", 8, 16);
      return;
    }

    const min = Math.min(...rewardHistory, 0);
    const max = Math.max(...rewardHistory, 1);
    const span = Math.max(1e-6, max - min);
    const xStep = cssW / (REWARD_HISTORY_LEN - 1);
    const startX = cssW - xStep * (rewardHistory.length - 1);

    if (min < 0 && max > 0) {
      const zeroY = cssH - ((0 - min) / span) * cssH;
      ctx.strokeStyle = paperEdge;
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(cssW, zeroY);
      ctx.stroke();
    }

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < rewardHistory.length; i++) {
      const x = startX + i * xStep;
      const y = cssH - ((rewardHistory[i] - min) / span) * cssH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = inkSoft;
    ctx.font = '10px "Space Mono", monospace';
    ctx.fillText(max.toFixed(1), 4, 12);
    ctx.fillText(min.toFixed(1), 4, cssH - 4);
  }

  // ---------------------------------------------------------------------------
  // Open in sandbox
  // ---------------------------------------------------------------------------
  function openInSandbox(pattern) {
    if (!pattern) return;
    try { sessionStorage.setItem("entangled.handoff", pattern); }
    catch (_) {}
    if (navigator.clipboard) {
      navigator.clipboard.writeText(pattern).catch(() => {});
    }
    window.open("./sandbox.html", "_blank");
  }

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------
  function updateVocabCount() {
    const n = selectedStitches().length;
    $vocabCount.textContent = n > 0
      ? `${n} stitch${n === 1 ? "" : "es"}` : "—";
  }

  function bindRange(input, output) {
    if (!input || !output) return;
    output.value = input.value;
    input.addEventListener("input", () => { output.value = input.value; });
  }

  // ---------------------------------------------------------------------------
  // Reset-on-config-change.
  // ---------------------------------------------------------------------------
  let modelDirty = false;
  function markConfigDirty() {
    if (!modelDirty) return;
    modelDirty = false;
    if (connected) {
      send({ type: "reset" });
    }
    rewardHistory.length = 0;
    redrawChart();
    $statAvg.textContent = "—";
    $statBest.textContent = "—";
    $statValid.textContent = "—";
    $statQsize.textContent = "0";
    $bestPattern.textContent = "Settings changed — model reset. Click Start training.";
    lastBestPattern = "";
    $openBest.disabled = true;
    setPhase("idle", "settings changed — model reset");
  }

  function wireConfigChange(el) {
    if (el) el.addEventListener("change", markConfigDirty);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  bindRange($targetRounds, $targetRoundsVal);
  bindRange($episodes, $episodesVal);

  [$targetRounds, $episodes].filter(Boolean).forEach(wireConfigChange);

  $connectBtn.addEventListener("click", () => {
    if (connected) disconnect(); else connect();
  });
  $startBtn.addEventListener("click", onStart);
  $pauseBtn.addEventListener("click", onPause);
  $resetBtn.addEventListener("click", onReset);
  $generateBtn.addEventListener("click", onGenerate);

  $openBest.addEventListener("click", () => openInSandbox(lastBestPattern));
  $openGen.addEventListener("click", () => openInSandbox(lastGenerated));
  $copyGen.addEventListener("click", () => {
    if (navigator.clipboard && lastGenerated) {
      navigator.clipboard.writeText(lastGenerated).then(() => {
        const prev = $copyGen.textContent;
        $copyGen.textContent = "copied!";
        setTimeout(() => { $copyGen.textContent = prev; }, 1200);
      });
    }
  });

  $startBtn.disabled = true;
  $pauseBtn.disabled = true;
  $resetBtn.disabled = true;
  $generateBtn.disabled = true;

  setTimeout(connect, 100);
  window.addEventListener("resize", redrawChart);
})();