/* =====================================================================
   KABIR VS TIGER 3D  -  final-shot.js      ( "kill cam" / last-shot slow motion )

   When a shot is going to FINISH the opponent:
     1. the game drops into SLOW MOTION while the bullet / weapon is still
        flying, and a cinematic camera chases it to the opponent
     2. extra slow "bullet time" right before impact
     3. on the KO: white flash, camera shake, "K.O." text, camera orbits the
        fallen hero in slow motion
     4. THEN the normal "<HERO> WINS!" screen appears (delayed until the
        cinematic is finished)

   It works for BOTH heroes (if the AI lands the last hit you see it too)
   and for guns AND melee weapons.  weapons.js / controls.js are NOT changed:
   slow motion is done by scaling the engine's delta time, so every script that
   uses scene.getEngine().getDeltaTime() slows down together.

   ADD  (in BOTH html files, after weapons.js and bullets.js):
     <script src="../4_GAME_LOGICS/final-shot.js"></script>

   TEST QUICKLY (browser console, F12):
     heroHealth.tiger = 4      // now one more hit kills Tiger  -> shoot him
     heroHealth.kabir = 4
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     1) SETTINGS
     ------------------------------------------------------------------ */
  const CFG = {
    slowScale:   0.15,   // game speed while the killing shot flies (1 = normal)
    impactScale: 0.05,   // extra slow right before the hit ("bullet time")
    koScale:     0.08,   // speed during the KO moment
    koHold:      2.2,    // seconds (real time) of cinematic after the kill, then WINS screen
    fov:         0.75,   // kill-cam field of view (smaller = more zoom)
    camSmooth:   9,      // kill-cam follow speed (higher = tighter)
    meleeSpeed:  35,     // weapon speed (units/s) toward the opponent that counts as "attack started"
    predictKill: true,   // false = no slow motion before impact, only the KO moment

    letterbox: true,     // black cinema bars
    vignette:  true,
    flash:     true,     // white flash on the kill
    shake:     true,     // camera shake on the kill
    hideHud:   true,     // fade the buttons / panels during the cinematic

    label:  "FINAL SHOT",
    koText: "K.O.",
    debug:  false
  };

  /* damage + shots per trigger pull, copied from weapons.js (change if you change weapons.js)
       type   : "gun" | "melee"
       dmg    : damage of ONE bullet / ONE melee hit
       volley : bullets per trigger pull (guns only)                        */
  const WEAPON_INFO = {
    tiger: {
      "hand-grips":  { type: "melee", dmg: 6 },
      "hammer":      { type: "melee", dmg: 16 },
      "shotgun":     { type: "gun",   dmg: 3,  volley: 5 },
      "pistols":     { type: "gun",   dmg: 4,  volley: 2 },
      "dual-swords": { type: "melee", dmg: 9 }
    },
    kabir: {
      "katana":       { type: "melee", dmg: 10 },
      "dual-rifles":  { type: "gun",   dmg: 3,  volley: 6 },
      "dual-axes":    { type: "melee", dmg: 12 },
      "sniper-rifle": { type: "gun",   dmg: 20, volley: 1 },
      "dual-pistols": { type: "gun",   dmg: 4,  volley: 2 }
    }
  };

  /* ------------------------------------------------------------------
     2) Small helpers (plain {x,y,z} vectors)
     ------------------------------------------------------------------ */
  const HEROES = ["tiger", "kabir"];
  const OPP = { tiger: "kabir", kabir: "tiger" };

  const vec = (x, y, z) => ({ x: x || 0, y: y || 0, z: z || 0 });
  const vadd = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
  const vsub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
  const vmul = (a, k) => vec(a.x * k, a.y * k, a.z * k);
  const vlen = a => Math.hypot(a.x, a.y, a.z);
  const vnorm = a => { const l = vlen(a) || 1; return vec(a.x / l, a.y / l, a.z / l); };
  const vlerp = (a, b, k) => vec(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
  const vdist = (a, b) => vlen(vsub(a, b));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => t * t * (3 - 2 * t);
  const fromB = v => vec(v.x, v.y, v.z);
  function log() { if (CFG.debug) console.log.apply(console, ["[final-shot]"].concat([].slice.call(arguments))); }

  /* ------------------------------------------------------------------
     3) State
     ------------------------------------------------------------------ */
  let scene = null, engine = null, prevCam = null, kc = null;
  const roots = {};
  const info = {};                              // hero -> { H, chestOff }
  const selected = { tiger: "hand-grips", kabir: "katana" };
  const health = { tiger: 100, kabir: 100 };

  let ts = 1;                                   // current game speed
  let scaleUsed = 1;                            // speed the engine really used this frame
  let target = 1;                               // speed we are easing to
  let origGetDelta = null;
  let paused = false;

  let phase = "idle";                           // idle | slow | ko | return
  let gt = 0;                                   // game-time clock (slows down with the game)
  let rt = 0;                                   // real-time clock (seconds)
  let lethal = null;                            // { kind, owner, victim, t0 }
  const lastVolley = { tiger: -9, kabir: -9 };
  const pendingBullets = [];
  const bullets = [];                           // { mesh, owner }
  const prevHolder = {};                        // hero -> last holder position

  let camPos = vec(), camTgt = vec(), camFov = 0.9;
  let ko = null;                                // { victim, attacker, t0, angle, end }
  let ret = null;                               // return flight { t0 }
  let fx = null;                                // dom elements

  /* ------------------------------------------------------------------
     4) Hero info
     ------------------------------------------------------------------ */
  function measureHero(name) {
    const root = roots[name];
    let H = 18, chestOff = 9;
    try {
      root.computeWorldMatrix(true);
      root.getDescendants(false).forEach(n => n.computeWorldMatrix && n.computeWorldMatrix(true));
      const meshes = root.getChildMeshes(false).filter(m => m.getTotalVertices && m.getTotalVertices() > 0);
      if (meshes.length) {
        let minY = Infinity, maxY = -Infinity;
        meshes.forEach(m => {
          const bb = m.getBoundingInfo().boundingBox;
          minY = Math.min(minY, bb.minimumWorld.y);
          maxY = Math.max(maxY, bb.maximumWorld.y);
        });
        const h = maxY - minY;
        if (isFinite(h) && h > 0.01) { H = h; chestOff = (minY + h * 0.58) - root.position.y; }
      }
    } catch (e) { /* keep defaults */ }
    info[name] = { H: H, chestOff: chestOff };
  }

  const H = n => (info[n] ? info[n].H : 18);
  const rootPos = n => fromB(roots[n].position);
  const chest = n => vec(roots[n].position.x, roots[n].position.y + info[n].chestOff, roots[n].position.z);

  function getHealth(n) {
    if (typeof heroHealth !== "undefined" && heroHealth && typeof heroHealth[n] === "number") return heroHealth[n];
    return health[n];
  }

  /* ------------------------------------------------------------------
     5) Slow motion: scale the engine's delta time
     ------------------------------------------------------------------ */
  function hookEngine() {
    origGetDelta = engine.getDeltaTime.bind(engine);
    engine.getDeltaTime = function () {
      scaleUsed = ts;
      return origGetDelta() * ts;
    };
  }

  /* ------------------------------------------------------------------
     6) Cinematic DOM (bars, vignette, flash, texts)
     ------------------------------------------------------------------ */
  function buildFx() {
    const css = document.createElement("style");
    css.textContent =
      "#fs-fx{position:fixed;inset:0;z-index:40;pointer-events:none;overflow:hidden;font-family:Arial,sans-serif}" +
      "#fs-fx .bar{position:absolute;left:0;right:0;height:0;background:#000;transition:height .45s ease}" +
      "#fs-fx .top{top:0}#fs-fx .bot{bottom:0}" +
      "#fs-fx.on.lb .bar{height:11vh}" +
      "#fs-fx .vig{position:absolute;inset:0;opacity:0;transition:opacity .5s;" +
        "background:radial-gradient(ellipse at center,transparent 45%,rgba(0,0,0,.68) 100%)}" +
      "#fs-fx.on.vg .vig{opacity:1}" +
      "#fs-fx .flash{position:absolute;inset:0;background:#fff;opacity:0}" +
      "#fs-fx .label{position:absolute;left:0;right:0;top:calc(11vh + 12px);text-align:center;color:#fff;" +
        "font-weight:900;letter-spacing:6px;font-size:clamp(12px,3vw,20px);opacity:0;transition:opacity .3s;" +
        "text-shadow:0 0 12px #ff3b3b}" +
      "#fs-fx.on .label{opacity:1;animation:fsBlink 1s infinite}" +
      "#fs-fx.ko .label{opacity:0;animation:none}" +
      "#fs-fx .kotext{position:absolute;left:0;right:0;top:40%;text-align:center;color:#fff;font-weight:900;" +
        "font-size:clamp(54px,18vw,140px);letter-spacing:8px;opacity:0;transform:scale(2.4);" +
        "text-shadow:0 0 30px #ff2a2a,0 0 70px #ff2a2a}" +
      "#fs-fx.ko .kotext{animation:fsPop .5s ease-out forwards}" +
      "@keyframes fsPop{0%{opacity:0;transform:scale(2.4)}60%{opacity:1;transform:scale(.94)}100%{opacity:1;transform:scale(1)}}" +
      "@keyframes fsBlink{0%,100%{opacity:1}50%{opacity:.35}}";
    document.head.appendChild(css);

    const root = document.createElement("div");
    root.id = "fs-fx";
    root.innerHTML =
      '<div class="vig"></div><div class="bar top"></div><div class="bar bot"></div>' +
      '<div class="flash"></div><div class="label"></div><div class="kotext"></div>';
    document.body.appendChild(root);
    root.querySelector(".label").textContent = CFG.label;
    root.querySelector(".kotext").textContent = CFG.koText;
    fx = { root: root, flash: root.querySelector(".flash") };
  }

  function fxOn(koMode) {
    if (!fx) return;
    fx.root.classList.add("on");
    fx.root.classList.toggle("lb", !!CFG.letterbox);
    fx.root.classList.toggle("vg", !!CFG.vignette);
    if (koMode) fx.root.classList.add("ko");
    hud(false);
  }
  function fxOff() {
    if (!fx) return;
    fx.root.classList.remove("on", "ko", "lb", "vg");
    hud(true);
  }
  function hud(show) {
    if (!CFG.hideHud) return;
    const g = document.getElementById("game");
    if (!g) return;
    g.style.transition = "opacity .4s";
    g.style.opacity = show ? "1" : "0.12";
  }
  function flash() {
    if (!fx || !CFG.flash) return;
    fx.flash.style.transition = "none";
    fx.flash.style.opacity = "0.75";
    void fx.flash.offsetWidth;
    fx.flash.style.transition = "opacity .5s ease-out";
    fx.flash.style.opacity = "0";
  }

  /* ------------------------------------------------------------------
     7) Kill camera
     ------------------------------------------------------------------ */
  function camTargetOf(cam) {
    if (cam.getTarget) return fromB(cam.getTarget());
    const d = cam.getForwardRay(30).direction;
    return vadd(fromB(cam.position), vmul(fromB(d), 30));
  }

  function camStart() {
    if (!kc) {
      kc = new BABYLON.FreeCamera("finalShotCam", new BABYLON.Vector3(0, 30, -60), scene);
      kc.minZ = 0.3;
    }
    if (scene.activeCamera !== kc) {
      prevCam = scene.activeCamera;
      camPos = fromB(prevCam.position);
      camTgt = camTargetOf(prevCam);
      camFov = prevCam.fov;
      kc.maxZ = prevCam.maxZ || 10000;
      kc.fov = camFov;
      kc.position.copyFromFloats(camPos.x, camPos.y, camPos.z);
      kc.setTarget(new BABYLON.Vector3(camTgt.x, camTgt.y, camTgt.z));
      scene.activeCamera = kc;
    }
  }

  function camEnd() {
    if (prevCam && scene.activeCamera === kc) scene.activeCamera = prevCam;
    prevCam = null;
  }

  function camApply(rdt, desPos, desTgt, desFov, shakeAmp) {
    const k = 1 - Math.exp(-CFG.camSmooth * rdt);
    camPos = vlerp(camPos, desPos, k);
    camTgt = vlerp(camTgt, desTgt, k);
    camFov += (desFov - camFov) * k;
    let p = camPos;
    if (shakeAmp > 0) p = vadd(p, vec((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp));
    kc.position.copyFromFloats(p.x, p.y, p.z);
    kc.setTarget(new BABYLON.Vector3(camTgt.x, camTgt.y, camTgt.z));
    kc.fov = camFov;
  }

  /* what the camera should look at while the killing shot is in the air */
  function shotFocus() {
    const L = lethal;
    const v = chest(L.victim), h = H(L.victim);
    const up = vec(0, 1, 0);

    if (L.kind === "gun") {
      let P = null;
      const mine = bullets.filter(b => b.owner === L.owner && !b.mesh.isDisposed());
      if (mine.length) {
        let sum = vec();
        mine.forEach(b => { sum = vadd(sum, fromB(b.mesh.position)); });
        P = vmul(sum, 1 / mine.length);
      } else {
        P = chest(L.owner);
      }
      const dir = vnorm(vsub(v, P));
      let right = vec(dir.z, 0, -dir.x);                       // horizontal right of the flight line
      right = vnorm(right);
      const chasePos = vadd(vsub(P, vmul(dir, h * 1.6)), vadd(vmul(right, h * 0.55), vmul(up, h * 0.25)));
      const chaseTgt = vadd(P, vmul(dir, h * 2.5));
      const prox = ease(clamp(1 - vdist(P, v) / (h * 2.5), 0, 1));
      const sidePos = vadd(v, vadd(vmul(right, h * 2.4), vmul(up, h * 0.2)));
      return {
        pos: vlerp(chasePos, sidePos, prox),
        tgt: vlerp(chaseTgt, v, prox),
        near: vdist(P, v) < h * 1.4
      };
    }

    // melee: camera in front of the victim watching the weapon arrive
    const node = holderNode(L.owner);
    const W = node ? fromB(node.getAbsolutePosition()) : chest(L.owner);
    const A = rootPos(L.owner);
    let dirAV = vnorm(vec(v.x - A.x, 0, v.z - A.z));
    const side = vec(dirAV.z, 0, -dirAV.x);
    const pos = vadd(vsub(v, vmul(dirAV, h * 1.1)), vadd(vmul(side, h * 0.9), vmul(up, h * 0.25)));
    const prox = ease(clamp(1 - vdist(W, v) / (h * 2.5), 0, 1));
    return { pos: pos, tgt: vlerp(W, v, 0.35 + 0.65 * prox), near: vdist(W, v) < h * 1.4 };
  }

  function koFocus() {
    const v = chest(ko.victim), h = H(ko.victim);
    const a = ko.angle + (rt - ko.t0) * 0.45;
    return { pos: vec(v.x + Math.cos(a) * h * 2.3, v.y + h * 0.2, v.z + Math.sin(a) * h * 2.3), tgt: v };
  }

  /* ------------------------------------------------------------------
     8) Detecting the killing shot
     ------------------------------------------------------------------ */
  function startSlow(kind, owner) {
    if (!CFG.predictKill || phase !== "idle" || ko) return;
    lethal = { kind: kind, owner: owner, victim: OPP[owner], t0: gt };
    phase = "slow";
    ret = null;
    camStart();
    fxOn(false);
    log("slow motion:", kind, owner, "->", lethal.victim);
  }

  function ownerOf(pos) {
    let best = null, bd = Infinity;
    HEROES.forEach(n => {
      const dx = roots[n].position.x - pos.x, dz = roots[n].position.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = n; }
    });
    return best;
  }

  function processNewBullets() {
    while (pendingBullets.length) {
      const m = pendingBullets.shift();
      if (m.isDisposed()) continue;
      const owner = ownerOf(m.position);
      bullets.push({ mesh: m, owner: owner });

      if (gt - lastVolley[owner] > 0.5) {                      // first bullet of a new trigger pull
        lastVolley[owner] = gt;
        const w = WEAPON_INFO[owner][selected[owner]];
        if (w && w.type === "gun" && getHealth(OPP[owner]) <= w.dmg * (w.volley || 1)) {
          startSlow("gun", owner);
        }
      }
    }
  }

  const holderCache = {};
  function holderNode(hero) {
    const name = hero + "_" + selected[hero] + "_holder";
    if (!holderCache[name]) holderCache[name] = scene.getTransformNodeByName(name);
    return holderCache[name];
  }

  function watchMelee(gameDt) {
    HEROES.forEach(n => {
      const w = WEAPON_INFO[n][selected[n]];
      const node = w && w.type === "melee" ? holderNode(n) : null;
      if (!node) return;
      const p = fromB(node.getAbsolutePosition());
      const q = prevHolder[node.name];
      prevHolder[node.name] = p;                               // always keep the last position fresh
      if (!q || phase !== "idle" || ko || gameDt <= 0) return;

      const d = vsub(p, q);
      const toOpp = vnorm(vsub(chest(OPP[n]), p));
      const toward = (d.x * toOpp.x + d.y * toOpp.y + d.z * toOpp.z) / gameDt;   // speed toward the opponent
      if (toward > CFG.meleeSpeed && getHealth(OPP[n]) <= w.dmg) startSlow("melee", n);
    });
  }

  function endSlowNoKill() {
    phase = "return";
    ret = { t0: rt };
    lethal = null;
    target = 1;
    log("shot did not kill - returning to normal");
  }

  /* ------------------------------------------------------------------
     9) The KO
     ------------------------------------------------------------------ */
  function startKO(victim) {
    if (ko) return;
    const attacker = OPP[victim];
    camStart();
    const v = chest(victim);
    const dx = camPos.x - v.x, dz = camPos.z - v.z;
    ko = { victim: victim, attacker: attacker, t0: rt, angle: Math.atan2(dz, dx), end: rt + CFG.koHold };
    phase = "ko";
    lethal = null;
    ret = null;
    fxOn(true);
    flash();
    log("K.O.", victim);
  }

  /* hold back the "<HERO> WINS!" screen until the cinematic is done */
  function watchOverlay() {
    const obs = new MutationObserver(list => {
      list.forEach(rec => rec.addedNodes.forEach(node => {
        if (node.nodeType !== 1 || node.tagName !== "DIV" || !/WINS/i.test(node.textContent || "")) return;
        if (!ko) return;                                       // no cinematic running: show immediately
        node.style.opacity = "0";
        node.style.pointerEvents = "none";
        node.style.transition = "opacity .6s";
        const wait = Math.max(0, (ko.end - rt) * 1000);
        setTimeout(() => {
          node.style.opacity = "1";
          node.style.pointerEvents = "auto";
          ko.released = true;                                  // normal speed again behind the WINS screen
        }, wait);
      }));
    });
    obs.observe(document.body, { childList: true });
  }

  /* ------------------------------------------------------------------
     10) Per-frame (runs in real time, never slowed)
     ------------------------------------------------------------------ */
  function frame() {
    const rdt = Math.min(origGetDelta() / 1000, 0.05);
    const gameDt = rdt * scaleUsed;
    rt += rdt;
    gt += gameDt;
    if (paused) return;

    processNewBullets();
    for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].mesh.isDisposed()) bullets.splice(i, 1);
    watchMelee(gameDt);

    /* ---- phase logic ---- */
    let desPos = null, desTgt = null, desFov = CFG.fov, shake = 0;

    if (phase === "slow" && lethal) {
      const f = shotFocus();
      desPos = f.pos; desTgt = f.tgt;
      target = f.near ? CFG.impactScale : CFG.slowScale;

      const mineLeft = bullets.some(b => b.owner === lethal.owner);
      const over = lethal.kind === "gun"
        ? (!mineLeft && gt - lastVolley[lethal.owner] > 0.6)
        : (gt - lethal.t0 > 1.4);
      if (over) endSlowNoKill();
    } else if (phase === "ko" && ko) {
      const f = koFocus();
      desPos = f.pos; desTgt = f.tgt;
      const t = rt - ko.t0;
      if (ko.released) target = 1;
      else target = t < CFG.koHold * 0.55 ? CFG.koScale : lerpNum(CFG.koScale, 0.4, ease(clamp((t - CFG.koHold * 0.55) / (CFG.koHold * 0.45), 0, 1)));
      if (CFG.shake && t < 0.5) shake = H(ko.victim) * 0.06 * (1 - t / 0.5);
    } else if (phase === "return" && ret) {
      desPos = fromB(prevCam.position);
      desTgt = camTargetOf(prevCam);
      desFov = prevCam.fov;
      if (rt - ret.t0 > 0.45) {
        camEnd();
        fxOff();
        phase = "idle";
        ret = null;
      }
    }

    if (desPos && kc && scene.activeCamera === kc) camApply(rdt, desPos, desTgt, desFov, shake);

    /* ---- ease the game speed ---- */
    ts += (target - ts) * (1 - Math.exp(-10 * rdt));
    if (Math.abs(ts - target) < 0.002) ts = target;
    scene.animationTimeScale = ts;                              // babylon animations follow too
  }

  function lerpNum(a, b, k) { return a + (b - a) * k; }

  /* ------------------------------------------------------------------
     11) Boot
     ------------------------------------------------------------------ */
  function init() {
    engine = scene.getEngine();
    HEROES.forEach(measureHero);
    hookEngine();
    buildFx();
    watchOverlay();

    if (typeof selectedWeapons !== "undefined" && selectedWeapons) {
      HEROES.forEach(n => { if (selectedWeapons[n]) selected[n] = selectedWeapons[n]; });
    }
    window.addEventListener("weaponselect", e => {
      if (e.detail && e.detail.hero) selected[e.detail.hero] = e.detail.weapon;
    });
    window.addEventListener("gamepause", e => { paused = !!(e.detail && e.detail.paused); });
    window.addEventListener("healthchange", e => {
      const d = e.detail || {};
      if (!d.hero) return;
      health[d.hero] = d.health;
      if (d.health <= 0) startKO(d.hero);
    });

    // catch every bullet weapons.js spawns (position is set a moment later, so handle it next frame)
    scene.onNewMeshAddedObservable.add(m => { if (m.name === "bullet") pendingBullets.push(m); });
    scene.onBeforeRenderObservable.add(frame);

    window.FinalShot = {
      config: CFG,
      weapons: WEAPON_INFO,
      state: () => ({ phase: phase, speed: +ts.toFixed(3), lethal: lethal, ko: !!ko })
    };
    console.log("final-shot.js ready  (try:  heroHealth.tiger = 4  then shoot Tiger)");
  }

  function boot() {
    scene = (BABYLON.EngineStore && BABYLON.EngineStore.LastCreatedScene) ||
            (BABYLON.Engine && BABYLON.Engine.LastCreatedScene) || null;
    const k = scene && scene.getTransformNodeByName("kabirRoot");
    const t = scene && scene.getTransformNodeByName("tigerRoot");
    if (!k || !t || !scene.activeCamera) { setTimeout(boot, 250); return; }
    roots.kabir = k; roots.tiger = t;
    init();
  }

  boot();
})();


