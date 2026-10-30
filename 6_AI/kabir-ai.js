
/* ================================================================
   KABIR AI — TIGER VS AI KABIR
   Human: TIGER (green controls)
   AI: KABIR (red controls)

   Load AFTER weapon-access.js.

   API:
   window.KabirAI.start()
   window.KabirAI.stop()
   window.KabirAI.reset()
   window.KabirAI.learning(true / false)
   ================================================================ */

(function () {
  "use strict";

  /* ---------------- SETTINGS ---------------- */

  var CFG = {
    stepMs: 220,
    startDelayMs: 1500,
    epsilon: 0.08,
    learn: true,
    modelKey: "localstorage://tiger-vs-kabir-ai-v1",
    tfUrl: "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"
  };

  /* Tiger is the human; Kabir is the AI. */
  var AI = "kabir"; // Kabir is ALWAYS the AI in this file
  var FOE = AI === "tiger" ? "kabir" : "tiger";
  var PREFIX = AI === "tiger" ? "t" : "k";

  var A = {
    APPROACH: 0,
    RETREAT: 1,
    STRAFE_L: 2,
    STRAFE_R: 3,
    SHOOT: 4,
    APPROACH_SHOOT: 5
  };

  var N_ACT = 6;
  var N_IN = 8;

  var RANGED = [
    "shotgun",
    "pistols",
    "dual-rifles",
    "sniper-rifle",
    "dual-pistols"
  ];

  var scene;
  var meNode;
  var foeNode;
  var model = null;
  var tfReady = false;

  var paused = false;
  var running = false;
  var calibrating = false;
  var timer = null;
  var step = 0;

  var held = {};

  var dirs = {
    up: { x: 0, z: 1 },
    down: { x: 0, z: -1 },
    left: { x: -1, z: 0 },
    right: { x: 1, z: 0 }
  };

  var memory = [];
  var prev = null;

  /* ---------------- HELPERS ---------------- */

  function pos(node) {
    var p = node.getAbsolutePosition();
    return { x: p.x, z: p.z };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function hp(hero) {
    var el = document.getElementById(
      (hero === "tiger" ? "t" : "k") + "-health-fill"
    );

    if (!el) return 1;

    var w = el.style.width;

    if (w && w.indexOf("%") > -1) {
      return clamp(parseFloat(w) / 100, 0, 1);
    }

    var parent = el.parentElement;

    return parent && parent.offsetWidth
      ? clamp(el.offsetWidth / parent.offsetWidth, 0, 1)
      : 1;
  }

  function currentWeapon() {
    return typeof selectedWeapons !== "undefined"
      ? selectedWeapons[AI]
      : null;
  }

  /* ---------------- AI INPUT FEATURES ---------------- */

  function features() {
    var m = pos(meNode);
    var f = pos(foeNode);

    var dx = f.x - m.x;
    var dz = f.z - m.z;
    var d = Math.hypot(dx, dz) || 0.000001;

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

  /* ---------------- CONTROL BUTTONS ---------------- */

  function btn(action) {
    return document.querySelector(
      '.control[data-hero="' + AI +
      '"][data-action="' + action + '"]'
    );
  }

  function setHold(action, on) {
    if (!!held[action] === on) return;

    var button = btn(action);
    if (!button) return;

    held[action] = on;

    button.dispatchEvent(
      new PointerEvent(on ? "pointerdown" : "pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 77,
        pointerType: "touch"
      })
    );
  }

  function releaseAll() {
    ["up", "down", "left", "right", "shoot"].forEach(
      function (action) {
        setHold(action, false);
      }
    );
  }

  /* ---------------- LOCK AI CONTROLS ---------------- */

  function lockHumanOut() {
    ["-controls", "-weapons"].forEach(function (suffix) {
      var panel = document.getElementById(PREFIX + suffix);

      if (!panel) return;

      panel.setAttribute("title", "AI controlled");

      panel.style.setProperty(
        "pointer-events",
        "none",
        "important"
      );

      panel.querySelectorAll("button").forEach(function (button) {
        button.style.setProperty(
          "pointer-events",
          "none",
          "important"
        );
      });
    });

    var heading = document.querySelector(
      "#" + PREFIX + "-weapons .hero-name"
    );

    if (heading && heading.textContent.indexOf("AI") === -1) {
      heading.textContent += " · AI 🤖";
    }
  }

  /* ---------------- LOAD TENSORFLOW ---------------- */

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      if (window.tf) {
        resolve();
        return;
      }

      var script = document.createElement("script");

      script.src = url;
      script.onload = resolve;
      script.onerror = reject;

      document.head.appendChild(script);
    });
  }

  /* ---------------- NEURAL NETWORK ---------------- */

  function buildModel() {
    var m = tf.sequential();

    m.add(
      tf.layers.dense({
        inputShape: [N_IN],
        units: 32,
        activation: "relu"
      })
    );

    m.add(
      tf.layers.dense({
        units: 32,
        activation: "relu"
      })
    );

    m.add(
      tf.layers.dense({
        units: N_ACT,
        activation: "softmax"
      })
    );

    m.compile({
      optimizer: tf.train.adam(0.003),
      loss: "categoricalCrossentropy"
    });

    return m;
  }

  /* ---------------- AI TEACHER ---------------- */

  function teacher(s) {
    var distance = s[2] * 60;
    var myHp = s[3];
    var ranged = s[7];
    var random = Math.random();

    var want = ranged ? 28 : 12;

    if (myHp < 0.25 && distance < want) {
      return random < 0.5
        ? A.RETREAT
        : random < 0.75
          ? A.STRAFE_L
          : A.STRAFE_R;
    }

    if (distance > want + 10) {
      return A.APPROACH;
    }

    if (distance > want) {
      return A.APPROACH_SHOOT;
    }

    if (distance < want * 0.4) {
      return random < 0.5 ? A.RETREAT : A.SHOOT;
    }

    if (random < 0.55) return A.SHOOT;
    if (random < 0.68) return A.STRAFE_L;
    if (random < 0.8) return A.STRAFE_R;

    return A.APPROACH_SHOOT;
  }

  /* ---------------- PRETRAINING ---------------- */

  function pretrain(m) {
    var xs = [];
    var ys = [];

    for (var i = 0; i < 3000; i++) {
      var angle = Math.random() * Math.PI * 2;
      var distance = 3 + Math.random() * 87;

      var s = [
        Math.cos(angle),
        Math.sin(angle),
        Math.min(distance / 60, 2),
        Math.random(),
        Math.random(),
        Math.random(),
        Math.random(),
        Math.random() < 0.5 ? 1 : 0
      ];

      var y = new Array(N_ACT).fill(0);
      y[teacher(s)] = 1;

      xs.push(s);
      ys.push(y);
    }

    var xt = tf.tensor2d(xs);
    var yt = tf.tensor2d(ys);

    return m.fit(xt, yt, {
      epochs: 12,
      batchSize: 64,
      shuffle: true,
      verbose: 0
    }).then(function () {
      xt.dispose();
      yt.dispose();
      return m;
    });
  }

  /* ---------------- INITIALIZE MODEL ---------------- */

  function initModel() {
    return loadScript(CFG.tfUrl)
      .then(function () {
        tfReady = true;

        return tf.loadLayersModel(CFG.modelKey)
          .then(function (loaded) {
            loaded.compile({
              optimizer: tf.train.adam(0.001),
              loss: "categoricalCrossentropy"
            });

            return loaded;
          })
          .catch(function () {
            return pretrain(buildModel()).then(function (trained) {
              return trained.save(CFG.modelKey).then(function () {
                return trained;
              });
            });
          });
      })
      .then(function (loaded) {
        model = loaded;
      })
      .catch(function (error) {
        console.warn(
          "[KabirAI] TensorFlow.js unavailable. Using rule-based AI.",
          error
        );
      });
  }

  /* ---------------- AI DECISION ---------------- */

  function decide(s) {
    if (Math.random() < CFG.epsilon) {
      return Math.floor(Math.random() * N_ACT);
    }

    if (!model) {
      return teacher(s);
    }

    var output = tf.tidy(function () {
      return model.predict(tf.tensor2d([s]));
    });

    var probabilities = output.dataSync();
    output.dispose();

    var random = Math.random();
    var cumulative = 0;

    for (var i = 0; i < N_ACT; i++) {
      cumulative += probabilities[i];

      if (random <= cumulative) {
        return i;
      }
    }

    return N_ACT - 1;
  }

  /* ---------------- LEARNING ---------------- */

  var learningBusy = false;

  function learnNow() {
    if (!model || !CFG.learn || learningBusy) return;

    var good = memory.filter(function (item) {
      return item.r > 0;
    });

    if (good.length < 6) return;

    learningBusy = true;

    var xs = good.map(function (item) {
      return item.s;
    });

    var ys = good.map(function (item) {
      var y = new Array(N_ACT).fill(0);
      y[item.a] = 1;
      return y;
    });

    var xt = tf.tensor2d(xs);
    var yt = tf.tensor2d(ys);

    model.fit(xt, yt, {
      epochs: 2,
      batchSize: 16,
      shuffle: true,
      verbose: 0
    })
      .then(function () {
        return model.save(CFG.modelKey);
      })
      .catch(function () {})
      .then(function () {
        xt.dispose();
        yt.dispose();

        memory = memory.slice(-60);
        learningBusy = false;
      });
  }

  /* ---------------- MOVEMENT ---------------- */

  function buttonsFor(vx, vz) {
    var candidates = Object.keys(dirs)
      .map(function (action) {
        var d = dirs[action];

        return {
          action: action,
          dot: d.x * vx + d.z * vz
        };
      })
      .sort(function (a, b) {
        return b.dot - a.dot;
      });

    var result = [];

    if (candidates[0] && candidates[0].dot > 0.3) {
      result.push(candidates[0].action);
    }

    if (candidates[1] && candidates[1].dot > 0.45) {
      result.push(candidates[1].action);
    }

    return result;
  }

  function perform(action, s) {
    var ux = s[0];
    var uz = s[1];

    var vx = 0;
    var vz = 0;
    var shoot = false;

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

    var m = pos(meNode);

    /* Return to arena centre near the boundary. */
    if (Math.abs(m.x) > 112 || Math.abs(m.z) > 112) {
      var length = Math.hypot(m.x, m.z) || 1;

      vx = -m.x / length;
      vz = -m.z / length;
    }

    var wanted = (vx || vz)
      ? buttonsFor(vx, vz)
      : [];

    ["up", "down", "left", "right"].forEach(function (button) {
      setHold(button, wanted.indexOf(button) > -1);
    });

    setHold("shoot", shoot && !!canShoot());

    return wanted;
  }

  /* ---------------- SHOOT CHECK ---------------- */

  function canShoot() {
    var weapon = currentWeapon();

    return weapon &&
      (!window.WeaponAccess ||
        window.WeaponAccess.isUnlocked(AI, weapon));
  }

  /* ---------------- WEAPON SELECTION ---------------- */

  function chooseWeapon(distance) {
    var list = window.WeaponAccess
      ? window.WeaponAccess.unlockedList(AI)
      : Array.prototype.map.call(
          document.querySelectorAll(
            '.weapon[data-hero="' + AI + '"]'
          ),
          function (button) {
            return button.dataset.weapon;
          }
        );

    if (!list || !list.length) return;

    var ranged = list.filter(function (weapon) {
      return RANGED.indexOf(weapon) > -1;
    });

    var melee = list.filter(function (weapon) {
      return RANGED.indexOf(weapon) === -1;
    });

    var pool = distance > 20 && ranged.length
      ? ranged
      : distance < 14 && melee.length
        ? melee
        : list;

    var pick = pool[Math.floor(Math.random() * pool.length)];

    if (pick === currentWeapon()) return;

    var button = document.querySelector(
      '.weapon[data-hero="' + AI +
      '"][data-weapon="' + pick + '"]'
    );

    if (button) button.click();
  }

  /* ---------------- MOVEMENT CALIBRATION ---------------- */

  function calibrate(done) {
    calibrating = true;

    var actions = ["up", "down", "left", "right"];
    var index = 0;

    (function next() {
      if (index >= actions.length) {
        calibrating = false;
        return done();
      }

      var action = actions[index++];
      var before = pos(meNode);

      setHold(action, true);

      setTimeout(function () {
        var after = pos(meNode);

        setHold(action, false);

        var dx = after.x - before.x;
        var dz = after.z - before.z;
        var length = Math.hypot(dx, dz);

        if (length > 0.05) {
          dirs[action] = {
            x: dx / length,
            z: dz / length
          };
        } else {
          console.warn(
            "[KabirAI] '" + action +
            "' did not move Kabir; using default direction."
          );
        }

        setTimeout(next, 200);
      }, 400);
    })();
  }

  /* ---------------- MAIN AI LOOP ---------------- */

  function tick() {
    if (!running || paused || calibrating) return;

    if (hp(AI) <= 0 || hp(FOE) <= 0) {
      releaseAll();
      return;
    }

    var s = features();
    var myPosition = pos(meNode);

    step++;

    /* Reward from previous action. */
    if (prev) {
      var reward =
        (prev.foeHp - hp(FOE)) -
        (prev.myHp - hp(AI));

      if (reward !== 0) {
        memory.slice(-3).forEach(function (item) {
          item.r += reward;
        });
      }

      /* Improve movement direction estimates. */
      if (prev.want.length === 1) {
        var dx = myPosition.x - prev.pos.x;
        var dz = myPosition.z - prev.pos.z;
        var length = Math.hypot(dx, dz);

        if (length > 0.1) {
          var direction = dirs[prev.want[0]];

          var nx = 0.8 * direction.x + 0.2 * dx / length;
          var nz = 0.8 * direction.z + 0.2 * dz / length;

          var normal = Math.hypot(nx, nz) || 1;

          dirs[prev.want[0]] = {
            x: nx / normal,
            z: nz / normal
          };
        }
      }
    }

    if (step % 18 === 1) {
      chooseWeapon(s[2] * 60);
    }

    var action = decide(s);

    memory.push({
      s: s,
      a: action,
      r: 0
    });

    var wanted = perform(action, s);

    prev = {
      foeHp: hp(FOE),
      myHp: hp(AI),
      pos: myPosition,
      want: wanted
    };

    if (step % 40 === 0) {
      learnNow();
    }
  }

  /* ---------------- START / STOP ---------------- */

  function start() {
    if (running) return;

    running = true;
    prev = null;

    timer = setInterval(tick, CFG.stepMs);
  }

  function stop() {
    running = false;

    clearInterval(timer);
    releaseAll();
  }

  window.addEventListener("gamepause", function (event) {
    paused = !!(event.detail && event.detail.paused);

    if (paused) {
      releaseAll();
    }
  });

  window.addEventListener("blur", releaseAll);

  /* ---------------- FIND HERO MODELS ---------------- */

  function waitForHeroes(callback) {
    var tries = 0;

    (function poll() {
      scene = window.gameScene ||
        (window.BABYLON && BABYLON.Engine &&
          BABYLON.Engine.LastCreatedScene);

      var registry = window.gameHeroes || {};

      meNode = registry[AI] && registry[AI].root;
      foeNode = registry[FOE] && registry[FOE].root;

      if (scene && !meNode) {
        meNode = scene.getTransformNodeByName(AI + "Root");
      }

      if (scene && !foeNode) {
        foeNode = scene.getTransformNodeByName(FOE + "Root");
      }

      if (scene && meNode && foeNode) {
        console.log("[KabirAI] Hero roots found:", AI, FOE);
        return callback();
      }

      if (++tries > 400) {
        console.error(
          "[KabirAI] Timed out waiting for hero roots (" +
          AI + "Root / " + FOE + "Root)."
        );

        return;
      }

      setTimeout(poll, 300);
    })();
  }

  /* ---------------- PUBLIC API ---------------- */

  window.KabirAI = {
    start: start,
    stop: stop,

    learning: function (on) {
      CFG.learn = !!on;
    },

    reset: function () {
      if (window.tf) {
        tf.io.removeModel(CFG.modelKey).catch(function () {});
      }

      try {
        localStorage.removeItem(
          "tensorflowjs_models/tiger-vs-kabir-ai-v1/info"
        );
      } catch (error) {}

      location.reload();
    }
  };

  /* ---------------- INITIALIZE ---------------- */

  lockHumanOut();

  waitForHeroes(function () {
    initModel().then(function () {
      calibrate(function () {
        setTimeout(start, CFG.startDelayMs);
      });
    });
  });

})();


