/* =====================================================================
   tiger-ai.js  —  TensorFlow.js AI that plays TIGER (green controls)
   Kabir (red controls) stays 100% human.

   PUT THIS AFTER weapon-access.js, just before </body> in KABIR-VS-AI.html:
       <script src="../4_GAME_LOGICS/weapon-access.js"></script>
       <script src="../4_GAME_LOGICS/tiger-ai.js"></script>
   (TensorFlow.js is loaded automatically from the CDN by this file.)

   What it does
   - Presses Tiger's 4 move buttons + SHOOT with real pointer events,
     so the green buttons light up exactly like a human touch.
   - Locks the green controls / green weapon bar so the human can't use them.
   - Brain = small neural network (8 inputs -> 32 -> 32 -> 6 actions).
       * First run: pre-trains itself in the browser (no dataset needed).
       * While you play: it learns from hits (reward-weighted training)
         and saves itself in localStorage, so Tiger gets smarter each game.
   - Auto-calibrates which button moves which way, so it works with any
     controls.js axis setup.
   - Picks only weapons that are unlocked (uses WeaponAccess if present).

   API:  window.TigerAI.start() / .stop() / .reset() / .learning(true|false)
   ===================================================================== */
(function () {
  "use strict";

  /* ---------------- settings you can edit ---------------- */
  var CFG = {
    stepMs: 220,          // how often the AI thinks (ms)
    startDelayMs: 1500,   // wait after load before fighting
    epsilon: 0.08,        // chance of a random exploratory move
    learn: true,          // keep learning during the match
    modelKey: "localstorage://kabir-vs-tiger-ai-v1",
    tfUrl: "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"
  };

  var AI = (window.WeaponAccess && window.WeaponAccess.ai) || "tiger";   // the AI hero
  var FOE = AI === "tiger" ? "kabir" : "tiger";
  var PREFIX = AI === "tiger" ? "t" : "k";

  /* Actions the brain can choose */
  var A = { APPROACH: 0, RETREAT: 1, STRAFE_L: 2, STRAFE_R: 3, SHOOT: 4, APPROACH_SHOOT: 5 };
  var N_ACT = 6, N_IN = 8;
  var RANGED = ["shotgun", "pistols", "dual-rifles", "sniper-rifle", "dual-pistols"];

  var scene, meNode, foeNode, model = null, tfReady = false;
  var paused = false, running = false, calibrating = false, timer = null, step = 0;
  var held = {};
  var dirs = { up: { x: 0, z: 1 }, down: { x: 0, z: -1 }, left: { x: -1, z: 0 }, right: { x: 1, z: 0 } }; // defaults
  var memory = [];             // recent {s,a,r}
  var prev = null;             // previous step info

  /* ---------------- small helpers ---------------- */
  function pos(n) { var p = n.getAbsolutePosition(); return { x: p.x, z: p.z }; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function hp(hero) {
    var el = document.getElementById((hero === "tiger" ? "t" : "k") + "-health-fill");
    if (!el) return 1;
    var w = el.style.width;
    if (w && w.indexOf("%") > -1) return clamp(parseFloat(w) / 100, 0, 1);
    var par = el.parentElement;
    return par && par.offsetWidth ? clamp(el.offsetWidth / par.offsetWidth, 0, 1) : 1;
  }

  function currentWeapon() { return (typeof selectedWeapons !== "undefined") ? selectedWeapons[AI] : null; }

  function features() {
    var m = pos(meNode), f = pos(foeNode);
    var dx = f.x - m.x, dz = f.z - m.z, d = Math.hypot(dx, dz) || 1e-6;
    return [dx / d, dz / d, Math.min(d / 60, 2), hp(AI), hp(FOE),
            Math.min(Math.abs(m.x) / 125, 1), Math.min(Math.abs(m.z) / 125, 1),
            RANGED.indexOf(currentWeapon()) > -1 ? 1 : 0];
  }

  /* ---------------- button control (real pointer events) ---------------- */
  function btn(a) { return document.querySelector('.control[data-hero="' + AI + '"][data-action="' + a + '"]'); }

  function setHold(a, on) {
    if (!!held[a] === on) return;
    var b = btn(a); if (!b) return;
    held[a] = on;
    b.dispatchEvent(new PointerEvent(on ? "pointerdown" : "pointerup",
      { bubbles: true, cancelable: true, pointerId: 77, pointerType: "touch" }));
  }
  function releaseAll() { ["up", "down", "left", "right", "shoot"].forEach(function (a) { setHold(a, false); }); }

  /* lock the human out of the AI hero's panels */
  function lockHumanOut() {
    ["-controls", "-weapons"].forEach(function (suffix) {
      var p = document.getElementById(PREFIX + suffix);
      if (!p) return;
      p.setAttribute("title", "AI controlled");
      p.style.setProperty("pointer-events", "none", "important");
      p.querySelectorAll("button").forEach(function (b) { b.style.setProperty("pointer-events", "none", "important"); });
    });
    var h = document.querySelector("#" + PREFIX + "-weapons .hero-name");
    if (h && h.textContent.indexOf("AI") === -1) h.textContent += " · AI 🤖";
  }

  /* ---------------- the brain (TensorFlow.js) ---------------- */
  function loadScript(url) {
    return new Promise(function (res, rej) {
      if (window.tf) return res();
      var s = document.createElement("script");
      s.src = url; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  function buildModel() {
    var m = tf.sequential();
    m.add(tf.layers.dense({ inputShape: [N_IN], units: 32, activation: "relu" }));
    m.add(tf.layers.dense({ units: 32, activation: "relu" }));
    m.add(tf.layers.dense({ units: N_ACT, activation: "softmax" }));
    m.compile({ optimizer: tf.train.adam(0.003), loss: "categoricalCrossentropy" });
    return m;
  }

  /* rule-based "teacher" — used to pre-train the network and as an offline fallback */
  function teacher(s) {
    var d = s[2] * 60, myHp = s[3], ranged = s[7], r = Math.random();
    var want = ranged ? 28 : 12;
    if (myHp < 0.25 && d < want) return r < 0.5 ? A.RETREAT : (r < 0.75 ? A.STRAFE_L : A.STRAFE_R);
    if (d > want + 10) return A.APPROACH;
    if (d > want) return A.APPROACH_SHOOT;
    if (d < want * 0.4) return r < 0.5 ? A.RETREAT : A.SHOOT;
    if (r < 0.55) return A.SHOOT;
    if (r < 0.68) return A.STRAFE_L;
    if (r < 0.8) return A.STRAFE_R;
    return A.APPROACH_SHOOT;
  }

  function pretrain(m) {
    var xs = [], ys = [];
    for (var i = 0; i < 3000; i++) {
      var ang = Math.random() * Math.PI * 2, d = 3 + Math.random() * 87;
      var s = [Math.cos(ang), Math.sin(ang), Math.min(d / 60, 2), Math.random(), Math.random(),
               Math.random(), Math.random(), Math.random() < 0.5 ? 1 : 0];
      var y = new Array(N_ACT).fill(0); y[teacher(s)] = 1;
      xs.push(s); ys.push(y);
    }
    var xt = tf.tensor2d(xs), yt = tf.tensor2d(ys);
    return m.fit(xt, yt, { epochs: 12, batchSize: 64, shuffle: true, verbose: 0 })
      .then(function () { xt.dispose(); yt.dispose(); return m; });
  }

  function initModel() {
    return loadScript(CFG.tfUrl).then(function () {
      tfReady = true;
      return tf.loadLayersModel(CFG.modelKey).then(function (m) {
        m.compile({ optimizer: tf.train.adam(0.001), loss: "categoricalCrossentropy" });
        return m;                                           // saved brain found
      }).catch(function () {                                // first run
        return pretrain(buildModel()).then(function (m) { return m.save(CFG.modelKey).then(function () { return m; }); });
      });
    }).then(function (m) { model = m; })
      .catch(function (e) { console.warn("[TigerAI] TensorFlow.js not available, using rule brain.", e); });
  }

  function decide(s) {
    if (Math.random() < CFG.epsilon) return Math.floor(Math.random() * N_ACT);
    if (!model) return teacher(s);
    var out = tf.tidy(function () { return model.predict(tf.tensor2d([s])); });
    var p = out.dataSync(); out.dispose();
    var r = Math.random(), c = 0;                            // sample from probabilities
    for (var i = 0; i < N_ACT; i++) { c += p[i]; if (r <= c) return i; }
    return N_ACT - 1;
  }

  /* learn only from actions that led to good results (reward-weighted) */
  var learningBusy = false;
  function learnNow() {
    if (!model || !CFG.learn || learningBusy) return;
    var good = memory.filter(function (m) { return m.r > 0; });
    if (good.length < 6) return;
    learningBusy = true;
    var xs = good.map(function (m) { return m.s; });
    var ys = good.map(function (m) { var y = new Array(N_ACT).fill(0); y[m.a] = 1; return y; });
    var xt = tf.tensor2d(xs), yt = tf.tensor2d(ys);
    model.fit(xt, yt, { epochs: 2, batchSize: 16, shuffle: true, verbose: 0 })
      .then(function () { return model.save(CFG.modelKey); })
      .catch(function () {})
      .then(function () { xt.dispose(); yt.dispose(); memory = memory.slice(-60); learningBusy = false; });
  }

  /* ---------------- movement: abstract action -> real buttons ---------------- */
  function buttonsFor(vx, vz) {
    var c = Object.keys(dirs).map(function (a) { var d = dirs[a]; return { a: a, dot: d.x * vx + d.z * vz }; })
      .sort(function (p, q) { return q.dot - p.dot; });
    var out = [];
    if (c[0] && c[0].dot > 0.3) out.push(c[0].a);
    if (c[1] && c[1].dot > 0.45) out.push(c[1].a);
    return out;
  }

  function perform(a, s) {
    var ux = s[0], uz = s[1], vx = 0, vz = 0, shoot = false;
    switch (a) {
      case A.APPROACH: vx = ux; vz = uz; break;
      case A.RETREAT: vx = -ux; vz = -uz; break;
      case A.STRAFE_L: vx = -uz; vz = ux; break;
      case A.STRAFE_R: vx = uz; vz = -ux; break;
      case A.SHOOT: shoot = true; break;
      case A.APPROACH_SHOOT: vx = ux; vz = uz; shoot = true; break;
    }
    /* near the island edge? head back to the middle */
    var m = pos(meNode);
    if (Math.abs(m.x) > 112 || Math.abs(m.z) > 112) {
      var L = Math.hypot(m.x, m.z) || 1; vx = -m.x / L; vz = -m.z / L;
    }
    var want = (vx || vz) ? buttonsFor(vx, vz) : [];
    ["up", "down", "left", "right"].forEach(function (b) { setHold(b, want.indexOf(b) > -1); });
    setHold("shoot", shoot && !!canShoot());
    return want;
  }

  function canShoot() {
    var w = currentWeapon();
    return w && (!window.WeaponAccess || window.WeaponAccess.isUnlocked(AI, w));
  }

  /* pick an unlocked weapon that fits the distance */
  function chooseWeapon(d) {
    var list = window.WeaponAccess ? window.WeaponAccess.unlockedList(AI)
      : Array.prototype.map.call(document.querySelectorAll('.weapon[data-hero="' + AI + '"]'), function (b) { return b.dataset.weapon; });
    if (!list.length) return;
    var ranged = list.filter(function (w) { return RANGED.indexOf(w) > -1; });
    var melee = list.filter(function (w) { return RANGED.indexOf(w) === -1; });
    var pool = d > 20 && ranged.length ? ranged : (d < 14 && melee.length ? melee : list);
    var pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick === currentWeapon()) return;
    var b = document.querySelector('.weapon[data-hero="' + AI + '"][data-weapon="' + pick + '"]');
    if (b) b.click();
  }

  /* ---------------- calibration: which button moves which way ---------------- */
  function calibrate(done) {
    calibrating = true;
    var acts = ["up", "down", "left", "right"], i = 0;
    (function next() {
      if (i >= acts.length) { calibrating = false; return done(); }
      var a = acts[i++], p0 = pos(meNode);
      setHold(a, true);
      setTimeout(function () {
        var p1 = pos(meNode); setHold(a, false);
        var dx = p1.x - p0.x, dz = p1.z - p0.z, L = Math.hypot(dx, dz);
        if (L > 0.05) dirs[a] = { x: dx / L, z: dz / L };
        else console.warn("[TigerAI] '" + a + "' did not move Tiger; using default direction.");
        setTimeout(next, 200);
      }, 400);
    })();
  }

  /* ---------------- main loop ---------------- */
  function tick() {
    if (!running || paused || calibrating) return;
    if (hp(AI) <= 0 || hp(FOE) <= 0) { releaseAll(); return; }   // round over

    var s = features(), mp = pos(meNode);
    step++;

    /* reward from the previous step: damage dealt minus damage taken */
    if (prev) {
      var r = (prev.foeHp - hp(FOE)) - (prev.myHp - hp(AI));
      if (r !== 0) memory.slice(-3).forEach(function (m) { m.r += r; });
      /* refine button directions when exactly one move button was held */
      if (prev.want.length === 1) {
        var dx = mp.x - prev.pos.x, dz = mp.z - prev.pos.z, L = Math.hypot(dx, dz);
        if (L > 0.1) {
          var d0 = dirs[prev.want[0]], nx = 0.8 * d0.x + 0.2 * dx / L, nz = 0.8 * d0.z + 0.2 * dz / L, N = Math.hypot(nx, nz) || 1;
          dirs[prev.want[0]] = { x: nx / N, z: nz / N };
        }
      }
    }

    if (step % 18 === 1) chooseWeapon(s[2] * 60);

    var a = decide(s);
    memory.push({ s: s, a: a, r: 0 });
    var want = perform(a, s);
    prev = { foeHp: hp(FOE), myHp: hp(AI), pos: mp, want: want };

    if (step % 40 === 0) learnNow();
  }

  /* ---------------- start / stop ---------------- */
  function start() {
    if (running) return;
    running = true; prev = null;
    timer = setInterval(tick, CFG.stepMs);
  }
  function stop() { running = false; clearInterval(timer); releaseAll(); }

  window.addEventListener("gamepause", function (e) { paused = !!(e.detail && e.detail.paused); if (paused) releaseAll(); });
  window.addEventListener("blur", releaseAll);

  function waitForHeroes(cb) {
    var tries = 0;
    (function poll() {
      scene = window.BABYLON && BABYLON.Engine && BABYLON.Engine.LastCreatedScene;
      if (scene) {
        meNode = scene.getTransformNodeByName(AI + "Root");
        foeNode = scene.getTransformNodeByName(FOE + "Root");
        if (meNode && foeNode) return cb();
      }
      if (++tries > 200) return console.warn("[TigerAI] Hero models not found (" + AI + "Root / " + FOE + "Root).");
      setTimeout(poll, 300);
    })();
  }

  window.TigerAI = {
    start: start, stop: stop,
    learning: function (on) { CFG.learn = !!on; },
    reset: function () {                                   // forget the learned brain
      if (window.tf) tf.io.removeModel(CFG.modelKey).catch(function () {});
      try { localStorage.removeItem("tensorflowjs_models/kabir-vs-tiger-ai-v1/info"); } catch (e) {}
      location.reload();
    }
  };

  lockHumanOut();
  waitForHeroes(function () {
    initModel().then(function () {
      calibrate(function () { setTimeout(start, CFG.startDelayMs); });
    });
  });
})();


