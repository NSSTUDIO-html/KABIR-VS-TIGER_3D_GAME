/* =====================================================================
   TIGER VS KABIR - AI COMBAT SYSTEM
   Tiger = AI (Green)
   Kabir = Human (Red)

   Requirements:
   - Babylon.js
   - TensorFlow.js (loaded automatically)
   - WeaponAccess (optional)
   - window.gameScene
   - window.gameHeroes

   API:
   window.TigerAI.start()
   window.TigerAI.stop()
   window.TigerAI.reset()
   window.TigerAI.learning(true/false)
   ===================================================================== */

(function () {
  "use strict";

  const CFG = {
    stepMs: 220,
    startDelayMs: 1500,
    epsilon: 0.08,
    learn: true,
    modelKey: "localstorage://kabir-vs-tiger-ai-v1",
    tfUrl: "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"
  };

  // Tiger is ALWAYS the AI in this file (Kabir = human player).
  const AI = "tiger";
  const FOE = AI === "tiger" ? "kabir" : "tiger";
  const PREFIX = AI === "tiger" ? "t" : "k";

  const A = {
    APPROACH: 0,
    RETREAT: 1,
    STRAFE_L: 2,
    STRAFE_R: 3,
    SHOOT: 4,
    APPROACH_SHOOT: 5
  };

  const N_ACT = 6;
  const N_IN = 8;

  const RANGED = [
    "shotgun",
    "pistols",
    "dual-rifles",
    "sniper-rifle",
    "dual-pistols"
  ];

  let scene = null;
  let meNode = null;
  let foeNode = null;
  let model = null;

  let paused = false;
  let running = false;
  let calibrating = false;
  let timer = null;
  let step = 0;

  const held = {};

  const dirs = {
    up: { x: 0, z: 1 },
    down: { x: 0, z: -1 },
    left: { x: -1, z: 0 },
    right: { x: 1, z: 0 }
  };

  let memory = [];
  let prev = null;

  // HELPERS

  function pos(node) {
    const p = node.getAbsolutePosition();
    return { x: p.x, z: p.z };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function hp(hero) {
    const el = document.getElementById(
      (hero === "tiger" ? "t" : "k") + "-health-fill"
    );

    if (!el) return 1;

    const w = el.style.width;

    if (w && w.includes("%")) {
      return clamp(parseFloat(w) / 100, 0, 1);
    }

    const parent = el.parentElement;

    return parent && parent.offsetWidth
      ? clamp(el.offsetWidth / parent.offsetWidth, 0, 1)
      : 1;
  }

  function currentWeapon() {
    return typeof selectedWeapons !== "undefined"
      ? selectedWeapons[AI]
      : null;
  }

  // AI INPUT FEATURES

  function features() {
    const m = pos(meNode);
    const f = pos(foeNode);

    const dx = f.x - m.x;
    const dz = f.z - m.z;
    const d = Math.hypot(dx, dz) || 1e-6;

    return [
      dx / d,
      dz / d,
      Math.min(d / 60, 2),
      hp(AI),
      hp(FOE),
      Math.min(Math.abs(m.x) / 125, 1),
      Math.min(Math.abs(m.z) / 125, 1),
      RANGED.indexOf(currentWeapon()) > -1 ? 1 : 0
    ];
  }

  // BUTTON CONTROL

  function btn(action) {
    return document.querySelector(
      '.control[data-hero="' + AI +
      '"][data-action="' + action + '"]'
    );
  }

  function setHold(action, on) {
    if (!!held[action] === on) return;

    const button = btn(action);

    if (!button) return;

    held[action] = on;

    const EventCtor = window.PointerEvent || window.MouseEvent;

    button.dispatchEvent(
      new EventCtor(on ? "pointerdown" : "pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 77,
        pointerType: "touch"
      })
    );
  }

  function releaseAll() {
    ["up", "down", "left", "right", "shoot"]
      .forEach(action => setHold(action, false));
  }

  // LOCK TIGER CONTROLS

  function lockHumanOut() {
    ["-controls", "-weapons"].forEach(suffix => {
      const panel = document.getElementById(PREFIX + suffix);

      if (!panel) return;

      panel.setAttribute("title", "AI controlled");

      panel.style.setProperty(
        "pointer-events",
        "none",
        "important"
      );

      panel.querySelectorAll("button").forEach(button => {
        button.style.setProperty(
          "pointer-events",
          "none",
          "important"
        );
      });
    });

    const title = document.querySelector(
      "#" + PREFIX + "-weapons .hero-name"
    );

    if (title && !title.textContent.includes("AI")) {
      title.textContent += " · AI 🤖";
    }
  }

  // TENSORFLOW LOADER

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      if (window.tf) return resolve();

      const script = document.createElement("script");

      script.src = url;
      script.onload = resolve;
      script.onerror = reject;

      document.head.appendChild(script);
    });
  }

  // NEURAL NETWORK

  function buildModel() {
    const m = tf.sequential();

    m.add(tf.layers.dense({
      inputShape: [N_IN],
      units: 32,
      activation: "relu"
    }));

    m.add(tf.layers.dense({
      units: 32,
      activation: "relu"
    }));

    m.add(tf.layers.dense({
      units: N_ACT,
      activation: "softmax"
    }));

    m.compile({
      optimizer: tf.train.adam(0.003),
      loss: "categoricalCrossentropy"
    });

    return m;
  }

  // RULE-BASED AI TEACHER

  function teacher(s) {
    const distance = s[2] * 60;
    const myHealth = s[3];
    const ranged = s[7];
    const random = Math.random();

    const wantedDistance = ranged ? 28 : 12;

    if (myHealth < 0.25 && distance < wantedDistance) {
      return random < 0.5
        ? A.RETREAT
        : random < 0.75
          ? A.STRAFE_L
          : A.STRAFE_R;
    }

    if (distance > wantedDistance + 10) {
      return A.APPROACH;
    }

    if (distance > wantedDistance) {
      return A.APPROACH_SHOOT;
    }

    if (distance < wantedDistance * 0.4) {
      return random < 0.5 ? A.RETREAT : A.SHOOT;
    }

    if (random < 0.55) return A.SHOOT;
    if (random < 0.68) return A.STRAFE_L;
    if (random < 0.8) return A.STRAFE_R;

    return A.APPROACH_SHOOT;
  }

  // PRETRAINING

  function pretrain(m) {
    const xs = [];
    const ys = [];

    for (let i = 0; i < 3000; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 3 + Math.random() * 87;

      const s = [
        Math.cos(angle),
        Math.sin(angle),
        Math.min(distance / 60, 2),
        Math.random(),
        Math.random(),
        Math.random(),
        Math.random(),
        Math.random() < 0.5 ? 1 : 0
      ];

      const y = new Array(N_ACT).fill(0);
      y[teacher(s)] = 1;

      xs.push(s);
      ys.push(y);
    }

    const xt = tf.tensor2d(xs);
    const yt = tf.tensor2d(ys);

    return m.fit(xt, yt, {
      epochs: 12,
      batchSize: 64,
      shuffle: true,
      verbose: 0
    }).then(() => {
      xt.dispose();
      yt.dispose();
      return m;
    });
  }

  // INITIALIZE MODEL

  function initModel() {
    return loadScript(CFG.tfUrl)
      .then(() => {
        return tf.loadLayersModel(CFG.modelKey)
          .then(m => {
            m.compile({
              optimizer: tf.train.adam(0.001),
              loss: "categoricalCrossentropy"
            });

            return m;
          })
          .catch(() => {
            return pretrain(buildModel()).then(m => {
              return m.save(CFG.modelKey).then(() => m);
            });
          });
      })
      .then(m => {
        model = m;
      })
      .catch(error => {
        console.warn(
          "[TigerAI] TensorFlow unavailable. Using rule AI.",
          error
        );
      });
  }

  // DECISION ENGINE

  function decide(s) {
    if (Math.random() < CFG.epsilon) {
      return Math.floor(Math.random() * N_ACT);
    }

    if (!model) return teacher(s);

    const output = tf.tidy(() => {
      return model.predict(tf.tensor2d([s]));
    });

    const probabilities = output.dataSync();
    output.dispose();

    const random = Math.random();
    let cumulative = 0;

    for (let i = 0; i < N_ACT; i++) {
      cumulative += probabilities[i];

      if (random <= cumulative) return i;
    }

    return N_ACT - 1;
  }

  // LEARNING

  let learningBusy = false;

  function learnNow() {
    if (!model || !CFG.learn || learningBusy) return;

    const good = memory.filter(item => item.r > 0);

    if (good.length < 6) return;

    learningBusy = true;

    const xs = good.map(item => item.s);

    const ys = good.map(item => {
      const y = new Array(N_ACT).fill(0);
      y[item.a] = 1;
      return y;
    });

    const xt = tf.tensor2d(xs);
    const yt = tf.tensor2d(ys);

    model.fit(xt, yt, {
      epochs: 2,
      batchSize: 16,
      shuffle: true,
      verbose: 0
    })
      .then(() => model.save(CFG.modelKey))
      .catch(() => {})
      .then(() => {
        xt.dispose();
        yt.dispose();
        memory = memory.slice(-60);
        learningBusy = false;
      });
  }

  // MOVEMENT

  function buttonsFor(vx, vz) {
    const candidates = Object.keys(dirs)
      .map(action => ({
        action,
        dot: dirs[action].x * vx + dirs[action].z * vz
      }))
      .sort((a, b) => b.dot - a.dot);

    const output = [];

    if (candidates[0] && candidates[0].dot > 0.3) {
      output.push(candidates[0].action);
    }

    if (candidates[1] && candidates[1].dot > 0.45) {
      output.push(candidates[1].action);
    }

    return output;
  }

  function canShoot() {
    const weapon = currentWeapon();

    return weapon &&
      (!window.WeaponAccess ||
       window.WeaponAccess.isUnlocked(AI, weapon));
  }

  // EXECUTE ACTION

  function perform(action, s) {
    const ux = s[0];
    const uz = s[1];

    let vx = 0;
    let vz = 0;
    let shoot = false;

    switch (action) {
      case A.APPROACH:
        vx = ux;
        vz = uz;
        break;

      case A.RETREAT:
        vx = -ux;
        vz = -uz;
        break;

      case A.STRAFE_L:
        vx = -uz;
        vz = ux;
        break;

      case A.STRAFE_R:
        vx = uz;
        vz = -ux;
        break;

      case A.SHOOT:
        shoot = true;
        break;

      case A.APPROACH_SHOOT:
        vx = ux;
        vz = uz;
        shoot = true;
        break;
    }

    const m = pos(meNode);

    if (Math.abs(m.x) > 112 || Math.abs(m.z) > 112) {
      const length = Math.hypot(m.x, m.z) || 1;

      vx = -m.x / length;
      vz = -m.z / length;
    }

    const wanted = (vx || vz)
      ? buttonsFor(vx, vz)
      : [];

    ["up", "down", "left", "right"].forEach(action => {
      setHold(action, wanted.includes(action));
    });

    setHold("shoot", shoot && !!canShoot());

    return wanted;
  }

  // WEAPON SELECTION

  function chooseWeapon(distance) {
    const list = window.WeaponAccess
      ? window.WeaponAccess.unlockedList(AI)
      : Array.from(document.querySelectorAll(
          '.weapon[data-hero="' + AI + '"]'
        )).map(button => button.dataset.weapon);

    if (!list || !list.length) return;

    const ranged = list.filter(w => RANGED.includes(w));
    const melee = list.filter(w => !RANGED.includes(w));

    const pool = distance > 20 && ranged.length
      ? ranged
      : distance < 14 && melee.length
        ? melee
        : list;

    const pick = pool[Math.floor(Math.random() * pool.length)];

    if (pick === currentWeapon()) return;

    const button = document.querySelector(
      '.weapon[data-hero="' + AI +
      '"][data-weapon="' + pick + '"]'
    );

    if (button) button.click();
  }

  // MOVEMENT CALIBRATION

  function calibrate(done) {
    calibrating = true;

    const actions = ["up", "down", "left", "right"];
    let i = 0;

    function next() {
      if (i >= actions.length) {
        calibrating = false;
        return done();
      }

      const action = actions[i++];
      const p0 = pos(meNode);

      setHold(action, true);

      setTimeout(() => {
        const p1 = pos(meNode);

        setHold(action, false);

        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const length = Math.hypot(dx, dz);

        if (length > 0.05) {
          dirs[action] = {
            x: dx / length,
            z: dz / length
          };
        } else {
          console.warn(
            "[TigerAI] Button did not move Tiger:",
            action
          );
        }

        setTimeout(next, 200);
      }, 400);
    }

    next();
  }

  // MAIN AI LOOP

  function tick() {
    if (!running || paused || calibrating) return;

    if (hp(AI) <= 0 || hp(FOE) <= 0) {
      releaseAll();
      return;
    }

    const s = features();
    const mp = pos(meNode);

    step++;

    if (prev) {
      const reward =
        (prev.foeHp - hp(FOE)) -
        (prev.myHp - hp(AI));

      if (reward !== 0) {
        memory.slice(-3).forEach(item => {
          item.r += reward;
        });
      }

      if (prev.want.length === 1) {
        const dx = mp.x - prev.pos.x;
        const dz = mp.z - prev.pos.z;
        const length = Math.hypot(dx, dz);

        if (length > 0.1) {
          const old = dirs[prev.want[0]];

          const nx = 0.8 * old.x + 0.2 * dx / length;
          const nz = 0.8 * old.z + 0.2 * dz / length;

          const n = Math.hypot(nx, nz) || 1;

          dirs[prev.want[0]] = {
            x: nx / n,
            z: nz / n
          };
        }
      }
    }

    if (step % 18 === 1) {
      chooseWeapon(s[2] * 60);
    }

    const action = decide(s);

    memory.push({
      s,
      a: action,
      r: 0
    });

    const wanted = perform(action, s);

    prev = {
      foeHp: hp(FOE),
      myHp: hp(AI),
      pos: mp,
      want: wanted
    };

    if (step % 40 === 0) {
      learnNow();
    }
  }

  // START / STOP

  function start() {
    if (running) return;

    running = true;
    prev = null;

    timer = setInterval(tick, CFG.stepMs);

    console.log("[TigerAI] AI started!");
  }

  function stop() {
    running = false;

    clearInterval(timer);
    releaseAll();

    console.log("[TigerAI] AI stopped!");
  }

  // PAUSE EVENTS

  window.addEventListener("gamepause", event => {
    paused = !!(event.detail && event.detail.paused);

    if (paused) releaseAll();
  });

  window.addEventListener("blur", releaseAll);

  // WAIT FOR BOTH HEROES

  function waitForHeroes(callback) {
    let tries = 0;

    const maxTries = 400;

    function poll() {
      scene = window.gameScene || null;

      const registry = window.gameHeroes || {};

      meNode = registry[AI] && registry[AI].root;
      foeNode = registry[FOE] && registry[FOE].root;

      if (scene && !meNode) {
        meNode = scene.getTransformNodeByName(AI + "Root");
      }

      if (scene && !foeNode) {
        foeNode = scene.getTransformNodeByName(FOE + "Root");
      }

      if (scene && meNode && foeNode) {
        console.log("[TigerAI] Hero roots found:", AI, FOE);
        return callback();
      }

      if (++tries > maxTries) {
        console.error(
          "[TigerAI] Timed out waiting for hero roots.",
          {
            sceneAvailable: !!scene,
            aiHero: !!meNode,
            opponent: !!foeNode,
            expected: [AI + "Root", FOE + "Root"]
          }
        );

        return;
      }

      setTimeout(poll, 300);
    }

    poll();
  }

  // PUBLIC API

  window.TigerAI = {
    start,
    stop,

    learning: function (on) {
      CFG.learn = !!on;
    },

    reset: function () {
      if (window.tf) {
        tf.io.removeModel(CFG.modelKey).catch(() => {});
      }

      try {
        localStorage.removeItem(
          "tensorflowjs_models/kabir-vs-tiger-ai-v1/info"
        );
      } catch (error) {}

      location.reload();
    }
  };

  // INITIALIZATION

  lockHumanOut();

  waitForHeroes(function () {
    initModel().then(function () {
      calibrate(function () {
        setTimeout(start, CFG.startDelayMs);
      });
    });
  });

})();